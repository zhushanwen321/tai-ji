// src/orchestration/__tests__/agent-call-stream.test.ts
//
// [H2 W3] 原 U4/U5（dispatchAgentCall 创建 SubagentStream + widgetKey 格式）与
// U6（streamSink undefined 降级）锁定的是 pump 旁路 streaming 通道——该族随设计
// subagent-workflow-record-unification.md D2「stream 通道承接」退役：pump 不再
// 构造 SubagentStream（streaming 由 service 派发路径既有通道承载）。
//
// [R2-5] streamSink 注入面已彻底删除（LifecycleDeps 死字段清理）：U4' 的运行时
// 负向断言（「streamSink 已注入 → setWidget 零调用」）前提消失，改为**编译期结构
// 断言**（下方 HasStreamSink）——字段若被重新引入，keyof LifecycleDeps 重新出现
// "streamSink"，类型断言立即编译红；比运行时负向用例更强的永久护栏。
//
// 本文件现锁定：
// - U4'（编译期）：LifecycleDeps 不再有 streamSink 注入面
// - U6（运行时）：最简 deps（无 stream 通道）下 runner.run 仍被调用，无异常

import { describe, expect, it, vi } from "vitest";

import { handleWorkerMessage } from "../worker-message-pump.ts";
import type { LifecycleDeps, WorkerHandlers } from "../models/ports.ts";
import { Trace } from "../models/trace.ts";
import type { WorkflowRun } from "../models/workflow-run.ts";
import type { AgentResult } from "../models/types.ts";

// ── helpers ──────────────────────────────────────────────────

function makeMockResult(): AgentResult {
  return { content: "OK", durationMs: 10, error: undefined, toolCalls: [] };
}

/** 构造 status="running" 的 mock WorkflowRun，含 trace/budget/calls/runtime */
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

/** LifecycleDeps mock（runner.run 可控制返回值；streamSink 注入面已随 [R2-5] 删除） */
function makeDeps(opts: {
  runnerResult?: AgentResult;
} = {}): LifecycleDeps {
  return {
    store: { save: vi.fn(async () => {}) },
    workerHost: { start: vi.fn() },
    runner: { run: vi.fn(async () => opts.runnerResult ?? makeMockResult()) },
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

/** agent-call 消息 */
function makeAgentCallMsg(callId: number): unknown {
  return {
    type: "agent-call",
    callId,
    phase: "test-phase",
    opts: { prompt: "test task", agent: "worker", description: "test-slug" },
  };
}

// ── U4': stream 通道退役（编译期结构断言，[R2-5]） ──

/** "streamSink" ∈ keyof LifecycleDeps 时为 true——与下方显式 false 标注冲突即编译红。 */
type HasStreamSink = "streamSink" extends keyof LifecycleDeps ? true : false;
// 结构断言本体：字段已删 = false。若有人重新引入 streamSink 字段，本行类型错误，
// tsc / vue-tsc 拦截（vitest 转译不做类型检查；类型门由 pre-commit/CI 的 tsc 面
// 覆盖——比运行时负向用例更强的注入面消失护栏）。
const assertNoStreamSinkField: HasStreamSink = false;
void assertNoStreamSinkField;

// ── U6: 最简 deps 下派发不报错 ──

describe("U6: 最简 deps（无 stream 通道）→ runner.run 仍被调用，无异常", () => {
  it("dispatchAgentCall 不依赖 stream 注入面 → runner.run 正常派发", async () => {
    const runnerRun = vi.fn(async () => makeMockResult());
    const deps = {
      store: { save: vi.fn(async () => {}) },
      workerHost: { start: vi.fn() },
      runner: { run: runnerRun },
      runs: new Map(),
      eventBus: { emit: vi.fn() },
      onRunDone: vi.fn(),
      log: vi.fn(),
    } as unknown as LifecycleDeps;
    const run = makeRunningRun("wf-test-456");
    const handlers = makeHandlers();

    await handleWorkerMessage(run, makeAgentCallMsg(0), deps, handlers);

    expect(runnerRun).toHaveBeenCalledTimes(1);
  });
});
