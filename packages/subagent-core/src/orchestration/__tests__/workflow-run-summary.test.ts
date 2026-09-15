// workflow-run-summary.test.ts —— runSummary 投影 + isScriptRunning 判定测试（U7/B5/D8）。
//
// 覆盖（验收条款③）：
// - runSummary：字段投影全断言（running / done 两形态；slug/error/completedAt 缺省透传）
// - isScriptRunning：真（同名 running）/ 假（同名 done、异名 running、空 Map）两分支
import { describe, expect, it } from "vitest";

import { isScriptRunning, runSummary } from "../workflow-run-summary.ts";
import { Budget } from "../models/budget.ts";
import type { RunSpec } from "../models/run-spec.ts";
import { Trace } from "../models/trace.ts";
import { WorkflowRun } from "../models/workflow-run.ts";

function makeSpec(scriptName: string, slug?: string): RunSpec {
  return {
    scriptSource: "execute() {}",
    args: {},
    scriptName,
    ...(slug !== undefined ? { slug } : {}),
    scriptPath: "/fake/test.js",
  };
}

function makeRun(
  runId: string,
  opts: {
    status?: "running" | "done";
    scriptName?: string;
    slug?: string;
    reason?: "completed" | "failed" | "aborted" | "time_limited";
    error?: string;
    startedAt?: string;
    completedAt?: string;
  } = {},
): WorkflowRun {
  const status = opts.status ?? "running";
  return WorkflowRun.reconstruct(
    runId,
    makeSpec(opts.scriptName ?? "deploy-site", opts.slug),
    {
      status,
      ...(status === "done" ? { reason: opts.reason ?? "completed" } : {}),
      budget: new Budget({ maxTokens: 1000 }),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
      ...(opts.error !== undefined ? { error: opts.error } : {}),
    },
    {
      startedAt: opts.startedAt ?? "2026-08-30T00:00:00.000Z",
      ...(opts.completedAt !== undefined ? { completedAt: opts.completedAt } : {}),
    },
  );
}

describe("runSummary — 字段投影（字段以 core WorkflowRun 为准）", () => {
  it("running run：name=scriptName、slug、status、startedAt 投影；completedAt/reason 为 undefined", () => {
    const run = makeRun("wf-r1", { status: "running", scriptName: "deploy-site", slug: "deploy" });

    expect(runSummary(run)).toEqual({
      runId: "wf-r1",
      name: "deploy-site",
      slug: "deploy",
      status: "running",
      reason: undefined,
      startedAt: "2026-08-30T00:00:00.000Z",
      completedAt: undefined,
      error: undefined,
    });
  });

  it("done run：reason/completedAt/error 投影（对齐 pi toRunSummary 字段集）", () => {
    const run = makeRun("wf-d1", {
      status: "done",
      reason: "failed",
      error: "agent timeout",
      startedAt: "2026-08-30T10:00:00.000Z",
      completedAt: "2026-08-30T10:05:00.000Z",
    });

    expect(runSummary(run)).toEqual({
      runId: "wf-d1",
      name: "deploy-site",
      slug: undefined,
      status: "done",
      reason: "failed",
      startedAt: "2026-08-30T10:00:00.000Z",
      completedAt: "2026-08-30T10:05:00.000Z",
      error: "agent timeout",
    });
  });
});

describe("isScriptRunning — 真假两分支", () => {
  it("真：同名 script 仍在 running", () => {
    const runs = new Map<string, WorkflowRun>([
      ["wf-1", makeRun("wf-1", { status: "done", scriptName: "other-wf" })],
      ["wf-2", makeRun("wf-2", { status: "running", scriptName: "deploy-site" })],
    ]);

    expect(isScriptRunning(runs, "deploy-site")).toBe(true);
  });

  it("假：同名但已 done（running 状态白名单）", () => {
    const runs = new Map<string, WorkflowRun>([
      ["wf-1", makeRun("wf-1", { status: "done", scriptName: "deploy-site" })],
    ]);

    expect(isScriptRunning(runs, "deploy-site")).toBe(false);
  });

  it("假：异名 running / 空 Map", () => {
    const runs = new Map<string, WorkflowRun>([
      ["wf-1", makeRun("wf-1", { status: "running", scriptName: "other-wf" })],
    ]);
    expect(isScriptRunning(runs, "deploy-site")).toBe(false);
    expect(isScriptRunning(new Map(), "deploy-site")).toBe(false);
  });
});
