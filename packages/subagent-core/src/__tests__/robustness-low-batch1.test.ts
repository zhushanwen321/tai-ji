// Low batch 1 robustness fix verification
//
// L9: run.state.errorLogs 追加而非覆盖——保留重试历史的诊断日志
//
// 一个 run 经历多次 error → rebuild → 最终 return 的场景，中间 worker 实例的
// console 日志对排查「为什么重试了 3 次」很关键。旧代码三处赋值都是覆盖式
//（run.state.errorLogs = ...），每次重试的诊断日志都被最后一次覆盖丢失。
// 修复：改为 push + 截断（MAX_ERROR_LOGS=500 防无界增长）。
//
// 测试搭建方式参照 worker-message-pump-handlers.test.ts（mock LifecycleDeps + WorkflowRun）。
// - handleScriptError 是 export 的 async function，直接 import 调用
// - handleReturn 不是 export 的——通过 handleWorkerMessage 发 { type: "return", ... } 触发

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleScriptError, handleWorkerMessage } from "../orchestration/worker-message-pump.ts";
import type { LifecycleDeps, WorkerHandlers } from "../orchestration/models/ports.ts";
import type { DoneReason, RunStatus } from "../orchestration/models/types.ts";
import type { WorkflowRun } from "../orchestration/models/workflow-run.ts";

// ── helpers ──────────────────────────────────────────────────

/**
 * 构造一个 status="running" 的 mock WorkflowRun。
 *
 * 关键：errorLogs 必须是真实数组（push/slice 会操作它），不能用 vi.fn 占位。
 * transition 把 status 切到 done——调用方可通过 resetRunning() 重置回 running
 * 以便多次触发 handleReturn（每条 return 消息都会 transition done）。
 */
function makeRunningRun(): WorkflowRun & { resetRunning(): void } {
  const run = {
    runId: "run-test",
    state: {
      status: "running" as const,
      reason: undefined as string | undefined,
      budget: { usedTokens: 0, usedCost: 0 },
      // 真实数组——push/slice 直接作用于它
      errorLogs: [] as Array<{ level: string; message: string }>,
      scriptResult: undefined as unknown,
      // rebuildRuntime 内 discardInFlightCalls 遍历 calls + 移除 trace 节点——
      // 必须是真实 Map（空 = 无在飞 call，discard 为 no-op）
      calls: new Map(),
      trace: { removeByStepIndex: vi.fn() },
    },
    meta: {
      startedAt: new Date().toISOString(),
    },
    spec: {
      scriptName: "test-wf",
      scriptSource: "execute() {}",
      args: {},
    },
    runtime: {
      worker: { postMessage: vi.fn() },
    },
    transition(this: WorkflowRun, target: RunStatus, reason?: DoneReason): void {
      this.state.status = target;
      if (target === "done") this.state.reason = reason;
    },
    replaceRuntime(this: WorkflowRun, rt: NonNullable<WorkflowRun["runtime"]>): void {
      this.runtime = rt;
    },
    // 多次触发 handleReturn 时把状态从 done 重置回 running
    resetRunning(this: WorkflowRun): void {
      this.state.status = "running";
      this.state.reason = undefined;
    },
  } as unknown as WorkflowRun & { resetRunning(): void };
  return run;
}

/** LifecycleDeps mock：store.save 是异步 no-op，其余可观察。 */
function makeDeps(): LifecycleDeps & {
  store: { save: ReturnType<typeof vi.fn> };
  workerHost: { start: ReturnType<typeof vi.fn> };
  eventBus: { emit: ReturnType<typeof vi.fn> };
  onRunDone: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
} {
  return {
    store: { save: vi.fn(async () => {}) },
    workerHost: { start: vi.fn(() => ({ postMessage: vi.fn() })) },
    runner: { run: vi.fn(async () => ({})) },
    runs: new Map(),
    eventBus: { emit: vi.fn() },
    onRunDone: vi.fn(),
    log: vi.fn(),
  } as unknown as ReturnType<typeof makeDeps>;
}

/** WorkerHandlers 占位（重试路径递归回调，但测试场景不触发）。 */
function makeHandlers(): WorkerHandlers {
  return {
    onMessage: vi.fn(async () => {}),
    onError: vi.fn(async () => {}),
    onExit: vi.fn(async () => {}),
  } as unknown as WorkerHandlers;
}

