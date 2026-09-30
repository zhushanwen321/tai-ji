// src/__tests__/record-store.test.ts
//
// RecordStore 专属测试。
// 覆盖：
//   - archive 立即移除（终态 record 不留内存，读时从 session.jsonl 重建）
//   - collectRecords 合并内存(running) + 磁盘(session.jsonl 重建)
//   - collectRecords statusFilter（"running" vs "all"）
//   - cancelled tombstone override
//   - compareRecords 排序（status priority + startedAt desc）
//   - 重建缓存（notifyChange 失效）
//
// 用 tmpdir + 真实 .jsonl fixture（隔离真实文件系统，同 session-reconstructor.test.ts 模式）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// [PS-14/T7③ / LC-9 等 T7 可观测性] Mock 共享 logger：sessions-index 写失败的
// warn 留痕可被断言（对齐 channel-registry-handshake.test.ts 模式）。
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({
  getLogger: () => loggerMock,
}));

// [PS-14] saveIndex 可注入失败（默认 resolve，零影响既有用例；loadIndex/常量保留 actual）。
const { saveIndexMock } = vi.hoisted(() => ({
  saveIndexMock: vi.fn(() => Promise.resolve()),
}));
vi.mock("../persistence/sessions-index.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../persistence/sessions-index.ts")>();
  return { ...actual, saveIndex: saveIndexMock };
});

import { writeAliveMarker } from "../persistence/alive-store.ts";
// [W1 / U2a] record 事件文件观察点（u0 契约层 scan/路径原语——被测面独立性）。
import { createRecordEventJournal, recordEventsPath } from "../persistence/record-events.ts";
import type { RecordJournalEvent } from "../persistence/record-events.ts";
import { readStateMarker } from "../persistence/state-marker.ts";
import { completeLegacyClosed, createRecord, projectOutcome, trySettleLegacyClosed } from "../persistence/execution-record.ts";
import { writeCancelledState, writeFinalizedState, writeSettledState } from "../persistence/state-marker.ts";
import type { ManifestRecord } from "../persistence/manifest-store.ts";
import { ManifestStore } from "../persistence/manifest-store.ts";
import { getSubagentRecordsDir, getSubagentSessionDir } from "../assembly/path-encoding.ts";
import { SUBAGENT_RECORD_CUSTOM_TYPE, SUBAGENT_RECORD_ENTRY_VERSION } from "../persistence/record-entry.ts";
import type { StatusFilter } from "../persistence/record-store.ts";
import { RecordStore } from "../persistence/record-store.ts";
import { manifestToSubagent, stateMarkerFromFold, v2PairToRecord } from "../persistence/record-store-rebuild.ts";
import type { V2EntryPair } from "../persistence/record-store-rebuild.ts";
import { foldRecordJournalEvents } from "../persistence/record-events.ts";
import type { ExecutionRecord, SubagentRecord } from "../assembly/types.ts";
import { writeLegacyCancelledSidecar, writeLegacyFinalizedSidecar } from "./helpers/legacy-sidecar.ts";
// [登记 §3.3] v2 两条款条目播种辅助（v1 全量快照写点已随兼容层删除）。
import { v2RegisteredEntry, v2SettledEntry } from "./helpers/v2-record-entry.ts";

/** 构造 ExecutionRecord（base 默认 running，over 覆盖任意字段）。 */
function makeRecord(over: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const base = createRecord("r1", {
    agent: "worker",
    model: "m",
    mode: "background",
    task: "t",
    slug: "test",
    startedAt: 1000,
    rootSessionId: "sess-current",
    // 对齐生产 register 路径（subagent-service createRecord：one-shot 显式 false）
  });
  return { ...base, ...over };
}

/**
 * 构造最小 SubagentRecord（[登记 §3.3] v2 条目播种辅助的入参——helpers/v2-record-entry.ts
 * 只消费身份域 + 终局域字段；其余字段给合法缺省）。
 */
function makeSubagentRecord(over: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    id: "sa-base",
    agent: "worker",
    task: "t",
    slug: "s",
    status: "running",
    mode: "background",
    startedAt: 1000,
    rootSessionId: "sess-current",
    parentRecordId: undefined,
    depth: 0,
    endedAt: undefined,
    turns: 0,
    totalTokens: 0,
    model: undefined,
    thinkingLevel: undefined,
    eventLog: [],
    displayItems: [],
    ...over,
  };
}

/**
 * 写一个最小合法的 session.jsonl（含 identity custom entry + 1 个 assistant message）。
 * 用于 collectRecords 磁盘源重建测试。
 */
function writeSessionJsonl(
  filePath: string,
  identity: { id: string; agent: string; mode: "background"; task: string; startedAt: number; rootSessionId?: string; parentRecordId?: string; depth?: number; lastTs?: number; chatMode?: boolean },
  assistantText = "result text",
): void {
  const lastTs = identity.lastTs ?? identity.startedAt + 1000;
  const header = JSON.stringify({
    type: "session", version: 3, id: "sess-uuid", timestamp: new Date(identity.startedAt).toISOString(), cwd: "/tmp",
  });
  const identityData: Record<string, unknown> = {
    id: identity.id,
    agent: identity.agent,
    mode: identity.mode,
    task: identity.task,
    startedAt: identity.startedAt,
  };
  if (identity.rootSessionId !== undefined) identityData.rootSessionId = identity.rootSessionId;
  if (identity.parentRecordId !== undefined) identityData.parentRecordId = identity.parentRecordId;
  if (identity.depth !== undefined) identityData.depth = identity.depth;
  if (identity.chatMode !== undefined) identityData.chatMode = identity.chatMode;
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
    timestamp: new Date(lastTs).toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: assistantText }],
      usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { total: 0 } },
      stopReason: "stop",
      timestamp: lastTs,
    },
  });
  fs.writeFileSync(filePath, `${header}\n${identityEntry}\n${assistantMsg}\n`, "utf-8");
}

