// src/execution/__tests__/permanent-session-legacy-compat.test.ts
//
// [U8 / S8] 旧数据只读兼容（设计 §4 S8 行 + §3.2.4 双向兼容 + §3.2.8 session-reader
// 前向兼容铁律）：
//   - 旧格式磁盘组（旧 `.finalized`/`.cancelled` sidecar + v1 binding + 旧 manifest
//     值域 closed/completed/failed/cancelled，无 executionStatus/intent）经新代码读侧
//     投影：恒 idle + stopReason 桥接（finalized→reason / cancelled→interrupted），
//     不炸、不丢 identity；
//   - manifest 双写映射（U5-D10）：markSettled 轮间 idle → legacy running（活跃成员）
//     / markArchived archived intent → legacy closed（「已收起」= 结束）；
//   - 双写回读：manifest 源按 executionStatus（两态权威词）优先，settle 产物
//     （legacy running + executionStatus idle）读回 idle；
//   - [B-restart manifest 契约面] engine/engineHandle 域下行 + manifest 源回读
//     （zcode record 重启可见性兜底锚）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ManifestStore } from "../persistence/manifest-store.ts";
import { getSubagentRecordsDir, getSubagentSessionDir } from "../assembly/path-encoding.ts";
import { RecordStore } from "../persistence/record-store.ts";
import { writeRecordBinding } from "../persistence/state-marker.ts";
import type { ExecutionRecord } from "../assembly/types.ts";
import { createRecord } from "../persistence/execution-record.ts";

/** 最小合法子 session 文件（session header + identity custom entry，S8 旧数据形态）。 */
function writeLegacySessionJsonl(
  filePath: string,
  identity: { id: string; task: string; startedAt: number; rootSessionId?: string },
): void {
  const header = JSON.stringify({
    type: "session", version: 3, id: `sess-${identity.id}`, timestamp: new Date(identity.startedAt).toISOString(), cwd: "/tmp",
  });
  const identityData: Record<string, unknown> = {
    id: identity.id,
    agent: "worker",
    mode: "background",
    task: identity.task,
    slug: "legacy",
    startedAt: identity.startedAt,
  };
  if (identity.rootSessionId !== undefined) identityData.rootSessionId = identity.rootSessionId;
  const identityEntry = JSON.stringify({
    type: "custom",
    id: "id-1",
    parentId: null,
    timestamp: new Date(identity.startedAt).toISOString(),
    customType: "subagent-identity",
    data: identityData,
  });
  fs.writeFileSync(filePath, `${header}\n${identityEntry}\n`, "utf-8");
}

/** 旧格式 v1 binding（UF-1 起即 v1，新写侧同版本——旧数据无新字段即「旧」形态）。 */
function writeLegacyBinding(sessionFile: string, id: string, startedAt: number): void {
  writeRecordBinding(sessionFile, {
    v: 1,
    recordId: id,
    rootSessionId: "root-session",
    parentRecordId: undefined,
    depth: 0,
    agent: "worker",
    task: "legacy task",
    slug: "legacy",
    mode: "background",
    startedAt,
    chatMode: false,
    model: "test/model",
    worktree: false,
  });
}

function makeExecutionRecord(id: string, overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const r = createRecord(id, {
    agent: "worker",
    model: "test/model",
    mode: "background",
    task: "compat task",
    slug: "compat",
    startedAt: 1000,
    rootSessionId: "root-session",
    chatMode: false,
    controller: new AbortController(),
  });
  Object.assign(r, overrides);
  return r;
}

