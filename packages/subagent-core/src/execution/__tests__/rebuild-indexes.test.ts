// src/execution/__tests__/rebuild-indexes.test.ts
//
// [U4c / G1+G2+G4-S5] 缓存降级三锚点：
//   - S5① 手动删 manifest/sessions-index → 重建照常无错误静默吞（boot 全量通道
//     rebuildIndexes + 查询面惰性通道 mergedRecords 双通道各自可独立触发）；
//   - 失败降级：无 identity 的损坏/异构文件不在扫描集 → 不重建不抛（sessions-index
//     「损坏静默回退全扫」同款先例）；幸存 manifest 不覆写（幂等补缺）；
//   - G2 词汇双写：manifest 写面（markFinalized/markCancelled/markSettledOut）
//     旧 status 三态投影 + executionStatus/closedReason 并存。
//     [collect 退役] markBatchFinalized 写面已删，批成员 manifest 改为存量读侧容忍用例。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRecord } from "../persistence/execution-record.ts";
import { RecordStore } from "../persistence/record-store.ts";
import { ManifestStore } from "../persistence/manifest-store.ts";
import { INDEX_FILENAME, INDEX_VERSION } from "../persistence/sessions-index.ts";
import type { ExecutionRecord } from "../domain/record-model.ts";
import type { SubagentRecord } from "../assembly/types.ts";

// [teardown 竞态修复] 被测链（rebuild/store/manifest 降级路径）的 logger 输出经
// console 落 stderr，满并行下文件结束与 worker rpc 关闭竞态会触发 vitest
// EnvironmentTeardownError（onUserConsoleLog pending）→ run 退出码 1。本文件对
// logger 零断言依赖，mock 静默（对齐 record-store.test.ts 同款先例）。
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({
  getLogger: () => loggerMock,
}));

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
    controller: new AbortController(),
  });
  Object.assign(r, overrides);
  return r;
}

/** 存量批成员 record 形态（[collect 退役] 批写侧已删，作存量模拟种子）。 */
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
    // 损坏/异构文件（无 identity 无绑定）：不在扫描集，重建面必须静默跳过
    fs.writeFileSync(path.join(sessionsDir, "junk.jsonl"), "not a session at all\n", "utf-8");
    // 「缓存曾存在」的现场：manifest + sessions-index 各留一份后人为删除（S5 场景步骤）
    fs.writeFileSync(path.join(recordsDir, "sa-closed.json"), "{}", "utf-8");
    fs.writeFileSync(path.join(rootDir, INDEX_FILENAME), "{corrupted", "utf-8");
    fs.rmSync(path.join(recordsDir, "sa-closed.json"));
    fs.rmSync(path.join(rootDir, INDEX_FILENAME));

    const store = new RecordStore(() => sessionsDir, undefined, undefined, () => recordsDir);
    let rebuilt = -1;
    expect(() => {
      rebuilt = store.rebuildIndexes();
    }).not.toThrow();
    // 幂等补缺面 = 扫描集内全部 record（closed + running 两种形态都补）
    expect(rebuilt).toBe(2);

    // manifest 重建产物：词汇双写（旧三态 + executionStatus）+ identity 富字段。
    // 终态投影（settled 帧 → closed）由事件驱动的用例覆盖；本用例的被测对象是
    // 「删掉 manifest/索引后 boot 仍能全量重建」这一机制本身。
    const first = JSON.parse(fs.readFileSync(path.join(recordsDir, "sa-closed.json"), "utf-8")) as Record<string, unknown>;
    expect(first.status).toBe("running");
    expect(first.executionStatus).toBe("idle");
    expect(first.agentName).toBe("worker");
    expect(first.task).toBe("closed task");
    expect(first.sessionFile).toBe(fileA);
    const running = JSON.parse(fs.readFileSync(path.join(recordsDir, "sa-running.json"), "utf-8")) as Record<string, unknown>;
    // [U3 / §3.2.4] 磁盘重建恒 idle（无 sidecar → interrupted-by-restart）：权威词汇
    // executionStatus=idle；legacy status 走 §3.2.8 下行映射（idle ∧ 无 closedReason →
    // "running"——session-reader 视角的活跃成员）
    expect(running.status).toBe("running");
    expect(running.executionStatus).toBe("idle");
    expect(running.completedAt).toBeUndefined();

    // junk 文件不产生 manifest（扫描集外静默跳过）
    expect(fs.readdirSync(recordsDir).sort()).toEqual(["sa-closed.json", "sa-running.json"]);

    // sessions-index 经首扫自愈重写（fire-and-forget，等待落盘）
    await vi.waitFor(() => expect(fs.existsSync(path.join(rootDir, INDEX_FILENAME))).toBe(true), { interval: 1 });
    const index = JSON.parse(fs.readFileSync(path.join(rootDir, INDEX_FILENAME), "utf-8")) as {
      version: number;
      entries: Record<string, unknown>;
    };
    expect(index.version).toBe(INDEX_VERSION);
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

    const store = new RecordStore(() => sessionsDir, undefined, undefined, () => recordsDir);
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

    const store = new RecordStore(() => sessionsDir, undefined, undefined, () => recordsDir);
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

    const store = new RecordStore(() => sessionsDir, undefined, undefined, () => recordsDir);
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