describe("RecordStore", () => {
  let rootDir: string;
  let tmpDir: string;

  beforeEach(() => {
    // [DS3] 两层布局：tmpDir 深一层（对齐生产 <enc> 段结构），sessions-index.json 落
    // dirname(tmpDir)=rootDir 内随 afterEach 清理（含 MF-3/S-20 的嵌套 <enc> 段索引）。
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rs-test-"));
    tmpDir = path.join(rootDir, "sessions");
    fs.mkdirSync(tmpDir);
  });
  afterEach(() => {
    // maxRetries：fire-and-forget 的 sessions-index 写可能与删除并发（ENOTEMPTY 竞态）
    fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    // [PS-14] 恢复 saveIndex 默认 resolve 实现 + 清 logger 断言（用例间隔离）
    saveIndexMock.mockReset();
    saveIndexMock.mockImplementation(() => Promise.resolve());
    loggerMock.debug.mockClear();
    loggerMock.warn.mockClear();
    loggerMock.error.mockClear();
  });

  // ============================================================
  // archive 立即移除
  // ============================================================
  describe("archive 立即移除", () => {
    it("archive 后 record 立即从内存移除（不再 linger）", () => {
      const store = new RecordStore(tmpDir);
      const r = makeRecord({ id: "sync-1", mode: "background", status: "idle" });
      store.register(r);
      expect(store.getMutable("sync-1")).toBeDefined();
      store.archive(r);
      expect(store.getMutable("sync-1")).toBeUndefined();
    });

    it("background record 同样立即移除（不再 FIFO）", () => {
      const store = new RecordStore(tmpDir);
      const r = makeRecord({ id: "bg-1", mode: "background", status: "idle" });
      store.register(r);
      store.archive(r);
      expect(store.getMutable("bg-1")).toBeUndefined();
    });
  });

  // ============================================================
  // collectRecords：内存(running) + 磁盘(重建) 合并
  // ============================================================
  describe("collectRecords 合并", () => {
    it("内存 running record 出现在结果中", () => {
      const store = new RecordStore(tmpDir);
      store.register(makeRecord({ id: "run-1", mode: "background", startedAt: 1000 }));
      const ids = store.collectRecords(100).map((r) => r.id);
      expect(ids).toContain("run-1");
    });

    it("磁盘 session.jsonl 重建的 record 出现在结果中（无 sidecar → idle + interrupted-by-restart，§3.2.4 单规则）", () => {
      const sessionFile = path.join(tmpDir, "2026-01-01-uuid-a.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "bg-1", agent: "worker", mode: "background", task: "do it", startedAt: 5000,
      });
      // 无 sidecar → 重建单规则兜底 idle + interrupted-by-restart（§3.2.4「文件不存在」行）
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === "bg-1");
      expect(found).toBeDefined();
      expect(found?.status).toBe("idle");
      expect(found?.stopReason).toBe("interrupted-by-restart");
      expect(found?.agent).toBe("worker");
      // [perf] 列表是 light（头部 identity，详情字段缺省）——turns/tokens/result 走 getFullRecord 懒加载
      expect(found?.turns).toBe(0);
      expect(found?.result).toBeUndefined();
      const full = store.getFullRecord("bg-1");
      expect(full?.turns).toBe(1);
      expect(full?.totalTokens).toBe(30);
      expect(full?.result).toBe("result text");
      expect(full?.status).toBe("idle"); // 单规则在全量路径同样套用
    });

    it("磁盘 session.jsonl + .state sidecar（finalized） → idle", () => {
      const sessionFile = path.join(tmpDir, "2026-01-01-uuid-b.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "bg-2", agent: "worker", mode: "background", task: "do it", startedAt: 5000,
      });
      writeFinalizedState(sessionFile);
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === "bg-2");
      expect(found).toBeDefined();
      expect(found?.status).toBe("idle");
    });

    it("statusFilter='running' 只剩内存 running（§3.2.4：磁盘重建恒 idle，running 只在轮次在飞时有意义）", () => {
      const sessionFile = path.join(tmpDir, "2026-01-01-uuid-a.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "bg-1", agent: "worker", mode: "background", task: "do it", startedAt: 5000,
      });
      const store = new RecordStore(tmpDir);
      store.register(makeRecord({ id: "run-1", mode: "background", startedAt: 1000 }));
      const filter: StatusFilter = "running";
      const ids = store.collectRecords(100, filter).map((r) => r.id);
      // 磁盘 bg-1 重建为 idle（单规则），filter=running 只剩内存 run-1
      expect(ids).toEqual(["run-1"]);
    });

    it("statusFilter='all'（默认）返回内存 + 磁盘", () => {
      const sessionFile = path.join(tmpDir, "2026-01-01-uuid-a.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "bg-1", agent: "worker", mode: "background", task: "do it", startedAt: 5000,
      });
      const store = new RecordStore(tmpDir);
      store.register(makeRecord({ id: "run-1", mode: "background", startedAt: 1000 }));
      const ids = store.collectRecords(100).map((r) => r.id);
      expect(ids).toContain("run-1");
      expect(ids).toContain("bg-1");
    });

    it("内存 running 优先于磁盘同 id（内存覆盖）", () => {
      const sessionFile = path.join(tmpDir, "2026-01-01-uuid-a.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "dup-1", agent: "worker", mode: "background", task: "from disk", startedAt: 5000,
      });
      const store = new RecordStore(tmpDir);
      store.register(makeRecord({ id: "dup-1", mode: "background", status: "running", startedAt: 5000 }));
      const found = store.collectRecords(100).find((r) => r.id === "dup-1");
      expect(found?.status).toBe("running"); // 内存 running 覆盖磁盘 idle（SP-2）
    });

    it("[MF-3/S-20] 跨进程组合：子进程（worktree）写入 enc(ROOT) 的深层 record 被 ROOT store 重建，同 rootSessionId 全树可见、他树被排除", () => {
      // MF-3 修复后：worktree 子进程把其子 record 的 session 文件写到统一 enc(ROOT cwd) 段，
      // ROOT 进程的 store 扫同一目录重建（旧实现子进程写到 enc(checkout) 段，此处为空）。
      const rootCwd = "/Users/x/root-proj";
      const sessionsDir = getSubagentSessionDir(tmpDir, rootCwd);
      const recordsDir = getSubagentRecordsDir(tmpDir, rootCwd);

      // 父 record A（ROOT 自己 spawn，parentRecordId 缺省=顶层）+ 孙 record C（B 子进程写入，
      // 同 rootSessionId、parentRecordId=A、depth=2）+ 他树 record X（rootSessionId 不同）
      fs.mkdirSync(sessionsDir, { recursive: true });
      writeSessionJsonl(path.join(sessionsDir, "2026-01-01-uuid-a.jsonl"), {
        id: "sa-A", agent: "worker", mode: "background", task: "level1", startedAt: 1000, rootSessionId: "root-main",
      });
      writeSessionJsonl(path.join(sessionsDir, "2026-01-01-uuid-c.jsonl"), {
        id: "sa-C", agent: "worker", mode: "background", task: "level3", startedAt: 3000,
        rootSessionId: "root-main", parentRecordId: "sa-A", depth: 2,
      });
      writeSessionJsonl(path.join(sessionsDir, "2026-01-01-uuid-x.jsonl"), {
        id: "sa-X", agent: "worker", mode: "background", task: "other root", startedAt: 4000, rootSessionId: "root-other",
      });

      // ROOT 进程的 store：sessionsDir/recordsDir 与子进程写盘目录同段（getSubagentSessionDir 同源）
      const store = new RecordStore(sessionsDir, new ManifestStore(recordsDir), undefined);
      const recs = store.collectRecords(10, "all", "root-main");
      const ids = recs.map((r) => r.id);

      // 全树可见：A（顶层）与 C（深度 2，跨进程写入）都在列表，身份字段正确
      expect(ids).toContain("sa-A");
      expect(ids).toContain("sa-C");
      const c = recs.find((r) => r.id === "sa-C");
      expect(c?.parentRecordId).toBe("sa-A");
      expect(c?.depth).toBe(2);
      // 他树 record 被 rootSessionFilter 排除（隔离不破坏）
      expect(ids).not.toContain("sa-X");
    });
  });

  // ============================================================
  // cancelled tombstone override
  // ============================================================
  describe("cancelled tombstone", () => {
    it("有 .state sidecar（cancelled） → status override 为 closed + closedReason=cancelled", () => {
      const sessionFile = path.join(tmpDir, "2026-01-01-uuid-a.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "bg-1", agent: "worker", mode: "background", task: "do it", startedAt: 5000,
      });
      writeCancelledState(sessionFile, 6000);
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === "bg-1");
      // v4 B-1：cancelled 折入 closed，closedReason='cancelled' 保留用户取消语义
      expect(found?.status).toBe("idle");
      expect(found?.closedReason).toBe("cancelled");
      expect(found?.error).toBe("cancelled by user");
    });
  });

  // ============================================================
  // compareRecords 排序稳定性（内存 running record）
  // ============================================================
  describe("compareRecords 排序", () => {
    it("status priority（running < closed）", () => {
      const store = new RecordStore(tmpDir);
      // 内存 running record
      const running = makeRecord({ id: "run-1", mode: "background", startedAt: 3000, status: "running" });
      store.register(running);
      // 磁盘 closed record（.state sidecar（finalized） → closed，v4 B-1 统一终态）
      const doneFile = path.join(tmpDir, "a.jsonl");
      writeSessionJsonl(doneFile, {
        id: "done-1", agent: "w", mode: "background", task: "t", startedAt: 5000,
      });
      writeFinalizedState(doneFile);
      const ids = store.collectRecords(100).map((r) => r.id);
      expect(ids[0]).toBe("run-1"); // running(0) 排在 closed(3) 前
    });

    it("同 status 时 startedAt desc（新→旧）", () => {
      const store = new RecordStore(tmpDir);
      writeSessionJsonl(path.join(tmpDir, "old.jsonl"), {
        id: "old", agent: "w", mode: "background", task: "t", startedAt: 1000,
      });
      writeSessionJsonl(path.join(tmpDir, "new.jsonl"), {
        id: "new", agent: "w", mode: "background", task: "t", startedAt: 9000,
      });
      // 两个都是 running（磁盘重建，无 sidecar → SP-2 兜底 running，旧 idle 折入），按 startedAt desc
      const ids = store.collectRecords(100).map((r) => r.id);
      expect(ids).toEqual(["new", "old"]);
    });
  });

  // ============================================================
  // running 态 record（M2-A chatMode 续聊；v4 B-1：旧 idle 折入 running）
  // ============================================================
  describe("running 态 record（旧 idle 折入，等待续聊）", () => {
    it("getMutable 能查到 running record（不筛 status，running record 留内存不 archive）", () => {
      const store = new RecordStore(tmpDir);
      const r = makeRecord({ id: "idle-1", status: "running" });
      store.register(r);
      // running record 不 archive → getMutable 仍可查（续聊定位依赖此）
      expect(store.getMutable("idle-1")).toBe(r);
    });

    it("running record 经 collectRecords(statusFilter=all) 可见", () => {
      const store = new RecordStore(tmpDir);
      store.register(makeRecord({ id: "idle-2", status: "running" }));
      const ids = store.collectRecords(100, "all").map((r) => r.id);
      expect(ids).toContain("idle-2");
    });

    it("running record 经 collectRecords(statusFilter=running) 可见（v4 B-1：旧 idle 折入 running）", () => {
      const store = new RecordStore(tmpDir);
      store.register(makeRecord({ id: "idle-3", status: "running" }));
      const ids = store.collectRecords(100, "running").map((r) => r.id);
      expect(ids).toContain("idle-3");
    });
  });


  // ============================================================
  // 重建缓存
  // ============================================================
  describe("重建缓存", () => {
    it("新 session.jsonl 无需内存事件即立即可见（[perf] stat 校验取代 notifyChange 整体失效）", () => {
      const store = new RecordStore(tmpDir);
      // 首次 collect：空目录
      expect(store.collectRecords(100)).toHaveLength(0);
      // 写新 session.jsonl（模拟外部进程/子进程写入——不经本进程任何内存事件）
      writeSessionJsonl(path.join(tmpDir, "new.jsonl"), {
        id: "bg-1", agent: "w", mode: "background", task: "t", startedAt: 1000,
      });
      // [perf] 旧实现：reconCache 建立后只能靠 register/archive 触发 notifyChange 失效，
      // 否则永远 stale（外部进程写入的文件对本进程不可见）。新实现：每次 collectRecords
      // 都 readdir + stat 校验，新文件立即可见（同时修复跨进程可见性）。
      const ids = store.collectRecords(100).map((r) => r.id);
      expect(ids).toContain("bg-1");
    });
  });

  // ============================================================
  // dispose / revive
  // ============================================================
  describe("dispose / revive", () => {
    it("dispose 后 notifyChange 不再触发 listener", () => {
      const store = new RecordStore(tmpDir);
      let count = 0;
      store.onChange(() => { count++; });
      store.register(makeRecord({ id: "r1", startedAt: 1000 }));
      expect(count).toBe(1);
      store.dispose();
      store.register(makeRecord({ id: "r2", startedAt: 2000 }));
      expect(count).toBe(1); // dispose 后不再通知
    });
  });

  // ============================================================
  // [U3 / §3.2.4] 重建单规则：重建一律得 idle，stopReason 取自 .state
  //（无则 interrupted-by-restart）；四输入 = 新格式 / 旧 finalized / 旧 cancelled / 无 sidecar
  // ============================================================
  describe("重建单规则（§3.2.4）", () => {
    const SESSION_ID = "bg-1";
    const STARTED_AT = 1000;

    function writeBaseSession(): string {
      const sessionFile = path.join(tmpDir, "2026-01-01-uuid-sidecar.jsonl");
      writeSessionJsonl(sessionFile, {
        id: SESSION_ID, agent: "worker", mode: "background", task: "do it", startedAt: STARTED_AT,
      });
      return sessionFile;
    }

    // ── 输入 1: 新格式收条 {status:"idle", stopReason, endedAt}（writeSettledState 写面）──
    it(".state 新格式收条 → idle + stopReason=收口 reason；closedReason/endedAt 不投影（live ≡ reload）", () => {
      const sessionFile = writeBaseSession();
      writeSettledState(sessionFile, { stopReason: "interrupted", endedAt: 6000 });
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === SESSION_ID);
      expect(found?.status).toBe("idle");
      expect(found?.stopReason).toBe("interrupted");
      // 桥接不变量新侧：settle 产出的 idle 无旧终态遗留位（与内存 markSettled 一致）
      expect(found?.closedReason).toBeUndefined();
      // 非终态语义：endedAt 不投影（收条时间不冒充终态结束时间）
      expect(found?.endedAt).toBeUndefined();
      expect(found?.error).toBeUndefined();
    });

    it(".state 新格式收条无 stopReason → idle + interrupted-by-restart 兜底", () => {
      const sessionFile = writeBaseSession();
      writeSettledState(sessionFile, { endedAt: 6000 });
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === SESSION_ID);
      expect(found?.status).toBe("idle");
      expect(found?.stopReason).toBe("interrupted-by-restart");
    });

    it(".state 新格式 stopReason 非法值（外部损坏）→ idle + interrupted-by-restart 兜底", () => {
      const sessionFile = writeBaseSession();
      fs.writeFileSync(`${sessionFile}.state`, JSON.stringify({ status: "idle", reason: "garbage-reason" }), "utf-8");
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === SESSION_ID);
      expect(found?.status).toBe("idle");
      expect(found?.stopReason).toBe("interrupted-by-restart");
    });

    // ── 输入 2: 旧 finalized → idle + closedReason/stopReason=reason（上行映射）──
    it(".state 旧 finalized（携 reason）→ idle + stopReason=closedReason=reason", () => {
      const sessionFile = writeBaseSession();
      writeFinalizedState(sessionFile, "user-close");
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === SESSION_ID);
      expect(found?.status).toBe("idle");
      expect(found?.closedReason).toBe("user-close");
      expect(found?.stopReason).toBe("user-close");
    });

    // ── 输入 2b: 旧 finalized 空 reason（死因不可考）→ disconnected 兜底 ──
    it(".state 旧 finalized（空 reason）→ idle + disconnected 兜底（旧数据兼容回归）", () => {
      const sessionFile = writeBaseSession();
      writeFinalizedState(sessionFile);
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === SESSION_ID);
      expect(found?.status).toBe("idle");
      expect(found?.closedReason).toBe("disconnected");
      expect(found?.stopReason).toBe("disconnected");
    });

    // ── 输入 3: 旧 cancelled → idle + closedReason=cancelled（legacy 投影判据）
    //    + stopReason=interrupted（§3.2.4 上行映射）──
    it(".state 旧 cancelled → idle + stopReason=interrupted + closedReason=cancelled（双写与 U2 桥接对齐）", () => {
      const sessionFile = writeBaseSession();
      writeCancelledState(sessionFile, 6000);
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === SESSION_ID);
      expect(found?.status).toBe("idle");
      expect(found?.stopReason).toBe("interrupted");
      // closedReason 保留旧词：U2 桥接判据（idle ∧ closedReason 有值 → legacy
      // closed/cancelled 投影，旧 session-reader 兼容面）依赖此值
      expect(found?.closedReason).toBe("cancelled");
      expect(found?.error).toBe("cancelled by user");
      expect(found?.endedAt).toBe(6000);
    });

    // ── 输入 4: 无 sidecar → idle + interrupted-by-restart（崩溃在途 / 尚未收口）──
    it("无任何 sidecar → idle + interrupted-by-restart（§3.2.4「文件不存在」行；.alive 不影响判定）", () => {
      const sessionFile = writeBaseSession();
      // .alive 在持（异宿主探活形态）不参与 status 判定——探活读面走 findForeignLiveInstance 现查
      writeAliveMarker(sessionFile, { pid: process.pid, id: SESSION_ID, startedAt: STARTED_AT });
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === SESSION_ID);
      expect(found?.status).toBe("idle");
      expect(found?.stopReason).toBe("interrupted-by-restart");
      expect(found?.closedReason).toBeUndefined();
      expect(found?.endedAt).toBeUndefined();
      expect(found).not.toHaveProperty("externalInstance");
    });

    it(".alive + 死 pid（崩溃残留）→ 同款 idle + interrupted-by-restart", () => {
      const sessionFile = writeBaseSession();
      writeAliveMarker(sessionFile, { pid: 9999999, id: SESSION_ID, startedAt: STARTED_AT });
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === SESSION_ID);
      expect(found?.status).toBe("idle");
      expect(found?.stopReason).toBe("interrupted-by-restart");
    });

    // ── 兼容读回归：存量旧名共存时 .cancelled 优先于 .finalized ──
    it("兼容读：旧 .cancelled 优先于旧 .finalized（存量共存形态，优先级对齐合并前）", () => {
      const sessionFile = writeBaseSession();
      writeLegacyFinalizedSidecar(sessionFile);
      writeLegacyCancelledSidecar(sessionFile, {
        id: SESSION_ID, status: "cancelled", agent: "worker", startedAt: STARTED_AT, endedAt: 6000,
      });
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === SESSION_ID);
      expect(found?.status).toBe("idle");
      expect(found?.closedReason).toBe("cancelled");
      expect(found?.stopReason).toBe("interrupted");
    });

    // ── 新名权威：.state 与存量旧名共存时 .state 胜出 ──
    it(".state 优先于存量旧名（新写侧权威，旧文件残留不覆盖新收口）", () => {
      const sessionFile = writeBaseSession();
      writeLegacyCancelledSidecar(sessionFile, {
        id: SESSION_ID, status: "cancelled", agent: "worker", startedAt: STARTED_AT, endedAt: 6000,
      });
      writeFinalizedState(sessionFile, "user-close");
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100).find((r) => r.id === SESSION_ID);
      expect(found?.status).toBe("idle");
      expect(found?.closedReason).toBe("user-close");
    });
  });

  // ============================================================
  // session 隔离（问题 1 修复）
  // ============================================================
  describe("session 隔离（rootSessionId 过滤）", () => {
    it("磁盘源：只返回 rootSessionId 匹配的 record", () => {
      writeSessionJsonl(path.join(tmpDir, "mine.jsonl"), {
        id: "mine", agent: "w", mode: "background", task: "t", startedAt: 1000, rootSessionId: "sess-A",
      });
      writeSessionJsonl(path.join(tmpDir, "other.jsonl"), {
        id: "other", agent: "w", mode: "background", task: "t", startedAt: 2000, rootSessionId: "sess-B",
      });
      const store = new RecordStore(tmpDir);
      const ids = store.collectRecords(100, "all", "sess-A").map((r) => r.id);
      expect(ids).toEqual(["mine"]); // other 属于 sess-B，被隔离
    });

    it("磁盘源：rootSessionId 缺失（旧文件）被排除（无法判定归属）", () => {
      writeSessionJsonl(path.join(tmpDir, "legacy.jsonl"), {
        id: "legacy", agent: "w", mode: "background", task: "t", startedAt: 1000, // 无 rootSessionId
      });
      const store = new RecordStore(tmpDir);
      const ids = store.collectRecords(100, "all", "sess-A").map((r) => r.id);
      expect(ids).toEqual([]); // 旧文件被排除
    });

    it("磁盘源：不传 filter（undefined）不过滤（向后兼容）", () => {
      writeSessionJsonl(path.join(tmpDir, "legacy.jsonl"), {
        id: "legacy", agent: "w", mode: "background", task: "t", startedAt: 1000,
      });
      writeSessionJsonl(path.join(tmpDir, "tagged.jsonl"), {
        id: "tagged", agent: "w", mode: "background", task: "t", startedAt: 2000, rootSessionId: "sess-A",
      });
      const store = new RecordStore(tmpDir);
      const ids = store.collectRecords(100).map((r) => r.id);
      expect(ids.sort()).toEqual(["legacy", "tagged"]); // 全返回，不过滤
    });

    it("内存源：只返回 rootSessionId 匹配的 running record", () => {
      const store = new RecordStore(tmpDir);
      store.register(makeRecord({ id: "mine", startedAt: 1000, rootSessionId: "sess-A" }));
      store.register(makeRecord({ id: "other", startedAt: 2000, rootSessionId: "sess-B" }));
      const ids = store.collectRecords(100, "all", "sess-A").map((r) => r.id);
      expect(ids).toEqual(["mine"]);
    });

    it("内存+磁盘混合：同时按 session 过滤", () => {
      writeSessionJsonl(path.join(tmpDir, "disk-A.jsonl"), {
        id: "disk-A", agent: "w", mode: "background", task: "t", startedAt: 1000, rootSessionId: "sess-A",
      });
      writeSessionJsonl(path.join(tmpDir, "disk-B.jsonl"), {
        id: "disk-B", agent: "w", mode: "background", task: "t", startedAt: 2000, rootSessionId: "sess-B",
      });
      const store = new RecordStore(tmpDir);
      store.register(makeRecord({ id: "mem-A", startedAt: 3000, rootSessionId: "sess-A" }));
      store.register(makeRecord({ id: "mem-B", startedAt: 4000, rootSessionId: "sess-B" }));
      const ids = store.collectRecords(100, "all", "sess-A").map((r) => r.id).sort();
      expect(ids).toEqual(["disk-A", "mem-A"]);
    });

    it("重建缓存：不同 filter 共享缓存，不交叉污染", () => {
      writeSessionJsonl(path.join(tmpDir, "a.jsonl"), {
        id: "a", agent: "w", mode: "background", task: "t", startedAt: 1000, rootSessionId: "sess-A",
      });
      writeSessionJsonl(path.join(tmpDir, "b.jsonl"), {
        id: "b", agent: "w", mode: "background", task: "t", startedAt: 2000, rootSessionId: "sess-B",
      });
      const store = new RecordStore(tmpDir);
      // 先查 sess-A（建缓存）
      expect(store.collectRecords(100, "all", "sess-A").map((r) => r.id)).toEqual(["a"]);
      // 再查 sess-B（复用缓存基底，过滤不交叉）
      expect(store.collectRecords(100, "all", "sess-B").map((r) => r.id)).toEqual(["b"]);
      // 不带 filter（复用缓存，全量）
      expect(store.collectRecords(100).map((r) => r.id).sort()).toEqual(["a", "b"]);
    });
  });

  // ============================================================
  // endedAt 重建（问题 2 修复：终态耗时不再随墙钟增长）
  // ============================================================
  describe("endedAt 重建（耗时不再无限增长）", () => {
    it(".state（finalized）→ light endedAt 用 mtime 近似，全量 endedAt 为最后 entry 时间戳", () => {
      const sessionFile = path.join(tmpDir, "fin.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "bg-1", agent: "w", mode: "background", task: "t",
        startedAt: 5000, lastTs: 9000, rootSessionId: "sess-A",
      });
      writeFinalizedState(sessionFile);
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100, "all", "sess-A").find((r) => r.id === "bg-1");
      // [perf] light 分支 2：endedAt 用 jsonl mtime 近似（finalize 后文件不再变化，
      // 与最后 entry ts 差 <1s）——不是 entry ts 9000，也不是随墙钟无限增长的 now 基准。
      expect(found?.endedAt).toBeDefined();
      expect(found?.endedAt).toBeGreaterThan(5000);
      // 全量（getFullRecord）：精确用最后 entry 时间戳（非 now）。
      expect(store.getFullRecord("bg-1")?.endedAt).toBe(9000);
    });

    it("无 sidecar（idle, §3.2.4 单规则）→ endedAt 保持 undefined（非终态，与内存 settle 形态一致）", () => {
      const sessionFile = path.join(tmpDir, "crash.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "bg-1", agent: "w", mode: "background", task: "t",
        startedAt: 5000, lastTs: 9000, rootSessionId: "sess-A",
      });
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100, "all", "sess-A").find((r) => r.id === "bg-1");
      expect(found?.status).toBe("idle");
      // 非终态语义：endedAt 保持 undefined（待续聊；与内存 markSettled 形态一致）
      expect(found?.endedAt).toBeUndefined();
    });

    it(".alive 在持 → endedAt 保持 undefined（.alive 不参与 status 判定，耗时继续增长是正确的）", () => {
      const sessionFile = path.join(tmpDir, "alive.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "bg-1", agent: "w", mode: "background", task: "t",
        startedAt: Date.now() - 1000, lastTs: Date.now(), rootSessionId: "sess-A",
      });
      writeAliveMarker(sessionFile, { pid: process.pid, id: "bg-1", startedAt: Date.now() - 1000 });
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100, "all", "sess-A").find((r) => r.id === "bg-1");
      expect(found?.status).toBe("idle");
      expect(found?.endedAt).toBeUndefined();
    });
  });

  // ============================================================
  // [BL-M1] 修复：损坏 manifest 上报 pi.appendEntry（用户可见）
  // collectRecords 跳过 mapManifestStatus 返回 null 的 manifest 时，除 console.warn
  // 外还需调 pi.appendEntry("subagent:manifest-invalid-status", ...) 让用户能在 session
  // 内复盘事故——避免磁盘陈旧/损坏 manifest 被静默吞掉。
  // ============================================================
  describe("manifest status 越界（损坏 manifest）", () => {
    /** 构造一个 status 越界的 manifest mock。
     *  ManifestRecord.status union 是 4 态，运行时却可能收到陈旧 "error" / 意外 "crashed"
     * 等越界值——isValidManifest 当前挡掉了大部分，但 manifestStore.listAllSync 与
     *  mapManifestStatus 之间仍有防御层（[BL-M1] 修复记录）。本测试用 unknown-cast 模拟
     *  一个越过 ManifestRecord 静态类型的对象，验证 collectRecords 反应正确。 */
    function brokenManifest(): ManifestRecord {
      // eslint-disable-next-line taste/no-unsafe-cast -- intentional: cast status 越界值模拟磁盘损坏 manifest（测试目的本身）
      return {
        id: "broken-1",
        rootSessionId: "sess-current",
        agentName: "worker",
        status: "crashed", // 越界值（union 不含 "crashed"，SP-1 后 valid statuses = running/closed/cancelled）
        createdAt: 1000,
      } as unknown as ManifestRecord;
    }

    /** Mock ManifestStore 让测试不依赖 fs 路径 + isValidManifest 守卫。
     *  source/target 类型不兼容是 intentional（ManifestStore 有多个方法，测试仅需 listAllSync），
     *  `as unknown as ManifestStore` 是 vitest mock 标准 pattern。*/
    function makeManifestStoreMock(manifests: ManifestRecord[]): ManifestStore {
      // eslint-disable-next-line taste/no-unsafe-cast -- intentional: ManifestStore 有多个方法，测试仅需 listAllSync
      return {
        // 复制 manifests 防调用方意外 mutate 共享数组；vi.fn 每次调用返回独立数组
        listAllSync: vi.fn(() => [...manifests]),
      } as unknown as ManifestStore;
    }

    it("collectRecords 跳过越界 status 时调用 pi.appendEntry('subagent:manifest-invalid-status', ...)", () => {
      const pi = { appendEntry: vi.fn() };
      // Mock ManifestStore：listAllSync 返回损坏 manifest，绕开真实 fs 路径与 isValidManifest 守卫。
      const manifestStore = makeManifestStoreMock([brokenManifest()]);
      const store = new RecordStore(tmpDir, manifestStore, pi);

      const result = store.collectRecords(100);

      // 损坏 manifest 不出现在结果中（status 越界被跳过，不降级为 failed——避免误告警）
      expect(result.find((r) => r.id === "broken-1")).toBeUndefined();
      // appendEntry 被调用，customType + data 字段正确
      expect(pi.appendEntry).toHaveBeenCalledTimes(1);
      expect(pi.appendEntry).toHaveBeenCalledWith("subagent:manifest-invalid-status", {
        id: "broken-1",
        status: "crashed",
        rootSessionId: "sess-current",
        agentName: "worker",
      });
    });

    it("pi 为 null/undefined 时不抛错（向后兼容：不注入 pi 的旧调用路径）", () => {
      const manifestStore = makeManifestStoreMock([brokenManifest()]);
      // 不传 pi（undefined）—— 模拟 SubagentService 构造期 session_start 未触发的场景。
      const store = new RecordStore(tmpDir, manifestStore);
      expect(() => store.collectRecords(100)).not.toThrow();
      // 损坏 manifest 仍被跳过（不降级）
      const result = store.collectRecords(100);
      expect(result.find((r) => r.id === "broken-1")).toBeUndefined();
    });

    it("setPi() 后 appendEntry 切换到新 pi（覆盖初始 undefined）", () => {
      const pi1 = { appendEntry: vi.fn() };
      const pi2 = { appendEntry: vi.fn() };
      const manifestStore = makeManifestStoreMock([brokenManifest()]);
      const store = new RecordStore(tmpDir, manifestStore, pi1);
      store.setPi(pi2);

      store.collectRecords(100);

      // 切换后只调 pi2（pi1 不再被调用）
      expect(pi1.appendEntry).not.toHaveBeenCalled();
      expect(pi2.appendEntry).toHaveBeenCalledTimes(1);
      expect(pi2.appendEntry).toHaveBeenCalledWith(
        "subagent:manifest-invalid-status",
        expect.objectContaining({ id: "broken-1" }),
      );
    });
  });

  // ============================================================
  // [U3 / §3.2.4] 重建单规则回归锚（原 SP-2 兜底 running 语义随单规则收敛为 idle）
  // ============================================================
  describe("重建单规则回归锚（原 SP-2）", () => {
    // TC-1: 无 sidecar 兜底输出 idle（非 crashed——两态下无派生终态）
    it("TC-1: 无 sidecar + 死 pid → reconstructAll 输出 idle + interrupted-by-restart（可冷路径续聊）", () => {
      const sessionFile = path.join(tmpDir, "sp2-tc1.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "sa-sp2-1", agent: "worker", mode: "background", task: "cross-restart task",
        startedAt: 1000, rootSessionId: "sess-sp2",
      });
      // 无任何 sidecar marker → 单规则兜底
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100, "all", "sess-sp2").find((r) => r.id === "sa-sp2-1");
      expect(found).toBeDefined();
      expect(found?.status).toBe("idle");
      expect(found?.stopReason).toBe("interrupted-by-restart");
      // 非终态：endedAt 保持 undefined
      expect(found?.endedAt).toBeUndefined();
    });

    // TC-2: 旧 .state marker（finalized） → idle（上行映射不回归）
    it("TC-2: .state marker（finalized） → idle（旧值上行映射不回归）", () => {
      const sessionFile = path.join(tmpDir, "sp2-tc2.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "sa-sp2-2", agent: "worker", mode: "background", task: "finalized task",
        startedAt: 2000, rootSessionId: "sess-sp2",
      });
      writeFinalizedState(sessionFile);
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100, "all", "sess-sp2").find((r) => r.id === "sa-sp2-2");
      expect(found).toBeDefined();
      expect(found?.status).toBe("idle");
      expect(found?.endedAt).toBeDefined();
    });

    // TC-2b: 旧 .state marker（cancelled） → idle + closedReason=cancelled + stopReason=interrupted
    it("TC-2b: .state marker（cancelled） → idle + closedReason=cancelled + stopReason=interrupted（旧值映射不回归）", () => {
      const sessionFile = path.join(tmpDir, "sp2-tc2b.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "sa-sp2-2b", agent: "worker", mode: "background", task: "cancelled task",
        startedAt: 3000, rootSessionId: "sess-sp2",
      });
      writeCancelledState(sessionFile, 4000);
      const store = new RecordStore(tmpDir);
      const found = store.collectRecords(100, "all", "sess-sp2").find((r) => r.id === "sa-sp2-2b");
      expect(found).toBeDefined();
      expect(found?.status).toBe("idle");
      expect(found?.closedReason).toBe("cancelled");
      expect(found?.stopReason).toBe("interrupted");
    });
  });

  // ============================================================
  // [U3 / §3.2.4 + 登记 §3.3] 孤儿恢复两入口：journal 在场收编（recoverOrphanRecords）
  // 与 entry-only 纠偏（recoverEntryOnlyOrphans）——一律保留 idle，锚在等 revive。
  // 播种全部走 v2 两条款（注册条目定界 + 非 interrupted 终态条目构成收口证据）。
  // ============================================================
  describe("recoverOrphanRecords 孤儿 entry 纠偏", () => {
    /** 播种用 SubagentRecord（孤儿场景缺省 rootSessionId=sess-orphan）。 */
    function seedRecord(over: Partial<SubagentRecord> = {}): SubagentRecord {
      return makeSubagentRecord({ rootSessionId: "sess-orphan", task: "orphan task", ...over });
    }

    /** 带真实磁盘 fixture + appendEntry 捕获的 store（recordsDir 接线 = 事件 journal 面在场）。 */
    function makeRecoveryStore(): { store: RecordStore; appended: Array<{ customType: string; data: Record<string, unknown> }> } {
      const appended: Array<{ customType: string; data: Record<string, unknown> }> = [];
      const recordsDir = path.join(rootDir, "records");
      fs.mkdirSync(recordsDir, { recursive: true });
      const store = new RecordStore(tmpDir, undefined, {
        appendEntry: (customType: string, data: unknown) => {
          appended.push({ customType, data: data as Record<string, unknown> });
        },
      } as never, recordsDir);
      return { store, appended };
    }

    /** 写主 session fixture（含指定 v2 subagent-record entry 序列）。 */
    function writeMainSession(entries: unknown[]): string {
      const mainFile = path.join(tmpDir, "main-session.jsonl");
      const lines = entries.map((d) => JSON.stringify({ type: "custom", id: `e-${Math.random()}`, parentId: null, customType: SUBAGENT_RECORD_CUSTOM_TYPE, data: d }));
      fs.writeFileSync(mainFile, lines.join("\n") + "\n", "utf-8");
      return mainFile;
    }

    /**
     * [登记 §3.3] 给 record 播种真实事件 journal（收编入口 recoverOrphanRecords 的在场
     * 前提）：created 帧携带身份域 → fold 的 lastSeq>0 且 identity 在场，收编可落地。
     */
    function seedRecordJournal(id: string, over: Record<string, unknown> = {}): void {
      const recordsDir = path.join(rootDir, "records");
      fs.mkdirSync(recordsDir, { recursive: true });
      const created = {
        type: "record-created",
        seq: 1,
        ts: 1000,
        id,
        agent: "worker",
        task: "orphan task",
        slug: "s",
        origin: "tool",
        rootSessionId: "sess-orphan",
        depth: 0,
        mode: "background",
        startedAt: 1000,
        ...over,
      };
      fs.writeFileSync(
        recordEventsPath(recordsDir, id),
        `${JSON.stringify({ type: "record-events", id })}\n${JSON.stringify(created)}\n`,
        "utf-8",
      );
    }

    it("in-flight 孤儿（注册条目残留 running + journal 在场）→ 收编 idle entry + interrupted-by-restart，无直断无 sidecar（[F3] 旧 closed+gc+error 直断退役）", () => {
      const sessionFile = path.join(tmpDir, "orphan-done.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "sa-orphan-1", agent: "worker", mode: "background", task: "orphan done",
        startedAt: 1000, rootSessionId: "sess-orphan",
      });
      seedRecordJournal("sa-orphan-1", { task: "orphan done" });
      const mainFile = writeMainSession([
        v2RegisteredEntry(seedRecord({ id: "sa-orphan-1", task: "orphan done", startedAt: 1000 })),
      ]);
      const { store, appended } = makeRecoveryStore();
      store.recoverOrphanRecords("sess-orphan", mainFile);

      const entry = appended.find((c) => c.data.id === "sa-orphan-1");
      expect(entry?.customType).toBe("subagent-record");
      // 收编产物 = v2 终态条目；一律保留 idle（锚在，等 revive）：不写死因 error
      expect(entry?.data.kind).toBe("settled");
      expect(entry?.data.status).toBe("idle");
      expect(entry?.data.stopReason).toBe("interrupted-by-restart");
      expect(entry?.data.error).toBeUndefined();
      // 不写 .state 防重锚（writeFinalizedState(file,"gc") 写点已删——磁盘重建面已收敛 idle）
      expect(fs.existsSync(`${sessionFile}.state`)).toBe(false);
      // 幂等：收编追加 record-settled 帧后 fold 已 settled，二次调用自然不再命中
      const again = [...appended];
      store.recoverOrphanRecords("sess-orphan", mainFile);
      expect(appended.length).toBe(again.length);
      const found = store.collectRecords(100, "all", "sess-orphan").find((r) => r.id === "sa-orphan-1");
      expect(found?.status).toBe("idle");
    });

    it("SP-5 完成态残留（注册条目 + journal 在场）→ 同款 idle 收编；result 全文落点迁至子 session 文件（v1 快照 merge 已随兼容层删除）", () => {
      const sessionFile = path.join(tmpDir, "orphan-sp5.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "sa-orphan-sp5", agent: "worker", mode: "background", task: "sp5 done",
        startedAt: 6000, rootSessionId: "sess-orphan",
      }, "final answer text");
      seedRecordJournal("sa-orphan-sp5", { task: "sp5 done", startedAt: 6000 });
      const mainFile = writeMainSession([
        v2RegisteredEntry(seedRecord({ id: "sa-orphan-sp5", task: "sp5 done", startedAt: 6000 })),
      ]);
      const { store, appended } = makeRecoveryStore();
      store.recoverOrphanRecords("sess-orphan", mainFile);

      const entry = appended.find((c) => c.data.id === "sa-orphan-sp5");
      expect(entry?.data.status).toBe("idle");
      expect(entry?.data.stopReason).toBe("interrupted-by-restart");
      expect(entry?.data.error).toBeUndefined();
      // v2 下 result 全文的载体 = 子 session 文件（收编是状态迁移不是信息重建）：读面仍拿得到
      const found = store.collectRecords(100, "all", "sess-orphan").find((r) => r.id === "sa-orphan-sp5");
      expect(found?.status).toBe("idle");
      expect(store.getFullRecord("sa-orphan-sp5")?.result).toBe("final answer text");
    });

    it("在飞残留 running（无产出）→ 收编 idle（[U5/D4] resumable 字段退役——可续聊资格由 idle 直读承载）", () => {
      const sessionFile = path.join(tmpDir, "orphan-resumable.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "sa-orphan-res", agent: "worker", mode: "background", task: "resumable orphan",
        startedAt: 7000, rootSessionId: "sess-orphan",
      });
      seedRecordJournal("sa-orphan-res", { task: "resumable orphan", startedAt: 7000 });
      const mainFile = writeMainSession([
        v2RegisteredEntry(seedRecord({ id: "sa-orphan-res", task: "resumable orphan", startedAt: 7000 })),
      ]);
      const { store, appended } = makeRecoveryStore();
      store.recoverOrphanRecords("sess-orphan", mainFile);

      const entry = appended.find((c) => c.data.id === "sa-orphan-res");
      expect(entry?.data.status).toBe("idle");
      expect(entry?.data.stopReason).toBe("interrupted-by-restart");
      expect(fs.existsSync(`${sessionFile}.state`)).toBe(false);
    });

    it("[P4-② ⛔ two-state-convergence U5] W4 纳管态孤儿（failed/error 只在内存，entry-born 无锚）跨重启 → entry-only 纠偏 idle + interrupted-by-restart", () => {
      // W4 新态 = adoptEngineDeath 纳管产物（[U5/D4] error/result/stopReason 三写、status
      // 保持 running）——[W1/D2] 过程 entry 停写：failed/error 只在内存，跨重启后的 v2
      // 注册条目结构上不承载它们，entry-only 纠偏恒落 interrupted-by-restart。
      // 设计 D6a 登记：W4 跨重启归宿 = 孤儿纠偏 idle 等 revive（非 readopt——
      // isBootReadoptable 现状空转）。
      const mainFile = writeMainSession([
        v2RegisteredEntry(seedRecord({ id: "sa-orphan-w4", task: "w4 adopt orphan", slug: "w4", startedAt: 8000 })),
      ]);
      const { store, appended } = makeRecoveryStore();
      // entry-born 无子文件锚形态 → recoverEntryOnlyOrphans（finalizeEntryOnlyOrphan）
      store.recoverEntryOnlyOrphans(mainFile, "sess-orphan");

      const entry = appended.find((c) => c.data.id === "sa-orphan-w4");
      // 纠偏 idle 等 revive（非 readopt、非直断）——message 冷查链 idle 全候选可复活
      expect(entry?.data.status).toBe("idle");
      expect(entry?.data.stopReason).toBe("interrupted-by-restart");
      expect(entry?.data.error).toBeUndefined();
      // [U5/D4] resumable 字段退役——可续聊复活资格由 idle 直读承载，无需独立信号位
      expect(entry?.data.status).toBe("idle");
    });

    it("子文件末行截断 → 收编与子文件正文解耦：照常 idle、无截断 error（末行判读路径已删）", () => {
      const sessionFile = path.join(tmpDir, "orphan-truncated.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "sa-orphan-2", agent: "worker", mode: "background", task: "orphan truncated",
        startedAt: 2000, rootSessionId: "sess-orphan",
      });
      // 制造截断：append 半行 JSON（无换行结尾）——旧实现判「truncated」落 error
      fs.appendFileSync(sessionFile, '{"type":"message","id":"msg-2","pare', "utf-8");
      seedRecordJournal("sa-orphan-2", { task: "orphan truncated", startedAt: 2000 });
      const mainFile = writeMainSession([
        v2RegisteredEntry(seedRecord({ id: "sa-orphan-2", task: "orphan truncated", startedAt: 2000 })),
      ]);
      const { store, appended } = makeRecoveryStore();
      store.recoverOrphanRecords("sess-orphan", mainFile);

      const entry = appended.find((c) => c.data.id === "sa-orphan-2");
      expect(entry?.data.status).toBe("idle");
      expect(entry?.data.stopReason).toBe("interrupted-by-restart");
      expect(entry?.data.error).toBeUndefined();
    });

    it("chatMode 孤儿 → 同款 idle 收编（无 running/chatMode 分流），entry 无 chatMode 残留键", () => {
      const sessionFile = path.join(tmpDir, "orphan-chat.jsonl");
      writeSessionJsonl(sessionFile, {
        id: "sa-orphan-3", agent: "worker", mode: "background", task: "orphan chat",
        startedAt: 3000, rootSessionId: "sess-orphan", chatMode: true,
      });
      seedRecordJournal("sa-orphan-3", { task: "orphan chat", startedAt: 3000 });
      const mainFile = writeMainSession([
        v2RegisteredEntry(seedRecord({ id: "sa-orphan-3", task: "orphan chat", startedAt: 3000 })),
      ]);
      const { store, appended } = makeRecoveryStore();
      store.recoverOrphanRecords("sess-orphan", mainFile);

      const entry = appended.find((c) => c.data.id === "sa-orphan-3");
      expect(entry?.data.status).toBe("idle");
      expect(entry?.data.stopReason).toBe("interrupted-by-restart");
      // [modeless 波1] chatMode 停写——entry 无此键（旧 entry 残留键读侧忽略）
      expect(entry?.data.chatMode).toBeUndefined();
      expect(fs.existsSync(`${sessionFile}.state`)).toBe(false);
    });

    it("entry 已收口（注册 + 非 interrupted 终态）/ 无 entry 残留 → 不进判定（零 append）", () => {
      const closedFile = path.join(tmpDir, "orphan-closed.jsonl");
      writeSessionJsonl(closedFile, {
        id: "sa-orphan-4", agent: "worker", mode: "background", task: "already settled",
        startedAt: 4000, rootSessionId: "sess-orphan",
      });
      writeFinalizedState(closedFile);
      const noEntryFile = path.join(tmpDir, "orphan-noentry.jsonl");
      writeSessionJsonl(noEntryFile, {
        id: "sa-orphan-6", agent: "worker", mode: "background", task: "no main entry",
        startedAt: 4500, rootSessionId: "sess-orphan",
      });
      // sa-orphan-6 的收口证据 = 注册 + 非 interrupted 终态条目；journal 也在场
      //（终态证据判据回归则收编被放行 → 本用例红）。
      seedRecordJournal("sa-orphan-6", { task: "no main entry", startedAt: 4500 });
      const mainFile = writeMainSession([
        // sa-orphan-4 无注册条目；sa-orphan-6 注册 + completed 终态
        v2RegisteredEntry(seedRecord({ id: "sa-orphan-6", task: "no main entry", startedAt: 4500, status: "idle", stopReason: "completed" })),
        v2SettledEntry(seedRecord({ id: "sa-orphan-6", task: "no main entry", startedAt: 4500, status: "idle", stopReason: "completed", endedAt: 4600 })),
      ]);
      const { store, appended } = makeRecoveryStore();
      store.recoverOrphanRecords("sess-orphan", mainFile);
      expect(appended.find((c) => c.data.id === "sa-orphan-4")).toBeUndefined();
      expect(appended.find((c) => c.data.id === "sa-orphan-6")).toBeUndefined();
    });

    it("entry-born 孤儿（无子文件 + 无 journal，spawn 窗口期死亡）→ idle + interrupted-by-restart（直断 closed+gc+error 退役）", () => {
      const mainFile = writeMainSession([
        v2RegisteredEntry(seedRecord({ id: "sa-entryonly-1", task: "spawn interrupted", slug: "s", startedAt: 6000 })),
      ]);
      const { store, appended } = makeRecoveryStore();
      store.recoverEntryOnlyOrphans(mainFile, "sess-orphan");

      const entry = appended.find((c) => c.data.id === "sa-entryonly-1");
      // 保持 idle 可见（无锚判据的续聊拒绝文案归 U4 准入判据，不在恢复面直断）
      expect(entry?.data.status).toBe("idle");
      expect(entry?.data.stopReason).toBe("interrupted-by-restart");
      expect(entry?.data.error).toBeUndefined();
      // 防重：orphanJudged 缓存拦截二次判定
      const count = appended.length;
      store.recoverEntryOnlyOrphans(mainFile, "sess-orphan");
      expect(appended.length).toBe(count);
    });

    it("entry-born 各形态统一 idle（原 chatMode-resumable 分流并入单规则）", () => {
      const mainFile = writeMainSession([
        v2RegisteredEntry(seedRecord({ id: "sa-entryonly-2", task: "chat spawn interrupted", slug: "s", startedAt: 7000 })),
      ]);
      const { store, appended } = makeRecoveryStore();
      store.recoverEntryOnlyOrphans(mainFile, "sess-orphan");

      const entry = appended.find((c) => c.data.id === "sa-entryonly-2");
      expect(entry?.data.status).toBe("idle");
      expect(entry?.data.stopReason).toBe("interrupted-by-restart");
      expect(entry?.data.error).toBeUndefined();
    });

    it("有子文件锚 / 末条已收口 / 他 session 的 entry-born id 不进判定", () => {
      const anchoredFile = path.join(tmpDir, "orphan-anchored.jsonl");
      writeSessionJsonl(anchoredFile, {
        id: "sa-anchored", agent: "worker", mode: "background", task: "has file",
        startedAt: 8000, rootSessionId: "sess-orphan",
      });
      const mainFile = writeMainSession([
        v2RegisteredEntry(seedRecord({ id: "sa-anchored", task: "has file", slug: "s", startedAt: 8000 })),
        v2RegisteredEntry(seedRecord({ id: "sa-settled", task: "settled", slug: "s", startedAt: 8100, status: "idle", stopReason: "completed" })),
        v2SettledEntry(seedRecord({ id: "sa-settled", task: "settled", slug: "s", startedAt: 8100, status: "idle", stopReason: "completed", endedAt: 8200 })),
        v2RegisteredEntry(seedRecord({ id: "sa-foreign", task: "other session", slug: "s", startedAt: 8200, rootSessionId: "sess-other" })),
      ]);
      const { store, appended } = makeRecoveryStore();
      store.recoverEntryOnlyOrphans(mainFile, "sess-orphan");
      expect(appended.find((c) => c.data.id === "sa-anchored")).toBeUndefined();
      expect(appended.find((c) => c.data.id === "sa-settled")).toBeUndefined();
      expect(appended.find((c) => c.data.id === "sa-foreign")).toBeUndefined();
    });

    it("[A11] 损坏 entry（身份域缺失）→ warn 留痕跳过：不抛错、不纠偏、不重判", () => {
      // task 缺失 = v2PairToRecord 拒绝重建（null）——注册条目身份域损坏的 record
      // 永远无法被纠偏落 idle，静默 continue 会把损坏伪装成「无孤儿可判」，
      // 排障无从下手（warn 必须含 id）。
      const mainFile = writeMainSession([
        {
          v: SUBAGENT_RECORD_ENTRY_VERSION, kind: "registered", id: "sa-corrupt-1",
          agent: "worker", slug: "s", origin: "tool",
          rootSessionId: "sess-orphan", depth: 0, startedAt: 9000,
          // task 缺失 = 身份域损坏
        },
      ]);
      const { store, appended } = makeRecoveryStore();
      expect(() => store.recoverEntryOnlyOrphans(mainFile, "sess-orphan")).not.toThrow();
      expect(appended).toHaveLength(0); // 不纠偏
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.stringContaining("sa-corrupt-1"),
      );
      // 防重：orphanJudged 已标记，二次扫描不重复 warn
      loggerMock.warn.mockClear();
      store.recoverEntryOnlyOrphans(mainFile, "sess-orphan");
      expect(loggerMock.warn).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // [A11] reconstructAll 目录级读失败分通道：ENOENT = 合法缺省（静默空表）；
  // 非 ENOENT（ENOTDIR/EACCES 等）= 真 IO 故障（warn 留痕——空表不得伪装 not-found）
  // ============================================================
  describe("reconstructAll 目录读失败分通道（collectRecords 冷查链消费）", () => {
    it("sessions 目录不存在（ENOENT）→ 空表且零 warn（合法缺省静默）", () => {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      const store = new RecordStore(tmpDir);
      expect(store.collectRecords(100)).toEqual([]);
      expect(loggerMock.warn).not.toHaveBeenCalled();
    });

    it("sessions 目录位被文件占据（ENOTDIR）→ 空表 + warn 留痕（IO 故障可诊断）", () => {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      fs.writeFileSync(tmpDir, "not a directory");
      const store = new RecordStore(tmpDir);
      expect(store.collectRecords(100)).toEqual([]);
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.stringContaining("reconstructAll"),
      );
    });
  });

  // ============================================================
  // W16 [D4]：subagent-record 自描述 appendEntry 上报（状态迁移点）
  // ============================================================
  describe("[W1/D1] subagent-record v2 两条款 appendEntry 上报（W16 v1 快照停写）", () => {
    /** appendEntry 捕获（RecordStorePi 最小实现）。 */
    interface AppendedCall {
      customType: string;
      data: unknown;
    }

    /** 构造带 appendEntry 捕获的 store（pi 注入通道，对齐生产 setPi 后形态）。 */
    function makeStoreWithPi(): { store: RecordStore; appended: AppendedCall[] } {
      const appended: AppendedCall[] = [];
      const store = new RecordStore(tmpDir, undefined, {
        appendEntry: (customType: string, data: unknown) => {
          appended.push({ customType, data });
        },
      });
      return { store, appended };
    }

    /** unknown → 对象的运行时 guard（taste/no-unsafe-cast：断言前先收窄）。 */
    function asEntryData(d: unknown): Record<string, unknown> {
      if (typeof d !== "object" || d === null) throw new Error("entry data is not an object");
      return d as Record<string, unknown>;
    }

    it("register：append v2 注册条目（kind=registered，身份域字段集；运行态/死字节零携带）", () => {
      const { store, appended } = makeStoreWithPi();
      store.register(makeRecord());

      expect(appended).toHaveLength(1);
      // 写点字面量与 record-entry.ts 常量等值（钉住双源一致性）
      expect(appended[0]?.customType).toBe(SUBAGENT_RECORD_CUSTOM_TYPE);
      // [E2E 实测教训] 必须先 JSON 序列化再断言：appendEntry 捕获的是内存对象，
      // undefined 值的键名仍在；真实 JSONL 会丢 undefined 值键，此处对齐生产行为。
      const data = asEntryData(JSON.parse(JSON.stringify(appended[0]?.data)));
      // [W1/D1] v2 注册条目字段集 = 身份与锚点（D1 条目契约表）；turns/status/
      // eventLog/displayItems 等运行态与死字节零携带（turns 投影停写点）。
      expect(Object.keys(data).sort()).toEqual([
        "agent", "depth", "id", "kind", "origin",
        "rootSessionId", "slug", "startedAt", "task", "v",
      ]);
      expect(data).toMatchObject({
        v: 2,
        kind: "registered",
        id: "r1",
        agent: "worker",
        task: "t",
        startedAt: 1000,
        rootSessionId: "sess-current",
        origin: "tool",
        depth: 0,
      });
    });

    it("archive：真终局（endedAt 已冻结）append v2 终态条目；one-shot 生命周期共 2 次 append", () => {
      const { store, appended } = makeStoreWithPi();
      const r = makeRecord();
      store.register(r);
      // 模拟正常终态路径：trySettleLegacyClosed CAS → completeLegacyClosed 冻结 → archive（D-017 时序）
      trySettleLegacyClosed(r, "gc");
      completeLegacyClosed(r, { text: "task done", turns: 1, durationMs: 500, success: true, sessionId: "r1", toolCalls: [] }, "gc");
      store.archive(r);

      // 探针基线（单测级）：one-shot 生命周期 = register + archive = 2 次 append
      expect(appended).toHaveLength(2);
      const data = asEntryData(JSON.parse(JSON.stringify(appended[1]?.data)));
      expect(data).toMatchObject({
        v: 2,
        kind: "settled",
        id: "r1",
        status: "idle",
        stopReason: "gc",
        result: "task done",
        endedAt: expect.any(Number) as number,
      });
    });

    it("reportRecordTransition：[W1/D2 停写写点] 零 entry 追加（过程面改走事件文件通道）", () => {
      const { store, appended } = makeStoreWithPi();
      const r = makeRecord({ round: 1 });
      store.reportRecordTransition(r);

      // v1 快照 entry（turns/engineHandle 过程投影）停写——可观测面移交事件文件
      // （record-bound 帧引擎域感知，record-store-v2-journal.test.ts 覆盖）。
      expect(appended).toHaveLength(0);
    });

    it("pi 未注入（session_start 前）：三写点均安全降级不抛错", () => {
      const store = new RecordStore(tmpDir);
      const r = makeRecord();
      expect(() => store.register(r)).not.toThrow();
      expect(() => store.archive(r)).not.toThrow();
      expect(() => store.reportRecordTransition(r)).not.toThrow();
    });
  });

  // ============================================================
  // [PS-14/T7③] sessions-index 写失败可观测（warn 而非仅 debug）
  // ============================================================
  // flushIndexAfterScan 触发链：collectRecords 全量扫描（首扫 dirStamp===null）→
  // scanFile 探测置 indexDirty → 扫描尾 flush（lastIndexWriteAt=0 天然过 60s 节流窗）
  // → saveIndex（mock reject）→ .catch 恢复 dirty + warn。
  describe("PS-14: sessions-index 写失败可观测", () => {
    it("saveIndex reject → warn（不再仅 debug），detail 含 dir 与 error", async () => {
      saveIndexMock.mockRejectedValueOnce(new Error("EACCES: permission denied"));
      writeSessionJsonl(path.join(tmpDir, "sa-ps14.jsonl"), {
        id: "ps14",
        agent: "worker",
        mode: "background",
        task: "t",
        startedAt: 1000,
      });

      const store = new RecordStore(tmpDir);
      const records = store.collectRecords(100);
      expect(records).toHaveLength(1); // 扫描本身不受索引写失败影响

      // fire-and-forget saveIndex：等 .catch 执行
      await vi.waitFor(() => {
        expect(loggerMock.warn).toHaveBeenCalledWith(
          expect.stringContaining("sessions-index write failed"),
          expect.objectContaining({
            detail: expect.objectContaining({
              error: expect.stringContaining("EACCES: permission denied"),
            }),
          }),
        );
      });
      // 升级语义：warn 而非 debug（debug 层不再承载该信号）
      const debugIndexMsgs = loggerMock.debug.mock.calls.filter((c) =>
        String(c[0]).includes("sessions-index write failed"),
      );
      expect(debugIndexMsgs).toHaveLength(0);
    });

    it("saveIndex 成功 → 零 warn（正常路径不制造噪音）", async () => {
      writeSessionJsonl(path.join(tmpDir, "sa-ps14-ok.jsonl"), {
        id: "ps14ok",
        agent: "worker",
        mode: "background",
        task: "t",
        startedAt: 1000,
      });

      const store = new RecordStore(tmpDir);
      store.collectRecords(100);
      await vi.waitFor(() => expect(saveIndexMock).toHaveBeenCalled());

      const warnIndexMsgs = loggerMock.warn.mock.calls.filter((c) =>
        String(c[0]).includes("sessions-index write failed"),
      );
      expect(warnIndexMsgs).toHaveLength(0);
    });
  });
});

