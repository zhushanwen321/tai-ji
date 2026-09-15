// src/__tests__/output-collector.test.ts
//
// 锁定 extractParsedOutput 纯函数契约——它被 collectOutcome 直接消费，决定
// AgentResult.parsedOutput 字段。toUsageTotal / collectResponseText 已删除
// （usage 收口进 getTotalUsage，text 收口进 getFullText，均在 execution-record.test 测）。
import { describe, expect, it } from "vitest";

import {
  classifyFailureKind,
  collectOutcome,
  describeMissingParsedOutput,
  DETERMINISTIC_SCHEMA_FAILURE_PREFIX,
  extractParsedOutput,
  isDeterministicSchemaFailureMsg,
  isStaleContextErrorMsg,
  neutralizeStalePatterns,
  STALE_CONTEXT_PATTERNS,
} from "../output-collector.ts";
import type { ReplayRecordView, ToolCall } from "@zhushanwen/subagent-engine-sdk";

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
      expect(lower).not.toContain("aborted");
      expect(lower).not.toContain("ctx is stale");
      expect(lower).not.toContain("context canceled");
    }
  });

  // ── [F-R1] 态2（isError 分支）错误摘要拼接段中和 ──
  //
  // 动态错误文本（模型/provider 原始错误）可能携带 "aborted"/"ctx is stale" 等
  // STALE_CONTEXT_PATTERNS 词；不中和则归因 error 经 collectOutcome 的
  // classifyFailureKind 分诊被误标 stale_context（归因语义被污染）。
  // 固定前缀静态无命中（上一用例锁定），中和只针对动态段。
  describe("F-R1: 态2 错误摘要 STALE_CONTEXT_PATTERNS 中和", () => {
    function failedSoCallsWith(text: string): ToolCall[] {
      return [
        { toolName: "structured-output", isError: true, result: { details: {}, content: [{ type: "text", text }] } },
      ];
    }

    it("失败 content 含 'aborted'/'ctx is stale' → 摘要被 [redacted]，归因 error 不触发 isStaleContextErrorMsg", () => {
      const msg = describeMissingParsedOutput(
        failedSoCallsWith("Request aborted: context canceled — ctx is stale after session replacement"),
      )!;
      expect(msg).toContain("[redacted]");
      const lower = msg.toLowerCase();
      expect(lower).not.toContain("aborted");
      expect(lower).not.toContain("ctx is stale");
      expect(lower).not.toContain("context canceled");
      // 消费点语义锁定：归因 error 进入 stale-context 分诊必须为 false（可重试）
      expect(isStaleContextErrorMsg(msg)).toBe(false);
    });

    it("大小写变体（'ABORTED'）同样被中和（分诊是大小写不敏感子串匹配）", () => {
      const msg = describeMissingParsedOutput(failedSoCallsWith("ABORTED by provider"))!;
      expect(msg).toContain("[redacted]");
      expect(isStaleContextErrorMsg(msg)).toBe(false);
    });

    it("无动态内容时整条归因也不命中（防御回归锁定）", () => {
      const msg = describeMissingParsedOutput([
        { toolName: "structured-output", isError: true, result: { details: {} } },
      ])!;
      expect(isStaleContextErrorMsg(msg)).toBe(false);
    });

    it("neutralizeStalePatterns：多 pattern 同时命中 + 无命中原样透传", () => {
      expect(neutralizeStalePatterns("aborted CTX IS STALE / context canceled")).toBe(
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
  // describeMissingParsedOutput JSDoc，本 describe 是执行面锁定）：
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
  /** 最小 ReplayRecordView stub（collectOutcome 只读 turns/toolCalls 派生面）。 */
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

  it("abort 族（context canceled / aborted）→ stale_context", () => {
    expect(classifyFailureKind("Request context canceled by provider")).toBe("stale_context");
    expect(classifyFailureKind("Subprocess aborted by runtime shutdown")).toBe("stale_context");
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

describe("collectOutcome — D5-③ failureKind 产出", () => {
  /** 最小 ReplayRecordView stub（collectOutcome 只读 turns/toolCalls 派生面）。 */
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

  it("error 命中 stale 词表 → failureKind=stale_context", () => {
    const record = makeRecordWithCalls([]);
    const result = collectOutcome(record, {
      ...baseArgs,
      success: false,
      error: "This extension ctx is stale after session replacement or reload.",
    });
    expect(result.failureKind).toBe("stale_context");
  });

  it("F-1 归因覆写（态①②确定性标记）→ failureKind=schema_deterministic", () => {
    const record = makeRecordWithCalls([]);
    const result = collectOutcome(record, { ...baseArgs, success: true, error: undefined, schemaExpected: true });
    expect(result.error).toBeDefined();
    expect(result.failureKind).toBe("schema_deterministic");
  });

  it("态③归因（调用过但无 details，无标记）→ failureKind=unknown（可重试，矩阵保留）", () => {
    const record = makeRecordWithCalls([
      { toolName: "structured-output", result: { content: [] } },
    ]);
    const result = collectOutcome(record, { ...baseArgs, success: true, error: undefined, schemaExpected: true });
    expect(result.error).toBeDefined();
    expect(result.failureKind).toBe("unknown");
  });

  it("普通 provider 错误 → failureKind=unknown", () => {
    const record = makeRecordWithCalls([]);
    const result = collectOutcome(record, { ...baseArgs, success: false, error: "provider boom 5xx" });
    expect(result.failureKind).toBe("unknown");
  });

  it("成功路径（error undefined）→ failureKind 不写（缺省 = unknown = 可重试，消费侧语义）", () => {
    const record = makeRecordWithCalls([]);
    const result = collectOutcome(record, { ...baseArgs, success: true, error: undefined });
    expect(result.failureKind).toBeUndefined();
  });

  it("词表漂移失效模式：未知文案（未来 pi 形态）→ failureKind=unknown（保守重试，非静默漏诊）", () => {
    const record = makeRecordWithCalls([]);
    const result = collectOutcome(record, {
      ...baseArgs,
      success: false,
      error: "extension runtime was superseded by a newer orchestration epoch",
    });
    expect(result.failureKind).toBe("unknown");
  });
});
