// src/output-collector.ts
//
// 结果收集器（W7 迁 pi 包，core engines/pi/output-collector.ts 的协议化改写）。
//
// 差异（协议化裁决，deviations 登记）：core 版从 ExecutionRecord 派生
// （getFullText/getAllToolCalls/getTotalUsage）；本包的累积器是 SDK
// journal-replay 的 ReplayRecordView（同一 reducer 的 SDK 下沉副本）——
// 派生逻辑在本文件内自持等价实现（turns 聚合），AgentResult 域类型改 SDK
// AgentOutcome 的载荷子集。失败分诊词表与三态归因逐字保留（产出侧单点）。

import type {
  AgentFailureKind,
  ToolCall,
  Turn,
} from "@zhushanwen/subagent-engine-sdk";
import type { ReplayRecordView } from "@zhushanwen/subagent-engine-sdk";

// ============================================================
// 失败分诊词表（D5-③，产出侧单点；与 core 版逐字等价）
// ============================================================

/**
 * Stale context 检测模式（P1-5；W4b 对齐 pi 0.84.x 真实文案）。
 * 命中时分诊 failureKind="stale_context"——重试只会再次失败。
 */
export const STALE_CONTEXT_PATTERNS = [
  "ctx is stale",
  "stale after session replacement",
  "context canceled",
  "aborted",
] as const;

/** 判断错误信息是否表示 stale/canceled pi session context。 */
export function isStaleContextErrorMsg(msg: string | undefined): boolean {
  if (!msg) return false;
  const lower = msg.toLowerCase();
  return STALE_CONTEXT_PATTERNS.some((p) => lower.includes(p));
}

/**
 * [MF-1] 确定性 schema 失败标记（error 文本前缀，产出方 = 本模块的
 * describeMissingParsedOutput）。标记词与 stale 词表零交集（防归因污染）。
 */
export const DETERMINISTIC_SCHEMA_FAILURE_PREFIX = "Structured output failed deterministically:";

/** [MF-1] 判断错误信息是否为确定性 schema 失败（命中标记前缀）。 */
export function isDeterministicSchemaFailureMsg(msg: string | undefined): boolean {
  if (!msg) return false;
  return msg.includes(DETERMINISTIC_SCHEMA_FAILURE_PREFIX);
}

/**
 * [D5-③] 错误文案 → 结构化失败分诊标签（产出侧唯一识别点，stale 在前）。
 * 未命中任何词表 → unknown——消费侧默认退避重试（语义守恒）。
 */
export function classifyFailureKind(
  msg: string | undefined,
): AgentFailureKind | undefined {
  if (msg === undefined) return undefined;
  if (isStaleContextErrorMsg(msg)) return "stale_context";
  if (isDeterministicSchemaFailureMsg(msg)) return "schema_deterministic";
  return "unknown";
}

// ============================================================
// Result 收集
// ============================================================

/** collectOutcome 的入参（session 身份 + 执行控制字段，执行内容从 record 读）。 */
export interface CollectResultArgs {
  startTime: number;
  success: boolean;
  error: string | undefined;
  sessionId: string;
  sessionFile: string | undefined;
  /**
   * [F-1] 本次执行是否要求结构化产出（schema 或 schemaEnv 任一存在）。
   * true 且 run 结束仍无有效 parsedOutput 时：结果不得静默 success。
   */
  schemaExpected?: boolean;
}

/** structured-output tool 名（与 structured-output 扩展 TOOL_NAME 一致）。 */
const STRUCTURED_OUTPUT_TOOL = "structured-output";

/** F-1 失败摘要截断长度（字符）。 */
const FAILED_SO_SUMMARY_MAX_CHARS = 300;

/**
 * 从 toolCalls 提取 structured-output 的 result.details（schema 模式产出）。
 * isError:true 的调用一律跳过（失败调用的 details 不是通过校验的产出）。
 */
export function extractParsedOutput(toolCalls: ToolCall[]): unknown {
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    const tc = toolCalls[i]!;
    if (tc.toolName === STRUCTURED_OUTPUT_TOOL && tc.isError !== true && tc.result?.details !== undefined) {
      return tc.result.details;
    }
  }
  return undefined;
}

/**
 * [F-R1] 中和动态错误摘要中的 stale-context 命中词（大小写不敏感子串替换为
 * "[redacted]"——防拼接结果被 classifyFailureKind 误诊 stale_context）。
 */
export function neutralizeStalePatterns(text: string): string {
  let out = text;
  for (const pattern of STALE_CONTEXT_PATTERNS) {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "gi"), "[redacted]");
  }
  return out;
}

/**
 * schema 模式下无有效 parsedOutput 时的三态失败归因（F-1）。
 * 三态判定优先级：校验失败（有 isError 调用）> 从未调用 SO tool > 调用过但无 details。
 */
