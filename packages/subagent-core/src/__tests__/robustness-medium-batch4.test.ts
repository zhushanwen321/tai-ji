// Medium batch 4: M4 IPC 字段校验（行为测试）
//
// M4: dispatchAgentCall / dispatchWorkflowCall 在函数最开头校验 IPC 消息字段
// （callId 非数字、opts/args 非对象、prompt/name 非字符串），畸形消息仅记日志后 return，
// 不抛 TypeError、不写 trace 节点、不 postMessage 回 worker。
//
// 通过 handleWorkerMessage 触发 dispatchAgentCall / dispatchWorkflowCall（内部函数不 export）。
// Mock 构造模式参考 orchestration/__tests__/agent-call-catch-fallback.test.ts 和
// orchestration/__tests__/worker-message-pump-workflow-call.test.ts。

import { describe, expect, it, vi } from "vitest";

// Mock 共享 logger，让 logger.error 可被 spy（源码已从 console.error 改为 logger.error）
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("../core/logger.ts", () => ({
  getLogger: () => loggerMock,
}));

import { handleWorkerMessage } from "../orchestration/worker-message-pump.ts";
import type { LifecycleDeps, WorkerHandlers } from "../orchestration/models/ports.ts";
import { Trace } from "../orchestration/models/trace.ts";
import type { AgentResult } from "../orchestration/models/types.ts";
import type { WorkflowRun } from "../orchestration/models/workflow-run.ts";

// ── helpers ──────────────────────────────────────────────────

/** 构造 status="running" 的 mock WorkflowRun，含 trace/budget/calls/runtime。
 *  与 agent-call-catch-fallback.test.ts 同构。 */
