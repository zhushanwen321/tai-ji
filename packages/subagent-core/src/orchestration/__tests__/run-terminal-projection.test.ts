// src/orchestration/__tests__/run-terminal-projection.test.ts
//
// [P1b-2] manifest-write 输出动作执行实装单测（D5-④ 终态投影）。
//
// 锁四面（P1 验收条款 a：终态写读经 dispatchRunTrigger 真实终局转移链驱动，
// 非直写构造）：
// 1. 终局转移链 → manifest（<runId>.json）+ .state（<runId>.jsonl.state）双面落
//    outcome/errorCode，三形态写读一致（成功=completed、失败=failed+errorCode、
//    取消=cancelled——取消经 cancel-requested 控制事件合成路径）。
// 2. errorCode 载荷溯源：errorCode 只来自 run-settled 事件载荷（cancel 合成路径
//    无结构化码——manifest/.state 均不落 errorCode 键）。
// 3. 投影时机：终局转移前的中间态零投影（manifest 文件不存在），转移后恰一次。
// 4. 投影失败不阻断终局（journal 侧断言独立成立——coda 权威面与取证面分离）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  dispatchRunCreated,
  dispatchRunTrigger,
  finalizeRun,
  setRunEventJournalDirForTest,
} from "../worker-message-pump.ts";
import { createRunEventJournal } from "../run-events.ts";
import { readRunTerminalManifest } from "../../execution/persistence/manifest-store.ts";
import { readStateMarker } from "../../execution/persistence/state-marker.ts";
import { AgentCall } from "../models/agent-call.ts";
import { WorkflowRun } from "../models/workflow-run.ts";
import { RunRuntime } from "../models/run-runtime.ts";
import { Budget } from "../models/budget.ts";
import { Trace } from "../models/trace.ts";
import type { AgentResult, ExecutionTraceNode } from "../models/types.ts";
import type { LifecycleDeps } from "../models/ports.ts";
import type { WorkerHandle } from "../worker-handle.ts";

let projectionDir: string;

beforeEach(() => {
  projectionDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-terminal-projection-"));
  // journal / manifest / .state 同目录（resolveRunEventJournal 同源解析）——
  // setRunEventJournalDirForTest 一次注入覆盖三面。
  setRunEventJournalDirForTest(projectionDir);
});

