// src/orchestration/member-reuse-pool.ts
//
// [U4 pi-workflow-run-resource-model] workflow 成员会话 name 键复用池（设计 §3.3
// 决策 4 / 决策 9）：同 run 内同名 agent() 调用 = 同一子代理身份的续写轮（对齐
// zcode 平台语义——name = run 内唯一身份，round 不参与路由），跨 run 串线被挡
// （池按 runId 分区，run 收尾清空）。
//
// 职责边界：
// - 内存池 = run 级 Map<name, recordId> 的活体缓存（本进程内 lookup/register 消费）；
// - 权威介质 = run 事件 journal（member-pool 事件，run-events.ts 词表）——run 中断
//   重发后的恢复 = journal fold 重建（本模块 foldMemberReusePool），内存池不是第
//   二真相源（决策 9「复用池只挂快照不进 journal」已否）。
//
// 写入序红线（决策 9）：register/clear 都是**先 append 登记事件、后改内存池**——
// 进程崩溃落在两条语句之间的窄窗只会多出一条事件，fold 重放幂等，不会缺项；事件
// append 失败时不落内存（fail-fast，不留无 journal 证据的内存孤项）。
//
// journal 读写通道经 MemberReusePoolIo 注入（生产装配 = worker-message-pump 的
// dispatchRunTrigger / scanRunEvents——journal 单写者纪律：全部写入经 pump 唯一
// 入口，池侧不自建 journal 实例绕过 pump 的 no-op 测试防线）。本模块不 import
// worker-message-pump（pump 反向 import 本模块做 finalizeRun 池清空接线，双向
// 直依赖会成环）。
//
// 层归属：Engine。除 io 注入的 journal 读写外零 IO / 零时钟依赖（fold 纯函数可
// 独立测试；ts 信封由调用侧补）。

import { getLogger } from "../core/logger.ts";
import { IllegalTransitionError, type MemberPoolClearEvent, type MemberPoolRegisterEvent, type WorkflowRunEvent } from "./run-events.ts";

const logger = getLogger("member-reuse-pool");

/** member-pool 事件的 input 形态（seq 由 journal 单写者分配，入参不带；与
 *  MemberPoolEvent 同源分解，零形状漂移）。 */
export type MemberPoolEventInput = Omit<MemberPoolRegisterEvent, "seq"> | Omit<MemberPoolClearEvent, "seq">;

/**
 * journal 读写注入面（生产装配在消费方：workflow-dispatch / worker-message-pump
 * 经 pump 的 dispatchRunTrigger + scanRunEvents 组装）。
 */
export interface MemberReusePoolIo { // oe-exempt:20260927:framework:复用池 ports IO 契约（journal 事件 append/scan 面）先立——生产实现经 pump 单写者链，测试 fake 为第二变体
  /** 追加一条 member-pool 事件（经 pump 单写者链，含状态机转移裁决）。 */
  readonly appendEvent: (runId: string, event: MemberPoolEventInput) => Promise<unknown>;
  /** 顺序扫描某 run 的全部事件（fold 重建的读通道）。 */
  readonly scanEvents: (runId: string) => Promise<readonly WorkflowRunEvent[]>;
}

// ── fold 重建（决策 9：journal 事件流 → 复用池映射，纯函数）──────

/**
 * 事件流 → 复用池映射（fold 重放）：只消费 member-pool 帧（其余事件类型跳过——
 * fold 与 run 状态机投影 foldRunEventFrames 各取所需，互不干扰），register 建/
 * 换映射、clear 清空。重放幂等：同一事件序列重复 fold 产出一致。
 */
export function foldMemberReusePool(events: readonly WorkflowRunEvent[]): Map<string, string> {
  const pool = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "member-pool") continue;
    if (event.action === "register") {
      pool.set(event.name, event.recordId);
    } else {
      pool.clear();
    }
  }
  return pool;
}

// ── 活体池（runId 分区的进程内缓存；first access 惰性 fold 重建）────────

/** runId → 复用池映射（本进程活体缓存；clear 随 run 收尾删除条目）。 */
const pools = new Map<string, Map<string, string>>();
/** 已做过首载（fold 重建或空载登记）的 runId——每个 run 只扫一次 journal，之后
 *  内存即权威快照（活体运行期 register/lookup 全走内存，无逐次 scan 开销）。 */
const loadedRuns = new Set<string>();

/** 事件 journal 扫描失败（IO 异常）的降级留痕：按空池继续（后续同名调用按未命中
 *  新建——行为不一致可由本 warn 追查），不炸派发主链。 */
function warnScanFailure(runId: string, err: unknown): void {
  logger.warn(
    `[subagents] member reuse pool fold rebuild failed for run ${runId}: ` +
      `${err instanceof Error ? err.message : String(err)} — proceeding with an empty pool; ` +
      `same-name agent() calls will dispatch as new members until the journal is readable.`,
  );
}

