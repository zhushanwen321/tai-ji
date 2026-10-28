// src/__tests__/run-events-model-override.test.ts
//
// [subagent-model-switch U4a] 覆盖事件综合用例：事件构造 → journal 追加（W1 seq
// 契约）→ fold 派生视图端到端。任务书测试要求第 4 条（事件构造 → journal 追加 →
// fold 产物端到端）。
//
// 覆盖范围：
// - 词表同步：RUN_EVENT_TYPES 含 model-override（core 词表值域——journal 严格校验
//   消费词表值，只改类型联合不改词表值时新事件行被判 type-outside-vocabulary 拒收）
// - 事件构造：ModelOverrideEvent 样本合法（行校验 isWorkflowRunEventLine 放行；
//   信封坏值 / 词表外 type 仍拒收——新成员不放宽既有坏行纪律）
// - journal 追加：单写者入口 append 分配正整数 seq（W1 契约：新写行信封必填），
//   append → scan 往返等价；seq 契约下与既有事件同流混写水位单调
// - fold：覆盖帧不进状态机（worker-log 同款——不坏帧、不占转移表行、水位推进），
//   覆盖值折叠（latestModelOverride 取最新不叠加），状态机半边照常推进到后续帧
//
// 整合来源（round 5-g 测试提速，主被测对象 = run-events 事件流契约 + 重建消费方）：
//   resume-run-rebuild.test.ts（rebuildRunFromRecord fold 在途语义）。零 mock。同簇
//   T0 常量字节级同构去重；tmpdir hook 已下沉本段各 describe。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RUN_EVENT_TYPES,
  createRunEventJournal,
  foldRunEventCheckpoint,
  INITIAL_RUN_EVENT_FOLD,
  latestModelOverride,
  parseRecordStreamLine,
} from "../run-events.ts";
import type { ModelOverrideEvent, WorkflowRunEvent } from "../run-events.ts";
import { rebuildRunFromRecord } from "../resume-run-rebuild.ts";
import { expectReplayedCallEntry } from "./helpers/replay-call-assert.ts";

// ── 夹具 ─────────────────────────────────────────────────────────────────────

const T0 = 1_770_000_000_000;

let journalDir: string;

/** model-override 样本（载荷契约形态：SDK ModelRef 同形 + 可选 thinkingLevel + 信封）。 */
function overrideEvent(seq: number, ts: number, thinkingLevel?: string): ModelOverrideEvent {
  return {
    type: "model-override",
    seq,
    ts,
    model: { provider: "b-provider", modelId: "b1" },
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
  };
}

/** 剥离 seq 的载荷派生视图（追加往返等价断言用）。 */
function stripSeq(event: WorkflowRunEvent): Omit<WorkflowRunEvent, "seq"> {
  const { seq: _s, ...rest } = event;
  return rest;
}

// ── 词表同步（四点同步的第一点：core 词表值域）────────────────

describe("词表同步：model-override 在 core 词表值域内（journal 严格校验消费词表值）", () => {

  beforeEach(() => {
    journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-events-model-override-"));
  });

  afterEach(() => {
    fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  it("RUN_EVENT_TYPES 含 model-override（漏扩位时 journal 行校验判 type-outside-vocabulary 硬拒收）", () => {
    expect(RUN_EVENT_TYPES).toContain("model-override");
  });

  it("事件构造：覆盖样本过行校验（isWorkflowRunEventLine 判据经 parseRecordStreamLine 等价消费）", () => {
    const line = JSON.stringify(overrideEvent(1, T0, "high"));
    const parsed = parseRecordStreamLine(line, { requireSeq: false });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.event).toMatchObject({
        type: "model-override",
        model: { provider: "b-provider", modelId: "b1" },
        thinkingLevel: "high",
        seq: 1,
        ts: T0,
      });
    }
  });

  it("坏行纪律不放宽：词表外 type 与坏 seq 信封照旧拒收（新成员不豁免既有校验）", () => {
    expect(parseRecordStreamLine(JSON.stringify({ type: "not-in-vocabulary", ts: T0 }), { requireSeq: false }).ok).toBe(false);
    // seq 契约在 core 严格档（requireSeq: true——恢复读取路径）下校验；坏值（0 非正整数）拒收
    expect(
      parseRecordStreamLine(JSON.stringify({ ...overrideEvent(1, T0), seq: 0 }), { requireSeq: true }).ok,
    ).toBe(false);
  });
});

