// agent-opts-resolver schema prompt wording lock (suggestion #4).
//
// M2 修正后 resolveAgentOpts 把 schema structured-output 指令内容直传进
// appendSystemPrompt（不再写临时文件、不再 push 路径）。本测试锁死 SO 指令措辞 +
// 验证 agent 正文不经此通道（防双重注入回归）。
//
// 覆盖 design.json TC1（措辞）/ TC2（无 schema）/ TC3（不处理 agent ref）。

import { describe, expect, it } from "vitest";

// [round5-g 合并产物] 吸收同被测模块（agent-opts-resolver.ts 导出）姊妹件：
// - format-schema-instruction.test.ts（formatSchemaInstruction 契约）
// - m2-append-content-probe.test.ts（M2 append 内容直传探针）
import type { AgentCallOpts } from "../models/types.ts";
import { formatSchemaInstruction, resolveAgentOpts } from "../agent-opts-resolver.ts";

describe("resolveAgentOpts schema prompt wording + M2 content passthrough", () => {
  it("schema 提供时 appendSystemPrompt 含 SO 指令内容（TC1 措辞锁）", () => {
    const opts: AgentCallOpts = {
      prompt: "do the thing",
      schema: { type: "object" },
      agent: "/abs/path/worker.md",
    };
    const result = resolveAgentOpts(opts);

    expect(result.error).toBeUndefined();
    expect(result.opts.appendSystemPrompt).toBeDefined();
    expect(result.opts.appendSystemPrompt!.length).toBe(1);

    const content = result.opts.appendSystemPrompt![0];
    // 措辞锁（单参数口径）：工具参数即结果数据本身，schema 已无独立 data 参数
    expect(content).toContain("Your call arguments ARE the result data itself");
    expect(content).toContain("Your result must conform to this schema:");
    expect(content).toContain("The system validates them against the schema above automatically");
    // 反向回流锁：旧双参数口径文案（"do NOT pass a schema parameter" / "ONLY the data
    // parameter"）一旦回流立即失败
    expect(content).not.toMatch(
      /do NOT pass a .schema. parameter|ONLY the .data. parameter/i,
    );
    // 内容直传（M2 fix）：非路径
    expect(content).not.toMatch(/\/tmp\/|\/var\/folders\//);
    expect(content).not.toMatch(/\.md$/);
  });

  it("无 schema 无 skill 时 appendSystemPrompt undefined（TC2）", () => {
    const opts: AgentCallOpts = {
      prompt: "x",
      agent: "/abs/path/worker.md",
      description: "test",
    };
    const result = resolveAgentOpts(opts);

    expect(result.error).toBeUndefined();
    expect(result.opts.appendSystemPrompt).toBeUndefined();
    // agent ref 原样保留（交 resolveIdentity 处理）
    expect(result.opts.agent).toBe("/abs/path/worker.md");
  });

  it("resolveAgentOpts 不处理 agent ref——不存在路径不报错（TC3）", () => {
    const opts: AgentCallOpts = {
      prompt: "x",
      agent: "/nonexistent/agent.md",
    };
    const result = resolveAgentOpts(opts);

    // resolveAgentOpts 不校验 agent 路径（已移交 resolveIdentity）
    expect(result.error).toBeUndefined();
    expect(result.opts.agent).toBe("/nonexistent/agent.md");
    // model/thinkingLevel 不被 resolveAgentOpts 修改（agent 层级提升已消除）
    expect(result.opts.model).toBeUndefined();
    expect(result.opts.thinkingLevel).toBeUndefined();
  });

  // H1 schema 传输归位：resolver 产出侧只产 schema 本体——PI_WORKFLOW_SCHEMA env
  // 预编码值（schemaEnv）退役，env 由引擎侧从 task.schema 派生。产出形态锁：
  // schemaEnv 键重新出现在产出对象上即回归。
  it("schema 提供时产出只有 schema 本体、无 schemaEnv 键（H1：env 派生归引擎侧）", () => {
    const schema: Record<string, unknown> = {
      type: "object",
      properties: { n: { type: "number" } },
    };
    const opts: AgentCallOpts = { prompt: "x", schema };
    const result = resolveAgentOpts(opts);

    expect(result.opts.schema).toBe(schema);
    expect(result.opts).not.toHaveProperty("schemaEnv");
    expect("schemaEnv" in result.opts).toBe(false);
  });

  it("无 schema 时产出同样无 schemaEnv 键", () => {
    const opts: AgentCallOpts = { prompt: "x" };
    const result = resolveAgentOpts(opts);

    expect(result.opts.schema).toBeUndefined();
    expect(result.opts).not.toHaveProperty("schemaEnv");
  });

  // [U3] 根类型条件化：ASP 文案与 structured-output 工具 description 同源互斥——
  // object 根口径「arguments ARE the data」；非 object 根参数层实为 {value} 包装，
  // 文案必须告知 {value: <data>} 契约，两形态文案互斥不可共存。
  describe("根类型条件化文案（U3：与工具 description 同源互斥）", () => {
    it("object 根 → arguments 即 data 口径，无 {value} 包装语汇", () => {
      const opts: AgentCallOpts = {
        prompt: "x",
        schema: { type: "object", properties: { n: { type: "number" } } },
      };
      const content = resolveAgentOpts(opts).opts.appendSystemPrompt![0];

      expect(content).toContain("Your call arguments ARE the result data itself");
      expect(content).not.toContain("{value:");
      expect(content).not.toContain("value.");
      // Rules 首条同样是 object 根口径
      expect(content).toContain(
        "- Call the structured-output tool with your result data as its arguments.",
      );
      expect(content).not.toContain("{value: <your result data>}");
    });

    it("非 object 根（array）→ {value} 包装契约语汇，无 arguments 即 data 口径", () => {
      const opts: AgentCallOpts = {
        prompt: "x",
        schema: { type: "array", items: { type: "string" } },
      };
      const content = resolveAgentOpts(opts).opts.appendSystemPrompt![0];

      // 包装契约与 value. 错误路径前缀（与工具 description 同语汇）
      expect(content).toContain("{value: <data>}");
      expect(content).toContain("value.");
      expect(content).toContain("that prefix addresses the wrapper, not your data");
      // 互斥：object 根专属文案不得出现
      expect(content).not.toContain("Your call arguments ARE the result data itself");
      expect(content).not.toContain(
        "- Call the structured-output tool with your result data as its arguments.",
      );
      // Rules 首条切换为包装口径
      expect(content).toContain("- Call the structured-output tool with `{value: <your result data>}`.");
    });

    it("组合根（anyOf，可能接受非 object 值）→ 按非 object 包装口径", () => {
      const opts: AgentCallOpts = {
        prompt: "x",
        schema: { anyOf: [{ type: "string" }, { type: "number" }] },
      };
      const content = resolveAgentOpts(opts).opts.appendSystemPrompt![0];

      expect(content).toContain("{value: <data>}");
      expect(content).not.toContain("Your call arguments ARE the result data itself");
    });
  });
});

// ══════ 来源: format-schema-instruction.test.ts ══════

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

  // ── schema 序列化（compact）───────

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
    // 文案源；JSON 从 pretty（indent=2）改为 compact。
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

// ══════ 来源: m2-append-content-probe.test.ts ══════

// M2 修复回归探针（design.json TC1）。
//
// M2 bug：旧实现把 schema SO 指令写成临时文件，push 文件路径（而非内容）给下游，
// 下游 mapper/session-runner 把路径当文本拼进最终 append 文件，子进程收到
// "/var/folders/.../xxx.md" 路径垃圾，schema 指令从未进入子进程。
//
// 修复后：schema 指令内容直传 appendSystemPrompt（不写盘、无临时文件）。
// 本探针锁死：appendSystemPrompt 只含 SO 指令内容，不含 agent 正文，无路径，无临时文件。



describe("M2 append-content probe (design.json TC1)", () => {
  it("schema + agent 时 appendSystemPrompt 只含 SO 指令内容（非路径、非 agent 正文）", () => {
    const opts: AgentCallOpts = {
      prompt: "run task",
      schema: { type: "object", properties: { ok: { type: "boolean" } } },
      agent: "/fake/agents/worker.md",
      description: "m2-probe",
    };

    const result = resolveAgentOpts(opts);

    expect(result.error).toBeUndefined();
    // 只含 SO 指令（length === 1）
    expect(result.opts.appendSystemPrompt).toBeDefined();
    expect(result.opts.appendSystemPrompt!.length).toBe(1);

    const item = result.opts.appendSystemPrompt![0];

    // 内容语义：含 structured-output 关键词
    expect(item).toContain("structured-output");
    // 非路径：不匹配 /tmp 或 var/folders（M2 bug 旧实现 push 路径字符串）
    expect(item).not.toMatch(/\/tmp\/|\/var\/folders\//);
    // 不以 .md 结尾（路径特征）
    expect(item).not.toMatch(/\.md$/);
    // 不含 agent 正文/路径标识词（agent 正文不经 appendSystemPrompt，防双重注入回归）
    expect(item).not.toContain("/fake/agents/worker.md");
    // agent ref 原样保留（resolveAgentOpts 不消费 agent，交 resolveIdentity）
    expect(result.opts.agent).toBe("/fake/agents/worker.md");
    // model/thinkingLevel 未被修改（agent 处理移交，不在此提升层级）
    expect(result.opts.model).toBeUndefined();
    expect(result.opts.thinkingLevel).toBeUndefined();
    // H1：schemaEnv 预编码值退役——resolver 只产 schema 本体，env 由引擎侧派生
    expect(result.opts.schema).toBe(opts.schema);
    expect(result.opts).not.toHaveProperty("schemaEnv");
  });

  it("agent 存在不影响 appendSystemPrompt 内容（agent 正文结构性不泄漏）", () => {
    const schema = { type: "object" } as Record<string, unknown>;
    const withAgent = resolveAgentOpts({ prompt: "x", schema, agent: "/fake/a.md" });
    const withoutAgent = resolveAgentOpts({ prompt: "x", schema });

    // 加不加 agent，appendSystemPrompt 完全相同——证明 agent 不被消费、正文不注入
    expect(withAgent.opts.appendSystemPrompt).toEqual(withoutAgent.opts.appendSystemPrompt);
  });

  it("无 schema 时 appendSystemPrompt undefined", () => {
    const result = resolveAgentOpts({ prompt: "x", agent: "/fake/a.md" });
    expect(result.opts.appendSystemPrompt).toBeUndefined();
  });

  it("resolveAgentOpts 无文件副作用——同 schema 多次调用结果字节相同（无随机路径）", () => {
    const schema = { type: "object" } as Record<string, unknown>;
    const a = resolveAgentOpts({ prompt: "x", schema });
    const b = resolveAgentOpts({ prompt: "x", schema });

    // 旧实现每次写入随机 UUID 文件名路径，结果不同；内容直传后结果确定性相同
    expect(a.opts.appendSystemPrompt).toEqual(b.opts.appendSystemPrompt);
  });
});
