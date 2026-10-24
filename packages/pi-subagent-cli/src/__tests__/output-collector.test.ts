// src/__tests__/output-collector.test.ts
//
// 锁定 extractParsedOutput 纯函数契约——它被 collectOutcome 直接消费，决定
// AgentResult.parsedOutput 字段。toUsageTotal / collectResponseText 已删除
// （usage 汇总进 getTotalUsage，text 汇总进 getFullText，均在 execution-record.test 测）。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildExitErrorText,
  classifyFailureCause,
  classifyFailureKind,
  collectOutcome,
  describeMissingParsedOutput,
  describePromptAckFailure,
  DETERMINISTIC_SCHEMA_FAILURE_PREFIX,
  extractParsedOutput,
  extractRetryAfterMsFromText,
  isDeterministicSchemaFailureMsg,
  isEngineSpawnDeliveryErrorMsg,
  isStaleContextErrorMsg,
  neutralizeStalePatterns,
  STALE_CONTEXT_PATTERNS,
} from "../output-collector.ts";
import {
  loadRetryRulesForClassification,
  type RetryRuleClassificationView,
} from "../retry-rules-classification.ts";
import type { PromptAckResult } from "../prompt-ack.ts";
import type { ReplayRecordView, ToolCall } from "@zhushanwen/subagent-engine-sdk";

// 测试环境隔离：pin PI_CODING_AGENT_DIR 到不存在的路径——collectOutcome 失败分类会
// 直读 ext-config（<piAgentDir>/config/retry-rules-ext-config.json），不 pin 则本机
// 真实 pi 配置在场时用例行为分化（码表命中改变分类结论）。强制覆盖（非缺省赋值），
// 宿主 env 泄漏不影响判定；需要真实文件读取的用例经 loadRetryRulesForClassification
// 的 env 参数注入 tmp fixture，不经本 pin。
process.env["PI_CODING_AGENT_DIR"] = "/nonexistent-taiji-test/pi-agent";

// ============================================================
// extractParsedOutput
// ============================================================

describe("extractParsedOutput", () => {
  it("returns undefined for empty toolCalls", () => {
    expect(extractParsedOutput([])).toBeUndefined();
  });

  it("returns undefined when no structured-output call exists", () => {
    const calls: ToolCall[] = [
      { toolName: "bash", result: { details: "x" } },
      { toolName: "read", result: { details: "y" } },
    ];
    expect(extractParsedOutput(calls)).toBeUndefined();
  });

  it("returns undefined when structured-output has no result.details", () => {
    const calls: ToolCall[] = [
      { toolName: "structured-output", result: { content: [] } },
      { toolName: "structured-output", result: {} },
      { toolName: "structured-output" },
    ];
    expect(extractParsedOutput(calls)).toBeUndefined();
  });

  it("returns details when exactly one structured-output call has details", () => {
    const calls: ToolCall[] = [
      { toolName: "bash" },
      { toolName: "structured-output", result: { details: { answer: 42 } } },
    ];
    expect(extractParsedOutput(calls)).toEqual({ answer: 42 });
  });

  it("returns the LAST structured-output details (reverse iteration)", () => {
    const calls: ToolCall[] = [
      { toolName: "structured-output", result: { details: "first" } },
      { toolName: "bash" },
      { toolName: "structured-output", result: { details: "second" } },
    ];
    expect(extractParsedOutput(calls)).toBe("second");
  });

  it("ignores isError structured-output calls without details, picks one with details", () => {
    const calls: ToolCall[] = [
      { toolName: "structured-output", isError: true, result: { content: [{ type: "text", text: "bad" }] } },
      { toolName: "structured-output", result: { details: { ok: true } } },
    ];
    expect(extractParsedOutput(calls)).toEqual({ ok: true });
  });

  // [F-1 失败吞没修复] 失败调用（pi 失败路径 details 默认 {}）的 details 不是
  // schema 校验产出——journal 实锤 tool_end isError=true details={} 曾被当
  // parsedOutput，gate 终止/模型自弃的 run 以 parsedOutput={} 静默 completed。
  it("skips failed structured-output call with details:{} (isError=true) — no parsedOutput", () => {
    const calls: ToolCall[] = [
      { toolName: "bash", result: { content: [] } },
      { toolName: "structured-output", isError: true, result: { details: {}, content: [{ type: "text", text: "Schema validation failed: /target is required" }] } },
    ];
    expect(extractParsedOutput(calls)).toBeUndefined();
  });

  it("skips failed call with details, still picks later valid call (reverse order)", () => {
    const calls: ToolCall[] = [
      { toolName: "structured-output", isError: true, result: { details: {} } },
      { toolName: "structured-output", result: { details: { fixed: true } } },
    ];
    expect(extractParsedOutput(calls)).toEqual({ fixed: true });
  });

  it("isError on non-structured-output calls does not affect extraction", () => {
    const calls: ToolCall[] = [
      { toolName: "bash", isError: true, result: { details: "ignored" } },
      { toolName: "structured-output", result: { details: { answer: 1 } } },
    ];
    expect(extractParsedOutput(calls)).toEqual({ answer: 1 });
  });
});

// ============================================================
// describeMissingParsedOutput（F-1 三态归因）
// ============================================================

