/**
 * Workflow Extension — RunState 值对象
 *
 * 单次 workflow run 的可持久化状态（domain-models.md §3）。
 *
 * 设计：
 * - status/reason/budget/calls/trace/errorLogs 是可变字段（运行中持续更新）
 * - error/scriptResult 仅终态有值（done 时）
 * - 与 RunSpec 的区别：RunSpec 不可变（输入），RunState 可变（执行快照）
 *
 * 层归属：Engine。
 *
 * 参考：domain-models.md §3。
 */

import type { AgentCall } from "./agent-call.ts";
import type { Budget } from "./budget.ts";
import type { Trace } from "./trace.ts";
import type { DoneReason, RunStatus, WorkerLogEntry } from "./types.ts";

/**
 * RunState——一次 run 的可持久化执行状态。
 *
 * 持久化由 RunStore.save(WorkflowRun) 触发（WorkflowRun 持 RunState）。
 * 跨进程重启时 RunState 从 JSONL 重水合（callCache 保留，worker 由崩溃恢复重建）。
 */
export interface RunState {
 /** 当前状态（running/done）。 */
  status: RunStatus;
 /** 终态原因（done 时必有）。 */
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
