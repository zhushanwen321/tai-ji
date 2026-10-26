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
  FailureCause,
  ToolCall,
  Turn,
} from "@zhushanwen/subagent-engine-sdk";
import {
  ENGINE_SPAWN_DELIVERY_ERROR_RECOVERY,
} from "@zhushanwen/subagent-engine-sdk";
import type { ReplayRecordView } from "@zhushanwen/subagent-engine-sdk";

import {
  classificationMatchInputs,
  deriveKindForRule,
  findClassificationRule,
  loadRetryRulesForClassification,
  verdictToRetryable,
  type RetryRuleClassificationView,
} from "./retry-rules-classification.ts";
import type { EngineRoundErrorFact } from "./spawn-event-translator.ts";
import type { PromptAckResult } from "./prompt-ack.ts";
import type { TurnBudgetExhaustion } from "./turn-limiter.ts";

// ============================================================
// 失败分诊词表（D5-③，产出侧单点；与 core 版逐字等价）
// ============================================================

/**
 * Stale context 检测模式（P1-5；W4b 对齐 pi 0.84.x 真实文案）。
 * 命中时分诊 failureKind="stale_context"——重试只会再次失败。
 *
 * abort 词登记 pi 实装精确字面量（pi-ai dist/utils/abort.js:4 的 "The operation
 * was aborted"），不收裸词 "aborted"——裸词子串会把任何携带 aborted 字样的动态错误
 * （如 provider 的 "request aborted while busy"）误诊为 stale context（枚举清理项 P8）。
 */