describe("[crash 回归] 索引命中即崩：v3+ 收条统计字段（number 型 turns）泄漏进身份基底", () => {
  let rootDir: string;
  let sessionsDir: string;
  let recordsDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rebuild-index-crash-"));
    sessionsDir = path.join(rootDir, "sessions");
    recordsDir = path.join(rootDir, "records");
    fs.mkdirSync(sessionsDir);
    fs.mkdirSync(recordsDir);
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("索引条目带 receipt+turns+totalTokens 且无 .record-binding → 扫描不抛，统计按索引自承值投影", () => {
    const id = "sa-idx-crash";
    const basename = "20260912T000010_idxcrash.jsonl";
    const file = path.join(sessionsDir, basename);
    writeSessionJsonl(file, { id, task: "index hit task", startedAt: 1000, rootSessionId: "root-session" });
    // 事件文件（首行头行 + record-settled 终态行；stopReason 取引擎停因词表值 "stop"）。
    // 索引命中腿只 stat 事件文件比戳（eventsMtimeMs/eventsSize），不读内容。
    const eventsPath = path.join(recordsDir, `${id}.events`);
    fs.writeFileSync(
      eventsPath,
      [
        JSON.stringify({ type: "record-events", id }),
        JSON.stringify({ type: "record-settled", seq: 1, ts: 1500, stopReason: "stop", outcome: "completed", endedAt: 1500, turns: 3, totalTokens: 120 }),
      ].join("\n") + "\n",
      "utf-8",
    );
    // 手写 v4 索引：正条目带收条 + 统计域，不写 .record-binding sidecar（默认即无）。
    // 四维戳（jsonl mtimeMs/size + events mtimeMs/size）写完数据文件后实测回填。
    const jsonlStat = fs.statSync(file);
    const eventsStat = fs.statSync(eventsPath);
    fs.writeFileSync(
      path.join(rootDir, INDEX_FILENAME),
      JSON.stringify({
        version: INDEX_VERSION,
        pid: process.pid,
        entries: {
          [basename]: {
            mtimeMs: jsonlStat.mtimeMs,
            size: jsonlStat.size,
            id,
            agent: "worker",
            mode: "background",
            task: "index hit task",
            slug: "rebuild",
            startedAt: 1000,
            rootSessionId: "root-session",
            parentRecordId: undefined,
            depth: 0,
            model: "test/model",
            eventsMtimeMs: eventsStat.mtimeMs,
            eventsSize: eventsStat.size,
            receipt: { stopReason: "stop", endedAt: 1500 },
            turns: 3,
            totalTokens: 120,
          },
        },
      }),
      "utf-8",
    );

    // 新进程语义：先落盘后建 store。修复前 collectRecords 在 buildEntryFromIndex
    // 命中处迭代 number 型 turns 抛 TypeError（"<N> is not iterable"）。
    const store = new RecordStore(() => sessionsDir, undefined, undefined, () => recordsDir);
    expect(() => store.collectRecords(100)).not.toThrow();
    expect(() => store.rebuildIndexes()).not.toThrow();

    // 走轻量分支（零内容读取）且统计投影正确：turns/totalTokens 取索引自承值，
    // 收条域（stopReason/endedAt）随 state marker 投影。
    const rec = store.collectRecords(100).find((r) => r.id === id);
    expect(rec).toBeDefined();
    expect(rec?.turns).toBe(3);
    expect(rec?.totalTokens).toBe(120);
    expect(rec?.stopReason).toBe("stop");
    expect(rec?.endedAt).toBe(1500);
    // 正常索引命中路径零 warn（buildRecord 的泄漏防御 warn 只在 turns 键存在却非
    // 数组时触发——防刷屏契约）。
    loggerMock.warn.mockClear();
    store.collectRecords(100);
    expect(loggerMock.warn).not.toHaveBeenCalled();
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
    const store = new RecordStore(() => sessionsDir, undefined, undefined, () => recordsDir);
    const sessionFile = path.join(sessionsDir, "20260912T000006_fin.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    const record = makeRecord("sa-fin", { sessionFile, status: "idle", closedReason: "parent-shutdown", endedAt: 2000 });

    expect(store.markFinalized(record, "parent-shutdown")).toBe(true);
    const manifest = readManifest("sa-fin");
    expect(manifest.status).toBe("closed");
    expect(manifest.executionStatus).toBe("idle");
    expect(manifest.closedReason).toBe("parent-shutdown");
    store.dispose();
  });

  it("markCancelled：终态投影同 markFinalized（双写字段齐）", () => {
    const store = new RecordStore(() => sessionsDir, undefined, undefined, () => recordsDir);
    const sessionFile = path.join(sessionsDir, "20260912T000007_cx.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    const record = makeRecord("sa-cx2", { sessionFile, endedAt: 2000 });

    expect(store.markCancelled(record)).toBe(true);
    const manifest = readManifest("sa-cx2");
    expect(manifest.status).toBe("closed");
    expect(manifest.executionStatus).toBe("idle");
    store.dispose();
  });

  it("[collect 退役] 存量批成员 manifest（running 投影双写词汇）读侧容忍：重建投影可读", () => {
    // 批写侧已删，构造磁盘遗留形态（原批写面 batchManifestRecord 产物词汇）：
    // legacy status=running + executionStatus=running + closedReason 缺省 + 无
    // 子 session 文件（manifest 源兜底投影路径）。
    fs.writeFileSync(
      path.join(recordsDir, "sa-batch-legacy.json"),
      JSON.stringify({
        id: "sa-batch-legacy",
        rootSessionId: "root-session",
        agentName: "worker",
        status: "running",
        executionStatus: "running",
        createdAt: 1000,
        completedAt: 2000,
        task: "batch task",
        slug: "batch",
      }),
      "utf-8",
    );

    const store = new RecordStore(() => sessionsDir, new ManifestStore(() => recordsDir));
    const rec = store.collectRecords(10, "all").find((r) => r.id === "sa-batch-legacy");
    expect(rec).toBeDefined();
    // manifest 源投影按 executionStatus 两态权威词读回；legacy running = §3.2.8
    // 活跃成员词汇 → running 投影（活跃可见），不炸。
    expect(rec?.status).toBe("running");
    expect(rec?.agent).toBe("worker");
    expect(rec?.task).toBe("batch task");
    store.dispose();
  });

});
