// src/execution/__tests__/rebuild-indexes.test.ts
//
// [U4c / G1+G2+G4-S5] 缓存降级三锚点：
//   - S5① 手动删 manifest/sessions-index → 重建照常无错误静默吞（boot 全量通道
//     rebuildIndexes + 查询面惰性通道 mergedRecords 双通道各自可独立触发）；
//   - 失败降级：无 identity 的损坏/异构文件不在扫描集 → 不重建不抛（sessions-index
//     「损坏静默回退全扫」同款先例）；幸存 manifest 不覆写（幂等补缺）；
//   - G2 词汇双写：四 manifest 写面（markFinalized/markCancelled/markBatchFinalized/
//     markIdleArchived）旧 status 三态投影 + executionStatus/closedReason 并存。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRecord } from "../execution-record.ts";
import { RecordStore } from "../record-store.ts";
import { INDEX_FILENAME } from "../sessions-index.ts";
import { writeCancelledState, writeFinalizedState } from "../state-marker.ts";
import type { ExecutionRecord, SubagentRecord } from "../types.ts";

/** 最小合法子 session 文件（session header + identity custom entry + assistant msg）。 */
function writeSessionJsonl(
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
    slug: "rebuild",
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
  const assistantMsg = JSON.stringify({
    type: "message",
    id: "msg-1",
    parentId: "id-1",
    timestamp: new Date(identity.startedAt + 1000).toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: "result text" }],
      usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { total: 0 } },
      stopReason: "stop",
      timestamp: identity.startedAt + 1000,
    },
  });
  fs.writeFileSync(filePath, `${header}\n${identityEntry}\n${assistantMsg}\n`, "utf-8");
}

function makeRecord(id: string, overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const r = createRecord(id, {
    agent: "worker",
    model: "test/model",
    mode: "background",
    task: "rebuild task",
    slug: "rebuild",
    startedAt: 1000,
    rootSessionId: "root-session",
    chatMode: false,
    controller: new AbortController(),
  });
  Object.assign(r, overrides);
  return r;
}

/** markBatchFinalized 入参的最小 SubagentRecord。 */
function makeSubagentRecord(id: string, sessionFile?: string): SubagentRecord {
  return {
    id,
    agent: "worker",
    task: "batch task",
    slug: "batch",
    status: "running",
    mode: "background",
    startedAt: 1000,
    rootSessionId: "root-session",
    parentRecordId: undefined,
    depth: 0,
    endedAt: undefined,
    turns: 0,
    totalTokens: 0,
    model: "test/model",
    thinkingLevel: undefined,
    eventLog: [],
    displayItems: [],
    result: undefined,
    error: undefined,
    sessionFile,
  };
}

