// src/execution/__tests__/record-entry-collect.test.ts
//
// subagent-record entry 序列化白名单与 v1/v2 双版本契约。
//
// v1 面锁三件事（subagent-sync-collect U1 foundation 设计 §3.1.3；[modeless 波3]
// collectMode 字段消亡后聚焦 batchFinalized——collect = 派发时路由选项，不再入 entry）：
//   1. 持久化：batchFinalized 在 entry data 中如实透传（round-trip 经 JSON 序列化不丢）；
//   2. 零迁移：无标记（旧 record 形态）的 entry 产物不含该键（JSON.stringify 自然
//      缺省），与改动前逐字节一致；
//   3. customType 稳定：SUBAGENT_RECORD_CUSTOM_TYPE 不因扩字段漂移。
//
// [W1 / D1] v2 面新增：版本常量 = 2、classify v1/v2 双分支（kind 判别）、v2
// 注册/终态条目形态与「v1 字段全保留（兼容读面不动）」互证。

import { describe, expect, it } from "vitest";

import {
  SUBAGENT_RECORD_CUSTOM_TYPE,
  SUBAGENT_RECORD_ENTRY_KINDS,
  SUBAGENT_RECORD_ENTRY_VERSION,
  classifySubagentRecordEntryData,
  toSubagentRecordEntry,
  type SubagentRecordEntryData,
  type SubagentRecordRegisteredEntryData,
  type SubagentRecordSettledEntryData,
} from "../persistence/record-entry.ts";
import type { SubagentRecord } from "../assembly/types.ts";

/** 最小合法 SubagentRecord（缺省无批域标记 = 旧记录形态）。 */
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
function serialize(entry: SubagentRecordEntryData): string {
  return JSON.stringify(entry);
}

describe("record-entry serialization: batch-finalized field (U1 foundation)", () => {
  it("keeps SUBAGENT_RECORD_CUSTOM_TYPE stable", () => {
    expect(SUBAGENT_RECORD_CUSTOM_TYPE).toBe("subagent-record");
  });

  it("passes batchFinalized through for a member that left the batch", () => {
    const entry = toSubagentRecordEntry(
      makeRecord({
        batchFinalized: true,
        status: "idle",
        endedAt: 2000,
      }),
    );
    expect(entry.batchFinalized).toBe(true);
    expect(entry.status).toBe("idle");
  });

  it("round-trips the marker through JSON serialization (persisted form)", () => {
    const entry = toSubagentRecordEntry(makeRecord({ batchFinalized: true }));
    const revived = JSON.parse(serialize(entry)) as SubagentRecordEntryData;
    expect(revived.batchFinalized).toBe(true);
    expect(revived.v).toBe(1);
  });

  it("emits no new keys for legacy records (旧记录零迁移)", () => {
    const json = serialize(toSubagentRecordEntry(makeRecord()));
    expect(json).not.toContain("collectMode");
    expect(json).not.toContain("batchFinalized");
    const revived = JSON.parse(json) as SubagentRecordEntryData;
    expect(revived.batchFinalized).toBeUndefined();
  });

  it("drops legacy collectMode keys on write-side (波3：字段停写，残留键读侧忽略)", () => {
    // 写侧停写后 entry 产物恒不含 collectMode 键——即使 record 对象曾被旧代码或
    // 手工注入该键（Structural typing 下多余键不进投影白名单）。
    const legacy = makeRecord({ batchFinalized: true }) as unknown as Record<string, unknown>;
    legacy["collectMode"] = "sync";
    const json = serialize(toSubagentRecordEntry(legacy as unknown as SubagentRecord));
    expect(json).not.toContain("collectMode");
    expect(json).toContain('"batchFinalized":true');
  });

  it("still emits the full legacy whitelist for legacy records (既有字段不受扩字段影响)", () => {
    const entry = toSubagentRecordEntry(makeRecord());
    expect(entry.id).toBe("sa-1");
    expect(entry.status).toBe("running");
    expect(entry.model).toBe("prov/m1");
    expect(entry.sessionFile).toBe("sess-1.jsonl");
  });

  it("[W1] v1 投影产物仍是 v:1（写点停写归 U2a——本层契约面零漂移）", () => {
    expect(toSubagentRecordEntry(makeRecord()).v).toBe(1);
  });
});

