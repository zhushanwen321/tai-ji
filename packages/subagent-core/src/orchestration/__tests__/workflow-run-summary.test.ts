// workflow-run-summary.test.ts —— runSummary 投影测试（U7/B5/D8）。
//
// 覆盖（验收条款③）：
// - runSummary：字段投影全断言（running / done 两形态；slug/error/completedAt 缺省透传）
import { describe, expect, it } from "vitest";

import { runSummary } from "../workflow-run-summary.ts";
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