/** 首载：内存无该 run 的池时经 journal fold 重建（每 run 至多一次 scan）。 */
async function ensureLoaded(runId: string, io: MemberReusePoolIo): Promise<Map<string, string>> {
  let pool = pools.get(runId);
  if (pool !== undefined) return pool;
  if (loadedRuns.has(runId)) {
    // 降级登记过的空池（scan 失败形态）——不重复 scan，直接复用空池
    pool = new Map<string, string>();
    pools.set(runId, pool);
    return pool;
  }
  try {
    pool = foldMemberReusePool(await io.scanEvents(runId));
  } catch (err) {
    warnScanFailure(runId, err);
    pool = new Map<string, string>();
  }
  pools.set(runId, pool);
  loadedRuns.add(runId);
  return pool;
}

/**
 * 按 name 查成员 record id（executeWorkflowAgent 入口分岔的命中判定）。
 * 命中返回 recordId；未命中（含 fold 重建后仍无——首派名或降级空池）返回
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
 * 登记成员映射（现状新建路径的收尾步）。写入序红线：先 append 登记事件、后改
 * 内存池——崩溃窄窗只会多出一条事件（fold 重放幂等），不会缺项。
 *
 * 失败语义分级：
 * - IO / journal 写失败：fail-fast 向上抛且**不落内存**（不留无 journal 证据的
 *   内存孤项；调用方 = 派发主链，失败即该次派发失败）。
 * - IllegalTransitionError：降级内存登记 + warn 留痕、不抛——该错误只在一个形态
 *   出现：run journal 停在 created（run-created 帧缺席；服务层直调 fixture 或
 *   run-created 接线断裂）。生产不可达（lifecycle.runWorkflow 先落 run-created 并
 *   await 才启动 worker），此时本 run 的 member-pool 帧整体无处落账，让位降级 =
 *   armed 回执的既有人处置先例（reportDispatchFailure debug 让位）；本进程内复用
 *   照常（内存池活体有效），崩溃后 fold 无据 → 同名调用按未命中新建 + warn 的
 *   设计内降级路径（决策 9）承接跨进程面。
 *
 * 同名换绑 warn（决策 9「行为不一致可追查」的留痕点）：命中检查与登记之间同名
 * 已映射到不同 record（并行同名派发 / fold 重建竞窗）时 warn 后覆盖——zcode 语义
 * 下 run 内名唯一，此形态只该由脚本并行同名调用触发，留痕不阻断。
 */
export async function registerMemberRecord(
  runId: string,
  name: string,
  recordId: string,
  io: MemberReusePoolIo,
): Promise<void> {
  const pool = await ensureLoaded(runId, io);
  try {
    await io.appendEvent(runId, { type: "member-pool", action: "register", name, recordId, ts: Date.now() });
  } catch (err) {
    if (!(err instanceof IllegalTransitionError)) throw err;
    logger.warn(
      `[subagents] member reuse pool register degraded to memory-only for run ${runId} ` +
        `(name "${name}" → ${recordId}): the run journal has no run-created frame, so the ` +
        `register event cannot be journaled (${err.message}). In-process reuse stays active; ` +
        `after a restart the pool rebuilds empty and same-name calls dispatch as new members ` +
        `(check the run-created dispatch wiring).`,
    );
  }
  const existing = pool.get(name);
  if (existing !== undefined && existing !== recordId) {
    logger.warn(
      `[subagents] member reuse pool rebind for run ${runId}: name "${name}" was mapped to ` +
        `record ${existing} and is now rebound to ${recordId} — concurrent same-name agent() ` +
        `calls or a stale pool snapshot; the workflow member identity diverges (recovery: avoid ` +
        `dispatching two agent() calls with the same name in flight).`,
    );
  }
  pool.set(name, recordId);
}

/**
 * run 收尾池清空（worker-message-pump.finalizeRun 唯一生产调用点，先于 run-settled
 * 帧投递——terminal × member-pool 是表外转移 fail-fast）。有登记才发 clear 事件
 * （空池 run 的 journal 保持零 member-pool 帧，fold 结果本就为空——「清空在 run
 * 收尾发一次」针对有过登记的池，零成员 run 无可清）。内存条目无论事件成败都释放
 * （run 已终局，内存池是必回收的垃圾；事件失败由调用方留痕）。
 *
 * @returns 是否发出了 clear 事件（诊断/测试观察面）。
 */
export async function clearMemberReusePool(runId: string, io: MemberReusePoolIo): Promise<boolean> {
  const pool = pools.get(runId);
  const shouldJournal = loadedRuns.has(runId) && pool !== undefined && pool.size > 0;
  try {
    if (shouldJournal) {
      await io.appendEvent(runId, { type: "member-pool", action: "clear", ts: Date.now() });
    }
  } finally {
    pools.delete(runId);
    loadedRuns.delete(runId);
  }
  return shouldJournal;
}

/** 测试辅助：清空全部活体池状态（仅 __tests__ 导入，生产勿用）。 */
export function resetMemberReusePoolsForTest(): void {
  pools.clear();
  loadedRuns.clear();
}
