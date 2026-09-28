// src/orchestration/__tests__/resume-replay-validation.test.ts
//
// [U2] 三面测试：canonical JSON 工具（场景 13 schema 哈希稳定）+ pump replay
// 校验增强（cached 命中的输入一致性）+ D11 terminate 分叉（场景 12 core 侧）。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  canonicalJsonHash,
  canonicalJsonStringify,
  handleWorkerMessage,
} from "../worker-message-pump.ts";
import {
  forgetRunResumedOrigin,
  isResumedOriginRun,
  markRunResumedOrigin,
  terminateRunningRuns,
} from "../lifecycle.ts";
import { setRunEventJournalDirForTest } from "../terminal-actions.ts";
import { createRunEventJournal } from "../run-events.ts";
import { resolveAgentOpts } from "../agent-opts-resolver.ts";
import { AgentCall } from "../models/agent-call.ts";
import { Budget } from "../models/budget.ts";
import { RunRuntime } from "../models/run-runtime.ts";
import { Trace } from "../models/trace.ts";
import type { AgentResult, ExecutionTraceNode } from "../models/types.ts";
import { WorkflowRun } from "../models/workflow-run.ts";
import type { LifecycleDeps } from "../models/ports.ts";
import type { WorkerHandle } from "../worker-handle.ts";

// ── helpers ──────────────────────────────────────────────────

function makeRunningRun(
  runId: string,
  opts: { budgetTimeMs?: number } = {},
): { run: WorkflowRun; postMessage: ReturnType<typeof vi.fn> } {
  const postMessage = vi.fn();
  const run = new WorkflowRun(
    runId,
    {
      scriptSource: "async function execute() {}",
      args: {},
      scriptName: "w",
      scriptPath: "",
      ...(opts.budgetTimeMs !== undefined ? { budgetTimeMs: opts.budgetTimeMs } : {}),
    },
    {
      status: "running",
      budget: new Budget(opts.budgetTimeMs !== undefined ? { maxTimeMs: opts.budgetTimeMs } : {}),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
    },
    { startedAt: new Date().toISOString() },
  );
  run.assignRuntime(
    new RunRuntime({ postMessage, terminate: vi.fn(async () => {}) } as unknown as WorkerHandle, new AbortController()),
  );
  return { run, postMessage };
}

/** 真实派发形态的 done call（markRunning → markDone，opts 为真实入参）。 */
function makeSettledCall(callId: number, opts: AgentCall["opts"], result: AgentResult): AgentCall {
  const node: ExecutionTraceNode = {
    stepIndex: callId,
    agent: "reviewer",
    task: "p",
    model: "m",
    status: "running",
    startedAt: new Date().toISOString(),
  };
  const call = new AgentCall(callId, opts, node);
  call.markRunning();
  call.markDone(result);
  return call;
}

function makeDeps(): { deps: LifecycleDeps; runs: Map<string, WorkflowRun> } {
  const runs = new Map<string, WorkflowRun>();
  const deps: LifecycleDeps = {
    store: { save: vi.fn(async () => {}), loadAll: vi.fn(async () => []), stateFilePath: vi.fn(() => "") },
    workerHost: {
      start: vi.fn(() => ({ postMessage: vi.fn(), terminate: vi.fn(async () => {}) } as unknown as WorkerHandle)),
    },
    runner: { run: vi.fn(async () => ({ content: "" })) },
    runs,
    appendEntry: vi.fn(),
    eventBus: { emit: vi.fn() },
    onRunDone: vi.fn(),
    log: vi.fn(),
  };
  return { deps, runs };
}

/** 排空微任务队列（void fire 的 async 投递链推进到稳定态）。 */
async function flushMicrotasks(ticks = 20): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    // eslint-disable-next-line no-await-in-loop -- 排空微任务队列的固定 tick 循环，非逐项等待
    await Promise.resolve();
  }
}

// ── canonical JSON（场景 13）────────────────────────────────

