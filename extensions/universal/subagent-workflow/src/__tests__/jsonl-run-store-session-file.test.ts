// src/__tests__/jsonl-run-store-session-file.test.ts
//
// JsonlRunStore 壳侧归属面汇总件（[D1] record 单源形态）：record 流折叠重建的
// round-trip 保真（sessionFile / result 全文经 agent-settled 载荷恢复）、record 流
// 路径指针（stateFilePath）、workflow-record 条目面（零条目写锚定 + v2 收编读面 +
// rebind 补写 + stale guard）、历史实体分流（旧后缀锚点不重建）。
//
// [D1] 退役面（旧形态用例随机制删除，语义锚迁移记录）：
// - state 快照物化触发源/串行链/批合并（W4-W8）→ 无物化面，写面纪律锚在
//   jsonl-run-store-event-edge.test.ts；
// - save 兜底容错（W3 mkdir ENOENT/EACCES）→ save 恒 no-op 零 IO，锚同上；
// - 快照版本守卫（W9）/ codec golden 字节锚（⛔5）→ 无快照字节面（codec 已删，
//   快照格式版本常量单源 = core SNAPSHOT_VERSION，读侧版本守卫锚在 runtime
//   workflow-extractor）；
// - adoption 投影重发保序（D4 resendSnapshots）→ 无投影可重发，接管动作收敛为
//   rebind（session-lifecycle.ts）；
// - 坏行宽容收编 → [D1] 反转为读失败拒绝（场景 18），见本件与 record-mode 族。
//
// 起源防的 bug（沿用）：sessionFile 加入 AgentCall + ExecutionTraceNode 后，持久化
// 时必须写入、重建时必须恢复——否则跨 session 重水合后 agent 的 session jsonl
// 路径丢失，overlay 无法定位。[D1] 形态下持久化面 = record 流 agent-settled 帧
// result 载荷（sessionFile 随 result 全文落流）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// logger mock（文件级）：jsonl-run-store.ts 模块级 getLogger 拿到此 mock，
// 坏行拒绝 / 历史分流 / stale guard 的留痕断言消费。
const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@zhushanwen/subagent-core/core/logger.ts", () => ({
  getLogger: () => loggerMock,
}));

import type { CustomEntry } from "@earendil-works/pi-coding-agent";

import { Budget } from "@zhushanwen/subagent-core";
import { Trace } from "@zhushanwen/subagent-core";
import { WorkflowRun } from "@zhushanwen/subagent-core";
import { runSummary } from "@zhushanwen/subagent-core";
import {
  RUN_EVENT_JOURNAL_SUFFIX,
  WORKFLOW_RECORD_CUSTOM_TYPE,
  WORKFLOW_RECORD_ENTRY_VERSION,
} from "@zhushanwen/subagent-core";
import { JsonlRunStore } from "../jsonl-run-store.ts";
import { mkCtx, mkPi } from "@zhushanwen/subagent-core/testing/orchestration/__tests__/test-mocks.ts";

/** 向 stateDir 的 record 流追加一帧（raw JSONL——模拟 core 写者落账）。 */
function appendRecordLine(tmpDir: string, runId: string, line: Record<string, unknown>): string {
  const recordPath = path.join(tmpDir, "workflow-state", `${runId}${RUN_EVENT_JOURNAL_SUFFIX}`);
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.appendFileSync(recordPath, `${JSON.stringify(line)}\n`, "utf8");
  return recordPath;
}

/** [D1] 手工 v2 注册条目夹具（字段集 = core lifecycle 写点同构）。 */
function v2RegisteredEntry(runId: string, journalPath: string): CustomEntry {
  return {
    type: "custom",
    customType: WORKFLOW_RECORD_CUSTOM_TYPE,
    data: {
      v: WORKFLOW_RECORD_ENTRY_VERSION,
      kind: "registered",
      runId,
      workflowName: "test-script",
      scriptName: "test-script",
      slug: "test-script",
      startedAt: Date.now(),
      journalPath,
    },
    id: `seed-v2-reg-${runId}`,
    parentId: null,
    timestamp: new Date().toISOString(),
  };
}

