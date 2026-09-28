// src/__tests__/jsonl-run-store-loadall.test.ts
//
// loadAll 读面汇总件（三源合一：原 corrupt-entry / finality-reconciliation /
// loadall-sources 三件——被测对象同属 loadAll 读路径，夹具逐字重复故归并）。
//
// 覆盖三块：
// 1. [SO-DATA-2] collectRecordRun 的 per-entry 隔离：1 条残缺 workflow-record entry
//    不得让整个 loadAll 返回空（fromRunSnapshot 读残缺 snapshot.state 抛 TypeError
//    会沿 collectEntrySources 穿透 loadAll 的 catch → 返回空——单条损坏让全部 run
//    不可见；修复 = collectRecordRun 单条 try/catch，损坏 entry 跳过 + logger.warn
//    留证（含 entry 索引与原因），其余 entry 正常重建）。
// 2. loadAll 终局调和（reconcileRunningFinality——[W1 / D4/D7] v1 兼容层）：两个
//    已证实的误判面——① journal run-settled 终局先于终态 entry 落账（pump 落账
//    顺序 + 终态 entry best-effort 不重试）→ 实际 completed 的 run 崩溃恢复后被
//    误标 failed；② state 与 entry 双轨——core 侧终局化只写 state 文件不改
//    entry（历史 idle 回收机制即此形态，已退役见 ADR-0081）→ resume 后恢复链从
//    entry 读到 running 再次转 failed，覆盖 state 终局。
//    [W1] 分流锚定：本调和只服务 v1 快照 entry 定界的实体；v2 实体的终局核对 =
//    journal 投影本身（rebuildRunsFromJournals，见 session-file 件 v2 用例）。
// 3. loadAll entry 源扫描（collectEntrySources + loadRunFromStateFile，R2-TC S4）：
//    多 run 并存重建无丢失 / 损坏 state 文件降级（单文件失败返回 null 跳过，不崩
//    loadAll、不阻断同批其余 run 重建）/ 同 runId 多条 record entry 末条胜出不串扰。
//
// 夹具纪律：v1 快照 entry 已停写（壳 save 不再产出），一律经「真实 toRunSnapshot
// codec + 存量 v1 信封」夹具产出（夹具是兼容读面的唯一产出方式）；1 条坏 entry
// 手工构造（模拟损坏正是用例的目的——绕开 schema 契约即 corruption 的本质）；
// journal 帧按 isWorkflowRunEventLine 的最小形状手写；state 文件的旁路终局（GC
// 通道）经「无 pi 的第二个 store save 同一 run」模拟；link 通路走真实 save 产
// state 文件（写点保留——state 是物化投影）。不 mock collectEntrySources：走
// loadAll 真实通路（ctx.sessionManager.getEntries 返回 seed entries，
// loadRunFromStateFile 读真实临时文件）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("@zhushanwen/subagent-core/core/logger.ts", () => ({ getLogger: () => loggerMock }));

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { CustomEntry } from "@earendil-works/pi-coding-agent";

import { Budget } from "@zhushanwen/subagent-core";
import { Trace } from "@zhushanwen/subagent-core";
import type { RunSpec } from "@zhushanwen/subagent-core";
import type { ExecutionTraceNode } from "@zhushanwen/subagent-core";
import { WorkflowRun } from "@zhushanwen/subagent-core";
// SNAPSHOT_VERSION 随 c721646f1 codec 迁 core 后壳模块不再 re-export，改从 barrel 消费
import { SNAPSHOT_VERSION, toRunSnapshot } from "@zhushanwen/subagent-core";
import { WORKFLOW_RECORD_CUSTOM_TYPE } from "@zhushanwen/subagent-core";
import { JsonlRunStore } from "../jsonl-run-store.ts";
import { mkCtx } from "@zhushanwen/subagent-core/testing/orchestration/__tests__/test-mocks.ts";

