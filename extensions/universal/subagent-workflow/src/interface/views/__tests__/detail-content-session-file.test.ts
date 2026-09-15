// src/interface/views/__tests__/detail-content-session-file.test.ts
//
// TUI 渲染测试：buildDetailContent 在 agent 终态时渲染 session: 路径行。
//
// 防的 bug：node.sessionFile 有值但 TUI detail 不显示——用户在交互面板里
// 看不到 agent 的 session jsonl 路径，无法定位文件做后续查看。

import { describe, expect, it } from "vitest";

import { buildDetailContent } from "../detail-content.ts";
import type { ThemeLike } from "../../format.ts";
import type { ExecutionTraceNode } from "@zhushanwen/subagent-core";
import type { WorkflowRun } from "@zhushanwen/subagent-core";

/** plain theme: 着色方法直接返回原文，无 ANSI 色码——测试断言纯文本。
 *  bg/underline 为宽 ThemeLike 接口的 no-op 实现（workflow 渲染面只用 fg/bold）。 */
const plainTheme: ThemeLike = {
  bg: (_color: string, text: string) => text,
  fg: (_tag: string, text: string) => text,
  bold: (text: string) => text,
  underline: (text: string) => text,
};

function makeNode(overrides: Partial<ExecutionTraceNode> = {}): ExecutionTraceNode {
  return {
    stepIndex: 0,
    agent: "coder",
    task: "do something",
    model: "default",
    status: "completed",
    ...overrides,
  };
}

/** 最小 WorkflowRun——buildDetailContent 只读 run.state.errorLogs。 */
function makeRun(): WorkflowRun {
  return {
    state: { errorLogs: [] },
  } as unknown as WorkflowRun;
}

describe("buildDetailContent session 路径行渲染", () => {
  it("node.sessionFile 有值 → 详情末尾渲染 session: <路径>", () => {
    const sessionPath = "/abs/.pi/agent/subagents/enc/sessions/2026-07-15T_session-abc.jsonl";
    const node = makeNode({
      status: "completed",
      sessionFile: sessionPath,
      result: { content: "done" },
    });
    const lines = buildDetailContent(node, { promptExpanded: false }, makeRun(), plainTheme, 120, Date.now());
    const sessionLine = lines.find((l) => l.includes("session:"));
    expect(sessionLine).toBeDefined();
    expect(sessionLine).toContain(sessionPath);
  });

  it("node.sessionFile undefined（窗口期）→ 不渲染 session: 行", () => {
    const node = makeNode({ status: "completed", sessionFile: undefined, result: { content: "done" } });
    const lines = buildDetailContent(node, { promptExpanded: false }, makeRun(), plainTheme, 120, Date.now());
    const sessionLine = lines.find((l) => l.includes("session:"));
    expect(sessionLine).toBeUndefined();
  });

  it("长路径截断到 mainWidth（防溢出）", () => {
    const longPath = "/very/long/path/" + "x".repeat(200) + "/session.jsonl";
    const node = makeNode({ status: "completed", sessionFile: longPath, result: { content: "done" } });
    const narrowWidth = 60;
    const lines = buildDetailContent(node, { promptExpanded: false }, makeRun(), plainTheme, narrowWidth, Date.now());
    const sessionLine = lines.find((l) => l.includes("session:"));
    expect(sessionLine).toBeDefined();
    // 截断后行宽不超过 mainWidth + 边框余量
    expect(sessionLine!.length).toBeLessThanOrEqual(narrowWidth);
  });
});
