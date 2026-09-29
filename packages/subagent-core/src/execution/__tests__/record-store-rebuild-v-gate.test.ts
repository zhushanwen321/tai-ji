// src/execution/__tests__/record-store-rebuild-v-gate.test.ts
//
// [W1 / U2b] record 读侧兼容：v1 快照通道版本门 + 身份解析三级优先级。
//
// 三面（设计 w1-run-record-journal-authority §3.3 D1/D2/D7/D8）：
//   1. v 门零幻影：v2 条目（registered/settled）与未知版本（future-v /
//      unknown-kind）在 v1 快照通道（collectLastRecordEntries +
//      rebuildEntryRecord）结构性跳过——不产生半构造的 v1 投影（D8 中间态
//      「不崩溃不产幻影」的读侧半边；v2 实体的状态权威在事件文件 fold）；
//   2. v1 兼容层行为不变（D7）：纯 v1 会话与 v1+v2 混排下的「每 id 末条 v1」
//      语义保持（v2 行像不存在）——旧会话读路径零迁移的证明义务；
//   3. 身份解析三级优先级（D2 binding 行裁决）：事件文件 fold > binding >
//      manifest——高级源在场即整体胜出（冲突字段取高级源值），源缺失/损坏
//      逐级降级，三源皆缺 → undefined。
//
// fixture 自持说明：helpers/subagent-record-fixture.ts（v1 快照单源）归 U2a
// 领地（其 v2 断言重写会触碰），本文件局部自持最小形态（record-entry-collect
// .test.ts 的 makeRecord 同款先例）；v2 条目常量与 record-entry-collect.test.ts
// 的 V2_REGISTERED/V2_SETTLED 同形。

import { describe, expect, it } from "vitest";

import {
  collectLastRecordEntries,
  rebuildEntryRecord,
  resolveRecordIdentity,
} from "../persistence/record-store-rebuild.ts";
import { toSubagentRecordEntry } from "../persistence/record-entry.ts";
import type {
  SubagentRecordRegisteredEntryData,
  SubagentRecordSettledEntryData,
} from "../persistence/record-entry.ts";
import {
  foldRecordJournalEvents,
  type RecordBoundEvent,
  type RecordCreatedEvent,
  type RecordJournalEvent,
  type RecordJournalFoldState,
} from "../persistence/record-events.ts";
import type { RecordBinding } from "../persistence/state-marker.ts";
import type { ManifestRecord } from "../persistence/manifest-store.ts";
import type { SubagentRecord } from "../assembly/types.ts";

// ── fixture ───────────────────────────────────────────────────

