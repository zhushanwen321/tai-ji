// src/orchestration/__tests__/worker-message-pump-workflow-dispatch.test.ts
//
// [H2 W3] pump 切换 executeWorkflowAgent 端到端单测（设计
// subagent-workflow-record-unification.md §3.5 终态数据流 / §5 W3）。
//
// 真实链路形态：handleWorkerMessage(agent-call) → dispatchAgentCall →
// deps.workflowAgentDispatch（SubagentService.executeWorkflowAgent 注入形态）→
// fake pi EnginePort（协议 seam 替身，与 W2 workflow-agent-dispatch.test 同源）。
//
// 锁四组面：
//   1. record 进 store：dispatch 在途时 record 带 origin:"workflow" +
//      parentRunId=run.runId（真实 record 经 store 治理面可见——进度源切换的
//      数据前提）；record 级 pending:register 照旧发射。
//   2. worker 协议回包不变：引擎应答 → executeAgentCall finalize →
//      postMessage({type:"agent-result", callId, result})（cached:false）；
//      trace node 终态摘要保真（node.result 来自 executeWorkflowAgent 的
//      AgentResult 出口，D2「node 保留 result」）。
//   3. 成功即终态化（D7 联动回归）：settle 后 record closed/gc + record 级
//      pending:unregister（archive 出内存，run 视图经磁盘面回查终态）。
//   4. 注入面回退：未注入 workflowAgentDispatch（旧测试 deps）→ deps.runner.run
//      被调（SAR 旧编排路径，W4 归位；两路互不串扰）。
//
// 替身形态与测试红线对齐 W2 workflow-agent-dispatch.test.ts：XYZ_AGENT_DATA_DIR
// 指 tmpdir（不触真实数据目录）；logger mock 防噪声。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

import { Budget } from "../models/budget.ts";
import { RunRuntime } from "../models/run-runtime.ts";
import { Trace } from "../models/trace.ts";
import { WorkflowRun } from "../models/workflow-run.ts";
import type { LifecycleDeps, WorkerHandlers } from "../models/ports.ts";
import type { AgentCallOpts } from "../models/types.ts";
import type { WorkerHandle } from "../worker-handle.ts";
import { handleWorkerMessage } from "../worker-message-pump.ts";
import { ModelConfigService } from "../../execution/model-config-service.ts";
import type { ModelInfo, ModelRegistryLike } from "../../execution/model-resolver.ts";
import type { RecordStore } from "../../execution/record-store.ts";
import { SubagentService } from "../../execution/subagent-service.ts";
import type { PiLike } from "../../execution/subagent-service.ts";
import { clearEngines } from "../../execution/engine/registry.ts";
import { registerFakePiEngine, type FakePiEnginePort } from "../../execution/__tests__/helpers/fake-engine-port.ts";

// ── harness ──────────────────────────────────────────────────

function makeEmptyRegistry(): ModelRegistryLike {
  return { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => true };
}

const ctxModel: ModelInfo = { id: "m", name: "M", provider: "p", reasoning: false };

interface PumpHarness {
  service: SubagentService;
  store: RecordStore;
  pi: { appendEntry: ReturnType<typeof vi.fn>; events: { emit: ReturnType<typeof vi.fn> }; sendMessage: ReturnType<typeof vi.fn> };
  fake: FakePiEnginePort;
  run: WorkflowRun;
  postMessage: ReturnType<typeof vi.fn>;
  deps: LifecycleDeps;
  tmpRoot: string;
}

function makePumpHarness(runId: string): PumpHarness {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wf-pump-it-"));
  process.env.XYZ_AGENT_DATA_DIR = path.join(tmpRoot, "engine-data");
  const agentDir = path.join(tmpRoot, "agent");
  const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
  modelService.initModel({ modelRegistry: makeEmptyRegistry(), sessionId: "wf-pump-it", ctxModel });
  const service = new SubagentService({ cwd: agentDir, modelService });
  const pi = {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
  };
  service.initSession({ pi: pi as unknown as PiLike, sessionId: "wf-pump-it" });
  clearEngines();
  const fake = registerFakePiEngine();

  const run = new WorkflowRun(
    runId,
    { scriptName: "test-wf", scriptSource: "agent('调研 A')", args: {}, scriptPath: "/tmp/test.js" },
    { status: "running", budget: new Budget({ maxTokens: 100_000 }), calls: new Map(), trace: new Trace(), errorLogs: [] },
    { startedAt: new Date().toISOString() },
  );
  const postMessage = vi.fn();
  const initialWorker = { postMessage, terminate: vi.fn(async () => {}) } as unknown as WorkerHandle;
  run.assignRuntime(new RunRuntime(initialWorker, new AbortController()));

  // 组合根注入形态（extension index.ts makeDeps 的等价内联）：dispatch 闭包捕获
  // service 单例，parentRunId 由 pump 侧补 run.runId。
  const deps = {
    store: { save: vi.fn(async () => {}) },
    workerHost: { start: vi.fn() },
    runner: { run: vi.fn(async () => ({ content: "legacy-runner", durationMs: 1, error: undefined, toolCalls: [] })) },
    runs: new Map([[runId, run]]),
    eventBus: { emit: vi.fn() },
    log: vi.fn(),
    workflowAgentDispatch: (opts: AgentCallOpts, parentRunId: string, signal?: AbortSignal) =>
      service.executeWorkflowAgent(opts, parentRunId, signal),
  } as unknown as LifecycleDeps;
  return { service, store: Reflect.get(service, "store") as RecordStore, pi, fake, run, postMessage, deps, tmpRoot };
}