// ── [W1 / D1] v2 条目契约：版本常量 + classify v1/v2 双分支 ──────────────

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
  engineHandle: { sessionRef: { sessionId: "s-1", dbPath: "/tmp/db.sqlite" }, poolKey: "shared" },
  sessionFile: "/tmp/sessions/sa-1.jsonl",
  result: "done: 3 tests fixed",
};

describe("subagent-record entry v2 契约（版本常量 + kind 词表）", () => {
  it("版本常量 W1 起 = 2；kind 词表恰为 registered/settled（D1：每实体两条小条目）", () => {
    expect(SUBAGENT_RECORD_ENTRY_VERSION).toBe(2);
    expect([...SUBAGENT_RECORD_ENTRY_KINDS]).toEqual(["registered", "settled"]);
  });

  it("v2 注册条目 JSON round-trip：可选身份字段自然缺省（undefined 不落键）", () => {
    const revived = JSON.parse(JSON.stringify(V2_REGISTERED)) as Record<string, unknown>;
    expect(revived).toMatchObject({ v: 2, kind: "registered", id: "sa-1", origin: "workflow" });
    expect("parentRecordId" in revived).toBe(false);
  });

  it("v2 终态条目 JSON round-trip：统计终值 + 锚链载荷 + result 全文在位", () => {
    const revived = JSON.parse(JSON.stringify(V2_SETTLED)) as Record<string, unknown>;
    expect(revived).toMatchObject({ kind: "settled", status: "idle", stopReason: "completed", turns: 3 });
    expect(revived.engineHandle).toEqual({
      sessionRef: { sessionId: "s-1", dbPath: "/tmp/db.sqlite" },
      poolKey: "shared",
    });
    expect(revived.result).toBe("done: 3 tests fixed");
    expect("thinkingLevel" in revived).toBe(false);
  });
});

describe("classifySubagentRecordEntryData（v1/v2 双分支）", () => {
  it("v1 全量快照 → ok（data 透传不校验——解码归消费方）", () => {
    const v1 = toSubagentRecordEntry(makeRecord());
    const result = classifySubagentRecordEntryData(v1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBe(v1);
    }
  });

  it("v2 registered → reason 'v2'（载荷透传，消费方按 kind 窄化）", () => {
    expect(classifySubagentRecordEntryData(V2_REGISTERED)).toEqual({
      ok: false,
      reason: "v2",
      entry: V2_REGISTERED,
    });
  });

  it("v2 settled → reason 'v2'", () => {
    const result = classifySubagentRecordEntryData(V2_SETTLED);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "v2" && result.entry.kind === "settled") {
      expect(result.entry.stopReason).toBe("completed");
    }
  });

  it("wrong-type / missing-v / unknown-kind / future-v 边界形态", () => {
    expect(classifySubagentRecordEntryData(undefined)).toEqual({ ok: false, reason: "wrong-type" });
    expect(classifySubagentRecordEntryData(42)).toEqual({ ok: false, reason: "wrong-type" });
    expect(classifySubagentRecordEntryData({ id: "sa-1" })).toEqual({ ok: false, reason: "missing-v" });
    expect(classifySubagentRecordEntryData({ v: 2, kind: "snapshot" })).toEqual({
      ok: false,
      reason: "unknown-kind",
    });
    expect(classifySubagentRecordEntryData({ v: 2 })).toEqual({ ok: false, reason: "unknown-kind" });
    expect(classifySubagentRecordEntryData({ v: 3 })).toEqual({ ok: false, reason: "future-v" });
    expect(classifySubagentRecordEntryData({ v: "1" })).toEqual({ ok: false, reason: "future-v" });
  });

  it("版本门语义：v1 读者拿 !ok 分支跳过 v2（D8 中间态「不产幻影」的构造基础）", () => {
    // 模拟 record-store-rebuild 的 v1 消费形态：只认 ok，其余跳过——v2 条目
    // 结构性不可见（U2b 按本函数补门）。
    const forV1Reader = (data: unknown): unknown =>
      classifySubagentRecordEntryData(data).ok ? data : null;
    expect(forV1Reader(V2_REGISTERED)).toBeNull();
    expect(forV1Reader(V2_SETTLED)).toBeNull();
    expect(forV1Reader(toSubagentRecordEntry(makeRecord()))).not.toBeNull();
  });
});