describe("describeMissingParsedOutput", () => {
  it("returns undefined when a valid parsedOutput exists", () => {
    const calls: ToolCall[] = [
      { toolName: "structured-output", isError: true, result: { details: {} } },
      { toolName: "structured-output", result: { details: { ok: 1 } } },
    ];
    expect(describeMissingParsedOutput(calls)).toBeUndefined();
  });

  it("state 1: validation failure — isError calls present, error carries last summary", () => {
    const calls: ToolCall[] = [
      { toolName: "structured-output", isError: true, result: { details: {}, content: [{ type: "text", text: "Schema validation failed: /target is required" }] } },
    ];
    const msg = describeMissingParsedOutput(calls);
    expect(msg).toContain("failed");
    expect(msg).toContain("1 structured-output call(s) failed");
    expect(msg).toContain("Schema validation failed: /target is required");
  });

  it("state 2: structured-output never called — error hints to check extension install (C1 blind spot)", () => {
    const calls: ToolCall[] = [
      { toolName: "bash", result: { content: [] } },
      { toolName: "read", result: { content: [] } },
    ];
    const msg = describeMissingParsedOutput(calls);
    expect(msg).toContain("structured-output tool was never called");
    expect(msg).toContain("structured-output extension is installed");
  });

  it("state 3: SO called successfully but no details", () => {
    const calls: ToolCall[] = [
      { toolName: "structured-output", result: { content: [] } },
    ];
    const msg = describeMissingParsedOutput(calls);
    expect(msg).toContain("none of the successful calls carried result details");
  });

  it("empty toolCalls → state 2 (never called)", () => {
    expect(describeMissingParsedOutput([])).toContain("never called");
  });

  it("summary truncates long error text (300 chars cap)", () => {
    const longText = "x".repeat(500);
    const calls: ToolCall[] = [
      { toolName: "structured-output", isError: true, result: { details: {}, content: [{ type: "text", text: longText }] } },
    ];
    const msg = describeMissingParsedOutput(calls);
    expect(msg).toContain("...");
    expect(msg!.length).toBeLessThan(longText.length);
  });

  // 文案约束：不得命中 execute-agent-call 的 STALE_CONTEXT_PATTERNS（"aborted" 等），
  // 否则会被误诊为 stale-context 跳过重试。
  it("messages avoid STALE_CONTEXT_PATTERNS substrings (no false stale-context triage)", () => {
    const samples = [
      describeMissingParsedOutput([])!,
      describeMissingParsedOutput([{ toolName: "structured-output", isError: true, result: { details: {} } }])!,
      describeMissingParsedOutput([{ toolName: "structured-output", result: { content: [] } }])!,
    ];
    for (const msg of samples) {
      const lower = msg.toLowerCase();
      expect(lower).not.toContain("the operation was aborted");
      expect(lower).not.toContain("ctx is stale");
      expect(lower).not.toContain("context canceled");
    }
  });

  // ── [F-R1] 态2（isError 分支）错误摘要拼接段中和 ──
  //
  // 动态错误文本（模型/provider 原始错误）可能携带 "the operation was aborted"/
  // "ctx is stale" 等 STALE_CONTEXT_PATTERNS 词；不中和则归因 error 经 collectOutcome
  // 的 classifyFailureKind 分诊被误标 stale_context（归因语义被污染）。
  // 固定前缀静态无命中（上一用例锁定），中和只针对动态段。
  describe("F-R1: 态2 错误摘要 STALE_CONTEXT_PATTERNS 中和", () => {
    function failedSoCallsWith(text: string): ToolCall[] {
      return [
        { toolName: "structured-output", isError: true, result: { details: {}, content: [{ type: "text", text }] } },
      ];
    }

    it("失败 content 含 pi abort 精确文案/'ctx is stale' → 摘要被 [redacted]，归因 error 不触发 isStaleContextErrorMsg", () => {
      const msg = describeMissingParsedOutput(
        failedSoCallsWith("The operation was aborted: context canceled — ctx is stale after session replacement"),
      )!;
      expect(msg).toContain("[redacted]");
      const lower = msg.toLowerCase();
      expect(lower).not.toContain("the operation was aborted");
      expect(lower).not.toContain("ctx is stale");
      expect(lower).not.toContain("context canceled");
      // 消费点语义锁定：归因 error 进入 stale-context 分诊必须为 false（可重试）
      expect(isStaleContextErrorMsg(msg)).toBe(false);
    });

    it("大小写变体（'THE OPERATION WAS ABORTED'）同样被中和（分诊是大小写不敏感子串匹配）", () => {
      const msg = describeMissingParsedOutput(failedSoCallsWith("THE OPERATION WAS ABORTED by provider"))!;
      expect(msg).toContain("[redacted]");
      expect(isStaleContextErrorMsg(msg)).toBe(false);
    });

    it("裸词 aborted 不在词表（P8 收窄）：provider 动态错误携带 aborted 字样不误诊 stale", () => {
      const msg = describeMissingParsedOutput(failedSoCallsWith("request aborted while busy"))!;
      expect(msg).not.toContain("[redacted]");
      expect(isStaleContextErrorMsg(msg)).toBe(false);
    });

    it("无动态内容时整条归因也不命中（防御回归锁定）", () => {
      const msg = describeMissingParsedOutput([
        { toolName: "structured-output", isError: true, result: { details: {} } },
      ])!;
      expect(isStaleContextErrorMsg(msg)).toBe(false);
    });

    it("neutralizeStalePatterns：多 pattern 同时命中 + 无命中原样透传", () => {
      expect(neutralizeStalePatterns("The operation was aborted CTX IS STALE / context canceled")).toBe(
        "[redacted] [redacted] / [redacted]",
      );
      expect(neutralizeStalePatterns("provider socket hang up")).toBe("provider socket hang up");
    });
  });

  // ── [F-R4] 态2 文案按最后错误内容分类，不再硬编码 "(schema validation)" ──
  describe("F-R4: 态2 失败原因分类", () => {
    it("最后错误含 'validation failed'（大小写不敏感）→ (schema validation)", () => {
      const calls: ToolCall[] = [
        { toolName: "structured-output", isError: true, result: { details: {}, content: [{ type: "text", text: "Schema validation failed: /target is required" }] } },
      ];
      const msg = describeMissingParsedOutput(calls)!;
      expect(msg).toContain("(schema validation)");
      expect(msg).not.toContain("(execution failure)");
    });

    it("最后错误为非校验失败（如 provider 错误）→ (execution failure)", () => {
      const calls: ToolCall[] = [
        { toolName: "structured-output", isError: true, result: { details: {}, content: [{ type: "text", text: "provider socket hang up" }] } },
      ];
      const msg = describeMissingParsedOutput(calls)!;
      expect(msg).toContain("(execution failure)");
      expect(msg).not.toContain("(schema validation)");
    });
  });
});

