/**
 * Workflow Extension — executeAgentCall（关键路径）
 *
 * 单次 agent 调用执行的 Engine free function（D-12）。显式 5 参数
 * `(call, runner, budget, signal, trace)`，无依赖注入 bag（AC-2：消除散落的
 * Context factory）。
 *
 * 职责：
 * - 单次执行：runner.run 一次，结果（成功或失败）直接终态化
 * - [ADR-0122] 失败显式上报：不自动重试（原 3 次指数退避重试已删——自动重试
 *   属无效防御；失败经 finalizeCall failed + agent-settled(failed) 落账显式上报，
 *   修复由用户重新发起 run 承接）
 * - 成功：consume usage + incrementCallCount + markDone + trace.update(completed)
 *
 * [D5-③ 结构化分诊] 失败分诊读 AgentResult.failureKind 字段（产出侧唯一识别点 =
 * execution/engine/inproc pi 引擎目录/output-collector.ts 的 classifyFailureKind，词表归属
 * 见其文件头）。本模块不扫 error 文案子串——failureKind 随 result 透传进 trace 节点，
 * 消费方（trace 读取/TUI）按字段分类展示；原 stale_context / schema_deterministic
 * 「不重试」特判随重试矩阵一并删除（所有失败行为一致：单次即终态）。
 *
 * 关键设计：
 * - **usage 透传**：result.usage 直接交给 budget.consume，加权由 Budget 内部的权重常量
 *   处理（见 budget.ts）。此函数不再做 usage 形状的改写。
 * - **参数显式化**：runner 直接传入（而非 ctx.getRun(runId).pool），无 runId 查找 / pool 守卫。
 * - **stale-state 检查**：runner.run 的 signal 传播由 AgentRunner port 承担；abort 后的
 *   结果同样经 finalizeCall 显式终态化（failed / cancelled 语义由 result.error 承载）。
 *
 * 层归属：Engine。零 infra 依赖（runner 是 AgentRunner port，budget/trace/call 是 Engine 模型）。
 */

import type { AgentStreamSink } from "../shared/agent-stream.ts";
import type { AgentEvent } from "../shared/agent-event.ts";
import type { AgentCall } from "./models/agent-call.ts";
import type { Budget } from "./models/budget.ts";
import type { AgentRunner } from "./models/ports.ts";
import type { Trace } from "./models/trace.ts";
import type { AgentResult } from "./models/types.ts";

// ── 内部 helper ──────────────────────────────────────────────

/**
 * 终态化单次 call：markDone + trace.update。
 *
 * 成功：status="completed"；失败：status="failed"。
 * traceNode.stepIndex === call.id（D-10 单源，调用方保证）。
 *
 * 孤儿守卫（OB2，S7 残留）：isOrphaned 谓词为 true 时跳过 trace.update——
 * 旧代际 finalize 的 update 会命中新代际同 stepIndex 节点，TUI/中间快照短暂
 * 可见错误终态。正确性论证：运行期 calls Map 写点为 dispatchAgentCall 的 set
 * （[HISTORICAL] 原另一写点 discardInFlightCalls 的 delete 随重试矩阵删除，
 * ADR-0122），实例不等 ⟺ 本 finalize 属于被替换的旧代际——与 dispatch 层
 * .then/.catch 守卫（S7-second 修复，8353f6b60）同一判定语义，本守卫只是把它
 * 前移到 trace.update 之前。markDone 与 sessionId/sessionFile 同步保留（markDone
 * 在孤儿实例上无害，dispatch 层 catch 路径依赖 call.status 语义）。跳过时不记
 * 日志——本文件是纯函数层无日志通道，dispatch 层 .then 守卫的 orphan completion
 * dropped 日志已覆盖同一事件的可观察性。
 */
function finalizeCall(
  call: AgentCall,
  result: AgentResult,
  trace: Trace,
  isOrphaned?: () => boolean,
): void {
  call.markDone(result);
  const status = result.error === undefined ? "completed" : "failed";
  // 同步 AgentCall 的 sessionId/sessionFile（对齐 trace 节点，持久化 + reset 用）
  if (result.sessionId !== undefined) call.setSessionId(result.sessionId);
  if (result.sessionFile !== undefined) call.setSessionFile(result.sessionFile);
  if (isOrphaned?.()) return;
  trace.update(call.id, {
    status,
    result,
    completedAt: new Date().toISOString(),
    sessionId: result.sessionId,
    sessionFile: result.sessionFile,
  });
}

// ── executeAgentCall ─────────────────────────────────────────

/**
 * 执行单次 agent 调用（无自动重试，ADR-0122）。
 *
 * 流程：
 * 1. markRunning（attempts++，恒 1——无重试）
 * 2. await runner.run(opts, signal, onEvent, stream)（AgentRunner port，infra 实现 spawn pi 子进程）
 * 3. 若 result.usage 存在：consumeUsage（D.4 修复）
 * 4. finalizeCall（completed 或 failed）+ incrementCallCount——失败显式上报，
 *    不重试不退避
 *
 * @param call AgentCall 实体（markRunning/markDone 由本函数驱动）
 * @param runner AgentRunner port（执行子进程）
 * @param budget Budget 值对象（consumeUsage 累加）
 * @param signal AbortSignal（runner.run 传播）
 * @param trace Trace 值对象（finalizeCall 时 update）
 * @param onEvent 透传 service 派发路径（journal 转发 + 守护刷新源）
 * @param stream streaming sink（透传 runner.run）
 * @param isOrphaned 孤儿判定谓词（OB2，可选，默认恒 false）：true 时 finalizeCall
 *   跳过 trace.update（判定语义与正确性论证见 finalizeCall 文档注释）。
 */
export async function executeAgentCall(
  call: AgentCall,
  runner: AgentRunner,
  budget: Budget,
  signal: AbortSignal,
  trace: Trace,
  onEvent?: (event: AgentEvent) => void,
  stream?: AgentStreamSink,
  isOrphaned?: () => boolean,
): Promise<void> {
  call.markRunning();

  const result = await runner.run(call.opts, signal, onEvent, stream);

  // 累加 usage（加权由 budget.consume 内部按权重常量处理，见 budget.ts）
  if (result.usage) {
    budget.consume(result.usage);
  }

  // 终态（成功或失败，无自动重试——ADR-0122：失败显式上报）
  finalizeCall(call, result, trace, isOrphaned);
  budget.incrementCallCount();
}
