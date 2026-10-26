// src/orchestration/__tests__/run-terminal-projection.test.ts
//
// [P1b-2] manifest-write 输出动作执行实装单测（D5-④ 终态派生视图）。
//
// 锁四面（P1 验收条款 a：终态写读经 dispatchRunTrigger 真实终局转移链驱动，
// 非直写构造）：
// 1. 终局转移链 → manifest（<runId>.json）落 outcome/errorCode，三形态写读一致
//   （成功=completed、失败=failed+errorCode、取消=cancelled——取消经
//    cancel-requested 控制事件合成路径）。
// 2. errorCode 载荷溯源：errorCode 只来自 run-settled 事件载荷（cancel 合成路径
//    无结构化码——manifest 不落 errorCode 键）。
// 3. 派生视图生成时机：终局转移前的中间态零派生视图（manifest 文件不存在），转移后恰一次。
// 4. 派生视图生成失败不阻断终局（journal 侧断言独立成立——coda 权威路径与取证路径分离）。
//
// [round5-g 合并产物] 吸收同被测链路（terminal-actions 终局派生视图）姊妹件：
// - stderr-tee-diagnostic-reference.test.ts（stderrTeePath 全链 + 旧 manifest 读兼容）。
//   两件原有文件级 journal hook 互斥（全局目录后写者胜），已统一为本文件顶层的
//   projectionDir hook；tee 的 fixtureDir/teeFixtures hook 下沉其各 describe。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  dispatchAgentSettled,
  dispatchAgentStarted,
  dispatchRunCreated,
  dispatchRunTrigger,
  finalizeRun,
  setRunEventJournalDirForTest,
} from "../terminal-actions.ts";
import { createRunEventJournal } from "../run-events.ts";
import type { WorkflowRunEvent } from "../run-events.ts";
import { flushMicrotasks } from "./helpers/flush-microtasks.ts";
import { readRunTerminalManifest } from "../../execution/persistence/manifest-store.ts";
import { AgentCall } from "../models/agent-call.ts";
import { WorkflowRun } from "../models/workflow-run.ts";
import { RunRuntime } from "../models/run-runtime.ts";
import { Budget } from "../models/budget.ts";
import { Trace } from "../models/trace.ts";
import type { AgentResult, ExecutionTraceNode } from "../models/types.ts";
import type { LifecycleDeps } from "../models/ports.ts";
import type { WorkerHandle } from "../worker-handle.ts";

let projectionDir: string;

beforeEach(() => {
  projectionDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-terminal-projection-"));
  // journal / manifest 同目录（resolveRunEventJournal 同源解析）——
  // setRunEventJournalDirForTest 一次注入覆盖两面。
  setRunEventJournalDirForTest(projectionDir);
});

