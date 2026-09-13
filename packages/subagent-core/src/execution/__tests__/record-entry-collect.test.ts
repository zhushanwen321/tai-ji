// src/execution/__tests__/record-entry-collect.test.ts
//
// subagent-record entry 序列化白名单：collectMode / batchFinalized 两字段
// （subagent-sync-collect U1 foundation）。
//
// 锁三件事（设计 §3.1.3）：
//   1. 持久化：两字段在 entry data 中如实透传（round-trip 经 JSON 序列化不丢）；
//   2. 零迁移：无字段（旧 record 形态）的 entry 产物不含新键（JSON.stringify 自然缺省），
//      与改动前逐字节一致；
//   3. customType 稳定：SUBAGENT_RECORD_CUSTOM_TYPE 不因扩字段漂移。

import { describe, expect, it } from "vitest";

import {
  SUBAGENT_RECORD_CUSTOM_TYPE,
  toSubagentRecordEntry,
  type SubagentRecordEntryData,
} from "../persistence/record-entry.ts";
import type { SubagentRecord } from "../assembly/types.ts";

/** 最小合法 SubagentRecord（缺省无 collect 两字段 = 旧记录形态）。 */
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

describe("record-entry serialization: collect fields (U1 foundation)", () => {
  it("keeps SUBAGENT_RECORD_CUSTOM_TYPE stable", () => {
    expect(SUBAGENT_RECORD_CUSTOM_TYPE).toBe("subagent-record");
  });

  it("passes collectMode through for a sync record", () => {
    const entry = toSubagentRecordEntry(makeRecord({ collectMode: "sync" }));
    expect(entry.collectMode).toBe("sync");
    expect(entry.batchFinalized).toBeUndefined();
  });

  it("passes batchFinalized through for a member that left the batch", () => {
    const entry = toSubagentRecordEntry(
      makeRecord({
        collectMode: "sync",
        batchFinalized: true,
        status: "idle",
        endedAt: 2000,
      }),
    );
    expect(entry.collectMode).toBe("sync");
    expect(entry.batchFinalized).toBe(true);
    expect(entry.status).toBe("idle");
  });

  it("round-trips both fields through JSON serialization (persisted form)", () => {
    const entry = toSubagentRecordEntry(
      makeRecord({ collectMode: "sync", batchFinalized: true }),
    );
    const revived = JSON.parse(serialize(entry)) as SubagentRecordEntryData;
    expect(revived.collectMode).toBe("sync");
    expect(revived.batchFinalized).toBe(true);
    expect(revived.v).toBe(1);
  });

  it("emits no new keys for legacy records (旧记录零迁移)", () => {
    const json = serialize(toSubagentRecordEntry(makeRecord()));
    expect(json).not.toContain("collectMode");
    expect(json).not.toContain("batchFinalized");
    const revived = JSON.parse(json) as SubagentRecordEntryData;
    expect(revived.collectMode).toBeUndefined();
    expect(revived.batchFinalized).toBeUndefined();
  });

  it("still emits the full legacy whitelist for legacy records (既有字段不受扩字段影响)", () => {
    const entry = toSubagentRecordEntry(makeRecord());
    expect(entry.id).toBe("sa-1");
    expect(entry.status).toBe("running");
    expect(entry.model).toBe("prov/m1");
    expect(entry.sessionFile).toBe("sess-1.jsonl");
  });
});
