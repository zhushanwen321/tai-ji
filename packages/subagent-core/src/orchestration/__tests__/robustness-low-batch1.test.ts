// Low batch 1 robustness fix verification
//
// [round5-g 合并产物] 吸收 robustness 系列姊妹件：
// - robustness-medium-batch4.test.ts（M4 IPC 字段校验）。其 makeRunningRun/
//   makeDeps/makeHandlers 与本文件同名异签，改名 makeM4* 前缀消歧；logger 桩
//   提升为文件级（本文件原用真实 logger，仅静默无断言影响）。
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
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("../../core/logger.ts", () => ({
  getLogger: () => loggerMock,
}));


import {
  handleScriptError,
  handleWorkerMessage,
} from "../worker-message-pump.ts";
import {
  dispatchRunCreated,
  isRunSettled,
  settledRecordOf,
} from "../terminal-actions.ts";
import type { LifecycleDeps, WorkerHandlers } from "../models/ports.ts";
import type { WorkflowRun } from "../models/workflow-run.ts";
import { Trace } from "../models/trace.ts";
import type { AgentResult } from "../../shared/agent-call-types.js";

// ── helpers ──────────────────────────────────────────────────

/**
 * 构造一个活体（未终局）mock WorkflowRun。
 *
 * 关键：errorLogs 必须是真实数组（push/slice 会操作它），不能用 vi.fn 占位。
 */
