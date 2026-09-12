// src/__tests__/record-store-intent-api.test.ts
//
// [U1 / record 持久化收敛 §3.1] RecordStore 意图级操作 API 立面专属测试。
//
// 覆盖（验收条款 A1/A2/A5/A6）：
//   - A1 十意图原语齐备（register/appendEvent/markRoundStarted/markRoundIdle/
//     markFinalized/markCancelled/markBatchFinalized/adoptEngineDeath/
//     markResurrected/markIdleArchived）+ acquireWriteLease（A6）；
//   - A2 终态写序（D8 v7）：`.state` writeSync 先 → entry/archive → manifest
//     writeSync → `.alive` 删除；markBatchFinalized barrier（manifest 落盘完成
//     先于批通知写账）；markRoundIdle 簿记⑦ `.alive` 保留；markIdleArchived
//     archive 先 release 后（archive 抛错 marker 必未删）；
//   - A5 markResurrected D3c 三中间形态（(ii) acquire 后中断 / (iii) 全成 /
//     acquire 失败）+ running 候选接管形态（跳删终态位仍 acquire）；
//   - §3.4 失败语义：`.state` 写失败 → 零持久化副作用、record 留 running 形态。
//
// 手法：state-marker / alive-store partial mock（包装真实实现并记录调用序）+
// manifestDir 真实落盘断言「写后即刻可见」（无 fire-and-forget）。fixture 一律
// mkdtempSync 自建自删（tmpdir），不触碰真实数据目录。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 跨模块调用序记录（A2 写序断言锚）+ release 时点探针。
const { order, probe } = vi.hoisted(() => ({
  order: [] as string[],
  probe: {
    manifestPath: undefined as string | undefined,
    manifestExistedAtRelease: undefined as boolean | undefined,
  },
}));

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({
  getLogger: () => loggerMock,
}));

// state-marker partial mock：写函数包装真实实现并记录调用序。
vi.mock("../state-marker.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state-marker.ts")>();
  return {
    ...actual,
    writeFinalizedState: vi.fn((sessionFile: string, reason?: string) => {
      order.push("state-finalized");
      return actual.writeFinalizedState(sessionFile, reason);
    }),
    writeCancelledState: vi.fn((sessionFile: string, endedAt: number) => {
      order.push("state-cancelled");
      return actual.writeCancelledState(sessionFile, endedAt);
    }),
  };
});

// alive-store partial mock：acquire/release 包装真实实现并记录调用序；release
// 时点探测 manifest 是否已落盘（A2「.state 先 → manifest 后 → .alive 删」断言）。
vi.mock("../alive-store.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../alive-store.ts")>();
  const nodeFs = await import("node:fs");
  return {
    ...actual,
    writeAliveMarker: vi.fn((sessionFile: string, marker: Parameters<typeof actual.writeAliveMarker>[1]) => {
      order.push("alive-acquire");
      return actual.writeAliveMarker(sessionFile, marker);
    }),
    removeAliveMarker: vi.fn((sessionFile: string) => {
      order.push("alive-release");
      if (probe.manifestPath !== undefined) {
        probe.manifestExistedAtRelease = nodeFs.existsSync(probe.manifestPath);
      }
      return actual.removeAliveMarker(sessionFile);
    }),
  };
});

// node:fs partial mock：rmSync 可注错（D3c (ii) 删终态位失败注入），其余真实。
type RmSyncFn = typeof import("node:fs").rmSync;
const { rmSyncMock, actualRmRef } = vi.hoisted(() => ({
  rmSyncMock: vi.fn(),
  actualRmRef: { current: undefined as RmSyncFn | undefined },
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  actualRmRef.current = actual.rmSync;
  return {
    ...actual,
    rmSync: rmSyncMock,
    default: { ...actual, rmSync: rmSyncMock },
  };
});

import { writeAliveMarker, readAliveMarker } from "../alive-store.ts";
import * as stateMarker from "../state-marker.ts";
import { createRecord, tryTransition } from "../execution-record.ts";
import { RecordStore } from "../record-store.ts";
import type { ExecutionRecord, SubagentRecord } from "../types.ts";

/** 构造 ExecutionRecord（running 基线，over 覆盖）。 */
function makeRecord(id: string, over: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const base = createRecord(id, {
    agent: "worker",
    model: "m",
    mode: "background",
    task: "t",
    slug: "intent-api",
    startedAt: 1000,
    rootSessionId: "sess-current",
    chatMode: false,
  });
  return { ...base, ...over };
}

/** 批成员 SubagentRecord 最小合法形状。 */
function makeSubagentRecord(id: string, over: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    id,
    agent: "worker",
    task: "batch task",
    slug: "batch",
    status: "running",
    mode: "background",
    startedAt: 1_700_000_000_000,
    rootSessionId: "sess-current",
    parentRecordId: undefined,
    depth: 0,
    endedAt: undefined,
    turns: 0,
    totalTokens: 0,
    model: "test/model-a",
    thinkingLevel: undefined,
    eventLog: [],
    displayItems: [],
    ...over,
  };
}