function makeRunningRun(runId: string): WorkflowRun {
  const trace = new Trace();
  const controller = new AbortController();
  return {
    runId,
    spec: { scriptName: "test-wf", scriptSource: "agent('hi')", args: {}, runId, slug: undefined },
    state: {
      status: "running" as const,
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
function makeDeps(): LifecycleDeps {
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

function makeHandlers(): WorkerHandlers {
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
      const run = makeRunningRun("wf-m4-001");
      const deps = makeDeps();
      const postMessage = run.runtime!.worker.postMessage as ReturnType<typeof vi.fn>;

      // callId = "not-a-number"（字符串）
      await handleWorkerMessage(
        run,
        { type: "agent-call", callId: "not-a-number", opts: { prompt: "test" } },
        deps,
        makeHandlers(),
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
      const run = makeRunningRun("wf-m4-002");
      const deps = makeDeps();
      const postMessage = run.runtime!.worker.postMessage as ReturnType<typeof vi.fn>;

      await handleWorkerMessage(
        run,
        { type: "agent-call", callId: 1, opts: null },
        deps,
        makeHandlers(),
      );

      expect(run.state.trace.toArray().length).toBe(0);
      expect(run.state.calls.size).toBe(0);
      expect(postMessage).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("opts.prompt 非字符串（数字）→ 不抛、不写 trace 节点", async () => {
    const restore = silenceConsoleError();
    try {
      const run = makeRunningRun("wf-m4-003");
      const deps = makeDeps();
      const postMessage = run.runtime!.worker.postMessage as ReturnType<typeof vi.fn>;

      await handleWorkerMessage(
        run,
        { type: "agent-call", callId: 1, opts: { prompt: 123 } },
        deps,
        makeHandlers(),
      );

      expect(run.state.trace.toArray().length).toBe(0);
      expect(run.state.calls.size).toBe(0);
      expect(postMessage).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("opts 缺失（undefined）→ 不抛、不写 trace 节点", async () => {
    const restore = silenceConsoleError();
    try {
      const run = makeRunningRun("wf-m4-004");
      const deps = makeDeps();
      const postMessage = run.runtime!.worker.postMessage as ReturnType<typeof vi.fn>;

      await handleWorkerMessage(
        run,
        { type: "agent-call", callId: 1, opts: undefined },
        deps,
        makeHandlers(),
      );

      expect(run.state.trace.toArray().length).toBe(0);
      expect(run.state.calls.size).toBe(0);
      expect(postMessage).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("callId 非有限数（NaN）→ 不抛、不写 trace 节点", async () => {
    const restore = silenceConsoleError();
    try {
      const run = makeRunningRun("wf-m4-005");
      const deps = makeDeps();
      const postMessage = run.runtime!.worker.postMessage as ReturnType<typeof vi.fn>;

      await handleWorkerMessage(
        run,
        { type: "agent-call", callId: NaN, opts: { prompt: "test" } },
        deps,
        makeHandlers(),
      );

      expect(run.state.trace.toArray().length).toBe(0);
      expect(run.state.calls.size).toBe(0);
      expect(postMessage).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("正常消息 → 正常派发（trace 节点创建）", async () => {
    const run = makeRunningRun("wf-m4-006");
    const deps = makeDeps();

    await handleWorkerMessage(
      run,
      { type: "agent-call", callId: 1, opts: { prompt: "test", description: "test-agent" } },
      deps,
      makeHandlers(),
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
      const run = makeRunningRun("wf-m4-007");
      const deps = makeDeps();

      await handleWorkerMessage(
        run,
        { type: "agent-call", callId: "bad", opts: { prompt: "test" } },
        deps,
        makeHandlers(),
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

// ── M4: dispatchWorkflowCall 字段校验 ────────────────────────

describe("M4: dispatchWorkflowCall validates IPC fields before dereferencing", () => {
  it("callId 非数字 → 不抛、不 postMessage", async () => {
    const restore = silenceConsoleError();
    try {
      const run = makeRunningRun("wf-m4-w-001");
      const deps = { onWorkflowCall: vi.fn(async () => ({ content: "ok" })) } as unknown as LifecycleDeps;
      const postMessage = run.runtime!.worker.postMessage as ReturnType<typeof vi.fn>;

      await handleWorkerMessage(
        run,
        { type: "workflow-call", callId: "bad", name: "sub", args: {} },
        deps,
        makeHandlers(),
      );

      expect(deps.onWorkflowCall).not.toHaveBeenCalled();
      expect(postMessage).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("name 非字符串 → 不抛、不 postMessage", async () => {
    const restore = silenceConsoleError();
    try {
      const run = makeRunningRun("wf-m4-w-002");
      const deps = { onWorkflowCall: vi.fn(async () => ({ content: "ok" })) } as unknown as LifecycleDeps;
      const postMessage = run.runtime!.worker.postMessage as ReturnType<typeof vi.fn>;

      await handleWorkerMessage(
        run,
        { type: "workflow-call", callId: 1, name: 42, args: {} },
        deps,
        makeHandlers(),
      );

      expect(deps.onWorkflowCall).not.toHaveBeenCalled();
      expect(postMessage).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("args 为 null → 不抛、不 postMessage", async () => {
    const restore = silenceConsoleError();
    try {
      const run = makeRunningRun("wf-m4-w-003");
      const deps = { onWorkflowCall: vi.fn(async () => ({ content: "ok" })) } as unknown as LifecycleDeps;
      const postMessage = run.runtime!.worker.postMessage as ReturnType<typeof vi.fn>;

      await handleWorkerMessage(
        run,
        { type: "workflow-call", callId: 1, name: "sub", args: null },
        deps,
        makeHandlers(),
      );

      expect(deps.onWorkflowCall).not.toHaveBeenCalled();
      expect(postMessage).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("校验失败打印 malformed 日志", async () => {
    loggerMock.error.mockClear();
    try {
      const run = makeRunningRun("wf-m4-w-004");
      const deps = { onWorkflowCall: vi.fn(async () => ({ content: "ok" })) } as unknown as LifecycleDeps;

      await handleWorkerMessage(
        run,
        { type: "workflow-call", callId: "bad", name: 42, args: {} },
        deps,
        makeHandlers(),
      );

      expect(loggerMock.error).toHaveBeenCalled();
      const logged = String(loggerMock.error.mock.calls[0]![0]);
      expect(logged).toContain("malformed workflow-call");
    } finally {
      loggerMock.error.mockClear();
    }
  });

  it("正常消息 → 正常派发（onWorkflowCall 被调用）", async () => {
    const run = makeRunningRun("wf-m4-w-005");
    const onWorkflowCall = vi.fn(async () => ({ content: "ok" }));
    const deps = { onWorkflowCall } as unknown as LifecycleDeps;

    await handleWorkerMessage(
      run,
      { type: "workflow-call", callId: 1, name: "sub", args: { k: 1 } },
      deps,
      makeHandlers(),
    );

    expect(onWorkflowCall).toHaveBeenCalledWith("sub", { k: 1 }, run);
  });
});