// ============================================================
// MF-1: 三态可重试性矩阵（确定性失败标记）
// ============================================================

describe("MF-1: 三态可重试性矩阵（确定性失败标记）", () => {
  // 矩阵（SSOT 注释在本模块 DETERMINISTIC_SCHEMA_FAILURE_PREFIX 与
  // describeMissingParsedOutput JSDoc，本 describe 是执行侧锁定）：
  //   态① 从未调用 SO            → 带标记 → 不可重试（环境确定性，C1 安装盲区）
  //   态② SO isError（gate 终止/不可满足 schema）→ 带标记 → 不可重试（同 schema 重试必同结果）
  //   态③ 调用过但无 details       → 无标记 → 可重试（可能瞬态，保留既有重试语义）

  it("态① 从未调用 SO → error 以确定性标记开头（不可重试）", () => {
    const msg = describeMissingParsedOutput([])!;
    expect(msg.startsWith(DETERMINISTIC_SCHEMA_FAILURE_PREFIX)).toBe(true);
    expect(isDeterministicSchemaFailureMsg(msg)).toBe(true);
  });

  it("态② isError/schema validation 子类 → error 以确定性标记开头（不可重试）", () => {
    const msg = describeMissingParsedOutput([
      { toolName: "structured-output", isError: true, result: { details: {}, content: [{ type: "text", text: "Schema validation failed: /target is required" }] } },
    ])!;
    expect(msg.startsWith(DETERMINISTIC_SCHEMA_FAILURE_PREFIX)).toBe(true);
    expect(isDeterministicSchemaFailureMsg(msg)).toBe(true);
  });

  it("态② execution failure 子类（provider 瞬态）同样带标记（isError 态整体不重试）", () => {
    const msg = describeMissingParsedOutput([
      { toolName: "structured-output", isError: true, result: { details: {}, content: [{ type: "text", text: "provider socket hang up" }] } },
    ])!;
    expect(isDeterministicSchemaFailureMsg(msg)).toBe(true);
  });

  it("态③ 调用过但无 details → 不带标记（可重试语义保留）", () => {
    const msg = describeMissingParsedOutput([
      { toolName: "structured-output", result: { content: [] } },
    ])!;
    expect(isDeterministicSchemaFailureMsg(msg)).toBe(false);
  });

  it("有有效 parsedOutput → 无归因无标记（不适用矩阵）", () => {
    expect(
      describeMissingParsedOutput([{ toolName: "structured-output", result: { details: { ok: 1 } } }]),
    ).toBeUndefined();
  });

  // 验收④：标记词不命中 STALE_CONTEXT_PATTERNS——若命中，isStaleContextErrorMsg
  // 分诊（判定在前）会抢先归因 stale-context，虽然同样不重试，但归因语义被污染
  // （TUI/日志把 schema 失败误报为 stale）。
  it("标记词与全部 STALE_CONTEXT_PATTERNS 零交集，isStaleContextErrorMsg 不抢先", () => {
    const lower = DETERMINISTIC_SCHEMA_FAILURE_PREFIX.toLowerCase();
    for (const pattern of STALE_CONTEXT_PATTERNS) {
      expect(lower.includes(pattern)).toBe(false);
    }
    expect(isStaleContextErrorMsg(DETERMINISTIC_SCHEMA_FAILURE_PREFIX)).toBe(false);
  });
});

// ============================================================
// collectOutcome — F-1 集成行为（schemaExpected → 失败标注）
// ============================================================