function makeHandlers(): WorkerHandlers {
  return {
    onMessage: vi.fn(async () => {}),
    onError: vi.fn(async () => {}),
    onExit: vi.fn(async () => {}),
  } as unknown as WorkerHandlers;
}

/** 微任务冲刷（dispatch → 路由 → record 注册 → acquire → engine.run 链）。 */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function findAgentResultPost(postMessage: ReturnType<typeof vi.fn>, callId: number) {
  return postMessage.mock.calls
    .map((c) => c[0] as { type?: string; callId?: number; result?: { content?: string; error?: string }; cached?: boolean })
    .find((m) => m.type === "agent-result" && m.callId === callId);
}

let prevDataDirEnv: string | undefined;

beforeEach(() => {
  prevDataDirEnv = process.env["XYZ_AGENT_DATA_DIR"];
});

afterEach(() => {
  vi.restoreAllMocks();
  if (prevDataDirEnv === undefined) delete process.env["XYZ_AGENT_DATA_DIR"];
  else process.env["XYZ_AGENT_DATA_DIR"] = prevDataDirEnv;
});

// ── 1+2+3：注入 dispatch 的端到端主路径 ───────────────────────

describe("pump → executeWorkflowAgent 端到端", () => {
  it("record 进 store（origin=workflow + parentRunId）→ settle → 回包/终态摘要/D7 终态化全链", async () => {
    const h = makePumpHarness("wf-pump-e2e-1");
    await handleWorkerMessage(
      h.run,
      { type: "agent-call", callId: 1, opts: { prompt: "调研 A", description: "research-a" } },
      h.deps,
      makeHandlers(),
    );
    await flush();

    // 1. dispatch 在途：真实 record 在 store（origin/parentRunId——views store 订阅的数据
    //    前提）。经 views 同款查询面（queries.collectRecordsByParentRunId）断言命中，
    //    再经 getMutable 拿真 record 验 originFields（listRunning 是 RecordSnapshot
    //    轻投影，无 origin 字段——勿用）。
    const found = h.service.queries.collectRecordsByParentRunId("wf-pump-e2e-1", 100);
    expect(found).toHaveLength(1);
    expect(found[0]!.origin).toBe("workflow");
    expect(found[0]!.parentRunId).toBe("wf-pump-e2e-1");
    expect(found[0]!.status).toBe("running");
    const record = h.store.getMutable(found[0]!.id)!;
    expect(record.origin).toBe("workflow");
    expect(record.parentRunId).toBe("wf-pump-e2e-1");
    // 引擎收到 run（taskId = record.id——守护/journal 键，W2 已锁定）
    expect(h.fake.runs).toHaveLength(1);
    // record 级 pending:register 照旧（D5：record 域发射面不动）
    const registered = h.pi.events.emit.mock.calls.find((c) => c[0] === "pending:register");
    expect(registered?.[1]).toMatchObject({ id: record.id, type: "subagent" });

    // 2. 引擎应答 → worker 协议回包 + trace node 终态摘要
    //    （settle 后链路含 journal.close 的真 fs await，用 waitFor 收敛）
    h.fake.runs[0]!.settle({ content: "ok", sessionId: "sess-1", sessionFile: "/tmp/sess-1.jsonl", durationMs: 5 });
    await vi.waitFor(() => {
      expect(findAgentResultPost(h.postMessage, 1)).toBeDefined();
    });

    const posted = findAgentResultPost(h.postMessage, 1);
    expect(posted).toBeDefined();
    expect(posted!.cached).toBe(false);
    expect(posted!.result!.content).toBe("ok");
    expect(posted!.result!.error).toBeUndefined();
    // node 终态摘要（D2：live 删除后 node 保留 result——数据源 = executeWorkflowAgent
    // 的 AgentResult 出口，经 executeAgentCall finalizeCall 写入）
    const node = h.run.state.trace.find(1);
    expect(node?.status).toBe("completed");
    expect(node?.result?.content).toBe("ok");
    expect(node?.result?.sessionFile).toBe("/tmp/sess-1.jsonl");
    expect(node?.completedAt).toBeDefined();
    expect(h.run.state.calls.get(1)?.status).toBe("done");

    // 3. D7 联动：成功即终态化（closed/gc + archive 出内存）+ record 级 unregister。
    //    （archive 后从磁盘重建面回查终态的「run 视图不丢行」行为由 W1 record-store
    //    的 mergedRecords 测试锁定——本 harness 的 pi mock 不落盘，不在此重复。）
    expect(h.store.listRunning()).toHaveLength(0);
    const unregistered = h.pi.events.emit.mock.calls.find((c) => c[0] === "pending:unregister");
    expect(unregistered?.[1]).toMatchObject({ id: record.id });

    // 4. run 级 pending 配对不回归（D5：lifecycle↔pump 的 run 级注册/注销对零改动
    //    ——lifecycle.ts 零 diff 由 git 自查；此处锁 pump 侧 run 终态注销行为）：
    //    脚本 return → finalizeRun emit pending:unregister with id=runId。
    await handleWorkerMessage(h.run, { type: "return", result: "done" }, h.deps, makeHandlers());
    const runUnregister = h.deps.eventBus!.emit as ReturnType<typeof vi.fn>;
    const runUnregCall = runUnregister.mock.calls.find((c) => c[0] === "pending:unregister");
    expect(runUnregCall?.[1]).toMatchObject({ id: "wf-pump-e2e-1" });
    expect(h.run.state.status).toBe("done");
  });

  it("失败结果：引擎 error outcome → 回包 error + trace failed 终态摘要", async () => {
    const h = makePumpHarness("wf-pump-e2e-2");
    await handleWorkerMessage(
      h.run,
      { type: "agent-call", callId: 2, opts: { prompt: "调研 B", description: "research-b" } },
      h.deps,
      makeHandlers(),
    );
    await flush();
    expect(h.fake.runs).toHaveLength(1);

    // 失败结果带巨额 usage 打爆 run 预算（Budget maxTokens=100k）——executeAgentCall
    // 的「预算超限不重试」分支直接 finalize（否则 error 结果走 1s/2s 退避重试，
    // 测试需 fake timers 推进；重试语义已由 execute-agent-call.test.ts 锁定，此处
    // 聚焦 pump 切换后的回包/终态摘要）。
    h.fake.runs[0]!.settle({ content: "", error: "engine blew up", durationMs: 3, usage: { input: 1_000_000, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 } });
    await vi.waitFor(() => {
      expect(findAgentResultPost(h.postMessage, 2)).toBeDefined();
    });

    const posted = findAgentResultPost(h.postMessage, 2);
    expect(posted).toBeDefined();
    expect(posted!.result!.error).toBe("engine blew up");
    const node = h.run.state.trace.find(2);
    expect(node?.status).toBe("failed");
    expect(node?.result?.error).toBe("engine blew up");
    expect(h.run.state.calls.get(2)?.status).toBe("done");
  });
});

