// src/execution/__tests__/pending-workflow-notify-loop.test.ts
//
// [P4 / D7] run 级 pending register/unregister 闭环单测（impl-plan P4 验收条款 b）。
//
// 闭环两端（同一 runId 流过）：
//   - register：runWorkflow（run 创建处，orchestration/lifecycle.ts）经 deps.eventBus
//     emit "pending:register"（id=runId、type=workflow、name 回退链 slug→scriptName→runId）
//     —— pending-notifications 扩展 listener 消费后 appendEntry 落盘（扩展侧自测，
//     本文件断言发射载荷契约）；
//   - unregister：finalizeRun（终态序列唯一定义点，orchestration/worker-message-pump.ts）
//     直落 appendEntry "pending:unregister"（id=runId、reason=DoneReason、status 经
//     protocol mapReasonToStatus 映射——completed/failed/aborted 逐一锁定，
//     budget_limited→failed 的非 identity 映射单独锁定。注意 run 域取消的 DoneReason
//     是 aborted，protocol 权威映射为 status 'aborted'（pending 词表独立态，非
//     cancelled）——journal 面的 outcome cancelled（D5 run-settled）与 pending status
//     面的 'aborted' 是两域词表，映射权威在 extension-protocol 单点）。
//
// 测试防线路径：finalizeRun 内部 run-settled journal 投递在 vitest 环境无
// setRunEventJournalDirForTest 注入时自动落 no-op journal（不触真实数据目录，
// worker-message-pump.ts resolveRunEventJournal 的 VITEST 防线）。
import { describe, expect, it, vi } from "vitest";

import { runWorkflow } from "../../orchestration/lifecycle.ts";
import { RunRuntime } from "../../orchestration/models/run-runtime.ts";
import { Trace } from "../../orchestration/models/trace.ts";
import { Budget } from "../../orchestration/models/budget.ts";
import type { RunSpec } from "../../orchestration/models/run-spec.ts";
import type { LifecycleDeps } from "../../orchestration/models/ports.ts";
import type { WorkerHandle } from "../../orchestration/worker-handle.ts";
import { finalizeRun } from "../../orchestration/worker-message-pump.ts";
import { WorkflowRun } from "../../orchestration/models/workflow-run.ts";

// ── harness ──────────────────────────────────────────────────

function makeSpec(): RunSpec {
  return {
    scriptSource: "execute() {}",
    args: {},
    scriptName: "test-wf",
    scriptPath: "/fake/test.js",
  } as RunSpec;
}

/** runWorkflow 用 deps mock（eventBus.emit 可观察 = register 发射面）。 */
function makeLauncherDeps(): LifecycleDeps & {
  runs: Map<string, WorkflowRun>;
  eventBus: { emit: ReturnType<typeof vi.fn> };
} {
  return {
    store: { save: vi.fn(async () => {}) },
    workerHost: { start: vi.fn(() => ({ postMessage: vi.fn(), terminate: vi.fn(async () => {}) })) },
    runner: { run: vi.fn(async () => ({})) },
    runs: new Map(),
    eventBus: { emit: vi.fn() },
    log: vi.fn(),
  } as unknown as ReturnType<typeof makeLauncherDeps>;
}

/** 构造真实 WorkflowRun（真实状态机）+ runtime（finalizeRun 直测输入）。 */
function makeRealRun(runId: string): WorkflowRun {
  const run = new WorkflowRun(
    runId,
    {
      scriptName: "test-wf",
      scriptSource: "agent('hi')",
      args: {},
      scriptPath: "/tmp/test-wf.js",
    },
    {
      status: "running",
      budget: new Budget(),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
    },
    { startedAt: new Date().toISOString() },
  );
  const worker = {
    postMessage: vi.fn(),
    terminate: vi.fn(async () => {}),
  } as unknown as WorkerHandle;
  run.assignRuntime(new RunRuntime(worker, new AbortController()));
  return run;
}