// ── 共享夹具（三源去重为一份）─────────────────────────────────────────────────

function makeSpec(): RunSpec {
  return {
    scriptSource: "module.exports = async () => {};",
    args: {},
    scriptName: "test-script",
    scriptPath: "/tmp/test.js",
    description: "test",
  };
}

function makeTraceNode(stepIndex: number): ExecutionTraceNode {
  return { stepIndex, agent: "worker", task: "do thing", model: "default", status: "pending" };
}

function makeRunningRun(runId: string): WorkflowRun {
  const trace = new Trace();
  trace.append(makeTraceNode(0));
  return WorkflowRun.reconstruct(runId, makeSpec(), {
    status: "running",
    budget: new Budget(),
    calls: new Map(),
    trace,
    errorLogs: [],
  }, { startedAt: new Date().toISOString() });
}

/** running → done 的聚合（快照形态可信：经真实 toRunSnapshot codec 产出）。 */
function makeDoneRun(runId: string): WorkflowRun {
  const run = makeRunningRun(runId);
  run.transition("done", "completed");
  return run;
}

/**
 * [W1 / D7] 手工构造 v1 快照 entry（兼容层夹具）：snapshot 经真实 codec，信封按
 * 存量 v1 形态拼装（W1 起壳侧停写该形态——夹具是兼容读面的唯一产出方式）。
 */
function v1RecordEntry(run: WorkflowRun): CustomEntry {
  return {
    type: "custom",
    customType: WORKFLOW_RECORD_CUSTOM_TYPE,
    data: {
      v: 1,
      snapshot: toRunSnapshot(run),
      updatedAt: new Date().toISOString(),
    },
    id: `seed-v1-${run.runId}-${Math.random().toString(36).slice(2, 8)}`,
    parentId: null,
    timestamp: new Date().toISOString(),
  };
}

/** 手工构造残缺 record entry：v1 guard 通过，但 snapshot.state 缺全部必读嵌套字段
 *  → fromRunSnapshot 读 snapshot.state.budget.maxTokens 抛 TypeError。 */
function corruptRecordEntry(runId: string): CustomEntry {
  return {
    type: "custom",
    customType: WORKFLOW_RECORD_CUSTOM_TYPE,
    data: {
      v: 1,
      snapshot: { v: SNAPSHOT_VERSION, runId, state: {} },
      updatedAt: new Date().toISOString(),
    },
    id: `seed-corrupt-${runId}`,
    parentId: null,
    timestamp: new Date().toISOString(),
  };
}

/** 手工构造旧 workflow-state-link 指针 entry（loadAll 的 link 兼容输入）。 */
function linkEntry(runId: string, statePath: string): CustomEntry {
  return {
    type: "custom",
    customType: "workflow-state-link",
    data: { runId, path: statePath },
    id: `seed-link-${runId}`,
    parentId: null,
    timestamp: new Date().toISOString(),
  };
}

/** journal run-settled 帧（isWorkflowRunEventLine 最小形状：type/ts/outcome 落词表）。
 *  outcome 放行 RunOutcome 四值——interrupted 用例锁定壳侧 runSettledOutcomeToDoneReason
 *  的 interrupted→"failed" 反向行（与 core run-registry.test.ts 收编条目 reason 断言
 *  同规格——双侧镜像实现的防漂移锚）。 */
function settledLine(
  outcome: "completed" | "failed" | "cancelled" | "interrupted",
  extra?: Record<string, unknown>,
): string {
  return JSON.stringify({ type: "run-settled", ts: Date.now(), outcome, artifactsDir: "/tmp/wf", ...extra });
}

// ── 1. per-entry 隔离（[SO-DATA-2]）───────────────────────────────────────────

