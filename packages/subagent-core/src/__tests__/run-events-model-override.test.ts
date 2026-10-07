// src/__tests__/run-events-model-override.test.ts
//
// [subagent-model-switch U4a] 覆盖事件综合用例：事件构造 → journal 追加（W1 seq
// 契约）→ fold 派生视图端到端。任务书测试要求第 4 条（事件构造 → journal 追加 →
// fold 产物端到端）。
//
// 覆盖面：
// - 词表同步：RUN_EVENT_TYPES 含 model-override（core 词表值域——journal 严格校验
//   消费词表值，只改类型联合不改词表值时新事件行被判 type-outside-vocabulary 拒收）
// - 事件构造：ModelOverrideEvent 样本合法（行校验 isWorkflowRunEventLine 放行；
//   信封坏值 / 词表外 type 仍拒收——新成员不放宽既有坏行纪律）
// - journal 追加：单写者入口 append 分配正整数 seq（W1 契约：新写行信封必填），
//   append → scan 往返等价；seq 契约下与既有事件同流混写水位单调
// - fold：覆盖帧不进状态机（worker-log 同款——不坏帧、不占转移表行、水位推进），
//   覆盖值折叠（latestModelOverride 取最新不叠加），状态机半边照常推进到后续帧
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
} from "../orchestration/run-events.ts";
import type { ModelOverrideEvent, WorkflowRunEvent } from "../orchestration/run-events.ts";

// ── 夹具 ─────────────────────────────────────────────────────────────────────

const T0 = 1_770_000_000_000;

let journalDir: string;

beforeEach(() => {
  journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-events-model-override-"));
});

afterEach(() => {
  fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

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

/** 剥离 seq 的载荷投影（追加往返等价断言用）。 */
function stripSeq(event: WorkflowRunEvent): Omit<WorkflowRunEvent, "seq"> {
  const { seq: _s, ...rest } = event;
  return rest;
}

// ── 词表同步（四点同步的第一点：core 词表值域）────────────────

describe("词表同步：model-override 在 core 词表值域内（journal 严格校验消费词表值）", () => {
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
    // seq 契约在 core 严格档（requireSeq: true——恢复读面）下校验；坏值（0 非正整数）拒收
    expect(
      parseRecordStreamLine(JSON.stringify({ ...overrideEvent(1, T0), seq: 0 }), { requireSeq: true }).ok,
    ).toBe(false);
  });
});

// ── journal 追加（W1 seq 契约）──────────────────────────────

describe("journal 追加：覆盖事件走单写者入口，seq 契约成立", () => {
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
