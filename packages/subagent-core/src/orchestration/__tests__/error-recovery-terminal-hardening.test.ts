/**
 * [OR-4] 终态收尾 emit/onRunDone M12 同款围栏 + [OR-6] handleWorkerMessage log case /
 * default 留痕 + [OR-8] run done 时 in-flight call 收口 cancelled 测试。
 *
 * 覆盖（unbounded-wait-audit §4.1 OR-4 / §4.3 OR-6、OR-8 / §7.2 T3④⑤、T7④）：
 * - OR-4：eventBus.emit 或 onRunDone 同步抛错时，五个终态路径（return / worker error
 *   超限 / script error 超限 / exit 无终态消息 / time_limited）promise 均 resolve——
 *   错误被围栏捕获 error 留痕，不再经 worker-host 的 `void handlers.onXxx(...)`
 *   变 unhandledRejection 崩宿主
 * - OR-6 主线程半边：{type:"log"} 计入 errorLogs + deps.log debug 留痕（含上限裁剪）；
 *   未知 type warn 留痕（协议漂移防线）
 * - OR-8：脚本 return 时残留 fire-and-forget in-flight call 收口为取消终态
 *   （call done + trace failed + Cancelled 文案 + completedAt；[H2 W3] trace.live
 *   字段已删除——节点无运行期附属对象可滞留），先收口再落盘——done 快照不含
 *   running 节点
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getLogger } from "../../core/logger.ts";
import {
  closeOutInFlightCalls,
  handleScriptError,
  handleWorkerError,
  handleWorkerExit,
  handleWorkerMessage,
} from "../worker-message-pump.ts";
import { Budget } from "../models/budget.ts";
import { RunRuntime } from "../models/run-runtime.ts";
import { toRunSnapshot } from "../run-snapshot.ts";
import { Trace } from "../models/trace.ts";
import type { AgentResult, WorkerLogEntry } from "../models/types.ts";
import { WorkflowRun } from "../models/workflow-run.ts";
import type { LifecycleDeps, WorkerHandlers } from "../models/ports.ts";
import type { WorkerHandle } from "../worker-handle.ts";
import { flushMicrotasks } from "./helpers/flush-microtasks.ts";

// ── helpers ──────────────────────────────────────────────────

const MAX_ERROR_LOGS = 500;

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
  const initialWorker = {
    postMessage: vi.fn(),
    terminate: vi.fn(async () => {}),
  } as unknown as WorkerHandle;
  run.assignRuntime(new RunRuntime(initialWorker, new AbortController()));
  return run;
}

function makeDeps(opts: {
  /** eventBus.emit 同步抛错（模拟 listener 异常）。 */
  emitThrows?: boolean;
  /** onRunDone 同步抛错（模拟 evictDoneRunsBeyondCap 等收尾异常）。 */
  onRunDoneThrows?: boolean;
} = {}): Omit<LifecycleDeps, "store" | "workerHost" | "runner" | "eventBus" | "onRunDone" | "log"> & {
  // 真实类型整体保留（接口成员完整），仅 mock 方法交叉 vi.fn 能力
  store: LifecycleDeps["store"] & { save: LifecycleDeps["store"]["save"] & ReturnType<typeof vi.fn> };
  workerHost: LifecycleDeps["workerHost"] & { start: LifecycleDeps["workerHost"]["start"] & ReturnType<typeof vi.fn> };
  runner: LifecycleDeps["runner"] & { run: LifecycleDeps["runner"]["run"] & ReturnType<typeof vi.fn> };
  eventBus: NonNullable<LifecycleDeps["eventBus"]> & { emit: NonNullable<LifecycleDeps["eventBus"]>["emit"] & ReturnType<typeof vi.fn> };
  onRunDone: LifecycleDeps["onRunDone"] & ReturnType<typeof vi.fn>;
  log: LifecycleDeps["log"] & ReturnType<typeof vi.fn>;
} {
  return {
    store: { save: vi.fn(async () => {}) },
    workerHost: {
      start: vi.fn(
        () => ({ postMessage: vi.fn(), terminate: vi.fn(async () => {}) }) as unknown as WorkerHandle,
      ),
    },
    runner: { run: vi.fn(async () => ({}) as AgentResult) },
    runs: new Map(),
    eventBus: {
      emit: opts.emitThrows
        ? vi.fn(() => {
            throw new Error("listener exploded");
          })
        : vi.fn(),
    },
    onRunDone: opts.onRunDoneThrows
      ? vi.fn(() => {
          throw new Error("onRunDone exploded");
        })
      : vi.fn(),
    log: vi.fn(),
  } as unknown as ReturnType<typeof makeDeps>;
}