export function describeMissingParsedOutput(toolCalls: ToolCall[]): string | undefined {
  if (extractParsedOutput(toolCalls) !== undefined) return undefined;
  const soCalls = toolCalls.filter((tc) => tc.toolName === STRUCTURED_OUTPUT_TOOL);
  if (soCalls.length === 0) {
    return (
      `${DETERMINISTIC_SCHEMA_FAILURE_PREFIX} ` +
      "Agent finished without producing a structured output: the structured-output tool was never called. " +
      "Recovery: verify the structured-output extension is installed and enabled for this agent, " +
      "and that the agent's final answer conforms to the requested schema."
    );
  }
  const failed = soCalls.filter((tc) => tc.isError === true);
  if (failed.length > 0) {
    const last = failed[failed.length - 1]!;
    const lastErrorSummary = neutralizeStalePatterns(summarizeToolContent(last.result?.content));
    const failureKind = lastErrorSummary.toLowerCase().includes("validation failed")
      ? "schema validation"
      : "execution failure";
    return (
      `${DETERMINISTIC_SCHEMA_FAILURE_PREFIX} ` +
      `Agent finished without a valid structured output: ${failed.length} structured-output call(s) failed ` +
      `(${failureKind}). Last error: ${lastErrorSummary}`
    );
  }
  return (
    "Agent finished without a valid structured output: structured-output was called but none of the " +
    "successful calls carried result details."
  );
}

/** 从 tool result.content 提取可读错误文本（[{type:"text",text}] 形态，防御未知形状）。 */
function summarizeToolContent(content: unknown): string {
  let summary = "(no detail)";
  if (Array.isArray(content)) {
    const texts = content
      .map((item) => (item && typeof item === "object" && "text" in item ? String((item as { text: unknown }).text) : ""))
      .filter((t) => t !== "");
    if (texts.length > 0) summary = texts.join(" ");
  } else if (typeof content === "string" && content !== "") {
    summary = content;
  }
  return summary.length > FAILED_SO_SUMMARY_MAX_CHARS
    ? `${summary.slice(0, FAILED_SO_SUMMARY_MAX_CHARS)}...`
    : summary;
}

// ── ReplayRecordView 派生（core execution-record 同名派生的等价实现） ──

/** 全量 assistant 文本（turns[].text 以空行 join，与 core getFullText 语义一致）。 */
export function getFullText(record: ReplayRecordView): string {
  return record.turns
    .map((t: Turn) => t.text)
    .filter((t) => t !== undefined && t.length > 0)
    .join("\n\n");
}

/** 扁平化所有 turns 的 toolCalls（与 core getAllToolCalls 等价）。 */
export function getAllToolCalls(record: ReplayRecordView): ToolCall[] {
  const out: ToolCall[] = [];
  for (const turn of record.turns) {
    out.push(...turn.toolCalls);
  }
  return out;
}

/** 引擎侧 run 收集结果（AgentOutcome 的载荷装配点）。 */
export interface CollectedOutcome {
  content: string;
  turns: number;
  durationMs: number;
  success: boolean;
  error: string | undefined;
  sessionId: string;
  sessionFile: string | undefined;
  toolCalls: ToolCall[];
  parsedOutput: unknown;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: number } | undefined;
  failureKind: AgentFailureKind | undefined;
}

/** usage 聚合（turns[].usageDelta 求和，全零则 undefined——与 core getTotalUsage 语义一致）。 */
function aggregateUsageDelta(record: ReplayRecordView): CollectedOutcome["usage"] {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let hasCost = false;
  let any = false;
  for (const turn of record.turns) {
    const u = turn.usageDelta;
    if (u === undefined) continue;
    any = true;
    input += u.input ?? 0;
    output += u.output ?? 0;
    cacheRead += u.cacheRead ?? 0;
    cacheWrite += u.cacheWrite ?? 0;
    if (u.cost !== undefined) {
      cost += u.cost;
      hasCost = true;
    }
  }
  if (!any) return undefined;
  return { input, output, cacheRead, cacheWrite, ...(hasCost ? { cost } : {}) };
}

/**
 * 从 ReplayRecordView + args 组装引擎侧结果。
 *
 * success 双来源判定（调用方传入）：
 *   ① 子进程 spawn/执行失败 → args.success=false
 *   ② 执行成功但 record.lastError 非空（message_end stopReason=error）→ success=false
 */
export function collectOutcome(
  record: ReplayRecordView,
  args: CollectResultArgs,
): CollectedOutcome {
  const toolCalls = getAllToolCalls(record);
  const parsedOutput = extractParsedOutput(toolCalls);
  let success = args.success;
  let error = args.error;
  // [F-1] schema 模式下 run 结束仍无有效 parsedOutput 时不得静默 success
  if (args.schemaExpected === true && success && parsedOutput === undefined) {
    success = false;
    error = describeMissingParsedOutput(toolCalls) ?? error;
  }
  if (success && record.lastError !== undefined) {
    success = false;
    error = record.lastError;
  }
  return {
    content: getFullText(record),
    turns: record.turnCount,
    durationMs: Date.now() - args.startTime,
    success,
    error,
    sessionId: args.sessionId,
    sessionFile: args.sessionFile,
    toolCalls,
    parsedOutput,
    usage: aggregateUsageDelta(record),
    // [D5-③] 失败分诊结构化：error 最终确定后一次分类写入
    failureKind: error !== undefined ? classifyFailureKind(error) : undefined,
  };
}
