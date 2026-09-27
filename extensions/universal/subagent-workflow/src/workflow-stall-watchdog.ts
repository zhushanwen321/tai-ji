/**
 * workflow stall watchdog — workflow run 长时间无进展的 informational 通知（D6-2）。
 *
 * 独立模块的原因：本功能由 setInterval 驱动，与 pi 生命周期事件无关——四块行为
 * （timer 起停 / 阈值判定 / journal 尾帧读 / 恰一次标记回收）若散住在事件装配
 * 文件（workflow-events.ts）里，改 stall 语义要动装配文件、测 stall 要挂全装配。
 * 全部行为收在 createStallWatchdog 单一入口后面，测试直接注入 fake deps 直测。
 *
 * 恰好一次语义：标记先于发送落下（发送失败不重试——informational 不必达，
 * 重复提示比丢失更吵）；run 终局经 noteRunSettled 回收（Set 防泄漏；runId 全局
 * 唯一，漏删不会误报、只构成缓慢累积）。
 *
 * 误报面（有意接受）：单 ask 长跑期间 journal 无新帧（帧频 = 事件边沿）会触发
 * 提示——文案语义「仍在运行、无需干预、不自动终止」与事实一致（run 确实在跑），
 * 提示不终止进程（对齐 zcode 语义：zcode 对不可 run 级定位的引擎同样只通知不杀）。
 *
 * 零依赖设计：不 import pi SDK / helpers / workflow-events——发送面与数据源经
 * deps 注入，模块可脱离装配面独立测试。
 */

import { readFileSync } from "node:fs";

// ── deps 契约（装配侧注入面） ─────────────────────────────────────────────────

/** tick 视角的单个 running run 投影（装配侧从 sessionState 投影，模块零路径知识）。 */
export interface StallRunView {
  runId: string;
  /** 通知文案用脚本名。 */
  scriptName: string;
  /** 回退判定的起点（Date.parse(meta.startedAt)；无效 ISO = NaN，tick 内跳过）。 */
  startedAtMs: number;
  /** 进展时间戳源的 journal 文件绝对路径（<sessionDir>/workflow-state/<runId>.events.jsonl）。 */
  journalPath: string;
}

export interface StallWatchdogDeps {
  /** 当前全部 session 的 running run 投影（status 过滤在装配侧）。 */
  getRunningRuns(): Iterable<StallRunView>;
  /**
   * 读 run 事件 journal 的尾帧 ts（stall 判定的进展时间戳）。**同步 IO**——tick
   * 周期 60s、run 数量个位数、单文件 ≤100KB（D5 量级预算），同步读的宿主阻塞
   * <1ms 且让 tick 整体确定性（fake timers 测试下 interval fire 即完成，无跨
   * macrotask 的 IO 等待时序）。
   *
   * 数据源裁决（D6-2 实施期选型，登记）：**事件 journal 尾帧**（D5 权威事件流的
   * 信封 ts），不依赖 P3 快照面的 health.lastProgressAt（并行单元在飞，本单元
   * 零依赖）。journal 缺文件（首帧未落）或尾行损坏时返回 undefined，tick 回退
   * run 起点（startedAtMs）。
   *
   * 可注入覆盖（模块直测用 fake，零 fs）。
   */
  readLastProgress?(journalPath: string): number | undefined;
  /** 发送面（装配侧闭包 resolveCurrentPi + notifyStall）。 */
  notifyStalled(view: StallRunView, stalledMs: number, lastProgressMs: number): void;
  /** tick 异常围栏：watchdog 自吞错误保 timer 存活，错误经此上报（informational 面 fail-open）。 */
  onTickError(err: unknown): void;
  /** 阈值（SSOT = workflow-notify.ts 的 WORKFLOW_STALL_THRESHOLD_MS，20min，对齐 zcode）。 */
  thresholdMs: number;
  /** 检测周期，缺省 60s。检测延迟上界 = 阈值 + 本周期（秒级精度无意义——分钟级
   * 周期把 tick 空转成本压到可忽略）。 */
  tickMs?: number;
}

export interface StallWatchdog {
  /** 起 timer。幂等：重复 arm 先清旧再建新（reload 时 factory 重跑防双 timer 双倍 tick）。 */
  arm(): void;
  /** 停 timer（幂等）。timer 生命周期随 factory（进程退出由 unref 放行），常规
   * 运行不 dispose——空 sessionState 的 tick 是零成本空转；dispose 供测试清理
   * 与显式停用。 */
  dispose(): void;
  /** run 终局回收恰一次标记（onRunDone 转发）。 */
  noteRunSettled(runId: string): void;
  /** 恰一次标记查询（断言/诊断面）。 */
  hasNotified(runId: string): boolean;
}

