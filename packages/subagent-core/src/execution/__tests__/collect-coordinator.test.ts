// src/execution/__tests__/collect-coordinator.test.ts
//
// collectCoordinator 单测（subagent-sync-collect U2）：全依赖注入，fake flush 断言
//   1. async 路由字节不变语义：notifyAsync 直通同一 record，协调器零改写（G3/A5）；
//   2. sync 登记 + 闭合检测：缓冲非空 && 无非终态 sync（⛔3 非终态口径，池排队恒
//      running 自动等待）→ flushBatch 收全部快照、缓冲清空；
//   3. 跨轮续累（D2 隐式批）：分两轮派 2+1 sync 仍同一 pending 集（单批三成员）；
//   4. cancel / watchdog（orphan 类）终态入 pending（设计 E3/E6）。
//
// [U8 拆批修复] 闭合满足 → setTimeout(0) 同宏任务去抖合批 flush（非立即）——背靠背
//   route（终态已落 store、notifyComplete 尚在 finalize 链间隙）一并入批；武装后
//   flush 异步到期，断言投递面/缓冲清空前须 await settleFlush() 开窗。
//
// 纯注入测试：无文件 IO、无真实 service——service 集成面见 collect-coordinator-service.test.ts。

import { describe, expect, it, vi } from "vitest";

import { COLLECT_SCAN_LIMIT, CollectCoordinator, isCollectPending } from "../assembly/collect-coordinator.ts";
import type { CollectCoordinatorDeps } from "../assembly/collect-coordinator.ts";
import type { BgNotifyRecord } from "../notify/notifier.ts";
import type { ExecutionRecord, SubagentRecord } from "../assembly/types.ts";

// ── stub 工厂 ──

function makeRec(over: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: "sa-1",
    agent: "/home/u/agents/worker.md",
    model: "prov/m1",
    thinkingLevel: undefined,
    mode: "background",
    task: "t",
    slug: "worker",
    startedAt: 1000,
    rootSessionId: "root-A",
    parentRecordId: undefined,
    depth: 0,
    status: "closed",
    closedReason: "gc",
    turns: [],
    turnCount: 1,
    totalTokens: 10,
    lastError: undefined,
    endedAt: 2000,
    result: "done",
    error: undefined,
    agentResult: undefined,
    controller: undefined,
    ...over,
  } as ExecutionRecord;
}

function makeSnapshot(id: string, over: Partial<BgNotifyRecord> = {}): BgNotifyRecord {
  return {
    id,
    status: "closed",
    agent: "/home/u/agents/worker.md",
    model: "prov/m1",
    result: `result of ${id}`,
    startedAt: 1000,
    endedAt: 2000,
    ...over,
  };
}

/** store 枚举 stub：listRecords 返回的 SubagentRecord 形态（协调器闭合判定输入）。 */
function makeStoreRec(over: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    id: "sa-1",
    agent: "/home/u/agents/worker.md",
    task: "t",
    slug: "worker",
    status: "closed",
    closedReason: "gc",
    mode: "background",
    startedAt: 1000,
    rootSessionId: "root-A",
    parentRecordId: undefined,
    depth: 0,
    endedAt: 2000,
    turns: 1,
    totalTokens: 10,
    model: "prov/m1",
    thinkingLevel: undefined,
    eventLog: [],
    displayItems: [],
    ...over,
  } as SubagentRecord;
}

interface Harness {
  coordinator: CollectCoordinator;
  notifyAsync: ReturnType<typeof vi.fn>;
  toNotifyRecord: ReturnType<typeof vi.fn>;
  listRecords: ReturnType<typeof vi.fn>;
  flushBatch: ReturnType<typeof vi.fn>;
}

function makeHarness(storeRecords: SubagentRecord[] = []): Harness {
  const notifyAsync = vi.fn();
  // toNotifyRecord stub：从 record 透传终态语义字段（closedReason/error/result），
  // 与 service.toNotifyRecord 的投影语义对齐。
  const toNotifyRecord = vi.fn((record: ExecutionRecord) =>
    makeSnapshot(record.id, {
      closedReason: record.closedReason,
      error: record.error,
      result: record.result,
    }),
  );
  const listRecords = vi.fn(() => storeRecords);
  const flushBatch = vi.fn();
  const coordinator = new CollectCoordinator({
    notifyAsync,
    toNotifyRecord,
    listRecords,
    flushBatch,
  } satisfies CollectCoordinatorDeps);
  return { coordinator, notifyAsync, toNotifyRecord, listRecords, flushBatch };
}

