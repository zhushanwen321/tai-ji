// src/execution/__tests__/permanent-session-legacy-compat.test.ts
//
// [U8 / S8] 旧数据只读兼容（设计 §4 S8 行 + §3.2.4 双向兼容 + §3.2.8 session-reader
// 前向兼容铁律）：
//   - 旧格式磁盘组（旧 `.finalized`/`.cancelled` sidecar + v1 binding + 旧 manifest
//     值域 closed/completed/failed/cancelled，无 executionStatus/intent）经新代码读侧
//     投影：恒 idle + stopReason 桥接（finalized→reason / cancelled→interrupted），
//     不炸、不丢 identity；
//   - manifest 双写映射：markSettled 轮间 idle / markSettledOut 收口落账 → legacy
//     running（[u-arch / §3.4 方案 A] 收起概念删除，可续聊 record = 活跃成员）；
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

describe("[U8] manifest 双写映射 + 双写回读 + engine 域下行", () => {
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

  it("markSettled 轮间 idle（无 closedReason）→ legacy status=running + executionStatus=idle", () => {
    const store = new RecordStore(sessionsDir, undefined, undefined, manifestDir);
    const record = makeExecutionRecord("sa-settle");
    store.register(record);
    store.markSettled(record, "gc");

    const manifest = readManifest("sa-settle");
    expect(manifest.status).toBe("running"); // §3.2.8 活跃成员下行（可续聊 = 活跃）
    expect(manifest.executionStatus).toBe("idle");
    expect(manifest.closedReason).toBeUndefined();
    expect(manifest.intent).toBeUndefined(); // [u-arch] intent 停写（概念删除）
    store.dispose();
  });

  it("markSettledOut 收口落账 → legacy status=running + executionStatus=idle（[u-arch / §3.4 方案 A] 收起概念删除）", () => {
    const store = new RecordStore(sessionsDir, undefined, undefined, manifestDir);
    const record = makeExecutionRecord("sa-arch");
    store.register(record);
    store.markSettled(record, "gc");
    store.markSettledOut(record);

    const manifest = readManifest("sa-arch");
    // [u-arch / §3.4 方案 A] close 收口落账 record 投 running——可续聊 record =
    // 旧 reader 视角的活跃成员（原「收起位 → closed」下行分支随概念删除退役）。
    expect(manifest.status).toBe("running");
    expect(manifest.executionStatus).toBe("idle");
    expect(manifest.intent).toBeUndefined(); // intent 停写
    store.dispose();
  });

  it("[collect 退役] 存量批成员 manifest（桥接终态 cancelled 词汇）读侧容忍：投影 idle + closedReason 保留", () => {
    // 批写侧（markBatchFinalized → batchManifestRecord → legacyManifestStatusFields
    // 派生单点）已删。构造磁盘遗留形态（批时代产物词汇：legacy status=cancelled +
    // executionStatus=idle + closedReason/intent 缺省）——旧 session 文件必须可读。
    fs.writeFileSync(
      path.join(manifestDir, "sa-bridge.json"),
      JSON.stringify({
        id: "sa-bridge",
        rootSessionId: "root-session",
        agentName: "worker",
        status: "cancelled",
        executionStatus: "idle",
        closedReason: "cancelled",
        createdAt: 1000,
        completedAt: 2000,
        task: "bridge task",
        slug: "bridge",
      }),
      "utf-8",
    );

    const store = new RecordStore(sessionsDir, new ManifestStore(manifestDir));
    const rec = store.collectRecords(10, "all").find((r) => r.id === "sa-bridge");
    expect(rec).toBeDefined();
    // 旧 cancelled 词汇读侧投影：idle（两态收敛）+ manifest closedReason 透传保留
    expect(rec?.status).toBe("idle");
    expect(rec?.closedReason).toBe("cancelled");
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

  it("双写回读：markSettledOut 收口落账产物 manifest 源读回 idle（intent 停写停读）", () => {
    const writer = new RecordStore(sessionsDir, undefined, undefined, manifestDir);
    const record = makeExecutionRecord("sa-arch-rt");
    writer.register(record);
    writer.markSettled(record, "gc");
    writer.markSettledOut(record);
    writer.dispose();

    const reader = new RecordStore(sessionsDir, new ManifestStore(manifestDir));
    const rec = reader.collectRecords(10, "all").find((r) => r.id === "sa-arch-rt");
    expect(rec?.status).toBe("idle");
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

  it("旧 entry 残留 intent 键被忽略（[u-arch] 停读证明）→ manifest 补建投 running、engine 域仍下行", () => {
    // 离线形态：主 session 末条 subagent-record entry 携带旧数据残留 intent 键
    //（收起概念删除前 close 落盘形态），manifest 缺失 → rebuildIndexes 惰性补建。
    // [u-arch] 读侧停读：残留键被忽略（与 chatMode 消亡同款先例），补建不再按
    // intent 派生 legacy closed——按 §3.4 方案 A 判定投 running。
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

    const manifest = readManifest("sa-entry-arch");
    expect(manifest.status).toBe("running"); // 残留 intent 键不再派生 closed（§3.4 方案 A）
    expect(manifest.intent).toBeUndefined(); // 补建停写 intent
    expect(manifest.executionStatus).toBe("idle");
    expect(manifest.engine).toBe("zcode"); // entry 重建的 engine 域随补建下行
    store.dispose();
  });
});