describe("SO-DATA-2: 残缺 record entry 的 per-entry 隔离", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-corrupt-entry-"));
    loggerMock.warn.mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("3 条 entry（2 好 1 坏）→ 返回 2 条 + warn 留证（含 entry 索引与原因）", async () => {
    const goodA = v1RecordEntry(makeDoneRun("run-a"));
    const goodB = v1RecordEntry(makeDoneRun("run-b"));
    const corrupt = corruptRecordEntry("run-corrupt");
    const seedEntries: CustomEntry[] = [goodA, goodB, corrupt];

    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(seedEntries) });
    const loaded = await store.loadAll();

    // 损坏 entry 只跳过自身，其余 run 全部可见
    expect(loaded.map((r) => r.runId).sort()).toEqual(["run-a", "run-b"]);
    // warn 留证：entry 索引 + 损坏原因
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    const warnMsg = String(loggerMock.warn.mock.calls[0]?.[0] ?? "");
    expect(warnMsg).toContain(`entry #${seedEntries.indexOf(corrupt)}`);
    expect(warnMsg).toContain("corrupted");
  });

  it("全部 entry 均损坏 → 返回空（不再抛 TypeError 穿透）+ 每条各留一条 warn", async () => {
    const seedEntries: CustomEntry[] = [
      corruptRecordEntry("run-corrupt-1"),
      corruptRecordEntry("run-corrupt-2"),
    ];
    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(seedEntries) });
    const loaded = await store.loadAll();
    expect(loaded).toEqual([]);
    expect(loggerMock.warn).toHaveBeenCalledTimes(2);
  });

  it("损坏 entry 位于同 runId 好 entry 之前 → 后写覆盖语义不受影响（好快照胜出）", async () => {
    const corrupt = corruptRecordEntry("run-x");
    const good = v1RecordEntry(makeDoneRun("run-x"));
    const seedEntries: CustomEntry[] = [corrupt, good];

    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(seedEntries) });
    const loaded = await store.loadAll();
    expect(loaded.map((r) => r.runId)).toEqual(["run-x"]);
    expect(loaded[0]?.state.status).toBe("done");
  });
});

// ── 2. 终局调和（v1 兼容层）───────────────────────────────────────────────────