/** 最小合法 SubagentRecord（v1 快照投影用；字段集同 record-entry-collect.test.ts）。 */
function makeV1Record(over: Partial<SubagentRecord> = {}): SubagentRecord {
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

/** 主 session 的 custom entry 行（appendEntry 落盘即此产物形态）。 */
function entryLine(data: unknown): string {
  return JSON.stringify({
    type: "custom",
    id: `e-${Math.random().toString(36).slice(2)}`,
    parentId: null,
    customType: "subagent-record",
    data,
  });
}

const V2_REGISTERED: SubagentRecordRegisteredEntryData = {
  v: 2,
  kind: "registered",
  id: "sa-v2-reg",
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
  id: "sa-v2-set",
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
  sessionFile: "/tmp/sessions/sa-v2-set.jsonl",
  result: "done: 3 tests fixed",
};

/** v1 投影产物经 JSON round-trip（磁盘读回形态 + Record<string,unknown> 通道）。 */
function v1EntryData(record: SubagentRecord): Record<string, unknown> {
  return JSON.parse(JSON.stringify(toSubagentRecordEntry(record))) as Record<string, unknown>;
}

// ── 1. v 门：v2 条目与未知版本跳过（零幻影）─────────────────────

describe("v 门：v2 条目在 v1 快照通道结构性跳过（零幻影）", () => {
  it("纯 v2 会话（registered + settled）→ collectLastRecordEntries 零收集", () => {
    const content = [entryLine(V2_REGISTERED), entryLine(V2_SETTLED)].join("\n") + "\n";
    expect(collectLastRecordEntries(content).size).toBe(0);
  });

  it("v2 registered/settled 直接喂 rebuildEntryRecord → null（不产半构造投影）", () => {
    // registered 若被 v1 通道消费会重建出 status:"running" 假态；settled 会丢失
    // eventLog/displayItems 详情域——两者都是幻影形态，v 门在重建层同样拦截。
    expect(rebuildEntryRecord("sa-v2-reg", V2_REGISTERED as unknown as Record<string, unknown>)).toBeNull();
    expect(rebuildEntryRecord("sa-v2-set", V2_SETTLED as unknown as Record<string, unknown>)).toBeNull();
  });

  it("future-v（v:3）与 unknown-kind（v:2 + kind 越词表）→ 跳过（不认识的版本跳过而非猜测）", () => {
    const future = { v: 3, id: "sa-fut", agent: "a", task: "t", startedAt: 1 };
    const unknownKind = { v: 2, kind: "snapshot", id: "sa-unk", agent: "a", task: "t", startedAt: 1 };
    expect(collectLastRecordEntries(entryLine(future)).size).toBe(0);
    expect(collectLastRecordEntries(entryLine(unknownKind)).size).toBe(0);
    expect(rebuildEntryRecord("sa-fut", future)).toBeNull();
    expect(rebuildEntryRecord("sa-unk", unknownKind)).toBeNull();
  });

  it("missing-v（无版本标记的存量形态）→ 宽容照 v1 读（真实写点恒写 v，宽容面只覆盖 fixture 简化形态）", () => {
    const noV = {
      id: "sa-nov",
      agent: "worker",
      task: "t",
      slug: "s",
      status: "running",
      mode: "background",
      startedAt: 1000,
      rootSessionId: "r",
      depth: 0,
      turns: 0,
      totalTokens: 0,
      eventLog: [],
      displayItems: [],
    };
    expect(collectLastRecordEntries(entryLine(noV)).size).toBe(1);
    expect(rebuildEntryRecord("sa-nov", noV)?.id).toBe("sa-nov");
  });
});

// ── 2. v1 兼容层行为不变（D7：旧会话读路径零迁移）────────────────

describe("v1 兼容层：v 门不破 v1 路径（D7）", () => {
  it("纯 v1 会话「每 id 末条」语义保持", () => {
    const first = v1EntryData(makeV1Record({ id: "sa-v1", status: "running" }));
    const last = v1EntryData(
      makeV1Record({ id: "sa-v1", status: "idle", stopReason: "completed", endedAt: 2000, result: "done" }),
    );
    const map = collectLastRecordEntries([entryLine(first), entryLine(last)].join("\n") + "\n");
    expect(map.size).toBe(1);
    expect(map.get("sa-v1")).toMatchObject({ id: "sa-v1", status: "idle", stopReason: "completed", result: "done" });
  });

  it("v1+v2 混排（不同 id，按 id 不相交的常态形态）→ 输出与纯 v1 会话逐项相等（v2 行像不存在）", () => {
    const a = v1EntryData(makeV1Record({ id: "sa-a", status: "running" }));
    const b = v1EntryData(makeV1Record({ id: "sa-b", status: "idle", stopReason: "failed", endedAt: 3000 }));
    const pure = collectLastRecordEntries([entryLine(a), entryLine(b)].join("\n") + "\n");
    const mixed = collectLastRecordEntries(
      [entryLine(a), entryLine(V2_REGISTERED), entryLine(b), entryLine(V2_SETTLED)].join("\n") + "\n",
    );
    const serialize = (m: Map<string, Record<string, unknown>>): Array<[string, string]> =>
      [...m.entries()].map(([k, v]) => [k, JSON.stringify(v)]);
    expect(serialize(mixed)).toEqual(serialize(pure));
  });

  it("同 id v1 在前 v2 在后 → 末条仍取 v1（v2 行不覆盖 v1 末条语义）", () => {
    const v1 = v1EntryData(makeV1Record({ id: "sa-mix", status: "running" }));
    const map = collectLastRecordEntries(
      [entryLine(v1), entryLine({ ...V2_SETTLED, id: "sa-mix" })].join("\n") + "\n",
    );
    expect(map.size).toBe(1);
    expect(map.get("sa-mix")).toEqual(v1);
  });

  it("rebuildEntryRecord 对 v1 data 的既有投影不变（终态域对照组）", () => {
    const data = v1EntryData(
      makeV1Record({ id: "sa-v1p", status: "idle", stopReason: "completed", endedAt: 2000, result: "done" }),
    );
    const rec = rebuildEntryRecord("sa-v1p", data);
    expect(rec).not.toBeNull();
    expect(rec?.status).toBe("idle");
    expect(rec?.stopReason).toBe("completed");
    expect(rec?.endedAt).toBe(2000);
    expect(rec?.result).toBe("done");
    expect(rec?.agent).toBe("/home/u/agents/worker.md");
  });
});

// ── 3. 身份解析三级优先级（事件文件 fold > binding > manifest）────

const CREATED_EVENT: RecordCreatedEvent = {
  type: "record-created",
  seq: 1,
  ts: 1780000000000,
  id: "sa-idn",
  agent: "fold-agent",
  task: "fold task",
  slug: "fold-slug",
  origin: "workflow",
  parentRunId: "wf-fold",
  stepIndex: 3,
  rootSessionId: "root-fold",
  parentRecordId: undefined,
  depth: 1,
  mode: "background",
  startedAt: 1780000000000,
};

const BOUND_EVENT: RecordBoundEvent = {
  type: "record-bound",
  seq: 2,
  ts: 1780000001000,
  sessionFile: "/tmp/sessions/sa-idn.jsonl",
  engine: "pi",
  engineHandle: { sessionRef: { sessionId: "s-1" }, poolKey: "shared" },
  epoch: 0,
};

const BINDING: RecordBinding = {
  v: 1,
  recordId: "sa-idn",
  rootSessionId: "root-binding",
  depth: 1,
  agent: "binding-agent",
  task: "binding task",
  slug: "binding-slug",
  mode: "background",
  startedAt: 2000,
  model: undefined,
  worktree: false,
  origin: "tool",
  stepIndex: 7,
};

const MANIFEST: ManifestRecord = {
  id: "sa-idn",
  rootSessionId: "root-mani",
  agentName: "manifest-agent",
  status: "running",
  createdAt: 3000,
  completedAt: 4000,
  task: "manifest task",
  slug: "manifest-slug",
};

function foldOf(events: readonly RecordJournalEvent[]): RecordJournalFoldState {
  return foldRecordJournalEvents(events);
}

describe("resolveRecordIdentity：三级优先级（fold > binding > manifest）", () => {
  it("档 1：三源齐在场且字段冲突 → fold 整体胜出（agent/task/slug/origin/parentRunId/stepIndex 取 fold 值）", () => {
    const resolved = resolveRecordIdentity(foldOf([CREATED_EVENT]), BINDING, MANIFEST);
    expect(resolved).toBeDefined();
    expect(resolved?.source).toBe("journal-fold");
    expect(resolved?.id).toBe("sa-idn");
    expect(resolved?.agent).toBe("fold-agent");
    expect(resolved?.task).toBe("fold task");
    expect(resolved?.slug).toBe("fold-slug");
    expect(resolved?.origin).toBe("workflow");
    expect(resolved?.parentRunId).toBe("wf-fold");
    expect(resolved?.stepIndex).toBe(3);
    expect(resolved?.rootSessionId).toBe("root-fold");
    expect(resolved?.depth).toBe(1);
    expect(resolved?.startedAt).toBe(1780000000000);
  });

  it("档 2：无事件文件（v1 实体）→ binding 胜出（manifest 冲突在场不参与）", () => {
    const resolved = resolveRecordIdentity(undefined, BINDING, MANIFEST);
    expect(resolved?.source).toBe("binding");
    expect(resolved?.agent).toBe("binding-agent");
    expect(resolved?.task).toBe("binding task");
    expect(resolved?.rootSessionId).toBe("root-binding");
    expect(resolved?.origin).toBe("tool");
    expect(resolved?.stepIndex).toBe(7);
    expect(resolved?.parentRunId).toBeUndefined();
  });

  it("档 2 降级变体：fold 有状态但 identity undefined（残文件——缺创建帧）→ 降级 binding", () => {
    const boundOnly = foldOf([BOUND_EVENT]); // bound 落账但无 record-created
    expect(boundOnly.identity).toBeUndefined();
    const resolved = resolveRecordIdentity(boundOnly, BINDING, MANIFEST);
    expect(resolved?.source).toBe("binding");
    expect(resolved?.agent).toBe("binding-agent");
  });

  it("档 3：fold/binding 皆缺 → manifest 兜底（投影语义对齐 manifestToSubagent）", () => {
    const resolved = resolveRecordIdentity(undefined, undefined, MANIFEST);
    expect(resolved?.source).toBe("manifest");
    expect(resolved?.id).toBe("sa-idn");
    expect(resolved?.agent).toBe("manifest-agent");
    expect(resolved?.task).toBe("manifest task");
    expect(resolved?.slug).toBe("manifest-slug");
    expect(resolved?.startedAt).toBe(3000);
    expect(resolved?.mode).toBe("background");
    expect(resolved?.depth).toBe(0);
    expect(resolved?.rootSessionId).toBe("root-mani");
    expect(resolved?.parentRecordId).toBeUndefined();
  });

  it("档 3 空字段兜底：manifest task/slug 缺失 → 空串；rootSessionId 空串 → undefined", () => {
    const sparse = resolveRecordIdentity(undefined, undefined, {
      ...MANIFEST,
      task: undefined,
      slug: undefined,
      rootSessionId: "",
    });
    expect(sparse?.task).toBe("");
    expect(sparse?.slug).toBe("");
    expect(sparse?.rootSessionId).toBeUndefined();
  });

  it("三源皆缺 → undefined（调用方按无身份处理）", () => {
    expect(resolveRecordIdentity(undefined, undefined, undefined)).toBeUndefined();
  });

  it("fold identity 载荷损坏（必需字段非标量）→ 降级 binding（损坏残留不误判成身份）", () => {
    const corrupt = { ...CREATED_EVENT, agent: 42 } as unknown as RecordCreatedEvent;
    const resolved = resolveRecordIdentity(foldOf([corrupt]), BINDING, MANIFEST);
    expect(resolved?.source).toBe("binding");
    expect(resolved?.agent).toBe("binding-agent");
  });
});
