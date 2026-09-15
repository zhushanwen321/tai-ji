/**
 * worker-message-pump handlers — handleWorkerExit/Error/ScriptError + postBudgetUpdate 测试。
 *
 * 参考 worker-message-pump-workflow-call.test.ts 的 mock 构建。通过 vi.useFakeTimers() 跳过
 * scheduleRebuild 的指数退避（1s/2s/4s）。
 *
 * 覆盖：
 * - handleWorkerExit：code=0 正常退出（no-op） / code!=0 委托 handleWorkerError / stale handle 过滤
 * - handleWorkerError：超限（count > MAX=3）→ transition done,failed + emit pending:unregister
 *   / 未超限 → rebuildRuntime（workerHost.start 重建）
 * - handleScriptError：超限 → transition done,failed / workerLogs 捕获
 * - postBudgetUpdate：postMessage budget-update（usedTokens/usedCost）
 * - stale handle 过滤（handle.isCurrent=false）+ terminal stale 守卫（isTerminal 语义）
 * - rebuildRuntime：worker 崩溃后 workerHost.start + scheduleTimeBudget 重排 + replaceRuntime
 *   + 在飞 call 清理（discardInFlightCalls 生效：在飞清除、done 保留）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  handleScriptError,
  handleWorkerError,
  handleWorkerExit,
  handleWorkerMessage,
  postBudgetUpdate,
  rebuildRuntime,
} from "../worker-message-pump.ts";
import { Budget } from "../models/budget.ts";
import { RunRuntime } from "../models/run-runtime.ts";
import { Trace } from "../models/trace.ts";
import type { AgentResult, DoneReason, RunStatus } from "../models/types.ts";
import { WorkflowRun } from "../models/workflow-run.ts";
import type { LifecycleDeps, WorkerHandlers } from "../models/ports.ts";
import type { WorkerHandle } from "../worker-handle.ts";
import { flushMicrotasks } from "./helpers/flush-microtasks.ts";

// ── helpers ──────────────────────────────────────────────────

/** 构造一个 status="running" 的 mock WorkflowRun，meta 可配置。 */
function makeRunningRun(opts: {
  workerErrorCount?: number;
  scriptErrorCount?: number;
  budgetTimeMs?: number;
  postMessage?: ReturnType<typeof vi.fn>;
  /** [F1] 预置本 runtime 代际已收到终态消息（return/error）。 */
  receivedTerminalMessage?: boolean;
} = {}): WorkflowRun {
  return {
    state: {
      status: "running",
      budget: { usedTokens: 50, usedCost: 0.1 },
      // L9: errorLogs 现在用 push 追加——必须是真实数组，不能省略
      errorLogs: [],
      // rebuildRuntime 内 discardInFlightCalls 遍历 calls + 移除 trace 节点——
      // 必须是真实 Map（空 = 无在飞 call，discard 为 no-op）
      calls: new Map(),
      trace: { removeByStepIndex: vi.fn() },
    },
    meta: {
      startedAt: new Date().toISOString(),
      workerErrorCount: opts.workerErrorCount,
      scriptErrorCount: opts.scriptErrorCount,
    },
    spec: {
      scriptName: "test-wf",
      scriptSource: "execute() {}",
      args: {},
      budgetTimeMs: opts.budgetTimeMs,
    },
    runtime: {
      worker: { postMessage: opts.postMessage ?? vi.fn() },
      receivedTerminalMessage: opts.receivedTerminalMessage,
    },
    // transition 副作用——run.state.status 由调用方通过 mock 控制后再次断言
    transition(this: WorkflowRun, target: RunStatus, reason?: DoneReason): void {
      this.state.status = target;
      if (target === "done") this.state.reason = reason;
    },
    replaceRuntime(this: WorkflowRun, rt: NonNullable<WorkflowRun["runtime"]>): void {
      this.runtime = rt;
    },
  } as unknown as WorkflowRun;
}

/** LifecycleDeps mock：store/workerHost/runner/eventBus/scheduleTimeBudget 可观察。
 *  mock 成员 = 真实签名 & vi.fn 能力（交叉纯 Mock 会丢真实签名，传回被测函数即报错）。 */
type MockLifecycleDeps = Omit<
  LifecycleDeps,
  "store" | "workerHost" | "runner" | "eventBus" | "onRunDone" | "log"