// ── journal 追加（W1 seq 契约）──────────────────────────────

describe("journal 追加：覆盖事件走单写者入口，seq 契约成立", () => {

  beforeEach(() => {
    journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-events-model-override-"));
  });

  afterEach(() => {
    fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  it("append 返回含正整数 seq 的完整事件；append → scan 往返等价", async () => {
    const journal = createRunEventJournal(journalDir);
    const appended = await journal.append("wf-ovr-journal", {
      type: "model-override",
      model: { provider: "b-provider", modelId: "b1" },
      thinkingLevel: "high",
      ts: T0,
    });

    // W1 seq 契约：新写行信封必填正整数 seq（journal 单写者分配——单调性构造性保证）
    expect(appended.seq).toBe(1);
    expect(Number.isSafeInteger(appended.seq)).toBe(true);
    expect(appended.seq).toBeGreaterThan(0);

    const scanned = await journal.scan("wf-ovr-journal");
    expect(scanned).toHaveLength(1);
    expect(stripSeq(scanned[0]!)).toEqual(stripSeq(appended));
  });

  it("与既有事件同流混写：水位单调推进（覆盖帧不重置不回退 seq）", async () => {
    const journal = createRunEventJournal(journalDir);
    await journal.append("wf-ovr-mixed", {
      type: "run-created",
      runId: "wf-ovr-mixed",
      workflowName: "test-wf",
      argsSummary: "{}",
      scriptSource: "agent('a')",
      ts: T0,
    });
    await journal.append("wf-ovr-mixed", {
      type: "model-override",
      model: { provider: "b-provider", modelId: "b1" },
      ts: T0 + 1_000,
    });
    await journal.append("wf-ovr-mixed", {
      type: "agent-started",
      taskIndex: 0,
      agentName: "a",
      attempt: 1,
      ts: T0 + 2_000,
    });

    const scanned = await journal.scan("wf-ovr-mixed");
    expect(scanned.map((e) => e.type)).toEqual(["run-created", "model-override", "agent-started"]);
    expect(scanned.map((e) => e.seq)).toEqual([1, 2, 3]);
  });
});

// ── fold：不进状态机 + 折叠派生视图（端到端）──────────────────

describe("fold：覆盖帧不坏帧、水位推进，覆盖值折叠取最新（端到端）", () => {

  beforeEach(() => {
    journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-events-model-override-"));
  });

  afterEach(() => {
    fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  it("含覆盖帧的流 fold 状态机照常推进（不因表外转移判坏帧停摆——P8 核实结论的回归锚）", () => {
    const events: WorkflowRunEvent[] = [
      {
        type: "run-created",
        seq: 1,
        ts: T0,
        runId: "wf-ovr-fold",
        workflowName: "test-wf",
        argsSummary: "{}",
      },
      overrideEvent(2, T0 + 1_000, "high"),
      {
        type: "agent-started",
        seq: 3,
        ts: T0 + 2_000,
        taskIndex: 0,
        agentName: "a",
        attempt: 1,
      },
      overrideEvent(4, T0 + 3_000),
    ];

    let brokenFrames = 0;
    const checkpoint = foldRunEventCheckpoint(events, () => {
      brokenFrames += 1;
    });

    // 覆盖帧不进状态机：零坏帧 + 状态随 run-created/agent-started 推进到 running
    expect(brokenFrames).toBe(0);
    expect(checkpoint.state.lifecycle).toBe("running");
    // 水位照常推进（覆盖帧贡献 lastSeq——tail 消费方不重读）
    expect(checkpoint.lastSeq).toBe(4);
  });

  it("latestModelOverride：最新一条生效（不叠加）；无覆盖 undefined；载荷完整透传", () => {
    const events: WorkflowRunEvent[] = [
      overrideEvent(1, T0, "high"),
      overrideEvent(2, T0 + 1_000),
    ];
    // 后到覆盖整体替换前值（thinkingLevel 缺席不残留前值键——不叠加语义）
    expect(latestModelOverride(events)).toEqual({
      model: { provider: "b-provider", modelId: "b1" },
      ts: T0 + 1_000,
    });
    expect(latestModelOverride([{ type: "run-created", seq: 1, ts: T0, runId: "x", workflowName: "w", argsSummary: "" }])).toBeUndefined();
    expect(latestModelOverride([])).toBeUndefined();
  });

  it("端到端：journal 落盘（含 seq）→ scan → fold（状态机 + 折叠）产物一致", async () => {
    const journal = createRunEventJournal(journalDir);
    await journal.append("wf-ovr-e2e", {
      type: "run-created",
      runId: "wf-ovr-e2e",
      workflowName: "test-wf",
      argsSummary: "{}",
      ts: T0,
    });
    await journal.append("wf-ovr-e2e", {
      type: "model-override",
      model: { provider: "b-provider", modelId: "b1" },
      thinkingLevel: "low",
      ts: T0 + 1_000,
    });

    const scanned = await journal.scan("wf-ovr-e2e");
    const checkpoint = foldRunEventCheckpoint(scanned, () => {
      throw new Error("unexpected broken frame");
    });

    expect(checkpoint.state.lifecycle).toBe("running");
    expect(latestModelOverride(scanned)).toEqual({
      model: { provider: "b-provider", modelId: "b1" },
      thinkingLevel: "low",
      ts: T0 + 1_000,
    });
    // fold 以 INITIAL 检查点为起点幂等（同流重读同产物）
    const replayed = foldRunEventCheckpoint(scanned, () => {
      throw new Error("unexpected broken frame");
    }, INITIAL_RUN_EVENT_FOLD);
    expect(replayed.state).toEqual(checkpoint.state);
    expect(replayed.lastSeq).toBe(checkpoint.lastSeq);
  });
});
// resume-run-rebuild.test.ts —— resume 重建 fold 语义测试（subagent-tool-interface-refactor
// 设计 §3.4「resume-run-rebuild.ts 修复 fold 的在途语义」；impl-plan u-foundation 验收条款②）。
//
// 覆盖：中断恢复重建（rebuildRunFromRecord）的 trace 节点状态位——
// - 在途 draft（有 agent-started 无 agent-settled）折 running，不是 completed（假成功 bug 修复；
//   与壳侧 foldRecordStreamToRun 的在途 = running 语义对齐）
// - settled 帧按 result.error 定 failed/completed（既有语义回归）
// - 回放集/重派集的 AgentCall 条目语义不变（重派集不建条目）
function makeRunCreated(): Extract<WorkflowRunEvent, { type: "run-created" }> {
  return {
    type: "run-created",
    runId: "wf-fold",
    seq: 0,
    workflowName: "fan-out",
    argsSummary: "{}",
    scriptSource: "async function execute({ agent }) { await agent('step1'); }",
    scriptPath: "/abs/workflows/fan-out.js",
    ts: T0,
  };
}

describe("rebuildRunFromRecord — fold 在途语义（中断恢复）", () => {
  it("在途 draft（无 settled 帧）折为 running，不是 completed；回放集折 completed；settled failed 折 failed", () => {
    const created = makeRunCreated();
    const events: WorkflowRunEvent[] = [
      // 回放集：taskIndex 0 done（result 全文随帧）。
      { type: "agent-started", taskIndex: 0, agentName: "fan-out-0", attempt: 1, seq: 1, ts: T0 + 1_000 },
      { type: "agent-settled", taskIndex: 0, attempt: 1, outcome: "done", durationMs: 5_000, result: { content: "result-0" }, seq: 2, ts: T0 + 6_000 },
      // 回放集：taskIndex 1 failed（result.error 定状态位）。
      { type: "agent-started", taskIndex: 1, agentName: "fan-out-1", attempt: 1, seq: 3, ts: T0 + 7_000 },
      { type: "agent-settled", taskIndex: 1, attempt: 1, outcome: "failed", durationMs: 500, result: { content: "", error: "boom" }, seq: 4, ts: T0 + 7_500 },
      // 重派集：taskIndex 2 有 started 无 settled——中断时仍在途。
      { type: "agent-started", taskIndex: 2, agentName: "fan-out-2", attempt: 1, seq: 5, ts: T0 + 8_000 },
    ];

    const run = rebuildRunFromRecord("wf-fold", created, events);
    const statusByIndex = new Map(run.state.trace.toArray().map((n) => [n.stepIndex, n.status]));

    expect(statusByIndex.get(0)).toBe("completed");
    expect(statusByIndex.get(1)).toBe("failed");
    // 修复断言：在途 draft 折 running——旧实装折 completed（假成功：未跑完的成员在
    // resume 后的成员表兜底路径冒充已完成）。
    expect(statusByIndex.get(2)).toBe("running");
  });

  it("在途 draft 的节点可被成员表兜底路径消费：agent 标签与 startedAt 随帧恢复", () => {
    const created = makeRunCreated();
    const events: WorkflowRunEvent[] = [
      { type: "agent-started", taskIndex: 3, agentName: "fan-out-3", attempt: 2, seq: 6, ts: T0 + 9_000 },
    ];

    const run = rebuildRunFromRecord("wf-fold", created, events);
    const node = run.state.trace.toArray().find((n) => n.stepIndex === 3);
    expect(node).toBeDefined();
    expect(node!.status).toBe("running");
    expect(node!.agent).toBe("fan-out-3");
    expect(node!.startedAt).toBe(new Date(T0 + 9_000).toISOString());
    expect(node!.completedAt).toBeUndefined(); // 未终局无完成时刻
  });

  it("call 条目语义不变：回放集 done + result 全文；重派集不建条目（worker 重跑到断点处重新派发）", () => {
    const created = makeRunCreated();
    const events: WorkflowRunEvent[] = [
      { type: "agent-started", taskIndex: 0, agentName: "fan-out-0", attempt: 1, seq: 7, ts: T0 + 1_000 },
      { type: "agent-settled", taskIndex: 0, attempt: 1, outcome: "done", durationMs: 5_000, result: { content: "result-0" }, seq: 8, ts: T0 + 6_000 },
      { type: "agent-started", taskIndex: 1, agentName: "fan-out-1", attempt: 1, seq: 9, ts: T0 + 7_000 },
    ];

    const run = rebuildRunFromRecord("wf-fold", created, events);
    // 回放集/重派集 call 条目（共享断言 = __tests__/helpers/replay-call-assert.ts）
    expectReplayedCallEntry(run.state.calls);
  });

  it("[§3.3.6/§3.3.9 budget] 重派集成员声明入参挂 meta.recoveredCallOpts（calls miss 的预算回落源）；回放集不入表（真值在 calls）", () => {
    const created = makeRunCreated();
    const events: WorkflowRunEvent[] = [
      // 回放集：input 载荷恢复进 calls 条目 opts（既有语义）。
      { type: "agent-started", taskIndex: 0, agentName: "fan-out-0", attempt: 1, seq: 10, ts: T0 + 1_000, input: JSON.stringify({ prompt: "p0", maxTurns: 4, timeoutMs: 90_000 }) },
      { type: "agent-settled", taskIndex: 0, attempt: 1, outcome: "done", durationMs: 5_000, result: { content: "result-0" }, seq: 11, ts: T0 + 6_000 },
      // 重派集：started 无 settled——声明值只进 meta（重派前窗口 budgetViewOf 回落源）。
      { type: "agent-started", taskIndex: 1, agentName: "fan-out-1", attempt: 1, seq: 12, ts: T0 + 7_000, input: JSON.stringify({ prompt: "p1", maxTurns: 6 }) },
    ];

    const run = rebuildRunFromRecord("wf-fold", created, events);
    // 重派集不建 calls 条目（语义不变——worker 重跑脚本到断点处重新派发）
    expect(run.state.calls.has(1)).toBe(false);
    expect(run.meta.recoveredCallOpts?.get(1)).toEqual({ prompt: "p1", maxTurns: 6 });
    // 回放集不入恢复表（calls 条目持真值，恢复表只收录 calls 缺席成员）
    expect(run.meta.recoveredCallOpts?.has(0)).toBe(false);
    expect(run.state.calls.get(0)?.opts).toEqual({ prompt: "p0", maxTurns: 4, timeoutMs: 90_000 });
  });

  it("[§3.3.6/§3.3.9 budget] 全员回放集（无重派集）不落 recoveredCallOpts 键；旧格式帧无 input 的重派集成员不入表", () => {
    const created = makeRunCreated();
    const events: WorkflowRunEvent[] = [
      { type: "agent-started", taskIndex: 0, agentName: "fan-out-0", attempt: 1, seq: 13, ts: T0 + 1_000 },
      { type: "agent-settled", taskIndex: 0, attempt: 1, outcome: "done", durationMs: 5_000, result: { content: "result-0" }, seq: 14, ts: T0 + 6_000 },
      // 旧格式 started 帧（无 input 载荷）的重派集成员：无可恢复声明值，不入表（缺省不造键）
      { type: "agent-started", taskIndex: 1, agentName: "fan-out-1", attempt: 1, seq: 15, ts: T0 + 7_000 },
    ];

    const run = rebuildRunFromRecord("wf-fold", created, events);
    expect(run.meta.recoveredCallOpts).toBeUndefined();
  });
});
