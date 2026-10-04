// src/execution/__tests__/record-entry-collect.test.ts
//
// subagent-record entry 契约（v2-only）：customType / 版本常量 / kind 词表 +
// 注册·终态条目载荷形态 + classifySubagentRecordEntryData 分类面。
//
// 历史沿革：本文件原覆盖「v1 全量快照序列化白名单 + v1/v2 双版本分类」；v1 兼容层
// 下线后（project 未发布、无 v1 数据），写点契约只剩 v2「注册 + 终态两条小条目」，
// v1 全量快照投影与其读者分支已删除——本文件同步改写为 v2-only，播种一律经
// helpers/v2-record-entry.ts（生产写侧未导出等价测试入口）。
//
// classify 语义（record-entry.ts SSOT）：
//   ok:true          = 当前 v2 条目（kind 已过词表判定）
//   wrong-type       = data 非对象
//   missing-v        = 对象但 v 缺失
//   future-v         = v 有值但不是 2（含已删的 v1 全量快照形态与类型漂移）
//   unknown-kind     = v=2 但 kind 不在 ["registered","settled"]

import { describe, expect, it } from "vitest";

import {
  SUBAGENT_RECORD_CUSTOM_TYPE,
  SUBAGENT_RECORD_ENTRY_KINDS,
  SUBAGENT_RECORD_ENTRY_VERSION,
  classifySubagentRecordEntryData,
  type SubagentRecordEntryV2,
  type SubagentRecordRegisteredEntryData,
  type SubagentRecordSettledEntryData,
} from "../persistence/record-entry.ts";
import type { SubagentRecord } from "../assembly/types.ts";
import { v2Entries, v2RegisteredEntry, v2SettledEntry } from "./helpers/v2-record-entry.ts";

/** 最小合法 SubagentRecord（缺省 = tool 来源、未收口）。 */
function makeRecord(over: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    id: "sa-1",
    agent: "/home/u/agents/worker.md",
    task: "t",
    slug: "worker",
    status: "running",
    mode: "background",
    startedAt: 1000,
    rootSessionId: "root-A",
    parentRecordId: undefined,
    depth: 0,
    endedAt: undefined,
    turns: 1,
    totalTokens: 42,
    model: "prov/m1",
    thinkingLevel: undefined,
    eventLog: [],
    displayItems: [],
    sessionFile: "sess-1.jsonl",
    ...over,
  } as SubagentRecord;
}

/** entry data 的 JSONL 形态字符串（appendEntry 落盘即此产物）。 */
function serialize(entry: SubagentRecordEntryV2): string {
  return JSON.stringify(entry);
}

const ENGINE_HANDLE = {
  sessionRef: { sessionId: "s-1", dbPath: "/tmp/db.sqlite" },
  poolKey: "shared",
} as const;

// ── v2 载荷契约（手写形态 = 生产类型逐字段钉住）──────────────────────────

const V2_REGISTERED: SubagentRecordRegisteredEntryData = {
  v: 2,
  kind: "registered",
  id: "sa-1",
  agent: "/home/u/agents/worker.md",
  task: "fix the flaky test",
  slug: "worker",
  origin: "workflow",
  parentRunId: "wf-1",
  stepIndex: 0,
  rootSessionId: "root-A",
  parentRecordId: undefined,
  depth: 1,
  startedAt: 1780000000000,
};

const V2_SETTLED: SubagentRecordSettledEntryData = {
  v: 2,
  kind: "settled",
  id: "sa-1",
  status: "idle",
  stopReason: "completed",
  outcome: "completed",
  endedAt: 1780000123000,
  turns: 3,
  totalTokens: 4500,
  model: "prov/m1",
  thinkingLevel: undefined,
  engine: "zcode",
  engineHandle: ENGINE_HANDLE,
  sessionFile: "/tmp/sessions/sa-1.jsonl",
  result: "done: 3 tests fixed",
};

