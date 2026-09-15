// src/execution/__tests__/format-schema-instruction.test.ts
//
// 锁定 formatSchemaInstruction 契约：构造 schema enforcement 的 MANDATORY 指令。
// [审查项#2] 注入链变更：指令仅经 agent-opts-resolver 进 appendSystemPrompt
// （ASP 单点），runSpawn 的 task + instruction 后缀拼接已删除——本测试随之改锁
// resolver 导出的同名函数。一旦漏掉 "structured-output" 关键词或 JSON 序列化漂移，
// schema 模式会静默失效——agent 可能直接把 JSON 写进文本响应。
//
// [审查项#4] 锁定 AP 告知句：注入侧校验用 additionalProperties:false 收窄后的
// parameters，指令必须前置告知「schema 外字段被拒」，否则拒绝显得凭空。
//
// 纯函数测试：不依赖 Pi 运行时、不 spawn 进程、不 mock。只 import 被测函数。
import { describe, expect, it } from "vitest";

import { formatSchemaInstruction } from "../../orchestration/agent-opts-resolver.ts";

describe("formatSchemaInstruction", () => {
  // ── 指令文本契约 ──────────────────────────────────────────────

  it("contains the structured-output tool keyword", () => {
    const out = formatSchemaInstruction({ type: "object" });
    expect(out).toContain("structured-output");
  });

  it("emits a MANDATORY structured-output directive (not free-form JSON)", () => {
    const out = formatSchemaInstruction({ type: "object" });
    expect(out).toContain("MANDATORY");
    expect(out).toContain("must be calling the `structured-output` tool");
    expect(out).toContain("Do NOT output JSON in your text response");
  });

  it("announces that fields outside the schema are rejected (AP 告知，审查项#4)", () => {
    const out = formatSchemaInstruction({ type: "object" });
    expect(out).toContain("Fields not defined in this schema are rejected");
    expect(out).toContain("do not add extra fields");
  });

  it("author-declared additionalProperties → weak wording (AP 条件化：声明时作者 schema 管辖额外字段)", () => {
    // D4 只在「未声明」时注入 false；作者显式声明 true 时额外字段实际放行——
    // 无条件「一律拒绝」强承诺与参数层行为不符，改用弱承诺措辞。
    const out = formatSchemaInstruction({ type: "object", additionalProperties: true });
    expect(out).not.toContain("Fields not defined in this schema are rejected");
    expect(out).toContain("follow this schema's own additionalProperties declaration");
  });

  // ── schema 序列化（compact：与 schemaEnv 复用同串，IF7 #13）───────

  it("embeds the schema as compact JSON inside a fenced block", () => {
    const schema: Record<string, unknown> = {
      type: "object",
      properties: { name: { type: "string" } },
    };
    const out = formatSchemaInstruction(schema);
    // 必须包含 JSON.stringify(schema) 的完整结果（compact，无缩进）
    expect(out).toContain(JSON.stringify(schema));
    expect(out).toContain("```json");
    expect(out).toContain("```");
  });

  it("locks the full output structure for a minimal schema", () => {
    const out = formatSchemaInstruction({ type: "object" });
    // 完整结构快照——任何指令措辞/顺序/序列化漂移都会被捕获。
    // [HISTORICAL] runner task 后缀双重注入删除后，本函数迁至 resolver 成为唯一
    // 文案源；JSON 从 pretty（indent=2）改为 compact（与 schemaEnv 同串复用）。
    expect(out).toBe(
      [
        "## MANDATORY: Structured Output Requirement",
        "",
        "This task requires structured output.",
        "Your FINAL action must be calling the `structured-output` tool.",
        "",
        "Your call arguments ARE the result data itself — the tool's parameter schema IS the required shape of your result.",
        "Your result must conform to this schema:",
        "```json",
        '{"type":"object"}',
        "```",
        "",
        "Rules:",
        "- Call the structured-output tool with your result data as its arguments. The system validates them against the schema above automatically.",
        "- Do NOT output JSON in your text response — use the structured-output tool.",
        "- Do NOT skip this step. The structured-output call IS your result.",
        "- Complete all other work FIRST, then call structured-output as the last action.",
        "- Fields not defined in this schema are rejected — do not add extra fields.",
      ].join("\n"),
    );
  });

  it("locks the single-parameter wording: arguments ARE the data coexists with the mandatory tool call", () => {
    const out = formatSchemaInstruction({ type: "object" });
    // 新口径双支柱必须共存：① 参数即数据（arguments ARE the data）② 必须调用工具
    expect(out).toContain("arguments ARE the result data itself");
    expect(out).toContain("parameter schema IS the required shape of your result");
    expect(out).toContain("must be calling the `structured-output` tool");
    // 旧双参数警告语义不得回流（工具已是单参数形态，警告失去对象）
    expect(out).not.toMatch(/do NOT pass a .schema. parameter/i);
    expect(out).not.toContain("ONLY the `data` parameter");
    expect(out).not.toContain("enforced by the system");
  });

  // ── 特殊字符转义（注入风险路径）──────────────────────────────

  it("escapes double quotes inside schema string values", () => {
    const schema: Record<string, unknown> = { prompt: 'say "hi"' };
    const out = formatSchemaInstruction(schema);
    // JSON.stringify 会把内层 " 转义为 \"
    expect(out).toContain('say \\"hi\\"');
    // 原始未转义形式（含成对字面双引号）绝不能回流进 JSON 体内
    expect(out).not.toContain('say "hi"');
  });

  it("escapes newlines inside schema string values", () => {
    const schema: Record<string, unknown> = { text: "line1\nline2" };
    const out = formatSchemaInstruction(schema);
    // 换行被序列化为字面反斜杠-n，不能是真实换行符
    expect(out).toContain("line1\\nline2");
    expect(out).not.toContain("line1\nline2");
  });

  it("escapes backslashes inside schema string values", () => {
    const schema: Record<string, unknown> = { path: "C:\\Users\\x" };
    const out = formatSchemaInstruction(schema);
    // 单反斜杠被序列化为 \\，避免后续解析误把转义序列当指令
    expect(out).toContain("C:\\\\Users\\\\x");
    expect(out).not.toContain("C:\\Users\\x");
  });

  // ── 边界值 ────────────────────────────────────────────────────

  it("handles empty schema object", () => {
    const out = formatSchemaInstruction({});
    expect(out).toContain("structured-output");
    expect(out).toContain("{}");
  });

  it("preserves null values in schema", () => {
    const schema: Record<string, unknown> = { default: null };
    const out = formatSchemaInstruction(schema);
    // JSON.stringify 对 null 保留字面 "null"（不会 omit 键，也不会变字符串）。
    // compact 序列化无空格：'"default":null'
    expect(out).toContain('"default":null');
  });

  it("serializes nested objects and arrays", () => {
    const schema: Record<string, unknown> = {
      type: "object",
      required: ["name", "age"],
      properties: {
        name: { type: "string" },
        age: { type: "integer", minimum: 0 },
      },
    };
    const out = formatSchemaInstruction(schema);
    expect(out).toContain(JSON.stringify(schema));
  });

  // ── 确定性 ────────────────────────────────────────────────────

  it("is deterministic — same schema produces identical output", () => {
    const schema: Record<string, unknown> = { a: 1, b: [2, 3] };
    expect(formatSchemaInstruction(schema)).toBe(formatSchemaInstruction(schema));
  });

  it("is deterministic across different object key insertion (value-equal schemas)", () => {
    // JSON.stringify 按对象自身属性顺序序列化；同序构造的等价 schema 应产出相同指令
    const a: Record<string, unknown> = { x: 1, y: 2 };
    const b: Record<string, unknown> = { x: 1, y: 2 };
    expect(formatSchemaInstruction(a)).toBe(formatSchemaInstruction(b));
  });
});
