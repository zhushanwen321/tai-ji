// src/execution/__tests__/agent-result-mapper.test.ts
//
// T3.14 (NFR-兼容性): AgentResult 映射字段对齐 —— D-A10 纯函数单测
// T3.1  (正常): executeAndAwait 返回 content → 间接覆盖（subagent-service.test.ts 集成验证）
//
// 测试范围: mapToWorkflowAgentResult 所有字段映射分支（success/error/usage/toolCalls）

import { describe, expect, it } from "vitest";

import { mapToWorkflowAgentResult } from "../assembly/agent-result-mapper.ts";
import type { AgentResult as SubagentsAgentResult, AgentUsageTotal, ToolCall } from "../assembly/types.ts";

describe("mapToWorkflowAgentResult (D-A10)", () => {
  const minimalResult: SubagentsAgentResult = {
    text: "Hello",
    turns: 3,
    durationMs: 1200,
    success: true,
    sessionId: "session-123",
    toolCalls: [],
  };

  // ── T3.14: 正常成功路径 ──

  it("映射成功结果: text→content, durationMs/sessionId 透传", () => {
    const result = mapToWorkflowAgentResult(minimalResult);
    expect(result.content).toBe("Hello");
    expect(result.durationMs).toBe(1200);
    expect(result.sessionId).toBe("session-123");
    expect(result.error).toBeUndefined();
    expect(result.parsedOutput).toBeUndefined();
    expect(result.usage).toBeUndefined();
    expect(result.toolCalls).toEqual([]);
  });

  // ── sessionFile 透传（方案 A：让 workflow 继承 subagent 的 session jsonl 路径）──

  it("映射 sessionFile: subagents AgentResult.sessionFile → workflow AgentResult.sessionFile 透传", () => {
    const r: SubagentsAgentResult = {
      ...minimalResult,
      sessionFile: "/abs/path/.pi/agent/subagents/enc/sessions/2026-07-15T10-00-00-000Z_session-123.jsonl",
    };
    const result = mapToWorkflowAgentResult(r);
    expect(result.sessionFile).toBe("/abs/path/.pi/agent/subagents/enc/sessions/2026-07-15T10-00-00-000Z_session-123.jsonl");
  });

  it("映射 sessionFile: 无 sessionFile → workflow AgentResult.sessionFile undefined（窗口期/未回填）", () => {
    const r: SubagentsAgentResult = { ...minimalResult, sessionFile: undefined };
    const result = mapToWorkflowAgentResult(r);
    expect(result.sessionFile).toBeUndefined();
  });

  it("映射 parsedOutput 透传（structured-output 契约 BC-8）", () => {
    const parsedData = { score: 0.95, label: "positive" };
    const r: SubagentsAgentResult = { ...minimalResult, parsedOutput: parsedData };
    const result = mapToWorkflowAgentResult(r);
    expect(result.parsedOutput).toEqual(parsedData);
  });

  // ── D5-③: failureKind 分诊标签透传（产出侧 output-collector → 消费侧 executeAgentCall） ──

  it("failureKind 三态逐值透传（stale_context / schema_deterministic / unknown）", () => {
    for (const kind of ["stale_context", "schema_deterministic", "unknown"] as const) {
      const r: SubagentsAgentResult = { ...minimalResult, success: false, error: "boom", failureKind: kind };
      const result = mapToWorkflowAgentResult(r);
      expect(result.failureKind).toBe(kind);
    }
  });

  it("failureKind 缺省（成功路径/上游未写）→ 不落键（消费侧视为 unknown = 可重试）", () => {
    const result = mapToWorkflowAgentResult(minimalResult);
    expect(result.failureKind).toBeUndefined();
    expect("failureKind" in result).toBe(false);
  });

  // ── T3.14: 失败路径 ──

  it("映射失败: success=false 且 error → 填入 error 字段", () => {
    const r: SubagentsAgentResult = { ...minimalResult, success: false, error: "timeout" };
    const result = mapToWorkflowAgentResult(r);
    expect(result.error).toBe("timeout");
    expect(result.content).toBe("Hello"); // content 仍保留（可能有部分输出）
  });

  it("映射失败: success=false 但无 error（abort 路径）→ error 填入 fallback 而非 undefined", () => {
    // H4: session-runner.ts abort 时 success=false, error=undefined。
    // 旧代码 error=undefined → executeAgentCall 误判 completed。
    // 修复后应 synthesize fallback error。
    const r: SubagentsAgentResult = { ...minimalResult, success: false };
    const result = mapToWorkflowAgentResult(r);
    expect(result.error).toBeDefined();
    expect(typeof result.error).toBe("string");
    expect(result.error!.length).toBeGreaterThan(0);
  });

  it("映射成功: success=true 且 error 存在 → error=undefined（不误填）", () => {
    const r: SubagentsAgentResult = { ...minimalResult, success: true, error: "stale" };
    const result = mapToWorkflowAgentResult(r);
    expect(result.error).toBeUndefined();
  });

  // ── T3.14: usage 映射 ──

  it("映射 usage: AgentUsageTotal → AgentUsage（字段形状转换）", () => {
    const usage: AgentUsageTotal = {
      input: 1000,
      output: 500,
      cacheRead: 200,
      cacheWrite: 100,
      total: 1800,
      cost: 0.005,
    };
    const r: SubagentsAgentResult = { ...minimalResult, usage };
    const result = mapToWorkflowAgentResult(r);
    expect(result.usage).toEqual({
      input: 1000,
      output: 500,
      cacheRead: 200,
      cacheWrite: 100,
      cost: 0.005,
      contextTokens: 1800, // total → contextTokens
      turns: 3, // 来自 AgentResult.turns
    });
  });

  it("映射 usage: 无 usage → usage undefined", () => {
    const result = mapToWorkflowAgentResult(minimalResult);
    expect(result.usage).toBeUndefined();
  });

  // ── T3.14: toolCalls 映射 ──

  it("映射 toolCalls: ToolCall → ToolCallEntry（name/input 形状转换）", () => {
    const calls: ToolCall[] = [
      { toolName: "read", args: { path: "/a.txt" } },
      { toolName: "bash", args: { command: "ls" }, result: { content: ["ok"] }, isError: false },
    ];
    const r: SubagentsAgentResult = { ...minimalResult, toolCalls: calls };
    const result = mapToWorkflowAgentResult(r);
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls!).toHaveLength(2);
    expect(result.toolCalls![0]).toEqual({ name: "read", input: '{"path":"/a.txt"}' });
    expect(result.toolCalls![1].name).toBe("bash");
  });

  it("映射 toolCalls: args=undefined → input=''", () => {
    const calls: ToolCall[] = [{ toolName: "list" }];
    const r: SubagentsAgentResult = { ...minimalResult, toolCalls: calls };
    const result = mapToWorkflowAgentResult(r);
    expect(result.toolCalls![0].input).toBe("");
  });

  it("映射 toolCalls: 长 args 截断（>500 chars）", () => {
    const longStr = "x".repeat(600);
    const calls: ToolCall[] = [{ toolName: "write", args: { content: longStr } }];
    const r: SubagentsAgentResult = { ...minimalResult, toolCalls: calls };
    const result = mapToWorkflowAgentResult(r);
    expect(result.toolCalls![0].input.length).toBeLessThanOrEqual(503); // 500 + "..."
  });

  it("映射 toolCalls: 无 toolCalls → undefined", () => {
    const r = { ...minimalResult, toolCalls: undefined } as unknown as SubagentsAgentResult;
    const result = mapToWorkflowAgentResult(r);
    expect(result.toolCalls).toBeUndefined();
  });
});
