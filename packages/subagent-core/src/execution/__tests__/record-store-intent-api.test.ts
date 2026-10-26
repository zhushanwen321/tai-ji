// src/__tests__/record-store-intent-api.test.ts
//
// [U1 / record 持久化收敛 §3.1] RecordStore 意图级操作 API 对外接口专属测试。
//
// 覆盖（验收条款 A1/A5/A6）：
//   - A1 八意图原语齐备（register/appendEvent/markRoundStarted/markRoundIdle/
//     markFinalized/markCancelled/markResurrected/markSettledOut，
//     [collect 退役] 原 markBatchFinalized 已删；[u-arch] 原 markArchived 更名
//     markSettledOut 随意图机制退役收尾；[subagent-observability u3 退役] 原
//     adoptEngineDeath 已随判定事实化删除，同下方 fns 数组注记口径）
//     + acquireWriteLease（A6）；
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

// alive-store partial mock：acquire/release 包装真实实现并记录调用序；release
// 时点探测 manifest 是否已落盘（A2「.state 先 → manifest 后 → .alive 删」断言）。
vi.mock("../persistence/alive-store.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../persistence/alive-store.ts")>();
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
  // [round5-g 合并说明] 默认转发真实 rmSync——本文件 beforeEach 会重设实现（注错用例
  // 覆写），其余节（manifest-fallback / round-idle-settle）不感知本 mock。
  rmSyncMock.mockImplementation(actual.rmSync);
  return {
    ...actual,
    rmSync: rmSyncMock,
    default: { ...actual, rmSync: rmSyncMock },
  };
});

import { writeAliveMarker, readAliveMarker } from "../persistence/alive-store.ts";
import { createRecord, resurrectClosed, trySettleLegacyClosed } from "../persistence/execution-record.ts";
import { readRecordBinding, zcodeAnchorBasePath } from "../persistence/state-marker.ts";
import { RecordStore } from "../persistence/record-store.ts";
import type { ExecutionRecord } from "../domain/record-model.ts";
import type { SubagentRecord } from "../assembly/types.ts";

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

