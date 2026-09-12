// src/execution/lifecycle-manager.ts
//
// Subagent 持续对话 V2 — 进程生命周期管理（§5.2 模块 1）。
//
// 本模块是 subagent 进程生命周期管理器（现存唯一职责 = idle timer），以**模块级
// 单例**持有全局进程状态（per-record idle timer）。它**不直接持有
// ChildProcess 句柄**——句柄在 engine/host/spawned-children.ts——因此
// 所有「副作用」能力（kill / 探活 / 超时回调）都由调用方经回调/参数注入，本模块
// 只管状态记账 + 调度顺序。这让模块可独立编译 + 单测，无需拉起真实子进程。
//
// 唯一职责（V2 §5.2 五项职责的存留）：
//   1. idle timer —— agent_settled arm / 新 turn disarm / 超时触发 onTimeout（决策 4）
//      【[H1 U6 后现状] arm 链已失活：旧「subagent-service.ts chat 域 arm/disarm」接线
//      随 chat 域退役删除，armIdleTimer 唯一剩余接线在 createHostBridge
//      （host-bridge.ts）——而后者全仓无生产调用点。运行时 timer 永不 armed，
//      disarmIdleTimer 仅剩 record-lifecycle 终态化路径的幂等清扫（对永不 armed
//      的 timer 为 no-op，保持终态清扫完整性）。模块与函数保留 = 既有判据形态
//      （lifecycle-predicates.isIdle 消费 hasIdleTimer）与 env/API 面
//      （ExecuteOptions.idleTimeoutMs 校验文案引用 DEFAULT_IDLE_TIMEOUT_MS）不删，
//      语义变化/显式 idle 状态设计属独立议题（impl-plan Gate B 收口 backlog）】
// 其余四项已删除：职责 2 全局 ceiling / 职责 3 shutdown 收割 / 职责 4 孤儿扫描自
// 落地起无生产接线；职责 5 activate 互斥的历史接线点（冷路径 resume 前）随协议化
// 重构消失、仅余自持单测。未来需要时按
// docs/design/v2-defense-ii-iii-resolution.md 重新设计。
//
// 本模块不 import subagent-service 等 execution 编排层，避免循环依赖。
//
// 设计参考：setTimeout→SIGTERM 骨架（复用 timer 形态）；模块级单例 Map 记账模式。

import { getLogger } from "../core/logger.ts";
import { assertSafeTimerDelay } from "../shared/timer-delay.ts";

// core/logger 无本地状态依赖（不 import execution/orchestration 层），与本模块
// 「可独立编译 + 单测」约束兼容；不 import session-runner / subagent-service（循环依赖）。
const logger = getLogger("subagents");

// ============================================================
// 默认常量
// ============================================================

/** 毫秒/秒（时间换算常数）。 */
const MS_PER_SECOND = 1000;
/** 秒/分钟（时间换算常数）。 */
const SECONDS_PER_MINUTE = 60;

/**
 * 默认 idle 超时（per-record）。
 *
 * V2 §5.4 / 决策 4：初拟 ≤ prompt cache TTL（~5min）——超出 cacheTTL 的活进程白占
 * 内存（续聊仍 cache miss），小于则 kill 丢热 cache。实测定（P-timeout）。
 *
 * [H1 U6 后现状] 「5min 超时回收保活进程」语义已无对象（每轮 = 新进程，轮末随
 * agent_settled 回收，无长驻进程可超时）。常量存活消费 = assertIdleTimeoutMsSafe
 * 错误文案基准（run-orchestration.ts）+ env XYZ_SUBAGENT_IDLE_TIMEOUT_MS 非法值
 * 回落默认 + ExecuteOptions.idleTimeoutMs API 校验域——属 API 面常量，非活性
 * timer 语义。
 */
const IDLE_TIMEOUT_MINUTES = 5;
export const DEFAULT_IDLE_TIMEOUT_MS = IDLE_TIMEOUT_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;

