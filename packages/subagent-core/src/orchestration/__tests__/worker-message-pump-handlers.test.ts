/**
 * worker-message-pump handlers — handleWorkerExit/Error/ScriptError + postBudgetUpdate 测试。
 *
 * 参考 worker-message-pump-workflow-call.test.ts 的 mock 构建。[ADR-0112] 后错误
 * 一次即终态（原 scheduleRebuild 指数退避重试矩阵已删），无需 fake timers 压缩退避。
 *
 * 覆盖：
 * - handleWorkerExit：code=0 正常退出（no-op） / code!=0 一次即 failed / stale handle 过滤
 * - handleWorkerError：一次即 transition done,failed + 直落 pending:unregister
 * - handleScriptError：一次即 failed / workerLogs 捕获
 * - postBudgetUpdate：postMessage budget-update（usedTokens/usedCost）
 * - stale handle 过滤（handle.isCurrent=false）+ terminal stale 守卫（isTerminal 语义）
 * - 孤儿 call 守卫（S7-second）：重跑 dispatch 替换同 callId 条目后，旧代际迟到
 *   completion 不投新 worker、不复活 Map/trace 条目
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  handleScriptError,
  handleWorkerError,
  handleWorkerExit,
  handleWorkerMessage,
  postBudgetUpdate,
} from "../worker-message-pump.ts";
import {
  dispatchRunCreated,
  noteRebuiltSettlement,
} from "../terminal-actions.ts";
import { doneReasonToRunOutcome } from "../run-events.ts";
import { Budget } from "../models/budget.ts";
import { RunRuntime } from "../models/run-runtime.ts";
import { Trace } from "../models/trace.ts";
import type { AgentResult, DoneReason } from "../models/types.ts";
import { WorkflowRun } from "../models/workflow-run.ts";
import type { LifecycleDeps, WorkerHandlers } from "../models/ports.ts";
import type { WorkerHandle } from "../worker-handle.ts";
import { flushMicrotasks } from "./helpers/flush-microtasks.ts";
// [W2/V1] 六态机引导 + 终局断言换源（两态机字段停更——终局经注册表判定/派生）。
import { isRunSettled, setRunEventJournalDirForTest, settledRecordOf } from "../terminal-actions.ts";
import { createRunEventJournal } from "../run-events.ts";

// ── helpers ──────────────────────────────────────────────────

/** 按 stepIndex 查 trace 节点（Trace 公共查询面 = toArray 线性扫）。 */
function findByStep(trace: Trace, stepIndex: number) {
  return trace.toArray().find((n) => n.stepIndex === stepIndex);
}

/** 构造一个活体（未终局）mock WorkflowRun，meta 可配置。 */
let runSeq = 0;
function makeRunningRun(opts: {
  budgetTimeMs?: number;
  postMessage?: ReturnType<typeof vi.fn>;
  /** [F1] 预置本 runtime 代际已收到终态消息（return/error）。 */
  receivedTerminalMessage?: boolean;
} = {}): WorkflowRun {
  return {
    runId: `wf-handlers-${++runSeq}`, // [W2/V1] 模块级活体态/注册表按 runId 键控——唯一化防跨测试污染
    state: {
      budget: { usedTokens: 50, usedCost: 0.1 },
      // L9: errorLogs 现在用 push 追加——必须是真实数组，不能省略
      errorLogs: [],
      calls: new Map(),
      trace: { removeByStepIndex: vi.fn() },
    },
    meta: {
      startedAt: new Date().toISOString(),
    },
    spec: {
      scriptName: "test-wf",
      scriptSource: "async function execute() {}",
      args: {},
      budgetTimeMs: opts.budgetTimeMs,
    },
    runtime: {
      worker: { postMessage: opts.postMessage ?? vi.fn() },
      receivedTerminalMessage: opts.receivedTerminalMessage,
    },
    replaceRuntime(this: WorkflowRun, rt: NonNullable<WorkflowRun["runtime"]>): void {
      this.runtime = rt;
    },
    releaseRuntime: vi.fn(),
  } as unknown as WorkflowRun;
}

/** LifecycleDeps mock：store/workerHost/runner/eventBus/appendEntry/scheduleTimeBudget 可观察。
 *  mock 成员 = 真实签名 & vi.fn 能力（交叉纯 Mock 会丢真实签名，传回被测函数即报错）。 */
type MockLifecycleDeps = Omit<
  LifecycleDeps,
  "store" | "workerHost" | "runner" | "eventBus" | "appendEntry" | "onRunDone" | "log"