function makeHandlers(): WorkerHandlers {
  return {
    onMessage: vi.fn(async () => {}),
    onError: vi.fn(async () => {}),
    onExit: vi.fn(async () => {}),
  } as unknown as WorkerHandlers;
}

function makeAgentCallMsg(callId: number): unknown {
  return {
    type: "agent-call",
    callId,
    opts: { prompt: "test task", agent: "worker", description: "test-slug" },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── [OR-4] 终态收尾围栏 ──────────────────────────────────────

describe("[OR-4] 终态收尾 emit/onRunDone 围栏（不产 unhandledRejection）", () => {
  it("handleReturn：eventBus.emit 同步抛错 → promise resolve + error 留痕（save 已发生）", async () => {
    const run = makeRealRun("wf-fence-1");
    const deps = makeDeps({ emitThrows: true });

    await expect(
      handleWorkerMessage(run, { type: "return", result: { ok: true } }, deps, makeHandlers()),
    ).resolves.toBeUndefined();

    expect(run.state.status).toBe("done");
    expect(deps.store.save).toHaveBeenCalledTimes(1);
    // [B-4] 独立围栏：emit 故障不再跳过 onRunDone（旧实现同一 try 会跳过）
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
  });

  it("handleReturn：onRunDone 同步抛错 → promise resolve + error 留痕", async () => {
    const run = makeRealRun("wf-fence-2");
    const deps = makeDeps({ onRunDoneThrows: true });

    await expect(
      handleWorkerMessage(run, { type: "return", result: { ok: true } }, deps, makeHandlers()),
    ).resolves.toBeUndefined();

    expect(run.state.status).toBe("done");
    expect(deps.store.save).toHaveBeenCalledTimes(1);
    expect(deps.eventBus.emit).toHaveBeenCalledTimes(1); // emit 正常发出后才抛
  });

  it("handleWorkerError 超限：emit 抛错 → resolve（旧实现裸调 → unhandledRejection）", async () => {
    const run = makeRealRun("wf-fence-3");
    (run.meta as { workerErrorCount?: number }).workerErrorCount = 3; // count=4 > MAX
    const deps = makeDeps({ emitThrows: true });

    await expect(handleWorkerError(run, new Error("boom"), deps, makeHandlers())).resolves.toBeUndefined();
    expect(run.state.reason).toBe("failed");
    expect(deps.store.save).toHaveBeenCalledTimes(1);
  });

  it("handleScriptError 超限：onRunDone 抛错 → resolve", async () => {
    const run = makeRealRun("wf-fence-4");
    (run.meta as { scriptErrorCount?: number }).scriptErrorCount = 3;
    const deps = makeDeps({ onRunDoneThrows: true });

    await expect(handleScriptError(run, "boom", [], deps, makeHandlers())).resolves.toBeUndefined();
    expect(run.state.reason).toBe("failed");
    expect(deps.store.save).toHaveBeenCalledTimes(1);
  });

  it("handleWorkerExit 无终态消息路径：emit 抛错 → resolve", async () => {
    const run = makeRealRun("wf-fence-5");
    const deps = makeDeps({ emitThrows: true });
    const handle = { isCurrent: true } as unknown as WorkerHandle;

    await expect(handleWorkerExit(run, 0, handle, deps, makeHandlers())).resolves.toBeUndefined();
    expect(run.state.reason).toBe("failed");
    expect(deps.store.save).toHaveBeenCalledTimes(1);
  });

  it("time_limited 路径（预算耗尽 + 超限重试）：emit 抛错 → resolve", async () => {
    const run = makeRealRun("wf-fence-6", { budgetTimeMs: 5000 });
    // 已耗 6000ms > 预算 5000ms（fake timers 冻结 Date）
    run.meta.startedAt = new Date(Date.now() - 6000).toISOString();
    const deps = makeDeps({ emitThrows: true });

    const p = handleScriptError(run, "boom", [], deps, makeHandlers());
    await vi.advanceTimersByTimeAsync(1000); // 退避
    await expect(p).resolves.toBeUndefined();

    expect(run.state.reason).toBe("time_limited");
    expect(deps.store.save).toHaveBeenCalledTimes(1);
    // [B-4] 独立围栏：emit 故障不再跳过 onRunDone（旧实现同一 try 会跳过）
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
  });

  it("围栏捕获后 error 留痕（shared logger）", async () => {
    const errorSpy = vi.spyOn(getLogger("subagents"), "error");
    const run = makeRealRun("wf-fence-7");
    const deps = makeDeps({ onRunDoneThrows: true });

    await handleWorkerMessage(run, { type: "return", result: 1 }, deps, makeHandlers());

    const errLogs = errorSpy.mock.calls.map((c) => String(c[0]));
    expect(errLogs.some((m) => m.includes("onRunDone failed") && m.includes("onRunDone exploded"))).toBe(true);
  });

  it("[B-4] emit 抛错 → onRunDone 仍执行（独立围栏，完成回调不被通知总线故障吞掉）", async () => {
    const errorSpy = vi.spyOn(getLogger("subagents"), "error");
    const run = makeRealRun("wf-fence-8");
    const deps = makeDeps({ emitThrows: true });

    await handleWorkerMessage(run, { type: "return", result: 1 }, deps, makeHandlers());

    expect(run.state.reason).toBe("completed");
    expect(deps.onRunDone).toHaveBeenCalledTimes(1); // 旧实现同一 try：emit 抛错会跳过
    const errLogs = errorSpy.mock.calls.map((c) => String(c[0]));
    expect(errLogs.some((m) => m.includes("pending:unregister emit failed") && m.includes("listener exploded"))).toBe(true);
  });
});

// ── [OR-6] handleWorkerMessage log case + default 留痕 ───────

describe("[OR-6] log 消息消费 + 未知类型 default 留痕", () => {
  it("{type:\"log\"} 计入 run.state.errorLogs + deps.log debug 留痕（不触发终态）", async () => {
    const run = makeRealRun("wf-log-1");
    const deps = makeDeps();

    await handleWorkerMessage(run, { type: "log", phase: "build", message: "step 1 done" }, deps, makeHandlers());

    expect(run.state.errorLogs).toEqual([{ level: "log", message: "step 1 done" }]);
    expect(run.state.status).toBe("running"); // 不触发终态
    expect(deps.store.save).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith("debug", "workflow:worker-message-pump", "worker log", {
      runId: "wf-log-1",
      phase: "build",
      message: "step 1 done",
    });
  });

  it("log 超上限（MAX_ERROR_LOGS）时裁剪保留尾部（与 workerLogs 通路同语义）", async () => {
    const run = makeRealRun("wf-log-2");
    const deps = makeDeps();
    const prefill: WorkerLogEntry[] = Array.from({ length: MAX_ERROR_LOGS }, (_, i) => ({
      level: "log",
      message: `pre-${i}`,
    }));
    run.state.errorLogs.push(...prefill);

    await handleWorkerMessage(run, { type: "log", message: "the-latest" }, deps, makeHandlers());

    expect(run.state.errorLogs).toHaveLength(MAX_ERROR_LOGS);
    expect(run.state.errorLogs.at(-1)).toEqual({ level: "log", message: "the-latest" });
    expect(run.state.errorLogs[0]).toEqual({ level: "log", message: "pre-1" }); // 头部被裁
  });

  it("[B-3] log 单通路：log 消息即时入账 + return workerLogs（仅 console.* 条目）→ 同一日志恰一份", async () => {
    // worker 侧 [B-3] 后的产出形态（worker-script-builder-runtime.test.ts 锁定）：
    // log() 只发独立 {type:"log"} 消息，return 的 workerLogs 只含 console.* 捕获条目。
    // 主线程两条消息各走各的入账 → 同一日志在 errorLogs 恰一份（旧双通路为 2 份）。
    const run = makeRealRun("wf-log-dup");
    const deps = makeDeps();

    await handleWorkerMessage(run, { type: "log", phase: "build", message: "step-1" }, deps, makeHandlers());
    await handleWorkerMessage(
      run,
      { type: "return", result: { ok: true }, workerLogs: [{ level: "error", message: "console-entry" }] },
      deps,
      makeHandlers(),
    );

    expect(run.state.errorLogs.filter((l) => l.message === "step-1")).toHaveLength(1);
    expect(run.state.errorLogs.filter((l) => l.message === "console-entry")).toHaveLength(1);
  });

  it("未知消息类型：warn 留痕后丢弃（协议漂移防线），不写状态不终态", async () => {
    const warnSpy = vi.spyOn(getLogger("subagents"), "warn");
    const run = makeRealRun("wf-log-3");
    const deps = makeDeps();

    await handleWorkerMessage(run, { type: "future-unknown-type", payload: 1 }, deps, makeHandlers());

    expect(warnSpy.mock.calls.map((c) => String(c[0])).some((m) => m.includes("unknown worker message type") && m.includes("future-unknown-type"))).toBe(true);
    expect(deps.log).toHaveBeenCalledWith("warn", "workflow:worker-message-pump", "unknown worker message type", {
      runId: "wf-log-3",
      type: "future-unknown-type",
    });
    expect(run.state.status).toBe("running");
    expect(deps.store.save).not.toHaveBeenCalled();
  });
});

// ── [OR-8] run done 时 in-flight call 收口 cancelled ─────────

describe("[OR-8] run done 时残留 in-flight call 收口 cancelled", () => {
  it("fire-and-forget agent() 后 return：call 收口 done + trace failed（Cancelled 文案），快照无 running 节点", async () => {
    const run = makeRealRun("wf-or8-1");
    const deps = makeDeps();
    // fire-and-forget dispatch：runner 永不 settle（脚本不 await，模拟在飞子进程）
    deps.runner.run.mockImplementation(() => new Promise<AgentResult>(() => {}));
    await handleWorkerMessage(run, makeAgentCallMsg(1), deps, makeHandlers());
    await flushMicrotasks();
    expect(run.state.calls.get(1)?.status).toBe("running");

    // 脚本 return（fire-and-forget call 仍在飞）
    await handleWorkerMessage(run, { type: "return", result: "done early" }, deps, makeHandlers());

    expect(run.state.status).toBe("done");
    const call = run.state.calls.get(1);
    // call 收口为 done + 取消文案（不删除条目——保留调用痕迹）
    expect(call?.status).toBe("done");
    expect(call?.result?.error).toContain("Cancelled");
    // trace 节点 failed + completedAt（快照/GUI 不再显示 running 步骤）
    const node = run.state.trace.find(1);
    expect(node?.status).toBe("failed");
    expect(node?.error).toContain("Cancelled");
    expect(node?.completedAt).toBeDefined();
    // 持久化快照（收口先于 save）不含 running 形态
    const snap = toRunSnapshot(run);
    expect(snap.state.calls.map((c) => c.status)).toEqual(["done"]);
    expect(snap.state.trace.map((n) => n.status)).toEqual(["failed"]);
  });

  it("handleWorkerError 超限路径同样收口（failed 快照一致）", async () => {
    const run = makeRealRun("wf-or8-2");
    const deps = makeDeps();
    deps.runner.run.mockImplementation(() => new Promise<AgentResult>(() => {}));
    await handleWorkerMessage(run, makeAgentCallMsg(2), deps, makeHandlers());
    await flushMicrotasks();

    // 预置计数已达上限：count=4 > MAX → 无退避直接 failed（in-flight call 一并收口）
    (run.meta as { workerErrorCount?: number }).workerErrorCount = 3;
    await handleWorkerError(run, new Error("final boom"), deps, makeHandlers());

    expect(run.state.reason).toBe("failed");
    expect(run.state.calls.get(2)?.status).toBe("done");
    expect(run.state.calls.get(2)?.result?.error).toContain("Cancelled");
    expect(run.state.trace.find(2)?.status).toBe("failed");
  });

  it("closeOutInFlightCalls 对 pending 状态 call 补齐状态机（markRunning→markDone）", () => {
    const run = makeRealRun("wf-or8-3");
    const deps = makeDeps();
    deps.runner.run.mockImplementation(() => new Promise<AgentResult>(() => {}));
    void handleWorkerMessage(run, makeAgentCallMsg(3), deps, makeHandlers());
    // 直接构造 pending 形态（防御 pending 分支可达性）
    const call = run.state.calls.get(3)!;
    (call as { status: string }).status = "pending";

    const closed = closeOutInFlightCalls(run);

    expect(closed).toEqual([3]);
    expect(call.status).toBe("done");
    expect(call.result?.error).toContain("Cancelled");
  });

  it("无 in-flight call 时收口为 no-op（正常完成的 call 不受影响）", async () => {
    const run = makeRealRun("wf-or8-4");
    const deps = makeDeps();
    deps.runner.run.mockImplementation(
      async () => ({ content: "ok", durationMs: 1, error: undefined, toolCalls: [] }) as AgentResult,
    );
    await handleWorkerMessage(run, makeAgentCallMsg(4), deps, makeHandlers());
    await flushMicrotasks(20);
    expect(run.state.calls.get(4)?.status).toBe("done");

    await handleWorkerMessage(run, { type: "return", result: "ok" }, deps, makeHandlers());

    // 已完成 call 的结果原样保留（不被取消文案覆盖）
    expect(run.state.calls.get(4)?.result?.content).toBe("ok");
    expect(run.state.trace.find(4)?.status).toBe("completed");
  });
});
