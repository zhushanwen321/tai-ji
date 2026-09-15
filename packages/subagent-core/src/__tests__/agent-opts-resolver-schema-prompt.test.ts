// agent-opts-resolver schema prompt wording lock (suggestion #4).
//
// M2 修正后 resolveAgentOpts 把 schema structured-output 指令内容直传进
// appendSystemPrompt（不再写临时文件、不再 push 路径）。本测试锁死 SO 指令措辞 +
// 验证 agent 正文不经此通道（防双重注入回归）。
//
// 覆盖 design.json TC1（措辞）/ TC2（无 schema）/ TC3（不处理 agent ref）。

import { describe, expect, it } from "vitest";

import type { AgentCallOpts } from "../orchestration/models/types.ts";
import { resolveAgentOpts } from "../orchestration/agent-opts-resolver.ts";

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

  it("sets schemaEnv from the provided schema (PI_WORKFLOW_SCHEMA contract)", () => {
    const schema: Record<string, unknown> = {
      type: "object",
      properties: { n: { type: "number" } },
    };
    const opts: AgentCallOpts = { prompt: "x", schema };
    const result = resolveAgentOpts(opts);

    expect(result.opts.schemaEnv).toBe(JSON.stringify(schema));
  });

  it("无 schema 时 schemaEnv undefined", () => {
    const opts: AgentCallOpts = { prompt: "x" };
    const result = resolveAgentOpts(opts);

    expect(result.opts.schemaEnv).toBeUndefined();
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
