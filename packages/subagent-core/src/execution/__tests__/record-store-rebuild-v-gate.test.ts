// src/execution/__tests__/record-store-rebuild-v-gate.test.ts
//
// record 读侧：主 session entry 通道的版本门（当前只剩 v2）+ 身份解析三级优先级。
//
// 三面：
//   1. 版本门零幻影（登记 §3.3）：v1 全量快照兼容层已随兼容层删除，entry 通道
//      只剩当前版本——非当前版本（v1 快照 / future-v / missing-v）与未知 kind
//      的行在 collectV2EntryPairs 结构性跳过（不猜测、不产半构造投影）；
//   2. v2 条目对 → record 投影：身份域取注册条目（缺注册条目不成实体 → null），
//      终局域取终态条目；无终态条目 = running（引擎域回落 journal 的 bound 事件，
//      终态条目在场时优先）；条目契约不承载的字段（详情域 / patchFile / worktree
//      / round / batchFinalized）一律缺席；
//   3. 身份解析三级优先级（D2 binding 行裁决）：事件文件 fold > binding > manifest
//      ——高级源在场即整体胜出（冲突字段取高级源值），源缺失/损坏逐级降级，
//      三源皆缺 → undefined。
//
// fixture 自持：本文件局部构造 v2 条目 JSONL 行与最小 record（record-entry-collect
// .test.ts 的 makeRecord 同款先例；helpers/ 下资产归各邻近测试的领地）。

import { describe, expect, it } from "vitest";

import {
  collectV2EntryPairs,
  resolveRecordIdentity,
  v2PairToRecord,
} from "../persistence/record-store-rebuild.ts";
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

// ── fixture ───────────────────────────────────────────────────

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
  id: "sa-v2",
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
  id: "sa-v2",
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
  sessionFile: "/tmp/sessions/sa-v2.jsonl",
  result: "done: 3 tests fixed",
};

/** 已删除的 v1 全量快照形态（旧写点产物）——现行读侧必须整体跳过。 */
function v1SnapshotLine(over: Record<string, unknown> = {}): string {
  return entryLine({
    v: 1,
    id: "sa-v1",
    agent: "/home/u/agents/worker.md",
    task: "t",
    slug: "worker",
    status: "idle",
    stopReason: "completed",
    mode: "background",
    startedAt: 1000,
    rootSessionId: "root-A",
    parentRecordId: undefined,
    depth: 0,
    endedAt: 2000,
    turns: 1,
    totalTokens: 42,
    model: "prov/m1",
    thinkingLevel: undefined,
    eventLog: [],
    displayItems: [],
    ...over,
  });
}

const BOUND_EVENT: RecordBoundEvent = {
  type: "record-bound",
  seq: 2,
  ts: 1780000001000,
  sessionFile: "/tmp/sessions/sa-bound.jsonl",
  engine: "pi",
  engineHandle: { sessionRef: { sessionId: "s-bound" }, poolKey: "shared" },
  epoch: 0,
};

// ── 1. 版本门：非当前版本 / 未知 kind 跳过（零幻影）──────────────

describe("collectV2EntryPairs：entry 通道版本门（非当前版本跳过，零幻影）", () => {
  it("registered + settled 同 id 两行 → 成对收集", () => {
    const pairs = collectV2EntryPairs([entryLine(V2_REGISTERED), entryLine(V2_SETTLED)].join("\n") + "\n");
    expect(pairs.size).toBe(1);
    const pair = pairs.get("sa-v2");
    expect(pair?.registered?.kind).toBe("registered");
    expect(pair?.settled?.kind).toBe("settled");
    expect(pair?.settled?.result).toBe("done: 3 tests fixed");
  });

  it("同 kind 后写覆盖前行（末次注册 / 末次终态为权威）", () => {
    const content = [
      entryLine(V2_REGISTERED),
      entryLine({ ...V2_REGISTERED, task: "second task" }),
      entryLine({ ...V2_SETTLED, endedAt: 1780009999000 }),
      entryLine(V2_SETTLED),
    ].join("\n") + "\n";
    const pair = collectV2EntryPairs(content).get("sa-v2");
    expect(pair?.registered?.task).toBe("second task");
    expect(pair?.settled?.endedAt).toBe(1780000123000);
  });

  it("v1 全量快照形态（v:1）跳过——旧写点形态不进任何解析路径", () => {
    const pairs = collectV2EntryPairs(v1SnapshotLine() + "\n");
    expect(pairs.size).toBe(0);
  });

  it("future-v / unknown-kind / missing-v → 跳过（不认识的版本跳过而非猜测）", () => {
    const content = [
      entryLine({ ...V2_REGISTERED, v: 3 }),
      entryLine({ ...V2_REGISTERED, kind: "snapshot" }),
      // missing-v：无版本标记的形态（写点恒写 v，缺失即形态损坏）
      entryLine({ id: "sa-nov", kind: "registered", agent: "a", task: "t", startedAt: 1 }),
    ].join("\n") + "\n";
    expect(collectV2EntryPairs(content).size).toBe(0);
  });

  it("非本类型 / 截断行 / 非对象 data / 缺 id 行忽略（行级 best-effort 不抛）", () => {
    const content = [
      JSON.stringify({ type: "custom", customType: "other", data: V2_REGISTERED }),
      '{"type":"custom","customType":"subagent-record","data":',
      entryLine(null),
      entryLine({ ...V2_REGISTERED, id: 42 }),
      entryLine(V2_REGISTERED),
    ].join("\n") + "\n";
    const pairs = collectV2EntryPairs(content);
    expect(pairs.size).toBe(1);
    expect(pairs.get("sa-v2")?.registered).toBeDefined();
  });
});