describe("canonical JSON 工具 — schema 哈希稳定（场景 13）", () => {
  it("对象键序无关：不同插入序构造的同值对象产出同一序列化与哈希", () => {
    const a = { type: "object", properties: { x: { type: "string" }, y: { type: "number" } }, required: ["x", "y"] };
    const b = { required: ["x", "y"], properties: { y: { type: "number" }, x: { type: "string" } }, type: "object" };
    expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b));
    expect(canonicalJsonHash(a)).toBe(canonicalJsonHash(b));
  });

  it("嵌套结构递归排序、数组保序、undefined 键跳过", () => {
    expect(canonicalJsonStringify({ b: [3, { z: 1, a: 2 }], a: undefined, c: 1 })).toBe(
      canonicalJsonStringify({ c: 1, b: [3, { a: 2, z: 1 }] }),
    );
    // 数组保序（顺序是语义）
    expect(canonicalJsonStringify([1, 2])).not.toBe(canonicalJsonStringify([2, 1]));
  });

  it("schema 模式调用形态的往返稳定（prompt + schema 组合的哈希一致）", () => {
    // 同一脚本重跑：schema 对象字面量构造序一致；经 IPC 往返后的键序漂移被
    // canonical 形态消除——场景 13 的「零误报 mismatch」机制面
    const callA = { prompt: "extract", schema: { properties: { title: { type: "string" } }, type: "object" } };
    const callB = { prompt: "extract", schema: { type: "object", properties: { title: { type: "string" } } } };
    expect(canonicalJsonHash(callA)).toBe(canonicalJsonHash(callB));
  });
});

// ── pump replay 校验增强（cached 命中的输入一致性）───────────