describe("loadAll 终局调和（v1 兼容层）：journal settled 帧 / state 文件旁路终局", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-finality-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("A1 completed：entry 仍 running 但 journal 已有 run-settled(completed) → 采纳 completed，不被恢复链误标 failed", async () => {
    // entry 通路：v1 夹具 running entry（W1 起壳 save 不产 entry——夹具喂入）
    const run = makeRunningRun("run-recon-a");
    const entries: CustomEntry[] = [v1RecordEntry(run)];

    // journal 通路：终局帧已落账、终态 entry 未写（pump 落账顺序窗口 / 终态 entry 写失败）
    const journalPath = path.join(tmpDir, "workflow-state", "run-recon-a.events.jsonl");
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.writeFileSync(journalPath, `${settledLine("completed")}\n`, "utf8");

    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    const loaded = await store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.state.status).toBe("done");
    expect(loaded[0]!.state.reason).toBe("completed");
    expect(loaded[0]!.state.error).toBeUndefined(); // 成功终局无 error
  });

  it("A1 failed：journal run-settled(failed, errorCode) → 采纳 failed 且 reason/error 保真（不落 generic kill-9 文案）", async () => {
    const run = makeRunningRun("run-recon-b");
    const entries: CustomEntry[] = [v1RecordEntry(run)];

    const journalPath = path.join(tmpDir, "workflow-state", "run-recon-b.events.jsonl");
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.writeFileSync(
      journalPath,
      `${settledLine("failed", { errorCode: "engine_crashed", reason: "worker exited code 1" })}\n`,
      "utf8",
    );

    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    const loaded = await store.loadAll();
    expect(loaded[0]!.state.status).toBe("done");
    expect(loaded[0]!.state.reason).toBe("failed");
    expect(loaded[0]!.state.error).toBe("worker exited code 1");
  });

  it("A1 cancelled：journal run-settled(cancelled) → DoneReason 归位 aborted", async () => {
    const run = makeRunningRun("run-recon-c");
    const entries: CustomEntry[] = [v1RecordEntry(run)];

    const journalPath = path.join(tmpDir, "workflow-state", "run-recon-c.events.jsonl");
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.writeFileSync(journalPath, `${settledLine("cancelled")}\n`, "utf8");

    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    const loaded = await store.loadAll();
    expect(loaded[0]!.state.status).toBe("done");
    expect(loaded[0]!.state.reason).toBe("aborted");
  });

  it("A1 interrupted：journal run-settled(interrupted) → 诊断面折叠 reason='failed'（[W2 D5] 反向行壳侧锚——显示语义走 outcome 四值，reason 是唯一折叠位）", async () => {
    const run = makeRunningRun("run-recon-g");
    const entries: CustomEntry[] = [v1RecordEntry(run)];

    const journalPath = path.join(tmpDir, "workflow-state", "run-recon-g.events.jsonl");
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.writeFileSync(
      journalPath,
      `${settledLine("interrupted", { errorCode: "interrupted_abandoned", reason: "abandon window elapsed" })}\n`,
      "utf8",
    );

    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    const loaded = await store.loadAll();
    expect(loaded[0]!.state.status).toBe("done");
    // interrupted → "failed" 诊断兜底（DoneReason 无 interrupted 成员，W4 随兼容层 sunset）
    expect(loaded[0]!.state.reason).toBe("failed");
    // 帧 reason 文本保真（不落 generic 文案）——细分语境由帧 errorCode 承载
    expect(loaded[0]!.state.error).toBe("abandon window elapsed");
  });

  it("A2 GC 旁路：journal 无 settled + state 文件被旁路终局化（done,time_limited）→ 采纳 state 终局", async () => {
    // entry 通路：v1 夹具 running entry；随后旁路 store（无 pi——FileRunStore 等价
    // 形态）把同一 run 终局化后写 state 文件：entry 保持 running、state 是 done,time_limited
    const run = makeRunningRun("run-recon-d");
    const entries: CustomEntry[] = [v1RecordEntry(run)];
    run.transition("done", "time_limited");
    run.state.error = "idle GC: run exceeded retention window";
    const sidecar = new JsonlRunStore({ sessionDir: tmpDir });
    await sidecar.save(run);

    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    const loaded = await store.loadAll();
    expect(loaded[0]!.state.status).toBe("done");
    expect(loaded[0]!.state.reason).toBe("time_limited");
    expect(loaded[0]!.state.error).toBe("idle GC: run exceeded retention window");
  });

  it("无终局证据（journal 缺 / state 同为 running）→ 保持 running 交恢复链收编（调和不越权）", async () => {
    const run = makeRunningRun("run-recon-e");
    const entries: CustomEntry[] = [v1RecordEntry(run)];
    // 写 running state 文件（save 通路）但不写 journal——entry 与 state 都是 running
    const sidecar = new JsonlRunStore({ sessionDir: tmpDir });
    await sidecar.save(run);

    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    const loaded = await store.loadAll();
    expect(loaded[0]!.state.status).toBe("running");
  });

  it("journal 有非终局帧（ask-settled）不触发调和——只认 run-settled", async () => {
    const run = makeRunningRun("run-recon-f");
    const entries: CustomEntry[] = [v1RecordEntry(run)];

    const journalPath = path.join(tmpDir, "workflow-state", "run-recon-f.events.jsonl");
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.writeFileSync(
      journalPath,
      `${JSON.stringify({ type: "ask-settled", ts: Date.now(), outcome: "completed" })}\n`,
      "utf8",
    );

    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    const loaded = await store.loadAll();
    expect(loaded[0]!.state.status).toBe("running");
  });
});

// ── 3. entry 源扫描与损坏 state 降级（R2-TC S4）───────────────────────────────