> & {
  // 真实类型整体保留（RunStore/WorkerHost 等接口成员完整），仅 mock 方法交叉 vi.fn 能力
  store: LifecycleDeps["store"] & { save: LifecycleDeps["store"]["save"] & ReturnType<typeof vi.fn> };
  workerHost: LifecycleDeps["workerHost"] & { start: LifecycleDeps["workerHost"]["start"] & ReturnType<typeof vi.fn> };
  runner: LifecycleDeps["runner"] & { run: LifecycleDeps["runner"]["run"] & ReturnType<typeof vi.fn> };
  eventBus: NonNullable<LifecycleDeps["eventBus"]> & { emit: NonNullable<LifecycleDeps["eventBus"]>["emit"] & ReturnType<typeof vi.fn> };
  onRunDone: LifecycleDeps["onRunDone"] & ReturnType<typeof vi.fn>;
  log: LifecycleDeps["log"] & ReturnType<typeof vi.fn>;
};

function makeDeps(opts: {
  scheduleTimeBudget?: LifecycleDeps["scheduleTimeBudget"];
} = {}): MockLifecycleDeps {
  return {
    store: { save: vi.fn(async () => {}) },
    workerHost: { start: vi.fn(() => ({ postMessage: vi.fn() })) },
    runner: { run: vi.fn(async () => ({})) },
    runs: new Map(),
    eventBus: { emit: vi.fn() },
    onRunDone: vi.fn(),
    log: vi.fn(),
    scheduleTimeBudget: opts.scheduleTimeBudget,
  } as unknown as ReturnType<typeof makeDeps>;
}

/** WorkerHandlers 占位（handler 路径递归调本对象上的回调，但测试场景不触发）。 */
function makeHandlers(): WorkerHandlers {
  return {
    onMessage: vi.fn(async () => {}),
    onError: vi.fn(async () => {}),
    onExit: vi.fn(async () => {}),
  } as unknown as WorkerHandlers;
}

