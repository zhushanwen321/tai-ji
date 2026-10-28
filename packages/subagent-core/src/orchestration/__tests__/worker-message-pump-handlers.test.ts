/**
 * worker-message-pump handlers — handleWorkerExit/Error/ScriptError + postBudgetUpdate 测试。
 *
 * [round5-g 合并产物] 吸收同被测模块（worker-message-pump.ts）姊妹件：
 * - worker-message-pump-run-events.test.ts（run 事件状态机 journal 接线段）。
 *   其 journal 目录 hook 已下沉进各 describe（本文件其余节依赖 vitest 无注入时
 *   的同步跳过路径——终局投影时序与固定 tick 窗口对齐，不可共享文件级 hook）。
 *
 * 参考 worker-message-pump-workflow-call.test.ts 的 mock 构建。[ADR-0122] 后错误
 * 一次即终态（原 scheduleRebuild 指数退避重试矩阵已删），无需 fake timers 压缩退避。
 *
 * 覆盖：
 * - handleWorkerExit：code=0 正常退出（no-op） / code!=0 一次即 failed / stale handle 过滤
 * - handleWorkerError：一次即 transition done,failed + 直落 pending:unregister
 * - handleScriptError：一次即 failed / workerLogs 捕获
 * - postBudgetUpdate：postMessage budget-update（usedTokens/usedCost）
 * - stale handle 过滤（handle.isCurrent=false）+ terminal stale 检查（isTerminal 语义）
 * - 孤儿 call 检查（S7-second）：重跑 dispatch 替换同 callId 条目后，旧代际迟到
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
  dispatchRunTrigger,
  finalizeRun,
  noteRebuiltSettlement,
} from "../terminal-actions.ts";
import { doneReasonToRunOutcome } from "../run-events.ts";
import { Budget } from "../models/budget.ts";
import { RunRuntime } from "../models/run-runtime.ts";
import { Trace } from "../models/trace.ts";
import { AgentCall } from "../models/agent-call.ts";
import type { AgentResult, DoneReason, ExecutionTraceNode } from "../models/types.ts";
import { WorkflowRun } from "../models/workflow-run.ts";
import type { LifecycleDeps, WorkerHandlers } from "../models/ports.ts";
import type { WorkerHandle } from "../worker-handle.ts";
import { flushMicrotasks } from "./helpers/flush-microtasks.ts";
// [W2/V1] 六态机引导 + 终局断言换源（两态机字段停更——终局经注册表判定/派生）。
import { isRunSettled, setRunEventJournalDirForTest, settledRecordOf } from "../terminal-actions.ts";
import { createRunEventJournal } from "../run-events.ts";

// ── helpers ──────────────────────────────────────────────────

/** 按 stepIndex 查 trace 节点（Trace 公共查询范围 = toArray 线性扫）。 */
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

/** [W2/V1] 六态机引导：journal 首帧（run-created）写入 journal 记录——finalizeRun/abortRun 等
 *  活体终局入口的六态机裁决要求 created→dispatched 已在链上（生产链路由
 *  runWorkflow 正点发射承接；直测终局入口的用例经本 helper 补齐同一引导）。 */
async function seedRunCreated(run: WorkflowRun): Promise<void> {
  await dispatchRunCreated(run);
}

