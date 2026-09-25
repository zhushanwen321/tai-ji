/**
 * [H2 W3] store record live 进度配对单测。
 *
 * collectNodeLiveProgress 配对（record ↔ trace node）：task 标签匹配 +
 * startedAt 最近邻 + 贪心唯一；终态 node 不配；无匹配 record（重试间隙）返回空。
 *
 * SubagentRecord 经 duck typing 构造（对齐 WorkflowsView-signature.test.ts 先例）；
 * SubagentRecord 投影面（eventLog/turns/totalTokens 等）的投影恒等由 core 侧
 * record-store 测试锁定，此处消费投影面。
 */
import { describe, it, expect } from "vitest";

import type { SubagentRecord, WorkflowRun } from "@zhushanwen/subagent-core";
import { collectNodeLiveProgress } from "../WorkflowsView.ts";

// ── Fixtures ──────────────────────────────────────────────────

const T0 = 1_700_000_000_000;

function makeRunShape(nodes: { stepIndex: number; task: string; status: string; startedAt: string }[]): WorkflowRun {
  return {
    state: { trace: { toArray: () => nodes } },
  } as unknown as WorkflowRun;
}

function makeSub(over: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    id: "sa-match",
    task: "调研 A",
    status: "running",
    startedAt: T0,
    turns: 0,
    totalTokens: 0,
    eventLog: [],
    ...over,
  } as SubagentRecord;
}

describe("collectNodeLiveProgress 配对", () => {
  it("task 全等匹配：running node ↔ running record，投影挂到 stepIndex", () => {
    const run = makeRunShape([{ stepIndex: 0, task: "调研 A", status: "running", startedAt: new Date(T0).toISOString() }]);
    const live = collectNodeLiveProgress(run, [makeSub({ totalTokens: 42 })]);
    expect(live.get(0)?.totalTokens).toBe(42);
  });

  it("多候选（parallel 同 prompt）取 startedAt 最近邻，贪心一一不重复消费", () => {
    const run = makeRunShape([
      { stepIndex: 0, task: "调研 A", status: "running", startedAt: new Date(T0).toISOString() },
      { stepIndex: 1, task: "调研 A", status: "running", startedAt: new Date(T0 + 5000).toISOString() },
    ]);
    const near0 = makeSub({ id: "sa-near0", startedAt: T0 + 10, totalTokens: 100 });
    const near1 = makeSub({ id: "sa-near1", startedAt: T0 + 5010, totalTokens: 200 });
    const live = collectNodeLiveProgress(run, [near1, near0]);
    expect(live.get(0)?.totalTokens).toBe(100); // node0(startedAt=T0) 最近 = near0
    expect(live.get(1)?.totalTokens).toBe(200); // node1(T0+5s) 最近 = near1
  });

  it("终态 node 不配对；task 不匹配（不同 prompt）不配对", () => {
    const run = makeRunShape([
      { stepIndex: 0, task: "调研 A", status: "completed", startedAt: new Date(T0).toISOString() },
      { stepIndex: 1, task: "写总结", status: "running", startedAt: new Date(T0).toISOString() },
    ]);
    const live = collectNodeLiveProgress(run, [makeSub({ task: "调研 A", totalTokens: 99 })]);
    expect(live.size).toBe(0); // node0 终态跳过；node1 task 不匹配
  });

  it("重试间隙（无 running record）→ 空 map（views 走终态 fallback 渲染）", () => {
    const run = makeRunShape([{ stepIndex: 0, task: "调研 A", status: "running", startedAt: new Date(T0).toISOString() }]);
    const live = collectNodeLiveProgress(run, [makeSub({ status: "closed" })]);
    expect(live.size).toBe(0);
  });
});