describe("[U8/S8] 旧格式磁盘组只读兼容——恒 idle + stopReason 桥接，不炸不丢", () => {
  let tmpDir: string;
  let sessionsDir: string;
  let manifestDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "core-legacy-compat-"));
    sessionsDir = getSubagentSessionDir(tmpDir, tmpDir);
    manifestDir = getSubagentRecordsDir(tmpDir, tmpDir);
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(manifestDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("旧 `.finalized`（内容 = reason 原文）→ idle + stopReason=reason + closedReason 桥接位", () => {
    const file = path.join(sessionsDir, "20260101T000000_a.jsonl");
    writeLegacySessionJsonl(file, { id: "sa-old-fin", task: "old fin task", startedAt: 1000, rootSessionId: "root-session" });
    writeLegacyBinding(file, "sa-old-fin", 1000);
    // 旧格式 finalized sidecar：裸内容 = 关闭原因（state-marker LEGACY_FINALIZED_EXT 读侧）
    fs.writeFileSync(`${file}.finalized`, "gc", "utf-8");

    const store = new RecordStore(sessionsDir);
    const rec = store.collectRecords(10, "all").find((r) => r.id === "sa-old-fin");
    expect(rec).toBeDefined();
    expect(rec?.status).toBe("idle");
    expect(rec?.stopReason).toBe("gc");
    expect(rec?.closedReason).toBe("gc");
    expect(rec?.agent).toBe("worker");
    expect(rec?.task).toBe("old fin task");
    store.dispose();
  });

  it("旧 `.finalized` 空文件（v8.5 前形态）→ idle + stopReason=disconnected", () => {
    const file = path.join(sessionsDir, "20260101T000001_b.jsonl");
    writeLegacySessionJsonl(file, { id: "sa-old-empty", task: "old empty task", startedAt: 1000, rootSessionId: "root-session" });
    fs.writeFileSync(`${file}.finalized`, "", "utf-8");

    const store = new RecordStore(sessionsDir);
    const rec = store.collectRecords(10, "all").find((r) => r.id === "sa-old-empty");
    expect(rec?.status).toBe("idle");
    expect(rec?.stopReason).toBe("disconnected");
    expect(rec?.closedReason).toBe("disconnected");
    store.dispose();
  });

  it("旧 `.cancelled` tombstone → idle + stopReason=interrupted + closedReason=cancelled", () => {
    const file = path.join(sessionsDir, "20260101T000002_c.jsonl");
    writeLegacySessionJsonl(file, { id: "sa-old-cx", task: "old cx task", startedAt: 1000, rootSessionId: "root-session" });
    writeLegacyBinding(file, "sa-old-cx", 1000);
    // 旧格式 cancelled tombstone：JSON {status:"cancelled", endedAt}
    fs.writeFileSync(`${file}.cancelled`, JSON.stringify({ status: "cancelled", endedAt: 2500 }), "utf-8");

    const store = new RecordStore(sessionsDir);
    const rec = store.collectRecords(10, "all").find((r) => r.id === "sa-old-cx");
    expect(rec?.status).toBe("idle");
    expect(rec?.stopReason).toBe("interrupted");
    expect(rec?.closedReason).toBe("cancelled");
    expect(rec?.endedAt).toBe(2500);
    store.dispose();
  });

  it("旧 manifest（无 executionStatus）三值域 closed/completed/cancelled → manifest 源投影 idle + closedReason 保留", () => {
    // 磁盘组缺员（无子 session 文件）→ manifest 源兜底可见（mergedRecords 1.5）
    const writeOld = (id: string, status: string, closedReason?: string): void => {
      fs.writeFileSync(
        path.join(manifestDir, `${id}.json`),
        JSON.stringify({
          id,
          rootSessionId: "root-session",
          agentName: "worker",
          status,
          ...(closedReason !== undefined ? { closedReason } : {}),
          createdAt: 1000,
          completedAt: 2000,
          task: "old manifest task",
          slug: "oldman",
        }),
        "utf-8",
      );
    };
    writeOld("sa-om-closed", "closed", "user-close");
    writeOld("sa-om-completed", "completed");
    writeOld("sa-om-cancelled", "cancelled");

    const store = new RecordStore(sessionsDir, new ManifestStore(manifestDir));
    const all = store.collectRecords(20, "all");
    for (const id of ["sa-om-closed", "sa-om-completed", "sa-om-cancelled"]) {
      const rec = all.find((r) => r.id === id);
      expect(rec, id).toBeDefined();
      expect(rec?.status, id).toBe("idle"); // 旧终态三值统一 idle（mapManifestStatus）
      expect(rec?.agent, id).toBe("worker");
      expect(rec?.task, id).toBe("old manifest task");
    }
    expect(all.find((r) => r.id === "sa-om-closed")?.closedReason).toBe("user-close");
    store.dispose();
  });
});

