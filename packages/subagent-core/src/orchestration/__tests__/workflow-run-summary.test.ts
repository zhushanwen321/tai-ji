// workflow-run-summary.test.ts —— runSummary 投影测试（U7/B5/D8）。
//
// 覆盖（验收条款③）：
// - runSummary：字段投影全断言（running / done 两形态；slug/error/completedAt 缺省透传）
import { describe, expect, it } from "vitest";

import { runSummary } from "../workflow-run-summary.ts";
import { doneReasonToRunOutcome } from "../run-events.ts";
import { noteRebuiltSettlement } from "../terminal-actions.ts";
import { Budget } from "../models/budget.ts";
import type { RunSpec } from "../models/run-spec.ts";
import { Trace } from "../models/trace.ts";
import { WorkflowRun } from "../models/workflow-run.ts";

function makeSpec(scriptName: string, slug?: string): RunSpec {
  return {
    scriptSource: "async function execute() {}",
    args: {},
    scriptName,
    ...(slug !== undefined ? { slug } : {}),
    scriptPath: "/fake/test.js",
  };
}

function makeRun(
  runId: string,
  opts: {
    /** fixture 建模选择器：done = 重水合终局 run（同步注入注册表条目 + reason）。 */
    status?: "running" | "done";
    scriptName?: string;
    slug?: string;
    reason?: "completed" | "failed" | "aborted" | "time_limited";
    error?: string;
    startedAt?: string;
    completedAt?: string;
    interruptedAt?: string;
  } = {},
): WorkflowRun {
  const status = opts.status ?? "running";
  const run = WorkflowRun.reconstruct(
    runId,
    makeSpec(opts.scriptName ?? "deploy-site", opts.slug),
    {
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
      ...(opts.interruptedAt !== undefined ? { interruptedAt: opts.interruptedAt } : {}),
    },
  );
  // [D6(a) 第 1 步] 终局判定源 = 终局记录注册表：done 形态 fixture 建模「重水合
  // done run」时必须携带注册表条目（生产 = 壳重建点 noteRebuiltSettlement 注入），
  // settledAt = 快照 completedAt（重水合 run 的条目 = run-settled 帧时序）。
  if (status === "done") {
    noteRebuiltSettlement(runId, {
      outcome: doneReasonToRunOutcome(opts.reason ?? "completed"),
      settledAt: opts.completedAt !== undefined ? Date.parse(opts.completedAt) : 0,
    });
  }
  return run;
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

  it("interrupted run（meta.interruptedAt 置位）：status 投影 'interrupted'——中断态经 meta 在投影面表达", () => {
    // [U10 回归] 重水合中断 run（loadAll fold / 收编链写 meta.interruptedAt）在
    // CLI/TUI 展示投影三态：不再显示僵尸「运行中」（与 shared WorkflowRunStatus
    // 三态、场景 25 中断显示语义同词）。resume 资格判据在 core fold lifecycle，
    // 不受本投影影响。
    const run = makeRun("wf-i1", { status: "running", interruptedAt: "2026-08-30T05:00:00.000Z" });

    expect(runSummary(run).status).toBe("interrupted");
    // 终局优先于中断标记（settled/done → done——中断标记不遮蔽终局）
    const settledRun = makeRun("wf-i2", { status: "done", reason: "failed", interruptedAt: "2026-08-30T05:00:00.000Z" });
    expect(runSummary(settledRun).status).toBe("done");
  });
});