/** [D6(a) 第 1 步] 终态 fixture：终局事实 = 终局记录注册表条目（换源后
 *  isRunSettled 只认注册表——生产经 dispatch 链 note / 重建点 noteRebuiltSettlement
 *  注入；stale 检查用例的「已终态」形态由本 helper 构造）。 */
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

  it("code!=0 异常退出：委托 handleWorkerError → 一次即 transition done,failed（ADR-0122）", async () => {
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

  it("run 已终态（done）：stale 检查前置丢弃", async () => {
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
  it("worker error → 一次即 transition done,failed + save + 直落 pending:unregister（ADR-0122）", async () => {
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

  it("终态（done）：stale 检查前置丢弃", async () => {
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
  it("script error → 一次即 transition done,failed + 捕获 workerLogs（ADR-0122）", async () => {
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

  it("terminal 状态：stale 检查前置丢弃", async () => {
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

// ── orphan call 检查（S7-second 竞态回归） ─────────────────
//
// 竞态形态：dispatch agent-call → 重跑 dispatch 替换同 callId 条目 → 旧 dispatch 的
// promise 以失败/成功 resolve → 迟到的旧代际结果不得经 postAgentResult 投给**重跑
// dispatch 的同 callId pending**（否则重跑中的 agent() 被旧结果劫持 resolve 为空串
// → 脚本假成功）。[HISTORICAL] 原用例经 rebuildRuntime 的 discardInFlightCalls 构造
// discard——该机制随重试矩阵删除（ADR-0122），本组用例改为「直接重跑 dispatch 替换」
// 形态，检查谓词（isOrphanedCall）的判定语义不变。
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

describe("orphan call 检查（非孤儿路径不误伤）", () => {
  // [HISTORICAL] 原「rebuild discard + 重跑替换」形态的孤儿检查用例随重试矩阵删除
  // （ADR-0122）——该形态现网不可达（同 run 内同 callId 重跑 dispatch 只发生在已删的
  // rebuild 重跑场景）；谓词本体（isOrphanedCall / executeAgentCall isOrphaned 注入）
  // 保留为接管形态的防御路径，行为由 execute-agent-call.test.ts 的谓词直测覆盖。

  it("非孤儿正常路径：成功 completion 照常投递 agent-result（检查不误伤）", async () => {
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
    }, { interval: 1 });

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

// ══════ 来源: worker-message-pump-run-events.test.ts ══════

// src/orchestration/__tests__/worker-message-pump-run-events.test.ts
//
// [P1b-1] run 事件状态机生产链接线测试（worker-message-pump 状态机接线段）。
//
// 锁四面：
// 1. finalizeRun = run-settled 事件终态单写点：completed/failed/aborted 三 doneReason
//    路径的 journal 终局帧（aborted 经 cancel-requested 控制事件 → 输出执行侧合成
//    run-settled(cancelled)——journal 词表恰无 cancel-requested 帧）。
// 2. 终局后让位：终局触发命中表外转移（无 run-created 引导/已终局）→ finalizeRun
//    让位返回 false，journal 零追加（M12 语义 + 单写者纪律）。
// 3. dispatchAgentCall 的 ask 事件链：agent-started（派发时）+ agent-settled(completed，
//    完成回调时)——taskIndex = callId 单源、attempt = call.attempts。
// 4. journal 目录测试注入（setRunEventJournalDirForTest + mkdtemp 自建自删，测试红线：
//    不触真实数据目录）。
// 5. [Q2] run-created 正点接线（P1b-1 引导补投已删除）：正点发射无双帧 + 无首帧时
//    事件触发表外转移 fail-fast（不静默补齐）。




// ── helpers ──────────────────────────────────────────────────

let journalDir: string;

function scanRunEvents(runId: string) {
  return createRunEventJournal(journalDir).scan(runId);
}

/** 构造真实 WorkflowRun（真实状态机 transition）。 */
function makeRealRunEv(runId: string, specOverrides: { scriptPath?: string } = {}): WorkflowRun {
  const run = new WorkflowRun(
    runId,
    {
      scriptName: "test-wf",
      scriptSource: "agent('hi')",
      args: {},
      scriptPath: specOverrides.scriptPath ?? "/tmp/test-wf.js",
    },
    {
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

  beforeEach(() => {
    journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "pump-run-events-"));
    setRunEventJournalDirForTest(journalDir);
  });

  afterEach(() => {
    setRunEventJournalDirForTest(undefined);
    fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  it("completed → journal 终帧 run-settled(completed)（正点 run-created 首帧）", async () => {
    const run = makeRealRunEv("wf-ev-1");
    const deps = makeDeps();
    await dispatchRunCreated(run); // [Q2] 正点发射（P1b-1 created 引导已删除）

    const ok = await finalizeRun(run, deps, "completed", { context: "test" });

    expect(ok).toBe(true);
    const events = await scanRunEvents("wf-ev-1");
    // 零 ask run：正点 run-created + run-settled
    expect(events.map((e) => e.type)).toEqual(["run-created", "run-settled"]);
    expect(events[1]).toMatchObject({ type: "run-settled", outcome: "done" });
  });

  it("run-created 帧携带 scriptPath 锚定载荷（spec.scriptPath 非空才落字段——空值防御形态不落）", async () => {
    const run = makeRealRunEv("wf-ev-anchor");
    await dispatchRunCreated(run);

    const events = await scanRunEvents("wf-ev-anchor");
    expect(events[0]).toMatchObject({ type: "run-created", scriptPath: "/tmp/test-wf.js" });

    const empty = makeRealRunEv("wf-ev-anchor-empty", { scriptPath: "" });
    await dispatchRunCreated(empty);

    const emptyEvents = await scanRunEvents("wf-ev-anchor-empty");
    expect(emptyEvents[0]).toMatchObject({ type: "run-created" });
    expect("scriptPath" in emptyEvents[0]).toBe(false);
  });

  it("run-created 帧条件式落 rootSessionId 归属锚（dmg-r2-5：同 cwd 多会话宿主精确路由）——传入落字段、缺省不落", async () => {
    const run = makeRealRunEv("wf-ev-anchor-sid");
    await dispatchRunCreated(run, "root-session-1");

    const events = await scanRunEvents("wf-ev-anchor-sid");
    expect(events[0]).toMatchObject({ type: "run-created", rootSessionId: "root-session-1" });

    const noAnchor = makeRealRunEv("wf-ev-anchor-sid-missing");
    await dispatchRunCreated(noAnchor);

    const noAnchorEvents = await scanRunEvents("wf-ev-anchor-sid-missing");
    expect(noAnchorEvents[0]).toMatchObject({ type: "run-created" });
    expect("rootSessionId" in noAnchorEvents[0]).toBe(false);
  });

  it("failed → run-settled(failed)，reason 承载诊断文本", async () => {
    const run = makeRealRunEv("wf-ev-2");
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
    const run = makeRealRunEv("wf-ev-3");
    await dispatchRunCreated(run);
    const deps = makeDeps();

    await finalizeRun(run, deps, "aborted", { context: "abortRun" });

    const events = await scanRunEvents("wf-ev-3");
    expect(events.map((e) => e.type)).toEqual(["run-created", "run-settled"]);
    expect(events[1]).toMatchObject({ type: "run-settled", outcome: "cancelled" });
  });

  it("budget_limited（六因）→ outcome 映射 failed", async () => {
    const run = makeRealRunEv("wf-ev-4");
    await dispatchRunCreated(run);
    const deps = makeDeps();

    await finalizeRun(run, deps, "budget_limited", { context: "test" });

    const events = await scanRunEvents("wf-ev-4");
    expect(events.at(-1)).toMatchObject({ type: "run-settled", outcome: "failed" });
  });

  it("终局触发命中表外转移（无 run-created 引导即终局化）→ 返回 false + journal 零追加（单写者纪律）", async () => {
    const run = makeRealRunEv("wf-ev-5");
    // 让位机制（[W2/V1] 六态机承接）：无 run-created 首帧 → fold 停在 created，
    // created × run-settled 表外转移 fail-fast（IllegalTransitionError）——终局
    // 单写者纪律的结构性承载，无需两态机先行直改。
    const deps = makeDeps();

    const ok = await finalizeRun(run, deps, "failed", { context: "test" });

    expect(ok).toBe(false);
    const events = await scanRunEvents("wf-ev-5");
    expect(events).toHaveLength(0); // 让位路径不落任何帧
  });
});

// ── 2. dispatchAgentCall 的 ask 事件链 ───────────────────────

describe("dispatchAgentCall 落 ask 事件（dispatched + settled）", () => {

  beforeEach(() => {
    journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "pump-run-events-"));
    setRunEventJournalDirForTest(journalDir);
  });

  afterEach(() => {
    setRunEventJournalDirForTest(undefined);
    fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  it("agent-call 派发 → agent-started；完成 → agent-settled(completed, attempt=1)", async () => {
    const run = makeRealRunEv("wf-ev-6");
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
    await flushMicrotasks(20);

    expect(isRunSettled(run)).toBe(false); // 正常完成不触发终局
    const events = await scanRunEvents("wf-ev-6");
    expect(events.map((e) => e.type)).toEqual(["run-created", "agent-started", "agent-settled"]);
    expect(events[1]).toMatchObject({ taskIndex: 3, agentName: "reviewer", attempt: 1 });
    expect(events[2]).toMatchObject({
      taskIndex: 3,
      attempt: 1,
      outcome: "done",
      durationMs: 7,
    });
  });
  it("终局后再到达的 call 完成 → stale 检查拦截，journal 零追加（terminal 后停止 append）", async () => {
    const run = makeRealRunEv("wf-ev-7");
    await dispatchRunCreated(run);
    const deps = makeDeps();
    deps.runner.run = vi.fn(async () => {
      // runner 执行窗内 run 被终态化（模拟 abort 竞态）
      // [D6(a) 第 1 步] 终局判定源 = 终局记录注册表：竞态终态化注入终局事实
      // （生产 abortRun 经 dispatch 链 note）——stale 检查据此拦截迟到 call 完成。
      noteRebuiltSettlement(run.runId, { outcome: "cancelled", settledAt: Date.now() });
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
    await flushMicrotasks(20);

    const events = await scanRunEvents("wf-ev-7");
    // 终局帧存在（runner 内抢先 finalizeRun 不发生——本用例只 transition 不 finalize，
    // journal 无 run-settled；核心断言 = 无 agent-settled 迟到帧）
    expect(events.some((e) => e.type === "agent-settled")).toBe(false);
  });
});

// ── 3. run-created 正点接线（[Q2] P1b-1 引导补投已删除） ─────

describe("run-created 正点接线（无双帧 + 引导退役）", () => {

  beforeEach(() => {
    journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "pump-run-events-"));
    setRunEventJournalDirForTest(journalDir);
  });

  afterEach(() => {
    setRunEventJournalDirForTest(undefined);
    fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  it("正点发射后后续触发不补投：journal 恰好一帧 run-created；重复发射 = 表外转移 fail-fast", async () => {
    const run = makeRealRunEv("wf-ev-dual");
    await dispatchRunCreated(run);

    // 正点后的 ask 事件照常写入 journal 记录（fold 出 dispatched，agent-started 合法转移）
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
    await flushMicrotasks(20);

    const events = await scanRunEvents("wf-ev-dual");
    // 双帧不存在：run-created 恰好一帧（正点），后续触发零补投
    expect(events.filter((e) => e.type === "run-created")).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "run-created", workflowName: "test-wf" });
    expect(events.slice(1).map((e) => e.type)).toEqual(["agent-started", "agent-settled"]);

    // 正点重复发射 = 表外转移 fail-fast（ask 全链后 fold 停在 running——无论哪个
    // 非 created 态，run-created 均无表行，双帧构造性排除）
    await expect(dispatchRunCreated(run)).rejects.toThrow(/不接受事件 run-created/);
  });

  it("引导补投已退役：journal 无 run-created 帧时事件触发表外转移 fail-fast（不静默补齐）", async () => {
    const run = makeRealRunEv("wf-ev-noseed");

    await expect(
      dispatchRunTrigger(run, {
        type: "agent-started",
        taskIndex: 1,
        agentName: "a",
        attempt: 1,
        ts: Date.now(),
      }),
    ).rejects.toThrow(/非法 run 状态转移/);
    // fail-fast 不写任何帧（事件在 run-created 写入 journal 记录前到达 = 接线错误，可归因）
    expect(await scanRunEvents("wf-ev-noseed")).toHaveLength(0);
  });
});

// ── 4. finalizeRun 的 run-settled errorCode 构造（S2 死亡可诊断） ──

describe("finalizeRun 的 run-settled errorCode 构造（DoneReason → RunErrorCode 单点映射）", () => {

  beforeEach(() => {
    journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "pump-run-events-"));
    setRunEventJournalDirForTest(journalDir);
  });

  afterEach(() => {
    setRunEventJournalDirForTest(undefined);
    fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  it("failed + 失败 call 带 engine_crashed 协议码前缀 → errorCode=engine_crashed（S2 引擎崩溃族）", async () => {
    const run = makeRealRunEv("wf-ev-ec");
    await dispatchRunCreated(run);
    // 错误文本 `<code>: <detail>` 前缀 = SDK EngineSdkError 的跨包契约形态
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

  it("budget_limited → failed + errorCode=budget_limited；time_limited → outcome 直判无码（[D2] 升格——新写入方不产出该 errorCode）", async () => {
    // budget_limited：维持 failed && errorCode 分级（预算耗尽仍是 failed 终局的错误码）
    const budgetRun = makeRealRunEv("wf-ev-budget_limited");
    await dispatchRunCreated(budgetRun);
    await finalizeRun(budgetRun, makeDeps(), "budget_limited", { context: "test" });
    expect((await scanRunEvents("wf-ev-budget_limited")).at(-1)).toMatchObject({
      type: "run-settled",
      outcome: "failed",
      errorCode: "budget_limited",
    });
    // time_limited：[D2] 升格为独立 outcome，errorCode 缺省（超时终局直判）
    const timeRun = makeRealRunEv("wf-ev-time_limited");
    await dispatchRunCreated(timeRun);
    await finalizeRun(timeRun, makeDeps(), "time_limited", { context: "test" });
    expect((await scanRunEvents("wf-ev-time_limited")).at(-1)).toMatchObject({
      type: "run-settled",
      outcome: "time_limited",
    });
  });

  it("failed + failureKind（无协议码前缀）→ failureKind 落码（ask 级分诊标签兜底）", async () => {
    const run = makeRealRunEv("wf-ev-kind");
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
    const run = makeRealRunEv("wf-ev-script");
    await dispatchRunCreated(run);
    run.state.error = "Workflow failed: script threw TypeError";
    const deps = makeDeps();

    await finalizeRun(run, deps, "failed", { context: "test" });

    const events = await scanRunEvents("wf-ev-script");
    expect(events.at(-1)).toMatchObject({ type: "run-settled", outcome: "failed", errorCode: "unknown" });
  });

  it("completed 与 aborted（cancel 合成 cancelled）→ 无 errorCode 键（成功/取消不带码）", async () => {
    const runDone = makeRealRunEv("wf-ev-ok2");
    await dispatchRunCreated(runDone);
    await finalizeRun(runDone, makeDeps(), "completed", { context: "test" });
    const doneEvents = await scanRunEvents("wf-ev-ok2");
    expect(doneEvents.at(-1)).toMatchObject({ type: "run-settled", outcome: "done" });
    expect(doneEvents.at(-1)).not.toHaveProperty("errorCode");

    const runAbort = makeRealRunEv("wf-ev-abort");
    await dispatchRunCreated(runAbort);
    await finalizeRun(runAbort, makeDeps(), "aborted", { context: "abortRun" });
    const abortEvents = await scanRunEvents("wf-ev-abort");
    expect(abortEvents.at(-1)).toMatchObject({ type: "run-settled", outcome: "cancelled" });
    expect(abortEvents.at(-1)).not.toHaveProperty("errorCode");
  });
});

// ── 5. dispatchAgentCall 写入 journal 记录（[ADR-0122] 无重试轨迹） ──
//
// [HISTORICAL] 原「两次失败后成功 → dispatched→retrying×2→settled{attempt:3}」用例
// 随重试矩阵删除（ADR-0122）——agent-retrying 帧不再产生（事件类型保留为 journal
// 词表兼容，仅历史 record 含此帧）。「非重试终局零假帧」用例保留：失败单次终态化，
// journal 恰三帧（run-created / agent-started / agent-settled）。

describe("dispatchAgentCall 写入 journal 记录（失败单次终态，零假帧）", () => {

  beforeEach(() => {
    journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "pump-run-events-"));
    setRunEventJournalDirForTest(journalDir);
  });

  afterEach(() => {
    setRunEventJournalDirForTest(undefined);
    fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  it("失败 call（stale_context）→ journal 恰三帧：run-created / agent-started / agent-settled", async () => {
    const run = makeRealRunEv("wf-ev-noretry");
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
    await flushMicrotasks(20);

    const events = await scanRunEvents("wf-ev-noretry");
    expect(events.map((e) => e.type)).toEqual(["run-created", "agent-started", "agent-settled"]);
    // 无 agent-retrying 帧（构造性零假帧）
    expect(events.filter((e) => e.type === "agent-retrying")).toHaveLength(0);
    expect(deps.onRunDone).not.toHaveBeenCalled(); // call 失败不触发 run 终局（run-settled 由脚本 return 驱动）
  });
});

// ── 6. 回放不受扰动（subagent-model-switch §6.6 决策六 / 验收场景 3 通过标准）──
//
// 覆盖记账走宿主派发侧覆写（决策六②），不进 worker 的 $MODEL、不改重建 spec 的
// run 级模型、不碰回放一致性比对——三者在场时 resume 重放的历史 call 回话不受
// 扰动。mock 表驱动：journal 覆盖帧在场（model-override B）+ 历史 opts 含旧
// model → 同 opts 重放命中 cached 回话（零 mismatch、零终局）；对照行 = 无覆盖
// 的现状行为。反向断言（表外负样本）：漂移照旧检出——覆盖帧不构成比对豁免。

describe("回放不受扰动（覆盖记账在场，历史旧 model 不触发 replay input mismatch）", () => {

  beforeEach(() => {
    journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "pump-run-events-"));
    setRunEventJournalDirForTest(journalDir);
  });

  afterEach(() => {
    setRunEventJournalDirForTest(undefined);
    fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  /** 历史 call 构造（带 opts 的三参形态——文件头 makeSettledCall 是两参版、opts 固定
   *  { prompt: "p" }；回放比对消费 cached.opts，本 describe 需要 opts 含 model 字段）。 */
  function makeSettledCallWithOpts(callId: number, opts: Record<string, unknown>, result: AgentResult): AgentCall {
    const node: ExecutionTraceNode = {
      stepIndex: callId,
      agent: "reviewer",
      task: "p",
      model: "test-model",
      status: "running",
      startedAt: new Date().toISOString(),
    };
    const call = new AgentCall(callId, opts as never, node);
    call.markRunning();
    call.markDone(result);
    return call;
  }

  /** 表驱动夹具：历史 call opts 恒旧 model；差异仅在 journal 是否携带覆盖帧。 */
  const replayCases = [
    {
      name: "对照行：无覆盖帧（现状行为）——历史 opts 含 model，一致重放回话",
      seedOverride: false,
    },
    {
      name: "覆盖帧在场（model-override B）——历史 opts 旧 model，一致重放仍回话（回放比对不受扰动）",
      seedOverride: true,
    },
  ] as const;

  for (const testCase of replayCases) {
    it(testCase.name, async () => {
      const runId = testCase.seedOverride ? "wf-ovr-replay" : "wf-base-replay";
      const seedJournal = createRunEventJournal(journalDir);
      await seedJournal.append(runId, {
        type: "run-created",
        runId,
        workflowName: "test-wf",
        argsSummary: "{}",
        scriptSource: "agent('a')",
        ts: Date.now(),
      });
      if (testCase.seedOverride) {
        await seedJournal.append(runId, {
          type: "model-override",
          model: { provider: "b-provider", modelId: "b1" },
          ts: Date.now() + 1,
        });
      }

      const run = makeRealRunEv(runId);
      // 历史 call：真实派发形态 opts（含旧 model 字段）+ done 终态
      run.state.calls.set(0, makeSettledCallWithOpts(0, { prompt: "p", model: "old-provider/old-model" }, {
        content: "cached result",
        durationMs: 5,
        toolCalls: [],
      }));
      const deps = makeDeps();
      const handlers: WorkerHandlers = {
        onMessage: vi.fn(async () => {}),
        onError: vi.fn(async () => {}),
        onExit: vi.fn(async () => {}),
      };

      await handleWorkerMessage(
        run,
        // resume 重放：脚本确定性重跑重发同 callId 同 opts（含旧 model——覆盖不改
        // 历史调用参数，派发侧覆写在解析层、到不了回放比对）
        { type: "agent-call", callId: 0, opts: { prompt: "p", model: "old-provider/old-model" } as never },
        deps,
        handlers,
      );
      await flushMicrotasks(20);

      // 回话成功：cached 结果投递 + 零真实派发 + run 未被 mismatch 判死
      expect(isRunSettled(run)).toBe(false);
      expect(deps.runner.run).not.toHaveBeenCalled();
      const events = await scanRunEvents(runId);
      expect(events.some((e) => e.type === "run-settled")).toBe(false);
      const runtime = run.runtime!;
      expect(runtime.worker.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "agent-result", callId: 0, cached: true }),
      );
    });
  }

  it("负样本：覆盖帧在场不构成比对豁免——真漂移（prompt 变化）照旧 mismatch 终局", async () => {
    const runId = "wf-ovr-drift";
    const seedJournal = createRunEventJournal(journalDir);
    await seedJournal.append(runId, {
      type: "run-created",
      runId,
      workflowName: "test-wf",
      argsSummary: "{}",
      scriptSource: "agent('a')",
      ts: Date.now(),
    });
    await seedJournal.append(runId, {
      type: "model-override",
      model: { provider: "b-provider", modelId: "b1" },
      ts: Date.now() + 1,
    });

    const run = makeRealRunEv(runId);
    run.state.calls.set(0, makeSettledCallWithOpts(0, { prompt: "original" }, {
      content: "stale",
      durationMs: 1,
      toolCalls: [],
    }));
    const deps = makeDeps();
    const handlers: WorkerHandlers = {
      onMessage: vi.fn(async () => {}),
      onError: vi.fn(async () => {}),
      onExit: vi.fn(async () => {}),
    };

    await handleWorkerMessage(
      run,
      { type: "agent-call", callId: 0, opts: { prompt: "drifted (Date.now())" } as never },
      deps,
      handlers,
    );
    await flushMicrotasks(20);

    // 漂移照旧检出：failed 终局落 run-settled（覆盖帧没有让比对失效）
    const events = await scanRunEvents(runId);
    const settled = events.find((e) => e.type === "run-settled");
    expect(settled).toBeDefined();
    expect(settled).toMatchObject({ outcome: "failed" });
  });
});
