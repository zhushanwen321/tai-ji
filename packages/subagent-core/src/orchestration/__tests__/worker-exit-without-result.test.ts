/**
 * [F1] worker exit 无终态消息 → run failed（非悬挂）+ [SW-DATA-3] store.save 抛错不产生
 * unhandledRejection 的 handler 级回归测试。
 *
 * F1 背景：execute() 返回不可克隆值（function/Symbol/循环引用）→ worker 侧 _safePost 吞掉
 * DataCloneError → return 消息从未发出 → worker exit(0)。旧实现 handleWorkerExit 对
 * code===0 no-op → run 永久 running、无终态（消费方无限等待）。
 *
 * 修复语义（本文件锚定）：
 * - exit(0) 且本 runtime 代际未收到 return/error 消息 → transition done,failed +
 *   WORKER_EXITED_WITHOUT_RESULT_MSG 归因 + pending:unregister + onRunDone
 * - exit(0) 但已收到终态消息 → no-op（正常收尾）
 * - handleWorkerMessage 的 return/error 分支必须标记 receivedTerminalMessage（判定的依据）
 * - 非零 exit → 委托 handleWorkerError 一次即 failed（[ADR-0122] 原重试矩阵已删）
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
import {
  dispatchRunCreated,
} from "../terminal-actions.ts";
import type { LifecycleDeps, WorkerHandlers } from "../models/ports.ts";
import type { WorkflowRun } from "../models/workflow-run.ts";
import type { WorkerHandle } from "../worker-handle.ts";
// [W2/V1] 六态机引导 + 终局断言换源（两态机字段停更——终局经注册表判定/派生）。
import { isRunSettled, noteRebuiltSettlement, settledRecordOf } from "../terminal-actions.ts";

/** [F1] 归因文案——与 worker-message-pump.ts 常量一致（不直接 import 常量以锚定对外文案）。 */
const EXITED_WITHOUT_RESULT_MSG =
  "worker exited before delivering a result (return value may not be structured-cloneable)";

// ── helpers（对齐 worker-message-pump-handlers.test.ts）─────────────────

interface RunMockOpts {
  /** 预置 receivedTerminalMessage（模拟 return/error 消息已送达）。 */
  receivedTerminalMessage?: boolean;
}

/** 构造一个 status="running" 的 mock WorkflowRun。
 *  [W2/V1] runId 唯一化（模块级 liveRunStates/终局注册表按 runId 键控——常量 id
 *  会跨测试污染）+ releaseRuntime 桩（finalizeRun 显式释放，原两态机 transition
 *  内联副作用随写点删除上提）。 */
let runSeq = 0;
function makeRunningRun(opts: RunMockOpts = {}): WorkflowRun {
  return {
    runId: `wf-test-${++runSeq}`,
    state: {
      budget: { usedTokens: 0, usedCost: 0, isExceeded: () => false },
      errorLogs: [],
      calls: new Map(),
      trace: { removeByStepIndex: vi.fn(), append: vi.fn(), update: vi.fn() },
    },
    meta: {
      startedAt: new Date().toISOString(),
    },
    spec: {
      scriptName: "test-wf",
      scriptSource: "async function execute() {}",
      args: {},
    },
    runtime: {
      worker: { postMessage: vi.fn() },
      receivedTerminalMessage: opts.receivedTerminalMessage,
    },
    replaceRuntime(this: WorkflowRun, rt: NonNullable<WorkflowRun["runtime"]>): void {
      this.runtime = rt;
    },
    releaseRuntime: vi.fn(),
  } as unknown as WorkflowRun;
}