describe("[U4c/G1] rebuildIndexes 双通道 + S5 缓存可丢锚点", () => {
  let rootDir: string;
  let sessionsDir: string;
  let recordsDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rebuild-indexes-"));
    sessionsDir = path.join(rootDir, "sessions");
    recordsDir = path.join(rootDir, "records");
    fs.mkdirSync(sessionsDir);
    fs.mkdirSync(recordsDir);
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("S5①: 手动删 manifest/sessions-index → boot 全量重建照常，无错误静默吞", async () => {
    const fileA = path.join(sessionsDir, "20260912T000000_a.jsonl");
    const fileB = path.join(sessionsDir, "20260912T000001_b.jsonl");
    writeSessionJsonl(fileA, { id: "sa-closed", task: "closed task", startedAt: 1000, rootSessionId: "root-session" });
    writeSessionJsonl(fileB, { id: "sa-running", task: "running task", startedAt: 2000, rootSessionId: "root-session" });
    // 权威终态位（重建源 = `.state` 优先）
    writeFinalizedState(fileA, "gc");
    // 损坏/异构文件（无 identity 无绑定）：不在扫描集，重建面必须静默跳过
    fs.writeFileSync(path.join(sessionsDir, "junk.jsonl"), "not a session at all\n", "utf-8");
    // 「缓存曾存在」的现场：manifest + sessions-index 各留一份后人为删除（S5 场景步骤）
    fs.writeFileSync(path.join(recordsDir, "sa-closed.json"), "{}", "utf-8");
    fs.writeFileSync(path.join(rootDir, INDEX_FILENAME), "{corrupted", "utf-8");
    fs.rmSync(path.join(recordsDir, "sa-closed.json"));
    fs.rmSync(path.join(rootDir, INDEX_FILENAME));

    const store = new RecordStore(sessionsDir, undefined, undefined, recordsDir);
    let rebuilt = -1;
    expect(() => {
      rebuilt = store.rebuildIndexes();
    }).not.toThrow();
    // 幂等补缺面 = 扫描集内全部 record（closed + running 两种形态都补）
    expect(rebuilt).toBe(2);

    // manifest 重建产物：词汇双写（旧三态 + executionStatus）+ identity 富字段
    const closed = JSON.parse(fs.readFileSync(path.join(recordsDir, "sa-closed.json"), "utf-8")) as Record<string, unknown>;
    expect(closed.status).toBe("closed");
    expect(closed.executionStatus).toBe("closed");
    expect(closed.closedReason).toBe("gc");
    expect(closed.agentName).toBe("worker");
    expect(closed.task).toBe("closed task");
    expect(closed.sessionFile).toBe(fileA);
    const running = JSON.parse(fs.readFileSync(path.join(recordsDir, "sa-running.json"), "utf-8")) as Record<string, unknown>;
    expect(running.status).toBe("running");
    expect(running.executionStatus).toBe("running");
    expect(running.completedAt).toBeUndefined();

    // junk 文件不产生 manifest（扫描集外静默跳过）
    expect(fs.readdirSync(recordsDir).sort()).toEqual(["sa-closed.json", "sa-running.json"]);

    // sessions-index 经首扫自愈重写（fire-and-forget，等待落盘）
    await vi.waitFor(() => expect(fs.existsSync(path.join(rootDir, INDEX_FILENAME))).toBe(true));
    const index = JSON.parse(fs.readFileSync(path.join(rootDir, INDEX_FILENAME), "utf-8")) as {
      version: number;
      entries: Record<string, unknown>;
    };
    expect(index.version).toBe(1);
    expect(Object.keys(index.entries)).toContain("20260912T000000_a.jsonl");
    expect(Object.keys(index.entries)).toContain("20260912T000001_b.jsonl");

    // 列表/详情照常（S5 通过标准）
    const ids = store.collectRecords(100).map((r) => r.id);
    expect(ids).toContain("sa-closed");
    expect(ids).toContain("sa-running");
    store.dispose();
  });

  it("幸存 manifest 不覆写（重建是补缺不是刷新——防用尽力数据降级幸存快照）", () => {
    const fileA = path.join(sessionsDir, "20260912T000002_survivor.jsonl");
    writeSessionJsonl(fileA, { id: "sa-survivor", task: "disk task", startedAt: 1000, rootSessionId: "root-session" });
    // 幸存 manifest 的 task 比 disk 重建源「新鲜」（终态写点真实值）
    fs.writeFileSync(
      path.join(recordsDir, "sa-survivor.json"),
      JSON.stringify({ id: "sa-survivor", rootSessionId: "root-session", agentName: "worker", status: "closed", task: "survivor task", createdAt: 1000 }),
      "utf-8",
    );

    const store = new RecordStore(sessionsDir, undefined, undefined, recordsDir);
    expect(store.rebuildIndexes()).toBe(0);
    const manifest = JSON.parse(fs.readFileSync(path.join(recordsDir, "sa-survivor.json"), "utf-8")) as Record<string, unknown>;
    expect(manifest.task).toBe("survivor task");
    store.dispose();
  });

  it("惰性通道: 查询面（collectRecords）补建缺员 manifest；在途 record 不建（创建时不写契约保持）", () => {
    const fileA = path.join(sessionsDir, "20260912T000003_lazy.jsonl");
    const fileLive = path.join(sessionsDir, "20260912T000004_live.jsonl");
    writeSessionJsonl(fileA, { id: "sa-lazy", task: "lazy task", startedAt: 1000, rootSessionId: "root-session" });
    writeSessionJsonl(fileLive, { id: "sa-live", task: "live task", startedAt: 2000, rootSessionId: "root-session" });

    const store = new RecordStore(sessionsDir, undefined, undefined, recordsDir);
    // 在途 record（内存持有）——终态写点会落 manifest，惰性通道不得提前建
    store.register(makeRecord("sa-live", { sessionFile: fileLive }));

    const ids = store.collectRecords(100).map((r) => r.id);
    expect(ids).toContain("sa-lazy");
    expect(ids).toContain("sa-live");

    // 惰性补建只发生在外源 record
    expect(fs.existsSync(path.join(recordsDir, "sa-lazy.json"))).toBe(true);
    expect(fs.existsSync(path.join(recordsDir, "sa-live.json"))).toBe(false);
    store.dispose();
  });

  it("每 id 每进程一次守卫 + revive 复位（防高频查询放大磁盘写）", () => {
    const fileA = path.join(sessionsDir, "20260912T000005_guard.jsonl");
    writeSessionJsonl(fileA, { id: "sa-guard", task: "guard task", startedAt: 1000, rootSessionId: "root-session" });

    const store = new RecordStore(sessionsDir, undefined, undefined, recordsDir);
    store.collectRecords(100);
    expect(fs.existsSync(path.join(recordsDir, "sa-guard.json"))).toBe(true);

    // 再次删除 + 查询：本进程已尝试过，不重复补写（boot 全量轮/下次进程承接）
    fs.rmSync(path.join(recordsDir, "sa-guard.json"));
    store.collectRecords(100);
    expect(fs.existsSync(path.join(recordsDir, "sa-guard.json"))).toBe(false);

    // /new /resume 复活（revive）复位守卫——「重开重判」语义
    store.revive();
    store.collectRecords(100);
    expect(fs.existsSync(path.join(recordsDir, "sa-guard.json"))).toBe(true);
    store.dispose();
  });
});

