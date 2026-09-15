/**
 * [F1] worker exit 无终态消息 → run failed（非悬挂）+ [SW-DATA-3] store.save 抛错不产生
 * unhandledRejection 的 handler 级回归测试。
 *
 * F1 背景：execute() 返回不可克隆值（function/Symbol/循环引用）→ worker 侧 _safePost 吞掉
 * DataCloneError → return 消息从未发出 → worker exit(0)。旧实现 handleWorkerExit 对
 * code===0 no-op → run 永久 running、runAndWait 无限挂起。
 *
 * 修复语义（本文件锚定）：
 * - exit(0) 且本 runtime 代际未收到 return/error 消息 → transition done,failed +
 *   WORKER_EXITED_WITHOUT_RESULT_MSG 归因 + pending:unregister + onRunDone
 * - exit(0) 但已收到终态消息（script-error 重试退避窗口）→ no-op（rebuild 即将发生）
 * - handleWorkerMessage 的 return/error 分支必须标记 receivedTerminalMessage（判定的依据）
 * - 非零 exit 行为不变（委托 handleWorkerError 重试矩阵）
 *
 * SW-DATA-3 背景：handleReturn / handleWorkerError / handleScriptError 的
 * `await deps.store.save(run)` 未捕获——ENOSPC 等落盘失败时 rejection 经 worker-host 的
 * `void handlers.onXxx(...)` 无人接 → unhandledRejection + pending:unregister / onRunDone
 * 不执行（pending 通知幽灵注销）。修复后 save 失败仅 logger.error，状态机继续推进。
 *
 * mock 构建参考 worker-message-pump-handlers.test.ts（plain-object WorkflowRun mock）。
 */
import { describe, expect, it, vi } from "vitest";

import {
  handleWorkerExit,
  handleWorkerMessage,
  handleScriptError,
  handleWorkerError,
} from "../worker-message-pump.ts";
import type { LifecycleDeps, WorkerHandlers } from "../models/ports.ts";
import type { DoneReason, RunStatus } from "../models/types.ts";
import type { WorkflowRun } from "../models/workflow-run.ts";
import type { WorkerHandle } from "../worker-handle.ts";

/** [F1] 归因文案——与 worker-message-pump.ts 常量一致（不直接 import 常量以锚定对外文案）。 */
const EXITED_WITHOUT_RESULT_MSG =
  "worker exited before delivering a result (return value may not be structured-cloneable)";

// ── helpers（对齐 worker-message-pump-handlers.test.ts）─────────────────

interface RunMockOpts {
  workerErrorCount?: number;
  scriptErrorCount?: number;
  /** 预置 receivedTerminalMessage（模拟 return/error 消息已送达）。 */
  receivedTerminalMessage?: boolean;
}

/** 构造一个 status="running" 的 mock WorkflowRun。 */
function makeRunningRun(opts: RunMockOpts = {}): WorkflowRun {
  return {
    runId: "wf-test",
    state: {
      status: "running",
      budget: { usedTokens: 0, usedCost: 0, isExceeded: () => false },
      errorLogs: [],
      calls: new Map(),
      trace: { removeByStepIndex: vi.fn(), append: vi.fn(), update: vi.fn() },
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
    },
    runtime: {
      worker: { postMessage: vi.fn() },
      receivedTerminalMessage: opts.receivedTerminalMessage,
    },
    transition(this: WorkflowRun, target: RunStatus, reason?: DoneReason): void {
      this.state.status = target;
      if (target === "done") this.state.reason = reason;
    },
    replaceRuntime(this: WorkflowRun, rt: NonNullable<WorkflowRun["runtime"]>): void {
      this.runtime = rt;
    },
  } as unknown as WorkflowRun;
}

