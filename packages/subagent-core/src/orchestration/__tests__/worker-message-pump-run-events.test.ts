// src/orchestration/__tests__/worker-message-pump-run-events.test.ts
//
// [P1b-1] run 事件状态机生产链接线测试（worker-message-pump 状态机接线段）。
//
// 锁四面：
// 1. finalizeRun = run-settled 事件终态单写点：completed/failed/aborted 三 doneReason
//    路径的 journal 终局帧（aborted 经 cancel-requested 控制事件 → 输出执行侧合成
//    run-settled(cancelled)——journal 词表恰无 cancel-requested 帧）。
// 2. 终局后让位：并发终态化（抢先 transition）→ finalizeRun 让位返回 false，journal
//    零追加（M12 语义 + 单写者纪律）。
// 3. dispatchAgentCall 的 ask 事件链：ask-dispatched（派发时）+ ask-settled(completed，
//    完成回调时)——taskIndex = callId 单源、attempt = call.attempts。
// 4. journal 目录测试注入（setRunEventJournalDirForTest + mkdtemp 自建自删，测试红线：
//    不触真实数据目录）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  finalizeRun,
  handleWorkerMessage,
  setRunEventJournalDirForTest,
} from "../worker-message-pump.ts";
import { createRunEventJournal } from "../run-events.ts";
import { Budget } from "../models/budget.ts";
import { RunRuntime } from "../models/run-runtime.ts";
import { Trace } from "../models/trace.ts";
import type { AgentResult } from "../models/types.ts";
import { WorkflowRun } from "../models/workflow-run.ts";
import type { LifecycleDeps, WorkerHandlers } from "../models/ports.ts";
import type { WorkerHandle } from "../worker-handle.ts";

// ── helpers ──────────────────────────────────────────────────

let journalDir: string;

beforeEach(() => {
  journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "pump-run-events-"));
  setRunEventJournalDirForTest(journalDir);
});

afterEach(() => {
  setRunEventJournalDirForTest(undefined);
  fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function scanRunEvents(runId: string) {
  return createRunEventJournal(journalDir).scan(runId);
}

/** 构造真实 WorkflowRun（真实状态机 transition）。 */
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

/** deps mock（形态对齐 worker-message-pump-finalize-run.test.ts）。 */
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

/** 排空微任务队列（void fire 的 async 投递链推进到稳定态）。 */
async function flushMicrotasks(ticks = 20): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    // eslint-disable-next-line no-await-in-loop -- 排空微任务队列的固定 tick 循环，非逐项等待
    await Promise.resolve();
  }
}

// ── 1. finalizeRun = run-settled 终态单写点 ──────────────────