/**
 * 从环境变量 XYZ_SUBAGENT_IDLE_TIMEOUT_MS 读取全局默认超时。
 * 返回 undefined 表示 env 未设置或非法（调用方回落 DEFAULT_IDLE_TIMEOUT_MS）。
 *
 * [LC-7/T7①] env 已设但非法（非数字/<=0）回落默认值时必须 warn 留痕——「以为设了
 * 极长保活、实际回落 5min」的静默语义漂移不可见（设计 §4.3 LC-7），生效行为必须
 * 可见。禁用语义不认 env（禁用只能显式传参 <=0，见 armIdleTimer 注释）。
 *
 * [review 修复] 原 PI_ 前缀（PI_SUBAGENT_IDLE_TIMEOUT_MS）不在 ENV_WHITELIST_PREFIXES
 * 白名单（packages/shared/src/constants.ts 只有 XYZ_ 等，无 PI_），xyz-agent 桌面
 * spawn 链（safe-env 过滤）会丢弃该 env，配置口在桌面场景静默失效——已改名 XYZ_
 * 前缀以透传。本地 pi CLI 直跑 env 全量继承，两种前缀都有效。注意与其他
 * PI_SUBAGENT_* env 区分：那些是 extension 在 pi 进程内 spawn 子进程时直接注入的
 * childEnv，不经过 safe-env 白名单过滤，PI_ 前缀无此问题。
 */
function getEnvIdleTimeoutMs(): number | undefined {
  const raw = process.env.XYZ_SUBAGENT_IDLE_TIMEOUT_MS;
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn(
      `[lifecycle-manager] XYZ_SUBAGENT_IDLE_TIMEOUT_MS="${raw}" is invalid (expected a positive millisecond number) — falling back to DEFAULT_IDLE_TIMEOUT_MS (${DEFAULT_IDLE_TIMEOUT_MS}ms); set a plain ms value (e.g. 1800000) to override`,
    );
    return undefined;
  }
  return parsed;
}

// ============================================================
// 职责 1：idle timer（per-record）
// ============================================================

interface IdleTimerEntry {
  /** Node setTimeout 句柄，disarm/刷新时 clearTimeout。 */
  readonly timer: NodeJS.Timeout;
  /** 本次 arm 使用的超时时长（诊断/刷新对齐用）。 */
  readonly timeoutMs: number;
}

/** recordId → armed idle timer。仅在空闲态 armed（V2 决策 4：禁止 timer 常驻）。 */
const idleTimers = new Map<string, IdleTimerEntry>();

/**
 * Arm（或刷新）某 record 的 idle timer。
 *
 * - 若该 record 已有 armed timer，先 clearTimeout 旧的再设新的（重复 arm = 刷新计时，
 *   对齐 V2「续聊 disarm 后再次 agent_settled 重新 arm」语义）。
 * - 超时触发时先从 Map 移除自身，再回调 onTimeout（onTimeout 内若重新 arm 不会被误删）。
 *
 * 调用时机（接入时由 session-runner 编排）：`agent_settled`（支柱四，真空闲边界）→ arm。
 *
 * [预算语义对齐] 显式禁用：timeoutMs 传 0/负数 → 不挂 timer 并 disarm 已有的
 * （idle GC 可被显式关闭，旧实现 0 会落成 setTimeout(0) 立即 kill——危险 footgun）。
 * 默认行为不变（资源回收性质，默认值保留）：不传 → env XYZ_SUBAGENT_IDLE_TIMEOUT_MS
 * → DEFAULT_IDLE_TIMEOUT_MS（5min）。env 频道不认识禁用值：非法（<=0）回落默认。
 *
 * @param recordId subagent record id（sa-<uuid>）
 * @param onTimeout 超时回调（调用方注入：SIGTERM 回收进程）
 * @param timeoutMs 可选。SP-6 优先级：参数 > env XYZ_SUBAGENT_IDLE_TIMEOUT_MS > DEFAULT_IDLE_TIMEOUT_MS；
 *   显式 <=0 表示禁用（不挂 timer）。
 * @throws 解析后的 delay（参数/env/默认任一层）超出 Node setTimeout 上限 2^31-1 ——
 *   溢出值会被 Node 置 1ms 立即触发（「长空闲保活」变「立即回收」），fail-fast 不静默
 *   clamp（U1）。
 */