/** finalizeRun 用 deps mock（appendEntry 可观察 = unregister 直落面）。 */
function makeFinalizeDeps(): LifecycleDeps & {
  appendEntry: ReturnType<typeof vi.fn>;
  onRunDone: ReturnType<typeof vi.fn>;
} {
  return {
    store: { save: vi.fn(async () => {}) },
    workerHost: { start: vi.fn(() => ({ postMessage: vi.fn() })) },
    runner: { run: vi.fn(async () => ({})) },
    runs: new Map(),
    appendEntry: vi.fn(),
    eventBus: { emit: vi.fn() },
    onRunDone: vi.fn(),
    log: vi.fn(),
  } as unknown as ReturnType<typeof makeFinalizeDeps>;
}

/** deps.appendEntry 收到的 pending:unregister 落盘形态。 */
function appendedUnregister(deps: ReturnType<typeof makeFinalizeDeps>): {
  id: string;
  reason: string;
  status: string;
} | undefined {
  const call = deps.appendEntry.mock.calls.find((c) => c[0] === "pending:unregister");
  if (!call) return undefined;
  const data = call[1] as { id: string; reason: string; status: string };
  return { id: data.id, reason: data.reason, status: data.status };
}

// ── 闭环 ─────────────────────────────────────────────────────

describe("run 级 pending register/unregister 闭环（D7）", () => {
  it("register 发射载荷（runWorkflow，run 创建处）：id=runId、type=workflow、name 回退链", async () => {
    const deps = makeLauncherDeps();
    const spec = makeSpec();

    const runId = await runWorkflow(spec, deps);

    expect(deps.eventBus.emit).toHaveBeenCalledTimes(1);
    expect(deps.eventBus.emit).toHaveBeenCalledWith("pending:register", {
      id: runId,
      type: "workflow",
      name: "test-wf",
    });
  });

  it("闭环配对：同一 runId 走 register（创建）与 unregister 直落（终局），两端 id 同源", async () => {
    const launcherDeps = makeLauncherDeps();
    const runId = await runWorkflow(makeSpec(), launcherDeps);
    const registerCall = launcherDeps.eventBus.emit.mock.calls[0]?.[1] as { id: string };

    const run = launcherDeps.runs.get(runId)!;
    const finalizeDeps = makeFinalizeDeps();
    const transitioned = await finalizeRun(run, finalizeDeps, "completed", { context: "loop-test" });

    expect(transitioned).toBe(true);
    const unregister = appendedUnregister(finalizeDeps);
    // 配对键：register.id === unregister.id === runId（主 agent 查询面同一注册条目的
    // 生命周期两端）
    expect(registerCall.id).toBe(runId);
    expect(unregister).toEqual({ id: runId, reason: "completed", status: "completed" });
  });

  it("status 映射：failed→failed、aborted→aborted（各恰好一条 unregister）", async () => {
    for (const [doneReason, expectedStatus] of [
      ["failed", "failed"],
      ["aborted", "aborted"],
    ] as const) {
      const run = makeRealRun(`wf-loop-${doneReason}`);
      const deps = makeFinalizeDeps();
      await finalizeRun(run, deps, doneReason, { context: `loop-test-${doneReason}` });
      const unregister = appendedUnregister(deps);
      expect(unregister).toEqual({
        id: `wf-loop-${doneReason}`,
        reason: doneReason,
        status: expectedStatus,
      });
      // 终局通知恰好随注销成对触发（一个 run 恰好一个终局，无双语义事件）
      expect(deps.onRunDone).toHaveBeenCalledTimes(1);
    }
  });

  it("status 非 identity 映射锁定：budget_limited → failed（词表外落值防线）", async () => {
    const run = makeRealRun("wf-loop-budget");
    const deps = makeFinalizeDeps();
    await finalizeRun(run, deps, "budget_limited", { context: "loop-test-budget" });
    expect(appendedUnregister(deps)).toEqual({
      id: "wf-loop-budget",
      reason: "budget_limited",
      status: "failed",
    });
  });
});