describe("RecordStore 意图 API 对外接口（U1 A1/A2/A5/A6）", () => {
  let tmpDir: string;
  let sessionsDir: string;
  let manifestDir: string;
  let sessionFile: string;
  /** Pi appendEntry mock（显式签名：可作 RecordStorePi 直传 + 断言范围可用）。 */
  let appendEntryMock: ReturnType<typeof vi.fn<(customType: string, data: unknown) => void>>;
  let store: RecordStore;

  /** 终态收条读取（③：`.state` 退场，收条 = 事件流最后一条 record-settled 帧）。 */
  function lastSettledEvent(
    recordsDir: string,
    id: string,
  ): { stopReason?: string; endedAt?: number } | undefined {
    const file = path.join(recordsDir, `${id}.events`);
    if (!fs.existsSync(file)) return undefined;
    return fs
      .readFileSync(file, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type?: string; stopReason?: string; endedAt?: number })
      .filter((e) => e.type === "record-settled")
      .at(-1);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "record-store-intent-api-"));
    sessionsDir = path.join(tmpDir, "sessions");
    manifestDir = path.join(tmpDir, "records");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(manifestDir, { recursive: true });
    sessionFile = path.join(sessionsDir, "2026-01-01_uuid.jsonl");
    appendEntryMock = vi.fn<(customType: string, data: unknown) => void>();
    store = new RecordStore(() => sessionsDir, undefined, { appendEntry: appendEntryMock }, () => manifestDir);
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

  /** [W1/D3] 事件文件末条事件行（观察侧独立于被测 store——直读 .events 文件）。 */
  const lastJournalEvent = (dir: string, id: string): Record<string, unknown> | undefined => {
    try {
      const lines = fs
        .readFileSync(path.join(dir, `${id}.events`), "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      return lines.filter((e) => e.type !== "record-journal").at(-1);
    } catch {
      return undefined;
    }
  };

  const readManifestJson = (id: string): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(manifestPathOf(id), "utf-8")) as Record<string, unknown>;

  // ============================================================
  // A1 十原语齐备
  // ============================================================
  describe("A1 意图原语的对外接口", () => {
    it("九意图原语 + store 内部 acquire 动作齐备（[collect 退役] markBatchFinalized 原语已删）", () => {
      const fns = [
        "register",
        "appendEvent",
        "markRoundStarted",
        "markRoundIdle",
        "markFinalized",
        "markCancelled",
        // [subagent-observability u3 退役] adoptEngineDeath 已随判定事实化删除——
        // 引擎死亡走正常轮终（退出码非 0 → error 停因），W4 死亡纳管态写点退役。
        "markResurrected",
        "markSettledOut",
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
      trySettleLegacyClosed(record, "user-close");
      record.endedAt = 5000;
      probe.manifestPath = manifestPathOf("bg-1");

      expect(store.markFinalized(record, "user-close")).toBe(true);

      // 写序：写权声明 → 终态写入 journal 记录（事件/entry/manifest）→ .alive release
      //（③ 后 `.state` 不再是写序中的一环）。
      expect(order).toEqual(["alive-acquire", "alive-release"]);
      // release 时点 manifest 已落盘（.state 先 → manifest 后 → .alive 删）。
      expect(probe.manifestExistedAtRelease).toBe(true);
      // 写后即刻可见（同步写，无 fire-and-forget）：终态收条 = record-settled 帧。
      expect(lastSettledEvent(manifestDir, "bg-1")?.stopReason).toBe("user-close");
      expect(fs.existsSync(`${sessionFile}.alive`)).toBe(false);
      // manifest 派生视图（同步落盘）。
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
        expect.objectContaining({ id: "bg-1", status: "idle" }),
      );
    });

    it("sessionFile 缺失 → binding 快照侧跳过（warn 留痕），manifest/entry 照常", () => {
      const record = makeRecord("bg-3");
      store.register(record);
      trySettleLegacyClosed(record, "gc");

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
      trySettleLegacyClosed(record, "cancelled");
      record.endedAt = 7777;
      probe.manifestPath = manifestPathOf("bg-c1");

      expect(store.markCancelled(record)).toBe(true);

      expect(order).toEqual(["alive-acquire", "alive-release"]);
      expect(probe.manifestExistedAtRelease).toBe(true);
      expect(typeof lastSettledEvent(manifestDir, "bg-c1")?.endedAt).toBe("number");
      expect(readManifestJson("bg-c1")).toMatchObject({ id: "bg-c1", status: "closed", closedReason: "cancelled" });
      expect(fs.existsSync(`${sessionFile}.alive`)).toBe(false);
    });

  });

  // [collect 退役] 原 markBatchFinalized barrier 用例（manifest 屏障写序 + 落标
  // entry 携带标记）随批机制删除；存量 batchFinalized entry 的读侧容忍由
  // batch-finalized.test.ts / sync-collect-recovery.test.ts 读侧检查承接。

  // ============================================================
  // A2 markRoundStarted / markRoundIdle 簿记
  // ============================================================
  describe("markRoundStarted（轮始重置：字段①②⑤ + [U6/D4] stopReason 清点）", () => {
    it("status=running + result 清除 + entry 上报", () => {
      const record = makeRecord("chat-1");
      record.result = "prev round";
      store.register(record);
      appendEntryMock.mockClear();

      expect(store.markRoundStarted("chat-1")).toBe(true);
      expect(record.status).toBe("running");
      expect(record.result).toBeUndefined();
      // [W1/D3 表行 3] 轮始迁移落 record-round-started 帧（v1 entry 过程面上报停写）
      expect(appendEntryMock).not.toHaveBeenCalled();
      expect(lastJournalEvent(manifestDir, "chat-1")).toMatchObject({ type: "record-round-started" });
    });

    it("[U6/D4 轮始清点族扩字段] 上轮 stopReason 随轮始清除（第 2+ 轮在途 record 不携带 stale 停因——renderer isOccupied 终态判据 `running && stopReason===undefined` 的直接检查）", () => {
      const record = makeRecord("chat-1b");
      record.result = "prev round";
      record.stopReason = "completed"; // 上轮轮终写入的展示位（markRoundIdleImpl 簿记⑩）
      store.register(record);
      appendEntryMock.mockClear();

      expect(store.markRoundStarted("chat-1b")).toBe(true);
      expect(record.status).toBe("running");
      expect(record.result).toBeUndefined();
      expect(record.stopReason).toBeUndefined();
    });

    it("id 不在内存 → false 无副作用", () => {
      expect(store.markRoundStarted("nope")).toBe(false);
    });

    // ── [轮次轴 CAS] 终态冻结门（与 markRoundIdle A3 断言同族；判定依据见
    //    markRoundStartedImpl 方法头）────────────────────────────────

    it("[轮次轴 CAS] 终态簿记已冻结（endedAt 已设）→ fail-fast 抛错，零副作用", () => {
      // 形态来源：真终态族写点（markFinalized / markCancelled / completeLegacyClosed）
      // 之后误派轮始 = 复活终态（调用方 bug）。markRoundIdle 刻意不写 endedAt
      //（轮终留内存 idle 可续聊），本门只拦真终态复活。
      const record = makeRecord("chat-rs-frozen", { status: "idle", endedAt: 123, result: "final output" });
      store.register(record);
      const eventsPath = path.join(manifestDir, "chat-rs-frozen.events");
      const countEventLines = (): number =>
        fs.existsSync(eventsPath)
          ? fs.readFileSync(eventsPath, "utf-8").split("\n").filter((l) => l.trim().length > 0).length
          : 0;
      const linesBefore = countEventLines();

      expect(() => store.markRoundStarted("chat-rs-frozen")).toThrow(
        /terminal bookkeeping already frozen/,
      );
      // 零副作用：内存态不动（status/result 保持终态冻结值）、事件文件不追加
      //（fail-fast 先于一切簿记——轮始帧不写入 journal 记录）。
      expect(record.status).toBe("idle");
      expect(record.result).toBe("final output");
      expect(countEventLines()).toBe(linesBefore);
    });

    it("[轮次轴 CAS] 终态 record 经 resurrectClosed 解冻后轮始放行（revive 链不误伤）", () => {
      // 合法解冻序列全部在轮始前清 endedAt：markResurrected → resurrectClosed
      //（idle→running 翻边并清终态位）/ reviveOrThrow（tryEnterRunning 后手动清）
      //——「先轮始后解冻」的序列不存在，本门不拦 revive 链。
      const record = makeRecord("chat-rs-revived", { status: "idle", endedAt: 123 });
      store.register(record);

      expect(() => store.markRoundStarted("chat-rs-revived")).toThrow(
        /terminal bookkeeping already frozen/,
      );
      expect(resurrectClosed(record)).toBe(true); // 解冻：idle→running + 清 endedAt
      expect(store.markRoundStarted("chat-rs-revived")).toBe(true);
      expect(record.status).toBe("running");
    });

    it("idle 续轮放行：轮终（idle）后轮始 → 翻 running + result/stopReason 清点 + 落帧", () => {
      // 形态来源：轮终后直接续轮（markReopened 保持 idle 的 reopen 后轮始同形态）。
      const record = makeRecord("chat-rs-idle", { round: 0 });
      record.result = "round 1 output";
      record.stopReason = "completed";
      store.register(record);
      expect(store.markRoundIdle("chat-rs-idle", { kind: "success", content: "round 1 output" })).toBe(true);
      expect(record.status).toBe("idle");

      expect(store.markRoundStarted("chat-rs-idle")).toBe(true);
      expect(record.status).toBe("running"); // idle→running 翻边（续轮在途）
      expect(record.result).toBeUndefined(); // 上轮结果随轮始清点（isStreaming 公式）
      expect(record.stopReason).toBeUndefined();
      expect(lastJournalEvent(manifestDir, "chat-rs-idle")).toMatchObject({
        type: "record-round-started",
        round: 1,
      });
    });

    it("running 连续轮始放行（onAbandoned→drain 合法路径语义锚）——无 running 在途门的判定依据", () => {
      // 形态来源：acquire 被打断（无 run 产生、不终态化）→ drain 重派 = running 中
      // 第二次轮始，是合法生产路径。与假想「双轮始竞态」的内存形态完全同形
      //（running + stopReason/result/endedAt 全 undefined），首轮出生 / 续轮翻边 /
      // revive 清位三种合法前提也同形——原语层无法构造「只拒双轮始」的 running 门，
      // 双轮始的生产防护在 Continuation 编排层（activeRunId 单飞窗 + 终态门）。
      // 本用例锚定原语层不拒绝的现状语义（详见 markRoundStartedImpl 方法头）。
      const record = makeRecord("chat-rs-again");
      store.register(record);
      expect(store.markRoundStarted("chat-rs-again")).toBe(true);
      loggerMock.warn.mockClear();

      expect(store.markRoundStarted("chat-rs-again")).toBe(true); // 连续轮始不拒绝
      expect(record.status).toBe("running");
      expect(loggerMock.warn).not.toHaveBeenCalled(); // 无 CAS 拒绝留痕
    });
  });

  describe("markRoundIdle（簿记全集①-⑨；簿记⑦ .alive 保留）", () => {
    it("成功轮：result=content、round+1、closedReason 清、翻 idle、注销②、entry 携带新 round", () => {
      const record = makeRecord("chat-2", { round: 1 });
      record.closedReason = "gc"; // [S10]：前置残留不清则泄漏进 list 派生视图
      record.sessionFile = sessionFile;
      store.register(record);
      store.acquireWriteLease(sessionFile, "chat-2");
      const unregister = vi.fn();
      store.setPendingUnregister(unregister);
      appendEntryMock.mockClear();
      order.length = 0;

      expect(store.markRoundIdle("chat-2", { kind: "success", content: "round done" })).toBe(true);

      expect(record.status).toBe("idle"); // ① 轮终翻边 idle（[two-state-convergence U4/D3]）
      expect(record.result).toBe("round done"); // ②
      expect(record.round).toBe(2); // ③
      expect(record.closedReason).toBeUndefined(); // ④
      // ⑥ idleSince 已退役（30 天空闲回收判据锚，ADR-0081）——无簿记动作。
      expect(order).toEqual([]); // ⑦ `.alive` 保留——无 release 动作
      expect(fs.existsSync(`${sessionFile}.alive`)).toBe(true); // ⑦ 落盘文件仍持声明
      // ⑧ 发射点②：[subagent-observability §3.3.6 结清枚举新写入方] 按轮终事实产
      // SettlementReason（成功轮 → completed）——旧恒发字面量 "running"（词表外）
      // 随写入方退役。
      expect(unregister).toHaveBeenCalledWith("chat-2", "completed");
      // [W1/D3 表行 4] ⑨ 过程面改走事件文件——record-round-idle 帧携带轮统计快照
      //（result 全文不进事件行，轮结果留在内存/条目；stopReason=completed）。
      expect(appendEntryMock).not.toHaveBeenCalled();
      expect(lastJournalEvent(manifestDir, "chat-2")).toMatchObject({
        type: "record-round-idle",
        stopReason: "completed",
      });
    });

    it("失败轮：lastError 写原因、result=前值??失败摘要", () => {
      const record = makeRecord("chat-3", { round: 0 });
      store.register(record);

      expect(store.markRoundIdle("chat-3", { kind: "failed", reason: "engine boom" })).toBe(true);
      expect(record.lastError).toBe("engine boom"); // ⑨ lastError 收敛
      expect(record.result).toBe("round did not complete: engine boom"); // ② 首轮失败无前值
    });

    it("终态簿记已冻结（endedAt 已设）→ fail-fast 抛错", () => {
      const record = makeRecord("chat-4");
      record.endedAt = 123; // completeLegacyClosed 已跑的冻结判据
      store.register(record);

      expect(() => store.markRoundIdle("chat-4", { kind: "success", content: "x" })).toThrow(
        /terminal bookkeeping already frozen/,
      );
    });

    it("[§4 在途门 CAS] 已轮终（idle）的 record 再次轮终 → warn 留痕 + false，零副作用", () => {
      // 形态来源：cancel 的 markSettledOut 有意不写 endedAt（endedAt 门拦不住），
      // 或迟到应答越过上层 status 门——原语级兜底即本用例。
      const record = makeRecord("chat-cas", { round: 0 });
      record.sessionFile = sessionFile;
      store.register(record);
      const eventsPath = path.join(manifestDir, "chat-cas.events");
      const countRoundIdleEvents = (): number =>
        fs
          .readFileSync(eventsPath, "utf-8")
          .split("\n")
          .filter((line) => line.includes('"type":"record-round-idle"')).length;

      expect(store.markRoundIdle("chat-cas", { kind: "success", content: "r1" })).toBe(true);
      const roundAfterFirst = record.round;
      const idleEventsAfterFirst = countRoundIdleEvents();
      loggerMock.warn.mockClear();

      // 第二次轮终（未过轮始门）：拒绝且零副作用。
      expect(store.markRoundIdle("chat-cas", { kind: "failed", reason: "late settle" })).toBe(false);

      expect(record.round).toBe(roundAfterFirst); // ③ 轮次不二次递增
      expect(record.stopReason).toBe("completed"); // ⑩ 展示位不被覆写
      expect(record.lastError).toBeUndefined(); // ⑨ 失败原因不入内存
      expect(record.result).toBe("r1"); // ② 结果不被覆写
      expect(countRoundIdleEvents()).toBe(idleEventsAfterFirst); // ⑪ 收条不覆写（收条即轮终帧）
      expect(loggerMock.warn).toHaveBeenCalledWith(
        "[subagents] markRoundIdle: CAS rejected (record not running)",
        expect.objectContaining({ detail: expect.objectContaining({ id: "chat-cas", status: "idle" }) }),
      );
    });

    it("id 不在内存 → false 无副作用", () => {
      expect(store.markRoundIdle("nope", { kind: "success", content: "x" })).toBe(false);
    });
  });

  // ============================================================
  // appendEvent（过程原语）
  // [subagent-observability u3 退役] adoptEngineDeath 用例已随写点退役删除——
  // 退役与归属语义锚（run-orchestration-write-lease.test.ts 用例 2/5）同批清理；
  // 引擎死亡收尾的现行语义锚 = 轮终失败事实（markRoundIdle failed 载荷 + 轮收条
  // 事实字段，见 record-store-round-idle-settle.test.ts）。
  // ============================================================
  describe("appendEvent", () => {
    it("appendEvent：事件归约进 turns + entry 变迁上报；id 不在内存 → false", () => {
      const record = makeRecord("ev-1");
      store.register(record);
      appendEntryMock.mockClear();

      expect(store.appendEvent("ev-1", { type: "text_delta", delta: "hi" })).toBe(true);
      expect(record.turns[0]?.text).toBe("hi"); // ⑧ turns 归约
      // [W1/D2 停写写点] 事件归约后的过渡 entry 上报停写——turn 粒度不进事件文件
      //（轮统计在轮终 round-idle 帧快照），引擎域未变零追加。
      expect(appendEntryMock).not.toHaveBeenCalled();
      expect(store.appendEvent("nope", { type: "text_delta", delta: "x" })).toBe(false);
    });
  });

  // ============================================================
  // A5 markResurrected（D3c：acquire-first + 单 try 域 + 三中间形态）
  // ============================================================
  describe("markResurrected（A5 D3c）", () => {
    const makeClosedCandidate = (id: string): ExecutionRecord => {
      const record = makeRecord(id);
      record.sessionFile = sessionFile;
      trySettleLegacyClosed(record, "parent-shutdown");
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

      expect(order).toEqual(["alive-acquire"]); // acquire-first：写权声明先行
      expect(readAliveMarker(sessionFile)).toMatchObject({ pid: process.pid, id: "rs-1" });
      // 终态位 sidecar 已随 ③ 退场：重开不再有磁盘终态位清理动作（磁盘终态由事件流决定）
      expect(record.status).toBe("running"); // resurrectClosed 内存翻回
      expect(record.closedReason).toBeUndefined();
      expect(store.getMutable("rs-1")).toBe(record); // register
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

// ══════ 来源: record-store-manifest-fallback.test.ts ══════

// src/execution/__tests__/record-store-manifest-fallback.test.ts
//
// findByIdManifestFallback（[D3 缺陷五] manifest 兜底单 id 读取）与 markModelOverride
// 身份守卫臂（非 in-memory 实例拒绝）的单元级断言。
//
// findByIdManifestFallback 消费场景 = model-switch-wiring 的引擎路由解析（getMutable /
// findLightById 双 miss 后第三源）：zcode 成员无子 session 文件不在扫描集、settle 后出
// 内存，bound/派生物化的 manifest 是其磁盘唯一载体。本测试钉住四臂行为：
//   1. manifestDir 未接线（纯内存测试形态）恒 undefined；
//   2. 文件缺失 → undefined（保守侧）；
//   3. 合法 manifest → 返回投影，身份域字段（origin/parentRunId/engine/engineHandle）
//      逐字段可信（消费方只依赖身份域——状态域禁用本方法，见方法头）；
//   4. 损坏 JSON / status 越界 → undefined（与 mergeManifestRecords 坏链保守侧同款）。
//
// markModelOverride 拒绝臂：调用方契约 = record 由调用方从 store 取出（getMutable），
// 非 in-memory 实例（未注册 / 同 id 异实例）返回 false 且零写面。
//
// 测试纪律：真实 fs 落盘断言；fixture 一律 mkdtempSync 自建自删（tmpdir），不触碰真实
// 数据目录。




/** 构造 ExecutionRecord（running 基线，over 覆盖）。 */
describe("findByIdManifestFallback（D3 缺陷五 manifest 兜底单 id 读取）", () => {
  let tmpDir: string;
  let sessionsDir: string;
  let manifestDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-fallback-"));
    sessionsDir = path.join(tmpDir, "sessions");
    manifestDir = path.join(tmpDir, "records");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(manifestDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("manifestDir 未接线（纯内存形态）恒 undefined", () => {
    const store = new RecordStore(() => sessionsDir);
    expect(store.findByIdManifestFallback("any-id")).toBeUndefined();
  });

  it("manifest 文件缺失 → undefined（保守侧，不抛）", () => {
    const store = new RecordStore(() => sessionsDir, undefined, { appendEntry: vi.fn() }, () => manifestDir);
    expect(store.findByIdManifestFallback("ghost-id")).toBeUndefined();
  });

  it("合法 manifest → 返回投影，身份域字段（origin/parentRunId/engine/engineHandle）逐字段可信", () => {
    // 先经真实写面物化 manifest（register + markRoundIdle 派生投影），再以重启形态
    // 的新 store 实例（内存空）走兜底读取——对齐 model-switch-wiring 的重启恢复消费。
    const dbPath = path.join(tmpDir, "session-db", "db.sqlite");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const writer = new RecordStore(() => sessionsDir, undefined, { appendEntry: vi.fn() }, () => manifestDir);
    const record = makeRecord("fb-zcode", {
      engine: "zcode",
      engineHandle: { sessionRef: { sessionId: "z-sess-9", dbPath }, poolKey: "shared" },
      origin: "workflow",
      parentRunId: "wf-run-fb",
      stepIndex: 2,
    });
    writer.register(record);
    expect(writer.markRoundIdle("fb-zcode", { kind: "success", content: "done" })).toBe(true);

    // 重启形态：同 manifestDir 新实例，内存零持有。
    const reader = new RecordStore(() => sessionsDir, undefined, { appendEntry: vi.fn() }, () => manifestDir);
    const projected = reader.findByIdManifestFallback("fb-zcode");
    expect(projected).toBeDefined();
    expect(projected?.id).toBe("fb-zcode");
    expect(projected?.agent).toBe("worker");
    expect(projected?.rootSessionId).toBe("sess-current");
    expect(projected?.origin).toBe("workflow");
    expect(projected?.parentRunId).toBe("wf-run-fb");
    expect(projected?.engine).toBe("zcode");
    expect(projected?.engineHandle?.sessionRef.sessionId).toBe("z-sess-9");
    expect(projected?.engineHandle?.sessionRef.dbPath).toBe(dbPath);
  });

  it("损坏 JSON（非合法 manifest 文本）→ undefined（保守侧）", () => {
    fs.writeFileSync(path.join(manifestDir, "broken.json"), "{ not json", "utf-8");
    const store = new RecordStore(() => sessionsDir, undefined, { appendEntry: vi.fn() }, () => manifestDir);
    expect(store.findByIdManifestFallback("broken")).toBeUndefined();
  });

  it("status 越界（数据损坏形态）→ undefined，不降级 failed 投影", () => {
    fs.writeFileSync(
      path.join(manifestDir, "bad-status.json"),
      JSON.stringify({
        id: "bad-status",
        rootSessionId: "sess-current",
        agentName: "worker",
        status: "crashed",
        createdAt: 1000,
      }),
      "utf-8",
    );
    const store = new RecordStore(() => sessionsDir, undefined, { appendEntry: vi.fn() }, () => manifestDir);
    expect(store.findByIdManifestFallback("bad-status")).toBeUndefined();
  });
});

describe("markModelOverride 身份守卫臂（非 in-memory 实例拒绝）", () => {
  let tmpDir: string;
  let sessionsDir: string;
  let manifestDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "model-override-guard-"));
    sessionsDir = path.join(tmpDir, "sessions");
    manifestDir = path.join(tmpDir, "records");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(manifestDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  const override = {
    ref: { provider: "p1", modelId: "m9" },
    thinkingLevel: "high",
    setAt: 1234,
  } as const;

  it("id 不在内存表（未注册）→ false，零写面", () => {
    const store = new RecordStore(() => sessionsDir, undefined, { appendEntry: vi.fn() }, () => manifestDir);
    const ghost = makeRecord("ghost-ovr");

    expect(store.markModelOverride(ghost, override)).toBe(false);
    expect(ghost.modelOverride).toBeUndefined();
    expect(fs.existsSync(path.join(manifestDir, "ghost-ovr.json"))).toBe(false);
    expect(fs.existsSync(path.join(manifestDir, "ghost-ovr.events"))).toBe(false);
  });

  it("同 id 异实例（record 非从本 store 取出）→ false，原注册实例不被触碰", () => {
    const store = new RecordStore(() => sessionsDir, undefined, { appendEntry: vi.fn() }, () => manifestDir);
    const registered = makeRecord("real-ovr", {
      engine: "zcode",
      engineHandle: { sessionRef: { sessionId: "z-1", dbPath: path.join(tmpDir, "db.sqlite") }, poolKey: "shared" },
    });
    store.register(registered);

    const stranger = makeRecord("real-ovr");
    expect(store.markModelOverride(stranger, override)).toBe(false);

    expect(stranger.modelOverride).toBeUndefined();
    // 注册实例与磁盘投影均保持无覆盖记账（写面零触碰）。
    expect(registered.modelOverride).toBeUndefined();
    expect(fs.existsSync(path.join(manifestDir, "real-ovr.json"))).toBe(false);
  });
});

// ══════ 来源: record-store-round-idle-settle.test.ts ══════

// src/execution/__tests__/record-store-round-idle-settle.test.ts
//
// [A-lite / 区1-U1 + 区3-U1] markRoundIdle 正常轮终磁盘侧增补（簿记⑩⑪）的
// 单元级断言——真实轮终路径（store.markRoundIdle 直驱，= finalizeRoundOutcome
// 编排薄壳的最终写点，非 markSettled("gc") 构造）：
//   1. 成功/失败轮后 `.state` 收条在场（{status:"idle", reason: completed|failed,
//      endedAt}——轮收尾 idle 形态，重建单规则一律 idle）；
//   2. binding 快照 turns/totalTokens 在场（U7 统计口径）；
//   3. rec.stopReason 内存展示位（completed/failed）且 status 翻 idle（
//      [two-state-convergence U4/D3] 写侧翻边）、endedAt 不写（A3 终态冻结判据不击穿
//      ——跨轮轮终不抛）；
//   4. 新 store 实例 markResurrected revive 水合不归零（turns/tokens/round 从
//      binding 快照恢复——正常轮终后宿主崩溃的最常见形态）；
//   5. zcode 路径锚分派：无 sessionFile 时快照写 transcriptRef 派生锚键、`.state`
//      不写（对齐 markSettled），revive 水合同样不归零；
//   6. 双锚皆缺（spawn 窗口期）：warn 留痕不抛，内存簿记照常。
//
// 测试纪律：真实 fs 落盘断言（不 mock state-marker——写侧形态本身是断言对象）；
// fixture 一律 mkdtempSync 自建自删（tmpdir），不触碰真实数据目录。




// [teardown 竞态修复] 被测链传递性 logger 输出经 console 落 stderr——同步用例的刷写落在
// 文件结束的 teardown 窗口，与 worker rpc 关闭竞态 → vitest EnvironmentTeardownError
// （onUserConsoleLog pending）→ run 退出码 1。本文件对 logger 零断言依赖，mock 静默
// （rebuild-indexes.test.ts 同款先例）。
/** 构造 ExecutionRecord（running 基线，over 覆盖）。 */
function makeStore(sessionsDir: string, manifestDir: string): RecordStore {
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(manifestDir, { recursive: true });
  return new RecordStore(() => sessionsDir, undefined, { appendEntry: vi.fn() }, () => manifestDir);
}

describe("markRoundIdle 正常轮终磁盘侧（A-lite 簿记⑩⑪）", () => {
  let tmpDir: string;
  let sessionsDir: string;
  let manifestDir: string;
  let sessionFile: string;
  let store: RecordStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "round-idle-settle-"));
    sessionsDir = path.join(tmpDir, "sessions");
    manifestDir = path.join(tmpDir, "records");
    store = makeStore(sessionsDir, manifestDir);
    sessionFile = path.join(sessionsDir, "2026-01-01_uuid.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf-8"); // 锚文件在盘（binding 快照写 sidecar 同目录）
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** 轮终收条改由事件流承载（③：`.state` 退场）：读最后一条 record-round-idle 帧。 */
  const lastRoundIdle = (id: string): { stopReason?: string; ts?: number } | undefined => {
    const file = path.join(manifestDir, `${id}.events`);
    if (!fs.existsSync(file)) return undefined;
    const idles = fs
      .readFileSync(file, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type?: string; stopReason?: string; ts?: number })
      .filter((e) => e.type === "record-round-idle");
    return idles.at(-1);
  };

  it("成功轮（pi 锚）：收条 reason=completed + binding 快照在场 + 内存翻 idle/stopReason + revive 水合不归零", () => {
    const record = makeRecord("bg-ok", { sessionFile });
    record.turnCount = 3;
    record.totalTokens = 1200;
    store.register(record);

    expect(store.markRoundIdle("bg-ok", { kind: "success", content: "round output" })).toBe(true);

    // ⑩ 内存展示位：status 翻 idle（[two-state-convergence U4/D3] 写侧翻边——idle 即
    // resumable，resumable 不再写）、endedAt 不写（终态冻结信号——写了会击穿方法头
    // A3 断言的跨轮轮终）。
    expect(record.status).toBe("idle");
    expect(record.stopReason).toBe("completed");
    expect(record.round).toBe(1);
    expect(record.endedAt).toBeUndefined();
    expect(record.result).toBe("round output");
    // ⑥ idleSince 已退役（30 天空闲回收判据锚，ADR-0081）——轮终不再写 idle 锚。
    // ⑪ `.state` 收条：轮收尾 idle 形态（重建单规则一律 idle）。
    const idle = lastRoundIdle("bg-ok");
    expect(idle?.stopReason).toBe("completed");
    expect(typeof idle?.ts).toBe("number");
    // ⑪ binding 快照（U7 统计口径）：turns/totalTokens 在场。
    const binding = readRecordBinding(sessionFile);
    expect(binding?.turns).toBe(3);
    expect(binding?.totalTokens).toBe(1200);
    expect(binding?.round).toBe(1);

    // [U7] 正常轮终后宿主崩溃的最常见形态：新 store 实例（模拟重启）+ createRecord
    // 产物（统计归零）→ markResurrected revive 水合不归零。wasClosed=true 对齐生产
    // 形态（round-terminal 崩溃后 cold-lookup 重建恒 idle 以 wasClosed=true 进入，
    // 顺带覆盖 .state 终态位删除分支）。
    const revivedStore = makeStore(sessionsDir, manifestDir);
    const revived = makeRecord("bg-ok", { sessionFile, status: "idle" });
    expect(revived.turnCount).toBe(0);
    expect(revived.totalTokens).toBe(0);
    revivedStore.markResurrected(revived, true);
    expect(revived.turnCount).toBe(3);
    expect(revived.totalTokens).toBe(1200);
    expect(revived.round).toBe(1);
  });

  it("[W1 / D3 表行 4] 轮终帧携带 result 摘要锚（record-settled 同款截断——承接 v1 轮终 result 显示信号）", () => {
    const record = makeRecord("bg-round-result", { sessionFile });
    store.register(record);

    const longResult = "x".repeat(260);
    expect(store.markRoundIdle("bg-round-result", { kind: "success", content: longResult })).toBe(true);

    // record-round-idle 帧的 resultSummary = 截断摘要（200 字 + 省略号，全文不进事件行）
    const lines = fs
      .readFileSync(path.join(manifestDir, "bg-round-result.events"), "utf-8")
      .trim()
      .split("\n");
    const idle = lines
      .map((l) => JSON.parse(l) as { type?: string; resultSummary?: string; error?: string })
      .find((e) => e.type === "record-round-idle");
    expect(idle?.resultSummary).toBe(`${"x".repeat(200)}…`);
    // 成功轮失败原因原文缺席（W1 终态同步 F2-2——error 仅失败轮承载）
    expect(idle?.error).toBeUndefined();
  });

  it("[§3.3.3 空正文语义] 空正文成功轮：resultSummary 键在场值空串（读侧可区分空串与缺席）", () => {
    const record = makeRecord("bg-empty-body", { sessionFile });
    store.register(record);

    expect(store.markRoundIdle("bg-empty-body", { kind: "success", content: "" })).toBe(true);

    // 内存侧空串保真（settleRoundResult 原样透传——空 = 无文本输出，非异常）。
    expect(record.result).toBe("");
    // 帧面键在场值空串——summarize 空串不再归一 undefined；旧帧键缺席仍 = 未记录。
    const lines = fs
      .readFileSync(path.join(manifestDir, "bg-empty-body.events"), "utf-8")
      .trim()
      .split("\n");
    const idle = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((e) => e.type === "record-round-idle");
    expect(Object.keys(idle ?? {})).toContain("resultSummary");
    expect(idle?.resultSummary).toBe("");
  });

  it("失败轮（pi 锚）：收条 reason=failed + lastError + 内存 stopReason=failed + binding 快照在场", () => {
    const record = makeRecord("bg-fail", { sessionFile });
    record.turnCount = 1;
    record.totalTokens = 300;
    store.register(record);

    expect(store.markRoundIdle("bg-fail", { kind: "failed", reason: "engine crashed" })).toBe(true);

    expect(record.stopReason).toBe("failed");
    expect(record.status).toBe("idle");
    expect(record.lastError).toBe("engine crashed");
    expect(record.result).toContain("engine crashed");
    const idle = lastRoundIdle("bg-fail");
    expect(idle?.stopReason).toBe("failed");
    expect(typeof idle?.ts).toBe("number");
    expect(readRecordBinding(sessionFile)?.turns).toBe(1);
    expect(readRecordBinding(sessionFile)?.totalTokens).toBe(300);
    // 帧面：record-round-idle 携带失败原因原文（W1 终态同步 F2-2——v1 rec.error
    // 显示信号的 journal 承接，派生视图 error 供源）
    const failLines = fs
      .readFileSync(path.join(manifestDir, "bg-fail.events"), "utf-8")
      .trim()
      .split("\n");
    const failIdle = failLines
      .map((l) => JSON.parse(l) as { type?: string; error?: string })
      .find((e) => e.type === "record-round-idle");
    expect(failIdle?.error).toBe("engine crashed");
  });

  it("跨轮轮终不击穿 A3 断言（endedAt 不写）+ `.state` 轮终收条随最新轮覆写（每轮先过轮始门）", () => {
    const record = makeRecord("bg-multi", { sessionFile });
    store.register(record);
    expect(store.markRoundIdle("bg-multi", { kind: "success", content: "r1" })).toBe(true);
    // 第二轮：先过轮始门（[§4] 轮终原语的同状态在途门——连续两次轮终会被拒绝），
    // 再失败轮终——断言收条 reason 跟随最新轮（单槽收尾位覆写）。
    expect(store.markRoundStarted("bg-multi")).toBe(true);
    expect(() => store.markRoundIdle("bg-multi", { kind: "failed", reason: "r2 boom" })).not.toThrow();
    expect(record.round).toBe(2);
    expect(record.stopReason).toBe("failed");
    expect(lastRoundIdle("bg-multi")?.stopReason).toBe("failed");
    // 第三轮同款：轮始门 → 成功轮终；A3 断言（endedAt）始终不被击穿。
    expect(store.markRoundStarted("bg-multi")).toBe(true);
    expect(() => store.markRoundIdle("bg-multi", { kind: "success", content: "r3" })).not.toThrow();
    expect(record.round).toBe(3);
    expect(lastRoundIdle("bg-multi")?.stopReason).toBe("completed");
  });

  it("zcode 路径锚分派：快照写 transcriptRef 派生锚键、`.state` 不写、revive 水合不归零", () => {
    const dbPath = path.join(tmpDir, "session-db", "db.sqlite");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const transcriptRef = { engine: "zcode", sessionId: "z-sess-1", dbPath } as const;
    const record = makeRecord("bg-zcode", { transcriptRef });
    record.turnCount = 5;
    record.totalTokens = 900;
    store.register(record);

    expect(store.markRoundIdle("bg-zcode", { kind: "success", content: "zcode done" })).toBe(true);

    // zcode 无 pi 文件锚（sessionFile undefined）——`.state` 不写（对齐 markSettled）。
    expect(record.sessionFile).toBeUndefined();
    expect(fs.existsSync(`${sessionFile}.state`)).toBe(false);
    // binding 快照落锚键基底（`<dbPath>.<sessionId>.record-binding`）。
    const anchorBase = zcodeAnchorBasePath(transcriptRef);
    const binding = readRecordBinding(anchorBase);
    expect(binding?.turns).toBe(5);
    expect(binding?.totalTokens).toBe(900);
    expect(binding?.transcriptRef).toEqual(transcriptRef);
    expect(record.stopReason).toBe("completed");

    // revive 水合（zcode 锚）：createRecord 产物统计归零 → markResurrected 恢复。
    const revivedStore = makeStore(sessionsDir, manifestDir);
    const revived = makeRecord("bg-zcode", { status: "idle", transcriptRef });
    revivedStore.markResurrected(revived, false);
    expect(revived.turnCount).toBe(5);
    expect(revived.totalTokens).toBe(900);
  });

  it("双锚皆缺（spawn 窗口期）：warn 留痕不抛、内存簿记照常、无 sidecar 产出", () => {
    const record = makeRecord("bg-noanchor");
    store.register(record);

    expect(() => store.markRoundIdle("bg-noanchor", { kind: "success", content: "x" })).not.toThrow();
    expect(record.stopReason).toBe("completed");
    expect(record.status).toBe("idle");
    // tmpdir 下无任何 `.state` / `.record-binding` 产出（无锚无写侧）。
    const stray = fs
      .readdirSync(tmpDir, { recursive: true })
      .filter((f) => String(f).endsWith(".state") || String(f).endsWith(".record-binding"));
    expect(stray).toEqual([]);
  });

  it("id 不在内存：false 且零副作用（debug 留痕语义不回归）", () => {
    expect(store.markRoundIdle("bg-missing", { kind: "success", content: "x" })).toBe(false);
    expect(fs.existsSync(`${sessionFile}.state`)).toBe(false);
  });
});

