/**
 * [OR-3] abort 广播（主线程半边）+ [OR-7] signal abort listener 终态移除 测试。
 *
 * 覆盖（unbounded-wait-audit §4.3 OR-7 / §7.2 T3③⑥ / §7.3 P-T3 主线程半边）：
 * - abortRun / terminateRunningRuns 在 worker.terminate 之前向 worker 广播
 *   {type:"abort", reason}（worker 侧 pending 优雅解阻，P-T3）；postMessage 抛错
 *   （worker 已退出）不阻断 abort 主流程；runtime 缺失为 no-op
 * - abort listener 注册后，run 经任意终态路径收敛时 removeEventListener：
 *   abortRun（用户/预算/超时 abort）、terminateRunningRuns（session 切换）、
 *   消息面终态（return → onRunDone 包装收口）——修复 {once:true} 只在 abort
 *   触发时自清的泄漏（同 signal 连续多 run 泄漏 listener）
 * - [OR-8] abortRun 收口残留 in-flight call（先收口再落盘）
 */
import { getEventListeners } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  abortRun,
  runWorkflow,
  terminateRunningRuns,
} from "../lifecycle.ts";
import { AgentCall } from "../models/agent-call.ts";
import { RunRuntime } from "../models/run-runtime.ts";
import { Trace } from "../models/trace.ts";
import type { RunSpec } from "../models/run-spec.ts";
import type { LifecycleDeps, WorkerHandlers } from "../models/ports.ts";
import type { AgentResult, ExecutionTraceNode } from "../models/types.ts";
import { WorkflowRun } from "../models/workflow-run.ts";
import type { WorkerHandle } from "../worker-handle.ts";

// ── helpers ──────────────────────────────────────────────────

function makeSpec(): RunSpec {
  return {
    scriptSource: "execute() {}",
    args: {},
    scriptName: "test-wf",
    scriptPath: "/fake/test.js",
  };
}

function makeDeps(): LifecycleDeps & {
  store: { save: ReturnType<typeof vi.fn>; loadAll: ReturnType<typeof vi.fn> };
  workerHost: { start: ReturnType<typeof vi.fn> };
  eventBus: { emit: ReturnType<typeof vi.fn> };
  onRunDone: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
} {
  return {
    store: { save: vi.fn(async () => {}), loadAll: vi.fn(async () => []) },
    workerHost: {
      start: vi.fn(
        () => ({ postMessage: vi.fn(), terminate: vi.fn(async () => {}) }) as unknown as WorkerHandle,
      ),
    },
    runner: { run: vi.fn(async () => ({}) as AgentResult) },
    runs: new Map(),
    eventBus: { emit: vi.fn() },
    onRunDone: vi.fn(),
    log: vi.fn(),
  } as unknown as ReturnType<typeof makeDeps>;
}

/** 从 mock worker 提取 postMessage spy。 */
function postSpy(handle: unknown): ReturnType<typeof vi.fn> {
  return (handle as { postMessage: ReturnType<typeof vi.fn> }).postMessage;
}