/** LifecycleDeps mock：store/workerHost/eventBus/appendEntry/onRunDone 可观察。 */
function makeDeps(): LifecycleDeps & {
  store: { save: ReturnType<typeof vi.fn> };
  eventBus: { emit: ReturnType<typeof vi.fn> };
  appendEntry: ReturnType<typeof vi.fn>;
  onRunDone: ReturnType<typeof vi.fn>;
} {
  return {
    store: { save: vi.fn(async () => {}) },
    workerHost: { start: vi.fn(() => ({ postMessage: vi.fn() })) },
    runner: { run: vi.fn(async () => ({})) },
    runs: new Map(),
    eventBus: { emit: vi.fn() },
    appendEntry: vi.fn(),
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


/** [W2/V1] 六态机引导：journal 首帧（run-created）落账——finalizeRun/abortRun 等
 *  活体终局入口的六态机裁决要求 created→dispatched 已在链上（生产链路由
 *  runWorkflow 正点发射承接；直测终局入口的用例经本 helper 补齐同一引导）。 */
async function seedRunCreated(run: WorkflowRun): Promise<void> {
  await dispatchRunCreated(run);
}

describe("handleWorkerExit — [F1] exit(0) 无终态消息", () => {
  it("exit(0) 且未收到 return/error → run 转 done,failed，归因 structured-cloneable，unregister + onRunDone", async () => {
    const run = makeRunningRun();
    await seedRunCreated(run);
    const deps = makeDeps();

    await handleWorkerExit(run, 0, makeHandle(), deps, makeHandlers());

    expect(isRunSettled(run)).toBe(true);
    expect(settledRecordOf(run.runId)).toMatchObject({ outcome: "failed" });
    expect(run.state.error).toBe(EXITED_WITHOUT_RESULT_MSG);
    expect(deps.appendEntry).toHaveBeenCalledWith(
      "pending:unregister",
      expect.objectContaining({ id: run.runId, reason: "failed", status: "failed" }),
    );
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
    expect(deps.store.save).toHaveBeenCalledTimes(1);
  });

  it("exit(0) 但已收到终态消息 → no-op，不被误判 failed", async () => {
    const run = makeRunningRun({ receivedTerminalMessage: true });
    await seedRunCreated(run);
    const deps = makeDeps();

    await handleWorkerExit(run, 0, makeHandle(), deps, makeHandlers());

    expect(isRunSettled(run)).toBe(false);
    expect(deps.store.save).not.toHaveBeenCalled();
    expect(deps.eventBus.emit).not.toHaveBeenCalled();
    expect(deps.appendEntry).not.toHaveBeenCalled();
    expect(deps.onRunDone).not.toHaveBeenCalled();
  });

  it("stale handle（isCurrent=false）仍被丢弃——修复不破坏 G-025", async () => {
    const run = makeRunningRun();
    await seedRunCreated(run);
    const deps = makeDeps();

    await handleWorkerExit(run, 0, makeHandle(false), deps, makeHandlers());

    expect(isRunSettled(run)).toBe(false);
    expect(deps.onRunDone).not.toHaveBeenCalled();
  });

  it("已终态（done）的 run 不受影响", async () => {
    const run = makeRunningRun();
    await seedRunCreated(run);
    // [D6(a) 第 1 步] 终局判定源 = 终局记录注册表：终局 fixture 注入注册表条目
    // （生产经 dispatch 链 note）——stale 守卫据此判「已终态」。
    noteRebuiltSettlement(run.runId, { outcome: "done", settledAt: Date.now() });
    const deps = makeDeps();

    await handleWorkerExit(run, 0, makeHandle(), deps, makeHandlers());

    // 终局事实保持原 outcome=done（映射 reason completed），未被 exit 路径改写
    expect(settledRecordOf(run.runId)).toMatchObject({ outcome: "done" });
    expect(deps.onRunDone).not.toHaveBeenCalled();
  });

  it("非零 exit：委托 handleWorkerError → 一次即 done,failed（ADR-0122，无自动重建）", async () => {
    const run = makeRunningRun();
    await seedRunCreated(run);
    const deps = makeDeps();
    const handlers = makeHandlers();

    await handleWorkerExit(run, 1, makeHandle(), deps, handlers);

    expect(isRunSettled(run)).toBe(true);
    expect(settledRecordOf(run.runId)).toMatchObject({ outcome: "failed" });
    expect(deps.workerHost.start).not.toHaveBeenCalled();
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
  });
});

// ── [R4-F1] handleWorkerError：error + exit(1) 同代际双派发只计一次 ────

describe("handleWorkerError — [R4-F1] 同代际双事件幂等", () => {
  it("worker 崩溃：error 事件先到 → 一次即 done,failed；exit(1) 委托后到 → settled 守卫丢弃", async () => {
    // 真实时序：worker 崩溃 → onError 与 exit 几乎同时触发。第一个事件直接终态化
    // （ADR-0122 无退避窗口），第二个事件被 stale 守卫丢弃——onRunDone 恰一次。
    const run = makeRunningRun();
    await seedRunCreated(run);
    const deps = makeDeps();
    const handlers = makeHandlers();

    await handleWorkerError(run, new Error("worker crashed"), deps, handlers);
    await handleWorkerExit(run, 1, makeHandle(), deps, handlers);

    expect(isRunSettled(run)).toBe(true);
    expect(settledRecordOf(run.runId)).toMatchObject({ outcome: "failed" });
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
    expect(deps.workerHost.start).not.toHaveBeenCalled();
  });

  it("error + exit(1) 双到达只转一次 done,failed（unregister / workflow-record 恰一次）", async () => {
    const run = makeRunningRun();
    await seedRunCreated(run);
    const deps = makeDeps();
    const handlers = makeHandlers();

    const p1 = handleWorkerError(run, new Error("worker crashed"), deps, handlers);
    const p2 = handleWorkerExit(run, 1, makeHandle(), deps, handlers);
    await Promise.all([p1, p2]);

    expect(isRunSettled(run)).toBe(true);
    expect(settledRecordOf(run.runId)).toMatchObject({ outcome: "failed" });
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
    // [W1] 终局 coda 现含两条 entry（workflow-record 终态条目 + unregister）——
    // 幂等锚点 = unregister 恰一次（无重复直落），workflow-record 也恰一次
    expect(
      deps.appendEntry.mock.calls.filter((c) => c[0] === "pending:unregister"),
    ).toHaveLength(1);
    expect(
      deps.appendEntry.mock.calls.filter((c) => c[0] === "workflow-record"),
    ).toHaveLength(1);
  });
});

// ── [F1] handleWorkerMessage：return/error 标记 receivedTerminalMessage ────

describe("handleWorkerMessage — [F1] 终态消息标记", () => {
  it("return 消息将 runtime.receivedTerminalMessage 置 true，随后正常 transition done,completed", async () => {
    const run = makeRunningRun();
    await seedRunCreated(run);
    const deps = makeDeps();

    await handleWorkerMessage(run, { type: "return", result: { ok: 1 } }, deps, makeHandlers());

    expect((run.runtime as { receivedTerminalMessage?: boolean }).receivedTerminalMessage).toBe(true);
    expect(isRunSettled(run)).toBe(true);
    expect(settledRecordOf(run.runId)).toMatchObject({ outcome: "done" });
  });

  it("error 消息同样置 true（本 runtime 代际标记，供 exit(0) 判定与 R4-F1 幂等守卫消费）", async () => {
    const run = makeRunningRun();
    await seedRunCreated(run);
    const deps = makeDeps();

    await handleWorkerMessage(run, { type: "error", error: "boom" }, deps, makeHandlers());

    expect((run.runtime as { receivedTerminalMessage?: boolean }).receivedTerminalMessage).toBe(true);
  });
});

// ── [SW-DATA-3] store.save 抛错 → 不产生 unhandledRejection，状态机继续 ────

describe("store.save 抛错（ENOSPC 等）— [SW-DATA-3] 不阻断终态推进", () => {
  it("handleReturn（经 handleWorkerMessage return 分支）：save reject 被吸收，unregister + onRunDone 照常", async () => {
    const run = makeRunningRun();
    await seedRunCreated(run);
    const deps = makeDeps();
    deps.store.save.mockRejectedValue(new Error("ENOSPC: no space left on device"));

    // 旧实现：await 裸抛 → handleWorkerMessage reject（worker-host 侧 void 掉）→
    // unhandledRejection + 幽灵注销。修复后必须正常 resolve。
    await expect(
      handleWorkerMessage(run, { type: "return", result: { ok: 1 } }, deps, makeHandlers()),
    ).resolves.toBeUndefined();

    expect(isRunSettled(run)).toBe(true);
    expect(deps.appendEntry).toHaveBeenCalledWith(
      "pending:unregister",
      expect.objectContaining({ id: run.runId }),
    );
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
  });

  it("handleWorkerError：save reject 被吸收，终态 + 通知照常", async () => {
    const run = makeRunningRun();
    await seedRunCreated(run);
    const deps = makeDeps();
    deps.store.save.mockRejectedValue(new Error("ENOSPC: no space left on device"));

    await expect(
      handleWorkerError(run, new Error("worker crash"), deps, makeHandlers()),
    ).resolves.toBeUndefined();

    expect(isRunSettled(run)).toBe(true);
    expect(settledRecordOf(run.runId)).toMatchObject({ outcome: "failed" });
    expect(deps.appendEntry).toHaveBeenCalledWith(
      "pending:unregister",
      expect.objectContaining({ id: run.runId, reason: "failed" }),
    );
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
  });

  it("handleScriptError：save reject 被吸收，终态 + 通知照常", async () => {
    const run = makeRunningRun();
    await seedRunCreated(run);
    const deps = makeDeps();
    deps.store.save.mockRejectedValue(new Error("ENOSPC: no space left on device"));

    await expect(
      handleScriptError(run, "script boom", [], deps, makeHandlers()),
    ).resolves.toBeUndefined();

    expect(isRunSettled(run)).toBe(true);
    expect(settledRecordOf(run.runId)).toMatchObject({ outcome: "failed" });
    expect(deps.appendEntry).toHaveBeenCalledWith(
      "pending:unregister",
      expect.objectContaining({ id: run.runId, reason: "failed" }),
    );
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
  });
});
