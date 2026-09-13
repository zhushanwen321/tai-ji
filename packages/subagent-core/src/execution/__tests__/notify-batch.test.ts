// src/execution/__tests__/notify-batch.test.ts
//
// notifier.notifyBatch 单测族（subagent-sync-collect U3）：
//   1. buildBatchNotifyId：幂等键 sync-batch:<sha1(sorted ids)>——同成员集不同登记
//      顺序同 hash（D2 隐式批身份稳定性），不同成员集异 hash；
//   2. buildBatchLlmContent：批头计数（N finished / M failed / K cancelled，A3/A8
//      前置）+ 批头行与成员条目 "\n\n---\n\n" join 形态；
//   3. notifyBatch + fake ledger：单 entry 写账 + notifyId 正确 + details 批形态 +
//      attemptDeliver 边沿投递（与 notify 同一四步链）；
//   4. notifyBatch 幂等：同成员集二次投递被账本拒绝（零副作用）；
//   5. notifyBatch 无 ledger 降级：内核路径单条 send（dedupeKey = 批 hash）；
//   6. CollectCoordinator ↔ notifyBatch 集成：跨轮续累（D2 探针）——分两轮 route
//      2+1 sync → 闭合时单批 3 成员一次投递。
//
// fake ledger host 手法对齐 notify-ledger.test.ts（同款 mock host + settled 回调）；
// 全程 tmpdir 零文件 IO（本族纯内存）；env 剥离见 beforeEach（RELAY/PI_SUBAGENT
// 泄漏防护，impl-plan 偏差#5 同族）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

import {
  bindNotifyLedgerHost,
  NOTIFY_CUSTOM_TYPE,
  NOTIFY_LEDGER_CUSTOM_TYPE,
  _resetNotifyLedgerForTest,
  type NotifyLedgerHost,
} from "../notify/notify-ledger.ts";
import {
  buildBatchLlmContent,
  buildBatchNotifyId,
  createNotifier,
  type BgNotifyRecord,
  type NotifierHost,
} from "../notify/notifier.ts";
import { CollectCoordinator } from "../assembly/collect-coordinator.ts";
import type { ExecutionRecord, SubagentRecord } from "../assembly/types.ts";

// ─── env 剥离（impl-plan 偏差#5：RELAY/PI_SUBAGENT 泄漏即红的存量敏感面隔离）──

const STRIPPED_ENV_PREFIXES = ["XYZ_SUBAGENT_RELAY_", "PI_SUBAGENT_"] as const;

function stripSensitiveEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (STRIPPED_ENV_PREFIXES.some((p) => key.startsWith(p))) delete process.env[key];
  }
}

// ─── fake ledger host（notify-ledger.test.ts 同款）──

interface LedgerHostMock {
  host: NotifyLedgerHost;
  // appendLedgerEntry（type/customType/data）与 sendDelivery（customType/content/display/details）
  // 两种 entry 形态共用一个收集数组，宽化为字段并集
  entries: { type: string; customType: string; data?: Record<string, unknown>; content?: string; display?: boolean; details?: unknown }[];
  sentMessages: { customType: string; content: string; display: boolean; details?: unknown }[];
  settledHandlers: Array<() => void>;
  setIdle(idle: boolean): void;
}

function makeLedgerHost(): LedgerHostMock {
  const entries: LedgerHostMock["entries"] = [];
  const sentMessages: LedgerHostMock["sentMessages"] = [];
  const settledHandlers: Array<() => void> = [];
  const idle = { value: true };
  return {
    host: {
      appendLedgerEntry: (customType, data) => {
        entries.push({ type: "custom", customType, data: data as Record<string, unknown> });
      },
      readSessionEntries: () => entries,
      isIdle: () => idle.value,
      onAgentSettled: (handler) => {
        settledHandlers.push(handler);
      },
      sendDelivery: (message) => {
        sentMessages.push(message);
        entries.push({
          type: "custom_message",
          customType: message.customType,
          content: message.content,
          display: message.display,
          details: message.details as Record<string, unknown>,
        });
      },
    },
    entries,
    sentMessages,
    settledHandlers,
    setIdle: (v: boolean) => {
      idle.value = v;
    },
  };
}

// ─── 成员快照工厂 ──

function makeMember(id: string, over: Partial<BgNotifyRecord> = {}): BgNotifyRecord {
  return {
    id,
    status: "closed",
    agent: `worker-${id}`,
    result: `result of ${id}`,
    startedAt: 1000,
    endedAt: 2000,
    ...over,
  };
}