describe("pump replay 校验增强 — cached 命中的输入一致性", () => {
  let journalDir: string;

  beforeEach(() => {
    journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-replay-"));
    setRunEventJournalDirForTest(journalDir);
  });

  afterEach(() => {
    setRunEventJournalDirForTest(undefined);
    fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("输入一致（真实派发形态 call + 相同 opts）→ cached replay 正常回话", async () => {
    const { run, postMessage } = makeRunningRun("wf-replay-ok");
    run.state.calls.set(0, makeSettledCall(0, { prompt: "same prompt", model: "m1" }, { content: "cached result" }));
    const { deps } = makeDeps();

    await handleWorkerMessage(run, { type: "agent-call", callId: 0, opts: { prompt: "same prompt", model: "m1" } }, deps, {
      onMessage: vi.fn(async () => {}),
      onError: vi.fn(async () => {}),
      onExit: vi.fn(async () => {}),
    });

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent-result", callId: 0, cached: true, result: expect.objectContaining({ content: "cached result" }) }),
    );
  });

  it("输入漂移（prompt 不同）→ 不回话错误结果，run 收敛 failed 终局（run-settled 落 record）", async () => {
    const runId = "wf-replay-mismatch";
    // run-created 帧先落（dispatch 链 fold 基线——mismatch 终局的 run-settled 帧
    // 需要状态机从 running 出发）
    const seedJournal = createRunEventJournal(journalDir);
    await seedJournal.append(runId, {
      type: "run-created",
      runId,
      workflowName: "w",
      argsSummary: "{}",
      scriptSource: "async function execute() {}",
      ts: 1_770_000_000_000,
    });
    const { run, postMessage } = makeRunningRun(runId);
    run.state.calls.set(0, makeSettledCall(0, { prompt: "original prompt" }, { content: "stale result" }));
    const { deps } = makeDeps();

    await handleWorkerMessage(run, { type: "agent-call", callId: 0, opts: { prompt: "drifted prompt (Date.now())" } }, deps, {
      onMessage: vi.fn(async () => {}),
      onError: vi.fn(async () => {}),
      onExit: vi.fn(async () => {}),
    });
    await flushMicrotasks();

    // 不回话（零错误结果投递）+ failed 终局
    expect(postMessage).not.toHaveBeenCalled();
    const events = await createRunEventJournal(journalDir).scan(runId);
    const settled = events.find((e) => e.type === "run-settled");
    expect(settled).toBeDefined();
    expect((settled as { outcome?: string }).outcome).toBe("failed");
  });

  it("占位 opts（resume/重水合重建形态）→ 跳过比对直接回话（零误报，场景 13 约束）", async () => {
    const { run, postMessage } = makeRunningRun("wf-replay-placeholder");
    // 旧格式 record 流重建的 call：帧无 input 载荷（agent-started 入参全文为 [U13]
    // 补齐，落地前落盘的流）→ opts 占位 { prompt: "" }
    const node: ExecutionTraceNode = {
      stepIndex: 0,
      agent: "a",
      task: "",
      model: "",
      status: "completed",
      startedAt: new Date().toISOString(),
    };
    const call = new AgentCall(0, { prompt: "" }, node);
    call.attempts = 1;
    call.status = "done";
    call.result = { content: "replayed" };
    run.state.calls.set(0, call);
    const { deps } = makeDeps();

    await handleWorkerMessage(run, { type: "agent-call", callId: 0, opts: { prompt: "anything rebuilt" } }, deps, {
      onMessage: vi.fn(async () => {}),
      onError: vi.fn(async () => {}),
      onExit: vi.fn(async () => {}),
    });

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent-result", callId: 0, cached: true }),
    );
  });

  it("rebuild 恢复 opts 形态（agent-started input 载荷 parse 往返）→ 比对可比：一致命中回话、漂移检出", async () => {
    // [U13] 机制面：dispatchAgentStarted 落 canonical 序列化入参全文（resolved
    // 形态——schema 已注入 appendSystemPrompt），rebuild 经 JSON.parse 恢复 opts
    // ——与本次消息 opts 走同一 resolveAgentOpts + canonical 哈希比对，形态对称
    // 成立（一致 → 回话；漂移 → mismatch 终局，不再结构性跳过）。
    const roundtrip = (opts: unknown): AgentCall["opts"] =>
      JSON.parse(canonicalJsonStringify(opts)) as AgentCall["opts"];
    const resolvedForm = (raw: AgentCall["opts"]): AgentCall["opts"] =>
      resolveAgentOpts(raw).opts;

    // 一致：rebuild 恢复的 resolved 形态 opts（input 载荷 parse 往返）与重发消息
    // （同一脚本字面量——schema 键序天然一致）经同一管道值级相等
    const { run: okRun, postMessage: okPost } = makeRunningRun("wf-replay-restored-ok");
    okRun.state.calls.set(
      0,
      makeSettledCall(
        0,
        roundtrip(resolvedForm({ prompt: "same", schema: { type: "object", properties: { a: { type: "number" } } } })),
        { content: "cached" },
      ),
    );
    const { deps } = makeDeps();
    await handleWorkerMessage(okRun, { type: "agent-call", callId: 0, opts: { prompt: "same", schema: { type: "object", properties: { a: { type: "number" } } } } }, deps, {
      onMessage: vi.fn(async () => {}),
      onError: vi.fn(async () => {}),
      onExit: vi.fn(async () => {}),
    });
    expect(okPost).toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent-result", callId: 0, cached: true }),
    );

    // 漂移：resume 前缀含非确定性（Date.now() 进 call#1 prompt）→ 检出、不回话
    const runId = "wf-replay-restored-drift";
    const seedJournal = createRunEventJournal(journalDir);
    await seedJournal.append(runId, {
      type: "run-created",
      runId,
      workflowName: "w",
      argsSummary: "{}",
      scriptSource: "async function execute() {}",
      ts: 1_770_000_000_000,
    });
    const driftRun = makeRunningRun(runId);
    driftRun.run.state.calls.set(0, makeSettledCall(0, roundtrip({ prompt: "t=1000" }), { content: "stale" }));
    await handleWorkerMessage(driftRun.run, { type: "agent-call", callId: 0, opts: { prompt: "t=2000" } }, deps, {
      onMessage: vi.fn(async () => {}),
      onError: vi.fn(async () => {}),
      onExit: vi.fn(async () => {}),
    });
    await flushMicrotasks();
    expect(driftRun.postMessage).not.toHaveBeenCalled();
    const events = await createRunEventJournal(journalDir).scan(runId);
    const settled = events.find((e) => e.type === "run-settled");
    expect(settled).toBeDefined();
    expect((settled as { outcome?: string }).outcome).toBe("failed");
  });
});

