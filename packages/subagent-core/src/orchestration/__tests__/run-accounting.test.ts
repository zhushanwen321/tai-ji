// src/orchestration/__tests__/run-accounting.test.ts
//
// [§2.1b] run 会计重建单源：帧推导（下界近似）+ 条目真值优先。
import { describe, expect, it } from "vitest";

import { Budget } from "../models/budget.ts";
import { rebuildBudget, runAccountingFromEvents } from "../run-accounting.ts";
import type { WorkflowRunEvent } from "../run-events.ts";

const settled = (
  taskIndex: number,
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: number } | undefined,
): Extract<WorkflowRunEvent, { type: "agent-settled" }> =>
  ({
    type: "agent-settled",
    taskIndex,
    attempt: 1,
    outcome: "done",
    durationMs: 1,
    ...(usage !== undefined ? { result: { content: "x", usage } } : {}),
    ts: 1,
  }) as never;

describe("runAccountingFromEvents（帧推导，下界近似）", () => {
  it("用 Budget 同一加权口径求和（input*1 + output*2 + cacheRead*0.02 + cacheWrite*0）", () => {
    const accounting = runAccountingFromEvents([
      settled(0, { input: 10, output: 20, cacheRead: 100, cacheWrite: 999 }),
      settled(1, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.5 }),
    ]);
    // 10*1 + 20*2 + 100*0.02 = 52；1 + 2 = 3 → 55
    expect(accounting.usedTokens).toBe(55);
    expect(accounting.usedCost).toBeCloseTo(0.5, 6);
    expect(accounting.callCount).toBe(2);
  });

  it("缺 usage 的 settled 帧计入 callCount 但不计消耗", () => {
    const accounting = runAccountingFromEvents([settled(0, undefined)]);
    expect(accounting).toEqual({ usedTokens: 0, usedCost: 0, callCount: 1 });
  });

  it("非 settled 帧不参与（agent-retrying 无 usage，属已知下界成因）", () => {
    const events = [
      { type: "agent-started", taskIndex: 0, agentName: "a", attempt: 1, ts: 1 },
      { type: "agent-retrying", taskIndex: 0, attempt: 2, backoffMs: 10, reason: "x", ts: 2 },
      settled(0, { input: 5, output: 0, cacheRead: 0, cacheWrite: 0 }),
    ] as unknown as WorkflowRunEvent[];
    expect(runAccountingFromEvents(events)).toEqual({ usedTokens: 5, usedCost: 0, callCount: 1 });
  });
});

describe("rebuildBudget（条目真值优先，帧推导兜底）", () => {
  const events = [settled(0, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })];

  it("条目带真值 → 用条目 usedTokens/callCount（usedCost 条目不存 → 0）", () => {
    const budget = rebuildBudget({ usedTokens: 1234, callCount: 7 }, events);
    expect(budget).toBeInstanceOf(Budget);
    expect(budget.usedTokens).toBe(1234);
    expect(budget.totalCallCount).toBe(7);
    expect(budget.usedCost).toBe(0);
  });

  it("条目缺席或零值 → 帧推导（含 usedCost）", () => {
    expect(rebuildBudget(undefined, events).usedTokens).toBe(3);
    expect(rebuildBudget({ usedTokens: 0, callCount: 0 }, events).usedTokens).toBe(3);
  });

  it("maxTimeMs 只在 > 0 时落字段（与 fresh/resume 同款条件式）", () => {
    expect(rebuildBudget(undefined, events, 5000).maxTimeMs).toBe(5000);
    expect(rebuildBudget(undefined, events, 0).maxTimeMs).toBeUndefined();
    expect(rebuildBudget(undefined, events).maxTimeMs).toBeUndefined();
  });
});