// ============================================================
// [subagent-observability §3.3.3/§3.3.6] markRoundIdle 轮收条事实化：
//   - 停因只存事实（引擎原值 engineStopReason 在场 → 展示位写引擎原值；旧引擎无
//     事实回落派生展示词，迁移期回落）；
//   - 失败分类/接管三态/usage 事实快照（帧 + rec.lastRound 内存读侧双承载）；
//   - 被接管轮（promptDisposition=handled）：无停因、无失败分类、空正文、结清 no_result；
//   - pending 结清枚举新写入方（completed/failed/cancelled/no_result 按轮终事实，
//     旧 "running" 退役）；
//   - 失败事实入账走 SDK appendErrorFact 单点（errors 只追加 + lastError 派生——u2 移交收编）。
// ============================================================
describe("markRoundIdle 轮收条事实化（subagent-observability u3）", () => {
  let tmpDir: string;
  let sessionsDir: string;
  let manifestDir: string;
  let sessionFile: string;
  let store: RecordStore;
  let settlements: Array<{ id: string; reason: string }>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "round-facts-"));
    sessionsDir = path.join(tmpDir, "sessions");
    manifestDir = path.join(tmpDir, "records");
    store = makeStore(sessionsDir, manifestDir);
    settlements = [];
    store.setPendingUnregister((id, reason) => settlements.push({ id, reason }));
    sessionFile = path.join(sessionsDir, "2026-01-01_uuid.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  const readIdleFrame = (id: string): Record<string, unknown> | undefined => {
    const file = path.join(manifestDir, `${id}.events`);
    if (!fs.existsSync(file)) return undefined;
    const idles = fs
      .readFileSync(file, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.type === "record-round-idle");
    return idles.at(-1);
  };

  it("引擎停因事实在场：停因存引擎原值（error）+ 帧事实字段 + rec.lastRound 快照 + 结清 failed", () => {
    const record = makeRecord("bg-fact-error", { sessionFile });
    record.turnCount = 6;
    store.register(record);

    expect(
      store.markRoundIdle("bg-fact-error", {
        kind: "failed",
        reason: "429: tier_limit_exceeded, resets 2026-10-24T06:58:00Z",
        engineStopReason: "error",
        failure: {
          class: "provider",
          kind: "rate_limited",
          retryable: "conditional",
          retryAfterMs: 1_320_000,
          raw: "429: tier_limit_exceeded, resets 2026-10-24T06:58:00Z",
        },
      }),
    ).toBe(true);

    // 事实字段：帧并行产出（§3.4）。
    const frame = readIdleFrame("bg-fact-error");
    expect(frame?.engineStopReason).toBe("error");
    expect(frame?.failure).toMatchObject({ class: "provider", kind: "rate_limited", retryable: "conditional" });
    // 停因展示位 = 引擎原值（停因只存事实——不再写推断值 completed/failed）。
    expect(record.stopReason).toBe("error");
    expect(frame?.stopReason).toBe("error");
    // 事实快照（内存读侧权威源——recordToSubagent/list 消费）。
    expect(record.lastRound).toMatchObject({
      engineStopReason: "error",
      failure: { class: "provider", kind: "rate_limited" },
    });
    // 结清枚举：轮失败结清 = failed。
    expect(settlements).toEqual([{ id: "bg-fact-error", reason: "failed" }]);
    // 失败事实入账（appendErrorFact 单点——errors 只追加 + lastError 派生）。
    expect(record.lastError).toContain("tier_limit_exceeded");
    expect(record.errors?.at(-1)?.message).toContain("tier_limit_exceeded");
  });

  it("被接管轮（promptDisposition=handled）：无停因、无失败分类、空正文、结清 no_result（§3.3.1 P6 第三形态）", () => {
    const record = makeRecord("bg-handled", { sessionFile });
    store.register(record);

    expect(
      store.markRoundIdle("bg-handled", {
        kind: "success",
        content: "",
        promptDisposition: "handled",
      }),
    ).toBe(true);

    // 轮终层记事实：engineStopReason 无值（引擎未执行）+ promptDisposition=handled +
    // 空正文 + 不写 FailureCause；「正常收尾」派生判据要求停因 stop——本形态无停因
    // 构造性不满足，stopReason 不写。
    expect(record.stopReason).toBeUndefined();
    expect(record.result).toBe("");
    // 收条快照恒带轮数事实（F1-46：turns 随收条定格——本用例 record 零 turn）。
    expect(record.lastRound).toEqual({ promptDisposition: "handled", turns: 0 });
    const frame = readIdleFrame("bg-handled");
    expect(frame?.stopReason).toBeUndefined();
    expect(frame?.engineStopReason).toBeUndefined();
    expect(frame?.failure).toBeUndefined();
    expect(frame?.promptDisposition).toBe("handled");
    // 结清：被接管 = 无果（细因经轮收条 promptDisposition 披露，§3.3.6）。
    expect(settlements).toEqual([{ id: "bg-handled", reason: "no_result" }]);
  });

  it("正常收尾事实：engineStopReason=stop 且无失败分类 → 停因存引擎原值 stop + 结清 completed", () => {
    const record = makeRecord("bg-fact-stop", { sessionFile });
    store.register(record);

    expect(
      store.markRoundIdle("bg-fact-stop", {
        kind: "success",
        content: "done",
        engineStopReason: "stop",
        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3, cost: 0 },
        retryAttempts: 0,
      }),
    ).toBe(true);

    expect(record.stopReason).toBe("stop");
    expect(record.lastRound).toMatchObject({
      engineStopReason: "stop",
      retryAttempts: 0,
    });
    expect(record.lastRound?.usage?.output).toBe(2);
    const frame = readIdleFrame("bg-fact-stop");
    expect(frame?.engineStopReason).toBe("stop");
    expect(frame?.stopReason).toBe("stop");
    expect(frame?.usage).toMatchObject({ output: 2 });
    expect(settlements).toEqual([{ id: "bg-fact-stop", reason: "completed" }]);
  });

  it("[§3.3.6 结清不分裂] kind=success + 引擎停因 error（无失败分类）→ 停因 error + 结清 failed（修复前结清落 completed 与停因展示分裂）", () => {
    const record = makeRecord("bg-split-error", { sessionFile });
    store.register(record);

    expect(
      store.markRoundIdle("bg-split-error", {
        kind: "success",
        content: "partial text",
        engineStopReason: "error",
      }),
    ).toBe(true);

    // 展示位与结清同源（引擎停因事实 error = 失败轮，两处一致落 failed 语义）。
    expect(record.stopReason).toBe("error");
    expect(settlements).toEqual([{ id: "bg-split-error", reason: "failed" }]);
  });

  it("[§3.3.6 结清不分裂] 用户中止轮（failure=user.cancelled + 停因 aborted）→ 停因 aborted + 结清 cancelled（中止非失败）", () => {
    const record = makeRecord("bg-user-cancel", { sessionFile });
    store.register(record);

    expect(
      store.markRoundIdle("bg-user-cancel", {
        kind: "failed",
        reason: "user abort",
        engineStopReason: "aborted",
        failure: { class: "user", kind: "cancelled", retryable: false, raw: "user abort" },
      }),
    ).toBe(true);

    expect(record.stopReason).toBe("aborted");
    expect(settlements).toEqual([{ id: "bg-user-cancel", reason: "cancelled" }]);
  });

  it("旧引擎回落（无引擎停因事实）：kind 派生展示词（failed 轮=failed / 成功轮=completed）+ 结清随 kind", () => {
    const failedRecord = makeRecord("bg-legacy-failed", { sessionFile });
    store.register(failedRecord);
    expect(store.markRoundIdle("bg-legacy-failed", { kind: "failed", reason: "legacy boom" })).toBe(true);
    expect(failedRecord.stopReason).toBe("failed");
    expect(settlements).toEqual([{ id: "bg-legacy-failed", reason: "failed" }]);

    expect(store.markRoundStarted("bg-legacy-failed")).toBe(true);
    expect(store.markRoundIdle("bg-legacy-failed", { kind: "success", content: "legacy ok" })).toBe(true);
    expect(failedRecord.stopReason).toBe("completed");
    // settlements 跨轮累积（beforeEach 清空，两轮结清都在场）。
    expect(settlements).toEqual([
      { id: "bg-legacy-failed", reason: "failed" },
      { id: "bg-legacy-failed", reason: "completed" },
    ]);
  });
});