// ============================================================
// [U4/R4-D6③] model 水合往返：entry/manifest 读侧空串归一缺席
// （写侧 undefined 经 JSON 缺省落盘 → 重建仍 undefined；旧数据 "" 残留 → 归一
// undefined，不再以 `?? ""` 复活——「压掉 defaultModelSelection」的空串复活链切断）
// ============================================================
describe("model 水合往返（record-store-rebuild 读侧归一）", () => {
  // [登记 §3.3] entry 读侧通道已 v2 化（v1 全量快照重建 rebuildEntryRecord 已删）：
  // 身份域在注册条目，model 归终局域——有值时落 v2 终态条目携带；空串/缺席归一仍是
  // v2PairToRecord 内的 modelOrUndefined（R4/D6③ 空串复活链切断）。
  it.each([
    { label: "无 model（注册条目 + 无终态条目，新写侧缺席形态）", model: undefined, expected: undefined },
    { label: "model=\"\"（旧写侧空串残留）", model: "", expected: undefined },
    { label: "model 有值（显式留痕）", model: "prov/model-1", expected: "prov/model-1" },
  ])("entry 投影：$label → $expected", ({ model, expected }) => {
    const registered = v2RegisteredEntry(
      makeSubagentRecord({ id: "sa-model-roundtrip", rootSessionId: "sess-m" }),
    );
    const pair: V2EntryPair =
      model === undefined
        ? { registered }
        : {
            registered,
            settled: {
              ...v2SettledEntry(
                makeSubagentRecord({ id: "sa-model-roundtrip", rootSessionId: "sess-m", status: "idle", stopReason: "completed" }),
              ),
              model,
            },
          };
    const rec = v2PairToRecord("sa-model-roundtrip", pair);
    expect(rec).not.toBeNull();
    expect(rec?.model).toBe(expected);
  });

  it("manifest 投影：model 缺失/空串 → undefined；有值 → 透传", () => {
    const base: ManifestRecord = {
      id: "sa-mani-m",
      rootSessionId: "sess-m",
      agentName: "worker",
      status: "closed",
      createdAt: 1000,
      completedAt: 2000,
      task: "t",
      slug: "s",
    };
    expect(manifestToSubagent(base)?.model).toBeUndefined();
    expect(manifestToSubagent({ ...base, model: "" })?.model).toBeUndefined();
    expect(manifestToSubagent({ ...base, model: "prov/model-1" })?.model).toBe("prov/model-1");
  });
});

