/**
 * finalizeRun — D5-② 终态 coda 单写点测试。
 *
 * 「transition → save → pending:unregister → onRunDone」四步终态序列的唯一
 * 定义点（worker-message-pump.ts）。收敛前 8 处逐字复制（本文件 6 处 + lifecycle
 * 2 处）——本文件锁定：
 * 1. 四步恰好一次且有序（transition 先于 save 先于 unregister 先于 onRunDone）
 * 2. notifyDone:false 真差异承载（terminateRunningRuns 不发 onRunDone、unregister 仍发）
 * 3. transition 让位（并发终态化）→ 后三步全不执行
 * 4. save best-effort（SW-DATA-3）→ unregister/onRunDone 不被落盘失败短路
 *
 * 其余终态路径的「恰好一次四步」行为断言（save×1 + unregister + onRunDone×1）
 * 已由既有测试覆盖：handleWorkerError/handleScriptError/handleWorkerExit 超限
 * （worker-message-pump-handlers / worker-exit-without-result）、time_limited
 * （worker-message-pump-handlers race-F3 describe）、abortRun（lifecycle.test）、
 * handleReturn（worker-exit-without-result SW-DATA-3 describe）。本文件补齐
 * budget_limited 路径（dispatchAgentCall coda）与 notifyDone:false 路径。
 */
import { describe, expect, it, vi } from "vitest";

import {
  finalizeRun,
  handleWorkerMessage,
} from "../worker-message-pump.ts";
import { Budget } from "../models/budget.ts";
import { RunRuntime } from "../models/run-runtime.ts";
import { Trace } from "../models/trace.ts";
import type { AgentResult } from "../models/types.ts";
import { WorkflowRun } from "../models/workflow-run.ts";
import type { LifecycleDeps, WorkerHandlers } from "../models/ports.ts";
import type { WorkerHandle } from "../worker-handle.ts";

// ── helpers ──────────────────────────────────────────────────

/** 构造真实 WorkflowRun（真实状态机 transition）+ 初始 runtime。 */
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

/** deps mock：副作用打点进单一顺序数组（断言四步顺序）。 */
function makeTracingDeps(): LifecycleDeps & {
  order: string[];
  store: { save: ReturnType<typeof vi.fn> };
} {
  const order: string[] = [];
  return {
    order,
    store: {
      save: vi.fn(async () => {
        order.push("save");
      }),
    },
    workerHost: { start: vi.fn(() => ({ postMessage: vi.fn() })) },
    runner: { run: vi.fn(async () => ({}) as AgentResult) },
    runs: new Map(),
    eventBus: {
      emit: vi.fn((event: string) => {
        order.push(`emit:${event}`);
      }),
    },
    onRunDone: vi.fn(() => {
      order.push("onRunDone");
    }),
    log: vi.fn(),
  } as unknown as ReturnType<typeof makeTracingDeps>;
}

/** flush 微任务队列（void finalizeRun 的 async 链推进到稳定态）。 */
async function flushMicrotasks(ticks = 20): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    // eslint-disable-next-line no-await-in-loop -- 排空微任务队列的固定 tick 循环，非逐项等待
    await Promise.resolve();
  }
}

// ── finalizeRun 直测 ─────────────────────────────────────────