/** 构造 mock WorkerHandle（isCurrent 可配）。 */
function makeHandle(isCurrent = true): WorkerHandle {
  return { isCurrent } as unknown as WorkerHandle;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── handleWorkerExit ─────────────────────────────────────────

describe("handleWorkerExit", () => {
  it("code=0 且已收到终态消息：no-op（不 transition、不 save）", async () => {
    // [F1] 语义更新：exit(0) no-op 的前提是本代际已交付 return/error（正常收尾退出，
    // 或 script-error 重试退避窗口）。无终态消息的 exit(0) 现转 done,failed，
    // 见下方用例与 worker-exit-without-result.test.ts。
    const run = makeRunningRun({ receivedTerminalMessage: true });
    const deps = makeDeps();
    const handle = makeHandle(true);

    await handleWorkerExit(run, 0, handle, deps, makeHandlers());

    expect(run.state.status).toBe("running"); // 未改
    expect(deps.store.save).not.toHaveBeenCalled();
    expect(deps.eventBus.emit).not.toHaveBeenCalled();
  });

  it("code=0 且无终态消息：[F1] 转 done,failed（不可克隆 return 被吞的悬挂防线）", async () => {
    const run = makeRunningRun();
    const deps = makeDeps();
    const handle = makeHandle(true);

    await handleWorkerExit(run, 0, handle, deps, makeHandlers());

    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("failed");
    expect(run.state.error).toContain("structured-cloneable");
    expect(deps.store.save).toHaveBeenCalledTimes(1);
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
  });

  it("code!=0 异常退出：委托 handleWorkerError → 超 MAX 重试 → transition done,failed", async () => {
    // workerErrorCount 已达 MAX=3 → handleWorkerError 内 count=4 > 3 → failed
    const run = makeRunningRun({ workerErrorCount: 3 });
    const deps = makeDeps();
    const handle = makeHandle(true);

    await handleWorkerExit(run, 1, handle, deps, makeHandlers());

    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("failed");
    expect(run.state.error).toContain("Worker exited with code 1");
    // 持久化 + 完成通知
    expect(deps.store.save).toHaveBeenCalledTimes(1);
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
  });

  it("stale handle（isCurrent=false）：丢弃 exit 事件，不处理", async () => {
    const run = makeRunningRun();
    const deps = makeDeps();
    const staleHandle = makeHandle(false);

    await handleWorkerExit(run, 1, staleHandle, deps, makeHandlers());

    // 状态未变，store 未 save
    expect(run.state.status).toBe("running");
    expect(deps.store.save).not.toHaveBeenCalled();
  });

  it("run 已终态（done）：stale 守卫前置丢弃", async () => {
    const run = makeRunningRun();
    run.state.status = "done";
    (run.state as { reason?: string }).reason = "completed";
    const deps = makeDeps();
    const handle = makeHandle(true);

    await handleWorkerExit(run, 1, handle, deps, makeHandlers());

    expect(deps.store.save).not.toHaveBeenCalled();
  });
});

// ── handleWorkerError ────────────────────────────────────────

describe("handleWorkerError", () => {
  it("count > MAX（3）：transition done,failed + save + emit pending:unregister", async () => {
    // workerErrorCount=3 → count=4 > MAX
    const run = makeRunningRun({ workerErrorCount: 3 });
    const deps = makeDeps();

    await handleWorkerError(run, new Error("worker boom"), deps, makeHandlers());

    expect(run.meta.workerErrorCount).toBe(4);
    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("failed");
    expect(run.state.error).toBe("worker boom");
    expect(deps.store.save).toHaveBeenCalledTimes(1);
    expect(deps.eventBus.emit).toHaveBeenCalledWith("pending:unregister", {
      id: undefined, // mock run 无 runId
      reason: "failed",
    });
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
  });

  it("count <= MAX：退避 + rebuildRuntime（workerHost.start 重建新 runtime）", async () => {
    const run = makeRunningRun({ workerErrorCount: 0 }); // count=1 <= MAX
    const deps = makeDeps();

    const promise = handleWorkerError(run, new Error("transient"), deps, makeHandlers());

    // 推进指数退避（第 1 次重试：1s）
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(run.meta.workerErrorCount).toBe(1);
    // 状态仍 running（重试不改 status）
    expect(run.state.status).toBe("running");
    // workerHost.start 被调（rebuildRuntime 内重建 worker）
    expect(deps.workerHost.start).toHaveBeenCalledTimes(1);
  });

  it("终态（done）：stale 守卫前置丢弃（不递增 workerErrorCount）", async () => {
    const run = makeRunningRun();
    run.state.status = "done";
    (run.state as { reason?: string }).reason = "completed";
    const deps = makeDeps();

    await handleWorkerError(run, new Error("stale"), deps, makeHandlers());

    expect(run.meta.workerErrorCount).toBeUndefined(); // 未递增
    expect(deps.store.save).not.toHaveBeenCalled();
  });
});

// ── handleScriptError ────────────────────────────────────────

describe("handleScriptError", () => {
  it("count > MAX（3）：transition done,failed + 捕获 workerLogs", async () => {
    const run = makeRunningRun({ scriptErrorCount: 3 }); // count=4 > MAX
    const deps = makeDeps();
    const workerLogs = [
      { level: "error" as const, message: "line 5 boom" },
    ];

    await handleScriptError(run, "TypeError: x is undefined", workerLogs, deps, makeHandlers());

    expect(run.meta.scriptErrorCount).toBe(4);
    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("failed");
    expect(run.state.error).toContain("Workflow failed after 3 retries");
    expect(run.state.error).toContain("TypeError: x is undefined");
    // workerLogs 捕获到 errorLogs
    expect(run.state.errorLogs).toEqual(workerLogs);
    expect(deps.store.save).toHaveBeenCalledTimes(1);
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
  });

  it("count <= MAX：退避 + rebuildRuntime", async () => {
    const run = makeRunningRun({ scriptErrorCount: 1 }); // count=2 <= MAX
    const deps = makeDeps();

    const promise = handleScriptError(run, "ReferenceError", [], deps, makeHandlers());

    // 第 2 次重试退避：2s
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(run.meta.scriptErrorCount).toBe(2);
    expect(run.state.status).toBe("running");
    expect(deps.workerHost.start).toHaveBeenCalledTimes(1);
  });

  it("terminal 状态：stale 守卫前置丢弃", async () => {
    const run = makeRunningRun();
    run.state.status = "done";
    (run.state as { reason?: string }).reason = "completed";
    const deps = makeDeps();

    await handleScriptError(run, "late error", [], deps, makeHandlers());

    expect(run.meta.scriptErrorCount).toBeUndefined();
    expect(deps.store.save).not.toHaveBeenCalled();
  });
});

// ── postBudgetUpdate ─────────────────────────────────────────

describe("postBudgetUpdate", () => {
  it("向 worker postMessage budget-update（usedTokens/usedCost）", () => {
    const postMessage = vi.fn();
    const run = makeRunningRun({ postMessage });

    postBudgetUpdate(run);

    expect(postMessage).toHaveBeenCalledWith({
      type: "budget-update",
      budget: { usedTokens: 50, usedCost: 0.1 },
    });
  });

  it("runtime 不存在时 no-op（不抛错）", () => {
    const run = makeRunningRun();
    // runtime.worker.postMessage 为 undefined 时应安全
    run.runtime = undefined;

    expect(() => postBudgetUpdate(run)).not.toThrow();
  });
});

// ── rebuildRuntime ───────────────────────────────────────────

describe("rebuildRuntime", () => {
  it("worker 崩溃后重建：workerHost.start + replaceRuntime（保持 running）", () => {
    const run = makeRunningRun({ budgetTimeMs: 0 }); // 无时间预算
    const deps = makeDeps();

    rebuildRuntime(run, deps, makeHandlers());

    // workerHost.start 被调（构造新 worker）
    expect(deps.workerHost.start).toHaveBeenCalledTimes(1);
    // replaceRuntime 被调（新 runtime 绑定，mock 内仅替换 runtime 字段）
    expect(run.runtime).toBeDefined();
    // status 仍 running（replaceRuntime 不改 status）
    expect(run.state.status).toBe("running");
  });

  it("带 budgetTimeMs 时重排 scheduleTimeBudget 计时器", () => {
    const run = makeRunningRun({ budgetTimeMs: 5000 });
    const scheduleTimeBudget = vi.fn((_runId: string, _budgetTimeMs: number) => undefined);
    const deps = makeDeps({ scheduleTimeBudget });

    rebuildRuntime(run, deps, makeHandlers());

    // D-12 regression fix (round-2 #2)：replaceRuntime 后重排时间预算
    expect(scheduleTimeBudget).toHaveBeenCalledTimes(1);
    // 第 1 参 = runId（mock run 无 runId），第 2 参 = budgetTimeMs
    const args = scheduleTimeBudget.mock.calls[0]!;
    expect(args[1]).toBe(5000);
  });

  it("无 scheduleTimeBudget 注入时不重排（向后兼容，不抛错）", () => {
    const run = makeRunningRun({ budgetTimeMs: 5000 });
    const deps = makeDeps({ scheduleTimeBudget: undefined });

    expect(() => rebuildRuntime(run, deps, makeHandlers())).not.toThrow();
    expect(deps.workerHost.start).toHaveBeenCalledTimes(1);
  });

  it("rebuildRuntime 后同步清理在飞 call（status !== done 清除、done 保留）", () => {
    const run = makeRunningRun({ budgetTimeMs: 0 });
    // 注入在飞 call（running）与已完成 call（done）+ trace 节点移除 spy
    const removeByStepIndex = vi.fn();
    const calls = new Map<number, { id: number; status: string }>([
      [7, { id: 7, status: "running" }],
      [8, { id: 8, status: "done" }],
    ]);
    (run.state as { calls: unknown }).calls = calls;
    (run.state as { trace: unknown }).trace = { removeByStepIndex };
    const deps = makeDeps();

    rebuildRuntime(run, deps, makeHandlers());

    // 在飞 call（running）被移除（含 trace 节点）；已完成 call（done）保留供重跑 replay
    expect(calls.has(7)).toBe(false);
    expect(calls.has(8)).toBe(true);
    expect(removeByStepIndex).toHaveBeenCalledTimes(1);
    expect(removeByStepIndex).toHaveBeenCalledWith(7);
    // 重建本身不受影响
    expect(deps.workerHost.start).toHaveBeenCalledTimes(1);
  });
});

// ── orphan call guard（S7-second 竞态回归） ─────────────────
//
// 复刻 gate-report §3 的竞态形态：dispatch agent-call → 立即 rebuildRuntime（同步
// discard 在飞 call）→ 旧 dispatch 的 promise 以失败/成功 resolve → 迟到的旧代际
// 结果不得经 postAgentResult 投给**新 worker** 的同 callId pending（否则重跑中的
// agent() 被旧结果劫持 resolve 为空串 → 脚本假成功，PHASE_B 子进程被连带收割）。
//
// 用真实 WorkflowRun/RunRuntime/Trace/Budget（而非 makeRunningRun 的简化 mock）：
// rebuildRuntime → replaceRuntime → release 的 abort 旧 controller / terminate 旧
// worker / discardInFlightCalls 全链路需要真实聚合根行为才成立。

// ── race-F3：rebuild 时间预算折算（已耗墙钟不重置） ─────────────
//
// 旧实现 rebuildRuntime 重排计时器用满额 budgetTimeMs——每吃一次 worker/script
// 错误重试就重置一次预算，最坏 6 次重试放大 ~6× 墙钟。修复后：
// - 重排值 = max(0, 原预算 - 已耗墙钟)（从 run.meta.startedAt 推算）
// - 重试前已耗尽 → 不 rebuild，直接 done,time_limited 终态
//
// 确定性说明：本文件 beforeEach 已 useFakeTimers()（默认 fake Date）——Date.now
// 冻结，startedAt 倒拨值即精确已耗墙钟，断言可精确等值。
describe("race-F3: rebuild 时间预算折算", () => {
  it("剩余 30% → 重排预算 = 30% 而非满额", () => {
    const run = makeRunningRun({ budgetTimeMs: 5000 });
    // 已耗 70%（3500ms）→ 剩余 1500ms；fake Date 冻结，elapsed 精确
    run.meta.startedAt = new Date(Date.now() - 3500).toISOString();
    const scheduleTimeBudget = vi.fn((_runId: string, _budgetTimeMs: number) => undefined);
    const deps = makeDeps({ scheduleTimeBudget });

    rebuildRuntime(run, deps, makeHandlers());

    expect(scheduleTimeBudget).toHaveBeenCalledTimes(1);
    const args = scheduleTimeBudget.mock.calls[0]!;
    expect(args[1]).toBe(1500);
    // run 保持 running（正常 rebuild 路径不受影响）
    expect(run.state.status).toBe("running");
  });

  it("重试前预算已耗尽（已耗 > 预算）→ 不 rebuild，直接 done,time_limited", async () => {
    const run = makeRunningRun({ budgetTimeMs: 5000 });
    // 已耗 6000ms > 预算 5000ms（退避 advance 1000ms 后已耗 7000ms，仍耗尽）
    run.meta.startedAt = new Date(Date.now() - 6000).toISOString();
    const scheduleTimeBudget = vi.fn((_runId: string, _budgetTimeMs: number) => undefined);
    const deps = makeDeps({ scheduleTimeBudget });

    const p = handleScriptError(run, "boom", [], deps, makeHandlers());
    await vi.advanceTimersByTimeAsync(1000); // 推进退避（1s）
    await p;

    // 不 rebuild：不启新 worker、不重排计时器
    expect(deps.workerHost.start).not.toHaveBeenCalled();
    expect(scheduleTimeBudget).not.toHaveBeenCalled();
    // 直接 time_limited 终态 + 持久化 + 注销通知 + onRunDone
    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("time_limited");
    expect(deps.store.save).toHaveBeenCalled();
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "pending:unregister",
      expect.objectContaining({ reason: "time_limited" }),
    );
    expect(deps.onRunDone).toHaveBeenCalled();
  });

  it("预算未耗尽（fresh run）→ 照常 rebuild，不误转 time_limited（防误伤回归）", async () => {
    const run = makeRunningRun({ budgetTimeMs: 5000 }); // startedAt ≈ now，remaining 满
    const scheduleTimeBudget = vi.fn((_runId: string, _budgetTimeMs: number) => undefined);
    const deps = makeDeps({ scheduleTimeBudget });

    const p = handleScriptError(run, "boom", [], deps, makeHandlers());
    await vi.advanceTimersByTimeAsync(1000);
    await p;

    expect(deps.workerHost.start).toHaveBeenCalledTimes(1);
    expect(scheduleTimeBudget).toHaveBeenCalledTimes(1);
    expect(run.state.status).toBe("running");
  });
});

