/**
 * Workflow Extension — executeAgentCall（关键路径）
 *
 * 单次 agent 调用执行的 Engine free function（D-12）。显式 5 参数
 * `(call, runner, budget, signal, trace)`，无依赖注入 bag（AC-2：消除散落的
 * Context factory）。
 *
 * 职责：
 * - 重试：3 次 + 指数退避（BACKOFF_MS = [1000, 2000, 4000]）
 * - 预算：超限不重试（直接 markDone failed）
 * - stale-context（result.failureKind="stale_context"）：不重试（直接 markDone failed）
 * - [MF-1] 确定性 schema 失败（result.failureKind="schema_deterministic"）：不重试
 *   （直接 markDone failed）
 * - 成功：consume usage + incrementCallCount + markDone + trace.update(completed)
 *
 * [D5-③ 结构化分诊] 失败分诊读 AgentResult.failureKind 字段（产出侧唯一识别点 =
 * execution/engine/inproc pi 引擎目录/output-collector.ts 的 classifyFailureKind，词表归属
 * 见其文件头）。本模块不再扫 error 文案子串——**语义守恒（r1 MF4）**：unknown
 * （含字段缺省）= 可重试，保持收敛前的默认重试语义；仅 stale_context（不重试、
 * 换参重发场景由调用方编排）与 schema_deterministic 维持特判。
 *
 * 关键设计：
 * - **usage 透传**：result.usage 直接交给 budget.consume，加权由 Budget 内部的权重常量
 *   处理（见 budget.ts）。此函数不再做 usage 形状的改写。
 * - **参数显式化**：runner 直接传入（而非 ctx.getRun(runId).pool），无 runId 查找 / pool 守卫。
 * - **stale-state 检查**：signal.aborted 时早返回。WorkflowRun 状态由调用方 lifecycle
 *   持有，executeAgentCall 只关心单次 call 生命周期。
 *
 * 层归属：Engine。零 infra 依赖（runner 是 AgentRunner port，budget/trace/call 是 Engine 模型）。
 *
 * 参考：domain-models.md §5 + §失败处理矩阵。
 */

import type { SubagentStream } from "../execution/stream-sink.ts";
import type { AgentEvent } from "../shared/agent-event.ts";
import type { AgentCall } from "./models/agent-call.ts";
import type { Budget } from "./models/budget.ts";
import type { AgentRunner } from "./models/ports.ts";
import type { Trace } from "./models/trace.ts";
import type { AgentResult } from "./models/types.ts";

// ── 常量 ─────────────────────────────────────────────────────

/** 指数退避基数（ms）：第 n 次重试等待 BASE^n。 */
const BACKOFF_BASE_MS = 1000;
const BACKOFF_EXPONENT_BASE = 2;

/** 最大尝试次数（含首次）：initial + 2 retries = 3。 */
const MAX_ATTEMPTS = 3;

// ── 内部 helper ──────────────────────────────────────────────

/**
 * 计算第 n 次重试前的退避时间（ms）。
 * 第 1 次重试 → 1000ms，第 2 次 → 2000ms，第 3 次 → 4000ms（指数退避）。
 */
function backoffDelay(retryIndex: number): number {
  return BACKOFF_BASE_MS * Math.pow(BACKOFF_EXPONENT_BASE, retryIndex - 1);
}