/** 从 workerHost.start mock 取第 n 次启动的 handle。 */
function startedHandle(deps: ReturnType<typeof makeDeps>, n = 0): unknown {
  return deps.workerHost.start.mock.results[n]?.value;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── [OR-3] abort 广播（主线程半边） ──────────────────────────

describe("[OR-3] abort 广播（abortRun / terminateRunningRuns）", () => {
  it("abortRun：在 terminate 之前向 worker 广播 {type:\"abort\", reason}", async () => {
    const deps = makeDeps();
    const runId = await runWorkflow(makeSpec(), deps);
    const handle = startedHandle(deps);
    const post = postSpy(handle);
    const terminate = (handle as { terminate: ReturnType<typeof vi.fn> }).terminate;
    post.mockClear();

    await abortRun(runId, deps, "user requested abort");

    expect(post).toHaveBeenCalledWith({ type: "abort", reason: "user requested abort" });
    // 顺序锚：广播先于 terminate（terminate 后广播发不进去）
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(post.mock.invocationCallOrder[0]).toBeLessThan(terminate.mock.invocationCallOrder[0]);
    expect(deps.runs.get(runId)?.state.reason).toBe("aborted");
  });

  it("abortRun 未传 reason：广播 reason 带 doneReason（time_limited 场景可归因）", async () => {
    const deps = makeDeps();
    const runId = await runWorkflow(makeSpec(), deps);
    postSpy(startedHandle(deps)).mockClear();

    await abortRun(runId, deps, undefined, "time_limited");

    expect(postSpy(startedHandle(deps))).toHaveBeenCalledWith(
      { type: "abort", reason: "Workflow aborted (time_limited)" },
    );
  });

  it("postMessage 同步抛错（worker 已退出）：不阻断 abort 主流程（P-T3）", async () => {
    const deps = makeDeps();
    const runId = await runWorkflow(makeSpec(), deps);
    const handle = startedHandle(deps);
    postSpy(handle).mockImplementation(() => {
      throw new Error("postMessage after worker exited");
    });

    await expect(abortRun(runId, deps, "abort despite dead worker")).resolves.toBeUndefined();

    // transition / 持久化照常完成（save 2 次 = runWorkflow 启动 1 次 + abortRun 1 次）
    expect(deps.runs.get(runId)?.state.reason).toBe("aborted");
    expect(deps.store.save).toHaveBeenCalledTimes(2);
    expect(deps.eventBus.emit).toHaveBeenCalledWith("pending:unregister", expect.anything());
  });

  it("runtime 缺失（无 worker）：广播 no-op，abort 照常", async () => {
    const deps = makeDeps();
    const runId = await runWorkflow(makeSpec(), deps);
    const run = deps.runs.get(runId)!;
    run.runtime = undefined;

    await expect(abortRun(runId, deps, "no runtime")).resolves.toBeUndefined();
    expect(run.state.reason).toBe("aborted");
  });

  it("terminateRunningRuns：每个 running run 各自广播（先于 terminate）", async () => {
    const deps = makeDeps();
    const idA = await runWorkflow(makeSpec(), deps);
    const idB = await runWorkflow(makeSpec(), deps);
    const handleA = startedHandle(deps, 0);
    const handleB = startedHandle(deps, 1);
    postSpy(handleA).mockClear();
    postSpy(handleB).mockClear();

    await terminateRunningRuns(deps, "Session switched: run terminated");

    expect(postSpy(handleA)).toHaveBeenCalledWith({ type: "abort", reason: "Session switched: run terminated" });
    expect(postSpy(handleB)).toHaveBeenCalledWith({ type: "abort", reason: "Session switched: run terminated" });
    expect(deps.runs.get(idA)?.state.reason).toBe("failed");
    expect(deps.runs.get(idB)?.state.reason).toBe("failed");
  });

  it("[OR-8] abortRun 收口残留 in-flight call：先收口再落盘，快照无 running 节点", async () => {
    const deps = makeDeps();
    const runId = await runWorkflow(makeSpec(), deps);
    const run = deps.runs.get(runId)!;
    // 注入 in-flight call（真实 AgentCall 实例：running）
    const node: ExecutionTraceNode = {
      stepIndex: 1,
      agent: "a",
      task: "t",
      model: "m",
      status: "running",
    };
    run.state.trace.append(node);
    const call = new AgentCall(1, { prompt: "t" }, node);
    call.markRunning();
    run.state.calls.set(1, call);

    await abortRun(runId, deps, "mid-flight abort");

    // 收口：call done + trace failed（Cancelled 文案；[H2 W3] trace.live 已删除）
    expect(call.status).toBe("done");
    expect(call.result?.error).toContain("Cancelled");
    expect(run.state.trace.find(1)?.status).toBe("failed");
    // 落盘在收口之后：save 时 run 已无 running 节点
    expect(run.state.trace.toArray().every((n) => n.status !== "running")).toBe(true);
  });
});

// ── [OR-7] signal abort listener 终态移除 ────────────────────

describe("[OR-7] signal abort listener run 终态移除", () => {
  /** 构造带 spy 的 controller（记录 add/remove 的 listener，原行为保留）。 */
  function makeSignal(): {
    controller: AbortController;
    added: Array<() => void>;
    removed: Array<() => void>;
  } {
    const controller = new AbortController();
    const added: Array<() => void> = [];
    const removed: Array<() => void> = [];
    const origAdd = controller.signal.addEventListener.bind(controller.signal);
    const origRemove = controller.signal.removeEventListener.bind(controller.signal);
    vi.spyOn(controller.signal, "addEventListener").mockImplementation(
      (type: string, listener: EventListenerOrEventListenerObject, options?: unknown): void => {
        added.push(listener as () => void);
        origAdd(type as "abort", listener, options as never);
      },
    );
    vi.spyOn(controller.signal, "removeEventListener").mockImplementation(
      (type: string, listener: EventListenerOrEventListenerObject, options?: unknown): void => {
        removed.push(listener as () => void);
        origRemove(type as "abort", listener, options as never);
      },
    );
    return { controller, added, removed };
  }

  it("abortRun 终止 run → removeEventListener（listener 不残留）", async () => {
    const deps = makeDeps();
    const { controller, added, removed } = makeSignal();

    const runId = await runWorkflow(makeSpec(), deps, controller.signal);
    expect(added).toHaveLength(1);
    expect(removed).toHaveLength(0);

    await abortRun(runId, deps, "user abort");

    expect(removed).toEqual([added[0]]);
    // 手动再派发 abort 事件：listener 已移除，无任何 abort 副作用
    const emitSpy = deps.eventBus.emit;
    emitSpy.mockClear();
    controller.signal.dispatchEvent(new Event("abort"));
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("消息面终态（worker return → onRunDone）→ removeEventListener（不再泄漏）", async () => {
    const deps = makeDeps();
    const { controller, added, removed } = makeSignal();

    const runId = await runWorkflow(makeSpec(), deps, controller.signal);
    const handle = startedHandle(deps);
    // 捕获 makeHandlers 构造的 handlers（workerHost.start 的第 3 参）并投递 return
    const handlers = deps.workerHost.start.mock.calls[0]?.[2] as WorkerHandlers;
    await handlers.onMessage({ type: "return", result: { ok: true } });

    expect(deps.runs.get(runId)?.state.reason).toBe("completed");
    expect(removed).toEqual([added[0]]);
    expect(postSpy(handle).mock.calls.some((c) => (c[0] as { type?: string })?.type === "abort")).toBe(false);
  });

  it("terminateRunningRuns 终止 → removeEventListener（不走 onRunDone 的路径也收口）", async () => {
    const deps = makeDeps();
    const { controller, added, removed } = makeSignal();

    await runWorkflow(makeSpec(), deps, controller.signal);
    expect(removed).toHaveLength(0);

    await terminateRunningRuns(deps, "session switch");

    expect(removed).toEqual([added[0]]);
  });

  it("signal 触发 abort → listener 自移除（显式 once 语义）且 run 转 aborted", async () => {
    const deps = makeDeps();
    const { controller, added, removed } = makeSignal();

    const runId = await runWorkflow(makeSpec(), deps, controller.signal);
    controller.abort();

    await vi.advanceTimersByTimeAsync(0);
    expect(deps.runs.get(runId)?.state.reason).toBe("aborted");
    expect(removed).toEqual([added[0]]);
  });

  it("同一 signal 连续跑 12 个 run（逐一终态）→ 同时刻至多 1 个 listener（无累积）", async () => {
    const deps = makeDeps();
    const controller = new AbortController();
    let live = 0;
    let peak = 0;
    const origAdd = controller.signal.addEventListener.bind(controller.signal);
    const origRemove = controller.signal.removeEventListener.bind(controller.signal);
    vi.spyOn(controller.signal, "addEventListener").mockImplementation(
      (type: string, listener: EventListenerOrEventListenerObject, options?: unknown): void => {
        live += 1;
        peak = Math.max(peak, live);
        origAdd(type as "abort", listener, options as never);
      },
    );
    vi.spyOn(controller.signal, "removeEventListener").mockImplementation(
      (type: string, listener: EventListenerOrEventListenerObject, options?: unknown): void => {
        live -= 1;
        origRemove(type as "abort", listener, options as never);
      },
    );

    for (let i = 0; i < 12; i++) {
      const runId = await runWorkflow(makeSpec(), deps, controller.signal);
      await abortRun(runId, deps, `done ${i}`);
    }

    expect(peak).toBe(1);
    expect(live).toBe(0);
  });

  it("终态后 listener 不再触发 abortRun（完成态不被迟到的 signal abort 改写）", async () => {
    const deps = makeDeps();
    const controller = new AbortController();
    const runId = await runWorkflow(makeSpec(), deps, controller.signal);

    // 正常完成
    const handlers = deps.workerHost.start.mock.calls[0]?.[2] as WorkerHandlers;
    await handlers.onMessage({ type: "return", result: "ok" });
    expect(deps.runs.get(runId)?.state.reason).toBe("completed");

    // 完成后外部 signal 才 abort——listener 已移除，run 保持 completed（不被改写）
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.runs.get(runId)?.state.reason).toBe("completed");
    expect(deps.store.save).toHaveBeenCalledTimes(2); // runWorkflow 启动 + return 各 1 次
  });
});

// ── [B-2] fail-fast throw 路径不泄漏 signal abort listener ──────────────

describe("[B-2] runWorkflow fail-fast throw 路径不泄漏 signal abort listener", () => {
  /** signal 上当前真实挂载的 abort listener 数（EventTarget 权威查询，非 spy 计数）。 */
  function liveListenerCount(signal: AbortSignal): number {
    return getEventListeners(signal, "abort").length;
  }

  it("budgetTimeMs 越界 fail-fast 重试 12 次 → 每次拒绝后 listener 计数归零（无 MaxListeners 累积）", async () => {
    const deps = makeDeps();
    const controller = new AbortController();
    // 越界值（>2^31-1）→ assertSafeTimerDelay 在 scheduleTimeBudget 内 fail-fast throw
    const spec: RunSpec = { ...makeSpec(), budgetTimeMs: 3_000_000_000 };

    for (let i = 0; i < 12; i++) {
      await expect(runWorkflow(spec, deps, controller.signal)).rejects.toThrow(/2147483647/);
      // 旧实现 listener 先注册、throw 路径不 dispose——12 次重试后泄漏 12 个
      expect(liveListenerCount(controller.signal)).toBe(0);
    }
    expect(deps.runs.size).toBe(0); // fail-fast：无孤儿 run
  });

  it("workerHost.start 抛错重试 12 次 → 每次拒绝后 listener 计数归零", async () => {
    const deps = makeDeps();
    deps.workerHost.start = vi.fn(() => {
      throw new Error("worker boot failed");
    });
    const controller = new AbortController();

    for (let i = 0; i < 12; i++) {
      await expect(runWorkflow(makeSpec(), deps, controller.signal)).rejects.toThrow("worker boot failed");
      expect(liveListenerCount(controller.signal)).toBe(0);
    }
    expect(deps.runs.size).toBe(0);
  });
});