export function armIdleTimer(
  recordId: string,
  onTimeout: () => void,
  timeoutMs?: number,
): void {
  // 显式禁用通道：参数明确传 0/负数 → 关闭该 record 的 idle GC（顺带清已有 timer，
  // 否则早前默认 arm 的 timer 仍在跑，禁用形同虚设）。
  if (timeoutMs !== undefined && timeoutMs <= 0) {
    disarmIdleTimer(recordId);
    return;
  }

  // SP-6 优先级：参数 > env XYZ_SUBAGENT_IDLE_TIMEOUT_MS > 默认 300000ms (5min)。
  const resolved = timeoutMs ?? getEnvIdleTimeoutMs() ?? DEFAULT_IDLE_TIMEOUT_MS;

  // [U1] arm 入口：值流入 setTimeout 前校验安全域（>2^31-1 会变 1ms 立即触发）。
  // 显式 <=0 的禁用通道已在上方 return，不受影响。
  assertSafeTimerDelay(resolved, "idleTimeoutMs");

  // 刷新：先清旧 timer，避免同一 record 叠加多个 armed timer。
  disarmIdleTimer(recordId);

  // [LC-5/T6①] 超时回调按值守卫（对齐同包 session-runner.ts removeChildRegistration
  // 的按句守卫先例）：clearTimeout 对「已到期、回调已入 macrotask 队列」的 timer 无效
  //（Node 语义：fire 后不可撤销），若此刻同 recordId 发生 disarm + re-arm（agent_settled
  // 刷新与旧 timer 到点同轮交错），旧回调无条件 delete(recordId) 会误删**新** timer 条目
  // ——新 timer 脱管，后续 disarm 失效 → turn 中途被 idle GC 误杀。回调捕获自己的 timer
  // 引用，仅当 Map 当前条目仍是自己（未被 re-arm 覆盖）才删除。设计 §11-2：fake-timer
  // 模型内无法复现「旧回调迟到于 re-arm」的精确交错（sinon clock 同步 tick 消除了该
  // 中间态），身份比对按防御性守卫保留（成本一行）。
  const timer: NodeJS.Timeout = setTimeout(() => {
    if (idleTimers.get(recordId)?.timer === timer) {
      idleTimers.delete(recordId);
    }
    onTimeout();
  }, resolved);
  // node 默认 setTimeout 返回的 timer 会被事件循环 keep-alive；unref 让它不阻塞
  // 进程退出（进程退出由 shutdown hook 显式收割兜底，不靠 timer 拖延）。
  timer.unref?.();

  idleTimers.set(recordId, { timer, timeoutMs: resolved });
}

/**
 * Disarm 某 record 的 idle timer（新 turn 开始时调）。
 *
 * 不存在 armed timer 时 no-op。V2 决策 4：新 turn 开始（投递导致 isStreaming 转
 * true）必须 disarm——turn 期间进程由 busy 状态保护，绝不能被 idle timer 误杀。
 */
export function disarmIdleTimer(recordId: string): void {
  const entry = idleTimers.get(recordId);
  if (!entry) {
    return;
  }
  clearTimeout(entry.timer);
  idleTimers.delete(recordId);
}

/**
 * 查询某 record 是否有 armed idle timer（诊断/接入期断言用）。
 */
export function hasIdleTimer(recordId: string): boolean {
  return idleTimers.has(recordId);
}

// ============================================================
// 测试钩子（模块级单例状态隔离）
// ============================================================

/**
 * 清空全部模块级状态（idle timer）。
 *
 * 仅用于单测的 beforeEach 隔离——clearTimeout 所有 armed timer 防止跨用例泄漏。
 */
export function _resetLifecycleState(): void {
  for (const entry of idleTimers.values()) {
    clearTimeout(entry.timer);
  }
  idleTimers.clear();
}