describe("[U4c/G2] manifest 词汇双写——四写面旧三态投影 + executionStatus/closedReason 并存", () => {
  let rootDir: string;
  let sessionsDir: string;
  let recordsDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rebuild-dualwrite-"));
    sessionsDir = path.join(rootDir, "sessions");
    recordsDir = path.join(rootDir, "records");
    fs.mkdirSync(sessionsDir);
    fs.mkdirSync(recordsDir);
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  function readManifest(id: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(recordsDir, `${id}.json`), "utf-8")) as Record<string, unknown>;
  }

  it("markFinalized：status closed（旧三态）+ executionStatus closed + closedReason 随写", () => {
    const store = new RecordStore(sessionsDir, undefined, undefined, recordsDir);
    const sessionFile = path.join(sessionsDir, "20260912T000006_fin.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    const record = makeRecord("sa-fin", { sessionFile, status: "closed", closedReason: "parent-shutdown", endedAt: 2000 });

    expect(store.markFinalized(record, "parent-shutdown")).toBe(true);
    const manifest = readManifest("sa-fin");
    expect(manifest.status).toBe("closed");
    expect(manifest.executionStatus).toBe("closed");
    expect(manifest.closedReason).toBe("parent-shutdown");
    store.dispose();
  });

  it("markCancelled：终态投影同 markFinalized（双写字段齐）", () => {
    const store = new RecordStore(sessionsDir, undefined, undefined, recordsDir);
    const sessionFile = path.join(sessionsDir, "20260912T000007_cx.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    const record = makeRecord("sa-cx2", { sessionFile, endedAt: 2000 });

    expect(store.markCancelled(record)).toBe(true);
    const manifest = readManifest("sa-cx2");
    expect(manifest.status).toBe("closed");
    expect(manifest.executionStatus).toBe("closed");
    store.dispose();
  });

  it("markIdleArchived：归档点补写 running 投影（非终态化语义——磁盘仍 running 可接管）", () => {
    const store = new RecordStore(sessionsDir, undefined, undefined, recordsDir);
    const sessionFile = path.join(sessionsDir, "20260912T000008_idle.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    const record = makeRecord("sa-idle", { sessionFile, resumable: true });

    store.markIdleArchived(record);
    const manifest = readManifest("sa-idle");
    expect(manifest.status).toBe("running");
    expect(manifest.executionStatus).toBe("running");
    expect(manifest.completedAt).toBeUndefined();
    // 非终态化：不写 .state（归档 ≠ 放弃可重连性）
    expect(fs.existsSync(`${sessionFile}.state`)).toBe(false);
    store.dispose();
  });

  it("markBatchFinalized：批成员 running 投影双写（barrier 面词汇一致）", async () => {
    const store = new RecordStore(sessionsDir, undefined, undefined, recordsDir);
    const sessionFile = path.join(sessionsDir, "20260912T000009_batch.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");

    await store.markBatchFinalized([makeSubagentRecord("sa-batch", sessionFile)]);
    const manifest = readManifest("sa-batch");
    expect(manifest.status).toBe("running");
    expect(manifest.executionStatus).toBe("running");
    expect(manifest.closedReason).toBeUndefined();
    store.dispose();
  });

  it("重建投影的旧三态 cancelled 派生：`.state` cancelled → status cancelled + closedReason cancelled", () => {
    // markCancelled 终态位的磁盘重建形态（buildRecord 分支 1）：重建 manifest 的旧
    // 词汇须能区分 cancelled（session-reader 投影消费三态）。
    const fileA = path.join(sessionsDir, "20260912T000010_cxl.jsonl");
    writeSessionJsonl(fileA, { id: "sa-cxl", task: "cancelled task", startedAt: 1000, rootSessionId: "root-session" });
    writeCancelledState(fileA, 3000);

    const store = new RecordStore(sessionsDir, undefined, undefined, recordsDir);
    store.rebuildIndexes();
    const manifest = readManifest("sa-cxl");
    expect(manifest.status).toBe("cancelled");
    expect(manifest.executionStatus).toBe("closed");
    expect(manifest.closedReason).toBe("cancelled");
    store.dispose();
  });
});