describe("RecordStore 意图 API 立面（U1 A1/A2/A5/A6）", () => {
  let tmpDir: string;
  let sessionsDir: string;
  let manifestDir: string;
  let sessionFile: string;
  /** Pi appendEntry mock（显式签名：可作 RecordStorePi 直传 + 断言面可用）。 */
  let appendEntryMock: ReturnType<typeof vi.fn<(customType: string, data: unknown) => void>>;
  let store: RecordStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "record-store-intent-api-"));
    sessionsDir = path.join(tmpDir, "sessions");
    manifestDir = path.join(tmpDir, "records");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(manifestDir, { recursive: true });
    sessionFile = path.join(sessionsDir, "2026-01-01_uuid.jsonl");
    appendEntryMock = vi.fn<(customType: string, data: unknown) => void>();
    store = new RecordStore(sessionsDir, undefined, { appendEntry: appendEntryMock }, manifestDir);
    order.length = 0;
    probe.manifestPath = undefined;
    probe.manifestExistedAtRelease = undefined;
    loggerMock.error.mockClear();
    loggerMock.warn.mockClear();
    // rmSync 基线 = 真实实现（个别用例注错覆盖）。
    if (actualRmRef.current !== undefined) {
      rmSyncMock.mockReset().mockImplementation(actualRmRef.current);
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    vi.restoreAllMocks();
  });

  const manifestPathOf = (id: string): string => path.join(manifestDir, `${id}.json`);

  const readManifestJson = (id: string): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(manifestPathOf(id), "utf-8")) as Record<string, unknown>;

  // ============================================================
  // A1 十原语齐备
  // ============================================================
  describe("A1 意图原语立面", () => {
    it("十意图原语 + store 内部 acquire 动作齐备", () => {
      const fns = [
        "register",
        "appendEvent",
        "markRoundStarted",
        "markRoundIdle",
        "markFinalized",
        "markCancelled",
        "markBatchFinalized",
        "adoptEngineDeath",
        "markResurrected",
        "markIdleArchived",
        "acquireWriteLease", // A6
      ] as const;
      for (const name of fns) {
        expect(typeof store[name], `primitive ${name}`).toBe("function");
      }
    });
  });

  // ============================================================
  // A2 markFinalized / markCancelled 写序（D8 v7）
  // ============================================================
  describe("markFinalized（A2 写序 + §3.4 失败语义）", () => {
    it("写序 = .state 先 → entry/archive → manifest writeSync → .alive 删；写后即刻可见", () => {
      const record = makeRecord("bg-1");
      record.sessionFile = sessionFile;
      store.acquireWriteLease(sessionFile, "bg-1"); // 持有期写权声明（release 前置形态）
      store.register(record);
      tryTransition(record, "closed", "user-close");
      record.endedAt = 5000;
      probe.manifestPath = manifestPathOf("bg-1");

      expect(store.markFinalized(record, "user-close")).toBe(true);

      // 写序：.state → .alive release（顺序数组中两者先后可证）。
      expect(order).toEqual(["alive-acquire", "state-finalized", "alive-release"]);
      // release 时点 manifest 已落盘（.state 先 → manifest 后 → .alive 删）。
      expect(probe.manifestExistedAtRelease).toBe(true);
      // 写后即刻可见（同步写，无 fire-and-forget）。
      expect(JSON.parse(fs.readFileSync(`${sessionFile}.state`, "utf-8"))).toEqual({
        status: "finalized",
        reason: "user-close",
      });
      expect(fs.existsSync(`${sessionFile}.alive`)).toBe(false);
      // manifest 投影（同步落盘）。
      expect(readManifestJson("bg-1")).toMatchObject({
        id: "bg-1",
        status: "closed",
        closedReason: "user-close",
        agentName: "worker",
        completedAt: 5000,
      });
      // archive：内存移除 + 终态 entry 落盘。
      expect(store.getMutable("bg-1")).toBeUndefined();
      expect(appendEntryMock).toHaveBeenCalledWith(
        "subagent-record",
        expect.objectContaining({ id: "bg-1", status: "closed" }),
      );
    });

    it(".state 写失败（重试耗尽）→ 返回 false、零持久化副作用、record 留 running 形态", () => {
      const record = makeRecord("bg-2");
      record.sessionFile = sessionFile;
      store.acquireWriteLease(sessionFile, "bg-2");
      store.register(record);
      tryTransition(record, "closed", "user-close");
      appendEntryMock.mockClear();

      vi.mocked(stateMarker.writeFinalizedState).mockReturnValueOnce(false);

      expect(store.markFinalized(record, "user-close")).toBe(false);
      // 零持久化副作用：不归档（内存仍在）、无 manifest、写权声明未 release、无终态 entry。
      expect(store.getMutable("bg-2")).toBeDefined();
      expect(fs.existsSync(manifestPathOf("bg-2"))).toBe(false);
      expect(fs.existsSync(`${sessionFile}.alive`)).toBe(true);
      // `.state` 写尝试确实发生（mockReturnValueOnce 短路包装层，顺序 token 不入 order，
      // 以调用事实为准）；且其后无任何后续写动作（alive-release 未入 order）。
      expect(stateMarker.writeFinalizedState).toHaveBeenCalledWith(sessionFile, "user-close");
      expect(order).toEqual(["alive-acquire"]);
      expect(appendEntryMock).not.toHaveBeenCalled();
    });

    it("sessionFile 缺失 → .state 面跳过（warn 留痕），manifest/entry 照常", () => {
      const record = makeRecord("bg-3");
      store.register(record);
      tryTransition(record, "closed", "gc");

      expect(store.markFinalized(record, "gc")).toBe(true);
      expect(loggerMock.warn).toHaveBeenCalled();
      expect(fs.existsSync(manifestPathOf("bg-3"))).toBe(true);
      expect(store.getMutable("bg-3")).toBeUndefined();
    });
  });

  describe("markCancelled（A2 写序 + tombstone）", () => {
    it("tombstone endedAt 落 .state；写序/manifest 同 markFinalized", () => {
      const record = makeRecord("bg-c1");
      record.sessionFile = sessionFile;
      store.register(record);
      store.acquireWriteLease(sessionFile, "bg-c1");
      tryTransition(record, "closed", "cancelled");
      record.endedAt = 7777;
      probe.manifestPath = manifestPathOf("bg-c1");

      expect(store.markCancelled(record)).toBe(true);

      expect(order).toEqual(["alive-acquire", "state-cancelled", "alive-release"]);
      expect(probe.manifestExistedAtRelease).toBe(true);
      expect(JSON.parse(fs.readFileSync(`${sessionFile}.state`, "utf-8"))).toEqual({
        status: "cancelled",
        endedAt: 7777,
      });
      expect(readManifestJson("bg-c1")).toMatchObject({ id: "bg-c1", status: "closed", closedReason: "cancelled" });
      expect(fs.existsSync(`${sessionFile}.alive`)).toBe(false);
    });

    it(".state 写失败 → 返回 false、tombstone 未落、record 不归档", () => {
      const record = makeRecord("bg-c2");
      record.sessionFile = sessionFile;
      store.register(record);
      tryTransition(record, "closed", "cancelled");

      vi.mocked(stateMarker.writeCancelledState).mockReturnValueOnce(false);

      expect(store.markCancelled(record)).toBe(false);
      expect(fs.existsSync(`${sessionFile}.state`)).toBe(false);
      expect(store.getMutable("bg-c2")).toBeDefined();
    });
  });

  // ============================================================
  // A2 markBatchFinalized barrier
  // ============================================================
  describe("markBatchFinalized（barrier：manifest 落盘先于批通知写账）", () => {
    it("entry 写账时点全部成员 manifest 均已落盘；落标 entry 携带 collectMode/batchFinalized", async () => {
      const members = [makeSubagentRecord("sa-m1"), makeSubagentRecord("sa-m2")];
      // 写账时点断言 barrier：appendEntry 被调时该成员 manifest 必已存在。
      appendEntryMock.mockImplementation((_type: string, data: unknown) => {
        const d = data as { id?: string };
        if (typeof d?.id === "string") {
          expect(fs.existsSync(manifestPathOf(d.id)), `manifest of ${d.id} at entry time`).toBe(true);
        }
      });

      await store.markBatchFinalized(members);

      expect(appendEntryMock).toHaveBeenCalledTimes(2);
      expect(appendEntryMock).toHaveBeenCalledWith(
        "subagent-record",
        expect.objectContaining({ id: "sa-m1", collectMode: "sync", batchFinalized: true }),
      );
      // manifest status 如实投影（成功成员此刻 running+resumable）。
      expect(readManifestJson("sa-m1")).toMatchObject({ id: "sa-m1", status: "running" });
      expect(readManifestJson("sa-m2")).toMatchObject({ id: "sa-m2", status: "running" });
    });
  });

  // ============================================================
  // A2 markRoundStarted / markRoundIdle 簿记
  // ============================================================
  describe("markRoundStarted（轮始重置：字段①②⑤）", () => {
    it("status=running + result/resumable 清除 + entry 上报", () => {
      const record = makeRecord("chat-1", { chatMode: true });
      record.result = "prev round";
      record.resumable = true;
      store.register(record);
      appendEntryMock.mockClear();

      expect(store.markRoundStarted("chat-1")).toBe(true);
      expect(record.status).toBe("running");
      expect(record.result).toBeUndefined();
      expect(record.resumable).toBeUndefined();
      expect(appendEntryMock).toHaveBeenCalledWith(
        "subagent-record",
        expect.objectContaining({ id: "chat-1" }),
      );
    });

    it("id 不在内存 → false 无副作用", () => {
      expect(store.markRoundStarted("nope")).toBe(false);
    });
  });

  describe("markRoundIdle（簿记全集①-⑨；簿记⑦ .alive 保留）", () => {
    it("成功轮：result=content、round+1、closedReason 清、resumable=true、idleSince 刷新、注销②、entry 携带新 round", () => {
      const record = makeRecord("chat-2", { chatMode: true, round: 1 });
      record.closedReason = "gc"; // [S10]：前置残留不清则泄漏进 list 投影
      record.sessionFile = sessionFile;
      store.register(record);
      store.acquireWriteLease(sessionFile, "chat-2");
      const unregister = vi.fn();
      store.setPendingUnregister(unregister);
      appendEntryMock.mockClear();
      order.length = 0;

      expect(store.markRoundIdle("chat-2", { kind: "success", content: "round done" })).toBe(true);

      expect(record.status).toBe("running"); // ① 保持 running（非 idle）
      expect(record.result).toBe("round done"); // ②
      expect(record.round).toBe(2); // ③
      expect(record.closedReason).toBeUndefined(); // ④
      expect(record.resumable).toBe(true); // ⑤
      expect(record.idleSince).toBeGreaterThan(0); // ⑥
      expect(order).toEqual([]); // ⑦ `.alive` 保留——无 release 动作
      expect(fs.existsSync(`${sessionFile}.alive`)).toBe(true); // ⑦ 落盘面仍持声明
      expect(unregister).toHaveBeenCalledWith("chat-2", "running"); // ⑧ 发射点②
      expect(appendEntryMock).toHaveBeenCalledWith(
        "subagent-record",
        expect.objectContaining({ id: "chat-2", round: 2, result: "round done" }), // ⑨
      );
    });

    it("失败轮：lastError 写原因、result=前值??失败摘要", () => {
      const record = makeRecord("chat-3", { chatMode: true, round: 0 });
      store.register(record);

      expect(store.markRoundIdle("chat-3", { kind: "failed", reason: "engine boom" })).toBe(true);
      expect(record.lastError).toBe("engine boom"); // ⑨ lastError 归口
      expect(record.result).toBe("round did not complete: engine boom"); // ② 首轮失败无前值
    });

    it("终态簿记已冻结（endedAt 已设）→ fail-fast 抛错", () => {
      const record = makeRecord("chat-4");
      record.endedAt = 123; // completeRecord 已跑的冻结判据
      store.register(record);

      expect(() => store.markRoundIdle("chat-4", { kind: "success", content: "x" })).toThrow(
        /terminal bookkeeping already frozen/,
      );
    });

    it("id 不在内存 → false 无副作用", () => {
      expect(store.markRoundIdle("nope", { kind: "success", content: "x" })).toBe(false);
    });
  });

  // ============================================================
  // appendEvent / adoptEngineDeath（过程原语）
  // ============================================================
  describe("appendEvent / adoptEngineDeath", () => {
    it("appendEvent：事件归约进 turns + entry 变迁上报；id 不在内存 → false", () => {
      const record = makeRecord("ev-1");
      store.register(record);
      appendEntryMock.mockClear();

      expect(store.appendEvent("ev-1", { type: "text_delta", delta: "hi" })).toBe(true);
      expect(record.turns[0]?.text).toBe("hi"); // ⑧ turns 归约
      expect(appendEntryMock).toHaveBeenCalledTimes(1);
      expect(store.appendEvent("nope", { type: "text_delta", delta: "x" })).toBe(false);
    });

    it("adoptEngineDeath：error/result/resumable 三写 + entry；id 不在内存 → false", () => {
      const record = makeRecord("adopt-1");
      record.result = "partial";
      store.register(record);
      appendEntryMock.mockClear();

      expect(store.adoptEngineDeath("adopt-1", { error: "engine crashed" })).toBe(true);
      expect(record.error).toBe("engine crashed"); // ⑩
      expect(record.result).toBeUndefined();
      expect(record.resumable).toBe(true); // ⑤ 收养
      expect(appendEntryMock).toHaveBeenCalledWith(
        "subagent-record",
        expect.objectContaining({ id: "adopt-1", resumable: true }),
      );
      expect(store.adoptEngineDeath("nope", { error: "x" })).toBe(false);
    });
  });

  // ============================================================
  // A5 markResurrected（D3c：acquire-first + 单 try 域 + 三中间形态）
  // ============================================================
  describe("markResurrected（A5 D3c）", () => {
    const makeClosedCandidate = (id: string): ExecutionRecord => {
      const record = makeRecord(id);
      record.sessionFile = sessionFile;
      tryTransition(record, "closed", "parent-shutdown");
      record.endedAt = 4000;
      return record;
    };

    it("(iii) 全成：acquire marker(pid=本进程) → .state/.finalized 删 → 内存翻回 + register", () => {
      // 磁盘预置终态位（现行载体 + legacy）。
      fs.writeFileSync(`${sessionFile}.state`, JSON.stringify({ status: "finalized", reason: "parent-shutdown" }));
      fs.writeFileSync(`${sessionFile}.finalized`, "parent-shutdown");
      const record = makeClosedCandidate("rs-1");
      order.length = 0;

      store.markResurrected(record, true);

      expect(order).toEqual(["alive-acquire"]); // acquire-first：声明先于终态位删除
      expect(readAliveMarker(sessionFile)).toMatchObject({ pid: process.pid, id: "rs-1" });
      expect(fs.existsSync(`${sessionFile}.state`)).toBe(false);
      expect(fs.existsSync(`${sessionFile}.finalized`)).toBe(false);
      expect(record.status).toBe("running"); // resurrectClosed 内存翻回
      expect(record.closedReason).toBeUndefined();
      expect(store.getMutable("rs-1")).toBe(record); // register
    });

    it("(iii) pre-L4 legacy：仅 .cancelled 终态（无 .state/.finalized）→ resurrect 后 readStateMarker undefined（live ≡ reload）", () => {
      // 存量形态：L4 合并前 writeCancelledTombstone 的旧名 tombstone（单行 JSON +
      // 换行），readStateMarker 在 .state 缺失时回退认领——resurrect 必须一并删除，
      // 否则磁盘终态位未真正翻转（重建 cancelled 与内存 running 不一致）。
      fs.writeFileSync(
        `${sessionFile}.cancelled`,
        `${JSON.stringify({ id: "rs-legacy", status: "cancelled", agent: "worker", startedAt: 1000, endedAt: 4000 })}\n`,
      );
      expect(stateMarker.readStateMarker(sessionFile)).toMatchObject({ status: "cancelled", endedAt: 4000 }); // 前置：旧名回退可读
      const record = makeClosedCandidate("rs-legacy");

      store.markResurrected(record, true);

      expect(stateMarker.readStateMarker(sessionFile)).toBeUndefined(); // 磁盘终态位真正翻转
      expect(record.status).toBe("running"); // 内存翻回
      expect(store.getMutable("rs-legacy")).toBe(record); // register
    });

    it("(ii) acquire 后删终态位失败 → 响亮抛错：marker 已写、.state 仍在、内存无半态", () => {
      fs.writeFileSync(`${sessionFile}.state`, JSON.stringify({ status: "finalized", reason: "parent-shutdown" }));
      const record = makeClosedCandidate("rs-2");
      rmSyncMock.mockImplementationOnce(() => {
        throw new Error("simulated EACCES");
      });

      expect(() => store.markResurrected(record, true)).toThrow(/write-lease acquire\/terminal-position flip failed/);
      expect(readAliveMarker(sessionFile)).toMatchObject({ pid: process.pid }); // acquire 已成
      expect(fs.existsSync(`${sessionFile}.state`)).toBe(true); // 终态位未删（旧形态保持）
      expect(store.getMutable("rs-2")).toBeUndefined(); // 内存无半态（未 register）
      expect(loggerMock.error).toHaveBeenCalled();
    });

    it("acquire 失败（写 .alive 抛错）→ 响亮抛错：终态位未动、未注册（禁止吞错续跑）", () => {
      fs.writeFileSync(`${sessionFile}.state`, JSON.stringify({ status: "finalized", reason: "parent-shutdown" }));
      const record = makeClosedCandidate("rs-3");
      const aliveMock = vi.mocked(writeAliveMarker);
      aliveMock.mockImplementationOnce(() => {
        throw new Error("simulated ENOSPC");
      });

      expect(() => store.markResurrected(record, true)).toThrow(/acquire\/terminal-position flip failed/);
      expect(fs.existsSync(`${sessionFile}.state`)).toBe(true); // acquire-first：失败时终态位未删
      expect(fs.existsSync(`${sessionFile}.alive`)).toBe(false);
      expect(store.getMutable("rs-3")).toBeUndefined();
      expect(loggerMock.error).toHaveBeenCalled();
    });

    it("running 候选接管（wasClosed=false）→ 跳过删终态位、仍 acquire 声明", () => {
      fs.writeFileSync(`${sessionFile}.state`, JSON.stringify({ status: "finalized", reason: "parent-shutdown" }));
      const record = makeRecord("rs-4");
      record.sessionFile = sessionFile;
      order.length = 0;

      store.markResurrected(record, false);

      expect(order).toEqual(["alive-acquire"]);
      expect(fs.existsSync(`${sessionFile}.state`)).toBe(true); // 不删终态位（running 形态无 .state 可删）
      expect(readAliveMarker(sessionFile)).toMatchObject({ pid: process.pid, id: "rs-4" }); // 接管即声明
      expect(store.getMutable("rs-4")).toBe(record);
    });

    it("sessionFile 缺失 → 响亮抛错（无锚点无法声明写权）", () => {
      const record = makeRecord("rs-5"); // 无 sessionFile
      expect(() => store.markResurrected(record, true)).toThrow(/no sessionFile anchor/);
      expect(store.getMutable("rs-5")).toBeUndefined();
    });
  });

  // ============================================================
  // A2 markIdleArchived（archive 先、release 后）
  // ============================================================
  describe("markIdleArchived（A2 写序）", () => {
    it("归档成功 → 内存移除 + .alive release（磁盘仍 running 可接管，不写 .state）", () => {
      const record = makeRecord("idle-1");
      record.sessionFile = sessionFile;
      store.register(record);
      store.acquireWriteLease(sessionFile, "idle-1");
      order.length = 0;

      store.markIdleArchived(record);

      expect(store.getMutable("idle-1")).toBeUndefined(); // archive 先
      expect(order).toEqual(["alive-release"]); // release 后
      expect(fs.existsSync(`${sessionFile}.alive`)).toBe(false);
      expect(fs.existsSync(`${sessionFile}.state`)).toBe(false); // 非终态化
    });

    it("archive 抛错 → 原语整体失败、marker 必未删（持有与声明一致）", () => {
      const record = makeRecord("idle-2");
      record.sessionFile = sessionFile;
      store.register(record);
      store.acquireWriteLease(sessionFile, "idle-2");
      const archiveSpy = vi.spyOn(store, "archive").mockImplementationOnce(() => {
        throw new Error("archive boom");
      });

      expect(() => store.markIdleArchived(record)).toThrow(/archive boom/);
      expect(fs.existsSync(`${sessionFile}.alive`)).toBe(true); // marker 未删
      expect(archiveSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // A6 acquireWriteLease（store 内部 acquire 动作）
  // ============================================================
  describe("acquireWriteLease（A6）", () => {
    it("写 .alive 声明（pid=本进程）——spawn 侧 sessionFile 回填挂钩锚", () => {
      store.acquireWriteLease(sessionFile, "bg-lease");
      expect(readAliveMarker(sessionFile)).toMatchObject({ pid: process.pid, id: "bg-lease" });
    });

    it("写失败原样上抛（响亮，禁止 best-effort 吞错）", () => {
      const badPath = path.join(tmpDir, "nonexistent-sub", "s.jsonl");
      expect(() => store.acquireWriteLease(badPath, "bg-lease2")).toThrow();
    });
  });
});