export const STALE_CONTEXT_PATTERNS = [
  "ctx is stale",
  "stale after session replacement",
  "context canceled",
  "the operation was aborted",
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
 * [M2 D3/D10] 引擎侧 spawn/送达错误码前缀（产出侧识别点；码表/recovery 文案 SSOT =
 * SDK protocol/error-codes.ts ENGINE_SPAWN_DELIVERY_ERROR_CODES——本表只收
 * outcome.error 文本里的「码前缀」形态，供确定性分诊）。
 */
export const ENGINE_SPAWN_DELIVERY_ERROR_PREFIXES = [
  "engine_prompt_not_delivered:",
  "engine_prompt_rejected:",
  "engine_spawn_handshake_timeout:",
] as const;

/** 判断错误信息是否为引擎 spawn/送达窗口错误（码前缀确定性判定）。 */
export function isEngineSpawnDeliveryErrorMsg(msg: string | undefined): boolean {
  if (!msg) return false;
  return ENGINE_SPAWN_DELIVERY_ERROR_PREFIXES.some((p) => msg.startsWith(p));
}

/**
 * [M2 D3/D10] 错误文案 → 结构化失败分诊标签——历史解析兼容词表谓词
 * （@deprecated 见下）。
 *
 * @deprecated [subagent-observability §3.3.2] 子串分诊已退役（8 案例 collapse 的直接
 * 原因——业务规则依赖 IO 文案形态而非事实结构）：u1 起 collectOutcome 的失败分类
 * 改由收尾边沿结构化事实一次产出（classifyFailureCause → FailureCause 判别联合），
 * 本函数不再参与 outcome 生产路径。保留导出 = 存量跨包测试（subagent-core
 * execute-agent-call.test.ts）仍 import 其词表谓词；全量删除随设计 §3.4 枚举清理项
 * （RunErrorCode failureKind 成员族与 record 侧 failureKind 字段同批清理）执行。
 */
export function classifyFailureKind(
  msg: string | undefined,
): AgentFailureKind | undefined {
  if (msg === undefined) return undefined;
  if (isEngineSpawnDeliveryErrorMsg(msg)) return "unknown";
  if (isStaleContextErrorMsg(msg)) return "stale_context";
  if (isDeterministicSchemaFailureMsg(msg)) return "schema_deterministic";
  return "unknown";
}

// ============================================================
// [subagent-observability §3.3.2] FailureCause 收尾边沿分类（结构化输入，唯一产点）
// ============================================================

/**
 * [§3.3.2 机读主通道] openai 兼容层（主力 provider）errorMessage 恒为
 * `"<status>: <body>"` 前缀拼法（pi-ai dist/utils/error-body.js:111
 * formatProviderError 实证，1.0.0 实装核实）——status 前缀是引擎内置 HTTP 语义层的
 * 机读入口。
 */
const PROVIDER_STATUS_PREFIX_PATTERN = /^(\d{3}):\s*/;

/**
 * [§3.3.2 码表硬约束] 429 不全可重试（欠费/套餐到期/公平使用限制同走 429）——
 * status 层只定大类，retryable 禁止按状态码判 true；内置层对限流族落
 * "conditional"（条件恢复——等限额重置窗口或人/账户先动作），provider 业务码
 * 层的精确裁决归 remote-config 词表域（§3.3.12 同域，随 W6 落地）。
 */
const HTTP_STATUS_REQUEST_TIMEOUT = 408;
const HTTP_STATUS_TOO_MANY_REQUESTS = 429;
const RATE_LIMIT_STATUSES: ReadonlySet<number> = new Set([
  HTTP_STATUS_REQUEST_TIMEOUT,
  HTTP_STATUS_TOO_MANY_REQUESTS,
]);

/** HTTP 4xx/5xx 类边界（内置 status 语义层的判类区间）。 */
const HTTP_STATUS_CLASS_CLIENT_ERROR = 400;
const HTTP_STATUS_CLASS_SERVER_ERROR = 500;

/** 非 429 4xx = 请求/凭据/协议形态问题——重发必然同样失败（retryable false）。 */
function isProtocolClassStatus(status: number): boolean {
  return (
    status >= HTTP_STATUS_CLASS_CLIENT_ERROR &&
    status < HTTP_STATUS_CLASS_SERVER_ERROR &&
    !RATE_LIMIT_STATUSES.has(status)
  );
}

/**
 * [§3.3.2 兜底文案词表] pi 侧能力错误（无 HTTP status/body 可读的形态）。pi 错误
 * 文案为模块内固定常量（先例：pi-ai retry 词表同为模块常量），字面量稳定可登记，
 * 新字面量登记制扩展。恢复指引 = 换 model/provider（protocol_unsupported 语义）。
 */
const PI_FALLBACK_ERROR_LITERALS: ReadonlyArray<{
  pattern: string;
  cause: { class: "provider"; kind: "protocol_unsupported"; retryable: false };
}> = [
  {
    // pi-ai models.js:561 `Provider ${id} has no API implementation for "${api}"`
    pattern: "has no API implementation",
    cause: { class: "provider", kind: "protocol_unsupported", retryable: false },
  },
];

/** 秒 → 毫秒折算（retry-after 秒数形态的乘数）。 */
const MS_PER_SECOND = 1000;

/**
 * [§3.3.2 retryAfterMs 文本兜底通道] 错误文本内重置时间字样提取。皆无结构化
 * Retry-After 载体时这是唯一现实来源（resets 时间戳无结构化字段）；
 * 皆无命中 → undefined（缺省 unknown，不产假 0）。
 */
export function extractRetryAfterMsFromText(text: string, nowMs: number): number | undefined {
  // 形态 1：ISO 时间戳——"resets 2026-10-23T06:58:00Z" / "resets at <ISO>"
  const iso = /resets?(?:\s+at)?\s+(\d{4}-\d{2}-\d{2}T[^\s"]+)/i.exec(text);
  if (iso?.[1] !== undefined) {
    const at = Date.parse(iso[1]);
    if (Number.isFinite(at)) return Math.max(0, at - nowMs);
  }
  // 形态 2：秒数——"retry after 120 s" / "try again in 90 seconds"
  const seconds = /(?:retry\s+(?:after|in)|try\s+again\s+in)\s+(\d+)\s*(?:s\b|sec|second)/i.exec(text);
  if (seconds?.[1] !== undefined) {
    const n = Number(seconds[1]);
    if (Number.isFinite(n)) return n * MS_PER_SECOND;
  }
  return undefined;
}

/** classifyFailureCause 的输入（收尾边沿结构化事实 + limiter 耗尽事实位）。 */
export interface FailureCauseInput {
  /** translator 收尾边沿事实（onErroredEnd 载荷；undefined = 无错误停因形态）。 */
  terminalError?: EngineRoundErrorFact;
  /** limiter abort 事实位（SIGKILL 直杀路径——进程死前无 message_end 停因可采）。 */
  turnBudgetExhausted?: boolean;
  /**
   * [subagent-observability §3.3.9/UC-10] limiter 耗尽事实（{used, limit}，abort 边沿
   * 一次产出）：随 turnBudgetExhausted 事实位/turn-budget 停因支进入 cause.budget
   * 结构化承载。undefined = 事实缺席（极端竞窗，轮失败事实不受影响）。
   */
  turnBudget?: TurnBudgetExhaustion;
  /**
   * [subagent-observability §3.3.2/§3.3.12] 分类码表（ext-config effectiveRules 段，
   * 与 message_end 改写判定同文件同数据的两个消费方）——provider 业务码层的精确
   * class/kind/verdict 裁决。undefined = 配置缺席/坏形状（安全缺省，回落内置 HTTP
   * 语义层 + 兜底文案）。collectOutcome 生产路径经 loadRetryRulesForClassification
   * 读取；纯函数测试可直接注入。
   */
  retryRules?: readonly RetryRuleClassificationView[];
}

/**
 * [subagent-observability §3.3.2] 收尾边沿 FailureCause 分类（唯一产点，一次产出，
 * 下游只读不可替换）。cause 优先级严格递减：provider 事实 > harness 预算/契约 >
 * agent 行为 > engine 崩溃 > unknown（未分类形态不产 FailureCause，落引擎停因原值）。
 *
 * 分层序（stopReason=error 支）：① provider→code→class 码表（remote-config 域，
 * retryRules 注入——分类与改写共用的同一份 ext-config 数据，§3.3.12；业务码层命中即
 * 按规则 class/kind/verdict 裁决，码表硬约束「retryable 必须由 provider 业务码层
 * 裁决」的结构承载）；② 未命中 → status→class 的 HTTP 语义层（引擎内置，稳定）+
 * pi 兜底文案词表；③ 皆未命中 → 不产（保守 unknown，不猜）。
 */
/** harness 预算耗尽 FailureCause 骨架（两产点共用：事实位直杀路径与 aborted 停因路径；raw/budget 来源各异）。 */
function harnessBudgetCause(raw: string, budget: TurnBudgetExhaustion | undefined): FailureCause {
  return {
    class: "harness",
    kind: "turn_budget_exhausted",
    retryable: false,
    raw,
    ...(budget !== undefined ? { budget } : {}),
  };
}

export function classifyFailureCause(input: FailureCauseInput, nowMs: number = Date.now()): FailureCause | undefined {
  const { terminalError } = input;
  // harness 预算：limiter 耗尽是 SIGKILL 直杀路径（无停因事实可采），事实位优先。
  if (input.turnBudgetExhausted === true) {
    return harnessBudgetCause("turn budget exhausted after grace turns (limiter abort)", input.turnBudget);
  }
  if (terminalError === undefined) return undefined;
  const raw = terminalError.errorMessage;
  // [§3.3.1 三源判别] aborted 的三源裁决在收尾边沿已定：宿主取消（中止非失败）/
  // limiter 耗尽（防御性同判——事实位路径已前置） / 引擎异常兜底。
  if (terminalError.stopReason === "aborted") return classifyAbortedCause(terminalError, raw);
  // stopReason=error：① provider 业务码层（分类码表消费，结构化输入优先——见
  // classificationMatchInputs）。
  const byRules = classifyByRetryRules(terminalError, raw, input.retryRules, nowMs);
  if (byRules !== undefined) return byRules;
  // ② 机读主通道（status 前缀）→ 内置 HTTP 语义层。
  const byStatus = classifyByStatusLayer(raw, nowMs);
  if (byStatus !== undefined) return byStatus;
  // 兜底文案词表（pi 模块常量字面量）。
  for (const entry of PI_FALLBACK_ERROR_LITERALS) {
    if (raw.includes(entry.pattern)) {
      return { ...entry.cause, raw } satisfies FailureCause;
    }
  }
  // 未分类形态不产 FailureCause（引擎停因原值承载事实）。
  return undefined;
}

/** aborted 停因三源判别（宿主取消 / limiter 耗尽 / 引擎异常兜底），cause 优先级内聚单点。 */
function classifyAbortedCause(terminalError: EngineRoundErrorFact, raw: string): FailureCause {
  if (terminalError.abortSource === "host-cancel") {
    return { class: "user", kind: "cancelled", retryable: false, raw };
  }
  if (terminalError.abortSource === "turn-budget") {
    // [§3.3.9/UC-10] 停因事实的 turnBudget 快照（EngineRoundErrorFact.turnBudget）
    // 优先；无快照的竞窗形态事实不足不产结构（budget 缺省）。
    return harnessBudgetCause(raw, terminalError.turnBudget);
  }
  return { class: "engine", kind: "engine_aborted", retryable: false, raw };
}

/**
 * ① provider 业务码层：分类码表命中即按规则 class/kind/verdict 裁决（码表硬约束
 * 「retryable 必须由 provider 业务码层裁决」的结构承载）。未命中返回 undefined 落
 * 下层。retryAfterMs 文本兜底通道对原始错误文本提取（规则的 waitHint 是展示文本
 * 非时间值，不参与提取）。
 */
function classifyByRetryRules(
  terminalError: EngineRoundErrorFact,
  raw: string,
  retryRules: readonly RetryRuleClassificationView[] | undefined,
  nowMs: number,
): FailureCause | undefined {
  if (retryRules === undefined || retryRules.length === 0) return undefined;
  const hit = findClassificationRule(classificationMatchInputs(terminalError), retryRules);
  if (hit === undefined) return undefined;
  const kind = deriveKindForRule(hit);
  if (kind === undefined) return undefined;
  // class×kind 组合合法性由运行时 guard 保证（narrowClassificationRule 的词表
  // 校验 / deriveKindForRule 只产合法缺省）——断言是对该 guard 的收口。
  const base = {
    class: hit.class,
    kind,
    retryable: verdictToRetryable(hit.verdict),
    raw,
  } as FailureCause;
  return withRetryAfterMs(base, raw, nowMs);
}

/** ② status 前缀机读主通道 → 内置 HTTP 语义层（稳定）。未命中/不判形态返回 undefined。 */
function classifyByStatusLayer(raw: string, nowMs: number): FailureCause | undefined {
  const statusMatch = PROVIDER_STATUS_PREFIX_PATTERN.exec(raw);
  if (statusMatch?.[1] === undefined) return undefined;
  const status = Number(statusMatch[1]);
  if (!Number.isFinite(status) || status < HTTP_STATUS_CLASS_CLIENT_ERROR) return undefined;
  if (RATE_LIMIT_STATUSES.has(status)) {
    const base: FailureCause = {
      class: "provider",
      kind: "rate_limited",
      retryable: "conditional",
      raw,
    };
    return withRetryAfterMs(base, raw, nowMs);
  }
  if (isProtocolClassStatus(status)) {
    return { class: "provider", kind: "protocol_unsupported", retryable: false, raw };
  }
  // 5xx / 其余：provider 业务码层缺席时不猜（保守 unknown，丢结构形态退化策略）。
  return undefined;
}

/** retryAfterMs 提取与合并单点（undefined = 文本无可提取时间值，原样返回）。 */
function withRetryAfterMs(base: FailureCause, raw: string, nowMs: number): FailureCause {
  const retryAfterMs = extractRetryAfterMsFromText(raw, nowMs);
  return retryAfterMs !== undefined ? { ...base, retryAfterMs } : base;
}

// ============================================================
// [M2 D3/D10] prompt 送达失败的终态文案（产出侧单点）
// ============================================================

/**
 * PromptAckResult → outcome.error 文案（collectRunResult 失败分支消费）。
 * 形态 = `<code>: <detail> Recovery: <recovery>`（与 engineTimeoutDetail 同款：
 * 恢复指引随文案内联；码前缀供 classifyFailureKind / 宿主分诊）。
 *   - timeout/lost → engine_prompt_not_delivered（零输出 / stdin 不可用 / EPIPE——
 *     任务从未被真实 pi 受理）；detail 已由 tracker 拼入诊断五元组摘要（有界）；
 *   - rejected → engine_prompt_rejected（已送达但被 pi 拒绝；带 pi error 文本）；
 *   - acked 不经此函数（正常 outcome）。
 */
export function describePromptAckFailure(failure: PromptAckResult): string {
  if (failure.kind === "acked") {
    throw new Error("describePromptAckFailure called with acked result (acks are not failures)");
  }
  if (failure.kind === "rejected") {
    return (
      `engine_prompt_rejected: pi rejected the prompt command: ${failure.detail}. ` +
      `Recovery: ${ENGINE_SPAWN_DELIVERY_ERROR_RECOVERY.engine_prompt_rejected}`
    );
  }
  // timeout / lost 同归 engine_prompt_not_delivered（D10：任务未送达；lost 的
  // detail 已含 stdin-unavailable/epipe 区分与诊断摘要）
  return (
    `engine_prompt_not_delivered: ${failure.detail}. ` +
    `Recovery: ${ENGINE_SPAWN_DELIVERY_ERROR_RECOVERY.engine_prompt_not_delivered}`
  );
}

/**
 * 退出码 → 失败 error 文案（collectRunResult 消费的单一装配点）：无结构化失败
 * 快照时走「child error / 退出码」文案。
 */
export function buildExitErrorText(
  exitCode: number,
  childErrorMessage: string | undefined,
): string {
  return childErrorMessage !== undefined
    ? `pi child error: ${childErrorMessage} (exit code ${exitCode})`
    : `pi child exited with code ${exitCode}`;
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
   * [F-1] 本次执行是否要求结构化产出（判定源 = task.schema 声明形态——schema
   * 本体存在与否，与 env 派生/注入值不同源）。true 且 run 结束仍无有效
   * parsedOutput 时：结果不得静默 success。
   */
  schemaExpected?: boolean;
  /**
   * [subagent-observability §3.3.1] 收尾边沿结构化轮终事实（spawn-runner 经 runEnd
   * 透传）——FailureCause 分类的权威输入；undefined = 无错误停因形态。
   */
  terminalError?: EngineRoundErrorFact;
  /** [§3.3.1 三源判别] limiter abort 事实位（SIGKILL 直杀路径的 turn-budget 支）。 */
  turnBudgetExhausted?: boolean;
  /**
   * [§3.3.9/UC-10] limiter 耗尽事实（{used, limit}）——随 turnBudgetExhausted 事实位
   * 传入，cause.budget 结构化承载。undefined = 事实缺席（轮失败事实不受影响）。
   */
  turnBudget?: TurnBudgetExhaustion;
  /**
   * [§3.3.1 P6-A] prompt disposition=handled 且执行从未启动（isStreaming=false 确定性
   * 立即轮终）：回执层成功 + engineStopReason 无值 + promptDisposition 字段定稿 +
   * 无 FailureCause（无失败发生——构造性不满足「正常收尾」派生，也不产失败分型）。
   */
  promptHandledNoRun?: boolean;
  /**
   * [P5 计账] 最终尝试的 turns 切片基（auto_retry_start 边界处的 turns 数）：
   * usage 聚合只取切片之后的 turns——轮收条 usage 记最终尝试值，失败尝试 usage
   * 不再静默计入（可经 record 事件流查询）。undefined = 无重试，全量聚合。
   */
  finalAttemptTurnBase?: number;
  /** [P5 计账] auto_retry_start 帧计数（重试波次，随 outcome 上报可见）。 */
  retryAttempts?: number;
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
  /** @deprecated [subagent-observability §3.3.2] 子串分诊退役——u1 起仅引擎送达错误码
   * 前缀保留确定性分诊值 "unknown"，其余失败归 undefined（FailureCause 承接分类）。 */
  failureKind: AgentFailureKind | undefined;
  turns: number;
  durationMs: number;
  success: boolean;
  error: string | undefined;
  sessionId: string;
  sessionFile: string | undefined;
  toolCalls: ToolCall[];
  parsedOutput: unknown;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: number } | undefined;
  /**
   * [subagent-observability §3.3.1/§3.3.3] 引擎停因原值（stop/error/aborted）：
   * 收尾边沿事实一次写死——错误轮 = terminalError.stopReason；正常收尾轮 =
   * "stop"（非 error/aborted 停因统一记 stop）；被接管轮（promptHandledNoRun）=
   * undefined（引擎未执行，无停因可言）。
   */
  engineStopReason?: "stop" | "error" | "aborted";
  /**
   * [subagent-observability §3.3.2] 失败分类（收尾边沿一次产出，下游只读不可替换）；
   * undefined = 未分类形态（落引擎停因原值，不产假分类）。
   */
  failure?: FailureCause;
  /** [§3.3.1 P6-A] prompt disposition 定稿字段——被接管轮 = "handled"。 */
  promptDisposition?: "handled";
  /** [§3.3.10] 观察性事实（F-1 兜底退役承载位——「SO 未调用」等不再伪造死因）。 */
  observations?: string[];
  /** [P5 计账] 重试波次计数（auto_retry_start 帧数；0/undefined = 无重试）。 */
  retryAttempts?: number;
}

/** usage 聚合（turns[].usageDelta 求和，全零则 undefined——与 core getTotalUsage 语义一致）。
 * fromIndex 供 [P5 计账] 最终尝试切片（undefined = 全量聚合）。 */
function aggregateUsageDelta(record: ReplayRecordView, fromIndex?: number): CollectedOutcome["usage"] {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let hasCost = false;
  let any = false;
  const turns = fromIndex !== undefined ? record.turns.slice(fromIndex) : record.turns;
  for (const turn of turns) {
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
 * [subagent-observability §3.3.1 第 0 波③ + 聚合不变量 2] 轮成败判定只产自引擎收尾
 * 边沿：真实失败事实（收尾边沿结构化事实 / 退出码 / 送达失败）最先裁决，错误轮的
 * FailureCause 从结构化事实一次分类，真实死因不再被任何兜底替换。
 *   ① F-1（schema 声明 + 成功收尾 + 无 parsedOutput）：按 §3.3.2 硬规则①归
 *      agent.no_deliverable（诚实失败——「结构化输出未调用」只能是它），三态归因
 *      摘要降级为 observations 观察事实；不再产出 schema_deterministic 假死因。
 *   ② record.lastError 兜底**退役**：判定链事实化后它是死代码（设计 §2.4）；且
 *      §3.3.5（u2）起 lastError 是「最后一个非空轮失败」的持久派生视图（errors
 *      只追加、不随轮终清空）——它描述历史轮事实，不再充当本轮成败判定输入
 *      （重试恢复轮的旧失败事实不得翻掉收尾边沿的成功判定）。
 *
 * success 双来源判定（调用方传入）：
 *   ① 子进程 spawn/执行失败 → args.success=false
 *   ② 收尾边沿错误停因事实 → endedCleanly=false → 退出码非 0 → args.success=false
 */
export function collectOutcome(
  record: ReplayRecordView,
  args: CollectResultArgs,
): CollectedOutcome {
  const toolCalls = getAllToolCalls(record);
  const parsedOutput = extractParsedOutput(toolCalls);
  const verdict = resolveOutcomeVerdict(args, toolCalls, parsedOutput);
  return {
    content: getFullText(record),
    turns: record.turnCount,
    durationMs: Date.now() - args.startTime,
    success: verdict.success,
    error: verdict.error,
    sessionId: args.sessionId,
    sessionFile: args.sessionFile,
    toolCalls,
    parsedOutput,
    usage: aggregateUsageDelta(record, args.finalAttemptTurnBase),
    // [D5-③ 改轨] failureKind 仅引擎送达错误码前缀保留确定性分诊（"unknown" =
    // 结构化码事实非文案启发）；子串分诊退役，失败分类由 failure 承载。
    failureKind:
      verdict.error !== undefined && isEngineSpawnDeliveryErrorMsg(verdict.error) ? "unknown" : undefined,
    // [§3.3.1/§3.3.3] 引擎停因原值：有收尾边沿事实用事实；被接管轮无停因（缺省）；
    // 成功收尾轮 = stop；其余失败形态无停因事实不产推断（缺省）。
    ...deriveEngineStopReason(args, verdict.success),
    ...(verdict.failure !== undefined ? { failure: verdict.failure } : {}),
    ...(args.promptHandledNoRun === true ? { promptDisposition: "handled" as const } : {}),
    ...(verdict.observations.length > 0 ? { observations: verdict.observations } : {}),
    ...(args.retryAttempts !== undefined && args.retryAttempts > 0
      ? { retryAttempts: args.retryAttempts }
      : {}),
  };
}

/** collectOutcome 的轮成败判定产物（判定链只在此处写这四个值，装配层只读）。 */
interface OutcomeVerdict {
  success: boolean;
  error: string | undefined;
  failure: FailureCause | undefined;
  observations: string[];
}

/**
 * 轮成败判定链（collectOutcome 判定段单点）：
 *   ① 真实失败事实（预算事实位 / 收尾边沿停因分类）最先裁决；
 *   ②-A 被接管轮：回执层成功，无执行、无失败、无停因——不写 FailureCause；
 *   ②-B [F-1 退役为 observations] 宣称成功但无结构化产出 → agent.no_deliverable
 *      （诚实失败），归因摘要进 observations（不再产出 schema_deterministic 假死因）。
 */
function resolveOutcomeVerdict(
  args: CollectResultArgs,
  toolCalls: ReturnType<typeof getAllToolCalls>,
  parsedOutput: unknown,
): OutcomeVerdict {
  let success = args.success;
  let error = args.error;
  const observations: string[] = [];
  let failure: FailureCause | undefined;
  // [subagent-observability §3.3.9 事实位收口] 预算耗尽事实在场即失败事实——事实位
  // 优先于调用方 success 声明（limiter abort 与迟到终态赛跑的收集侧配套：abort 权威
  // 产点的事实位在场时，轮不得以 success 落账）。
  if (args.turnBudgetExhausted === true) success = false;
  if (!success) {
    // 真实失败事实：分类只从收尾边沿结构化事实产出（一次产出，下游只读）。
    failure = classifyFailureCause(buildFailureClassificationInput(args));
  } else if (args.promptHandledNoRun === true) {
    // 被接管轮（见 ②-A 注）
  } else if (args.schemaExpected === true && parsedOutput === undefined) {
    success = false;
    const detail = describeMissingParsedOutput(toolCalls) ?? "structured output expected but absent";
    error = detail;
    failure = { class: "agent", kind: "no_deliverable", retryable: false, raw: detail };
    observations.push(detail);
  }
  return { success, error, failure, observations };
}

/** classifyFailureCause 输入装配（条件 spread 单点）。分类码表只在错误停因形态读取（低频路径直读 ext-config——aborted/预算支不消费规则，零读盘）。 */
function buildFailureClassificationInput(args: CollectResultArgs): FailureCauseInput {
  return {
    ...(args.terminalError !== undefined ? { terminalError: args.terminalError } : {}),
    ...(args.turnBudgetExhausted === true ? { turnBudgetExhausted: true } : {}),
    // [§3.3.9/UC-10] limiter 耗尽事实（{used, limit}）→ cause.budget。
    ...(args.turnBudget !== undefined ? { turnBudget: args.turnBudget } : {}),
    ...(args.terminalError?.stopReason === "error"
      ? { retryRules: loadRetryRulesForClassification() }
      : {}),
  };
}

/** engineStopReason 派生（条件 spread 单点；undefined = 不落该字段）。 */
function deriveEngineStopReason(
  args: CollectResultArgs,
  success: boolean,
): { engineStopReason?: "stop" | "error" | "aborted" } | Record<string, never> {
  if (args.terminalError !== undefined) return { engineStopReason: args.terminalError.stopReason };
  if (success && args.promptHandledNoRun !== true) return { engineStopReason: "stop" as const };
  return {};
}