/** [W1 / D1] 手工 v2 终态条目夹具（kind: settled）。 */
function v2SettledEntry(runId: string): CustomEntry {
  return {
    type: "custom",
    customType: WORKFLOW_RECORD_CUSTOM_TYPE,
    data: {
      v: WORKFLOW_RECORD_ENTRY_VERSION,
      kind: "settled",
      runId,
      status: "done",
      reason: "completed",
      outcome: "done",
      settledAt: Date.now(),
      callCount: 1,
      usedTokens: 0,
    },
    id: `seed-v2-settled-${runId}`,
    parentId: null,
    timestamp: new Date().toISOString(),
  };
}

/** record 流三帧夹具：created + settled call（带 result 全文/sessionFile）+ run-settled。 */
function seedSettledRunWithCall(
  tmpDir: string,
  runId: string,
  result: Record<string, unknown>,
): string {
  appendRecordLine(tmpDir, runId, { type: "run-created", seq: 1, ts: 1000, runId, workflowName: "test-script", argsSummary: "{}", scriptSource: "agent('x')" });
  appendRecordLine(tmpDir, runId, { type: "agent-started", seq: 2, ts: 1100, taskIndex: 0, agentName: "worker", attempt: 1 });
  appendRecordLine(tmpDir, runId, { type: "agent-settled", seq: 3, ts: 1200, taskIndex: 0, attempt: 1, outcome: "done", durationMs: 100, result });
  return appendRecordLine(tmpDir, runId, { type: "run-settled", seq: 4, ts: 1300, outcome: "done", artifactsDir: tmpDir });
}

// ── record 重建 round-trip（sessionFile / result 全文保真）────────────