// ── 内置 journal 尾帧读（deps.readLastProgress 缺省实现） ──────────────────────

/** journal 帧的信封守卫（EventEnvelope 形态运行时收窄——避免全可选属性的结构断言）。 */
function isFrameWithTs(frame: unknown): frame is { ts: number } {
  if (typeof frame !== "object" || frame === null) return false;
  const record = frame as Record<string, unknown>;
  return typeof record["ts"] === "number";
}

/**
 * 尾帧形态（core run-events P1a 钉死）：每行一个 JSON 事件、信封含 ts（epoch
 * ms）。坏尾行（半截写入）向前逐行找——journal 是 append-only JSONL，坏行只可
 * 能出现在文件尾。
 */
function readLastJournalTimestamp(journalPath: string): number | undefined {
  let raw: string;
  try {
    raw = readFileSync(journalPath, "utf8");
  } catch {
    return undefined; // ENOENT = 尚无 journal 帧（run 创建极早/引导补投未跑）
  }
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const frame: unknown = JSON.parse(line);
      if (isFrameWithTs(frame)) {
        return frame.ts;
      }
      return undefined;
    } catch {
      continue;
    }
  }
  return undefined;
}

const DEFAULT_TICK_MS = 60_000;

// ── 工厂（测试直测入口） ─────────────────────────────────────────────────────

export function createStallWatchdog(deps: StallWatchdogDeps): StallWatchdog {
  const tickMs = deps.tickMs ?? DEFAULT_TICK_MS;
  const readLastProgress = deps.readLastProgress ?? readLastJournalTimestamp;
  const notified = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;

  function tick(): void {
    const now = Date.now();
    for (const view of deps.getRunningRuns()) {
      if (notified.has(view.runId)) continue;
      const lastProgressMs = readLastProgress(view.journalPath) ?? view.startedAtMs;
      if (!Number.isFinite(lastProgressMs)) continue;
      const stalledMs = now - lastProgressMs;
      if (stalledMs < deps.thresholdMs) continue;
      notified.add(view.runId);
      deps.notifyStalled(view, stalledMs, lastProgressMs);
    }
  }

  return {
    arm() {
      if (timer !== undefined) clearInterval(timer);
      // unref：informational 面不阻止宿主进程自然退出。tick 全同步（journal
      // 同步读 + 同步发送）——无 async 链，无 unhandledRejection 面。
      timer = setInterval(() => {
        try {
          tick();
        } catch (err) {
          deps.onTickError(err);
        }
      }, tickMs);
      timer.unref();
    },
    dispose() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    noteRunSettled(runId: string) {
      notified.delete(runId);
    },
    hasNotified(runId: string) {
      return notified.has(runId);
    },
  };
}

// ── 槽单例（装配入口） ───────────────────────────────────────────────────────

// 与 WORKFLOW_DOMAIN_SLOT_KEY 同一防线形态（globalThis[Symbol.for]，跨 jiti
// 多实例与 pi reload 模块重求值存活）。实例必须跨 reload 复用：重建实例会丢
// stallNotifiedRunIds，违背「reload 前后同一在飞 run 不重发」——因此槽已有
// 实例时 deps 被忽略，deps 闭包必须现读 volatile 源（resolveCurrentPi /
// domainState 字段），禁止捕获 factory 期快照（装配侧本来就是这么写的）。
const STALL_WATCHDOG_SLOT_KEY = Symbol.for("@zhushanwen/pi-subagents.workflow-stall-watchdog");

export function getOrCreateStallWatchdog(deps: StallWatchdogDeps): StallWatchdog {
  let instance = Reflect.get(globalThis, STALL_WATCHDOG_SLOT_KEY) as StallWatchdog | undefined;
  if (!instance) {
    instance = createStallWatchdog(deps);
    Reflect.set(globalThis, STALL_WATCHDOG_SLOT_KEY, instance);
  }
  return instance;
}

/** 只读窥视（测试清理 / 诊断），未装配返回 undefined。 */
export function peekStallWatchdog(): StallWatchdog | undefined {
  return Reflect.get(globalThis, STALL_WATCHDOG_SLOT_KEY) as StallWatchdog | undefined;
}