describe("finalizeRun 落 run-settled（终态单写点）", () => {
  it("completed → journal 终帧 run-settled(completed)（含 created 引导首帧）", async () => {
    const run = makeRealRun("wf-ev-1");
    const deps = makeDeps();

    const ok = await finalizeRun(run, deps, "completed", { context: "test" });

    expect(ok).toBe(true);
    const events = await scanRunEvents("wf-ev-1");
    // 零 ask run：created 引导补投 run-created + run-settled
    expect(events.map((e) => e.type)).toEqual(["run-created", "run-settled"]);
    expect(events[1]).toMatchObject({ type: "run-settled", outcome: "completed" });
  });

  it("failed → run-settled(failed)，reason 承载诊断文本", async () => {
    const run = makeRealRun("wf-ev-2");
    run.state.error = "Workflow failed after 3 retries: boom";
    const deps = makeDeps();

    await finalizeRun(run, deps, "failed", { context: "test" });

    const events = await scanRunEvents("wf-ev-2");
    expect(events.at(-1)).toMatchObject({
      type: "run-settled",
      outcome: "failed",
      reason: "Workflow failed after 3 retries: boom",
    });
  });

  it("aborted → cancel-requested 控制事件 → 合成 run-settled(cancelled)（控制事件本身不落 journal）", async () => {
    const run = makeRealRun("wf-ev-3");
    const deps = makeDeps();

    await finalizeRun(run, deps, "aborted", { context: "abortRun" });

    const events = await scanRunEvents("wf-ev-3");
    expect(events.map((e) => e.type)).toEqual(["run-created", "run-settled"]);
    expect(events[1]).toMatchObject({ type: "run-settled", outcome: "cancelled" });
  });

  it("budget_limited（六因）→ outcome 映射 failed", async () => {
    const run = makeRealRun("wf-ev-4");
    const deps = makeDeps();

    await finalizeRun(run, deps, "budget_limited", { context: "test" });

    const events = await scanRunEvents("wf-ev-4");
    expect(events.at(-1)).toMatchObject({ type: "run-settled", outcome: "failed" });
  });

  it("并发终态化让位（抢先 transition）→ 返回 false + journal 零追加（单写者纪律）", async () => {
    const run = makeRealRun("wf-ev-5");
    run.transition("done", "aborted"); // 抢先方终态化
    const deps = makeDeps();

    const ok = await finalizeRun(run, deps, "failed", { context: "test" });

    expect(ok).toBe(false);
    const events = await scanRunEvents("wf-ev-5");
    expect(events).toHaveLength(0); // 让位路径不落任何帧
  });
});

// ── 2. dispatchAgentCall 的 ask 事件链 ───────────────────────

describe("dispatchAgentCall 落 ask 事件（dispatched + settled）", () => {
  it("agent-call 派发 → ask-dispatched；完成 → ask-settled(completed, attempt=1)", async () => {
    const run = makeRealRun("wf-ev-6");
    const deps = makeDeps();
    deps.runner.run = vi.fn(async () =>
      ({ content: "ok", durationMs: 7, toolCalls: [] }) as AgentResult,
    );
    const handlers: WorkerHandlers = {
      onMessage: vi.fn(async () => {}),
      onError: vi.fn(async () => {}),
      onExit: vi.fn(async () => {}),
    };

    await handleWorkerMessage(
      run,
      { type: "agent-call", callId: 3, opts: { prompt: "p", description: "reviewer" } },
      deps,
      handlers,
    );
    await flushMicrotasks();

    expect(run.state.status).toBe("running"); // 正常完成不触发终局
    const events = await scanRunEvents("wf-ev-6");
    expect(events.map((e) => e.type)).toEqual(["run-created", "ask-dispatched", "ask-settled"]);
    expect(events[1]).toMatchObject({ taskIndex: 3, agentName: "reviewer", attempt: 1 });
    expect(events[2]).toMatchObject({
      taskIndex: 3,
      attempt: 1,
      outcome: "completed",
      durationMs: 7,
    });
  });
  it("终局后再到达的 call 完成 → stale 守卫拦截，journal 零追加（terminal 后停止 append）", async () => {
    const run = makeRealRun("wf-ev-7");
    const deps = makeDeps();
    deps.runner.run = vi.fn(async () => {
      // runner 执行窗内 run 被终态化（模拟 abort 竞态）
      run.transition("done", "aborted");
      return { content: "late", durationMs: 1, toolCalls: [] } as AgentResult;
    });
    const handlers: WorkerHandlers = {
      onMessage: vi.fn(async () => {}),
      onError: vi.fn(async () => {}),
      onExit: vi.fn(async () => {}),
    };

    await handleWorkerMessage(
      run,
      { type: "agent-call", callId: 1, opts: { prompt: "p" } },
      deps,
      handlers,
    );
    await flushMicrotasks();

    const events = await scanRunEvents("wf-ev-7");
    // 终局帧存在（runner 内抢先 finalizeRun 不发生——本用例只 transition 不 finalize，
    // journal 无 run-settled；核心断言 = 无 ask-settled 迟到帧）
    expect(events.some((e) => e.type === "ask-settled")).toBe(false);
  });
});