beforeEach(() => {
  // handleScriptError 重试路径走 scheduleRebuild（指数退避 1s/2s/4s）。
  // 测试中 workerLogs 已在退避前 push，但为了让 promise resolve（rebuildRuntime 后），
  // 用 fake timers 推进退避。超 MAX 的终态路径不进退避，直接 resolve。
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── handleScriptError: errorLogs 追加 ─────────────────────────

describe("L9: handleScriptError 追加 errorLogs（非覆盖）", () => {
  it("第一次 scriptError：errorLogs 长度为 1", async () => {
    const run = makeRunningRun();
    const deps = makeDeps();

    // count=1 <= MAX → 进退避重试路径。advance timer 让 promise resolve。
    const p = handleScriptError(
      run,
      "boom-1",
      [{ level: "error", message: "console error from worker #1" }],
      deps,
      makeHandlers(),
    );
    await vi.advanceTimersByTimeAsync(1000);
    await p;

    expect(run.state.errorLogs).toHaveLength(1);
    expect(run.state.errorLogs[0]).toEqual({
      level: "error",
      message: "console error from worker #1",
    });
  });

  it("第二次 scriptError：errorLogs 长度为 2（追加而非覆盖）", async () => {
    const run = makeRunningRun();
    const deps = makeDeps();

    // 第一次：count=1 <= MAX → 退避 1s
    const p1 = handleScriptError(
      run,
      "boom-1",
      [{ level: "error", message: "console error from worker #1" }],
      deps,
      makeHandlers(),
    );
    await vi.advanceTimersByTimeAsync(1000);
    await p1;

    // 第二次：count=2 <= MAX → 退避 2s
    const p2 = handleScriptError(
      run,
      "boom-2",
      [{ level: "warn", message: "console warn from worker #2" }],
      deps,
      makeHandlers(),
    );
    await vi.advanceTimersByTimeAsync(2000);
    await p2;

    expect(run.state.errorLogs).toHaveLength(2);
    expect(run.state.errorLogs[0]).toEqual({
      level: "error",
      message: "console error from worker #1",
    });
    expect(run.state.errorLogs[1]).toEqual({
      level: "warn",
      message: "console warn from worker #2",
    });
  });
});

// ── handleReturn: errorLogs 追加（经 handleWorkerMessage 触发） ──

describe("L9: handleReturn 追加 errorLogs（非覆盖）", () => {
  it("已有 2 条 errorLogs 后 handleReturn 再追加 1 条 → 长度 3", async () => {
    const run = makeRunningRun();
    const deps = makeDeps();

    // 先用 scriptError 累积 2 条诊断日志
    const p1 = handleScriptError(
      run,
      "boom-1",
      [{ level: "error", message: "diag-1" }],
      deps,
      makeHandlers(),
    );
    await vi.advanceTimersByTimeAsync(1000);
    await p1;

    const p2 = handleScriptError(
      run,
      "boom-2",
      [{ level: "error", message: "diag-2" }],
      deps,
      makeHandlers(),
    );
    await vi.advanceTimersByTimeAsync(2000);
    await p2;

    expect(run.state.errorLogs).toHaveLength(2);

    // handleReturn 经 handleWorkerMessage 触发——它内部会 transition("done","completed")
    run.resetRunning();
    await handleWorkerMessage(
      run,
      { type: "return", result: "final-result", workerLogs: [{ level: "log", message: "final-return-log" }] },
      deps,
      makeHandlers(),
    );

    expect(run.state.errorLogs).toHaveLength(3);
    expect(run.state.errorLogs[2]).toEqual({
      level: "log",
      message: "final-return-log",
    });
    // scriptResult 也被正确写入（验证未破坏其他字段）
    expect(run.state.scriptResult).toBe("final-result");
    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("completed");
  });
});

// ── 截断：超过 MAX_ERROR_LOGS 只保留最后 500 条 ────────────────

describe("L9: errorLogs 截断到 MAX_ERROR_LOGS（500）", () => {
  it("handleScriptError 追加超过 MAX 后只保留最后 MAX 条", async () => {
    const run = makeRunningRun();
    const deps = makeDeps();

    // 注入 499 条已有日志，再追加 3 条 → 502 > 500，应截断到 500
    for (let i = 0; i < 499; i++) {
      run.state.errorLogs.push({ level: "log", message: `pre-${i}` });
    }
    expect(run.state.errorLogs).toHaveLength(499);

    // handleScriptError 内部 push 3 条 + 截断。走终态路径（count > MAX）避免退避计时。
    // scriptErrorCount=3 → count=4 > 3 → transition done,failed，不进 scheduleRebuild。
    run.meta.scriptErrorCount = 3;
    await handleScriptError(
      run,
      "boom",
      [
        { level: "error", message: "new-1" },
        { level: "error", message: "new-2" },
        { level: "error", message: "new-3" },
      ],
      deps,
      makeHandlers(),
    );

    expect(run.state.errorLogs).toHaveLength(500);
    // 截断保留最后 500 条：499 + 3 = 502，丢弃最前 2 条（pre-0, pre-1）
    expect(run.state.errorLogs[0]).toEqual({ level: "log", message: "pre-2" });
    expect(run.state.errorLogs[499]).toEqual({ level: "error", message: "new-3" });
  });

  it("handleReturn 追加超过 MAX 后只保留最后 MAX 条", async () => {
    const run = makeRunningRun();
    const deps = makeDeps();

    // 注入 500 条已有日志，再追加 2 条 → 502 > 500
    for (let i = 0; i < 500; i++) {
      run.state.errorLogs.push({ level: "log", message: `pre-${i}` });
    }

    await handleWorkerMessage(
      run,
      {
        type: "return",
        result: "done",
        workerLogs: [
          { level: "log", message: "ret-1" },
          { level: "log", message: "ret-2" },
        ],
      },
      deps,
      makeHandlers(),
    );

    expect(run.state.errorLogs).toHaveLength(500);
    // 截断保留最后 500 条：丢弃最前 2 条（pre-0, pre-1）
    expect(run.state.errorLogs[0]).toEqual({ level: "log", message: "pre-2" });
    expect(run.state.errorLogs[499]).toEqual({ level: "log", message: "ret-2" });
  });
});