let runSeqL9 = 0;
function makeRunningRun(): WorkflowRun {
  const run = {
    // [W2/V1] 模块级活体态/终局注册表按 runId 键控——唯一化防跨测试污染
    runId: `run-test-${++runSeqL9}`,
    state: {
      reason: undefined as string | undefined,
      budget: { usedTokens: 0, usedCost: 0 },
      // 真实数组——push/slice 直接作用于它
      errorLogs: [] as Array<{ level: string; message: string }>,
      scriptResult: undefined as unknown,
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
    },
    runtime: {
      worker: { postMessage: vi.fn() },
    },
    replaceRuntime(this: WorkflowRun, rt: NonNullable<WorkflowRun["runtime"]>): void {
      this.runtime = rt;
    },
    releaseRuntime: vi.fn(),
  } as unknown as WorkflowRun;
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

describe("L9: errorLogs 追加（非覆盖）", () => {
  it("预置 2 条 errorLogs 后 handleReturn 再追加 1 条 → 长度 3（workerLogs 通路同 L9 追加）", async () => {
    const run = makeRunningRun();
    const deps = makeDeps();
    await dispatchRunCreated(run); // [W2/V1] 六态机引导（run-created 首帧——终局裁决前置）

    // 预置 2 条既有诊断日志（[ADR-0122] 原「scriptError 重试不终态化累积」形态已删，
    // scriptError 一次即终态——改用预置构造追加前提）
    run.state.errorLogs.push({ level: "error", message: "diag-1" });
    run.state.errorLogs.push({ level: "warn", message: "diag-2" });

    // handleReturn 经 handleWorkerMessage 触发——workerLogs 先追加、后走 finalizeRun 终局 coda
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
    // 追加而非覆盖：前两条保留
    expect(run.state.errorLogs[0].message).toBe("diag-1");
    expect(run.state.errorLogs[1].message).toBe("diag-2");
    // scriptResult 也被正确写入（验证未破坏其他字段）
    expect(run.state.scriptResult).toBe("final-result");
    // [W2/V1] 终局断言换源（两态机字段停更——终局经注册表判定）
    expect(isRunSettled(run)).toBe(true);
    expect(settledRecordOf(run.runId)).toMatchObject({ outcome: "done" });
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

    // handleScriptError 内部 push 3 条 + 截断（终态路径，ADR-0122 一次即 failed）。
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

// ══════ 来源: robustness-medium-batch4.test.ts ══════

// Medium batch 4: M4 IPC 字段校验（行为测试）
//
// M4: dispatchAgentCall / dispatchWorkflowCall 在函数最开头校验 IPC 消息字段
// （callId 非数字、opts/args 非对象、prompt/name 非字符串），畸形消息仅记日志后 return，
// 不抛 TypeError、不写 trace 节点、不 postMessage 回 worker。
//
// 通过 handleWorkerMessage 触发 dispatchAgentCall / dispatchWorkflowCall（内部函数不 export）。
// Mock 构造模式参考 orchestration/__tests__/agent-call-catch-fallback.test.ts 和
// orchestration/__tests__/worker-message-pump-workflow-call.test.ts。


// Mock 共享 logger，让 logger.error 可被 spy（源码已从 console.error 改为 logger.error）

// ── helpers ──────────────────────────────────────────────────

/** 构造活体（未终局）mock WorkflowRun，含 trace/budget/calls/runtime。
 *  与 agent-call-catch-fallback.test.ts 同构。 */
function makeM4RunningRun(runId: string): WorkflowRun {
  const trace = new Trace();
  const controller = new AbortController();
  return {
    runId,
    spec: { scriptName: "test-wf", scriptSource: "agent('hi')", args: {}, runId, slug: undefined },
    state: {
      reason: undefined,
      trace,
      budget: {
        usedTokens: 0,
        usedCost: 0,
        totalCallCount: 0,
        consume: vi.fn(),
        isExceeded: vi.fn(() => false),
        incrementCallCount: vi.fn(),
      },
      calls: new Map(),
      scriptResult: undefined,
    },
    meta: { startedAt: new Date().toISOString(), workerErrorCount: 0, scriptErrorCount: 0 },
    runtime: {
      controller,
      worker: { postMessage: vi.fn() },
    },
    transition: vi.fn(),
    replaceRuntime: vi.fn(),
  } as unknown as WorkflowRun;
}

/** LifecycleDeps mock——runner.run 默认成功。 */
function makeM4Deps(): LifecycleDeps {
  const runnerRun = vi.fn(async () => {
    return { content: "OK", durationMs: 10, error: undefined, toolCalls: [] } as AgentResult;
  });
  return {
    store: { save: vi.fn(async () => {}) },
    workerHost: { start: vi.fn() },
    runner: { run: runnerRun },
    runs: new Map(),
    eventBus: { emit: vi.fn() },
    onRunDone: vi.fn(),
    log: vi.fn(),
  } as unknown as LifecycleDeps;
}

function makeM4Handlers(): WorkerHandlers {
  return {
    onMessage: vi.fn(async () => {}),
    onError: vi.fn(async () => {}),
    onExit: vi.fn(async () => {}),
  } as unknown as WorkerHandlers;
}

/** 清空 logger.error 调用记录（校验失败会打印 malformed 消息日志，避免污染跨用例断言）。 */
function silenceConsoleError(): () => void {
  loggerMock.error.mockClear();
  return () => {
    loggerMock.error.mockClear();
  };
}

// ── M4: dispatchAgentCall 字段校验 ───────────────────────────

describe("M4: dispatchAgentCall validates IPC fields before dereferencing", () => {
  it("callId 非数字 → 不抛、不写 trace 节点、不 postMessage", async () => {
    const restore = silenceConsoleError();
    try {
      const run = makeM4RunningRun("wf-m4-001");
      const deps = makeM4Deps();
      const postMessage = run.runtime!.worker.postMessage as ReturnType<typeof vi.fn>;

      // callId = "not-a-number"（字符串）
      await handleWorkerMessage(
        run,
        { type: "agent-call", callId: "not-a-number", opts: { prompt: "test" } },
        deps,
        makeM4Handlers(),
      );

      expect(run.state.trace.toArray().length).toBe(0);
      expect(run.state.calls.size).toBe(0);
      expect(postMessage).not.toHaveBeenCalled();
      expect(deps.store.save).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("opts 为 null → 不抛、不写 trace 节点", async () => {
    const restore = silenceConsoleError();
    try {
      const run = makeM4RunningRun("wf-m4-002");
      const deps = makeM4Deps();
      const postMessage = run.runtime!.worker.postMessage as ReturnType<typeof vi.fn>;

      await handleWorkerMessage(
        run,
        { type: "agent-call", callId: 1, opts: null },
        deps,
        makeM4Handlers(),
      );

      expect(run.state.trace.toArray().length).toBe(0);
      expect(run.state.calls.size).toBe(0);
      // 加固语义（oe-harden）：callId 合法的畸形载荷回发 error result 收敛 worker 侧
      // pending（旧行为 = 仅日志不回发，worker 内该 callId 永久悬挂且无墙钟兜底）
      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(postMessage.mock.calls[0])).toContain("malformed");
    } finally {
      restore();
    }
  });

  it("opts.prompt 非字符串（数字）→ 不抛、不写 trace 节点", async () => {
    const restore = silenceConsoleError();
    try {
      const run = makeM4RunningRun("wf-m4-003");
      const deps = makeM4Deps();
      const postMessage = run.runtime!.worker.postMessage as ReturnType<typeof vi.fn>;

      await handleWorkerMessage(
        run,
        { type: "agent-call", callId: 1, opts: { prompt: 123 } },
        deps,
        makeM4Handlers(),
      );

      expect(run.state.trace.toArray().length).toBe(0);
      expect(run.state.calls.size).toBe(0);
      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(postMessage.mock.calls[0])).toContain("malformed");
    } finally {
      restore();
    }
  });

  it("opts 缺失（undefined）→ 不抛、不写 trace 节点", async () => {
    const restore = silenceConsoleError();
    try {
      const run = makeM4RunningRun("wf-m4-004");
      const deps = makeM4Deps();
      const postMessage = run.runtime!.worker.postMessage as ReturnType<typeof vi.fn>;

      await handleWorkerMessage(
        run,
        { type: "agent-call", callId: 1, opts: undefined },
        deps,
        makeM4Handlers(),
      );

      expect(run.state.trace.toArray().length).toBe(0);
      expect(run.state.calls.size).toBe(0);
      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(postMessage.mock.calls[0])).toContain("malformed");
    } finally {
      restore();
    }
  });

  it("callId 非有限数（NaN）→ 不抛、不写 trace 节点", async () => {
    const restore = silenceConsoleError();
    try {
      const run = makeM4RunningRun("wf-m4-005");
      const deps = makeM4Deps();
      const postMessage = run.runtime!.worker.postMessage as ReturnType<typeof vi.fn>;

      await handleWorkerMessage(
        run,
        { type: "agent-call", callId: NaN, opts: { prompt: "test" } },
        deps,
        makeM4Handlers(),
      );

      expect(run.state.trace.toArray().length).toBe(0);
      expect(run.state.calls.size).toBe(0);
      expect(postMessage).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("正常消息 → 正常派发（trace 节点创建）", async () => {
    const run = makeM4RunningRun("wf-m4-006");
    const deps = makeM4Deps();

    await handleWorkerMessage(
      run,
      { type: "agent-call", callId: 1, opts: { prompt: "test", description: "test-agent" } },
      deps,
      makeM4Handlers(),
    );

    // 正常消息应创建 trace 节点（status=running，等待异步执行）
    const nodes = run.state.trace.toArray();
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes[0]!.stepIndex).toBe(1);
    expect(nodes[0]!.task).toBe("test");
    expect(nodes[0]!.agent).toBe("test-agent");
    // call 已入 run.state.calls
    expect(run.state.calls.size).toBeGreaterThan(0);
  });

  it("校验失败打印 malformed 日志（含 callId）", async () => {
    loggerMock.error.mockClear();
    try {
      const run = makeM4RunningRun("wf-m4-007");
      const deps = makeM4Deps();

      await handleWorkerMessage(
        run,
        { type: "agent-call", callId: "bad", opts: { prompt: "test" } },
        deps,
        makeM4Handlers(),
      );

      expect(loggerMock.error).toHaveBeenCalled();
      const logged = String(loggerMock.error.mock.calls[0]![0]);
      expect(logged).toContain("malformed agent-call");
      expect(logged).toContain('"bad"');
    } finally {
      loggerMock.error.mockClear();
    }
  });
});