> & {
  // 真实类型整体保留（RunStore/WorkerHost 等接口成员完整），仅 mock 方法交叉 vi.fn 能力
  store: LifecycleDeps["store"] & { save: LifecycleDeps["store"]["save"] & ReturnType<typeof vi.fn> };
  workerHost: LifecycleDeps["workerHost"] & { start: LifecycleDeps["workerHost"]["start"] & ReturnType<typeof vi.fn> };
  runner: LifecycleDeps["runner"] & { run: LifecycleDeps["runner"]["run"] & ReturnType<typeof vi.fn> };
  eventBus: NonNullable<LifecycleDeps["eventBus"]> & { emit: NonNullable<LifecycleDeps["eventBus"]>["emit"] & ReturnType<typeof vi.fn> };
  appendEntry: NonNullable<LifecycleDeps["appendEntry"]> & ReturnType<typeof vi.fn>;
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
    appendEntry: vi.fn(),
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

// ── [W2/V1] 六态机引导 + 终态 fixture ────────────────────────

/** [W2/V1] 六态机引导：journal 首帧（run-created）落账——finalizeRun/abortRun 等
 *  活体终局入口的六态机裁决要求 created→dispatched 已在链上（生产链路由
 *  runWorkflow 正点发射承接；直测终局入口的用例经本 helper 补齐同一引导）。 */
async function seedRunCreated(run: WorkflowRun): Promise<void> {
  await dispatchRunCreated(run);
}

/** [D6(a) 第 1 步] 终态 fixture：终局事实 = 终局记录注册表条目（换源后
 *  isRunSettled 只认注册表——生产经 dispatch 链 note / 重建点 noteRebuiltSettlement
 *  注入；stale 守卫用例的「已终态」形态由本 helper 构造）。 */
function markRunTerminalDone(run: WorkflowRun, reason: DoneReason = "completed"): void {
  run.state.reason = reason;
  noteRebuiltSettlement(run.runId, {
    outcome: doneReasonToRunOutcome(reason),
    settledAt: Date.now(),
  });
}

// ── handleWorkerExit ─────────────────────────────────────────

describe("handleWorkerExit", () => {
  it("code=0 且已收到终态消息：no-op（不 transition、不 save）", async () => {
    // [F1] exit(0) no-op 的前提是本代际已交付 return/error（正常收尾退出）。
    // 无终态消息的 exit(0) 转 done,failed，见下方用例与 worker-exit-without-result.test.ts。
    const run = makeRunningRun({ receivedTerminalMessage: true });
    await seedRunCreated(run);
    const deps = makeDeps();
    const handle = makeHandle(true);

    await handleWorkerExit(run, 0, handle, deps, makeHandlers());

    expect(isRunSettled(run)).toBe(false); // 未改
    expect(deps.store.save).not.toHaveBeenCalled();
    expect(deps.eventBus.emit).not.toHaveBeenCalled();
    expect(deps.appendEntry).not.toHaveBeenCalled();
  });

  it("code=0 且无终态消息：[F1] 转 done,failed（不可克隆 return 被吞的悬挂防线）", async () => {
    const run = makeRunningRun();
    await seedRunCreated(run);
    const deps = makeDeps();
    const handle = makeHandle(true);

    await handleWorkerExit(run, 0, handle, deps, makeHandlers());

    expect(isRunSettled(run)).toBe(true);
    expect(settledRecordOf(run.runId)).toMatchObject({ outcome: "failed" });
    expect(run.state.error).toContain("structured-cloneable");
    expect(deps.store.save).toHaveBeenCalledTimes(1);
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
  });

  it("code!=0 异常退出：委托 handleWorkerError → 一次即 transition done,failed（ADR-0112）", async () => {
    const run = makeRunningRun();
    await seedRunCreated(run);
    const deps = makeDeps();
    const handle = makeHandle(true);

    await handleWorkerExit(run, 1, handle, deps, makeHandlers());

    expect(isRunSettled(run)).toBe(true);
    expect(settledRecordOf(run.runId)).toMatchObject({ outcome: "failed" });
    expect(run.state.error).toContain("Worker exited with code 1");
    // 持久化 + 完成通知
    expect(deps.store.save).toHaveBeenCalledTimes(1);
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
    // 无自动重建：workerHost.start 不被调
    expect(deps.workerHost.start).not.toHaveBeenCalled();
  });

  it("stale handle（isCurrent=false）：丢弃 exit 事件，不处理", async () => {
    const run = makeRunningRun();
    await seedRunCreated(run);
    const deps = makeDeps();
    const staleHandle = makeHandle(false);

    await handleWorkerExit(run, 1, staleHandle, deps, makeHandlers());

    // 状态未变，store 未 save
    expect(isRunSettled(run)).toBe(false);
    expect(deps.store.save).not.toHaveBeenCalled();
  });

  it("run 已终态（done）：stale 守卫前置丢弃", async () => {
    const run = makeRunningRun();
    await seedRunCreated(run);
    // [D6(a)] 终态 fixture 注入注册表条目（生产经 dispatch 链 note）。
    markRunTerminalDone(run);
    const deps = makeDeps();
    const handle = makeHandle(true);

    await handleWorkerExit(run, 1, handle, deps, makeHandlers());

    expect(deps.store.save).not.toHaveBeenCalled();
  });
});

// ── handleWorkerError ────────────────────────────────────────

describe("handleWorkerError", () => {
  it("worker error → 一次即 transition done,failed + save + 直落 pending:unregister（ADR-0112）", async () => {
    const run = makeRunningRun();
    await seedRunCreated(run);
    const deps = makeDeps();

    await handleWorkerError(run, new Error("worker boom"), deps, makeHandlers());

    expect(isRunSettled(run)).toBe(true);
    expect(settledRecordOf(run.runId)).toMatchObject({ outcome: "failed" });
    expect(run.state.error).toBe("worker boom");
    expect(deps.store.save).toHaveBeenCalledTimes(1);
    expect(deps.appendEntry).toHaveBeenCalledWith("pending:unregister", {
      id: run.runId,
      reason: "failed",
      status: "failed",
    });
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
    // 无自动重建
    expect(deps.workerHost.start).not.toHaveBeenCalled();
  });

  it("[R4-F1] 同代际幂等：receivedTerminalMessage 已置位 → 第二个事件直接跳过", async () => {
    const run = makeRunningRun({ receivedTerminalMessage: true });
    await seedRunCreated(run);
    const deps = makeDeps();

    await handleWorkerError(run, new Error("second event"), deps, makeHandlers());

    expect(isRunSettled(run)).toBe(false);
    expect(deps.store.save).not.toHaveBeenCalled();
  });

  it("终态（done）：stale 守卫前置丢弃", async () => {
    const run = makeRunningRun();
    await seedRunCreated(run);
    // [D6(a)] 终态 fixture 注入注册表条目（生产经 dispatch 链 note）。
    markRunTerminalDone(run);
    const deps = makeDeps();

    await handleWorkerError(run, new Error("stale"), deps, makeHandlers());

    expect(deps.store.save).not.toHaveBeenCalled();
  });
});

// ── handleScriptError ────────────────────────────────────────

describe("handleScriptError", () => {
  it("script error → 一次即 transition done,failed + 捕获 workerLogs（ADR-0112）", async () => {
    const run = makeRunningRun();
    await seedRunCreated(run);
    const deps = makeDeps();
    const workerLogs = [
      { level: "error" as const, message: "line 5 boom" },
    ];

    await handleScriptError(run, "TypeError: x is undefined", workerLogs, deps, makeHandlers());

    expect(isRunSettled(run)).toBe(true);
    expect(settledRecordOf(run.runId)).toMatchObject({ outcome: "failed" });
    // 错误原文显式上报（无 retries 包装文案）
    expect(run.state.error).toBe("TypeError: x is undefined");
    // workerLogs 捕获到 errorLogs
    expect(run.state.errorLogs).toEqual(workerLogs);
    expect(deps.store.save).toHaveBeenCalledTimes(1);
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
    // 无自动重建
    expect(deps.workerHost.start).not.toHaveBeenCalled();
  });

  it("terminal 状态：stale 守卫前置丢弃", async () => {
    const run = makeRunningRun();
    await seedRunCreated(run);
    // [D6(a)] 终态 fixture 注入注册表条目（生产经 dispatch 链 note）。
    markRunTerminalDone(run);
    const deps = makeDeps();

    await handleScriptError(run, "late error", [], deps, makeHandlers());

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

// ── orphan call guard（S7-second 竞态回归） ─────────────────
//
// 竞态形态：dispatch agent-call → 重跑 dispatch 替换同 callId 条目 → 旧 dispatch 的
// promise 以失败/成功 resolve → 迟到的旧代际结果不得经 postAgentResult 投给**重跑
// dispatch 的同 callId pending**（否则重跑中的 agent() 被旧结果劫持 resolve 为空串
// → 脚本假成功）。[HISTORICAL] 原用例经 rebuildRuntime 的 discardInFlightCalls 构造
// discard——该机制随重试矩阵删除（ADR-0112），本组用例改为「直接重跑 dispatch 替换」
// 形态，守卫谓词（isOrphanedCall）的判定语义不变。
//
// 用真实 WorkflowRun/RunRuntime/Trace/Budget（而非 makeRunningRun 的简化 mock）。

// ── 手动控制的 deferred——精确编排「dispatch 挂起 → 替换 → 旧 promise settle」交错。
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

describe("orphan call guard（非孤儿路径不误伤）", () => {
  // [HISTORICAL] 原「rebuild discard + 重跑替换」形态的孤儿守卫用例随重试矩阵删除
  // （ADR-0112）——该形态现网不可达（同 run 内同 callId 重跑 dispatch 只发生在已删的
  // rebuild 重跑场景）；谓词本体（isOrphanedCall / executeAgentCall isOrphaned 注入）
  // 保留为接管形态的防御面，行为由 execute-agent-call.test.ts 的谓词直测覆盖。

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
    expect(findByStep(run.state.trace, 4)?.status).toBe("completed");
  });

});

// ── agent-call 的 schema 入参形状：调用方错误 fail-fast，不静默降级成文本调用 ──

/** agent-call 消息 + 指定 schema 入参（形状检查用）。 */
function makeSchemaMsg(callId: number, schema: unknown): unknown {
  return {
    type: "agent-call",
    callId,
    opts: { prompt: "test task", agent: "worker", description: "test-slug", schema },
  };
}

describe("agent-call schema 入参形状（fail-fast）", () => {
  let journalDir: string;

  beforeEach(() => {
    journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "pump-schema-"));
    setRunEventJournalDirForTest(journalDir);
  });

  afterEach(() => {
    setRunEventJournalDirForTest(undefined);
    fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it.each([
    ["字符串", '{"type":"object"}'],
    ["数字", 42],
    ["布尔", true],
    ["数组", [{ type: "object" }]],
  ])("schema 为%s → 立即失败：不派发 / call 落 failed / 失败帧入 record / 错误回传 worker", async (_label, schema) => {
    const run = makeRealRun("wf-schema-bad");
    const deps = makeDeps();
    const handlers = makeHandlers();
    // record 流首帧（fold 起点）：agent-settled 需从 running 态转移，缺 run-created 会
    // 被状态机判为表外转移而静默丢弃
    await createRunEventJournal(journalDir).append("wf-schema-bad", {
      type: "run-created",
      runId: "wf-schema-bad",
      workflowName: "test-wf",
      argsSummary: "{}",
      scriptSource: "async function execute() {}",
      ts: Date.now(),
    });

    await handleWorkerMessage(run, makeSchemaMsg(1, schema), deps, handlers);
    await flushMicrotasks();

    // fail-fast 的关键断言：没有真实派发（否则会退化成文本调用，脚本静默拿到字符串）
    expect(deps.runner.run).not.toHaveBeenCalled();
    const call = run.state.calls.get(1);
    expect(call?.status).toBe("done");
    expect(String(call?.result?.error ?? "")).toContain("Invalid schema param");
    expect(String(call?.result?.error ?? "")).toContain("Recovery:");

    // 失败帧入 record（来源可追溯，不是只回一条 IPC 错误）——落帧是异步投递，轮询等它
    await vi.waitFor(async () => {
      const events = await createRunEventJournal(journalDir).scan("wf-schema-bad");
      const settled = events.filter((e) => e.type === "agent-settled").at(-1) as
        | { result?: { error?: string } }
        | undefined;
      expect(String(settled?.result?.error ?? "")).toContain("Invalid schema param");
    });

    // 错误回传 worker：agent() 的 pending 收敛，不悬挂
    const postMessage = run.runtime!.worker.postMessage as unknown as ReturnType<typeof vi.fn>;
    expect(String(findAgentResultPost(postMessage, 1)?.result.error ?? "")).toContain("Invalid schema param");
  });

  it("schema 缺省 / null → 视为未提供，正常派发", async () => {
    for (const [i, schema] of [undefined, null].entries()) {
      const run = makeRealRun(`wf-schema-absent-${i}`);
      const deps = makeDeps();
      const handlers = makeHandlers();
      await handleWorkerMessage(run, makeSchemaMsg(1, schema), deps, handlers);
      await flushMicrotasks();
      expect(deps.runner.run).toHaveBeenCalledTimes(1);
    }
  });
});