describe("[U8/U5-D10] manifest 双写映射 + 双写回读 + engine 域下行", () => {
  let tmpDir: string;
  let sessionsDir: string;
  let manifestDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "core-manifest-mapping-"));
    sessionsDir = getSubagentSessionDir(tmpDir, tmpDir);
    manifestDir = getSubagentRecordsDir(tmpDir, tmpDir);
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(manifestDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  const readManifest = (id: string): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(path.join(manifestDir, `${id}.json`), "utf-8")) as Record<string, unknown>;

  it("markSettled 轮间 idle（无 closedReason，非 archived）→ legacy status=running + executionStatus=idle", () => {
    const store = new RecordStore(sessionsDir, undefined, undefined, manifestDir);
    const record = makeExecutionRecord("sa-settle");
    store.register(record);
    store.markSettled(record, "gc");

    const manifest = readManifest("sa-settle");
    expect(manifest.status).toBe("running"); // §3.2.8 活跃成员下行（可续聊 = 活跃）
    expect(manifest.executionStatus).toBe("idle");
    expect(manifest.closedReason).toBeUndefined();
    expect(manifest.intent).toBeUndefined();
    store.dispose();
  });

  it("markArchived（archived intent）→ legacy status=closed + intent 下行 + executionStatus=idle", () => {
    const store = new RecordStore(sessionsDir, undefined, undefined, manifestDir);
    const record = makeExecutionRecord("sa-arch");
    store.register(record);
    store.markSettled(record, "gc");
    store.markArchived(record);

    const manifest = readManifest("sa-arch");
    // U5-D10：archived → 旧 closed（「已收起」在旧消费者语义里 = 结束）
    expect(manifest.status).toBe("closed");
    expect(manifest.intent).toBe("archived");
    expect(manifest.executionStatus).toBe("idle");
    store.dispose();
  });

  it("桥接终态（idle ∧ closedReason=cancelled）→ legacy status=cancelled（旧语义保留）", async () => {
    const store = new RecordStore(sessionsDir, undefined, undefined, manifestDir);
    // markBatchFinalized 走 batchManifestRecord → legacyManifestStatusFields（同一派生单点）
    await store.markBatchFinalized([
      {
        id: "sa-bridge",
        agent: "worker",
        task: "bridge task",
        slug: "bridge",
        status: "idle",
        closedReason: "cancelled",
        stopReason: "interrupted",
        mode: "background",
        startedAt: 1000,
        rootSessionId: "root-session",
        parentRecordId: undefined,
        depth: 0,
        endedAt: 2000,
        turns: 1,
        totalTokens: 10,
        model: "test/model",
        thinkingLevel: undefined,
        eventLog: [],
        displayItems: [],
        result: undefined,
        error: undefined,
        sessionFile: undefined,
      },
    ]);

    const manifest = readManifest("sa-bridge");
    expect(manifest.status).toBe("cancelled");
    expect(manifest.executionStatus).toBe("idle");
    store.dispose();
  });

  it("双写回读：settle 产物（legacy running + executionStatus idle）manifest 源读回 idle 非 running", () => {
    // 写侧：settle（legacy running 下行 + 权威词 idle）
    const writer = new RecordStore(sessionsDir, undefined, undefined, manifestDir);
    const record = makeExecutionRecord("sa-roundtrip");
    writer.register(record);
    writer.markSettled(record, "gc");
    writer.dispose();
    expect(readManifest("sa-roundtrip").status).toBe("running");

    // 读侧：新进程（manifest 源兜底——磁盘组无子 session 文件）
    const reader = new RecordStore(sessionsDir, new ManifestStore(manifestDir));
    const rec = reader.collectRecords(10, "all").find((r) => r.id === "sa-roundtrip");
    expect(rec?.status).toBe("idle"); // executionStatus 优先（双写回读权威词）
    expect(rec?.closedReason).toBeUndefined();
    reader.dispose();
  });

  it("双写回读：archived manifest 源读回 idle + intent=archived（归档意图跨重启不丢）", () => {
    const writer = new RecordStore(sessionsDir, undefined, undefined, manifestDir);
    const record = makeExecutionRecord("sa-arch-rt");
    writer.register(record);
    writer.markSettled(record, "gc");
    writer.markArchived(record);
    writer.dispose();

    const reader = new RecordStore(sessionsDir, new ManifestStore(manifestDir));
    const rec = reader.collectRecords(10, "all").find((r) => r.id === "sa-arch-rt");
    expect(rec?.status).toBe("idle");
    expect(rec?.intent).toBe("archived");
    reader.dispose();
  });

  it("[B-restart] engine/engineHandle 域随 manifest 下行 + manifest 源回读（zcode 锚兜底）", () => {
    // zcode 锚基底目录真实存在（markSettled 的 binding 快照写点——U7 锚键 sidecar）
    fs.mkdirSync(path.join(tmpDir, "session-db"), { recursive: true });
    const engineHandle = {
      sessionRef: { sessionId: "z-sess-1", dbPath: path.join(tmpDir, "session-db", "db.sqlite") },
      poolKey: "shared",
    };
    const writer = new RecordStore(sessionsDir, undefined, undefined, manifestDir);
    const record = makeExecutionRecord("sa-zc", {
      engine: "zcode",
      engineHandle,
    });
    writer.register(record);
    writer.markSettled(record, "gc");
    writer.dispose();

    // 写侧下行：manifest 携带 engine 域（旧 session-reader 未知字段跳过，无破坏）
    const manifest = readManifest("sa-zc");
    expect(manifest.engine).toBe("zcode");
    expect(manifest.engineHandle).toEqual(engineHandle);

    // 读侧回读：manifest 源投影恢复引擎身份与锚（重启可见性兜底）
    const reader = new RecordStore(sessionsDir, new ManifestStore(manifestDir));
    const rec = reader.collectRecords(10, "all").find((r) => r.id === "sa-zc");
    expect(rec?.engine).toBe("zcode");
    expect(rec?.engineHandle).toEqual(engineHandle);
    reader.dispose();
  });

  it("entry intent 透传：archived 末条 entry 重建（rebuildEntryRecord）→ manifest 补建投影 closed", () => {
    // 离线形态：主 session 末条 subagent-record entry 携带 intent=archived（close 落盘），
    // manifest 缺失 → rebuildIndexes 惰性补建按 intent 派生 legacy closed。
    const mainSessionFile = path.join(tmpDir, "main-session.jsonl");
    const entry = JSON.stringify({
      type: "custom",
      id: "seed-1",
      parentId: null,
      timestamp: new Date(1000).toISOString(),
      customType: "subagent-record",
      data: {
        v: 1,
        id: "sa-entry-arch",
        agent: "worker",
        task: "entry arch task",
        slug: "entryarch",
        status: "idle",
        stopReason: "gc",
        intent: "archived",
        mode: "background",
        startedAt: 1000,
        rootSessionId: "root-session",
        parentRecordId: undefined,
        depth: 0,
        endedAt: 2000,
        turns: 1,
        totalTokens: 10,
        model: "test/model",
        thinkingLevel: undefined,
        eventLog: [],
        displayItems: [],
        engine: "zcode",
      },
    });
    fs.writeFileSync(mainSessionFile, `${entry}\n`, "utf-8");

    // 锚定 entry 源（recoverEntryOnlyOrphans 的 mainSessionFile 记忆点；末条 idle 非
    // running → 不触发纠偏 append），随后 collectRecords 经 mergedRecords 1.7
    //（zcode entry 源）→ 惰性 manifest 补建。
    const store = new RecordStore(sessionsDir, undefined, undefined, manifestDir);
    store.recoverEntryOnlyOrphans(mainSessionFile, "root-session");
    const visible = store.collectRecords(10, "all").find((r) => r.id === "sa-entry-arch");
    expect(visible?.engine).toBe("zcode");
    expect(visible?.intent).toBe("archived");

    const manifest = readManifest("sa-entry-arch");
    expect(manifest.status).toBe("closed"); // intent=archived 下行（U5-D10）
    expect(manifest.intent).toBe("archived");
    expect(manifest.executionStatus).toBe("idle");
    expect(manifest.engine).toBe("zcode"); // entry 重建的 engine 域随补建下行
    store.dispose();
  });
});