// ── [W1 / U2a] v2 写点断言段专属 helper（v2* 前缀防与上文重名）──────

function v2MakeRecord(over: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const base = createRecord("bg-v2", {
    agent: "worker",
    model: "m",
    mode: "background",
    task: "t",
    slug: "v2-journal",
    startedAt: 1000,
    rootSessionId: "sess-v2",
  });
  return { ...base, ...over };
}

function v2CapturePi(captured: unknown[]): { appendEntry: (customType: string, data: unknown) => void } {
  return {
    appendEntry: (customType: string, data: unknown) => {
      captured.push({ customType, data });
    },
  };
}

function v2ScanEvents(recordsDir: string, id: string): Promise<readonly RecordJournalEvent[]> {
  return createRecordEventJournal(recordsDir).scan(id);
}

function v2ReadEventLines(recordsDir: string, id: string): RecordJournalEvent[] {
  const content = fs.readFileSync(recordEventsPath(recordsDir, id), "utf8");
  const out: RecordJournalEvent[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    out.push(JSON.parse(trimmed) as RecordJournalEvent);
  }
  return out;
}

describe("record 写侧 v2：事件写点映射逐点（W1 D3 表对照）", () => {
  let rootDir: string;
  let sessionsDir: string;
  let recordsDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "record-v2-journal-"));
    sessionsDir = path.join(rootDir, "sessions");
    recordsDir = path.join(rootDir, "records");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(recordsDir, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  function makeStore(captured: unknown[] = []): RecordStore {
    const store = new RecordStore(sessionsDir, undefined, v2CapturePi(captured), recordsDir);
    return store;
  }

  it("register → record-created 帧 + v2 注册条目（同点双写：事件是事实、条目是锚）", async () => {
    const captured: unknown[] = [];
    const store = makeStore(captured);
    store.register(
      v2MakeRecord({ id: "sa-v2-reg", origin: "workflow", parentRunId: "run-1", stepIndex: 2 }),
    );

    const events = await v2ScanEvents(recordsDir, "sa-v2-reg");
    const created = events.find((e) => e.type === "record-created");
    expect(created).toMatchObject({
      type: "record-created",
      id: "sa-v2-reg",
      agent: "worker",
      origin: "workflow",
      parentRunId: "run-1",
      stepIndex: 2,
      rootSessionId: "sess-v2",
      depth: 0,
      mode: "background",
      startedAt: 1000,
    });

    // v2 注册条目：身份与锚点，无 turns/engineHandle 等运行态（D1 契约字段集）。
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      customType: "subagent-record",
      data: {
        v: 2,
        kind: "registered",
        id: "sa-v2-reg",
        origin: "workflow",
        parentRunId: "run-1",
        stepIndex: 2,
        rootSessionId: "sess-v2",
        startedAt: 1000,
      },
    });
    // 首行头行形态（D3：无 .jsonl 后缀的自描述补偿）。
    const firstLine = fs
      .readFileSync(recordEventsPath(recordsDir, "sa-v2-reg"), "utf8")
      .split("\n")[0]!;
    expect(JSON.parse(firstLine)).toEqual({ type: "record-events", id: "sa-v2-reg" });
  });

  it("register 幂等：revive / 重启后重注册不重复落 created 帧与注册条目", async () => {
    const captured: unknown[] = [];
    const storeA = makeStore(captured);
    storeA.register(v2MakeRecord({ id: "sa-v2-idem" }));

    // 模拟重启：全新 store 实例（fold 缓存空），同 id register（markResurrected → register 链）。
    const capturedB: unknown[] = [];
    const storeB = makeStore(capturedB);
    storeB.register(v2MakeRecord({ id: "sa-v2-idem" }));

    const events = await v2ScanEvents(recordsDir, "sa-v2-idem");
    expect(events.filter((e) => e.type === "record-created")).toHaveLength(1);
    expect(capturedB).toHaveLength(0); // 注册条目不重复写（journal 已有创建帧）
  });

  it("spawn 回填（reportRecordTransition 引擎域感知）→ record-bound 帧 + bound manifest 物化", async () => {
    const captured: unknown[] = [];
    const store = makeStore(captured);
    const rec = v2MakeRecord({ id: "sa-v2-bound", engine: "pi" });
    store.register(rec);

    // spawn 应答回填：sessionFile + engineHandle（writeBindingForRecord 之后的
    // reportRecordTransition 感知链）。
    const sessionFile = path.join(sessionsDir, "sa-v2-bound.jsonl");
    fs.writeFileSync(sessionFile, '{"type":"session","version":3}\n', "utf8"); // 锚定就绪（子文件在盘）
    rec.sessionFile = sessionFile;
    store.reportRecordTransition(rec);

    const events = await v2ScanEvents(recordsDir, "sa-v2-bound");
    expect(events.map((e) => e.type)).toEqual(["record-created", "record-bound"]);
    expect(events[1]).toMatchObject({
      type: "record-bound",
      sessionFile,
      engine: "pi",
      epoch: 0,
    });

    // bound manifest 物化（D2 决策 9）：running 投影落 records/<id>.json。
    const manifestPath = path.join(recordsDir, "sa-v2-bound.json");
    expect(fs.existsSync(manifestPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(manifestPath, "utf8") as string)).toMatchObject({
      id: "sa-v2-bound",
      status: "running",
      executionStatus: "running",
      sessionFile,
    });

    // 引擎域未变的重复 transition：零追加（高频 turns 归约不放大事件面）。
    store.reportRecordTransition(rec);
    const eventsAfter = await v2ScanEvents(recordsDir, "sa-v2-bound");
    expect(eventsAfter).toHaveLength(2);
  });

  it("markRoundStarted → record-round-started 帧；markRoundIdle → record-round-idle 帧（轮统计快照）", async () => {
    const store = makeStore();
    const rec = v2MakeRecord({ id: "sa-v2-round" });
    store.register(rec);
    const sessionFile = path.join(sessionsDir, "sa-v2-round.jsonl");
    fs.writeFileSync(sessionFile, '{"type":"session","version":3}\n', "utf8");
    rec.sessionFile = sessionFile;
    store.reportRecordTransition(rec);

    store.markRoundStarted("sa-v2-round");
    // 轮内 usage 累积（updateFromEvent 归约的近似——直接写字段等价）。
    rec.turnCount = 3;
    rec.totalTokens = 4200;
    store.markRoundIdle("sa-v2-round", { kind: "success", content: "round output" });

    const events = await v2ScanEvents(recordsDir, "sa-v2-round");
    expect(events.map((e) => e.type)).toEqual([
      "record-created",
      "record-bound",
      "record-round-started",
      "record-round-idle",
    ]);
    expect(events[2]).toMatchObject({ type: "record-round-started", round: 0, epoch: 0 });
    expect(events[3]).toMatchObject({
      type: "record-round-idle",
      stopReason: "completed",
      turns: 3,
      totalTokens: 4200,
    });

    // 轮终收条 = record-round-idle 帧（③：`.state` 已退场，收条不再落 sidecar）。
    expect(events[3]).toMatchObject({ type: "record-round-idle", stopReason: "completed" });
  });

  it("markSettled → record-settled 帧 + v2 终态条目；archive 真终局同款（endedAt 判定）", async () => {
    const captured: unknown[] = [];
    const store = makeStore(captured);
    const rec = v2MakeRecord({ id: "sa-v2-settled" });
    store.register(rec);
    const sessionFile = path.join(sessionsDir, "sa-v2-settled.jsonl");
    fs.writeFileSync(sessionFile, '{"type":"session","version":3}\n', "utf8");
    rec.sessionFile = sessionFile;
    store.reportRecordTransition(rec);
    rec.result = "final output text";

    store.markSettled(rec, "interrupted");

    let events = await v2ScanEvents(recordsDir, "sa-v2-settled");
    expect(events.map((e) => e.type)).toEqual([
      "record-created",
      "record-bound",
      "record-settled",
    ]);
    expect(events[2]).toMatchObject({
      type: "record-settled",
      stopReason: "interrupted",
      turns: 0,
      totalTokens: 0,
    });
    const settledEntry = captured.at(-1);
    expect(settledEntry).toMatchObject({
      customType: "subagent-record",
      data: {
        v: 2,
        kind: "settled",
        id: "sa-v2-settled",
        status: "idle",
        stopReason: "interrupted",
        sessionFile,
        result: "final output text",
      },
    });

    // 幂等：settled 后重复终局写点（archive 真终局）不再追加——fold settled 守卫。
    rec.endedAt = Date.now();
    store.archive(rec);
    events = await v2ScanEvents(recordsDir, "sa-v2-settled");
    expect(events.filter((e) => e.type === "record-settled")).toHaveLength(1);
  });

  it("archive 真终局（completeLegacyClosed 已冻结 endedAt）→ record-settled 帧；内存回收（endedAt 未设）零事件", async () => {
    const captured: unknown[] = [];
    const store = makeStore(captured);
    const rec = v2MakeRecord({ id: "sa-v2-arch" });
    store.register(rec);
    // completeLegacyClosed 桥接形态：冻结终局字段（含 endedAt）。
    rec.status = "idle";
    rec.stopReason = "completed";
    rec.outcome = "completed";
    rec.endedAt = 12345;
    rec.result = "done text";
    rec.turnCount = 2;
    rec.totalTokens = 300;
    store.archive(rec);

    const events = await v2ScanEvents(recordsDir, "sa-v2-arch");
    expect(events.map((e) => e.type)).toEqual(["record-created", "record-settled"]);
    expect(events[1]).toMatchObject({
      type: "record-settled",
      stopReason: "completed",
      outcome: "completed",
      endedAt: 12345,
      turns: 2,
      totalTokens: 300,
    });
    expect(captured.at(-1)).toMatchObject({
      data: { v: 2, kind: "settled", id: "sa-v2-arch", endedAt: 12345, turns: 2, totalTokens: 300, result: "done text" },
    });

    // 非终局 archive（endedAt 未设）：零事件零条目。
    const captured2: unknown[] = [];
    const store2 = makeStore(captured2);
    const rec2 = v2MakeRecord({ id: "sa-v2-evict" });
    store2.register(rec2);
    store2.archive(rec2);
    const events2 = await v2ScanEvents(recordsDir, "sa-v2-evict");
    expect(events2.map((e) => e.type)).toEqual(["record-created"]);
  });

  it("markReopened → record-reopened 帧（epoch 递增 + round 归零）；重开后 round-started 清除 settled", async () => {
    const store = makeStore();
    const rec = v2MakeRecord({ id: "sa-v2-reopen" });
    store.register(rec);
    const sessionFile = path.join(sessionsDir, "sa-v2-reopen.jsonl");
    fs.writeFileSync(sessionFile, '{"type":"session","version":3}\n', "utf8");
    rec.sessionFile = sessionFile;
    store.reportRecordTransition(rec);
    store.markSettled(rec, "completed");

    const newSessionFile = path.join(sessionsDir, "sa-v2-reopen-2.jsonl");
    fs.writeFileSync(newSessionFile, '{"type":"session","version":3}\n', "utf8");
    expect(
      store.markReopened(rec, { engine: "pi", sessionFile: newSessionFile }),
    ).toBe(true);

    let events = await v2ScanEvents(recordsDir, "sa-v2-reopen");
    expect(events.map((e) => e.type)).toEqual([
      "record-created",
      "record-bound",
      "record-settled",
      "record-reopened",
    ]);
    expect(events[3]).toMatchObject({ type: "record-reopened", epoch: 1, round: 0 });

    // 重开后的新轮：round-started 帧（fold 侧清除 settled——可续实体回边）。
    store.markRoundStarted("sa-v2-reopen");
    events = await v2ScanEvents(recordsDir, "sa-v2-reopen");
    expect(events.at(-1)).toMatchObject({ type: "record-round-started", round: 0, epoch: 1 });
  });

  it("seq 单调递增（record 侧对称断言）：全部事件行 seq 严格递增且自 1 起", async () => {
    const store = makeStore();
    const rec = v2MakeRecord({ id: "sa-v2-seq" });
    store.register(rec);
    const sessionFile = path.join(sessionsDir, "sa-v2-seq.jsonl");
    fs.writeFileSync(sessionFile, '{"type":"session","version":3}\n', "utf8");
    rec.sessionFile = sessionFile;
    store.reportRecordTransition(rec);
    store.markRoundStarted("sa-v2-seq");
    store.markRoundIdle("sa-v2-seq", { kind: "failed", reason: "boom" });
    // 下一轮在飞中断：round-started → markSettled（CAS 仅 running 可收口）。
    store.markRoundStarted("sa-v2-seq");
    store.markSettled(rec, "interrupted-by-parent");

    const events = v2ReadEventLines(recordsDir, "sa-v2-seq").filter(
      (e) => (e.type as string) !== "record-events",
    );
    // 事件行（排除头行后 6 条）seq = 1..6 严格递增。
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(events.map((e) => e.type)).toEqual([
      "record-created",
      "record-bound",
      "record-round-started",
      "record-round-idle",
      "record-round-started",
      "record-settled",
    ]);
  });

  it("验收②：主 session 新写 entry 无 eventLog/displayItems 字节", async () => {
    const captured: unknown[] = [];
    const store = makeStore(captured);
    const rec = v2MakeRecord({ id: "sa-v2-bytes" });
    store.register(rec);
    store.markRoundIdle("sa-v2-bytes", { kind: "success", content: "r" });
    rec.endedAt = Date.now();
    store.archive(rec);

    // 捕获的全部 subagent-record 条目（注册 + 终态）序列化产物不含死字节键。
    for (const { data } of captured as Array<{ customType: string; data: unknown }>) {
      if ((data as { kind?: string }).kind === undefined) continue;
      const serialized = JSON.stringify(data);
      expect(serialized).not.toContain("eventLog");
      expect(serialized).not.toContain("displayItems");
    }
    // 两条款恰两条（注册 + 终态）——markRoundIdle 等过程写点零条目。
    expect(captured).toHaveLength(2);
  });
});