describe("record-entry 常量面（customType / 版本 / kind 词表）", () => {
  it("keeps SUBAGENT_RECORD_CUSTOM_TYPE stable", () => {
    expect(SUBAGENT_RECORD_CUSTOM_TYPE).toBe("subagent-record");
  });

  it("版本常量 = 2；kind 词表恰为 registered/settled（D1：每实体两条小条目）", () => {
    expect(SUBAGENT_RECORD_ENTRY_VERSION).toBe(2);
    expect([...SUBAGENT_RECORD_ENTRY_KINDS]).toEqual(["registered", "settled"]);
  });
});

describe("v2 条目载荷形态", () => {
  it("注册条目 JSON round-trip：身份域在位，可选字段自然缺省（undefined 不落键）", () => {
    const revived = JSON.parse(serialize(V2_REGISTERED)) as Record<string, unknown>;
    expect(revived).toMatchObject({
      v: 2,
      kind: "registered",
      id: "sa-1",
      origin: "workflow",
      parentRunId: "wf-1",
      stepIndex: 0,
      rootSessionId: "root-A",
      depth: 1,
      startedAt: 1780000000000,
    });
    expect("parentRecordId" in revived).toBe(false);
  });

  it("终态条目 JSON round-trip：统计终值 + 锚链载荷 + result 全文在位", () => {
    const revived = JSON.parse(serialize(V2_SETTLED)) as Record<string, unknown>;
    expect(revived).toMatchObject({
      v: 2,
      kind: "settled",
      id: "sa-1",
      status: "idle",
      stopReason: "completed",
      outcome: "completed",
      endedAt: 1780000123000,
      turns: 3,
      totalTokens: 4500,
      model: "prov/m1",
      engine: "zcode",
      sessionFile: "/tmp/sessions/sa-1.jsonl",
    });
    expect(revived.engineHandle).toEqual(ENGINE_HANDLE);
    expect(revived.result).toBe("done: 3 tests fixed");
    expect("thinkingLevel" in revived).toBe(false);
  });
});

// ── 测试播种辅助（helpers/v2-record-entry.ts）────────────────────────────

describe("v2 播种辅助：SubagentRecord → 现行主 session 条目族", () => {
  it("注册播种：身份域投影 + 可选字段缺省不落键", () => {
    const entry = v2RegisteredEntry(
      makeRecord({ origin: "workflow", parentRunId: "wf-1", stepIndex: 0, depth: 1 }),
    );
    expect(entry).toMatchObject({
      v: 2,
      kind: "registered",
      id: "sa-1",
      agent: "/home/u/agents/worker.md",
      task: "t",
      slug: "worker",
      origin: "workflow",
      parentRunId: "wf-1",
      stepIndex: 0,
      rootSessionId: "root-A",
      depth: 1,
      startedAt: 1000,
    });
    const revived = JSON.parse(serialize(entry)) as Record<string, unknown>;
    expect(revived).toMatchObject({ v: 2, kind: "registered", id: "sa-1", origin: "workflow" });
    // 顶层 record：无父、无 step、无 parentRunId → 键缺省。
    const top = JSON.parse(serialize(v2RegisteredEntry(makeRecord()))) as Record<string, unknown>;
    expect("parentRecordId" in top).toBe(false);
    expect("parentRunId" in top).toBe(false);
    expect("stepIndex" in top).toBe(false);
  });

  it("终态播种：终局域投影（停因/统计/引擎锚/result）", () => {
    const entry = v2SettledEntry(
      makeRecord({
        status: "idle",
        stopReason: "completed",
        outcome: "completed",
        endedAt: 2000,
        engine: "zcode",
        engineHandle: ENGINE_HANDLE,
        result: "done",
      }),
    );
    expect(entry).toMatchObject({
      v: 2,
      kind: "settled",
      id: "sa-1",
      status: "idle",
      stopReason: "completed",
      outcome: "completed",
      endedAt: 2000,
      turns: 1,
      totalTokens: 42,
      model: "prov/m1",
      engine: "zcode",
      result: "done",
    });
    expect(entry.engineHandle).toEqual(ENGINE_HANDLE);
    // undefined 可选字段（error / thinkingLevel）不落键。
    const revived = JSON.parse(serialize(entry)) as Record<string, unknown>;
    expect("error" in revived).toBe(false);
    expect("thinkingLevel" in revived).toBe(false);
  });

  it("条目族：running 只产注册条目；已收口再补终态条目（注册先行）", () => {
    expect(v2Entries(makeRecord()).map((e) => e.kind)).toEqual(["registered"]);
    expect(
      v2Entries(makeRecord({ status: "idle", stopReason: "completed", endedAt: 2000 })).map(
        (e) => e.kind,
      ),
    ).toEqual(["registered", "settled"]);
  });
});