describe("collectOutcome — F-1 schemaExpected 失败标注", () => {
  /** 最小 ReplayRecordView stub（collectOutcome 只读 turns/toolCalls 派生字段）。 */
  function makeRecordWithCalls(calls: ToolCall[]): ReplayRecordView {
    return {
      id: "rec-1",
      turns: [{ toolCalls: calls, text: "done", turnCount: 1, closed: true }],
      turnCount: 1,
    } as unknown as ReplayRecordView;
  }

  const baseArgs = {
    startTime: Date.now(),
    sessionId: "s-1",
    sessionFile: undefined,
  };

  it("schemaExpected + failed SO call (details:{}) + success=true → success=false + error attributed", () => {
    const record = makeRecordWithCalls([
      { toolName: "structured-output", isError: true, result: { details: {}, content: [{ type: "text", text: "validation boom" }] } },
    ]);
    const result = collectOutcome(record, { ...baseArgs, success: true, error: undefined, schemaExpected: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain("validation boom");
    expect(result.parsedOutput).toBeUndefined();
  });

  it("schemaExpected + never called SO + success=true → error hints extension check", () => {
    const record = makeRecordWithCalls([{ toolName: "bash", result: { content: [] } }]);
    const result = collectOutcome(record, { ...baseArgs, success: true, error: undefined, schemaExpected: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain("structured-output extension is installed");
  });

  it("schemaExpected + valid details → success preserved (S3 e2e semantics no regression)", () => {
    const record = makeRecordWithCalls([
      { toolName: "structured-output", result: { details: { answer: 42 } } },
    ]);
    const result = collectOutcome(record, { ...baseArgs, success: true, error: undefined, schemaExpected: true });
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.parsedOutput).toEqual({ answer: 42 });
  });

  it("no schemaExpected (plain mode) + no SO call → success unchanged", () => {
    const record = makeRecordWithCalls([{ toolName: "bash", result: { content: [] } }]);
    const result = collectOutcome(record, { ...baseArgs, success: true, error: undefined });
    expect(result.success).toBe(true);
    expect(result.parsedOutput).toBeUndefined();
  });

  it("success=false path: existing error not overwritten by F-1 attribution", () => {
    const record = makeRecordWithCalls([]);
    const result = collectOutcome(record, { ...baseArgs, success: false, error: "provider boom", schemaExpected: true });
    expect(result.success).toBe(false);
    expect(result.error).toBe("provider boom");
  });

  it("[MF-1] F-1 标注的 error 携带确定性标记（流到 executeAgentCall 即不可重试）", () => {
    const record = makeRecordWithCalls([
      { toolName: "structured-output", isError: true, result: { details: {}, content: [{ type: "text", text: "Schema validation failed: /target is required" }] } },
    ]);
    const result = collectOutcome(record, { ...baseArgs, success: true, error: undefined, schemaExpected: true });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(isDeterministicSchemaFailureMsg(result.error)).toBe(true);
  });
});

// ============================================================
// D5-③: failureKind 分类（产出侧单点识别）
// ============================================================

describe("classifyFailureKind（词表 → 结构化标签）", () => {
  it("pi 真实 stale 文案 → stale_context", () => {
    const piRealStale =
      "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession().";
    expect(classifyFailureKind(piRealStale)).toBe("stale_context");
  });

  it("abort 族（context canceled / pi abort 精确文案）→ stale_context；裸词 aborted 不误诊（P8 收窄）", () => {
    expect(classifyFailureKind("Request context canceled by provider")).toBe("stale_context");
    expect(classifyFailureKind("The operation was aborted")).toBe("stale_context");
    expect(classifyFailureKind("Subprocess aborted by runtime shutdown")).toBe("unknown");
    expect(classifyFailureKind("request aborted while busy")).toBe("unknown");
  });

  it("确定性 schema 失败标记前缀 → schema_deterministic", () => {
    expect(classifyFailureKind(
      `${DETERMINISTIC_SCHEMA_FAILURE_PREFIX} Agent finished without producing a structured output`,
    )).toBe("schema_deterministic");
  });

  it("未知文案（词表零命中，pi 升级改写文案后的形态）→ unknown（安全默认，可重试）", () => {
    expect(classifyFailureKind("provider 503 service unavailable")).toBe("unknown");
    expect(classifyFailureKind("spawn EAGAIN")).toBe("unknown");
    expect(classifyFailureKind("extension runtime was superseded by a newer orchestration epoch")).toBe("unknown");
  });

  it("undefined（成功路径）→ undefined（不落失败分诊）", () => {
    expect(classifyFailureKind(undefined)).toBeUndefined();
  });

  it("标记词与 stale 词表零交集（分诊优先级无歧义）", () => {
    expect(classifyFailureKind(DETERMINISTIC_SCHEMA_FAILURE_PREFIX)).toBe("schema_deterministic");
  });
});

describe("collectOutcome — failureKind 改轨（subagent-observability §3.3.2 子串分诊退役）", () => {
  /** 最小 ReplayRecordView stub（collectOutcome 只读 turns/toolCalls 派生字段）。 */
  function makeRecordWithCalls(calls: ToolCall[]): ReplayRecordView {
    return {
      id: "rec-fk",
      turns: [{ toolCalls: calls, text: "done", turnCount: 1, closed: true }],
      turnCount: 1,
    } as unknown as ReplayRecordView;
  }

  const baseArgs = {
    startTime: Date.now(),
    sessionId: "s-fk",
    sessionFile: undefined,
  };

  it("子串分诊退役：stale 文案不再产出 stale_context（failureKind 改轨为送达码确定性分诊）", () => {
    const record = makeRecordWithCalls([]);
    const result = collectOutcome(record, {
      ...baseArgs,
      success: false,
      error: "This extension ctx is stale after session replacement or reload.",
    });
    expect(result.failureKind).toBeUndefined();
  });

  it("[F-1 退役为 observations] schema 声明 + 成功收尾 + 无产出 → agent.no_deliverable（诚实失败，不再产 schema_deterministic 假死因）", () => {
    const record = makeRecordWithCalls([]);
    const result = collectOutcome(record, { ...baseArgs, success: true, error: undefined, schemaExpected: true });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.failureKind).toBeUndefined();
    // 新分类面：agent.no_deliverable（§3.3.2 硬规则①「SO 未调用」只能是它）
    expect(result.failure).toEqual({
      class: "agent",
      kind: "no_deliverable",
      retryable: false,
      raw: result.error,
    });
    // 观察事实承载（F-1 兜底退役为 observations）
    expect(result.observations).toHaveLength(1);
    expect(result.observations?.[0]).toBe(result.error);
    // 负面断言（场景 1）：不再产出 schema_deterministic
    expect(JSON.stringify(result)).not.toContain("schema_deterministic");
  });

  it("态③归因（调用过但无 details）→ agent.no_deliverable + observations（分类面承接，failureKind 退役）", () => {
    const record = makeRecordWithCalls([
      { toolName: "structured-output", result: { content: [] } },
    ]);
    const result = collectOutcome(record, { ...baseArgs, success: true, error: undefined, schemaExpected: true });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.failure?.class).toBe("agent");
    expect(result.failure?.kind).toBe("no_deliverable");
    expect(result.observations).toHaveLength(1);
  });

  it("引擎送达错误码前缀保留确定性分诊 failureKind=unknown（结构化码事实，非文案启发）", () => {
    const record = makeRecordWithCalls([]);
    const result = collectOutcome(record, {
      ...baseArgs,
      success: false,
      error:
        "engine_prompt_not_delivered: zero stdout after prompt write within 30000ms. Recovery: re-run the task.",
    });
    expect(result.failureKind).toBe("unknown");
  });

  it("成功路径（error undefined）→ failureKind 不写", () => {
    const record = makeRecordWithCalls([]);
    const result = collectOutcome(record, { ...baseArgs, success: true, error: undefined });
    expect(result.failureKind).toBeUndefined();
  });

  it("普通 provider 错误（无结构化事实）→ failure 也不产（未分类形态落引擎停因原值，不产假分类）", () => {
    const record = makeRecordWithCalls([]);
    const result = collectOutcome(record, { ...baseArgs, success: false, error: "provider boom 5xx" });
    expect(result.failureKind).toBeUndefined();
    expect(result.failure).toBeUndefined();
  });

  it("[§3.3.9 事实位收口] turnBudgetExhausted 事实在场 → 轮不得落 success（事实位优先于调用方 success 声明）", () => {
    const record = makeRecordWithCalls([]);
    const result = collectOutcome(record, {
      ...baseArgs,
      success: true,
      error: undefined,
      turnBudgetExhausted: true,
      turnBudget: { used: 4, limit: 3 },
    });
    expect(result.success).toBe(false);
    expect(result.failure).toMatchObject({
      class: "harness",
      kind: "turn_budget_exhausted",
      retryable: false,
      budget: { used: 4, limit: 3 },
    });
    // 事实位在场时 engineStopReason 不派生 "stop"（无收尾边沿停因事实不产推断）
    expect(result.engineStopReason).toBeUndefined();
  });
});

// ============================================================
// [M2 D3/D10] 送达失败分诊
// ============================================================

describe("M2: 送达错误码分诊（确定性码前缀置前，防 stale 词表误诊）", () => {
  const ackFailureError =
    "engine_prompt_not_delivered: zero stdout after prompt write within 30000ms; diagnostics: pid=1 bytesWritten=9 stdoutBytes=0 stdoutBytesAfterPrompt=0 stdoutSeen=false getStateAnswered=false lastEventType=-. Recovery: re-run the task.";

  it("engine_prompt_not_delivered 前缀 → unknown（可重试安全默认，非 stale）", () => {
    expect(classifyFailureKind(ackFailureError)).toBe("unknown");
    expect(isEngineSpawnDeliveryErrorMsg(ackFailureError)).toBe(true);
  });

  it("engine_prompt_rejected 且 pi error 含 pi abort 精确文案 → unknown（不被 stale 词表劫走——拒绝面可重试）", () => {
    const msg =
      "engine_prompt_rejected: pi rejected the prompt command: The operation was aborted. Recovery: check the pi-side reason.";
    expect(classifyFailureKind(msg)).toBe("unknown");
    expect(isStaleContextErrorMsg(msg)).toBe(true); // 词表本身会命中——分诊必须码前缀优先
  });

  it("engine_prompt_rejected 且 pi error 含裸词 aborted → 词表不命中（P8 收窄：拒绝面误诊源消除）", () => {
    const msg =
      "engine_prompt_rejected: pi rejected the prompt command: request aborted while busy. Recovery: check the pi-side reason.";
    expect(classifyFailureKind(msg)).toBe("unknown");
    expect(isStaleContextErrorMsg(msg)).toBe(false);
  });

  it("engine_spawn_handshake_timeout → unknown（重启后重跑）", () => {
    const msg =
      "engine_spawn_handshake_timeout: engine spawn handshake did not complete in time. Recovery: restart taiji.";
    expect(classifyFailureKind(msg)).toBe("unknown");
  });

  it("非送达错误码不误判（isEngineSpawnDeliveryErrorMsg 负例）", () => {
    expect(isEngineSpawnDeliveryErrorMsg("pi child exited with code 15")).toBe(false);
    expect(isEngineSpawnDeliveryErrorMsg("engine_crashed: stdout tail ...")).toBe(false);
    expect(isEngineSpawnDeliveryErrorMsg(undefined)).toBe(false);
  });
});

describe("M2: describePromptAckFailure（tracker 结算 → outcome.error 文案）", () => {
  it("timeout → engine_prompt_not_delivered 前缀 + 诊断 detail + Recovery", () => {
    const failure: PromptAckResult = {
      kind: "timeout",
      detail: "zero stdout after prompt write within 30000ms; diagnostics: pid=7 bytesWritten=3 stdoutBytes=0 stdoutBytesAfterPrompt=0 stdoutSeen=false getStateAnswered=false",
    };
    const text = describePromptAckFailure(failure);
    expect(text.startsWith("engine_prompt_not_delivered:")).toBe(true);
    expect(text).toContain("zero stdout after prompt write");
    expect(text).toContain("pid=7");
    expect(text).toContain("Recovery:");
  });

  it("lost → engine_prompt_not_delivered 前缀（detail 含 stdin-unavailable/epipe 区分）", () => {
    const text = describePromptAckFailure({
      kind: "lost",
      reason: "epipe",
      detail: "epipe: EPIPE on stdin write; diagnostics: pid=7 bytesWritten=3 stdoutBytes=0 stdoutBytesAfterPrompt=0 stdoutSeen=false getStateAnswered=false",
    });
    expect(text.startsWith("engine_prompt_not_delivered:")).toBe(true);
    expect(text).toContain("epipe");
  });

  it("rejected → engine_prompt_rejected 前缀 + pi error 文本（与 not_delivered 分型防误诊）", () => {
    const text = describePromptAckFailure({ kind: "rejected", detail: "model not found" });
    expect(text.startsWith("engine_prompt_rejected:")).toBe(true);
    expect(text).toContain("model not found");
    expect(text).not.toContain("engine_prompt_not_delivered");
  });

  it("acked 不经此函数（正常 outcome，防御性抛错）", () => {
    expect(() => describePromptAckFailure({ kind: "acked", disposition: "started" })).toThrow(/acked/);
  });
});

// ============================================================
// [subagent-observability §3.3.2] classifyFailureCause（收尾边沿分类单点）
// ============================================================

describe("classifyFailureCause（结构化输入分类，子串分诊的接替者）", () => {
  const NOW = 1_700_000_000_000;

  it("status 机读主通道：429 → provider.rate_limited + conditional（429 不全可重试——禁止按状态码判 true）", () => {
    const cause = classifyFailureCause(
      { terminalError: { stopReason: "error", errorMessage: '429: {"code":"rate_limit_exceeded"}', abortSource: "engine" } },
      NOW,
    );
    expect(cause).toMatchObject({ class: "provider", kind: "rate_limited", retryable: "conditional" });
  });

  it("retryAfterMs 文本兜底通道：resets ISO 时间戳命中 → 毫秒差值；无字样 → undefined（缺省 unknown 不产假 0）", () => {
    const resetsAt = new Date(NOW + 22 * 60 * 1000).toISOString();
    const withReset = classifyFailureCause(
      { terminalError: { stopReason: "error", errorMessage: `429: quota exceeded, resets ${resetsAt}`, abortSource: "engine" } },
      NOW,
    );
    expect(withReset?.retryAfterMs).toBe(22 * 60 * 1000);

    const withoutReset = classifyFailureCause(
      { terminalError: { stopReason: "error", errorMessage: "429: rate limited", abortSource: "engine" } },
      NOW,
    );
    expect(withoutReset).toMatchObject({ class: "provider", kind: "rate_limited" });
    expect(withoutReset?.retryAfterMs).toBeUndefined();
  });

  it("非 429 4xx 无业务码命中 → provider.protocol_unsupported（retryable false——码表未命中回落内置层）", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const cause = classifyFailureCause(
        {
          terminalError: { stopReason: "error", errorMessage: `${status}: {"error":{"code":"x"}}`, abortSource: "engine" },
          retryRules: [],
        },
        NOW,
      );
      expect(cause).toMatchObject({ class: "provider", kind: "protocol_unsupported", retryable: false });
    }
  });

  it("5xx / 无 status 前缀的无词表形态 → 不产 FailureCause（未分类落引擎停因原值，不猜）", () => {
    expect(
      classifyFailureCause({ terminalError: { stopReason: "error", errorMessage: "503: service unavailable", abortSource: "engine" } }, NOW),
    ).toBeUndefined();
    expect(
      classifyFailureCause({ terminalError: { stopReason: "error", errorMessage: "provider exploded mysteriously", abortSource: "engine" } }, NOW),
    ).toBeUndefined();
  });

  // ── [§3.3.2/§3.3.12 分类码表接线] provider 业务码层（与改写判定同一份数据） ──

  const BASELINE_TIER_RULE: RetryRuleClassificationView = {
    verdict: "conditional",
    class: "provider",
    kind: "rate_limited",
    match: [{ kind: "pattern", pattern: "tier_limit_exceeded" }],
    source: "builtin",
  };

  it("场景 1 分类形态：400 + tier_limit_exceeded + resets → 码表命中 rate_limited/conditional + retryAfterMs>0（status 层不再判 protocol_unsupported）", () => {
    const resetsAt = new Date(NOW + 22 * 60 * 1000).toISOString();
    const cause = classifyFailureCause(
      {
        terminalError: {
          stopReason: "error",
          errorMessage: `400: {"error":{"code":"tier_limit_exceeded","message":"usage limit, resets ${resetsAt}"}}`,
          abortSource: "engine",
        },
        retryRules: [BASELINE_TIER_RULE],
      },
      NOW,
    );
    expect(cause).toMatchObject({
      class: "provider",
      kind: "rate_limited",
      retryable: "conditional",
    });
    expect(cause?.retryAfterMs).toBe(22 * 60 * 1000);
    expect(cause?.raw).toContain("tier_limit_exceeded");
  });

  it("码表 non_retryable 排除序优先：账户类规则命中 → retryable false（429 不全可重试硬约束的结构承载）", () => {
    const accountRule: RetryRuleClassificationView = {
      verdict: "non_retryable",
      class: "provider",
      kind: "protocol_unsupported",
      match: [{ kind: "pattern", pattern: "insufficient_quota" }],
      source: "builtin",
    };
    const cause = classifyFailureCause(
      {
        terminalError: {
          stopReason: "error",
          errorMessage: '429: {"error":{"code":"1113","message":"insufficient_quota: account exhausted"}}',
          abortSource: "engine",
        },
        retryRules: [BASELINE_TIER_RULE, accountRule],
      },
      NOW,
    );
    expect(cause).toMatchObject({ class: "provider", kind: "protocol_unsupported", retryable: false });
  });

  it("码表 kind 缺省推导：provider+conditional 规则未登记 kind → 推导 rate_limited；harness 双值不推导 → 规则不消费（不猜）", () => {
    const noKindRule: RetryRuleClassificationView = {
      verdict: "conditional",
      class: "provider",
      match: [{ kind: "pattern", pattern: "tier_limit_exceeded" }],
      source: "builtin",
    };
    const derived = classifyFailureCause(
      {
        terminalError: { stopReason: "error", errorMessage: "400: tier_limit_exceeded", abortSource: "engine" },
        retryRules: [noKindRule],
      },
      NOW,
    );
    expect(derived).toMatchObject({ class: "provider", kind: "rate_limited", retryable: "conditional" });

    const harnessRule: RetryRuleClassificationView = {
      verdict: "conditional",
      class: "harness",
      match: [{ kind: "pattern", pattern: "tier_limit_exceeded" }],
      source: "builtin",
    };
    const skipped = classifyFailureCause(
      {
        terminalError: { stopReason: "error", errorMessage: "400: tier_limit_exceeded", abortSource: "engine" },
        retryRules: [harnessRule],
      },
      NOW,
    );
    // harness 未登记 kind（双值词表无缺省）→ 该规则对分类侧不生效 → 回落 HTTP 语义层
    expect(skipped).toMatchObject({ class: "provider", kind: "protocol_unsupported", retryable: false });
  });

  it("[§3.3.2 结构化优先] diagnostics.error.code 命中码表匹配键（errorMessage 无可匹配文本形态）", () => {
    const jsonPathRule: RetryRuleClassificationView = {
      verdict: "conditional",
      class: "provider",
      kind: "rate_limited",
      match: [{ kind: "jsonPath", path: "error.code", operator: "equals", value: "1302" }],
      source: "builtin",
    };
    const cause = classifyFailureCause(
      {
        terminalError: {
          stopReason: "error",
          errorMessage: "provider request failed",
          rawStopReason: "error",
          diagnostics: [{ type: "provider_error", timestamp: NOW, error: { name: "Error", message: "1302 rate limit", code: 1302 } }],
          abortSource: "engine",
        },
        retryRules: [jsonPathRule],
      },
      NOW,
    );
    expect(cause).toMatchObject({ class: "provider", kind: "rate_limited", retryable: "conditional" });
    expect(cause?.raw).toBe("provider request failed");
  });

  it("码表未注入（undefined = 配置缺席安全缺省）→ 行为与内置层基线一致", () => {
    const resetsAt = new Date(NOW + 22 * 60 * 1000).toISOString();
    const cause = classifyFailureCause(
      {
        terminalError: {
          stopReason: "error",
          errorMessage: `400: {"error":{"code":"tier_limit_exceeded","message":"resets ${resetsAt}"}}`,
          abortSource: "engine",
        },
      },
      NOW,
    );
    expect(cause).toMatchObject({ class: "provider", kind: "protocol_unsupported", retryable: false });
  });

  it("兜底文案词表：pi 模块常量字面量（has no API implementation）→ protocol_unsupported", () => {
    const cause = classifyFailureCause(
      { terminalError: { stopReason: "error", errorMessage: 'Provider p has no API implementation for "anthropic"', abortSource: "engine" } },
      NOW,
    );
    expect(cause).toMatchObject({ class: "provider", kind: "protocol_unsupported", retryable: false });
    expect(cause?.raw).toContain("has no API implementation");
  });

  it("aborted 三源 → user.cancelled / harness.turn_budget_exhausted / engine.engine_aborted（禁止一律记失败）", () => {
    expect(
      classifyFailureCause({ terminalError: { stopReason: "aborted", errorMessage: "cancel", abortSource: "host-cancel" } }, NOW),
    ).toMatchObject({ class: "user", kind: "cancelled", retryable: false });
    expect(
      classifyFailureCause({ terminalError: { stopReason: "aborted", errorMessage: "budget", abortSource: "turn-budget" } }, NOW),
    ).toMatchObject({ class: "harness", kind: "turn_budget_exhausted", retryable: false });
    expect(
      classifyFailureCause({ terminalError: { stopReason: "aborted", errorMessage: "engine", abortSource: "engine" } }, NOW),
    ).toMatchObject({ class: "engine", kind: "engine_aborted", retryable: false });
  });

  it("limiter 事实位（SIGKILL 直杀无停因形态）→ harness.turn_budget_exhausted；无输入 → undefined", () => {
    expect(
      classifyFailureCause({ turnBudgetExhausted: true }, NOW),
    ).toMatchObject({ class: "harness", kind: "turn_budget_exhausted", retryable: false });
    expect(classifyFailureCause({}, NOW)).toBeUndefined();
  });

  it("[§3.3.9/UC-10] 耗尽事实 {used, limit} 结构化进 cause.budget（事实位与停因支两路）", () => {
    // SIGKILL 直杀主路径：事实位 + turnBudget → cause.budget 携带
    expect(
      classifyFailureCause({ turnBudgetExhausted: true, turnBudget: { used: 12, limit: 10 } }, NOW),
    ).toMatchObject({ class: "harness", kind: "turn_budget_exhausted", budget: { used: 12, limit: 10 } });
    // 事实位在、快照缺席（极端竞窗）→ 轮失败事实不变、budget 缺省不产结构
    const factOnly = classifyFailureCause({ turnBudgetExhausted: true }, NOW);
    expect(factOnly).toMatchObject({ class: "harness", kind: "turn_budget_exhausted" });
    expect(factOnly && "budget" in factOnly).toBe(false);
    // aborted 停因支：EngineRoundErrorFact.turnBudget 快照 → cause.budget 透传
    expect(
      classifyFailureCause(
        { terminalError: { stopReason: "aborted", errorMessage: "budget", abortSource: "turn-budget", turnBudget: { used: 3, limit: 1 } } },
        NOW,
      ),
    ).toMatchObject({ class: "harness", kind: "turn_budget_exhausted", budget: { used: 3, limit: 1 } });
    // 非 turn-budget 支（host-cancel）不产 budget
    const cancelled = classifyFailureCause(
      { terminalError: { stopReason: "aborted", errorMessage: "cancel", abortSource: "host-cancel" } },
      NOW,
    );
    expect(cancelled).toMatchObject({ class: "user", kind: "cancelled" });
    expect(cancelled && "budget" in cancelled).toBe(false);
  });

  it("extractRetryAfterMsFromText：resets ISO / retry after 秒数 / 无命中 undefined", () => {
    expect(extractRetryAfterMsFromText(`resets ${new Date(NOW + 5000).toISOString()}`, NOW)).toBe(5000);
    expect(extractRetryAfterMsFromText("try again in 90 seconds", NOW)).toBe(90_000);
    expect(extractRetryAfterMsFromText("no hint here", NOW)).toBeUndefined();
  });
});