/**
 * 终态化单次 call：markDone + trace.update。
 *
 * 成功：status="completed"；失败：status="failed"。
 * traceNode.stepIndex === call.id（D-10 单源，调用方保证）。
 *
 * 孤儿守卫（OB2，S7 残留）：isOrphaned 谓词为 true 时跳过 trace.update——
 * rebuild 竞态窗口中，重跑 dispatch 已 append 同 stepIndex 新节点，旧代际
 * finalize 的 update 会命中新节点，TUI/中间快照短暂可见错误终态。正确性论证：
 * 运行期 calls Map 写点仅 discardInFlightCalls 的 delete 与 dispatchAgentCall 的
 * set 两族（worker-message-pump.ts isOrphanedCall 文档注释既定），故实例不等 ⟺ 本
 * finalize 属于被丢弃/被替换的旧代际——与 dispatch 层 .then/.catch 守卫
 * （S7-second 修复，8353f6b60）同一判定语义，本守卫只是把它前移到 trace.update
 * 之前。markDone 与 sessionId/sessionFile 同步保留（markDone 在孤儿实例上无害，
 * dispatch 层 catch 路径依赖 call.status 语义）。跳过时不记日志——本文件是纯
 * 函数层无日志通道，dispatch 层 .then 守卫的 orphan completion dropped 日志已
 * 覆盖同一事件的可观察性。
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

/**
 * 延迟工具（testable —— 测试可通过 fake timers 推进）。
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

// ── executeAgentCall ─────────────────────────────────────────

/**
 * 执行单次 agent 调用，含重试 + 预算 + stale-context 检测。
 *
 * 流程：
 * 1. markRunning（attempts++，含首次）
 * 2. await runner.run(opts, signal)（AgentRunner port，infra 实现 spawn pi 子进程）
 * 3. 若 result.usage 存在：consumeUsage（D.4 修复）
 * 4. stale-context → finalizeCall failed，返回（不重试）
 * 5. signal.aborted → 返回（调用方已终止，不重试）
 * 6. budget.isExceeded → finalizeCall failed，返回（不重试）
 * 7. 失败 && attempts < MAX → 退避后递归（下一次 markRunning）
 * 8. 否则 finalizeCall（completed 或 failed）+ incrementCallCount
 *
 * @param call AgentCall 实体（markRunning/markDone 由本函数驱动）
 * @param runner AgentRunner port（执行子进程）
 * @param budget Budget 值对象（consume + isExceeded 检查）
 * @param signal AbortSignal（runner.run 传播；abort 后不重试）
 * @param trace Trace 值对象（finalizeCall 时 update）
 * @param onEvent 透传 service 派发路径（journal 转发 + 守护刷新源）
 * @param stream streaming sink（透传 runner.run）
 * @param isOrphaned 孤儿判定谓词（OB2，可选，默认恒 false）：true 时 finalizeCall
 *   跳过 trace.update（判定语义与正确性论证见 finalizeCall 文档注释）。递归重试
 *   透传本谓词。
 */
export async function executeAgentCall(
  call: AgentCall,
  runner: AgentRunner,
  budget: Budget,
  signal: AbortSignal,
  trace: Trace,
  onEvent?: (event: AgentEvent) => void,
  stream?: SubagentStream,
  isOrphaned?: () => boolean,
): Promise<void> {
  call.markRunning();

  const result = await runner.run(call.opts, signal, onEvent, stream);

  // 累加 usage（加权由 budget.consume 内部按权重常量处理，见 budget.ts）
  if (result.usage) {
    budget.consume(result.usage);
  }

  // stale-context（D5-③ 结构化分诊：读 failureKind 字段，词表识别在产出侧
  // output-collector）：不重试（P1-5）
  if (result.error !== undefined && result.failureKind === "stale_context") {
    finalizeCall(call, result, trace, isOrphaned);
    budget.incrementCallCount();
    return;
  }

  // [MF-1] 确定性 schema 失败（failureKind="schema_deterministic"）：不重试
  // （gate 终止/不可满足 schema 同 schema 重试必同结果——重试纯烧钱；三态矩阵
  // 见产出侧 output-collector 的确定性失败标记注释）
  if (result.error !== undefined && result.failureKind === "schema_deterministic") {
    finalizeCall(call, result, trace, isOrphaned);
    budget.incrementCallCount();
    return;
  }

  // signal 已 abort：调用方终止，不重试（避免无意义的递归）
  if (signal.aborted) {
    finalizeCall(call, result, trace, isOrphaned);
    budget.incrementCallCount();
    return;
  }

  // 预算超限：不重试（重试只会突破预算且无意义）
  if (result.error !== undefined && budget.isExceeded()) {
    finalizeCall(call, result, trace, isOrphaned);
    budget.incrementCallCount();
    return;
  }

  // 可重试失败：退避后递归
  if (result.error !== undefined && call.attempts < MAX_ATTEMPTS) {
    await delay(backoffDelay(call.attempts));
    // 退避期间 signal 可能 abort
    if (signal.aborted) {
      finalizeCall(call, result, trace, isOrphaned);
      budget.incrementCallCount();
      return;
    }
    await executeAgentCall(call, runner, budget, signal, trace, onEvent, stream, isOrphaned);
    return;
  }

  // 终态（成功或达到重试上限的失败）
  finalizeCall(call, result, trace, isOrphaned);
  budget.incrementCallCount();
}