describe("W1[D1]: record 重建 round-trip（call 级详情经 agent-settled result 恢复）", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-store-test-"));
    loggerMock.warn.mockClear();
    loggerMock.debug.mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("loadAll round-trip: spec.budgetTimeMs 经 run-created 帧恢复（core rebuildRunFromRecord 同款条件式）", async () => {
    const runId = "run-rt-budget";
    const recordPath = appendRecordLine(tmpDir, runId, {
      type: "run-created",
      seq: 1,
      ts: 1000,
      runId,
      workflowName: "test-script",
      argsSummary: "{}",
      scriptSource: "agent('x')",
      budgetTimeMs: 600_000,
    });
    appendRecordLine(tmpDir, runId, { type: "run-settled", seq: 2, ts: 2000, outcome: "done", artifactsDir: tmpDir });

    const entries: CustomEntry[] = [v2RegisteredEntry(runId, recordPath)];
    const store = new JsonlRunStore({ sessionDir: tmpDir, pi: mkPi(entries), ctx: mkCtx(entries) });
    const restored = await store.loadAll();
    expect(restored[0]!.spec.budgetTimeMs).toBe(600_000);
  });

  it("loadAll round-trip: 旧格式帧（无 budgetTimeMs）/ 0 值 → spec 无预算（不限时，与 core 侧等价）", async () => {
    const legacyId = "run-rt-budget-legacy";
    const legacyPath = appendRecordLine(tmpDir, legacyId, { type: "run-created", seq: 1, ts: 1000, runId: legacyId, workflowName: "test-script", argsSummary: "{}", scriptSource: "agent('x')" });
    appendRecordLine(tmpDir, legacyId, { type: "run-settled", seq: 2, ts: 2000, outcome: "done", artifactsDir: tmpDir });
    const zeroId = "run-rt-budget-zero";
    const zeroPath = appendRecordLine(tmpDir, zeroId, { type: "run-created", seq: 1, ts: 1000, runId: zeroId, workflowName: "test-script", argsSummary: "{}", scriptSource: "agent('x')", budgetTimeMs: 0 });
    appendRecordLine(tmpDir, zeroId, { type: "run-settled", seq: 2, ts: 2000, outcome: "done", artifactsDir: tmpDir });

    const entries: CustomEntry[] = [v2RegisteredEntry(legacyId, legacyPath), v2RegisteredEntry(zeroId, zeroPath)];
    const store = new JsonlRunStore({ sessionDir: tmpDir, pi: mkPi(entries), ctx: mkCtx(entries) });
    const restored = await store.loadAll();
    const byId = new Map(restored.map((r) => [r.runId, r]));
    expect(byId.get(legacyId)!.spec.budgetTimeMs).toBeUndefined();
    expect(byId.get(zeroId)!.spec.budgetTimeMs).toBeUndefined();
  });

  it("loadAll round-trip: spec.budgetTimeMs 取最近一条 run-resumed 的生效值（覆盖 created；旧格式 run-resumed 回落 created）", async () => {
    // created 60min + run-resumed 120min → 生效 120min（跨崩溃存续的 record 侧）
    const overrideId = "run-rt-budget-resumed";
    const overridePath = appendRecordLine(tmpDir, overrideId, { type: "run-created", seq: 1, ts: 1000, runId: overrideId, workflowName: "test-script", argsSummary: "{}", scriptSource: "agent('x')", budgetTimeMs: 3_600_000 });
    appendRecordLine(tmpDir, overrideId, { type: "run-interrupted", seq: 2, ts: 2000, errorCode: "crashed" });
    appendRecordLine(tmpDir, overrideId, { type: "run-resumed", seq: 3, ts: 3000, budgetTimeMs: 7_200_000 });
    appendRecordLine(tmpDir, overrideId, { type: "run-settled", seq: 4, ts: 4000, outcome: "done", artifactsDir: tmpDir });

    // created 60min + 旧格式 run-resumed（无 budgetTimeMs）→ 回落 created 60min
    const legacyResumedId = "run-rt-budget-legacy-resumed";
    const legacyResumedPath = appendRecordLine(tmpDir, legacyResumedId, { type: "run-created", seq: 1, ts: 1000, runId: legacyResumedId, workflowName: "test-script", argsSummary: "{}", scriptSource: "agent('x')", budgetTimeMs: 3_600_000 });
    appendRecordLine(tmpDir, legacyResumedId, { type: "run-interrupted", seq: 2, ts: 2000, errorCode: "crashed" });
    appendRecordLine(tmpDir, legacyResumedId, { type: "run-resumed", seq: 3, ts: 3000 });
    appendRecordLine(tmpDir, legacyResumedId, { type: "run-settled", seq: 4, ts: 4000, outcome: "done", artifactsDir: tmpDir });

    const entries: CustomEntry[] = [v2RegisteredEntry(overrideId, overridePath), v2RegisteredEntry(legacyResumedId, legacyResumedPath)];
    const store = new JsonlRunStore({ sessionDir: tmpDir, pi: mkPi(entries), ctx: mkCtx(entries) });
    const restored = await store.loadAll();
    const byId = new Map(restored.map((r) => [r.runId, r]));
    expect(byId.get(overrideId)!.spec.budgetTimeMs).toBe(7_200_000);
    expect(byId.get(legacyResumedId)!.spec.budgetTimeMs).toBe(3_600_000);
  });

  it("loadAll round-trip: AgentCall.sessionFile / sessionId 经 result 载荷恢复（overlay 定位链）", async () => {
    const sessionFilePath = "/abs/.pi/agent/subagents/enc/sessions/2026-07-15T_session-abc.jsonl";
    const runId = "run-rt-001";
    const recordPath = seedSettledRunWithCall(tmpDir, runId, {
      content: "done",
      sessionId: "session-abc",
      sessionFile: sessionFilePath,
    });

    const entries: CustomEntry[] = [v2RegisteredEntry(runId, recordPath)];
    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    const restored = await store.loadAll();
    expect(restored).toHaveLength(1);
    expect(restored[0]!.runId).toBe(runId);
    const call = restored[0]!.state.calls.get(0);
    expect(call).toBeDefined();
    expect(call!.sessionFile).toBe(sessionFilePath);
    expect(call!.sessionId).toBe("session-abc");
    expect(call!.result?.content).toBe("done");
    expect(call!.status).toBe("done");
  });

  it("loadAll round-trip: result 全文不裁（10000 字符 content 逐字节恢复——resume 缓存回放的数据面）", async () => {
    const longContent = "q".repeat(10000);
    const runId = "run-rt-long";
    const recordPath = seedSettledRunWithCall(tmpDir, runId, { content: longContent });

    const entries: CustomEntry[] = [v2RegisteredEntry(runId, recordPath)];
    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    const restored = await store.loadAll();
    expect(restored[0]!.state.calls.get(0)!.result?.content).toHaveLength(10000);
    // trace 节点回链同一 result（D-10 引用共享重建）
    expect(restored[0]!.state.trace.toArray()[0]!.result?.content).toBe(longContent);
  });

  it("loadAll round-trip: spec.scriptSource 经 run-created 帧恢复（[D1] resume 重放的脚本体数据面）", async () => {
    const runId = "run-rt-script";
    const recordPath = seedSettledRunWithCall(tmpDir, runId, { content: "done" });

    const entries: CustomEntry[] = [v2RegisteredEntry(runId, recordPath)];
    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    const restored = await store.loadAll();
    expect(restored[0]!.spec.scriptSource).toBe("agent('x')");
    expect(restored[0]!.spec.scriptName).toBe("test-script");
    // meta.startedAt 优先 run-created 帧 ts（ISO 往返）
    expect(restored[0]!.meta.startedAt).toBe(new Date(1000).toISOString());
    expect(restored[0]!.meta.completedAt).toBe(new Date(1300).toISOString());
  });

  it("在途 call（dispatched 无 settled）重建为 running——恢复链 closeOut 的消费形态", async () => {
    const runId = "run-rt-inflight";
    const recordPath = appendRecordLine(tmpDir, runId, { type: "run-created", seq: 1, ts: 1000, runId, workflowName: "test-script", argsSummary: "{}", scriptSource: "agent('x')" });
    appendRecordLine(tmpDir, runId, { type: "agent-started", seq: 2, ts: 1100, taskIndex: 0, agentName: "worker", attempt: 1 });
    appendRecordLine(tmpDir, runId, { type: "agent-started", seq: 3, ts: 1150, taskIndex: 1, agentName: "reviewer", attempt: 1, phase: "review" });

    const entries: CustomEntry[] = [v2RegisteredEntry(runId, recordPath)];
    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    const restored = await store.loadAll();
    expect(restored[0]!.state.status).toBe("running");
    for (const call of restored[0]!.state.calls.values()) {
      expect(call.status).toBe("running");
    }
    // phase 归属随 dispatched 帧恢复（traceNode.phase——分组展示供源）
    expect(restored[0]!.state.calls.get(1)!.traceNode.phase).toBe("review");
    expect(restored[0]!.state.calls.get(0)!.traceNode.agent).toBe("worker");
  });

  it("[U10] 中断流 fold：run-interrupted 无复活无终局 → meta.interruptedAt 置位（投影 interrupted 非僵尸 running）；复活流清除标记", async () => {
    // 已收编 run（流含 run-interrupted）的重水合投影：聚合 status 保持两态
    // （running），中断态经 meta.interruptedAt 表达——runSummary 据此投影
    // 'interrupted'，CLI/TUI 不显示僵尸「运行中」；resume 复活（run-resumed
    // 尾帧）后标记清除回 running。
    const runId = "run-rt-interrupted";
    const recordPath = appendRecordLine(tmpDir, runId, { type: "run-created", seq: 1, ts: 1000, runId, workflowName: "test-script", argsSummary: "{}", scriptSource: "agent('x')" });
    appendRecordLine(tmpDir, runId, { type: "agent-started", seq: 2, ts: 1100, taskIndex: 0, agentName: "worker", attempt: 1 });
    appendRecordLine(tmpDir, runId, { type: "run-interrupted", seq: 3, ts: 1200, errorCode: "crashed", reason: "Process killed" });

    const entries: CustomEntry[] = [v2RegisteredEntry(runId, recordPath)];
    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    const restored = await store.loadAll();
    expect(restored[0]!.state.status).toBe("running"); // 聚合两态保持
    expect(restored[0]!.meta.interruptedAt).toBe(new Date(1200).toISOString());
    expect(runSummary(restored[0]!).status).toBe("interrupted");

    // 复活流（同流追加 run-resumed）：标记清除，投影回 running
    const runId2 = "run-rt-resumed";
    const recordPath2 = appendRecordLine(tmpDir, runId2, { type: "run-created", seq: 1, ts: 1000, runId: runId2, workflowName: "test-script", argsSummary: "{}", scriptSource: "agent('x')" });
    appendRecordLine(tmpDir, runId2, { type: "run-interrupted", seq: 2, ts: 1100, errorCode: "crashed", reason: "Process killed" });
    appendRecordLine(tmpDir, runId2, { type: "run-resumed", seq: 3, ts: 1200, reason: "resume dispatch plan: 1 restart(tier-3)", host: "h" });
    const store2 = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx([v2RegisteredEntry(runId2, recordPath2)]) });
    const restored2 = await store2.loadAll();
    expect(restored2[0]!.meta.interruptedAt).toBeUndefined();
    expect(runSummary(restored2[0]!).status).toBe("running");
  });
});