// ── 4：注入面回退（旧 deps 不注入 dispatch） ──────────────────

describe("workflowAgentDispatch 未注入回退", () => {
  it("旧 deps（仅 runner）→ deps.runner.run 被调（[H2 W4] SAR.run 已掏空为纯转调 executeWorkflowAgent，两分支执行体归一；生产恒注入 dispatch 本分支不可达，仅为旧测试 deps 形态兼容）", async () => {
    const run = new WorkflowRun(
      "wf-pump-fallback-1",
      { scriptName: "test-wf", scriptSource: "agent('hi')", args: {}, scriptPath: "/tmp/test.js" },
      { status: "running", budget: new Budget(), calls: new Map(), trace: new Trace(), errorLogs: [] },
      { startedAt: new Date().toISOString() },
    );
    const runnerRun = vi.fn(async () => ({ content: "legacy", durationMs: 1, error: undefined, toolCalls: [] }));
    const postMessage = vi.fn();
    const deps = {
      store: { save: vi.fn(async () => {}) },
      workerHost: { start: vi.fn() },
      runner: { run: runnerRun },
      runs: new Map(),
      eventBus: { emit: vi.fn() },
      log: vi.fn(),
    } as unknown as LifecycleDeps;
    run.assignRuntime(new RunRuntime({ postMessage, terminate: vi.fn(async () => {}) } as unknown as WorkerHandle, new AbortController()));

    await handleWorkerMessage(run, { type: "agent-call", callId: 7, opts: { prompt: "p" } }, deps, makeHandlers());
    await flush();

    expect(runnerRun).toHaveBeenCalledTimes(1);
    const posted = findAgentResultPost(postMessage, 7);
    expect(posted?.result?.content).toBe("legacy");
  });
});