/** [U8 拆批修复] 闭合合批排程窗口等待：flush 排程 = setTimeout(0)（Node 1ms clamp），
 *  10ms 真实定时器保证窗口已开（本包 vitest 真实 timers 环境）。 */
async function settleFlush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

// ============================================================
// [two-state-convergence U4/D4] isCollectPending 判据 SSOT 四形态等价矩阵
// ============================================================
// 门语义（设计 D4 行为级第 1 行 / R3 补 W4 形态）：U4 批内四形态与现行为逐一对齐——
// 真在跑 → 挂起等待；桥接轮终（running+resumable=true 存量 entry）→ 补发；
// 翻边轮终（idle，U4 写面权威词）→ 补发；W4 纳管态（running+resumable=true，
// adoptEngineDeath 产物）→ 补发。矩阵同时钉住 SSOT 双消费方（hasRunningSync 主路径 +
// E1 恢复扫描过滤器）共用同一函数——两处各断言一次同一形态表（防单点回退内联）。

describe("[P-collect ⛔] isCollectPending 判据 SSOT 四形态矩阵（two-state-convergence U4）", () => {
  it("形态①真在跑（running + resumable 空）→ true（闭合等待/补发挂起）", () => {
    expect(isCollectPending({ status: "running", resumable: undefined })).toBe(true);
  });

  it("形态②桥接轮终（running + resumable=true 存量 entry）→ false（resumable 子句排除）", () => {
    expect(isCollectPending({ status: "running", resumable: true })).toBe(false);
  });

  it("形态③翻边轮终（idle）→ false（status 子句排除——U4 写面权威词）", () => {
    expect(isCollectPending({ status: "idle", resumable: undefined })).toBe(false);
  });

  it("形态④W4 纳管态（running + resumable=true，adoptEngineDeath）→ false（与桥接形态同判——U5 批才翻转 waiting）", () => {
    expect(isCollectPending({ status: "running", resumable: true })).toBe(false);
  });

  it("closed 终态（idle + closedReason）→ false（status 子句吸收旧 closed 子句）", () => {
    expect(isCollectPending({ status: "idle", resumable: undefined })).toBe(false);
  });
});

