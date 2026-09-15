// src/execution/__tests__/collect-coordinator.test.ts
//
// collectCoordinator 单测（subagent-sync-collect U2 + [modeless 波3] 登记制语义）：
// 全依赖注入，fake flush 断言
//   1. async 路由字节不变语义：未登记成员 notifyAsync 直通同一 record，协调器零改写
//      （G3/A5 零回归）；
//   2. 派发登记（registerMember）+ sync 缓冲 + 闭合检测：缓冲非空 && 无「登记中未收口」
//      （⛔3 非终态口径，池排队恒 running 自动等待）→ flushBatch 收全部快照、缓冲清空 +
//      批成员自登记集离场；
//   3. 跨轮续累（D2 隐式批）：分两轮派 2+1 sync 仍同一 pending 集（单批三成员）；
//   4. cancel / watchdog（orphan 类）终态入 pending（设计 E3/E6）；
//   5. [modeless 波3] clear()：批协调状态整体清空（E9 dispose 语义——挂起排程取消 +
//      缓冲 + 登记集随 session 生命周期消亡）。
//
// [U8 拆批修复] 闭合满足 → setTimeout(0) 同宏任务去抖合批 flush（非立即）——背靠背
//   route（终态已落 store、settle 链 route 尚在finalize 间隙）一并入批；武装后
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
  // 与 service.toNotifyRecord 的投影语义对齐；batchMember opts 透传断言用元组捕获。
  const toNotifyRecord = vi.fn((record: ExecutionRecord, opts?: { batchMember?: boolean }) =>
    makeSnapshot(record.id, {
      closedReason: record.closedReason,
      error: record.error,
      result: record.result,
      // [modeless 波3] 协调器 sync 路径传 batchMember=true（终态载荷形态判据）——
      // 快照 status 随之落 closed（真实投影语义，notifier 批头计数依赖此形态）。
      status: opts?.batchMember === true ? "closed" : "running",
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
// [two-state-convergence U4/D4 → U5 翻转] isCollectPending 判据 SSOT 形态矩阵
// ============================================================
// 门语义（设计 D4 行为级第 1 行 / U5 批行为翻转登记）：resumable 字段退役后判据
// 退化为 status 直读——真在跑 → 挂起等待；翻边轮终（idle，U4 写面权威词）→ 补发；
// W4 新态（running + stopReason=failed + result=∅，adoptEngineDeath 产物）→ 翻为
// 挂起等待（readopt settle 链承接）。

describe("[P-collect ⛔] isCollectPending 判据 SSOT 形态矩阵（two-state-convergence U5 翻转）", () => {
  it("形态①真在跑（running）→ true（闭合等待）", () => {
    expect(isCollectPending({ status: "running" })).toBe(true);
  });

  it("形态②翻边轮终（idle）→ false（status 子句排除——U4 写面权威词）", () => {
    expect(isCollectPending({ status: "idle" })).toBe(false);
  });

  it("形态③W4 新态（running + stopReason=failed，adoptEngineDeath）→ true（U5 翻转挂起）", () => {
    expect(isCollectPending({ status: "running" })).toBe(true);
  });

  it("closed 终态（idle + closedReason）→ false（status 子句吸收旧 closed 子句）", () => {
    expect(isCollectPending({ status: "idle" })).toBe(false);
  });
});

// ============================================================
// [modeless 波3] 派发登记（registerMember）语义
// ============================================================

describe("CollectCoordinator member registration ([modeless 波3])", () => {
  it("unregistered records route straight to notifyAsync (未登记 = async 路由，直通同一 record)", () => {
    const h = makeHarness();
    const record = makeRec({ id: "sa-async" });
    expect(h.coordinator.route(record)).toBe("async");
    expect(h.notifyAsync).toHaveBeenCalledTimes(1);
    expect(h.notifyAsync).toHaveBeenCalledWith(record);
    expect(h.flushBatch).not.toHaveBeenCalled();
    expect(h.coordinator.pendingCount).toBe(0);
  });

  it("registerMember is idempotent and drives memberCount (登记幂等，pendingSyncCount 口径)", () => {
    const h = makeHarness();
    expect(h.coordinator.memberCount).toBe(0);
    h.coordinator.registerMember("sa-1");
    h.coordinator.registerMember("sa-1");
    h.coordinator.registerMember("sa-2");
    expect(h.coordinator.memberCount).toBe(2);
    // 登记本身零路由副作用（登记 ≠ route）
    expect(h.notifyAsync).not.toHaveBeenCalled();
    expect(h.flushBatch).not.toHaveBeenCalled();
  });

  it("registered members route into the buffer with batchMember payload (成员 route 入批)", () => {
    const h = makeHarness();
    h.coordinator.registerMember("sa-1");
    expect(h.coordinator.route(makeRec({ id: "sa-1" }))).toBe("sync-flushed");
    expect(h.toNotifyRecord).toHaveBeenCalledWith(expect.objectContaining({ id: "sa-1" }), { batchMember: true });
  });

  it("scan limit is 1000 (与 service 冷路径同量级)", () => {
    expect(COLLECT_SCAN_LIMIT).toBe(1000);
  });
});

// ============================================================
// sync 缓冲 + 闭合检测（登记制）
// ============================================================

describe("CollectCoordinator sync buffering + closure", () => {
  it("buffers a finished sync member while another registered member is still running", () => {
    // store：sa-2 已登记且仍在跑（未收口）→ sa-1 终态入缓冲不闭合
    const h = makeHarness([
      makeStoreRec({ id: "sa-2", status: "running" }),
    ]);
    h.coordinator.registerMember("sa-1");
    h.coordinator.registerMember("sa-2");
    const result = h.coordinator.route(makeRec({ id: "sa-1" }));
    expect(result).toBe("sync-buffered");
    expect(h.coordinator.pendingCount).toBe(1);
    expect(h.flushBatch).not.toHaveBeenCalled();
  });

  it("flushes the whole buffer when the last running member finishes", async () => {
    // 时序：sa-1 先终态（sa-2 仍 running → 入缓冲）；sa-2 最后终态（store 全 idle）
    // → 闭合 flush 两成员，且批成员自登记集离场（memberCount 归零）。
    let sa2Running = true;
    const storeRecords = (): SubagentRecord[] => [
      makeStoreRec({ id: "sa-1", status: "idle" }),
      makeStoreRec({ id: "sa-2", status: sa2Running ? "running" : "idle" }),
    ];
    const h = makeHarness();
    (h as { listRecords: ReturnType<typeof vi.fn> }).listRecords.mockImplementation(storeRecords);
    h.coordinator.registerMember("sa-1");
    h.coordinator.registerMember("sa-2");
    expect(h.coordinator.route(makeRec({ id: "sa-1" }))).toBe("sync-buffered");
    sa2Running = false;
    expect(h.coordinator.route(makeRec({ id: "sa-2" }))).toBe("sync-flushed");
    await settleFlush();
    expect(h.flushBatch).toHaveBeenCalledTimes(1);
    const members = h.flushBatch.mock.calls[0]?.[0] as BgNotifyRecord[];
    expect(members.map((m) => m.id)).toEqual(["sa-1", "sa-2"]);
    expect(h.coordinator.pendingCount).toBe(0);
    expect(h.coordinator.memberCount).toBe(0);
  });

  it("unregistered running records never block sync closure (混派正交，A8 前置)", async () => {
    // sa-async 在跑但未登记（async 路由）→ 不阻止 sync 批闭合
    const h = makeHarness([
      makeStoreRec({ id: "sa-async", status: "running" }), // 无登记：async 在跑
    ]);
    h.coordinator.registerMember("sa-1");
    const result = h.coordinator.route(makeRec({ id: "sa-1" }));
    expect(result).toBe("sync-flushed");
    await settleFlush();
    expect(h.flushBatch).toHaveBeenCalledTimes(1);
  });

  it("a lone sync member flushes via the coalescing window (单成员即闭合)", async () => {
    const h = makeHarness([
      makeStoreRec({ id: "sa-1", status: "idle" }),
    ]);
    h.coordinator.registerMember("sa-1");
    const result = h.coordinator.route(makeRec({ id: "sa-1" }));
    expect(result).toBe("sync-flushed");
    await settleFlush();
    expect(h.flushBatch).toHaveBeenCalledTimes(1);
  });

  it("back-to-back routes in one macrotask coalesce into ONE flush (U8 拆批盲窗回归)", async () => {
    // 盲窗精确形态：A/B 均已收口（listAllActive 扫描恒空——终态已落 store 但
    // B 的 route 尚在 settle 链间隙）。修复前：route(A) 闭合立即 flush([A])，
    // route(B) 再 flush([B]) → 两条单成员批；修复后：同宏任务去抖窗口把 B 并入，
    // 单批两成员一次投递。
    const h = makeHarness([]); // store 空 = 双成员均已收口（盲窗扫描视图）
    h.coordinator.registerMember("sa-a");
    h.coordinator.registerMember("sa-b");
    expect(h.coordinator.route(makeRec({ id: "sa-a" }))).toBe("sync-flushed");
    expect(h.coordinator.route(makeRec({ id: "sa-b" }))).toBe("sync-flushed");
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
      makeStoreRec({ id: "sa-1", status: "idle" }),
    ]);
    h.coordinator.registerMember("sa-1");
    expect(h.coordinator.route(makeRec({ id: "sa-1" }))).toBe("sync-flushed");
    h.coordinator.cancelScheduledFlush();
    await settleFlush();
    expect(h.flushBatch).not.toHaveBeenCalled();
    expect(h.coordinator.pendingCount).toBe(1);
    expect(h.coordinator.pendingMembers().map((m) => m.id)).toEqual(["sa-1"]);
  });

  it("clear() drops timer + buffer + registry (E9/波3：批协调状态随 session 消亡)", async () => {
    const h = makeHarness([
      makeStoreRec({ id: "sa-1", status: "idle" }),
    ]);
    h.coordinator.registerMember("sa-1");
    h.coordinator.registerMember("sa-2");
    expect(h.coordinator.route(makeRec({ id: "sa-1" }))).toBe("sync-flushed");
    h.coordinator.clear();
    await settleFlush();
    expect(h.flushBatch).not.toHaveBeenCalled(); // 挂起排程已取消
    expect(h.coordinator.pendingCount).toBe(0); // 缓冲清空
    expect(h.coordinator.memberCount).toBe(0); // 登记集清空
    // clear 后旧成员 route 落 async（登记态已消亡——同进程 revive 后跨 session 不复活）
    expect(h.coordinator.route(makeRec({ id: "sa-1" }))).toBe("async");
  });

  it("skips buffering when toNotifyRecord returns undefined (gate 未过，与 async 静默跳过对称)", () => {
    const notifyAsync = vi.fn();
    const toNotifyRecord = vi.fn(() => undefined);
    const listRecords = vi.fn(() => [] as SubagentRecord[]);
    const flushBatch = vi.fn();
    const coordinator = new CollectCoordinator({ notifyAsync, toNotifyRecord, listRecords, flushBatch });
    coordinator.registerMember("sa-x");
    const result = coordinator.route(makeRec({ id: "sa-x" }));
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
    // store 枚举由「谁还活着」驱动：闭合只看登记成员是否全部收口。
    let running = new Set(["sa-b"]);
    const storeRecords = (): SubagentRecord[] =>
      [...running].map((id) => makeStoreRec({ id, status: "running" }));
    const notifyAsync = vi.fn();
    const toNotifyRecord = vi.fn((record: ExecutionRecord, opts?: { batchMember?: boolean }) =>
      makeSnapshot(record.id, { status: opts?.batchMember === true ? "closed" : "running" }),
    );
    const listRecords = vi.fn(() => storeRecords());
    const flushBatch = vi.fn();
    const coordinator = new CollectCoordinator({ notifyAsync, toNotifyRecord, listRecords, flushBatch });
    coordinator.registerMember("sa-a");
    coordinator.registerMember("sa-b");
    coordinator.registerMember("sa-c");

    // round1：A 终态（B 仍在跑）→ 缓冲 [A]
    expect(coordinator.route(makeRec({ id: "sa-a" }))).toBe("sync-buffered");
    expect(coordinator.pendingMembers().map((m) => m.id)).toEqual(["sa-a"]);

    // round2：派 C（跨轮续累——同一 pending 集）；C 终态（B 仍在跑）→ 缓冲 [A, C]
    expect(coordinator.route(makeRec({ id: "sa-c" }))).toBe("sync-buffered");
    expect(coordinator.pendingMembers().map((m) => m.id)).toEqual(["sa-a", "sa-c"]);

    // B 终态（先从 running 集移除 = 终态落 store）→ 闭合：单批三成员（2+1 同一批）
    running.delete("sa-b");
    expect(coordinator.route(makeRec({ id: "sa-b" }))).toBe("sync-flushed");
    await settleFlush();
    expect(flushBatch).toHaveBeenCalledTimes(1);
    const members = flushBatch.mock.calls[0]?.[0] as BgNotifyRecord[];
    expect(members.map((m) => m.id).sort()).toEqual(["sa-a", "sa-b", "sa-c"]);
    expect(coordinator.pendingCount).toBe(0);
  });

  it("starts a fresh batch after a flush (闭合后新派开新批)", async () => {
    // sa-2 在跑（阻止闭合）：sa-1 终态入缓冲；sa-2 终态闭合后，新派 sa-3（新登记）
    // 终态开新批。
    const store: SubagentRecord[] = [
      makeStoreRec({ id: "sa-1", status: "idle" }),
      makeStoreRec({ id: "sa-2", status: "running" }),
    ];
    const h = makeHarness();
    (h as { listRecords: ReturnType<typeof vi.fn> }).listRecords.mockImplementation(() => store);
    h.coordinator.registerMember("sa-1");
    h.coordinator.registerMember("sa-2");
    expect(h.coordinator.route(makeRec({ id: "sa-1" }))).toBe("sync-buffered");
    store[1] = makeStoreRec({ id: "sa-2", status: "idle" });
    expect(h.coordinator.route(makeRec({ id: "sa-2" }))).toBe("sync-flushed");
    await settleFlush(); // 第一批投出（合批窗口开）
    // 闭合后新 sync 终态 → 新批缓冲（不复活旧成员——旧成员已自登记集离场）：
    // route(sa-3) 时缓冲空 + 无登记中 running → 闭合开新批排程
    h.coordinator.registerMember("sa-3");
    expect(h.coordinator.route(makeRec({ id: "sa-3" }))).toBe("sync-flushed");
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
      makeStoreRec({ id: "sa-1", status: "idle" }),
    ]);
    h.coordinator.registerMember("sa-1");
    const record = makeRec({
      id: "sa-1",
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
      makeStoreRec({ id: "sa-1", status: "idle" }),
    ]);
    h.coordinator.registerMember("sa-1");
    const record = makeRec({
      id: "sa-1",
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