// ── stateFilePath：唯一持久件（record 流）指针 ───────────────────────

describe("W2[D1]: RunStore.stateFilePath 暴露 record 流路径", () => {
  let tmpDir: string;
  let store: JsonlRunStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-store-test-"));
    store = new JsonlRunStore({ sessionDir: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("stateFilePath(runId) 返回 <sessionDir>/workflow-state/<runId>.record.jsonl（[D1] 唯一持久件）", () => {
    const result = store.stateFilePath("run-foo");
    expect(result).toBe(path.join(tmpDir, "workflow-state", `run-foo${RUN_EVENT_JOURNAL_SUFFIX}`));
    expect(result.endsWith(".record.jsonl")).toBe(true);
  });
});

// ── W17/W1: workflow-record 条目面（零条目写锚定 + v2 收编读面）──────

describe("W17/W1[D1]: workflow-record 条目面（零条目写锚定 + v2 收编读面）", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-store-w17-"));
    loggerMock.warn.mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("customType 常量字面量钉住：WORKFLOW_RECORD_CUSTOM_TYPE === 'workflow-record'", () => {
    // 写点引用常量（单源）；本断言钉住常量与消费方（W18 runtime extractor）约定的
    // 字面量拼写，防重命名漂移后静默丢重建。
    expect(WORKFLOW_RECORD_CUSTOM_TYPE).toBe("workflow-record");
  });

  it("[停写锚定] save（running → done 全程）零 workflow-record entry、零 state 文件（[D1] 无物化面）", async () => {
    const entries: CustomEntry[] = [];
    const store = new JsonlRunStore({ sessionDir: tmpDir, pi: mkPi(entries) });
    const runId = "run-w17-shape";
    const run = WorkflowRun.reconstruct(
      runId,
      { scriptSource: "agent('x')", args: {}, scriptName: "test-script", scriptPath: "/tmp/x.js" },
      { status: "running", budget: new Budget(), calls: new Map(), trace: new Trace(), errorLogs: [] },
      { startedAt: new Date().toISOString() },
    );
    await store.save(run);
    run.transition("done", "completed");
    await store.save(run);

    expect(entries.filter((e) => e.customType === WORKFLOW_RECORD_CUSTOM_TYPE)).toHaveLength(0);
    // 无 state 快照文件（[D1] 投影退役锚）
    expect(fs.existsSync(path.join(tmpDir, "workflow-state", `${runId}.jsonl`))).toBe(false);
  });

  it("[D4 接管] store rebind 后 v2 终态条目补写走新 pi（旧 pi 不再收 entry）", async () => {
    const entriesOld: CustomEntry[] = [];
    const entriesNew: CustomEntry[] = [];
    const runId = "run-w17-rebind";
    // v2 收编面夹具：注册条目 + record 已终局（终态条目缺失 → loadAll 幂等补写）
    const recordPath = appendRecordLine(tmpDir, runId, { type: "run-created", runId, workflowName: "test-script", argsSummary: "{}", ts: 1000, seq: 1 });
    appendRecordLine(tmpDir, runId, { type: "run-settled", outcome: "done", artifactsDir: tmpDir, ts: 2000, seq: 2 });
    const seedEntries: CustomEntry[] = [v2RegisteredEntry(runId, recordPath)];

    const store = new JsonlRunStore({
      sessionDir: tmpDir,
      pi: mkPi(entriesOld),
      ctx: mkCtx(seedEntries),
    });
    // rebind 换源：条目补写面路由到新 pi
    store.rebind(mkPi(entriesNew), mkCtx(seedEntries));

    const loaded = await store.loadAll();
    expect(loaded[0]?.state.status).toBe("done");
    expect(loaded[0]?.state.reason).toBe("completed");

    // 补写落新 pi：seed 注册之外恰 1 条终态条目（kind: settled）
    const wfNew = entriesNew.filter((e) => e.customType === WORKFLOW_RECORD_CUSTOM_TYPE);
    expect(wfNew).toHaveLength(1);
    expect((wfNew[0]!.data as { kind?: string }).kind).toBe("settled");
    // 旧 pi 不再收 entry（appendEntry 源已换新）
    expect(entriesOld).toHaveLength(0);
  });

  it("[record 权威] state 文件从不存在，loadAll 仍从 record 流重建（唯一事实源证明）", async () => {
    const runId = "run-w1-record";
    const recordPath = appendRecordLine(tmpDir, runId, { type: "run-created", runId, workflowName: "test-script", argsSummary: "{}", ts: 1000, seq: 1 });
    appendRecordLine(tmpDir, runId, { type: "agent-settled", taskIndex: 0, attempt: 1, outcome: "done", durationMs: 5, result: { content: "ok" }, ts: 2000, seq: 2 });
    appendRecordLine(tmpDir, runId, { type: "run-settled", outcome: "done", artifactsDir: tmpDir, ts: 3000, seq: 3 });
    // 无任何 state 文件被创建过（[D1] 后磁盘唯一持久件 = record 流）

    const entries: CustomEntry[] = [v2RegisteredEntry(runId, recordPath)];
    const store = new JsonlRunStore({ sessionDir: tmpDir, pi: mkPi(entries), ctx: mkCtx(entries) });
    const loaded = await store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.runId).toBe(runId);
    expect(loaded[0]!.state.status).toBe("done");
    expect(loaded[0]!.state.reason).toBe("completed");
    // 终态条目缺失 → 幂等补写恰 1 条（收编条目半边）；载荷与 core finalizeRun 同构
    const settledEntries = entries.filter(
      (e) => e.customType === WORKFLOW_RECORD_CUSTOM_TYPE && (e.data as { kind?: string }).kind === "settled",
    );
    expect(settledEntries).toHaveLength(1);
    const data = settledEntries[0]!.data as Record<string, unknown>;
    expect(data["v"]).toBe(WORKFLOW_RECORD_ENTRY_VERSION);
    expect(data["kind"]).toBe("settled");
    expect(data["runId"]).toBe(runId);
    expect(data["status"]).toBe("done");
    expect(data["outcome"]).toBe("done");
    expect(data["reason"]).toBe("completed");
    expect(data["settledAt"]).toBe(3000);
    expect(data["callCount"]).toBe(1); // record agent-settled 帧数投影
  });

  it("[D2] 历史形态 interrupted outcome 帧被 scan 词表外坏行跳过（[D1] 历史数据处置——旧词表行不进解析路径，run 重建退 running 交收编）", async () => {
    const runId = "run-w1-interrupted";
    const recordPath = appendRecordLine(tmpDir, runId, { type: "run-created", runId, workflowName: "test-script", argsSummary: "{}", ts: 1000, seq: 1 });
    appendRecordLine(tmpDir, runId, { type: "run-settled", outcome: "interrupted", errorCode: "interrupted_abandoned", reason: "abandon window elapsed", artifactsDir: tmpDir, ts: 3000, seq: 2 });

    const entries: CustomEntry[] = [v2RegisteredEntry(runId, recordPath)];
    const store = new JsonlRunStore({ sessionDir: tmpDir, pi: mkPi(entries), ctx: mkCtx(entries) });
    // interrupted 已出 outcome 词表（[D2] 入 lifecycle）——历史帧在 strict 读面按
    // 词表外值拒绝（RecordStreamCorruptionError 上抛，storeHealthy=false——与半截
    // 行同语义，不静默跳过把损坏伪装成「无终局」）
    await expect(store.loadAll()).rejects.toThrow(/词表外 outcome/);
  });

  it("[收编幂等] 终态条目已在 → 补写跳过；双重启 loadAll 不重复追加", async () => {
    const runId = "run-w1-idem";
    const recordPath = appendRecordLine(tmpDir, runId, { type: "run-created", runId, workflowName: "test-script", argsSummary: "{}", ts: 1000, seq: 1 });
    appendRecordLine(tmpDir, runId, { type: "run-settled", outcome: "failed", errorCode: "engine_crashed", reason: "boom", artifactsDir: tmpDir, ts: 3000, seq: 2 });

    const entries: CustomEntry[] = [v2RegisteredEntry(runId, recordPath), v2SettledEntry(runId)];
    const storeA = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    const loaded = await storeA.loadAll();
    expect(loaded[0]!.state.status).toBe("done");
    expect(loaded[0]!.state.reason).toBe("failed");
    expect(loaded[0]!.state.error).toBe("boom");
    // 条目已在：不追加（数量不变）
    expect(entries.filter((e) => e.customType === WORKFLOW_RECORD_CUSTOM_TYPE)).toHaveLength(2);

    // 第二次启动（新 store 实例读同一 session 面）：仍恰 2 条，零重复追加
    const storeB = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    await storeB.loadAll();
    expect(entries.filter((e) => e.customType === WORKFLOW_RECORD_CUSTOM_TYPE)).toHaveLength(2);
  });

  it("[非终局不补写] record 无 run-settled → running 交恢复链，零条目追加", async () => {
    const runId = "run-w1-running";
    const recordPath = appendRecordLine(tmpDir, runId, { type: "run-created", runId, workflowName: "test-script", argsSummary: "{}", ts: 1000, seq: 1 });
    appendRecordLine(tmpDir, runId, { type: "agent-settled", taskIndex: 0, attempt: 1, outcome: "done", durationMs: 5, result: { content: "ok" }, ts: 2000, seq: 2 });

    const entries: CustomEntry[] = [v2RegisteredEntry(runId, recordPath)];
    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    const loaded = await store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.state.status).toBe("running");
    expect(entries.filter((e) => e.customType === WORKFLOW_RECORD_CUSTOM_TYPE)).toHaveLength(1);
  });

  it("[场景 18 锚] record 中部坏行 → loadAll 拒绝（读失败不静默跳过——唯一事实源读不出即拒绝）", async () => {
    const runId = "run-w1-badline";
    const recordPath = appendRecordLine(tmpDir, runId, { type: "run-created", runId, workflowName: "test-script", argsSummary: "{}", ts: 1000, seq: 1 });
    fs.appendFileSync(recordPath, "{truncated-not-json\n", "utf8"); // 中部坏行
    appendRecordLine(tmpDir, runId, { type: "run-settled", outcome: "done", artifactsDir: tmpDir, ts: 3000, seq: 2 });

    const entries: CustomEntry[] = [v2RegisteredEntry(runId, recordPath)];
    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    // [D1] 反转（原坏行宽容收编）：拒绝语义——错误含文件/行定位与恢复指引
    await expect(store.loadAll()).rejects.toThrow(/record 流损坏/);
    await expect(store.loadAll()).rejects.toThrow(/恢复/);
  });

  it("[中断收编] 注册条目指向缺失 record 流且无终态条目 → degraded running 重建交恢复链", async () => {
    const runId = "run-w1-missing";
    const entries: CustomEntry[] = [
      v2RegisteredEntry(runId, path.join(tmpDir, "workflow-state", `${runId}${RUN_EVENT_JOURNAL_SUFFIX}`)),
    ];
    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    const loaded = await store.loadAll();
    // 设计 §3.1 失败路径样例「全文件不可解析 → 该 run 按中断收编」：静默跳过会让
    // 该实体对恢复链与收编扫描全部不可见——degraded running 基线交恢复链收编。
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.runId).toBe(runId);
    expect(loaded[0]!.state.status).toBe("running");
    expect(loggerMock.warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain(runId);
  });

  it("[存续分流] record 流缺失 + 终态条目在 → 跳过不重建（呈现面归条目读者，不伪造收编）", async () => {
    const runId = "run-w1-missing-settled";
    const entries: CustomEntry[] = [
      v2RegisteredEntry(runId, path.join(tmpDir, "workflow-state", `${runId}${RUN_EVENT_JOURNAL_SUFFIX}`)),
      v2SettledEntry(runId),
    ];
    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    // 条目在 = 实体呈现面归条目读者（runtime 投影）；壳侧不产生 running 聚合
    //（对不在场的流交恢复链 = 伪造收编事实）
    await expect(store.loadAll()).resolves.toEqual([]);
    expect(loggerMock.warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("settled entry present");
  });

  it("[历史实体分流] 旧后缀锚点（.events.jsonl 注册条目）→ 跳过不重建（D1 历史数据处置：不读旧两件套）", async () => {
    const runId = "run-legacy-anchor";
    // 旧格式两件套在盘（历史遗留——不读不写不主动删）
    const legacyJournalPath = path.join(tmpDir, "workflow-state", `${runId}.events.jsonl`);
    fs.mkdirSync(path.dirname(legacyJournalPath), { recursive: true });
    fs.writeFileSync(legacyJournalPath, `${JSON.stringify({ type: "run-created", ts: 1000, runId, workflowName: "t", argsSummary: "{}" })}\n`, "utf8");
    fs.writeFileSync(path.join(tmpDir, "workflow-state", `${runId}.jsonl`), `{"runId":"${runId}"}\n`, "utf8");

    const entries: CustomEntry[] = [v2RegisteredEntry(runId, legacyJournalPath)];
    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    // 旧后缀锚点 = 历史 run：不重建（从壳侧读取面消失 = D1 预期行为），零读取
    await expect(store.loadAll()).resolves.toEqual([]);
  });

  it("[终局帧损坏] record 坏行 + 终态条目在 → 仍拒绝（条目救不回损坏的流——判读无第二判据）", async () => {
    const runId = "run-w1-settled-entry-final";
    const recordPath = appendRecordLine(tmpDir, runId, { type: "run-created", runId, workflowName: "test-script", argsSummary: "{}", ts: 1000, seq: 1 });
    // 终局帧损坏：[D1] 拒绝语义不因条目在场放宽（条目是投影锚不是第二判据）
    fs.appendFileSync(recordPath, '{"type":"run-settled","outcome":"compl\n', "utf8");

    const entries: CustomEntry[] = [v2RegisteredEntry(runId, recordPath), v2SettledEntry(runId)];
    const store = new JsonlRunStore({ sessionDir: tmpDir, pi: mkPi(entries), ctx: mkCtx(entries) });
    await expect(store.loadAll()).rejects.toThrow(/record 流损坏/);
    // 条目数量不变——不产生任何补写
    expect(entries.filter((e) => e.customType === WORKFLOW_RECORD_CUSTOM_TYPE)).toHaveLength(2);
  });

  it("entry 形态守卫：v2 但 kind 不在词表（半写/漂移）→ 静默跳过不崩（对齐 future-v 的不猜测解析）", async () => {
    const entries: CustomEntry[] = [
      {
        type: "custom",
        customType: WORKFLOW_RECORD_CUSTOM_TYPE,
        data: { v: WORKFLOW_RECORD_ENTRY_VERSION, kind: "migrated" },
        id: "seed-unknown-kind",
        parentId: null,
        timestamp: new Date().toISOString(),
      },
    ];
    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    await expect(store.loadAll()).resolves.toEqual([]);
  });
});