// ============================================================
// [subagent-observability §3.3.2/§3.3.12] ext-config 读取（分类码表消费侧）
// ============================================================

describe("loadRetryRulesForClassification（ext-config 读侧，安全缺省）", () => {
  function writeExtConfig(dir: string, body: string): string {
    mkdirSync(nodePath.join(dir, "config"), { recursive: true });
    const file = nodePath.join(dir, "config", "retry-rules-ext-config.json");
    writeFileSync(file, body);
    return file;
  }

  it("文件缺失 → undefined（安全缺省：回落内置 HTTP 语义层）", () => {
    expect(loadRetryRulesForClassification({ PI_CODING_AGENT_DIR: "/nonexistent-taiji-test/pi-agent" })).toBeUndefined();
  });

  it("合法 effectiveRules 读取 + 坏条目跳过（字段级窄化，绕过写侧校验的直改形态不猜）", () => {
    const dir = mkdtempSync(nodePath.join(tmpdir(), "pi-agent-retry-rules-"));
    writeExtConfig(
      dir,
      JSON.stringify({
        version: 1,
        customRules: [],
        effectiveRules: [
          {
            id: "tier-limit-window",
            verdict: "conditional",
            class: "provider",
            kind: "rate_limited",
            match: [{ kind: "pattern", pattern: "tier_limit_exceeded" }],
            source: "builtin",
          },
          { id: "bad-verdict", verdict: "sometimes", class: "provider", match: [], source: "builtin" },
          { id: "bad-kind", verdict: "retryable", class: "provider", kind: "turn_budget_exhausted", match: [{ kind: "pattern", pattern: "x" }], source: "builtin" },
        ],
      }),
    );
    const rules = loadRetryRulesForClassification({ PI_CODING_AGENT_DIR: dir });
    expect(rules).toHaveLength(1);
    expect(rules?.[0]).toMatchObject({ verdict: "conditional", class: "provider", kind: "rate_limited" });
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("坏 JSON / 非对象 / version 不符 → undefined", () => {
    for (const body of ["{not json", JSON.stringify([1, 2]), JSON.stringify({ version: 2, effectiveRules: [] })]) {
      const dir = mkdtempSync(nodePath.join(tmpdir(), "pi-agent-retry-rules-"));
      writeExtConfig(dir, body);
      expect(loadRetryRulesForClassification({ PI_CODING_AGENT_DIR: dir })).toBeUndefined();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});