// ── 2. v2 条目对 → record 投影（身份域注册条目 / 终局域终态条目）──

describe("v2PairToRecord：v2 条目对 → record 投影", () => {
  it("registered + settled → 身份域取注册条目，终局域取终态条目", () => {
    const rec = v2PairToRecord("sa-v2", { registered: V2_REGISTERED, settled: V2_SETTLED });
    expect(rec).not.toBeNull();
    expect(rec).toMatchObject({
      id: "sa-v2",
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
      status: "idle",
      stopReason: "completed",
      outcome: "completed",
      endedAt: 1780000123000,
      turns: 3,
      totalTokens: 4500,
      model: "prov/m1",
      engine: "zcode",
      sessionFile: "/tmp/sessions/sa-v2.jsonl",
      result: "done: 3 tests fixed",
      mode: "background",
    });
    expect(rec?.engineHandle).toEqual(V2_SETTLED.engineHandle);
  });

  it("条目契约不承载的字段一律缺席（详情域 / patchFile / worktree / round / batchFinalized）", () => {
    const rec = v2PairToRecord("sa-v2", { registered: V2_REGISTERED, settled: V2_SETTLED });
    expect(rec?.eventLog).toEqual([]);
    expect(rec?.displayItems).toEqual([]);
    expect(rec?.patchFile).toBeUndefined();
    expect(rec?.worktree).toBeUndefined();
    expect(rec?.round).toBeUndefined();
    expect(rec?.batchFinalized).toBeUndefined();
    expect(rec?.closedReason).toBeUndefined();
  });

  it("只有注册条目 → running（终局域零值/缺席）", () => {
    const rec = v2PairToRecord("sa-v2", { registered: V2_REGISTERED });
    expect(rec).toMatchObject({
      id: "sa-v2",
      status: "running",
      turns: 0,
      totalTokens: 0,
      endedAt: undefined,
      result: undefined,
      error: undefined,
    });
    // 终局域缺席（键不落）而非 undefined 占位——与写侧投影同口径
    expect(rec?.stopReason).toBeUndefined();
    expect(rec?.outcome).toBeUndefined();
  });

  it("缺注册条目 → null（身份无所出不成实体：仅终态行 / 空对都不成行）", () => {
    expect(v2PairToRecord("sa-v2", { settled: V2_SETTLED })).toBeNull();
    expect(v2PairToRecord("sa-v2", {})).toBeNull();
  });

  it("无终态条目时引擎域回落 bound 事件（引擎/sessionFile/engineHandle）", () => {
    const rec = v2PairToRecord("sa-v2", { registered: V2_REGISTERED }, BOUND_EVENT);
    expect(rec?.status).toBe("running");
    expect(rec?.engine).toBe("pi");
    expect(rec?.sessionFile).toBe("/tmp/sessions/sa-bound.jsonl");
    expect(rec?.engineHandle).toEqual(BOUND_EVENT.engineHandle);
  });

  it("无终态条目且无 bound → 引擎域缺席（不产半构造引擎锚）", () => {
    const rec = v2PairToRecord("sa-v2", { registered: V2_REGISTERED });
    expect(rec?.engine).toBeUndefined();
    expect(rec?.sessionFile).toBeUndefined();
    expect(rec?.engineHandle).toBeUndefined();
  });

  it("终态条目与 bound 事件同时在场 → 终态条目胜出", () => {
    const rec = v2PairToRecord("sa-v2", { registered: V2_REGISTERED, settled: V2_SETTLED }, BOUND_EVENT);
    expect(rec?.engine).toBe("zcode");
    expect(rec?.sessionFile).toBe("/tmp/sessions/sa-v2.jsonl");
    expect(rec?.engineHandle).toEqual(V2_SETTLED.engineHandle);
  });

  it("端到端：混合 v1 快照行的主 session 全文 → 每 id 一条 record（v1 行像不存在）", () => {
    const content = [
      v1SnapshotLine(),
      entryLine(V2_REGISTERED),
      entryLine(V2_SETTLED),
      entryLine({ ...V2_REGISTERED, id: "sa-run", task: "still running" }),
    ].join("\n") + "\n";
    const records = [...collectV2EntryPairs(content)]
      .map(([id, pair]) => v2PairToRecord(id, pair, BOUND_EVENT))
      .filter((r) => r !== null);
    expect(records.map((r) => r.id).sort()).toEqual(["sa-run", "sa-v2"]);
    const settled = records.find((r) => r.id === "sa-v2");
    const running = records.find((r) => r.id === "sa-run");
    expect(settled).toMatchObject({ status: "idle", stopReason: "completed", turns: 3, engine: "zcode" });
    expect(running).toMatchObject({ status: "running", task: "still running", engine: "pi" });
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

const BOUND_EVENT_FOR_IDENTITY: RecordBoundEvent = {
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
    const boundOnly = foldOf([BOUND_EVENT_FOR_IDENTITY]); // bound 落账但无 record-created
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