// ============================================================
// [subagent-observability §3.3.6 F1-39/F1-42/F1-46] list 证据链组合（store 层两路）：
//   - 内存写点路：collectRecords 漏斗条目 evidence（eventsFile/lastSeq/stderrTeePath）
//     + lastRound.turns 收条定格；
//   - 磁盘重建路（新 store 实例 = 模拟重启）：fold 恢复 evidence/lastRound（含
//     stderrTeePath 诊断引用）；
//   - getFullRecord 富化源不产 evidence（全量重建也不恢复 lastRound）——listHandler
//     富化合并职责的输入侧事实锁定。
// ============================================================
describe("list 证据链组合（F1-39/F1-42/F1-46 store 层）", () => {
  let tmpDir: string;
  let sessionsDir: string;
  let manifestDir: string;
  let sessionFile: string;
  let store: RecordStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "round-evidence-"));
    sessionsDir = path.join(tmpDir, "sessions");
    manifestDir = path.join(tmpDir, "records");
    store = makeStore(sessionsDir, manifestDir);
    sessionFile = path.join(sessionsDir, "2026-01-01_uuid.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  const EVENTS_FILE = (id: string) => path.join(manifestDir, `${id}.events`);
  const TEE_PATH = "/logs/pi-2026-10-23-sa-tee.jsonl";

  function settleFailedRound(id: string, turnCount: number): void {
    const record = makeRecord(id, { sessionFile });
    record.turnCount = turnCount;
    store.register(record);
    expect(
      store.markRoundIdle(id, {
        kind: "failed",
        reason: "429: tier_limit_exceeded",
        engineStopReason: "error",
        stderrTeePath: TEE_PATH,
      }),
    ).toBe(true);
  }

  it("内存写点路：漏斗条目 evidence 三字段在场 + lastRound.turns 收条定格；getFullRecord 不产 evidence", () => {
    settleFailedRound("bg-ev-mem", 6);

    const items = store.collectRecords(20, "all", undefined, false);
    const mem = items.find((r) => r.id === "bg-ev-mem");
    expect(mem).toBeDefined();
    // evidence：journal 物理定位 + fold 水位 + 引擎诊断 tee 路径（最近轮收条透传）。
    expect(mem?.evidence).toEqual({
      eventsFile: EVENTS_FILE("bg-ev-mem"),
      lastSeq: expect.any(Number),
      stderrTeePath: TEE_PATH,
    });
    expect(mem?.evidence?.lastSeq).toBeGreaterThan(0);
    // 收条自身轮终值（F1-46：markRoundIdle 时点定格，非 live 计数器）。
    expect(mem?.lastRound).toMatchObject({ engineStopReason: "error", turns: 6, stderrTeePath: TEE_PATH });

    // getFullRecord（内存 recordToSubagent 投影）：lastRound 直读在场、evidence 不产
    // （附加只发生在 mergedRecords 漏斗——listHandler 富化合并的输入侧事实）。
    const full = store.getFullRecord("bg-ev-mem");
    expect(full?.evidence).toBeUndefined();
    expect(full?.lastRound).toMatchObject({ engineStopReason: "error", turns: 6 });
  });

  it("磁盘重建路（新 store 实例）：fold 恢复 evidence/lastRound（含诊断 tee 路径）；磁盘 full 不带 evidence", () => {
    settleFailedRound("bg-ev-disk", 15);

    const revivedStore = makeStore(sessionsDir, manifestDir);
    const items = revivedStore.collectRecords(20, "all", undefined, false);
    const disk = items.find((r) => r.id === "bg-ev-disk");
    expect(disk).toBeDefined();
    expect(disk?.evidence).toEqual({
      eventsFile: EVENTS_FILE("bg-ev-disk"),
      lastSeq: expect.any(Number),
      stderrTeePath: TEE_PATH,
    });
    // 轮收条事实随 fold 重建恢复（收条帧 turns 快照 + 诊断引用透传）。
    expect(disk?.lastRound).toMatchObject({ engineStopReason: "error", turns: 15, stderrTeePath: TEE_PATH });

    // 磁盘全量重建（buildRecord）不恢复轮收条快照/证据——listHandler 富化时从漏斗
    // 条目补缺（F1-39 合并职责的另一半输入侧事实）。
    const diskFull = revivedStore.getFullRecord("bg-ev-disk");
    expect(diskFull?.evidence).toBeUndefined();
  });

  it("无失败轮诊断指针的形态：evidence 不落 stderrTeePath 键（成功轮引擎不上报）", () => {
    const record = makeRecord("bg-ev-ok", { sessionFile });
    record.turnCount = 2;
    store.register(record);
    expect(
      store.markRoundIdle("bg-ev-ok", { kind: "success", content: "done", engineStopReason: "stop" }),
    ).toBe(true);

    const items = store.collectRecords(20, "all", undefined, false);
    const ok = items.find((r) => r.id === "bg-ev-ok");
    expect(ok?.evidence).toEqual({
      eventsFile: EVENTS_FILE("bg-ev-ok"),
      lastSeq: expect.any(Number),
    });
    expect("stderrTeePath" in (ok?.evidence ?? {})).toBe(false);
    expect(ok?.lastRound).toMatchObject({ engineStopReason: "stop", turns: 2 });
  });
});