describe("finalizeRun（D5-② 单写点直测）", () => {
  it("四步恰好一次且有序：transition → save → pending:unregister → onRunDone", async () => {
    const run = makeRealRun("wf-fin-1");
    const deps = makeTracingDeps();

    const transitionSpy = vi.spyOn(run, "transition");
    const ok = await finalizeRun(run, deps, "completed", { context: "test" });

    expect(ok).toBe(true);
    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("completed");
    // 四步各恰好一次
    expect(transitionSpy).toHaveBeenCalledTimes(1);
    expect(deps.store.save).toHaveBeenCalledTimes(1);
    expect(deps.eventBus!.emit).toHaveBeenCalledTimes(1);
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
    // 顺序：save → unregister → onRunDone（transition 已同步先行）
    expect(deps.order).toEqual(["save", "emit:pending:unregister", "onRunDone"]);
    // unregister reason = transition 后的 state.reason
    expect(deps.eventBus!.emit).toHaveBeenCalledWith("pending:unregister", {
      id: "wf-fin-1",
      reason: "completed",
    });
  });

  it("notifyDone:false → onRunDone 不调、unregister 仍发（terminateRunningRuns 真差异经参数承载）", async () => {
    const run = makeRealRun("wf-fin-2");
    const deps = makeTracingDeps();

    const ok = await finalizeRun(run, deps, "failed", {
      context: "terminateRunningRuns",
      notifyDone: false,
    });

    expect(ok).toBe(true);
    expect(run.state.reason).toBe("failed");
    expect(deps.eventBus!.emit).toHaveBeenCalledTimes(1);
    expect(deps.eventBus!.emit).toHaveBeenCalledWith("pending:unregister", {
      id: "wf-fin-2",
      reason: "failed",
    });
    expect(deps.onRunDone).not.toHaveBeenCalled();
    expect(deps.order).toEqual(["save", "emit:pending:unregister"]);
  });

  it("transition 抛错（并发 abort 抢先终态化）→ 返回 false，后三步全不执行", async () => {
    const run = makeRealRun("wf-fin-3");
    // 抢先终态化——此后 running→done 转移抛 illegal-transition
    run.transition("done", "aborted");
    const deps = makeTracingDeps();

    const ok = await finalizeRun(run, deps, "failed", { context: "test" });

    expect(ok).toBe(false);
    // 抢先方已兑现 unregister/onRunDone——本路径让位，不重复执行
    expect(deps.store.save).not.toHaveBeenCalled();
    expect(deps.eventBus!.emit).not.toHaveBeenCalled();
    expect(deps.onRunDone).not.toHaveBeenCalled();
    expect(run.state.reason).toBe("aborted");
  });

  it("save 抛错（ENOSPC）→ best-effort：unregister + onRunDone 照常（SW-DATA-3 统一）", async () => {
    const run = makeRealRun("wf-fin-4");
    const deps = makeTracingDeps();
    deps.store.save = vi.fn(async () => {
      throw new Error("ENOSPC: no space left on device");
    });

    const ok = await finalizeRun(run, deps, "failed", { context: "test" });

    expect(ok).toBe(true);
    expect(run.state.status).toBe("done");
    expect(deps.eventBus!.emit).toHaveBeenCalledTimes(1);
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
  });

  it("onRunDone 抛错 → 被捕获记日志（M12：真实副作用错误不静默吞、不上抛）", async () => {
    const run = makeRealRun("wf-fin-5");
    const deps = makeTracingDeps();
    deps.onRunDone = vi.fn(() => {
      throw new Error("interface notify blew up");
    });

    await expect(
      finalizeRun(run, deps, "completed", { context: "test" }),
    ).resolves.toBe(true);
    expect(deps.eventBus!.emit).toHaveBeenCalledTimes(1);
    expect(run.state.status).toBe("done");
  });
});

// ── budget_limited 路径（dispatchAgentCall coda）四步恰好一次 ────────────

describe("budget_limited 终态路径（dispatchAgentCall → finalizeRun）", () => {
  it("agent call 后预算超限 → 四步恰好一次（unregister reason=budget_limited + onRunDone）", async () => {
    const run = makeRealRun("wf-budget-1");
    const deps = makeTracingDeps();
    // budget.isExceeded 恒 true——runner.run 成功返回后命中 C-2 coda
    (run.state.budget as unknown as { isExceeded: () => boolean }).isExceeded =
      () => true;
    deps.runner.run = vi.fn(async () =>
      ({ content: "ok", durationMs: 1, error: undefined, toolCalls: [] }) as AgentResult,
    );
    const handlers: WorkerHandlers = {
      onMessage: vi.fn(async () => {}),
      onError: vi.fn(async () => {}),
      onExit: vi.fn(async () => {}),
    };

    await handleWorkerMessage(
      run,
      { type: "agent-call", callId: 1, opts: { prompt: "p", description: "d" } },
      deps,
      handlers,
    );
    await flushMicrotasks();

    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("budget_limited");
    // save 3 次 = dispatch 启动快照（8d52c0035 dispatch-time save，running 步骤
    // 实时可见）+ call 完成快照（dispatchAgentCall .then 的常规持久化）+ budget
    // 终态快照（finalizeRun 内）——三次语义不同，收敛前后一致
    expect(deps.store.save).toHaveBeenCalledTimes(3);
    expect(deps.eventBus!.emit).toHaveBeenCalledTimes(1);
    expect(deps.eventBus!.emit).toHaveBeenCalledWith("pending:unregister", {
      id: "wf-budget-1",
      reason: "budget_limited",
    });
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
  });
});