afterEach(() => {
  setRunEventJournalDirForTest(undefined);
  fs.rmSync(projectionDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** 构造真实 WorkflowRun（spec/args 可控——created 引导补投的载荷源）。 */
function makeRun(runId: string): WorkflowRun {
  const run = new WorkflowRun(
    runId,
    {
      scriptName: "review-fix-loop",
      scriptSource: "agent('hi')",
      args: { pr: 42 },
      scriptPath: "/tmp/review-fix-loop.js",
      model: "test-model",
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
    postMessage: () => {},
    terminate: async () => {},
  } as unknown as WorkerHandle;
  run.assignRuntime(new RunRuntime(worker, new AbortController()));
  return run;
}

// ── 1. 终局转移链 → 双路径派生视图三形态（验收 a） ─────────────────

describe("终态写读三形态（验收 a：manifest 经真实转移链）", () => {
  it("成功 = completed：run-settled(completed) → manifest 落 outcome", async () => {
    const run = makeRun("wf-proj-ok");
    await dispatchRunCreated(run); // [Q2] 正点发射（P1b-1 created 引导已删除）
    await dispatchRunTrigger(run, {
      type: "run-settled",
      outcome: "done",
      artifactsDir: projectionDir,
      ts: Date.now(),
    });

    const manifest = await readRunTerminalManifest(projectionDir, run.runId);
    expect(manifest).toMatchObject({
      id: run.runId,
      workflowName: "review-fix-loop",
      outcome: "done",
    });
    expect(manifest).not.toHaveProperty("errorCode");
  });

  it("失败 = failed + errorCode：run-settled(failed, engine_crashed) → manifest 落 errorCode", async () => {
    const run = makeRun("wf-proj-fail");
    await dispatchRunCreated(run);
    await dispatchRunTrigger(run, {
      type: "run-settled",
      outcome: "failed",
      errorCode: "engine_crashed",
      reason: "worker died 3 times",
      artifactsDir: projectionDir,
      ts: Date.now(),
    });

    const manifest = await readRunTerminalManifest(projectionDir, run.runId);
    expect(manifest).toMatchObject({ outcome: "failed", errorCode: "engine_crashed" });
  });

  it("取消 = cancelled：cancel-requested 控制事件合成路径（无 errorCode 键）", async () => {
    const run = makeRun("wf-proj-cancel");
    await dispatchRunCreated(run);
    await dispatchRunTrigger(run, {
      type: "agent-started",
      taskIndex: 1,
      agentName: "a",
      attempt: 1,
      ts: Date.now(),
    });
    await dispatchRunTrigger(run, { type: "cancel-requested", reason: "user abort" });

    const manifest = await readRunTerminalManifest(projectionDir, run.runId);
    expect(manifest).toMatchObject({ id: run.runId, outcome: "cancelled" });
    expect(manifest).not.toHaveProperty("errorCode");
  });
});

// ── 2. errorCode 载荷溯源 ────────────────────────────────────

describe("errorCode 只溯源 run-settled 载荷", () => {
  it("completed 终局带 errorCode 载荷位但无值 → 派生视图不落 errorCode 键", async () => {
    const run = makeRun("wf-proj-ok-noerr");
    await dispatchRunCreated(run);
    await dispatchRunTrigger(run, {
      type: "run-settled",
      outcome: "done",
      artifactsDir: projectionDir,
      ts: Date.now(),
    });

    expect(await readRunTerminalManifest(projectionDir, run.runId)).not.toHaveProperty("errorCode");
  });
});

// ── 3. 派生视图生成时机（中间态零派生视图） ──────────────────────────────

describe("派生视图生成时机（终局前的中间态零派生视图）", () => {
  it("run-created / ask 链中间态不写 manifest；终局转移后恰一次", async () => {
    const run = makeRun("wf-proj-timing");
    await dispatchRunCreated(run);
    await dispatchRunTrigger(run, {
      type: "agent-started",
      taskIndex: 1,
      agentName: "a",
      attempt: 1,
      ts: Date.now(),
    });
    expect(fs.existsSync(path.join(projectionDir, `${run.runId}.json`))).toBe(false);

    await dispatchRunTrigger(run, {
      type: "run-settled",
      outcome: "done",
      artifactsDir: projectionDir,
      ts: Date.now(),
    });
    expect(await readRunTerminalManifest(projectionDir, run.runId)).not.toBeNull();

    // terminal 后再投递 = IllegalTransitionError 让位，派生视图不被重写（状态不变量）
    await expect(
      dispatchRunTrigger(run, {
        type: "agent-settled",
        taskIndex: 1,
        attempt: 1,
        outcome: "failed",
        durationMs: 1,
        ts: Date.now(),
      }),
    ).rejects.toThrow(/terminal/);
    expect(await readRunTerminalManifest(projectionDir, run.runId)).toMatchObject({
      outcome: "done",
    });
  });
});

// ── 4. journal 与派生视图独立（取证路径与派生视图分离） ──────────────

describe("派生视图与 journal 共存（同目录不同文件）", () => {
  it("终局后 journal 含 run-settled 帧 + manifest 落派生视图（互不干扰）", async () => {
    const run = makeRun("wf-proj-coexist");
    await dispatchRunCreated(run);
    await dispatchRunTrigger(run, {
      type: "run-settled",
      outcome: "failed",
      errorCode: "engine_crashed",
      artifactsDir: projectionDir,
      ts: Date.now(),
    });

    const events = await createRunEventJournal(projectionDir).scan(run.runId);
    expect(events.map((e) => e.type)).toEqual(["run-created", "run-settled"]);
    expect(await readRunTerminalManifest(projectionDir, run.runId)).toMatchObject({
      outcome: "failed",
    });
    // 目录派生视图文件齐备：journal / manifest
    const names = fs.readdirSync(projectionDir).sort();
    expect(names).toContain(`${run.runId}.record.jsonl`);
    expect(names).toContain(`${run.runId}.json`);
  });
});

// ── 5. 生产链（finalizeRun → dispatchFinalRunSettle 构造 errorCode → 派生视图） ──

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

/** 构造已终局的 AgentCall（markRunning → markDone，对齐 executeAgentCall finalize 形态）。 */
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

describe("生产链 errorCode 派生视图（finalizeRun 构造 → manifest，S2 死亡可诊断）", () => {
  it("engine_crashed 终局 → manifest{outcome:failed, errorCode:engine_crashed}（journal 终帧同源）", async () => {
    const run = makeRun("wf-prod-ec");
    await dispatchRunCreated(run);
    run.state.calls.set(0, makeSettledCall(0, {
      content: "",
      error: "engine_crashed: engine process exited unexpectedly: signal SIGKILL. stderr tail: fake",
      durationMs: 21_000,
      toolCalls: [],
    }));
    run.state.error =
      "Workflow failed after 3 retries: ask-1 failed after retries: engine_crashed: engine process exited unexpectedly: signal SIGKILL";
    const deps = makeDeps();

    const ok = await finalizeRun(run, deps, "failed", { context: "test" });
    expect(ok).toBe(true);

    const manifest = await readRunTerminalManifest(projectionDir, run.runId);
    expect(manifest).toMatchObject({ id: run.runId, outcome: "failed", errorCode: "engine_crashed" });
    // journal 终局帧与 manifest 同源（同一 run-settled 载荷）
    const events = await createRunEventJournal(projectionDir).scan(run.runId);
    expect(events.at(-1)).toMatchObject({ type: "run-settled", outcome: "failed", errorCode: "engine_crashed" });
  });

  it("budget_limited → manifest{failed, budget_limited}；time_limited → manifest{time_limited, 无码}（[D2] 升格）", async () => {
    const budgetRun = makeRun("wf-prod-budget_limited");
    await dispatchRunCreated(budgetRun);
    await finalizeRun(budgetRun, makeDeps(), "budget_limited", { context: "test" });
    expect(await readRunTerminalManifest(projectionDir, budgetRun.runId)).toMatchObject({
      outcome: "failed",
      errorCode: "budget_limited",
    });

    const timeRun = makeRun("wf-prod-time_limited");
    await dispatchRunCreated(timeRun);
    await finalizeRun(timeRun, makeDeps(), "time_limited", { context: "test" });
    const timeManifest = await readRunTerminalManifest(projectionDir, timeRun.runId);
    expect(timeManifest).toMatchObject({ outcome: "time_limited" });
    expect(timeManifest?.errorCode).toBeUndefined();
  });

  it("time_limited 终局携带 stderrTeePath（[D2] 词表变更登记第 3 条「证据采集沿用 failed 同款」——record 有带路径失败帧时，「脚本慢」与「引擎卡死超时」在 manifest 面可区分）", async () => {
    const run = makeRun("wf-prod-time-tee");
    await dispatchRunCreated(run);
    // 超时前有失败 call 落盘（引擎卡死超时的典型形态：最后一帧带取证指针）
    const failed = makeSettledCall(0, {
      content: "",
      error: "engine_crashed: engine process exited unexpectedly",
      durationMs: 21_000,
      toolCalls: [],
      stderrTeePath: "/tee-fixtures/wf-prod-time-tee/call-0.stderr.log",
    });
    run.state.calls.set(0, failed);
    dispatchAgentSettled(run, failed, false);

    await finalizeRun(run, makeDeps(), "time_limited", { context: "test" });

    const manifest = await readRunTerminalManifest(projectionDir, run.runId);
    expect(manifest).toMatchObject({
      outcome: "time_limited",
      stderrTeePath: "/tee-fixtures/wf-prod-time-tee/call-0.stderr.log",
    });
    // 对照：成功/cancelled 终局维持不写（失败伴随纪律不受本条影响）
    const okRun = makeRun("wf-prod-done-tee");
    await dispatchRunCreated(okRun);
    const okCall = makeSettledCall(0, { content: "ok", durationMs: 1, toolCalls: [] });
    okRun.state.calls.set(0, okCall);
    dispatchAgentSettled(okRun, okCall, false);
    await finalizeRun(okRun, makeDeps(), "completed", { context: "test" });
    expect(await readRunTerminalManifest(projectionDir, okRun.runId)).not.toHaveProperty("stderrTeePath");
  });
});

// ══════ 来源: stderr-tee-diagnostic-reference.test.ts ══════

// src/orchestration/__tests__/stderr-tee-diagnostic-reference.test.ts
//
// [D5 诊断引用写入 journal 记录] stderrTeePath 生产链测试（2026-09-22 一致性审查 P1 修复）。
//
// 锁四面（S2「stderr tee 文件路径在事件载荷中且文件存在」的 L1 等价用例）：
// 1. 全链三段：引擎上报（call.result.stderrTeePath 注入——真实引擎段由
//    pi-subagent-cli run-spawn-once.integration 覆盖）→ dispatchAgentSettled 事件
//    载荷含路径 → 失败终局 manifest 含路径（事件流派生视图取值）。
// 2. 失败伴随纪律：成功 ask / cancelled 终局不带 stderrTeePath（成功/cancel 不写）。
// 3. 旧 manifest 读兼容：无 stderrTeePath 字段的存量形态读回 undefined 不炸。
// 4. journal 目录测试注入（setRunEventJournalDirForTest + mkdtemp 自建自删）；
//    tee fixture 落真实临时文件并断言存在性（S2 L1 等价——不 mock 文件存在性）。




// ── helpers ──────────────────────────────────────────────────

let fixtureDir: string;
/** 各用例自建的 tee fixture（真实文件——存在性断言的目标），afterEach 统一清理。 */
const teeFixtures: string[] = [];

/** 落一个真实 tee fixture 文件（S2 L1 等价：事件载荷里的路径必须指向存在的文件）。 */
function writeTeeFixture(name: string, content: string): string {
  const teePath = path.join(fixtureDir, name);
  fs.writeFileSync(teePath, content, "utf8");
  teeFixtures.push(teePath);
  return teePath;
}

function scanRunEvents(runId: string): Promise<readonly WorkflowRunEvent[]> {
  return createRunEventJournal(projectionDir).scan(runId);
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

// ── 1. 全链三段（引擎上报 → 事件载荷 → manifest） ────────────

describe("stderrTeePath 全链（引擎上报 → agent-settled 载荷 → 失败终局 manifest）", () => {

  beforeEach(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "stderr-tee-fixture-"));
  });

  afterEach(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    teeFixtures.length = 0;
  });
  it("失败 ask → 事件载荷含 stderrTeePath 且文件存在；终局 failed → manifest 派生视图同路径", async () => {
    const teePath = writeTeeFixture("pi-task-stderr-4242.log", "fake-pi stderr boot\n");
    const run = makeRealRun("wf-tee-1");
    const deps = makeDeps();
    await dispatchRunCreated(run);
    dispatchAgentStarted(run, 0, "reviewer");
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
    dispatchAgentSettled(run, call, false);
    await flushMicrotasks(20);

    // 事件载荷段：agent-settled(failed) 携带路径 + 文件真实存在（S2 L1 等价断言）
    const events = await scanRunEvents("wf-tee-1");
    const settled = events.find((e) => e.type === "agent-settled");
    expect(settled).toMatchObject({
      type: "agent-settled",
      taskIndex: 0,
      attempt: 1,
      outcome: "failed",
      stderrTeePath: teePath,
    });
    expect(fs.existsSync(teePath)).toBe(true);

    // manifest 段：失败终局派生视图同路径（事件流派生视图取值，非第二写点）
    const ok = await finalizeRun(run, deps, "failed", { context: "test" });
    expect(ok).toBe(true);
    const manifest = await readRunTerminalManifest(projectionDir, "wf-tee-1");
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
    dispatchAgentStarted(run, 0, "reviewer");
    const call = makeSettledCall(0, { content: "ok", durationMs: 5, toolCalls: [] });
    dispatchAgentSettled(run, call, false);
    await flushMicrotasks(20);

    const ok = await finalizeRun(run, deps, "failed", { context: "script error" });
    expect(ok).toBe(true);
    const manifest = await readRunTerminalManifest(projectionDir, "wf-tee-2");
    expect(manifest).toMatchObject({ outcome: "failed" });
    expect(manifest?.stderrTeePath).toBeUndefined();
  });

  it("失败 ask 后 cancelled 终局：manifest 不写 stderrTeePath（成功/cancel 不写纪律）", async () => {
    const teePath = writeTeeFixture("pi-task-stderr-1111.log", "boom\n");
    const run = makeRealRun("wf-tee-3");
    const deps = makeDeps();
    await dispatchRunCreated(run);
    dispatchAgentStarted(run, 0, "reviewer");
    const call = makeSettledCall(0, {
      content: "",
      error: "pi child exited with code 1",
      failureKind: "unknown",
      stderrTeePath: teePath,
      durationMs: 3_000,
      toolCalls: [],
    });
    dispatchAgentSettled(run, call, false);
    await flushMicrotasks(20);

    const ok = await finalizeRun(run, deps, "aborted", { context: "abortRun" });
    expect(ok).toBe(true);
    const manifest = await readRunTerminalManifest(projectionDir, "wf-tee-3");
    expect(manifest).toMatchObject({ outcome: "cancelled" });
    expect(manifest?.stderrTeePath).toBeUndefined();
  });
});

// ── 2. 旧 manifest 读兼容 ────────────────────────────────────

describe("RunTerminalManifest 旧形态读兼容", () => {

  beforeEach(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "stderr-tee-fixture-"));
  });

  afterEach(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    teeFixtures.length = 0;
  });
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
      path.join(projectionDir, "wf-tee-legacy.json"),
      JSON.stringify(legacy, null, 2),
      "utf8",
    );
    const manifest = await readRunTerminalManifest(projectionDir, "wf-tee-legacy");
    expect(manifest).not.toBeNull();
    expect(manifest).toMatchObject({ id: "wf-tee-legacy", outcome: "failed", errorCode: "engine_crashed" });
    expect(manifest?.stderrTeePath).toBeUndefined();
  });
});