// ============================================================
// created 事件自承载绑定侧独有字段（.record-binding 退场的前置）
// ============================================================

describe("record-created 帧承载绑定侧独有字段（model / thinkingLevel / worktree）", () => {
  let fieldRoot: string;
  let fieldSessions: string;
  let fieldRecords: string;

  beforeEach(() => {
    fieldRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sa-created-fields-"));
    fieldSessions = path.join(fieldRoot, "sessions");
    fieldRecords = path.join(fieldRoot, "records");
    fs.mkdirSync(fieldSessions, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(fieldRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  function makeStoreForFields(): RecordStore {
    return new RecordStore(fieldSessions, undefined, v2CapturePi([]), fieldRecords);
  }

  it("指定模型/档位且启用 worktree → 三个字段进 created 帧", async () => {
    const store = makeStoreForFields();
    store.register(
      v2MakeRecord({
        id: "sa-v2-fields",
        model: "prov/model-a",
        thinkingLevel: "xhigh",
        hadWorktree: true,
      }),
    );

    const created = (await v2ScanEvents(fieldRecords, "sa-v2-fields")).find(
      (e) => e.type === "record-created",
    );
    expect(created).toMatchObject({
      type: "record-created",
      model: "prov/model-a",
      thinkingLevel: "xhigh",
      worktree: true,
    });
  });

  it("未指定模型/档位、未启用 worktree → 不落键（缺省语义，不写空值）", async () => {
    const store = makeStoreForFields();
    store.register(v2MakeRecord({ id: "sa-v2-fields-empty", model: undefined }));

    const created = (await v2ScanEvents(fieldRecords, "sa-v2-fields-empty")).find(
      (e) => e.type === "record-created",
    ) as Record<string, unknown> | undefined;
    expect(created).toBeDefined();
    expect(created).not.toHaveProperty("model");
    expect(created).not.toHaveProperty("thinkingLevel");
    expect(created).not.toHaveProperty("worktree");
  });
});

// ============================================================
// 折叠 → 终态收条投影（.state sidecar 退场的桥，① 读侧换源）
// ============================================================

describe("stateMarkerFromFold（折叠状态 → 终态收条）", () => {
  const idleEvent = {
    type: "record-round-idle" as const,
    seq: 2,
    ts: 2000,
    stopReason: "completed" as const,
    turns: 1,
    totalTokens: 10,
  };
  const settledEvent = {
    type: "record-settled" as const,
    seq: 3,
    ts: 3000,
    stopReason: "completed" as const,
    endedAt: 3000,
    turns: 1,
    totalTokens: 10,
  };

  it("settled 在场 → 终局收条（reason/endedAt 取 settled）", () => {
    const fold = foldRecordJournalEvents([idleEvent, settledEvent]);
    expect(stateMarkerFromFold(fold)).toEqual({
      status: "idle",
      reason: "completed",
      endedAt: 3000,
    });
  });

  it("仅 round-idle 在场 → 轮终收条（endedAt 取该事件时间）", () => {
    const fold = foldRecordJournalEvents([idleEvent]);
    expect(stateMarkerFromFold(fold)).toEqual({
      status: "idle",
      reason: "completed",
      endedAt: 2000,
    });
  });

  it("轮终收条之后又有轮开始 → undefined（续轮记录不继承上一轮停因）", () => {
    const fold = foldRecordJournalEvents([
      idleEvent,
      { type: "record-round-started", seq: 3, ts: 3000, round: 2, epoch: 0 },
    ]);
    expect(stateMarkerFromFold(fold)).toBeUndefined();
  });

  it("无收条事件 / 无折叠 → undefined（在途中断，与 sidecar 缺席同语义）", () => {
    expect(stateMarkerFromFold(undefined)).toBeUndefined();
    expect(stateMarkerFromFold(foldRecordJournalEvents([]))).toBeUndefined();
  });
});
