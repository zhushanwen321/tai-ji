// src/orchestration/__tests__/stderr-tee-diagnostic-reference.test.ts
//
// [D5 诊断引用落账] stderrTeePath 生产链测试（2026-09-22 一致性审查 P1 修复）。
//
// 锁四面（S2「stderr tee 文件路径在事件载荷中且文件存在」的 L1 等价用例）：
// 1. 全链三段：引擎上报（call.result.stderrTeePath 注入——真实引擎段由
//    pi-subagent-cli run-spawn-once.integration 覆盖）→ dispatchAskSettled 事件
//    载荷含路径 → 失败终局 manifest 含路径（事件流投影取值）。
// 2. 失败伴随纪律：成功 ask / cancelled 终局不带 stderrTeePath（成功/cancel 不写）。
// 3. 旧 manifest 读兼容：无 stderrTeePath 字段的存量形态读回 undefined 不炸。
// 4. journal 目录测试注入（setRunEventJournalDirForTest + mkdtemp 自建自删）；
//    tee fixture 落真实临时文件并断言存在性（S2 L1 等价——不 mock 文件存在性）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  dispatchAskDispatched,
  dispatchAskSettled,
  dispatchRunCreated,
  finalizeRun,
  setRunEventJournalDirForTest,
} from "../worker-message-pump.ts";
import { createRunEventJournal } from "../run-events.ts";
import { AgentCall } from "../models/agent-call.ts";
import { Budget } from "../models/budget.ts";
import { RunRuntime } from "../models/run-runtime.ts";
import { Trace } from "../models/trace.ts";
import type { AgentCallOpts, AgentResult, ExecutionTraceNode } from "../models/types.ts";
import type { WorkflowRunEvent } from "../run-events.ts";
import { WorkflowRun } from "../models/workflow-run.ts";
import type { LifecycleDeps } from "../models/ports.ts";
import type { WorkerHandle } from "../worker-handle.ts";
import { readRunTerminalManifest } from "../../execution/persistence/manifest-store.ts";

// ── helpers ──────────────────────────────────────────────────

let journalDir: string;
let fixtureDir: string;
/** 各用例自建的 tee fixture（真实文件——存在性断言的目标），afterEach 统一清理。 */
const teeFixtures: string[] = [];

beforeEach(() => {
  journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "stderr-tee-journal-"));
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "stderr-tee-fixture-"));
  setRunEventJournalDirForTest(journalDir);
});

