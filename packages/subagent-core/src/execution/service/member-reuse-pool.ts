// src/execution/service/member-reuse-pool.ts
//
// [D1 拆边 Class C 第 4 步] 自 `orchestration/member-reuse-pool.ts` 整体下沉（同一批
// 消除 `service/workflow-dispatch` → 编排层的值反向边）。依赖面核查结论 = 可下沉：
// 值依赖只有 `core/logger`（叶子），类型依赖只有 run-events 的 `WorkflowRunEvent`
// （事件载荷接口按 Class B 先例留原位作类型导入——B1 已裁决「值不能反向依赖编排层」，
// 类型边编译期擦除）；模块本体是 record 流的 fold + runId 分区内存表，零编排状态机
// 语义、除 io 注入的 record 读外零 IO / 零时钟依赖，不把状态机语义带进下层。编排侧
// 消费面（terminal-actions / worker-message-pump / 成员复用池测试）直连本模块——
// 过渡期曾保留同名 re-export façade，收尾已删。
//
// [U4 pi-workflow-run-resource-model → D6 绑定消解]（workflow-run-resume-revision）
// workflow 成员会话 name 键复用绑定的查询辅助：同 run 内同名 agent() 调用 = 同一
// 子代理身份的续写轮（对齐 zcode 平台语义——name = run 内唯一身份），跨 run 串线
// 被挡（绑定按 runId 分区，run 收尾清空）。
//
// [D6] 概念消解后的形态：绑定不再是独立词表成员 + 独立池实体——绑定为 call 记录的
// 字段（agent-started 载荷的 memberRecordId，随帧落 record），复用路由按绑定字段查；
// 跨崩溃恢复从 record 折叠重建（foldMemberBindings）。机制保留（同名续写、按 runId
// 分区防串线、收尾清绑定的时序），实体取消（原 member-pool 词表事件随 [D6] 删除，
// 写入序红线由「绑定字段与 agent-started 帧同帧落账」构造性满足——字段与帧一体，
// 不存在「事件落了内存没改」或反之的窄窗）。
//
// 职责边界（收窄后）：
// - 内存绑定表 = run 级 Map<name, recordId> 的活体缓存（本进程内 lookup 消费）；
// - 权威介质 = record 事件流的 agent-started.memberRecordId 字段——run 中断重发后
//   的恢复 = fold 重建（foldMemberBindings），内存表不是第二真相源；
// - 收尾清空（clearMemberReusePool）只释放内存（无 clear 事件可发——词表成员已删；
//   恢复语义 = 新进程 fold 只见 agent-started 帧，run 已终局后无新增派发，重建结果
//   与清空后等价——原「clear 帧」的 fold 清空语义由「终局后无后续 agent-started 帧」
//   构造性承接）。
//
// record 读通道经 MemberReusePoolIo 注入（生产装配 = terminal-actions 的
// scanRunEvents——journal 单写者纪律：读侧不自建 journal 实例绕过 no-op 测试防线）。
// 本模块不 import worker-message-pump / terminal-actions（消费方反向 import 本模块
// 做收尾清空接线，双向直依赖会成环；编排侧导入面直连本模块）。
//
// 层归属：Engine。除 io 注入的 record 读外零 IO / 零时钟依赖（fold 纯函数可独立
// 测试）。

import { getLogger } from "../../core/logger.ts";
// 事件载荷接口单源（Class B 裁决：值不下沉时接口留原位，消费方按类型导入）。
import type { WorkflowRunEvent } from "../../orchestration/run-events.ts";

const logger = getLogger("member-reuse-pool");

/**
 * record 读注入面（[D6] 收窄：原 appendEvent 通道随 member-pool 词表成员删除——
 * 绑定落账归 agent-started 帧，由 pump dispatchAgentCall 链承载，不经本注入面）。
 * 生产装配在消费方（workflow-dispatch / terminal-actions 的 scanRunEvents 组装）。
 */
export interface MemberReusePoolIo { // oe-exempt:20260927:framework:复用绑定 ports IO 契约（record 读面）——生产实现经 terminal-actions 单源，测试 fake 为第二变体
  /** 顺序扫描某 run 的全部事件（fold 重建的读通道）。 */
  readonly scanEvents: (runId: string) => Promise<readonly WorkflowRunEvent[]>;
}

// ── fold 重建（[D6]：record 事件流 → 绑定映射，纯函数）──────────

/**
 * 事件流 → 绑定映射（fold 重放）：只消费 agent-started 帧的 memberRecordId 字段
 * （其余事件类型跳过——fold 与 run 状态机投影 foldRunEventFrames 各取所需，互不
 * 干扰）。绑定语义 = 首派建绑（同 run 同名首个携带 recordId 的 agent-started 帧
 * 生效，后续同名续写帧的重复携带不换绑——zcode 语义下 run 内名唯一，重复携带是
 * 并行同名派发的防御面，首个为准与原 register 语义一致）。重放幂等：同一事件序列
 * 重复 fold 产出一致。
 */
export function foldMemberBindings(events: readonly WorkflowRunEvent[]): Map<string, string> {
  const pool = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "agent-started") continue;
    if (event.memberRecordId === undefined) continue;
    if (!pool.has(event.agentName)) {
      pool.set(event.agentName, event.memberRecordId);
    }
  }
  return pool;
}

// ── 活体绑定表（runId 分区的进程内缓存；first access 惰性 fold 重建）────────