// ── D11 terminate 分叉（场景 12 core 侧）────────────────────

describe("D11 terminate 分叉 — resume 来源 run 被动失联转 interrupted（场景 12）", () => {
  let journalDir: string;

  beforeEach(() => {
    journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-terminate-"));
    setRunEventJournalDirForTest(journalDir);
  });

  afterEach(() => {
    setRunEventJournalDirForTest(undefined);
    forgetRunResumedOrigin("wf-resumed-origin");
    forgetRunResumedOrigin("wf-normal");
    fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("resume 来源 run：terminate → run-interrupted(terminated) 落 record，非 failed 终局，可再 resume", async () => {
    const runId = "wf-resumed-origin";
    // run-created 落账（fold 基线）+ run-interrupted（前置中断）+ run-resumed（复活）
    const journal = createRunEventJournal(journalDir);
    await journal.append(runId, {
      type: "run-created",
      runId,
      workflowName: "w",
      argsSummary: "{}",
      scriptSource: "async function execute() {}",
      ts: 1_770_000_000_000,
    });
    await journal.append(runId, { type: "run-interrupted", errorCode: "crashed", ts: 1_770_000_001_000 });
    await journal.append(runId, { type: "run-resumed", ts: 1_770_000_002_000 });

    const { run } = makeRunningRun(runId);
    const { deps, runs } = makeDeps();
    runs.set(runId, run);
    markRunResumedOrigin(runId);
    expect(isResumedOriginRun(runId)).toBe(true);

    await terminateRunningRuns(deps, "Session switched: run terminated");

    // record：run-interrupted(terminated)（非 run-settled failed）
    const events = await createRunEventJournal(journalDir).scan(runId);
    const last = events.at(-1);
    expect(last?.type).toBe("run-interrupted");
    expect((last as { errorCode?: string }).errorCode).toBe("terminated");
    expect(events.some((e) => e.type === "run-settled")).toBe(false);
    // 执行资源释放（runtime 解绑）
    expect(run.runtime).toBeUndefined();
    // 可再 resume（场景 12 core 侧闭环：interrupted 态资格成立）
    const { resumeRun } = await import("../resume-run.ts");
    await expect(
      resumeRun(runId, deps, { now: () => 1_770_000_100_000 }),
    ).resolves.toBe(runId);
    expect(runs.get(runId)!.state.status).toBe("running");
  });

  it("正常 run（非 resume 来源）：维持 failed 终局现状语义（不代裁统一 interrupted）", async () => {
    const runId = "wf-normal";
    const journal = createRunEventJournal(journalDir);
    await journal.append(runId, {
      type: "run-created",
      runId,
      workflowName: "w",
      argsSummary: "{}",
      scriptSource: "async function execute() {}",
      ts: 1_770_000_000_000,
    });
    const { run } = makeRunningRun(runId);
    const { deps, runs } = makeDeps();
    runs.set(runId, run);

    await terminateRunningRuns(deps, "Session closed");

    const events = await createRunEventJournal(journalDir).scan(runId);
    const last = events.at(-1);
    expect(last?.type).toBe("run-settled");
    expect((last as { outcome?: string }).outcome).toBe("failed");
    // 正常 run 终局后不可 resume（一次性生命周期）
    expect(isResumedOriginRun(runId)).toBe(false);
  });
});
