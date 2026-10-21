// resume-run-rebuild.test.ts —— resume 重建 fold 语义测试（subagent-tool-interface-refactor
// 设计 §3.4「resume-run-rebuild.ts 修复 fold 的在途语义」；impl-plan u-foundation 验收条款②）。
//
// 覆盖：中断恢复重建（rebuildRunFromRecord）的 trace 节点状态位——
// - 在途 draft（有 agent-started 无 agent-settled）折 running，不是 completed（假成功 bug 修复；
//   与壳侧 foldRecordStreamToRun 的在途 = running 语义对齐）
// - settled 帧按 result.error 定 failed/completed（既有语义回归）
// - 回放集/重派集的 AgentCall 条目语义不变（重派集不建条目）
import { describe, expect, it } from "vitest";

import { rebuildRunFromRecord } from "../resume-run-rebuild.ts";
import type { WorkflowRunEvent } from "../run-events.ts";

const T0 = 1_770_000_000_000;

function makeRunCreated(): Extract<WorkflowRunEvent, { type: "run-created" }> {
  return {
    type: "run-created",
    runId: "wf-fold",
    seq: 0,
    workflowName: "fan-out",
    argsSummary: "{}",
    scriptSource: "async function execute({ agent }) { await agent('step1'); }",
    scriptPath: "/abs/workflows/fan-out.js",
    ts: T0,
  };
}

describe("rebuildRunFromRecord — fold 在途语义（中断恢复）", () => {
  it("在途 draft（无 settled 帧）折为 running，不是 completed；回放集折 completed；settled failed 折 failed", () => {
    const created = makeRunCreated();
    const events: WorkflowRunEvent[] = [
      // 回放集：taskIndex 0 done（result 全文随帧）。
      { type: "agent-started", taskIndex: 0, agentName: "fan-out-0", attempt: 1, seq: 1, ts: T0 + 1_000 },
      { type: "agent-settled", taskIndex: 0, attempt: 1, outcome: "done", durationMs: 5_000, result: { content: "result-0" }, seq: 2, ts: T0 + 6_000 },
      // 回放集：taskIndex 1 failed（result.error 定状态位）。
      { type: "agent-started", taskIndex: 1, agentName: "fan-out-1", attempt: 1, seq: 3, ts: T0 + 7_000 },
      { type: "agent-settled", taskIndex: 1, attempt: 1, outcome: "failed", durationMs: 500, result: { content: "", error: "boom" }, seq: 4, ts: T0 + 7_500 },
      // 重派集：taskIndex 2 有 started 无 settled——中断时仍在途。
      { type: "agent-started", taskIndex: 2, agentName: "fan-out-2", attempt: 1, seq: 5, ts: T0 + 8_000 },
    ];

    const run = rebuildRunFromRecord("wf-fold", created, events);
    const statusByIndex = new Map(run.state.trace.toArray().map((n) => [n.stepIndex, n.status]));

    expect(statusByIndex.get(0)).toBe("completed");
    expect(statusByIndex.get(1)).toBe("failed");
    // 修复断言：在途 draft 折 running——旧实装折 completed（假成功：未跑完的成员在
    // resume 后的成员表兜底路径冒充已完成）。
    expect(statusByIndex.get(2)).toBe("running");
  });

  it("在途 draft 的节点可被成员表兜底路径消费：agent 标签与 startedAt 随帧恢复", () => {
    const created = makeRunCreated();
    const events: WorkflowRunEvent[] = [
      { type: "agent-started", taskIndex: 3, agentName: "fan-out-3", attempt: 2, seq: 6, ts: T0 + 9_000 },
    ];

    const run = rebuildRunFromRecord("wf-fold", created, events);
    const node = run.state.trace.toArray().find((n) => n.stepIndex === 3);
    expect(node).toBeDefined();
    expect(node!.status).toBe("running");
    expect(node!.agent).toBe("fan-out-3");
    expect(node!.startedAt).toBe(new Date(T0 + 9_000).toISOString());
    expect(node!.completedAt).toBeUndefined(); // 未终局无完成时刻
  });

  it("call 条目语义不变：回放集 done + result 全文；重派集不建条目（worker 重跑到断点处重新派发）", () => {
    const created = makeRunCreated();
    const events: WorkflowRunEvent[] = [
      { type: "agent-started", taskIndex: 0, agentName: "fan-out-0", attempt: 1, seq: 7, ts: T0 + 1_000 },
      { type: "agent-settled", taskIndex: 0, attempt: 1, outcome: "done", durationMs: 5_000, result: { content: "result-0" }, seq: 8, ts: T0 + 6_000 },
      { type: "agent-started", taskIndex: 1, agentName: "fan-out-1", attempt: 1, seq: 9, ts: T0 + 7_000 },
    ];

    const run = rebuildRunFromRecord("wf-fold", created, events);
    const replayed = run.state.calls.get(0);
    expect(replayed?.status).toBe("done");
    expect(replayed?.result?.content).toBe("result-0");
    expect(run.state.calls.has(1)).toBe(false);
  });
});