// ─── 协调器集成 harness（collect-coordinator.test.ts 同款注入风格）──

function makeExecutionRecord(id: string, collectMode: "sync" | undefined): ExecutionRecord {
  return {
    id,
    agent: "/agents/worker.md",
    model: "prov/m1",
    thinkingLevel: undefined,
    mode: "background",
    task: "t",
    slug: "worker",
    startedAt: 1000,
    rootSessionId: "root-A",
    parentRecordId: undefined,
    depth: 0,
    status: "idle",
    closedReason: "gc",
    turns: [],
    turnCount: 1,
    totalTokens: 10,
    lastError: undefined,
    endedAt: 2000,
    result: `result of ${id}`,
    error: undefined,
    agentResult: undefined,
    controller: undefined,
    collectMode,
  } as ExecutionRecord;
}

function makeStoreRec(id: string, collectMode: "sync" | undefined, status: "idle" | "running"): SubagentRecord {
  return {
    id,
    agent: "/agents/worker.md",
    task: "t",
    slug: "worker",
    status,
    closedReason: status === "idle" ? "gc" : undefined,
    mode: "background",
    startedAt: 1000,
    rootSessionId: "root-A",
    parentRecordId: undefined,
    depth: 0,
    endedAt: status === "idle" ? 2000 : undefined,
    turns: 1,
    totalTokens: 10,
    model: "prov/m1",
    thinkingLevel: undefined,
    eventLog: [],
    displayItems: [],
    collectMode,
  } as SubagentRecord;
}

beforeEach(() => {
  stripSensitiveEnv();
});

afterEach(() => {
  _resetNotifyLedgerForTest();
});

// ─── 1. 批身份键 ──