afterEach(() => {
  setRunEventJournalDirForTest(undefined);
  fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  fs.rmSync(fixtureDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  teeFixtures.length = 0;
});

/** 落一个真实 tee fixture 文件（S2 L1 等价：事件载荷里的路径必须指向存在的文件）。 */
function writeTeeFixture(name: string, content: string): string {
  const teePath = path.join(fixtureDir, name);
  fs.writeFileSync(teePath, content, "utf8");
  teeFixtures.push(teePath);
  return teePath;
}

function scanRunEvents(runId: string): Promise<readonly WorkflowRunEvent[]> {
  return createRunEventJournal(journalDir).scan(runId);
}

/** 构造真实 WorkflowRun（真实状态机 transition）。 */
function makeRealRun(runId: string): WorkflowRun {
  const run = new WorkflowRun(
    runId,
    {
      scriptName: "test-wf",
      scriptSource: "agent('hi')",
      args: {},
      scriptPath: "/tmp/test-wf.js",
    },
    {
      status: "running",
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

/** deps mock（形态对齐 worker-message-pump-run-events.test.ts）。 */
function makeDeps(): LifecycleDeps {
  return {
    store: { save: vi.fn(async () => {}) },
    workerHost: { start: vi.fn(() => ({ postMessage: vi.fn() })) },
    runner: { run: vi.fn(async () => ({}) as AgentResult) },
    runs: new Map(),
    appendEntry: vi.fn(),
    eventBus: { emit: vi.fn() },
    onRunDone: vi.fn(),
    log: vi.fn(),
  } as unknown as LifecycleDeps;
}

/** 构造已终局的 AgentCall（markRunning → markDone——对齐 executeAgentCall 的 finalize 形态）。 */
function makeSettledCall(callId: number, result: AgentResult): AgentCall {
  const opts: AgentCallOpts = { prompt: "p" };
  const node: ExecutionTraceNode = {
    stepIndex: callId,
    agent: "reviewer",
    task: "p",
    model: "test-model",
    status: "running",
    startedAt: new Date().toISOString(),
  };
  const call = new AgentCall(callId, opts, node);
  call.markRunning();
  call.markDone(result);
  return call;
}

/** 排空微任务队列（void fire 的 async 投递链推进到稳定态）。 */
async function flushMicrotasks(ticks = 20): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    // eslint-disable-next-line no-await-in-loop -- 排空微任务队列的固定 tick 循环，非逐项等待
    await Promise.resolve();
  }
}

// ── 1. 全链三段（引擎上报 → 事件载荷 → manifest） ────────────

describe("stderrTeePath 全链（引擎上报 → ask-settled 载荷 → 失败终局 manifest）", () => {
  it("失败 ask → 事件载荷含 stderrTeePath 且文件存在；终局 failed → manifest 投影同路径", async () => {
    const teePath = writeTeeFixture("pi-task-stderr-4242.log", "fake-pi stderr boot\n");
    const run = makeRealRun("wf-tee-1");
    const deps = makeDeps();
    await dispatchRunCreated(run);
    dispatchAskDispatched(run, 0, "reviewer");
    // 引擎上报段：call.result.stderrTeePath（真实产出链 = AgentOutcome.stderrTeePath
    // → outcomeToWorkflowResult → call.result，引擎段由 pi-subagent-cli 集成测试覆盖）
    const call = makeSettledCall(0, {
      content: "",
      error: "pi child exited with code 3",
      failureKind: "unknown",
      stderrTeePath: teePath,
      durationMs: 21_000,
      toolCalls: [],
    });
    dispatchAskSettled(run, call, false);
    await flushMicrotasks();

    // 事件载荷段：ask-settled(failed) 携带路径 + 文件真实存在（S2 L1 等价断言）
    const events = await scanRunEvents("wf-tee-1");
    const settled = events.find((e) => e.type === "ask-settled");
    expect(settled).toMatchObject({
      type: "ask-settled",
      taskIndex: 0,
      attempt: 1,
      outcome: "failed",
      stderrTeePath: teePath,
    });
    expect(fs.existsSync(teePath)).toBe(true);

    // manifest 段：失败终局投影同路径（事件流投影取值，非第二写点）
    const ok = await finalizeRun(run, deps, "failed", { context: "test" });
    expect(ok).toBe(true);
    const manifest = await readRunTerminalManifest(journalDir, "wf-tee-1");
    expect(manifest).toMatchObject({
      id: "wf-tee-1",
      outcome: "failed",
      stderrTeePath: teePath,
    });
    expect(fs.existsSync(teePath)).toBe(true);
  });

  it("成功 ask + 失败终局（脚本错误）：journal 无带路径帧 → manifest 不落 stderrTeePath", async () => {
    const run = makeRealRun("wf-tee-2");
    const deps = makeDeps();
    await dispatchRunCreated(run);
    dispatchAskDispatched(run, 0, "reviewer");
    const call = makeSettledCall(0, { content: "ok", durationMs: 5, toolCalls: [] });
    dispatchAskSettled(run, call, false);
    await flushMicrotasks();

    const ok = await finalizeRun(run, deps, "failed", { context: "script error" });
    expect(ok).toBe(true);
    const manifest = await readRunTerminalManifest(journalDir, "wf-tee-2");
    expect(manifest).toMatchObject({ outcome: "failed" });
    expect(manifest?.stderrTeePath).toBeUndefined();
  });

  it("失败 ask 后 cancelled 终局：manifest 不写 stderrTeePath（成功/cancel 不写纪律）", async () => {
    const teePath = writeTeeFixture("pi-task-stderr-1111.log", "boom\n");
    const run = makeRealRun("wf-tee-3");
    const deps = makeDeps();
    await dispatchRunCreated(run);
    dispatchAskDispatched(run, 0, "reviewer");
    const call = makeSettledCall(0, {
      content: "",
      error: "pi child exited with code 1",
      failureKind: "unknown",
      stderrTeePath: teePath,
      durationMs: 3_000,
      toolCalls: [],
    });
    dispatchAskSettled(run, call, false);
    await flushMicrotasks();

    const ok = await finalizeRun(run, deps, "aborted", { context: "abortRun" });
    expect(ok).toBe(true);
    const manifest = await readRunTerminalManifest(journalDir, "wf-tee-3");
    expect(manifest).toMatchObject({ outcome: "cancelled" });
    expect(manifest?.stderrTeePath).toBeUndefined();
  });
});

// ── 2. 旧 manifest 读兼容 ────────────────────────────────────

describe("RunTerminalManifest 旧形态读兼容", () => {
  it("无 stderrTeePath 字段的旧 manifest（无 errorCode 同批存量形态）读回 undefined 不炸", async () => {
    // 手写旧形态磁盘文件（绕过 writeRunTerminalManifest——模拟存量数据）
    const legacy = {
      id: "wf-tee-legacy",
      workflowName: "review-fix-loop",
      outcome: "failed",
      errorCode: "engine_crashed",
      settledAt: 1_758_000_000_000,
    };
    fs.writeFileSync(
      path.join(journalDir, "wf-tee-legacy.json"),
      JSON.stringify(legacy, null, 2),
      "utf8",
    );
    const manifest = await readRunTerminalManifest(journalDir, "wf-tee-legacy");
    expect(manifest).not.toBeNull();
    expect(manifest).toMatchObject({ id: "wf-tee-legacy", outcome: "failed", errorCode: "engine_crashed" });
    expect(manifest?.stderrTeePath).toBeUndefined();
  });
});