// ── D5 store stale guard（rebind 面——被测对象是 JsonlRunStore rebind 后的条目补写）──

describe("D5 store stale guard：rebind 后窗口内 stale appendEntry 统一 debug 丢弃", () => {
  it("stale 抛错不进错误路径：loadAll 终态条目补写被守卫丢弃（不 reject）、读回终态", async () => {
    const staleMessage = "Extension runner is stale after session replacement";
    const entriesStale: CustomEntry[] = [];
    const piStale = mkPi(entriesStale, {
      appendEntry: vi.fn(() => {
        throw new Error(staleMessage);
      }),
    });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-adopt-stale-"));
    try {
      // v2 收编面夹具：注册条目 + record 已终局（终态条目缺失 → loadAll 幂等补写）
      const runId = "wf-stale-1";
      const recordPath = appendRecordLine(tmpDir, runId, { type: "run-created", runId, workflowName: "test-script", argsSummary: "{}", ts: 1000, seq: 1 });
      appendRecordLine(tmpDir, runId, { type: "run-settled", outcome: "done", artifactsDir: tmpDir, ts: 2000, seq: 2 });
      const seedEntries: CustomEntry[] = [v2RegisteredEntry(runId, recordPath)];

      const store = new JsonlRunStore({
        sessionDir: tmpDir,
        ctx: mkCtx(seedEntries),
      });
      // rebind 后新 pi 随下一次 reload 窗口变 stale（appendEntry 抛 PS-30 文案）
      store.rebind(piStale, mkCtx(seedEntries));

      // 补写撞 stale → guardStaleCtx 分诊丢弃（debug 留痕），loadAll 不 reject、
      // 读回终态（条目是投影锚：stale 窗口内缺失由下次 loadAll 幂等补写自愈）
      const loaded = await store.loadAll();
      expect(loaded).toHaveLength(1);
      expect(loaded[0]!.state.status).toBe("done");
      expect(entriesStale).toHaveLength(0); // stale 条目被丢弃
      // save（no-op）照常 settle
      const run = WorkflowRun.reconstruct(
        "wf-stale-2",
        { scriptSource: "agent('x')", args: {}, scriptName: "test-script", scriptPath: "/tmp/x.js" },
        { status: "done", reason: "completed", budget: new Budget(), calls: new Map(), trace: new Trace(), errorLogs: [] },
        { startedAt: new Date().toISOString() },
      );
      await expect(store.save(run)).resolves.toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});