describe("loadAll entry 源扫描：多 run 重建与损坏 state 降级（R2-TC S4）", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-loadall-src-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("多 run 并存：2 个 entry run + 1 个 link run 同批全部重建（无丢失）", async () => {
    // run-a/run-b：v1 兼容夹具 entry（快照经真实 codec）
    const entries: CustomEntry[] = [
      v1RecordEntry(makeDoneRun("run-a")),
      v1RecordEntry(makeDoneRun("run-b")),
    ];

    // run-c：旧 link 形态（state 文件完好，无 record entry）
    const storeC = new JsonlRunStore({ sessionDir: tmpDir });
    const runC = makeRunningRun("run-c");
    await storeC.save(runC);
    runC.transition("done", "completed");
    await storeC.save(runC);
    const linkPath = path.join(tmpDir, "workflow-state", "run-c.jsonl");
    expect(fs.existsSync(linkPath)).toBe(true);
    const seedEntries: CustomEntry[] = [...entries, linkEntry("run-c", linkPath)];

    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(seedEntries) });
    const loaded = await store.loadAll();
    expect(loaded.map((r) => r.runId).sort()).toEqual(["run-a", "run-b", "run-c"]);
  });

  it("损坏 state 文件（末行非 JSON）→ 该 run 跳过不崩，同批其余 run（entry run）正常返回", async () => {
    const entries: CustomEntry[] = [v1RecordEntry(makeDoneRun("run-good"))];

    const corruptPath = path.join(tmpDir, "workflow-state", "run-corrupt.jsonl");
    fs.mkdirSync(path.dirname(corruptPath), { recursive: true });
    fs.writeFileSync(corruptPath, "{truncated-not-json\n", "utf8");

    const seedEntries: CustomEntry[] = [...entries, linkEntry("run-corrupt", corruptPath)];
    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(seedEntries) });
    const loaded = await store.loadAll();
    expect(loaded.map((r) => r.runId)).toEqual(["run-good"]);
  });

  it("损坏形态族：空文件 / link 指向不存在路径 / link data 缺 runId → 均降级跳过，loadAll 不抛", async () => {
    const emptyPath = path.join(tmpDir, "workflow-state", "run-empty.jsonl");
    fs.mkdirSync(path.dirname(emptyPath), { recursive: true });
    fs.writeFileSync(emptyPath, "", "utf8");
    const missingPath = path.join(tmpDir, "workflow-state", "run-missing.jsonl");

    const malformedLink = linkEntry("run-bad", emptyPath);
    (malformedLink.data as Record<string, unknown>).runId = undefined; // 缺 runId 的坏指针

    // 对照组：一条合法 record entry run 应正常重建（v1 兼容夹具）
    const entries: CustomEntry[] = [v1RecordEntry(makeDoneRun("run-seeded"))];

    const seedEntries: CustomEntry[] = [
      ...entries,
      linkEntry("run-empty", emptyPath),
      linkEntry("run-missing", missingPath),
      malformedLink,
    ];
    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(seedEntries) });
    const loaded = await store.loadAll();
    expect(loaded.map((r) => r.runId)).toEqual(["run-seeded"]);
  });

  it("同 runId 多条 record entry 末条胜出（running→done 收敛）+ 另一 run 不受影响（混合批不串扰）", async () => {
    // run-x：两条 entry（running 中间态 + done 终态），末条胜出（v1 兼容夹具）
    const entries: CustomEntry[] = [
      v1RecordEntry(makeRunningRun("run-x")),
      v1RecordEntry(makeDoneRun("run-x")),
    ];
    // run-y：done 终态
    entries.push(v1RecordEntry(makeDoneRun("run-y")));

    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    const loaded = await store.loadAll();
    const byId = new Map(loaded.map((r) => [r.runId, r]));
    expect(loaded).toHaveLength(2);
    expect(byId.get("run-x")?.state.status).toBe("done");
    expect(byId.get("run-y")?.state.status).toBe("done");
  });
});
