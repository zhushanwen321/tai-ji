// src/execution/assembly/agent-result-mapper.ts
//
// D-A10: subagents AgentResult → workflow AgentResult 映射。
// 纯 DTO 映射函数——executeAndAwait 出口调，SAR 不感知形状差异。
//
// 接线层级：[模块内直调] —— SubagentService.executeAndAwait 出口调。

import type { AgentResult as WorkflowAgentResult, AgentUsage as WorkflowAgentUsage, ToolCallEntry } from "../../orchestration/models/types.ts";
import type { AgentResult as SubagentsAgentResult, AgentUsageTotal, ToolCall } from "./types.ts";

/** safeStringify 的 JSON 截断长度（字符），防大对象拼进 toolCalls 挤爆 trace。 */
const TOOL_ARGS_JSON_MAX_CHARS = 500;

/**
 * D-A10: subagents AgentResult → workflow AgentResult 映射。
 *
 * 字段映射表：
 *   subagents                         → workflow
 *   ─────────────────────────────────────────────
 *   text                              → content
 *   parsedOutput                      → parsedOutput（structured-output 契约，BC-8）
 *   !success && error                 → error（失败时填，成功时 undefined）
 *   !success && !error                → error fallback（abort 路径：session-runner 设 success=false,error=undefined，
 *                                      若直接透传 undefined 则 executeAgentCall 的 `error===undefined` 误判 completed。H4 修复：synthesize fallback）
 *   durationMs                        → durationMs
 *   sessionId                         → sessionId
 *   usage (AgentUsageTotal)           → usage (AgentUsage: input/output/cacheRead/cacheWrite/cost/contextTokens/turns)
 *   toolCalls (ToolCall[])            → toolCalls (ToolCallEntry[]: name/input)
 *
 * @param r subagents 管道产出的 AgentResult（runSpawn/collectResult 出口形状）
 * @returns workflow 编排层消费的 AgentResult（executeAgentCall/finalizeCall 入参形状）
 */
export function mapToWorkflowAgentResult(
  r: SubagentsAgentResult,
): WorkflowAgentResult {
  return {
    content: r.text,
    // [D5-③] 失败分诊标签透传（产出侧 output-collector 写入，消费侧
    // executeAgentCall 读字段分诊）。成功路径 undefined 不落键。
    ...(r.failureKind !== undefined ? { failureKind: r.failureKind } : {}),
    parsedOutput: r.parsedOutput,
    error: r.success ? undefined : (r.error || "Agent call failed (aborted or unknown error)"),
    durationMs: r.durationMs,
    sessionId: r.sessionId,
    sessionFile: r.sessionFile,
    usage: r.usage ? mapUsage(r.usage, r.turns) : undefined,
    toolCalls: r.toolCalls ? mapToolCalls(r.toolCalls) : undefined,
  };
}

/**
 * AgentUsageTotal（subagents）→ AgentUsage（workflow）映射。
 *
 * subagents AgentUsageTotal: { input, output, cacheRead, cacheWrite, total, cost }
 * workflow AgentUsage:       { input, output, cacheRead, cacheWrite, cost, contextTokens, turns }
 *
 * contextTokens ≈ total（subagents 的四项之和，近似上下文 token 量）。
 * turns 来自 AgentResult.turns（非 usage 内字段）。
 */
function mapUsage(u: AgentUsageTotal, turns: number): WorkflowAgentUsage {
  return {
    input: u.input,
    output: u.output,
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite,
    cost: u.cost,
    contextTokens: u.total,
    turns,
  };
}

/**
 * ToolCall（subagents）→ ToolCallEntry（workflow）映射。
 *
 * subagents ToolCall:     { toolName, args?, result?, isError? }
 * workflow ToolCallEntry: { name, input }
 */
function mapToolCalls(calls: ToolCall[]): ToolCallEntry[] {
  return calls.map((c) => ({
    name: c.toolName,
    input: c.args === undefined ? "" : safeStringify(c.args),
  }));
}

/** 安全序列化（args 可能含循环引用或大对象，截断防 OOM）。 */
function safeStringify(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s.length > TOOL_ARGS_JSON_MAX_CHARS ? `${s.slice(0, TOOL_ARGS_JSON_MAX_CHARS)}...` : s;
  } catch {
    return String(value);
  }
}
