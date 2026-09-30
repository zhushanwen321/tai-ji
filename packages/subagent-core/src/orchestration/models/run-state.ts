/**
 * Workflow Extension — RunExecutionSnapshot 值对象
 *
 * 单次 workflow run 的可持久化状态。
 *
 * 设计：
 * - reason/budget/calls/trace/errorLogs 是可变字段（运行中持续更新）
 * - error/scriptResult 仅终态有值（终局 run）
 * - 与 RunSpec 的区别：RunSpec 不可变（输入），RunExecutionSnapshot 可变（执行快照）
 *
 * [§2.1 注释回写] 本类型是**活体执行快照**（run 在内存中的状态面，TUI/GUI 投影读它），
 * 生命周期判定的权威源是 record 事件流的 fold 与终局记录注册表（见 run-events.ts /
 * terminal-actions.ts）——本类型不承载生命周期轴（[D6(a)] status 字段已退役）。
 *
 * 层归属：Engine。
 */

import type { AgentCall } from "./agent-call.ts";
import type { Budget } from "./budget.ts";
import type { Trace } from "./trace.ts";
import type { DoneReason, WorkerLogEntry } from "./types.ts";

/**
 * RunExecutionSnapshot——一次 run 的可持久化执行状态。
 *
 * [§2.1 注释回写] 持久化事实：run 状态的唯一落盘介质是 **record 事件流**（追加写，
 * 唯一写者 = worker-message-pump；壳侧 `RunStore.save` 是显式 no-op）。跨进程重启时，
 * 宿主经 record 流 fold 重建 run（`jsonl-run-store.loadAll` / core `rebuildRunFromRecord`），
 * 重建面覆盖 reason/calls/trace 与 spec；**budget 计数与 errorLogs 不重建**
 *（前者只有终态条目带 usedTokens 可 seed，后者无持久面）——读到 0 值/空数组属已知形态，
 * 不是「状态丢失 = 内存态权威」（详见 docs/todo/subagent-workflow-issues.md §2.1）。
 *
 * [D6(a)] 生命周期轴（status 字段）已退役：终局判定唯一走进程内终局记录注册表
 * （isRunSettled / settledRecordOf），展示投影走 runSummary（三态投影词表）——
 * 本类型不再携带生命周期字段。
 */
export interface RunExecutionSnapshot { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
 /** 终态原因（终局 run 有值，来源 = run-settled 帧派生）。 */
  reason?: DoneReason;
 /** Token/cost 预算（含 usedTokens/usedCost 累积）。 */
  budget: Budget;
 /** 按 callId 索引的 agent 调用集合（含 result，跨 runtime 重建存活——callCache replay）。 */
  calls: Map<number, AgentCall>;
 /** 执行追踪事件流（唯一来源 D-10）。 */
  trace: Trace;
 /** Worker console.* 捕获条目（run 级诊断，仅展示在 TUI widget）。 */
  errorLogs: WorkerLogEntry[];
 /** done && reason !== completed 时可有（失败/中止/预算超限的原因）。 */
  error?: string;
 /** done && reason === completed 时有（脚本 execute 返回值）。 */
  scriptResult?: unknown;
}
