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
// 5. [Q2] run-created 正点接线（P1b-1 引导补投已删除）：正点发射无双帧 + 无首帧时
//    事件触发表外转移 fail-fast（不静默补齐）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  dispatchRunCreated,
  dispatchRunTrigger,
  finalizeRun,
  handleWorkerMessage,
  setRunEventJournalDirForTest,
} from "../worker-message-pump.ts";
import { createRunEventJournal } from "../run-events.ts";
import { AgentCall } from "../models/agent-call.ts";
import { Budget } from "../models/budget.ts";
import { RunRuntime } from "../models/run-runtime.ts";
import { Trace } from "../models/trace.ts";
import type { AgentResult, ExecutionTraceNode } from "../models/types.ts";
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

/** 构造已终局的 AgentCall（markRunning → markDone——对齐 executeAgentCall 的 finalize 形态，
 *  同 stderr-tee-diagnostic-reference.test.ts 助手）。 */
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

// ── 1. finalizeRun = run-settled 终态单写点 ──────────────────

describe("finalizeRun 落 run-settled（终态单写点）", () => {
  it("completed → journal 终帧 run-settled(completed)（正点 run-created 首帧）", async () => {
    const run = makeRealRun("wf-ev-1");
    const deps = makeDeps();
    await dispatchRunCreated(run); // [Q2] 正点发射（P1b-1 created 引导已删除）

    const ok = await finalizeRun(run, deps, "completed", { context: "test" });

    expect(ok).toBe(true);
    const events = await scanRunEvents("wf-ev-1");
    // 零 ask run：正点 run-created + run-settled
    expect(events.map((e) => e.type)).toEqual(["run-created", "run-settled"]);
    expect(events[1]).toMatchObject({ type: "run-settled", outcome: "completed" });
  });

  it("failed → run-settled(failed)，reason 承载诊断文本", async () => {
    const run = makeRealRun("wf-ev-2");
    await dispatchRunCreated(run);
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
    await dispatchRunCreated(run);
    const deps = makeDeps();

    await finalizeRun(run, deps, "aborted", { context: "abortRun" });

    const events = await scanRunEvents("wf-ev-3");
    expect(events.map((e) => e.type)).toEqual(["run-created", "run-settled"]);
    expect(events[1]).toMatchObject({ type: "run-settled", outcome: "cancelled" });
  });

  it("budget_limited（六因）→ outcome 映射 failed", async () => {
    const run = makeRealRun("wf-ev-4");
    await dispatchRunCreated(run);
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
    await dispatchRunCreated(run);
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
    await dispatchRunCreated(run);
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

// ── 3. run-created 正点接线（[Q2] P1b-1 引导补投已删除） ─────

describe("run-created 正点接线（无双帧 + 引导退役）", () => {
  it("正点发射后后续触发不补投：journal 恰好一帧 run-created；重复发射 = 表外转移 fail-fast", async () => {
    const run = makeRealRun("wf-ev-dual");
    await dispatchRunCreated(run);

    // 正点后的 ask 事件照常落账（fold 出 dispatched，ask-dispatched 合法转移）
    const deps = makeDeps();
    deps.runner.run = vi.fn(async () =>
      ({ content: "ok", durationMs: 1, toolCalls: [] }) as AgentResult,
    );
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

    const events = await scanRunEvents("wf-ev-dual");
    // 双帧不存在：run-created 恰好一帧（正点），后续触发零补投
    expect(events.filter((e) => e.type === "run-created")).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "run-created", workflowName: "test-wf" });
    expect(events.slice(1).map((e) => e.type)).toEqual(["ask-dispatched", "ask-settled"]);

    // 正点重复发射 = 表外转移 fail-fast（ask 全链后 fold 停在 running——无论哪个
    // 非 created 态，run-created 均无表行，双帧构造性排除）
    await expect(dispatchRunCreated(run)).rejects.toThrow(/不接受事件 run-created/);
  });

  it("引导补投已退役：journal 无 run-created 帧时事件触发表外转移 fail-fast（不静默补齐）", async () => {
    const run = makeRealRun("wf-ev-noseed");

    await expect(
      dispatchRunTrigger(run, {
        type: "ask-dispatched",
        taskIndex: 1,
        agentName: "a",
        attempt: 1,
        ts: Date.now(),
      }),
    ).rejects.toThrow(/非法 run 状态转移/);
    // fail-fast 不落任何帧（事件在 run-created 落账前到达 = 接线错误，可归因）
    expect(await scanRunEvents("wf-ev-noseed")).toHaveLength(0);
  });
});

// ── 4. finalizeRun 的 run-settled errorCode 构造（S2 死亡可诊断） ──

describe("finalizeRun 的 run-settled errorCode 构造（DoneReason → RunErrorCode 单点映射）", () => {
  it("failed + 失败 call 带 engine_crashed 协议码前缀 → errorCode=engine_crashed（S2 引擎崩溃族）", async () => {
    const run = makeRealRun("wf-ev-ec");
    await dispatchRunCreated(run);
    // 错误文本 `<code>: <detail>` 前缀 = SDK EngineSdkError 的跨面契约形态
    // （AgentOutcome.error 与协议 error 帧共用；engine crash 族经此存活进 run 域）。
    run.state.calls.set(0, makeSettledCall(0, {
      content: "",
      error:
        "engine_crashed: engine process exited unexpectedly: signal SIGKILL. stderr tail: fake engine ready",
      durationMs: 21_000,
      toolCalls: [],
    }));
    run.state.error =
      "Workflow failed after 3 retries: ask-1 failed after retries: engine_crashed: engine process exited unexpectedly: signal SIGKILL";
    const deps = makeDeps();

    await finalizeRun(run, deps, "failed", { context: "test" });

    const events = await scanRunEvents("wf-ev-ec");
    expect(events.at(-1)).toMatchObject({
      type: "run-settled",
      outcome: "failed",
      errorCode: "engine_crashed",
    });
  });

  it("budget_limited → errorCode=budget_limited；time_limited → time_limited（run 级终局码恒等映射）", async () => {
    for (const reason of ["budget_limited", "time_limited"] as const) {
      const run = makeRealRun(`wf-ev-${reason}`);
      await dispatchRunCreated(run);
      const deps = makeDeps();

      await finalizeRun(run, deps, reason, { context: "test" });

      const events = await scanRunEvents(`wf-ev-${reason}`);
      expect(events.at(-1)).toMatchObject({
        type: "run-settled",
        outcome: "failed",
        errorCode: reason,
      });
    }
  });

  it("failed + failureKind（无协议码前缀）→ failureKind 落码（ask 级分诊标签兜底）", async () => {
    const run = makeRealRun("wf-ev-kind");
    await dispatchRunCreated(run);
    run.state.calls.set(0, makeSettledCall(0, {
      content: "",
      error: "pi child exited with code 3",
      failureKind: "unknown",
      durationMs: 3_000,
      toolCalls: [],
    }));
    const deps = makeDeps();

    await finalizeRun(run, deps, "failed", { context: "test" });

    const events = await scanRunEvents("wf-ev-kind");
    expect(events.at(-1)).toMatchObject({ type: "run-settled", outcome: "failed", errorCode: "unknown" });
  });

  it("failed 无失败 call（脚本自身错误终局）→ 保守 unknown（诊断全文在 reason）", async () => {
    const run = makeRealRun("wf-ev-script");
    await dispatchRunCreated(run);
    run.state.error = "Workflow failed: script threw TypeError";
    const deps = makeDeps();

    await finalizeRun(run, deps, "failed", { context: "test" });

    const events = await scanRunEvents("wf-ev-script");
    expect(events.at(-1)).toMatchObject({ type: "run-settled", outcome: "failed", errorCode: "unknown" });
  });

  it("completed 与 aborted（cancel 合成 cancelled）→ 无 errorCode 键（成功/取消不带码）", async () => {
    const runDone = makeRealRun("wf-ev-ok2");
    await dispatchRunCreated(runDone);
    await finalizeRun(runDone, makeDeps(), "completed", { context: "test" });
    const doneEvents = await scanRunEvents("wf-ev-ok2");
    expect(doneEvents.at(-1)).toMatchObject({ type: "run-settled", outcome: "completed" });
    expect(doneEvents.at(-1)).not.toHaveProperty("errorCode");

    const runAbort = makeRealRun("wf-ev-abort");
    await dispatchRunCreated(runAbort);
    await finalizeRun(runAbort, makeDeps(), "aborted", { context: "abortRun" });
    const abortEvents = await scanRunEvents("wf-ev-abort");
    expect(abortEvents.at(-1)).toMatchObject({ type: "run-settled", outcome: "cancelled" });
    expect(abortEvents.at(-1)).not.toHaveProperty("errorCode");
  });
});

// ── 5. dispatchAgentCall 重试轨迹（ask-retrying 帧补投 + 静默反向） ──

describe("dispatchAgentCall 重试轨迹（ask-retrying 帧 + 静默反向）", () => {
  it("两次失败后成功 → journal dispatched→retrying{attempt:1}→retrying{attempt:2}→settled{attempt:3}（backoffMs 实测 = 退避调度值）", async () => {
    vi.useFakeTimers();
    try {
      const run = makeRealRun("wf-ev-retry");
      await dispatchRunCreated(run);
      const deps = makeDeps();
      deps.runner.run = vi
        .fn()
        .mockResolvedValueOnce({
          content: "",
          error: "engine_crashed: engine process exited unexpectedly: signal SIGKILL",
          durationMs: 5,
          toolCalls: [],
        })
        .mockResolvedValueOnce({
          content: "",
          error: "transient provider flake",
          durationMs: 5,
          toolCalls: [],
        })
        .mockResolvedValue({ content: "ok", durationMs: 5, toolCalls: [] });
      const handlers: WorkerHandlers = {
        onMessage: vi.fn(async () => {}),
        onError: vi.fn(async () => {}),
        onExit: vi.fn(async () => {}),
      };

      await handleWorkerMessage(
        run,
        { type: "agent-call", callId: 2, opts: { prompt: "p" } },
        deps,
        handlers,
      );
      await flushMicrotasks(); // attempt 1 失败（mock 立即 resolve）
      await vi.advanceTimersByTimeAsync(1000); // 首退避（BACKOFF 1000ms）→ attempt 2
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(2000); // 次退避（BACKOFF 2000ms）→ attempt 3 成功
      await flushMicrotasks(); // ask-settled 投递链落账

      expect(run.state.status).toBe("running"); // call 成功不触发终局
      // 静默反向（D7）：重试窗口零终局通知（journal 事件落账 ≠ 通知）
      expect(deps.onRunDone).not.toHaveBeenCalled();
      const events = await scanRunEvents("wf-ev-retry");
      expect(events.map((e) => e.type)).toEqual([
        "run-created",
        "ask-dispatched",
        "ask-retrying",
        "ask-retrying",
        "ask-settled",
      ]);
      expect(events[2]).toMatchObject({ type: "ask-retrying", taskIndex: 2, attempt: 1, backoffMs: 1000 });
      expect(events[3]).toMatchObject({ type: "ask-retrying", taskIndex: 2, attempt: 2, backoffMs: 2000 });
      // reason 摘要：首退避帧携带失败文案（engine 码前缀保留）
      expect((events[2] as { reason?: string }).reason).toContain("engine_crashed");
      expect(events[4]).toMatchObject({ type: "ask-settled", taskIndex: 2, attempt: 3, outcome: "completed" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("非重试终局（stale_context 不重试）→ 零 ask-retrying 帧（构造性零假帧）", async () => {
    const run = makeRealRun("wf-ev-noretry");
    await dispatchRunCreated(run);
    const deps = makeDeps();
    deps.runner.run = vi.fn(async () =>
      ({ content: "", error: "stale context", failureKind: "stale_context", durationMs: 1, toolCalls: [] }) as AgentResult,
    );
    const handlers: WorkerHandlers = {
      onMessage: vi.fn(async () => {}),
      onError: vi.fn(async () => {}),
      onExit: vi.fn(async () => {}),
    };

    await handleWorkerMessage(
      run,
      { type: "agent-call", callId: 4, opts: { prompt: "p" } },
      deps,
      handlers,
    );
    await flushMicrotasks();

    const events = await scanRunEvents("wf-ev-noretry");
    expect(events.map((e) => e.type)).toEqual(["run-created", "ask-dispatched", "ask-settled"]);
    expect(deps.onRunDone).not.toHaveBeenCalled();
  });
});
