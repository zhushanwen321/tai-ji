// M2 修复回归探针（design.json TC1）。
//
// M2 bug：旧实现把 schema SO 指令写成临时文件，push 文件路径（而非内容）给下游，
// 下游 mapper/session-runner 把路径当文本拼进最终 append 文件，子进程收到
// "/var/folders/.../xxx.md" 路径垃圾，schema 指令从未进入子进程。
//
// 修复后：schema 指令内容直传 appendSystemPrompt（不写盘、无临时文件）。
// 本探针锁死：appendSystemPrompt 只含 SO 指令内容，不含 agent 正文，无路径，无临时文件。

import { describe, expect, it } from "vitest";

import type { AgentCallOpts } from "../orchestration/models/types.ts";
import { resolveAgentOpts } from "../orchestration/agent-opts-resolver.ts";

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
    // schemaEnv 设置（PI_WORKFLOW_SCHEMA 契约）
    expect(result.opts.schemaEnv).toBe(JSON.stringify(opts.schema));
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