/** 手动控制的 deferred——精确编排「dispatch 挂起 → rebuild → 旧 promise settle」交错。 */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 构造真实 WorkflowRun（真实状态机/replaceRuntime/Trace/Budget）+ 初始 RunRuntime。 */
function makeRealRun(runId: string, opts: { budgetTimeMs?: number } = {}): WorkflowRun {
  const run = new WorkflowRun(
    runId,
    {
      scriptName: "test-wf",
      scriptSource: "agent('hi')",
      args: {},
      scriptPath: "/tmp/test-wf.js",
      budgetTimeMs: opts.budgetTimeMs,
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
  // 初始 worker mock 必须带 terminate——真实 replaceRuntime 会 release 旧 runtime
  const initialWorker = {
    postMessage: vi.fn(),
    terminate: vi.fn(async () => {}),
  } as unknown as WorkerHandle;
  run.assignRuntime(new RunRuntime(initialWorker, new AbortController()));
  return run;
}

/** agent-call 消息（opts 无 skill/schema——resolveAgentOpts 直通，无 IO）。 */
function makeAgentCallMsg(callId: number): unknown {
  return {
    type: "agent-call",
    callId,
    opts: { prompt: "test task", agent: "worker", description: "test-slug" },
  };
}

/** 从 postMessage spy 的调用记录中找 type:"agent-result" 且 callId 匹配的报文。 */
function findAgentResultPost(
  postMessage: ReturnType<typeof vi.fn>,
  callId: number,
): { type: string; callId: number; result: AgentResult; cached: boolean } | undefined {
  for (const call of postMessage.mock.calls) {
    const msg = call[0] as { type?: string; callId?: number };
    if (msg?.type === "agent-result" && msg.callId === callId) {
      return msg as never;
    }
  }
  return undefined;
}

describe("orphan call guard（rebuild 后迟到 completion 不投递新 worker）", () => {
  it("失败路径：discard + 重跑替换后，旧 dispatch 的失败 completion 不投新 worker、不复活 Map 条目", async () => {
    const run = makeRealRun("wf-orphan-1");
    const deps = makeDeps();
    // rebuild 的新 worker——postMessage 记录用于断言「孤儿结果未投递」
    const newWorkerPost = vi.fn();
    deps.workerHost.start.mockImplementation(
      () =>
        ({ postMessage: newWorkerPost, terminate: vi.fn(async () => {}) }) as unknown as WorkerHandle,
    );
    const handlers = makeHandlers();

    // 旧 runtime 代际：dispatch callId=1，runner 挂起（模拟在飞子进程）
    const deferredA = createDeferred<AgentResult>();
    deps.runner.run.mockImplementation(() => deferredA.promise);
    await handleWorkerMessage(run, makeAgentCallMsg(1), deps, handlers);
    await flushMicrotasks();
    expect(run.state.calls.get(1)?.status).toBe("running");

    // worker 崩溃 → rebuildRuntime：replaceRuntime（abort 旧 controller）+ 同步 discard 在飞 call
    rebuildRuntime(run, deps, handlers);
    expect(run.state.calls.has(1)).toBe(false);
    expect(run.state.trace.find(1)).toBeUndefined();

    // 新 worker 重跑脚本：同 callId=1 再 dispatch（重跑实例 B 挂起在飞）
    const deferredB = createDeferred<AgentResult>();
    deps.runner.run.mockImplementation(() => deferredB.promise);
    await handleWorkerMessage(run, makeAgentCallMsg(1), deps, handlers);
    await flushMicrotasks();
    const rerunCall = run.state.calls.get(1);
    expect(rerunCall).toBeDefined();

    // 旧 dispatch 的 promise 以失败 resolve（abort 收割子进程后的迟到 finalize，
    // error 含 "aborted" 命中 stale-context 快速路径——真实形态）
    deferredA.resolve({ content: "", error: "Subprocess aborted by runtime shutdown" });
    await flushMicrotasks();

    // 孤儿失败结果不得投给新 worker（否则劫持重跑 pending 为空串假成功）
    expect(findAgentResultPost(newWorkerPost, 1)).toBeUndefined();
    // calls Map 无孤儿复活条目：callId=1 仍是重跑实例 B
    expect(run.state.calls.get(1)).toBe(rerunCall);
  });

  it("成功路径：discard 后旧 dispatch 的成功 completion 不投新 worker、不复活 Map/trace 条目", async () => {
    const run = makeRealRun("wf-orphan-2");
    const deps = makeDeps();
    const newWorkerPost = vi.fn();
    deps.workerHost.start.mockImplementation(
      () =>
        ({ postMessage: newWorkerPost, terminate: vi.fn(async () => {}) }) as unknown as WorkerHandle,
    );

    const deferred = createDeferred<AgentResult>();
    deps.runner.run.mockImplementation(() => deferred.promise);
    await handleWorkerMessage(run, makeAgentCallMsg(2), deps, makeHandlers());
    await flushMicrotasks();

    rebuildRuntime(run, deps, makeHandlers());
    expect(run.state.calls.has(2)).toBe(false);

    // 旧 promise 以成功 resolve（runner 已完成、结果晚于 rebuild 到达）
    deferred.resolve({ content: "late success", durationMs: 5, error: undefined, toolCalls: [] });
    await flushMicrotasks();

    expect(findAgentResultPost(newWorkerPost, 2)).toBeUndefined();
    expect(run.state.calls.has(2)).toBe(false);
    expect(run.state.trace.find(2)).toBeUndefined();
  });

  it("catch 路径：discard 后旧 dispatch 的异常 reject 不投新 worker、不复活 Map 条目", async () => {
    // catch 块的 logger.error 会打印——静默防噪音
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const run = makeRealRun("wf-orphan-3");
      const deps = makeDeps();
      const newWorkerPost = vi.fn();
      deps.workerHost.start.mockImplementation(
        () =>
          ({ postMessage: newWorkerPost, terminate: vi.fn(async () => {}) }) as unknown as WorkerHandle,
      );

      const deferred = createDeferred<AgentResult>();
      deps.runner.run.mockImplementation(() => deferred.promise);
      await handleWorkerMessage(run, makeAgentCallMsg(3), deps, makeHandlers());
      await flushMicrotasks();

      rebuildRuntime(run, deps, makeHandlers());
      expect(run.state.calls.has(3)).toBe(false);

      deferred.reject(new Error("runner exploded"));
      await flushMicrotasks();

      expect(findAgentResultPost(newWorkerPost, 3)).toBeUndefined();
      expect(run.state.calls.has(3)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("非孤儿正常路径：成功 completion 照常投递 agent-result（守卫不误伤）", async () => {
    const run = makeRealRun("wf-orphan-4");
    const deps = makeDeps();
    const postMessage = run.runtime!.worker.postMessage as ReturnType<typeof vi.fn>;
    deps.runner.run.mockImplementation(
      async () => ({ content: "real result", durationMs: 1, error: undefined, toolCalls: [] }) as AgentResult,
    );

    await handleWorkerMessage(run, makeAgentCallMsg(4), deps, makeHandlers());
    await flushMicrotasks(20);

    const posted = findAgentResultPost(postMessage, 4);
    expect(posted).toBeDefined();
    expect(posted?.result.content).toBe("real result");
    expect(run.state.calls.get(4)?.status).toBe("done");
    expect(run.state.trace.find(4)?.status).toBe("completed");
  });

  it("U6/S3 场景重放：discard + 重跑替换后，旧 finalize 不污染重跑新 trace 节点（旧 call 实例仍 markDone）", async () => {
    const run = makeRealRun("wf-orphan-s3");
    const deps = makeDeps();
    const newWorkerPost = vi.fn();
    deps.workerHost.start.mockImplementation(
      () => ({ postMessage: newWorkerPost, terminate: vi.fn(async () => {}) }) as unknown as WorkerHandle,
    );
    const handlers = makeHandlers();

    // 旧代际 dispatch callId=9：runner 挂起（模拟在飞子进程）
    const deferredA = createDeferred<AgentResult>();
    deps.runner.run.mockImplementation(() => deferredA.promise);
    await handleWorkerMessage(run, makeAgentCallMsg(9), deps, handlers);
    await flushMicrotasks();
    const oldCall = run.state.calls.get(9);
    expect(oldCall?.status).toBe("running");

    // rebuild：discard 移除旧 call 条目 + trace 节点（replaceRuntime 同步 abort 旧 signal）
    rebuildRuntime(run, deps, handlers);
    expect(run.state.calls.has(9)).toBe(false);
    expect(run.state.trace.find(9)).toBeUndefined();

    // 重跑 dispatch 同 callId=9：新实例 + 新 trace 节点 running，挂起在飞
    const deferredB = createDeferred<AgentResult>();
    deps.runner.run.mockImplementation(() => deferredB.promise);
    await handleWorkerMessage(run, makeAgentCallMsg(9), deps, handlers);
    await flushMicrotasks();
    const rerunCall = run.state.calls.get(9);
    expect(rerunCall).toBeDefined();
    expect(rerunCall).not.toBe(oldCall);
    expect(run.state.trace.find(9)?.status).toBe("running");

    // 旧 runner promise 以非 stale 失败 resolve——rebuild 已 abort 旧 signal，旧
    // executeAgentCall 醒来走 signal.aborted finalize 调用点（错误文案不含 stale
    // 模式词，确保不进 stale 分支）。红性锚点：无 OB2 守卫时此处 trace.update(9)
    // 命中重跑新节点 → 短暂污染为 failed。
    deferredA.resolve({ content: "", durationMs: 3, error: "old generation failure", toolCalls: [] });
    await flushMicrotasks();

    // 新 trace 节点未被旧 finalize 污染：仍 running、无 result、无 completedAt
    const newNode = run.state.trace.find(9);
    expect(newNode?.status).toBe("running");
    expect(newNode?.result).toBeUndefined();
    expect(newNode?.completedAt).toBeUndefined();
    // 旧实例 markDone 保留（dispatch 层 catch 路径依赖 call.status 语义）
    expect(oldCall?.status).toBe("done");
    expect(oldCall?.result?.error).toBe("old generation failure");
    // 重跑实例仍在飞，未被旧 completion 干扰；孤儿结果不投新 worker
    expect(rerunCall?.status).toBe("running");
    expect(findAgentResultPost(newWorkerPost, 9)).toBeUndefined();

    // 收尾：resolve 重跑 deferred，让挂起的 promise 链走完（非孤儿 → 正常完成路径）
    deferredB.resolve({ content: "rerun ok", durationMs: 1, error: undefined, toolCalls: [] });
    await flushMicrotasks();
    expect(run.state.trace.find(9)?.status).toBe("completed");
  });
});

// ── rebuildRuntime 可观察性（OB3 日志点 L1-L4） ─────────────

/** 从 deps.log 的 mock 调用记录提取 (message, payload)——message 非字符串时置空串（断言自然失败）。 */
function toLogEntries(calls: unknown[][]): Array<{ message: string; payload: unknown }> {
  return calls.map((c) => ({
    message: typeof c[2] === "string" ? c[2] : "",
    payload: c[3],
  }));
}

describe("rebuildRuntime 可观察性（OB3 日志点）", () => {
  it("U7: 无 budgetTimeMs 时按序打 L1 start → L4 complete（payload 含 runId），无 L2 重排日志", () => {
    const run = makeRealRun("wf-rebuild-log-1");
    const deps = makeDeps();

    rebuildRuntime(run, deps, makeHandlers());

    const entries = toLogEntries(deps.log.mock.calls);
    const messages = entries.map((e) => e.message);
    expect(messages).toContain("runtime rebuild start");
    expect(messages).toContain("runtime rebuild complete");
    // L4 在 L1 之后（顺序锚）
    expect(messages.indexOf("runtime rebuild complete")).toBeGreaterThan(
      messages.indexOf("runtime rebuild start"),
    );
    // 无 budgetTimeMs → 该分支本就跳过重排，L2 不打
    expect(messages).not.toContain("time budget rescheduled");
    // L1/L4 payload 含 runId
    const l1 = entries.find((e) => e.message === "runtime rebuild start");
    expect(l1?.payload).toMatchObject({ runId: "wf-rebuild-log-1" });
    const l4 = entries.find((e) => e.message === "runtime rebuild complete");
    expect(l4?.payload).toEqual({ runId: "wf-rebuild-log-1" });
  });

  it("U7: 带 budgetTimeMs + scheduleTimeBudget 注入时含 L2（在 L1 之后、L3 之前，payload 含 budgetTimeMs）", () => {
    const run = makeRealRun("wf-rebuild-log-2", { budgetTimeMs: 5000 });
    const scheduleTimeBudget = vi.fn((_runId: string, _budgetTimeMs: number) => undefined);
    const deps = makeDeps({ scheduleTimeBudget });

    rebuildRuntime(run, deps, makeHandlers());

    const entries = toLogEntries(deps.log.mock.calls);
    const messages = entries.map((e) => e.message);
    expect(messages).toContain("time budget rescheduled");
    expect(messages.indexOf("time budget rescheduled")).toBeGreaterThan(
      messages.indexOf("runtime rebuild start"),
    );
    expect(messages.indexOf("time budget rescheduled")).toBeLessThan(
      messages.indexOf("in-flight calls discarded"),
    );
    const l2 = entries.find((e) => e.message === "time budget rescheduled");
    expect(l2?.payload).toEqual({ runId: "wf-rebuild-log-2", budgetTimeMs: 5000 });
  });

  it("U8: 含 2 个在飞 call 的 run 经 rebuild → L3 callIds 升序、count === 2，与实际被弃 callId 一致", async () => {
    const run = makeRealRun("wf-rebuild-log-3");
    const deps = makeDeps();
    const handlers = makeHandlers();

    // 两个在飞 call（dispatch 插入序 5 → 3，验证 L3 callIds 是升序而非插入序）
    const deferreds = [createDeferred<AgentResult>(), createDeferred<AgentResult>()];
    let next = 0;
    deps.runner.run.mockImplementation(() => {
      const d = deferreds[next];
      next += 1;
      return d!.promise;
    });
    await handleWorkerMessage(run, makeAgentCallMsg(5), deps, handlers);
    await handleWorkerMessage(run, makeAgentCallMsg(3), deps, handlers);
    await flushMicrotasks();
    expect(run.state.calls.get(5)?.status).toBe("running");
    expect(run.state.calls.get(3)?.status).toBe("running");

    rebuildRuntime(run, deps, makeHandlers());

    // L3 payload：callIds 升序 [3, 5]、count === 2（即 discardInFlightCalls 返回值）
    const entries = toLogEntries(deps.log.mock.calls);
    const l3 = entries.find((e) => e.message === "in-flight calls discarded");
    expect(l3?.payload).toEqual({ runId: "wf-rebuild-log-3", callIds: [3, 5], count: 2 });
    // 返回值（经 L3 暴露）与实际被弃 callId 一致：Map/trace 条目均已移除
    expect(run.state.calls.has(5)).toBe(false);
    expect(run.state.calls.has(3)).toBe(false);
    expect(run.state.trace.find(5)).toBeUndefined();
    expect(run.state.trace.find(3)).toBeUndefined();

    // 收尾：resolve 两个挂起的 deferred（孤儿守卫 drop，无投递无污染）
    deferreds[0]!.resolve({ content: "", durationMs: 1, error: undefined, toolCalls: [] });
    deferreds[1]!.resolve({ content: "", durationMs: 1, error: undefined, toolCalls: [] });
    await flushMicrotasks();
  });
});