describe("buildBatchNotifyId — sync-batch:<sha1(sorted ids)>", () => {
  it("同成员集不同登记顺序同 hash（D2 隐式批身份稳定性）", () => {
    const a = buildBatchNotifyId(["sa-c", "sa-a", "sa-b"]);
    const b = buildBatchNotifyId(["sa-b", "sa-c", "sa-a"]);
    const c = buildBatchNotifyId(["sa-a", "sa-b", "sa-c"]);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("前缀 sync-batch: + 不同成员集异 hash（跨批不互吞）", () => {
    const id = buildBatchNotifyId(["sa-1", "sa-2"]);
    expect(id.startsWith("sync-batch:")).toBe(true);
    expect(id).not.toBe(buildBatchNotifyId(["sa-1", "sa-3"]));
    // 单成员批也是合法批（后派 async 与残留单 sync 的混派边界）
    expect(buildBatchNotifyId(["sa-1"])).not.toBe(buildBatchNotifyId(["sa-2"]));
  });
});

// ─── 2. 批头计数 + join 形态 ──

describe("buildBatchLlmContent — 批头计数与 join 形态（A3/A8 前置）", () => {
  it("3 finished：批头 `3 finished, 0 failed, 0 cancelled.` + 三条目 join", () => {
    const members = [makeMember("sa-1"), makeMember("sa-2"), makeMember("sa-3")];
    const content = buildBatchLlmContent(members);
    const lines = content.split("\n\n---\n\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("Subagent batch completed: 3 finished, 0 failed, 0 cancelled.");
    expect(lines[1]).toBe('Subagent "worker-sa-1" (sa-1) completed. Result:\nresult of sa-1');
    expect(lines[3]).toBe('Subagent "worker-sa-3" (sa-3) completed. Result:\nresult of sa-3');
  });

  it("1 failed + 2 finished：失败条目 error 内联全文形态（A3，多行 error 原样保留）", () => {
    const members = [
      makeMember("sa-ok-1"),
      makeMember("sa-bad", { result: undefined, error: "spawn EPIPE\ndetail line" }),
      makeMember("sa-ok-2"),
    ];
    const content = buildBatchLlmContent(members);
    expect(content).toContain("Subagent batch completed: 2 finished, 1 failed, 0 cancelled.");
    expect(content).toContain('Subagent "worker-sa-bad" (sa-bad) failed: spawn EPIPE\ndetail line');
  });

  it("cancelled 计数：cancelled 条目短文案（E6 cancel 入批）", () => {
    const members = [
      makeMember("sa-ok"),
      makeMember("sa-gone", { result: undefined, closedReason: "cancelled" }),
    ];
    const content = buildBatchLlmContent(members);
    expect(content).toContain("Subagent batch completed: 1 finished, 0 failed, 1 cancelled.");
    expect(content).toContain('Subagent "worker-sa-gone" (sa-gone) cancelled.');
  });

  it("outcome 已物化的成员直接读（不二次派生，计数与条目同源）", () => {
    const members = [makeMember("sa-1", { outcome: "failed", error: "boom" })];
    const content = buildBatchLlmContent(members);
    expect(content).toContain("Subagent batch completed: 0 finished, 1 failed, 0 cancelled.");
  });
});

// ─── 3+4. notifyBatch × ledger 四步链 + 幂等 ──

describe("notifyBatch — ledger 写账 → 边沿投递（与 notify 同一通道，单 entry）", () => {
  it("闭合投递：单 entry 写账 + notifyId = sync-batch hash + details 批形态（顶层 notifyId 可达）", () => {
    const mock = makeLedgerHost();
    bindNotifyLedgerHost(mock.host);
    const notifier = createNotifier({
      sendMessage: () => {},
      hasRunningBackground: () => false,
      isIdle: () => true,
    });

    const members = [makeMember("sa-b"), makeMember("sa-a")];
    const expectedId = buildBatchNotifyId(["sa-b", "sa-a"]);
    const accepted = notifier.notifyBatch(members);
    expect(accepted).toBe(true);

    // 单 entry 写账：notifyId 为成员集 hash（与登记顺序无关）
    const ledgerEntries = mock.entries.filter((e) => e.customType === NOTIFY_LEDGER_CUSTOM_TYPE);
    expect(ledgerEntries).toHaveLength(1);
    expect(ledgerEntries[0]?.data?.["notifyId"]).toBe(expectedId);

    // idle → attemptDeliver 立即投递：单条批消息（不与 mergeItems 再包一层——批即单 entry）
    expect(mock.sentMessages).toHaveLength(1);
    const sent = mock.sentMessages[0]!;
    expect(sent.customType).toBe(NOTIFY_CUSTOM_TYPE);
    expect(sent.content).toContain("Subagent batch completed: 2 finished, 0 failed, 0 cancelled.");
    expect(sent.content).toContain('Subagent "worker-sa-a" (sa-a) completed. Result:\nresult of sa-a');
    const details = sent.details as { batch: boolean; notifyId: string; items: BgNotifyRecord[] };
    expect(details.batch).toBe(true);
    // 顶层 notifyId = 回执匹配键（collectDeliveredNotifyIds 认 details.notifyId）
    expect(details.notifyId).toBe(expectedId);
    expect(details.items).toHaveLength(2);
    expect(details.items.map((i) => i.id)).toEqual(["sa-b", "sa-a"]);
    // 成员条目 outcome 物化（bg-notify-render 渲染锁依赖顶层 outcome）
    expect(details.items.every((i) => i.outcome === "completed")).toBe(true);

    // 回执销账闭环：送达 entry 的 details.notifyId 匹配 → settled 边沿后账面清零
    const fireSettled = () => {
      for (const handler of mock.settledHandlers) handler();
    };
    fireSettled();
    expect(mock.entries.some((e) => e.customType === "subagent-bg-notify-ack" && e.data?.["notifyId"] === expectedId)).toBe(true);

    notifier.dispose();
  });

  it("busy 挂 pending，settled 边沿补投（闭合触发即 flush 的 busy 分支）", () => {
    const mock = makeLedgerHost();
    bindNotifyLedgerHost(mock.host);
    mock.setIdle(false);
    const notifier = createNotifier({
      sendMessage: () => {},
      hasRunningBackground: () => false,
      isIdle: () => false,
    });

    expect(notifier.notifyBatch([makeMember("sa-1")])).toBe(true);
    expect(mock.sentMessages).toHaveLength(0); // busy：账已落，投递挂边沿
    expect(mock.entries.filter((e) => e.customType === NOTIFY_LEDGER_CUSTOM_TYPE)).toHaveLength(1);

    mock.setIdle(true);
    for (const handler of mock.settledHandlers) handler();
    expect(mock.sentMessages).toHaveLength(1);
    notifier.dispose();
  });

  it("幂等：同成员集二次 notifyBatch 被账本拒绝（零副作用）——E1 重建重发防线", () => {
    const mock = makeLedgerHost();
    bindNotifyLedgerHost(mock.host);
    mock.setIdle(false); // 挂 pending，隔离投递时机干扰
    const notifier = createNotifier({
      sendMessage: () => {},
      hasRunningBackground: () => false,
      isIdle: () => false,
    });

    const members = [makeMember("sa-1"), makeMember("sa-2")];
    expect(notifier.notifyBatch(members)).toBe(true);
    const entriesBefore = mock.entries.length;
    // 乱序同成员集 → 同 hash → 拒绝
    expect(notifier.notifyBatch([members[1]!, members[0]!])).toBe(false);
    expect(mock.entries).toHaveLength(entriesBefore);

    // 异成员集 → 异 hash → 新批独立写账
    expect(notifier.notifyBatch([makeMember("sa-1"), makeMember("sa-3")])).toBe(true);
    const ledgerIds = mock.entries
      .filter((e) => e.customType === NOTIFY_LEDGER_CUSTOM_TYPE)
      .map((e) => e.data?.["notifyId"]);
    expect(new Set(ledgerIds).size).toBe(2);

    notifier.dispose();
  });

  it("空批 / dispose 后：false 短路零副作用", () => {
    const mock = makeLedgerHost();
    bindNotifyLedgerHost(mock.host);
    const notifier = createNotifier({
      sendMessage: () => {},
      hasRunningBackground: () => false,
      isIdle: () => true,
    });
    expect(notifier.notifyBatch([])).toBe(false);
    notifier.dispose();
    expect(notifier.notifyBatch([makeMember("sa-1")])).toBe(false);
    expect(mock.entries).toHaveLength(0);
  });
});

// ─── 5. 无 ledger 降级 ──

describe("notifyBatch — 无 ledger 内核路径降级（旧装配/无 ledger 测试兼容）", () => {
  it("handle.send 单条批消息，dedupeKey = 批 hash", () => {
    const sent: { content: string; details: unknown }[] = [];
    const notifier = createNotifier({
      sendMessage: (message) => {
        sent.push({ content: (message as { content: string }).content, details: (message as { details?: unknown }).details });
      },
      hasRunningBackground: () => false,
      isIdle: () => true,
    });
    const accepted = notifier.notifyBatch([makeMember("sa-x"), makeMember("sa-y")]);
    expect(accepted).toBe(true);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining("notify ledger not bound"),
      expect.objectContaining({ notifyId: buildBatchNotifyId(["sa-x", "sa-y"]) }),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.content).toContain("Subagent batch completed: 2 finished, 0 failed, 0 cancelled.");
    expect((sent[0]!.details as { batch: boolean }).batch).toBe(true);
    notifier.dispose();
  });
});

// ─── 6. 协调器 ↔ notifyBatch 集成（D2 跨轮续累）──

describe("CollectCoordinator ↔ notifyBatch 集成 — 跨轮续累单批（D2 探针）", () => {
  /** 真协调器 + 真 notifier（fake ledger host）+ store 枚举 stub：route 全真链。 */
  function makeHarness(storeRecords: SubagentRecord[]) {
    const mock = makeLedgerHost();
    bindNotifyLedgerHost(mock.host);
    const notifier = createNotifier({
      sendMessage: () => {},
      hasRunningBackground: () => false,
      isIdle: () => true,
    });
    const coordinator = new CollectCoordinator({
      notifyAsync: () => {},
      toNotifyRecord: (record) => ({
        id: record.id,
        status: "closed" as const,
        agent: `worker-${record.id}`,
        result: `result of ${record.id}`,
        startedAt: 1000,
        endedAt: 2000,
      }),
      listRecords: (limit) => storeRecords.slice(0, limit),
      // flushBatch 签名已 async 化（deps 契约 Promise<void>）；本 fake 只透传 notifyBatch
      flushBatch: async (members) => {
        notifier.notifyBatch(members);
      },
    });
    return { mock, notifier, coordinator };
  }

/** [U8 拆批修复] 闭合合批排程窗口等待：flush 排程 = setTimeout(0)（Node 1ms clamp），
 *  10ms 真实定时器保证窗口已开（本包 vitest 真实 timers 环境）。 */
async function settleFlush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

  it("分两轮派 2+1 sync：闭合时单批 3 成员一次投递（D2）", async () => {
    // 第一轮：2 sync 终态，第三台仍在跑（非终态 → 不闭合）
    const storeRecords = [
      makeStoreRec("sa-1", "sync", "idle"),
      makeStoreRec("sa-2", "sync", "idle"),
      makeStoreRec("sa-3", "sync", "running"),
    ];
    const { mock, coordinator } = makeHarness(storeRecords);

    expect(coordinator.route(makeExecutionRecord("sa-1", "sync"))).toBe("sync-buffered");
    expect(coordinator.route(makeExecutionRecord("sa-2", "sync"))).toBe("sync-buffered");
    expect(coordinator.pendingCount).toBe(2);
    expect(mock.sentMessages).toHaveLength(0);

    // 第二轮：sa-3 终态（store 快照同步终态）→ 闭合 → 单批 3 成员
    storeRecords[2] = makeStoreRec("sa-3", "sync", "idle");
    expect(coordinator.route(makeExecutionRecord("sa-3", "sync"))).toBe("sync-flushed");
    await settleFlush();
    expect(coordinator.pendingCount).toBe(0);

    expect(mock.sentMessages).toHaveLength(1);
    const sent = mock.sentMessages[0]!;
    expect(sent.content).toContain("Subagent batch completed: 3 finished, 0 failed, 0 cancelled.");
    expect(sent.content).toContain("Subagent batch completed: 3 finished");
    const details = sent.details as { batch: boolean; notifyId: string; items: BgNotifyRecord[] };
    expect(details.items.map((i) => i.id).sort()).toEqual(["sa-1", "sa-2", "sa-3"]);
    expect(details.notifyId).toBe(buildBatchNotifyId(["sa-1", "sa-2", "sa-3"]));
  });

  it("flush 后新 sync 成员开新批（缓冲清空语义），两批 hash 互异", async () => {
    const storeRecords = [makeStoreRec("sa-1", "sync", "idle")];
    const { mock, coordinator } = makeHarness(storeRecords);

    expect(coordinator.route(makeExecutionRecord("sa-1", "sync"))).toBe("sync-flushed");
    await settleFlush();
    // 第一批已投（仍挂 pending——idle），第二批成员入缓冲
    storeRecords.push(makeStoreRec("sa-2", "sync", "idle"));
    expect(coordinator.route(makeExecutionRecord("sa-2", "sync"))).toBe("sync-flushed");
    await settleFlush();

    expect(mock.sentMessages).toHaveLength(2);
    const ids = mock.sentMessages.map((m) => (m.details as { notifyId: string }).notifyId);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain(buildBatchNotifyId(["sa-1"]));
    expect(ids).toContain(buildBatchNotifyId(["sa-2"]));
  });

  it("混派正交（A8）：async record 直通不走批，sync 成员批闭合不受 async 干扰", async () => {
    const storeRecords = [
      makeStoreRec("sa-sync", "sync", "idle"),
      makeStoreRec("sa-async", undefined, "idle"),
    ];
    const asyncDirect: BgNotifyRecord[] = [];
    const mock = makeLedgerHost();
    bindNotifyLedgerHost(mock.host);
    const notifier = createNotifier({
      sendMessage: () => {},
      hasRunningBackground: () => false,
      isIdle: () => true,
    });
    const coordinator = new CollectCoordinator({
      notifyAsync: (record) => {
        asyncDirect.push({
          id: record.id,
          status: "closed",
          agent: `worker-${record.id}`,
          result: `result of ${record.id}`,
          startedAt: 1000,
          endedAt: 2000,
        });
      },
      toNotifyRecord: (record) => ({
        id: record.id,
        status: "closed" as const,
        agent: `worker-${record.id}`,
        result: `result of ${record.id}`,
        startedAt: 1000,
        endedAt: 2000,
      }),
      listRecords: (limit) => storeRecords.slice(0, limit),
      flushBatch: async (members) => {
        notifier.notifyBatch(members);
      },
    });

    expect(coordinator.route(makeExecutionRecord("sa-async", undefined))).toBe("async");
    expect(coordinator.route(makeExecutionRecord("sa-sync", "sync"))).toBe("sync-flushed");
    await settleFlush();
    // async 直通收集器（生产接 notifier.notify），批通道只见 sync 成员
    expect(asyncDirect.map((r) => r.id)).toEqual(["sa-async"]);
    expect(mock.sentMessages).toHaveLength(1);
    const details = mock.sentMessages[0]!.details as { items: BgNotifyRecord[] };
    expect(details.items.map((i) => i.id)).toEqual(["sa-sync"]);
  });
});