/** runId → 绑定映射（本进程活体缓存；clear 随 run 收尾删除条目）。 */
const pools = new Map<string, Map<string, string>>();
/** 已做过首载（fold 重建或空载登记）的 runId——每个 run 只扫一次 record 流，之后
 *  内存即权威快照（活体运行期 lookup/register 全走内存，无逐次 scan 开销）。 */
const loadedRuns = new Set<string>();

/** 事件流扫描失败（IO 异常）的降级留痕：按空表继续（后续同名调用按未命中
 *  新建——行为不一致可由本 warn 追查），不炸派发主链。 */
function warnScanFailure(runId: string, err: unknown): void {
  logger.warn(
    `[subagents] member binding fold rebuild failed for run ${runId}: ` +
      `${err instanceof Error ? err.message : String(err)} — proceeding with an empty table; ` +
      `same-name agent() calls will dispatch as new members until the record stream is readable.`,
  );
}

/** 首载：内存无该 run 的绑定表时经 record fold 重建（每 run 至多一次 scan）。 */
async function ensureLoaded(runId: string, io: MemberReusePoolIo): Promise<Map<string, string>> {
  let pool = pools.get(runId);
  if (pool !== undefined) return pool;
  if (loadedRuns.has(runId)) {
    // 降级登记过的空表（scan 失败形态）——不重复 scan，直接复用空表
    pool = new Map<string, string>();
    pools.set(runId, pool);
    return pool;
  }
  try {
    pool = foldMemberBindings(await io.scanEvents(runId));
  } catch (err) {
    warnScanFailure(runId, err);
    pool = new Map<string, string>();
  }
  pools.set(runId, pool);
  loadedRuns.add(runId);
  return pool;
}

/**
 * 按 name 查绑定 record id（executeWorkflowAgent 入口分岔的命中判定）。
 * 命中返回 recordId；未命中（含 fold 重建后仍无——首派名或降级空表）返回
 * undefined，调用方走现状新建路径 + 登记。
 */
export async function lookupMemberRecordId(
  runId: string,
  name: string,
  io: MemberReusePoolIo,
): Promise<string | undefined> {
  const pool = await ensureLoaded(runId, io);
  return pool.get(name);
}

/**
 * [D6] 绑定表活体缓存的同步读取（agent-started 载荷 memberRecordId 的供源——
 * pump dispatchAgentCall 主链无 await 点）：命中返回绑定 id；miss（首派 / 未首载）
 * 返回 undefined。miss 不触发 fold 重建（重建是 async 语义，派发主链不等待——
 * 崩溃重启后的首个同名续写调用经 ensureLoaded 的 ensure 已在生产装配侧先行
 * （lookupMemberRecordId 入口分岔先于 dispatchAgentCall），本读取只服务活体窗口）。
 */
export function peekMemberRecordId(runId: string, name: string, _io: MemberReusePoolIo): string | undefined {
  return pools.get(runId)?.get(name);
}

/**
 * 登记绑定（现状新建路径的收尾步）。[D6] 后无独立事件可发——绑定随 agent-started
 * 帧落 record（dispatchAgentCall 的 dispatchAgentStarted 调用，字段与帧一体），
 * 本函数只改内存表（fold 重放从帧恢复，无「事件落了内存没改」窄窗可虑）。
 *
 * 同名换绑 warn（「行为不一致可追查」的留痕点）：命中检查与登记之间同名已映射到
 * 不同 record（并行同名派发 / fold 重建竞窗）时 warn 后覆盖——zcode 语义下 run 内
 * 名唯一，此形态只该由脚本并行同名调用触发，留痕不阻断。
 */
export async function registerMemberRecord(
  runId: string,
  name: string,
  recordId: string,
  io: MemberReusePoolIo,
): Promise<void> {
  const pool = await ensureLoaded(runId, io);
  const existing = pool.get(name);
  if (existing !== undefined && existing !== recordId) {
    logger.warn(
      `[subagents] member binding rebind for run ${runId}: name "${name}" was mapped to ` +
        `record ${existing} and is now rebound to ${recordId} — concurrent same-name agent() ` +
        `calls or a stale snapshot; the workflow member identity diverges (recovery: avoid ` +
        `dispatching two agent() calls with the same name in flight).`,
    );
  }
  pool.set(name, recordId);
}

/**
 * run 收尾绑定清空（terminal-actions.finalizeRun 唯一生产调用点）。[D6] 后无
 * clear 事件（词表成员已删）——只释放内存条目（run 已终局，内存表是必回收的垃圾；
 * 恢复语义 = 新进程 fold 只见 agent-started 帧，终局后无新增派发，重建结果与本清空
 * 后等价——原 clear 帧的 fold 清空语义由「终局后无后续 agent-started 帧」构造性
 * 承接）。
 *
 * @returns 恒 false（原「是否发出了 clear 事件」的诊断面——无事件可发，保留返回
 * 形状兼容既有测试断言）。
 */
export async function clearMemberReusePool(runId: string, _io: MemberReusePoolIo): Promise<boolean> {
  pools.delete(runId);
  loadedRuns.delete(runId);
  return false;
}

/** 测试辅助：清空全部活体绑定状态（仅 __tests__ 导入，生产勿用）。 */
export function resetMemberReusePoolsForTest(): void {
  pools.clear();
  loadedRuns.clear();
}