afterEach(() => {
  setRunEventJournalDirForTest(undefined);
  fs.rmSync(projectionDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** 构造真实 WorkflowRun（spec/args 可控——created 引导补投的载荷源）。 */
function makeRun(runId: string): WorkflowRun {
  const run = new WorkflowRun(
    runId,
    {
      scriptName: "review-fix-loop",
      scriptSource: "agent('hi')",
      args: { pr: 42 },
      scriptPath: "/tmp/review-fix-loop.js",
      model: "test-model",
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
    postMessage: () => {},
    terminate: async () => {},
  } as unknown as WorkerHandle;
  run.assignRuntime(new RunRuntime(worker, new AbortController()));
  return run;
}

// ── 1. 终局转移链 → 双面投影三形态（验收 a） ─────────────────

describe("终态写读三形态（验收 a：manifest/.state 经真实转移链）", () => {
  it("成功 = completed：run-settled(completed) → manifest + .state 双面落 outcome", async () => {
    const run = makeRun("wf-proj-ok");
    await dispatchRunCreated(run); // [Q2] 正点发射（P1b-1 created 引导已删除）
    await dispatchRunTrigger(run, {
      type: "run-settled",
      outcome: "completed",
      artifactsDir: projectionDir,
      ts: Date.now(),
    });

    const manifest = await readRunTerminalManifest(projectionDir, run.runId);
    expect(manifest).toMatchObject({
      id: run.runId,
      workflowName: "review-fix-loop",
      outcome: "completed",
    });
    expect(manifest).not.toHaveProperty("errorCode");

    const marker = readStateMarker(path.join(projectionDir, `${run.runId}.jsonl`));
    expect(marker).toMatchObject({ status: "idle", outcome: "completed" });
    expect(marker).not.toHaveProperty("errorCode");
  });

  it("失败 = failed + errorCode：run-settled(failed, engine_crashed) → 双面落 errorCode", async () => {
    const run = makeRun("wf-proj-fail");
    await dispatchRunCreated(run);
    await dispatchRunTrigger(run, {
      type: "run-settled",
      outcome: "failed",
      errorCode: "engine_crashed",
      reason: "worker died 3 times",
      artifactsDir: projectionDir,
      ts: Date.now(),
    });

    const manifest = await readRunTerminalManifest(projectionDir, run.runId);
    expect(manifest).toMatchObject({ outcome: "failed", errorCode: "engine_crashed" });

    const marker = readStateMarker(path.join(projectionDir, `${run.runId}.jsonl`));
    expect(marker).toMatchObject({ status: "idle", outcome: "failed", errorCode: "engine_crashed" });
  });

  it("取消 = cancelled：cancel-requested 控制事件合成路径（无 errorCode 键）", async () => {
    const run = makeRun("wf-proj-cancel");
    await dispatchRunCreated(run);
    await dispatchRunTrigger(run, {
      type: "ask-dispatched",
      taskIndex: 1,
      agentName: "a",
      attempt: 1,
      ts: Date.now(),
    });
    await dispatchRunTrigger(run, { type: "cancel-requested", reason: "user abort" });

    const manifest = await readRunTerminalManifest(projectionDir, run.runId);
    expect(manifest).toMatchObject({ id: run.runId, outcome: "cancelled" });
    expect(manifest).not.toHaveProperty("errorCode");

    const marker = readStateMarker(path.join(projectionDir, `${run.runId}.jsonl`));
    expect(marker).toMatchObject({ status: "idle", outcome: "cancelled" });
    expect(marker).not.toHaveProperty("errorCode");
  });
});

// ── 2. errorCode 载荷溯源 ────────────────────────────────────

describe("errorCode 只溯源 run-settled 载荷", () => {
  it("completed 终局带 errorCode 载荷位但无值 → 投影不落 errorCode 键", async () => {
    const run = makeRun("wf-proj-ok-noerr");
    await dispatchRunCreated(run);
    await dispatchRunTrigger(run, {
      type: "run-settled",
      outcome: "completed",
      artifactsDir: projectionDir,
      ts: Date.now(),
    });

    expect(await readRunTerminalManifest(projectionDir, run.runId)).not.toHaveProperty("errorCode");
  });
});

// ── 3. 投影时机（中间态零投影） ──────────────────────────────

describe("投影时机（终局前的中间态零投影）", () => {
  it("run-created / ask 链中间态不写 manifest；终局转移后恰一次", async () => {
    const run = makeRun("wf-proj-timing");
    await dispatchRunCreated(run);
    await dispatchRunTrigger(run, {
      type: "ask-dispatched",
      taskIndex: 1,
      agentName: "a",
      attempt: 1,
      ts: Date.now(),
    });
    expect(fs.existsSync(path.join(projectionDir, `${run.runId}.json`))).toBe(false);

    await dispatchRunTrigger(run, {
      type: "run-settled",
      outcome: "completed",
      artifactsDir: projectionDir,
      ts: Date.now(),
    });
    expect(await readRunTerminalManifest(projectionDir, run.runId)).not.toBeNull();

    // terminal 后再投递 = IllegalTransitionError 让位，投影不被重写（状态不变量）
    await expect(
      dispatchRunTrigger(run, {
        type: "ask-settled",
        taskIndex: 1,
        attempt: 1,
        outcome: "failed",
        durationMs: 1,
        ts: Date.now(),
      }),
    ).rejects.toThrow(/terminal/);
    expect(await readRunTerminalManifest(projectionDir, run.runId)).toMatchObject({
      outcome: "completed",
    });
  });
});

// ── 4. journal 与投影独立（取证面与投影面分离） ──────────────

describe("投影与 journal 共存（同目录不同文件）", () => {
  it("终局后 journal 含 run-settled 帧 + manifest/.state 落投影（互不干扰）", async () => {
    const run = makeRun("wf-proj-coexist");
    await dispatchRunCreated(run);
    await dispatchRunTrigger(run, {
      type: "run-settled",
      outcome: "failed",
      errorCode: "engine_crashed",
      artifactsDir: projectionDir,
      ts: Date.now(),
    });

    const events = await createRunEventJournal(projectionDir).scan(run.runId);
    expect(events.map((e) => e.type)).toEqual(["run-created", "run-settled"]);
    expect(await readRunTerminalManifest(projectionDir, run.runId)).toMatchObject({
      outcome: "failed",
    });
    // 目录四面文件齐备：journal / .state（挂 state 文件 stem——基底 .jsonl 由
    // store.save 写，dispatch 链不产出）/ manifest
    const names = fs.readdirSync(projectionDir).sort();
    expect(names).toContain(`${run.runId}.events.jsonl`);
    expect(names).toContain(`${run.runId}.jsonl.state`);
    expect(names).toContain(`${run.runId}.json`);
  });
});

// ── 5. 生产链（finalizeRun → dispatchFinalRunSettle 构造 errorCode → 投影） ──

/** deps mock（形态对齐 worker-message-pump-run-events.test.ts）。 */
function makeDeps(): LifecycleDeps {
  return {
    store: { save: vi.fn(async () => {}) },
    workerHost: { start: vi.fn(() => ({ postMessage: vi.fn() })) },
    runner: { run: vi.fn(async () => ({}) as AgentResult) },
    runs: new Map(),
    appendEntry: vi.fn(),
    eventBus: { emit: vi.fn() },
    onRunDone: vi.fn(),
    log: vi.fn(),
  } as unknown as LifecycleDeps;
}

/** 构造已终局的 AgentCall（markRunning → markDone，对齐 executeAgentCall finalize 形态）。 */
function makeSettledCall(callId: number, result: AgentResult): AgentCall {
  const node: ExecutionTraceNode = {
    stepIndex: callId,
    agent: "reviewer",
    task: "p",
    model: "test-model",
    status: "running",
    startedAt: new Date().toISOString(),
  };
  const call = new AgentCall(callId, { prompt: "p" }, node);
  call.markRunning();
  call.markDone(result);
  return call;
}

describe("生产链 errorCode 投影（finalizeRun 构造 → manifest/.state，S2 死亡可诊断）", () => {
  it("engine_crashed 终局 → manifest{outcome:failed, errorCode:engine_crashed}（journal 终帧同源）", async () => {
    const run = makeRun("wf-prod-ec");
    await dispatchRunCreated(run);
    run.state.calls.set(0, makeSettledCall(0, {
      content: "",
      error: "engine_crashed: engine process exited unexpectedly: signal SIGKILL. stderr tail: fake",
      durationMs: 21_000,
      toolCalls: [],
    }));
    run.state.error =
      "Workflow failed after 3 retries: ask-1 failed after retries: engine_crashed: engine process exited unexpectedly: signal SIGKILL";
    const deps = makeDeps();

    const ok = await finalizeRun(run, deps, "failed", { context: "test" });
    expect(ok).toBe(true);

    const manifest = await readRunTerminalManifest(projectionDir, run.runId);
    expect(manifest).toMatchObject({ id: run.runId, outcome: "failed", errorCode: "engine_crashed" });
    const marker = readStateMarker(path.join(projectionDir, `${run.runId}.jsonl`));
    expect(marker).toMatchObject({ status: "idle", outcome: "failed", errorCode: "engine_crashed" });
    // journal 终局帧与 manifest 同源（同一 run-settled 载荷）
    const events = await createRunEventJournal(projectionDir).scan(run.runId);
    expect(events.at(-1)).toMatchObject({ type: "run-settled", outcome: "failed", errorCode: "engine_crashed" });
  });

  it("budget_limited / time_limited 终局 → manifest 落对应 run 级终局码", async () => {
    for (const reason of ["budget_limited", "time_limited"] as const) {
      const run = makeRun(`wf-prod-${reason}`);
      await dispatchRunCreated(run);
      const deps = makeDeps();

      await finalizeRun(run, deps, reason, { context: "test" });

      const manifest = await readRunTerminalManifest(projectionDir, run.runId);
      expect(manifest).toMatchObject({ outcome: "failed", errorCode: reason });
    }
  });
});
