// src/orchestration/__tests__/agent-call-catch-fallback.test.ts
//
// U7: dispatchAgentCall catch 分支回发 agent-result 给 worker（吞错兜底）
//
// 场景：executeAgentCall（或 gate.withSlot）抛非 Abort 异常时，原 catch 块仅
// console.error，worker 内对应 callId 的 pending Promise 永不 resolve → agent()
// 永久 await → worker 脚本挂死。修复后 catch 块构造 failed AgentResult 并
// postAgentResult 回 worker，使 pending Promise 能 resolve（结果为 error）。
//
// 通过 handleWorkerMessage 触发 dispatchAgentCall（内部函数不 export）。
// Mock 构造模式参考 agent-call-stream.test.ts。

import { describe, expect, it, vi } from "vitest";

import { handleWorkerMessage } from "../worker-message-pump.ts";
import type { LifecycleDeps, WorkerHandlers } from "../models/ports.ts";
import { Trace } from "../models/trace.ts";
import type { WorkflowRun } from "../models/workflow-run.ts";
import type { AgentResult } from "../models/types.ts";
import { flushMicrotasks } from "./helpers/flush-microtasks.ts";

// ── helpers ──────────────────────────────────────────────────

/** 构造 status="running" 的 mock WorkflowRun，含 trace/budget/calls/runtime。
 *  worker.postMessage 为 vi.fn spy，便于断言回发内容。gate.withSlot 直接 await fn()
 *  让异常透传到外层 .catch（模拟 executeAgentCall 抛错的真实链路）。 */
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

/** LifecycleDeps mock，runner.run 可配置为 reject 指定 error。 */
function makeDeps(opts: { runnerError?: Error } = {}): LifecycleDeps {
  const runnerRun = vi.fn(async () => {
    if (opts.runnerError) throw opts.runnerError;
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
    // streamSink 不设 = undefined（本测试不关心 stream）
  } as unknown as LifecycleDeps;
}

function makeHandlers(): WorkerHandlers {
  return {
    onMessage: vi.fn(async () => {}),
    onError: vi.fn(async () => {}),
    onExit: vi.fn(async () => {}),
  } as unknown as WorkerHandlers;
}

/** agent-call 消息 */
function makeAgentCallMsg(callId: number): unknown {
  return {
    type: "agent-call",
    callId,
    phase: "test-phase",
    opts: { prompt: "test task", agent: "worker", description: "test-slug" },
  };
}

/** 从 postMessage spy 的所有调用中找 type:"agent-result" 且 callId 匹配的参数。 */
function findAgentResultPost(
  postMessage: ReturnType<typeof vi.fn>,
  callId: number,
): { type: string; callId: number; result: AgentResult; cached: boolean } | undefined {
  for (const call of postMessage.mock.calls) {
    const msg = call[0] as { type?: string; callId?: number; result?: AgentResult; cached?: boolean };
    if (msg?.type === "agent-result" && msg.callId === callId) return msg as never;
  }
  return undefined;
}

/** 静默 console.error（catch 块会打印失败日志，避免污染测试输出）。 */
function silenceConsoleError(): () => void {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  return () => spy.mockRestore();
}

// ── U7a: 非 Abort 异常 → postAgentResult 回发 failed result ──

describe("U7a: catch 分支兜底回发 agent-result（非 Abort 异常）", () => {
  it("runner.run reject 'runner exploded' → worker 收到 {success:false, error:'runner exploded'}", async () => {
    const restore = silenceConsoleError();
    try {
      const deps = makeDeps({ runnerError: new Error("runner exploded") });
      const run = makeRunningRun("wf-catch-001");
      const handlers = makeHandlers();
      const postMessage = run.runtime!.worker.postMessage as ReturnType<typeof vi.fn>;

      await handleWorkerMessage(run, makeAgentCallMsg(2), deps, handlers);

      // dispatchAgentCall 内 void withSlot(...)（fire-and-forget），需等微任务完成
      await vi.waitFor(() => {
        expect(findAgentResultPost(postMessage, 2)).toBeDefined();
      });

      const posted = findAgentResultPost(postMessage, 2)!;
      expect(posted.type).toBe("agent-result");
      expect(posted.callId).toBe(2);
      expect(posted.cached).toBe(false);
      // AgentResult.error 字段承载错误信息（与 resolveAgentOpts 失败路径一致）
      expect(posted.result.error).toBe("runner exploded");
      expect(posted.result.content).toBe("");

      // state 一致性三件套（review should_fix；[H2 W3] trace.live 字段已删除，
      // 「live 清除」由类型层面收敛——节点无运行期附属对象）：
      // trace node 标 failed（不遗留 running 幽灵节点）
      const traceNode = run.state.trace.find(2);
      expect(traceNode?.status).toBe("failed");
      expect(traceNode?.result?.error).toBe("runner exploded");
      // 持久化（catch 是最需留证的场景）
      expect(deps.store.save).toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("非 Error 值 reject（字符串）→ error 字段为该字符串", async () => {
    const restore = silenceConsoleError();
    try {
      const deps = makeDeps({ runnerError: "string failure" as unknown as Error });
      const run = makeRunningRun("wf-catch-002");
      const handlers = makeHandlers();
      const postMessage = run.runtime!.worker.postMessage as ReturnType<typeof vi.fn>;

      await handleWorkerMessage(run, makeAgentCallMsg(7), deps, handlers);

      await vi.waitFor(() => {
        expect(findAgentResultPost(postMessage, 7)).toBeDefined();
      });

      const posted = findAgentResultPost(postMessage, 7)!;
      expect(posted.result.error).toBe("string failure");
    } finally {
      restore();
    }
  });
});

// ── U7b: AbortError → 不回发（预期路径，吞掉） ──

describe("U7b: AbortError 不回发 agent-result", () => {
  it("runner.run reject AbortError → postAgentResult 不被调用", async () => {
    const restore = silenceConsoleError();
    try {
      const abortErr = new Error("aborted");
      abortErr.name = "AbortError";
      const deps = makeDeps({ runnerError: abortErr });
      const run = makeRunningRun("wf-catch-003");
      const handlers = makeHandlers();
      const postMessage = run.runtime!.worker.postMessage as ReturnType<typeof vi.fn>;

      await handleWorkerMessage(run, makeAgentCallMsg(3), deps, handlers);

      // 等待 fire-and-forget 链路稳定：无 agent-result 回发。
      // 先 flush 微任务队列（多次确保 withSlot promise 已 settle），
      // 再断言断言期内无 agent-result。vi.waitFor 用反向断言会一满足就 return，
      // 故采用：跑若干 microtask tick 后静态断言。
      await flushMicrotasks(5);
      const posted = findAgentResultPost(postMessage, 3);
      expect(posted).toBeUndefined();
    } finally {
      restore();
    }
  });
});