// ── v2-only 分类面 ───────────────────────────────────────────────────────

describe("classifySubagentRecordEntryData（v2-only）", () => {
  it("合法注册条目 → { ok:true, entry }，kind = 'registered'", () => {
    const result = classifySubagentRecordEntryData(V2_REGISTERED);
    expect(result).toEqual({ ok: true, entry: V2_REGISTERED });
    if (result.ok) {
      expect(result.entry.kind).toBe("registered");
    }
  });

  it("合法终态条目 → { ok:true, entry }，kind = 'settled' 且载荷可窄化", () => {
    const result = classifySubagentRecordEntryData(V2_SETTLED);
    expect(result.ok).toBe(true);
    if (result.ok && result.entry.kind === "settled") {
      expect(result.entry.stopReason).toBe("completed");
      expect(result.entry.result).toBe("done: 3 tests fixed");
    }
  });

  it("播种条目经 JSON round-trip 后仍判 ok（落盘形态 = 分类面输入）", () => {
    const seeded = v2Entries(makeRecord({ status: "idle", stopReason: "completed", endedAt: 2000 }));
    expect(seeded).toHaveLength(2);
    for (const entry of seeded) {
      const revived = JSON.parse(serialize(entry)) as unknown;
      expect(classifySubagentRecordEntryData(revived).ok).toBe(true);
    }
  });

  it("wrong-type：非对象 data（undefined / number / null）", () => {
    expect(classifySubagentRecordEntryData(undefined)).toEqual({ ok: false, reason: "wrong-type" });
    expect(classifySubagentRecordEntryData(42)).toEqual({ ok: false, reason: "wrong-type" });
    expect(classifySubagentRecordEntryData(null)).toEqual({ ok: false, reason: "wrong-type" });
  });

  it("missing-v：对象但 v 缺失", () => {
    expect(classifySubagentRecordEntryData({ id: "sa-1" })).toEqual({
      ok: false,
      reason: "missing-v",
    });
    expect(classifySubagentRecordEntryData({ kind: "registered" })).toEqual({
      ok: false,
      reason: "missing-v",
    });
  });

  it("unknown-kind：v = 2 但 kind 缺失或不在词表", () => {
    expect(classifySubagentRecordEntryData({ v: 2, kind: "snapshot" })).toEqual({
      ok: false,
      reason: "unknown-kind",
    });
    expect(classifySubagentRecordEntryData({ v: 2 })).toEqual({ ok: false, reason: "unknown-kind" });
  });

  it("future-v：v 有值但非当前版本（含已删 v1 全量快照形态与类型漂移）", () => {
    // 已删除的 v1 全量快照形态：旧写点产物，现行契约结构性跳过。
    const legacyV1Snapshot = {
      v: 1,
      id: "sa-1",
      agent: "/home/u/agents/worker.md",
      task: "t",
      slug: "worker",
      status: "running",
      mode: "background",
      startedAt: 1000,
      turns: 1,
      totalTokens: 42,
      model: "prov/m1",
    };
    expect(classifySubagentRecordEntryData(legacyV1Snapshot)).toEqual({
      ok: false,
      reason: "future-v",
    });
    expect(classifySubagentRecordEntryData({ v: 3 })).toEqual({ ok: false, reason: "future-v" });
    expect(classifySubagentRecordEntryData({ v: "1" })).toEqual({ ok: false, reason: "future-v" });
  });
});