/** LifecycleDeps mock：store/workerHost/eventBus/onRunDone 可观察。 */
function makeDeps(): LifecycleDeps & {
  store: { save: ReturnType<typeof vi.fn> };
  eventBus: { emit: ReturnType<typeof vi.fn> };
  onRunDone: ReturnType<typeof vi.fn>;
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

function makeHandlers(): WorkerHandlers {
  return {
    onMessage: vi.fn(async () => {}),
    onError: vi.fn(async () => {}),
    onExit: vi.fn(async () => {}),
  } as unknown as WorkerHandlers;
}

function makeHandle(isCurrent = true): WorkerHandle {
  return { isCurrent } as unknown as WorkerHandle;
}

// ── [F1] handleWorkerExit：exit(0) 无终态消息 → failed ──────────────

describe("handleWorkerExit — [F1] exit(0) 无终态消息", () => {
  it("exit(0) 且未收到 return/error → run 转 done,failed，归因 structured-cloneable，unregister + onRunDone", async () => {
    const run = makeRunningRun();
    const deps = makeDeps();

    await handleWorkerExit(run, 0, makeHandle(), deps, makeHandlers());

    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("failed");
    expect(run.state.error).toBe(EXITED_WITHOUT_RESULT_MSG);
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "pending:unregister",
      expect.objectContaining({ id: "wf-test", reason: "failed" }),
    );
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
    expect(deps.store.save).toHaveBeenCalledTimes(1);
  });

  it("exit(0) 但已收到终态消息（script-error 重试退避窗口）→ no-op，不被误判 failed", async () => {
    const run = makeRunningRun({ receivedTerminalMessage: true });
    const deps = makeDeps();

    await handleWorkerExit(run, 0, makeHandle(), deps, makeHandlers());

    expect(run.state.status).toBe("running");
    expect(deps.store.save).not.toHaveBeenCalled();
    expect(deps.eventBus.emit).not.toHaveBeenCalled();
    expect(deps.onRunDone).not.toHaveBeenCalled();
  });

  it("stale handle（isCurrent=false）仍被丢弃——修复不破坏 G-025", async () => {
    const run = makeRunningRun();
    const deps = makeDeps();

    await handleWorkerExit(run, 0, makeHandle(false), deps, makeHandlers());

    expect(run.state.status).toBe("running");
    expect(deps.onRunDone).not.toHaveBeenCalled();
  });

  it("已终态（done）的 run 不受影响", async () => {
    const run = makeRunningRun();
    run.transition("done", "completed");
    const deps = makeDeps();

    await handleWorkerExit(run, 0, makeHandle(), deps, makeHandlers());

    expect(run.state.reason).toBe("completed");
    expect(deps.onRunDone).not.toHaveBeenCalled();
  });

  it("非零 exit 行为不变：委托 handleWorkerError（未超限 → 退避后 rebuild 重试，不直接 failed）", async () => {
    // fake timers 跳过 scheduleRebuild 的真实 1s 退避
    vi.useFakeTimers();
    try {
      const run = makeRunningRun();
      const deps = makeDeps();
      const handlers = makeHandlers();

      const pending = handleWorkerExit(run, 1, makeHandle(), deps, handlers);
      await vi.advanceTimersByTimeAsync(1000); // 退避 1s → 触发 rebuildRuntime
      await pending;

      // 未超限 → rebuild（workerHost.start 重建），run 保持 running、不判 failed
      expect(run.state.status).toBe("running");
      expect(run.meta.workerErrorCount).toBe(1);
      expect(deps.workerHost.start).toHaveBeenCalledTimes(1);
      expect(deps.onRunDone).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── [R4-F1] handleWorkerError：error + exit(1) 同代际双派发只计一次 ────

describe("handleWorkerError — [R4-F1] 同代际双事件幂等", () => {
  it("worker 崩溃：error 事件先到（退避窗口内）+ exit(1) 委托二次到达 → 只计一次、只 rebuild 一次", async () => {
    // 真实时序：worker 崩溃 → onError 与 exit 几乎同时触发。handleWorkerError 进入
    // scheduleRebuild 的退避 delay（未完成）时 exit(1) 到达 handleWorkerExit → 委托
    // handleWorkerError 二次进入。旧实现在此处重复计数 + 第二个 scheduleRebuild
    //（单次崩溃 workerErrorCount +2、双 rebuild 交错）。
    vi.useFakeTimers();
    try {
      const run = makeRunningRun();
      const deps = makeDeps();
      const handlers = makeHandlers();

      // 第一次：uncaught error 事件（进入退避 delay，不 await 完成）
      const p1 = handleWorkerError(run, new Error("worker crashed"), deps, handlers);
      // 第二次：exit(1) 在退避窗口内到达（runtime 尚未被 replace，同代际）
      const p2 = handleWorkerExit(run, 1, makeHandle(), deps, handlers);
      await vi.advanceTimersByTimeAsync(1000); // 跳过退避 → 第一个事件的 rebuild 执行
      await Promise.all([p1, p2]);

      // 双事件只处理一次：计数 +1（非 +2）、单次 rebuild、run 保持 running
      expect(run.meta.workerErrorCount).toBe(1);
      expect(deps.workerHost.start).toHaveBeenCalledTimes(1);
      expect(run.state.status).toBe("running");
      expect(deps.onRunDone).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("幂等守卫不误伤新代际：rebuild 后新 worker 的 error 正常处理（计数/重建各自 +1）", async () => {
    vi.useFakeTimers();
    try {
      const run = makeRunningRun();
      const deps = makeDeps();
      const handlers = makeHandlers();

      // 第一代：error → 标记本代际 → 退避 → rebuild（新 RunRuntime，标志重置 false）
      const p1 = handleWorkerError(run, new Error("crash gen-1"), deps, handlers);
      await vi.advanceTimersByTimeAsync(1000);
      await p1;
      expect(deps.workerHost.start).toHaveBeenCalledTimes(1);

      // 新代际（rebuildRuntime 构造的真 RunRuntime 实例）标志为 false
      expect((run.runtime as { receivedTerminalMessage?: boolean }).receivedTerminalMessage).toBe(false);

      // 新代际再崩 → 正常走重试矩阵（计数 2、第二次 rebuild）
      const p2 = handleWorkerError(run, new Error("crash gen-2"), deps, handlers);
      // 第二次重试退避是指数值 backoffDelay(2) = 1000×2 = 2000ms，非 1000
      await vi.advanceTimersByTimeAsync(2000);
      await p2;

      expect(run.meta.workerErrorCount).toBe(2);
      expect(deps.workerHost.start).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("超限路径同样幂等：error + exit(1) 双到达只转一次 done,failed（onRunDone 只调一次）", async () => {
    vi.useFakeTimers();
    try {
      // 预置 workerErrorCount = MAX（3）：本次 error 计数到 4 → 超限 → done,failed
      const run = makeRunningRun({ workerErrorCount: 3 });
      const deps = makeDeps();
      const handlers = makeHandlers();

      const p1 = handleWorkerError(run, new Error("worker crashed"), deps, handlers);
      const p2 = handleWorkerExit(run, 1, makeHandle(), deps, handlers);
      await Promise.all([p1, p2]);

      expect(run.meta.workerErrorCount).toBe(4); // 只 +1
      expect(run.state.status).toBe("done");
      expect(run.state.reason).toBe("failed");
      expect(deps.onRunDone).toHaveBeenCalledTimes(1);
      expect(deps.eventBus.emit).toHaveBeenCalledTimes(1); // 单次 unregister，无重复
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── [F1] handleWorkerMessage：return/error 标记 receivedTerminalMessage ────

describe("handleWorkerMessage — [F1] 终态消息标记", () => {
  it("return 消息将 runtime.receivedTerminalMessage 置 true，随后正常 transition done,completed", async () => {
    const run = makeRunningRun();
    const deps = makeDeps();

    await handleWorkerMessage(run, { type: "return", result: { ok: 1 } }, deps, makeHandlers());

    expect((run.runtime as { receivedTerminalMessage?: boolean }).receivedTerminalMessage).toBe(true);
    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("completed");
  });

  it("error 消息同样置 true——在 rebuild 前的退避窗口内捕获（replaceRuntime 前 start 时刻）", async () => {
    // 断言时机说明：标记的生命周期是「本 runtime 代际」。await 整个 handleWorkerMessage
    // 后 scheduleRebuild 已完成 replaceRuntime，runtime 已换新代际（flag=false 属正确语义）。
    // 真正需要标记保护的窗口是退避期间（旧 worker exit(0) 到达、run.runtime 仍指向旧代际），
    // 故在 rebuildRuntime 调 workerHost.start 的时刻（replaceRuntime 之前）捕获。
    vi.useFakeTimers();
    try {
      const run = makeRunningRun();
      const deps = makeDeps();
      let flagAtRebuildStart: boolean | undefined;
      (deps.workerHost.start as ReturnType<typeof vi.fn>).mockImplementation(() => {
        flagAtRebuildStart = (run.runtime as { receivedTerminalMessage?: boolean }).receivedTerminalMessage;
        return { postMessage: vi.fn() };
      });

      const pending = handleWorkerMessage(run, { type: "error", error: "boom" }, deps, makeHandlers());
      await vi.advanceTimersByTimeAsync(1000); // 跳过 scheduleRebuild 真实 1s 退避
      await pending;

      expect(flagAtRebuildStart).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── [SW-DATA-3] store.save 抛错 → 不产生 unhandledRejection，状态机继续 ────

describe("store.save 抛错（ENOSPC 等）— [SW-DATA-3] 不阻断终态推进", () => {
  it("handleReturn（经 handleWorkerMessage return 分支）：save reject 被吸收，unregister + onRunDone 照常", async () => {
    const run = makeRunningRun();
    const deps = makeDeps();
    deps.store.save.mockRejectedValue(new Error("ENOSPC: no space left on device"));

    // 旧实现：await 裸抛 → handleWorkerMessage reject（worker-host 侧 void 掉）→
    // unhandledRejection + 幽灵注销。修复后必须正常 resolve。
    await expect(
      handleWorkerMessage(run, { type: "return", result: { ok: 1 } }, deps, makeHandlers()),
    ).resolves.toBeUndefined();

    expect(run.state.status).toBe("done");
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "pending:unregister",
      expect.objectContaining({ id: "wf-test" }),
    );
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
  });

  it("handleWorkerError 重试超限：save reject 被吸收，终态 + 通知照常", async () => {
    const run = makeRunningRun({ workerErrorCount: 3 });
    const deps = makeDeps();
    deps.store.save.mockRejectedValue(new Error("ENOSPC: no space left on device"));

    await expect(
      handleWorkerError(run, new Error("worker crash"), deps, makeHandlers()),
    ).resolves.toBeUndefined();

    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("failed");
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "pending:unregister",
      expect.objectContaining({ id: "wf-test", reason: "failed" }),
    );
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
  });

  it("handleScriptError 重试超限：save reject 被吸收，终态 + 通知照常", async () => {
    const run = makeRunningRun({ scriptErrorCount: 3 });
    const deps = makeDeps();
    deps.store.save.mockRejectedValue(new Error("ENOSPC: no space left on device"));

    await expect(
      handleScriptError(run, "script boom", [], deps, makeHandlers()),
    ).resolves.toBeUndefined();

    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("failed");
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "pending:unregister",
      expect.objectContaining({ id: "wf-test", reason: "failed" }),
    );
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
  });
});