describe("[P-collect ⛔] 协调器主路径（hasRunningSync）对四形态的 route 行为", () => {
  it("真在跑 sync 成员阻止闭合（buffered）；翻边轮终 sync 成员不阻止（flushed）", async () => {
    const h = makeHarness([
      makeStoreRec({ id: "sa-running", collectMode: "sync", status: "running" }),
    ]);
    expect(h.coordinator.route(makeRec({ id: "sa-flip", collectMode: "sync" }))).toBe("sync-buffered");

    // 翻边轮终形态：running 成员轮终翻 idle → 闭合放行
    const h2 = makeHarness([
      makeStoreRec({ id: "sa-flipped", collectMode: "sync", status: "idle" }),
    ]);
    expect(h2.coordinator.route(makeRec({ id: "sa-flip", collectMode: "sync" }))).toBe("sync-flushed");
    await settleFlush();
    expect(h2.flushBatch).toHaveBeenCalledTimes(1);
  });

  it("桥接期存量（running+resumable=true）与 W4 纳管态 sync 成员不阻止闭合", async () => {
    const h = makeHarness([
      makeStoreRec({ id: "sa-bridge", collectMode: "sync", status: "running", resumable: true }),
      makeStoreRec({ id: "sa-w4", collectMode: "sync", status: "running", resumable: true }),
    ]);
    expect(h.coordinator.route(makeRec({ id: "sa-x", collectMode: "sync" }))).toBe("sync-flushed");
    await settleFlush();
    expect(h.flushBatch).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// async 路由（字节不变语义）
// ============================================================

describe("CollectCoordinator async routing", () => {
  it("routes records without collectMode straight to notifyAsync (直通同一 record)", () => {
    const h = makeHarness();
    const record = makeRec({ id: "sa-async" });
    expect(h.coordinator.route(record)).toBe("async");
    expect(h.notifyAsync).toHaveBeenCalledTimes(1);
    expect(h.notifyAsync).toHaveBeenCalledWith(record);
    expect(h.flushBatch).not.toHaveBeenCalled();
    expect(h.coordinator.pendingCount).toBe(0);
  });

  it("routes chatMode records async (对话回流不入批，D8)", () => {
    const h = makeHarness();
    const record = makeRec({ id: "sa-chat", chatMode: true });
    expect(h.coordinator.route(record)).toBe("async");
    expect(h.notifyAsync).toHaveBeenCalledTimes(1);
  });

  it("scan limit is 1000 (与 service 冷路径同量级)", () => {
    expect(COLLECT_SCAN_LIMIT).toBe(1000);
  });
});

// ============================================================
// sync 登记 + 闭合检测
// ============================================================

describe("CollectCoordinator sync buffering + closure", () => {
  it("buffers a finished sync member while another sync member is still running", () => {
    // store：sa-2 仍在跑（非终态）→ sa-1 终态入缓冲不闭合
    const h = makeHarness([
      makeStoreRec({ id: "sa-1", collectMode: "sync", status: "idle" }),
      makeStoreRec({ id: "sa-2", collectMode: "sync", status: "running" }),
    ]);
    const result = h.coordinator.route(makeRec({ id: "sa-1", collectMode: "sync" }));
    expect(result).toBe("sync-buffered");
    expect(h.coordinator.pendingCount).toBe(1);
    expect(h.flushBatch).not.toHaveBeenCalled();
  });

  it("flushes the whole buffer when the last running sync member finishes", async () => {
    // 时序：sa-1 先终态（sa-2 仍 running → 入缓冲）；sa-2 最后终态（store 全 closed）
    // → 闭合 flush 两成员。
    let sa2Running = true;
    const storeRecords = (): SubagentRecord[] => [
      makeStoreRec({ id: "sa-1", collectMode: "sync", status: "idle" }),
      makeStoreRec({ id: "sa-2", collectMode: "sync", status: sa2Running ? "running" : "idle" }),
    ];
    const h = makeHarness();
    (h as { listRecords: ReturnType<typeof vi.fn> }).listRecords.mockImplementation(storeRecords);
    expect(h.coordinator.route(makeRec({ id: "sa-1", collectMode: "sync" }))).toBe("sync-buffered");
    sa2Running = false;
    expect(h.coordinator.route(makeRec({ id: "sa-2", collectMode: "sync" }))).toBe("sync-flushed");
    await settleFlush();
    expect(h.flushBatch).toHaveBeenCalledTimes(1);
    const members = h.flushBatch.mock.calls[0]?.[0] as BgNotifyRecord[];
    expect(members.map((m) => m.id)).toEqual(["sa-1", "sa-2"]);
    expect(h.coordinator.pendingCount).toBe(0);
  });

  it("a lone sync member flushes via the coalescing window (单成员即闭合)", async () => {
    const h = makeHarness([
      makeStoreRec({ id: "sa-1", collectMode: "sync", status: "idle" }),
    ]);
    const result = h.coordinator.route(makeRec({ id: "sa-1", collectMode: "sync" }));
    expect(result).toBe("sync-flushed");
    await settleFlush();
    expect(h.flushBatch).toHaveBeenCalledTimes(1);
  });

  it("back-to-back routes in one macrotask coalesce into ONE flush (U8 拆批盲窗回归)", async () => {
    // 盲窗精确形态：A/B 均已 archive（listAllActive 扫描恒空——终态已落 store 但
    // B 的 notifyComplete 尚在 finalize 链间隙）。修复前：route(A) 闭合立即 flush([A])，
    // route(B) 再 flush([B]) → 两条单成员批；修复后：同宏任务去抖窗口把 B 并入，
    // 单批两成员一次投递。
    const h = makeHarness([]); // store 空 = 双成员均已 archive（盲窗扫描视图）
    expect(h.coordinator.route(makeRec({ id: "sa-a", collectMode: "sync" }))).toBe("sync-flushed");
    expect(h.coordinator.route(makeRec({ id: "sa-b", collectMode: "sync" }))).toBe("sync-flushed");
    await settleFlush();
    expect(h.flushBatch).toHaveBeenCalledTimes(1);
    const members = h.flushBatch.mock.calls[0]?.[0] as BgNotifyRecord[];
    expect(members.map((m) => m.id)).toEqual(["sa-a", "sa-b"]);
    expect(h.coordinator.pendingCount).toBe(0);
  });

  it("cancelScheduledFlush drops the pending window and keeps the buffer (E9 dispose 语义)", async () => {
    // dispose 到来时挂起排程取消、缓冲原样保留（convertPendingSyncBufferToAsync
    // 仍读得到全部成员转 async）——service 侧 E9 交互的单元级前置。
    const h = makeHarness([
      makeStoreRec({ id: "sa-1", collectMode: "sync", status: "idle" }),
    ]);
    expect(h.coordinator.route(makeRec({ id: "sa-1", collectMode: "sync" }))).toBe("sync-flushed");
    h.coordinator.cancelScheduledFlush();
    await settleFlush();
    expect(h.flushBatch).not.toHaveBeenCalled();
    expect(h.coordinator.pendingCount).toBe(1);
    expect(h.coordinator.pendingMembers().map((m) => m.id)).toEqual(["sa-1"]);
  });

  it("pool-queued sync members (status=running) block closure (⛔3 非终态口径)", () => {
    // sa-2 在池排队：store.register 起即 status=running（无独立排队态）→ 阻止闭合
    const h = makeHarness([
      makeStoreRec({ id: "sa-1", collectMode: "sync", status: "idle" }),
      makeStoreRec({ id: "sa-2", collectMode: "sync", status: "running" }),
    ]);
    const result = h.coordinator.route(makeRec({ id: "sa-1", collectMode: "sync" }));
    expect(result).toBe("sync-buffered");
    expect(h.flushBatch).not.toHaveBeenCalled();
  });

  it("batchFinalized members do not block closure (已离场成员)", async () => {
    const h = makeHarness([
      makeStoreRec({ id: "sa-1", collectMode: "sync", status: "idle" }),
      makeStoreRec({ id: "sa-2", collectMode: "sync", status: "idle", batchFinalized: true }),
    ]);
    const result = h.coordinator.route(makeRec({ id: "sa-1", collectMode: "sync" }));
    expect(result).toBe("sync-flushed");
    await settleFlush();
    expect(h.flushBatch).toHaveBeenCalledTimes(1);
  });

  it("async records never block sync closure (混派正交，A8 前置)", async () => {
    const h = makeHarness([
      makeStoreRec({ id: "sa-1", collectMode: "sync", status: "idle" }),
      makeStoreRec({ id: "sa-async", status: "running" }), // 无 collectMode：async 在跑
    ]);
    const result = h.coordinator.route(makeRec({ id: "sa-1", collectMode: "sync" }));
    expect(result).toBe("sync-flushed");
    await settleFlush();
    expect(h.flushBatch).toHaveBeenCalledTimes(1);
  });

  it("skips buffering when toNotifyRecord returns undefined (gate 未过，与 async 静默跳过对称)", () => {
    const notifyAsync = vi.fn();
    const toNotifyRecord = vi.fn(() => undefined);
    const listRecords = vi.fn(() => [] as SubagentRecord[]);
    const flushBatch = vi.fn();
    const coordinator = new CollectCoordinator({ notifyAsync, toNotifyRecord, listRecords, flushBatch });
    const result = coordinator.route(makeRec({ id: "sa-x", collectMode: "sync" }));
    expect(result).toBe("sync-skipped");
    expect(coordinator.pendingCount).toBe(0);
    expect(flushBatch).not.toHaveBeenCalled();
  });
});

// ============================================================
// 跨轮续累（D2 隐式批：2+1 同一 pending 集）
// ============================================================

describe("CollectCoordinator cross-turn accumulation (D2)", () => {
  it("accumulates 2+1 sync starts across two turns into ONE flush batch", async () => {
    // round1 派 A、B；round2 派 C。终态时序：A → C → B（B 最后闭合）。
    // store 枚举由「谁还活着」驱动：闭合只看非终态 sync 是否清零。
    let running = new Set(["sa-b"]);
    const storeRecords = (): SubagentRecord[] =>
      [...running].map((id) => makeStoreRec({ id, collectMode: "sync", status: "running" }));
    const notifyAsync = vi.fn();
    const toNotifyRecord = vi.fn((record: ExecutionRecord) => makeSnapshot(record.id));
    const listRecords = vi.fn(() => storeRecords());
    const flushBatch = vi.fn();
    const coordinator = new CollectCoordinator({ notifyAsync, toNotifyRecord, listRecords, flushBatch });

    // round1：A 终态（B 仍在跑）→ 缓冲 [A]
    expect(coordinator.route(makeRec({ id: "sa-a", collectMode: "sync" }))).toBe("sync-buffered");
    expect(coordinator.pendingMembers().map((m) => m.id)).toEqual(["sa-a"]);

    // round2：派 C（跨轮续累——同一 pending 集）；C 终态（B 仍在跑）→ 缓冲 [A, C]
    expect(coordinator.route(makeRec({ id: "sa-c", collectMode: "sync" }))).toBe("sync-buffered");
    expect(coordinator.pendingMembers().map((m) => m.id)).toEqual(["sa-a", "sa-c"]);

    // B 终态（先从 running 集移除 = 终态落 store）→ 闭合：单批三成员（2+1 同一批）
    running.delete("sa-b");
    expect(coordinator.route(makeRec({ id: "sa-b", collectMode: "sync" }))).toBe("sync-flushed");
    await settleFlush();
    expect(flushBatch).toHaveBeenCalledTimes(1);
    const members = flushBatch.mock.calls[0]?.[0] as BgNotifyRecord[];
    expect(members.map((m) => m.id).sort()).toEqual(["sa-a", "sa-b", "sa-c"]);
    expect(coordinator.pendingCount).toBe(0);
  });

  it("starts a fresh batch after a flush (闭合后新派开新批)", async () => {
    // sa-2 在跑（阻止闭合）：sa-1 终态入缓冲；sa-2 终态闭合后，新派 sa-3 终态开新批。
    const store: SubagentRecord[] = [
      makeStoreRec({ id: "sa-1", collectMode: "sync", status: "idle" }),
      makeStoreRec({ id: "sa-2", collectMode: "sync", status: "running" }),
    ];
    const h = makeHarness();
    (h as { listRecords: ReturnType<typeof vi.fn> }).listRecords.mockImplementation(() => store);
    expect(h.coordinator.route(makeRec({ id: "sa-1", collectMode: "sync" }))).toBe("sync-buffered");
    store[1] = makeStoreRec({ id: "sa-2", collectMode: "sync", status: "idle" });
    expect(h.coordinator.route(makeRec({ id: "sa-2", collectMode: "sync" }))).toBe("sync-flushed");
    await settleFlush(); // 第一批投出（合批窗口开）
    // 闭合后新 sync 终态 → 新批缓冲（不复活旧成员）：store 无 running sync → 但
    // 缓冲非空在先入时判定，route(sa-3) 时缓冲空 + 无 running → 闭合开新批排程
    expect(h.coordinator.route(makeRec({ id: "sa-3", collectMode: "sync" }))).toBe("sync-flushed");
    await settleFlush();
    expect(h.coordinator.pendingMembers().map((m) => m.id)).toEqual([]);
    expect(h.flushBatch).toHaveBeenCalledTimes(2);
  });
});

// ============================================================
// cancel / watchdog（orphan 类）终态入 pending（E3/E6）
// ============================================================

describe("CollectCoordinator cancel/watchdog terminal states enter the batch", () => {
  it("routes a cancelled sync member into the buffer (E6：cancel 计入批)", async () => {
    const h = makeHarness([
      makeStoreRec({ id: "sa-1", collectMode: "sync", status: "idle" }),
    ]);
    const record = makeRec({
      id: "sa-1",
      collectMode: "sync",
      status: "idle",
      closedReason: "cancelled",
      result: "",
      error: "cancelled by user",
    });
    expect(h.coordinator.route(record)).toBe("sync-flushed");
    await settleFlush();
    const members = h.flushBatch.mock.calls[0]?.[0] as BgNotifyRecord[];
    expect(members).toHaveLength(1);
    expect(members[0]?.closedReason).toBe("cancelled");
  });

  it("routes a watchdog/gc-failed sync member into the buffer (E3：orphan 类终态计入批)", async () => {
    const h = makeHarness([
      makeStoreRec({ id: "sa-1", collectMode: "sync", status: "idle" }),
    ]);
    const record = makeRec({
      id: "sa-1",
      collectMode: "sync",
      status: "idle",
      closedReason: "gc",
      result: "",
      error: "settled watchdog timeout",
    });
    expect(h.coordinator.route(record)).toBe("sync-flushed");
    await settleFlush();
    const members = h.flushBatch.mock.calls[0]?.[0] as BgNotifyRecord[];
    expect(members[0]?.error).toBe("settled watchdog timeout");
  });
});
