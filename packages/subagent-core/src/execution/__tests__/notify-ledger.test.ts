// src/execution/__tests__/notify-ledger.test.ts
//
// U2 B-ledger 单测族：通知账本与 courier 的四步生命周期
// （设计 docs/design/subagent-dispatch-reliability.md §3.3 D4/D5）。
// u-5c 迁自壳套件 src/__tests__/notify-ledger.test.ts（被测 module 是 core 件，
// 唯一测试覆盖原落壳——设计 §2.2 C6 / §1 目标 6）。
//
// 覆盖验收面：
//   - 写账先于投递（顺序断言：appendEntry ledger entry 先于 sendMessage）
//   - settled 边沿投递 + isIdle 二次复查命中 busy 时挂回 pending
//   - 回执销账（ack entry 追加）后两列 entry 差集为空
//   - 重启恢复（新实例扫账本）重放未销账号、已销账零重发
//   - notifyId 幂等（重复 record / 重复投递条目可识别）
//   - 120s 看门狗触发（fake timers；主 session 长期无 settled 兜底 + 超时重投）
//   - 合并投递（同一边沿多条 pending 单条送达，content join + batch details）
//   - compaction 降级（ledger/ack entry 被清除后按内存态补写）
//   - session_start 恢复钩子（bindNotifyLedgerHost + recoverFromSession：
//     mock session entries 含 ledger/ack entry → 重放差集）
//   - notifier 四步接线（createNotifier + bindNotifyLedgerHost：notify → 写账 →
//     边沿投递 → 回执销账全链路）
//
// u-5c 迁移改写（core 依赖闭包禁 pi 系包，验收「零跨包 specifier」）：
//   - 投递内核由真实 @xyz-agent/session-delivery createDelivery 改为下方内联
//     内核等价桩（notifier 实际消费的内核行为切片：payload fail-fast / dedupe /
//     busy gate / 空闲立即投 / 同步 send 失败 warn + 退避重试 / 批量 join 形态），
//     内核自身全量语义（合批窗口 / checked / watchdog 等）由 session-delivery
//     包自有测试守卫，此处锚定的是 notifier 对内核契约的消费面。
//
// 合并终态（feat 容器 + dev T4③ 增量）：
//   - 追加 T4③ 重投止损（PS-6）族：回执确认不可达时 attempts 上限 + abandoned
//     放弃终态（docs/design/subagent-core-unbounded-wait-audit.md §7.2 T4③ /
//     §8.2 S-E）；差集 helper 相应升级三列（ledger − ack − abandoned）。
//   - logger 基建统一 dev 侧 configureCore sink（core logger facade 经
//     host-services 动态解析宿主实现，见 agents-assembly.test.ts 同款）——
//     移除 u-5c 期的 vi.mock(core/logger)，日志断言用例自行注入 logCalls sink。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureNotifyDomain, resetNotifyDomainForTests } from "../../core/notify-ports.ts";
import type {
  DeliveryConfig,
  DeliveryHandle,
  DeliveryMessage,
  DeliveryPort,
} from "../../core/notify-ports.ts";
import { configureCore, resetCoreForTests } from "../../core/host-services.ts";
import {
  bindNotifyLedgerHost,
  createNotifyLedger,
  getBoundNotifyLedger,
  NOTIFY_ABANDONED_CUSTOM_TYPE,
  NOTIFY_ACK_CUSTOM_TYPE,
  NOTIFY_CUSTOM_TYPE,
  NOTIFY_LEDGER_CUSTOM_TYPE,
  NOTIFY_REDELIVERY_MAX_ATTEMPTS,
  NOTIFY_WATCHDOG_MS,
  _resetNotifyLedgerForTest,
  type NotifyLedgerHost,
} from "../notify-ledger.ts";
import { createNotifier, type BgNotifyRecord, type NotifierHost } from "../notifier.ts";

// ─── 投递内核等价桩（u-5c：替代真实 session-delivery createDelivery） ──────
//
// 忠实复刻 notifier 消费面触及的内核行为（对照 packages/session-delivery
// src/delivery.ts 同名实现）：
//   - send()：payload 能力 fail-fast → dedupe → 入队 → 无合批依赖时立即
//     scheduleFlush(0)（mergeHoldActive()=false 路径，notifier 单条通知即时投）
//   - busy gate：isIdle() + hasPendingMessages() 双条件，busy 时退避轮询
//     （无 subscribeSettled 装配的形态——notifier 测试 host 均不注入 onAgentSettled）
//   - attemptSend()：同步 port.send（notifier port 契约返回 void = 受理成功）；
//     同步抛错 → onSendFail → warn("port.send failed, retrying with backoff")
//     + 退避重试，达上限终态 warn
//   - buildBatchPayload()：多条合批 content join "\n\n---\n\n" + batch details
//     （与 ledger 侧合批形态同构，钉住跨件一致的两处 join 语义）
function createDelivery(port: DeliveryPort, options?: DeliveryConfig): DeliveryHandle {
  const cfg = {
    intent: options?.intent ?? ("interrupt-at-turn-boundary" as const),
    mergeWindowMs: options?.mergeWindowMs ?? 0,
    mergeHoldActive: options?.mergeHoldActive,
    busyPolicy: options?.busyPolicy ?? ("retry-force" as const),
    backoff: options?.backoff ?? { ms: 100, max: 50 },
    warn: options?.warn ?? ((msg: string, err?: unknown) => { console.warn(`[session-delivery] ${msg}`, err ?? ""); }),
  };

  const queue: DeliveryMessage[] = [];
  let inflightBatch: DeliveryMessage[] = [];
  let inFlight = false;
  let sendAttempts = 0;
  let backoffTimer: ReturnType<typeof setTimeout> | undefined;
  let mergeTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const dedupSet = options?.dedupe ? new Set<string>() : null;

  function buildBatchPayload(batch: DeliveryMessage[]): DeliveryMessage {
    if (batch.length === 1) return batch[0]!;
    const first = batch[0]!;
    const contents = batch.map((m) => m.payload.content);
    const content = contents.join("\n\n---\n\n");
    if (first.payload.kind !== "custom") {
      return { ...first, payload: { kind: "text", content } };
    }
    return {
      ...first,
      payload: {
        kind: "custom",
        customType: first.payload.customType,
        content,
        display: first.payload.display,
        details: {
          batch: true,
          items: batch.map((m) =>
            m.payload.kind === "custom" && m.payload.details !== undefined
              ? m.payload.details
              : m.payload,
          ),
        },
      },
    };
  }

  function isBusy(): boolean {
    try {
      if (!port.isIdle()) return true;
      return port.hasPendingMessages();
    } catch {
      return true;
    }
  }

  function attemptSend(): void {
    const composed = buildBatchPayload(inflightBatch);
    try {
      port.send(composed, composed.intent ?? cfg.intent);
      onSendOk();
    } catch (err) {
      onSendFail(composed, err);
    }
  }

  function onSendOk(): void {
    if (disposed) return;
    inFlight = false;
    inflightBatch = [];
    sendAttempts = 0;
    if (queue.length > 0) scheduleFlush(0);
  }

  function onSendFail(composed: DeliveryMessage, err: unknown): void {
    if (disposed) return;
    void composed;
    sendAttempts++;
    if (sendAttempts > cfg.backoff.max) {
      inFlight = false;
      inflightBatch = [];
      sendAttempts = 0;
      cfg.warn("port.send failed after max retries", err);
      return;
    }
    if (sendAttempts === 1) cfg.warn("port.send failed, retrying with backoff", err);
    backoffTimer = setTimeout(() => {
      backoffTimer = undefined;
      if (disposed || !inFlight) return;
      attemptSend();
    }, cfg.backoff.ms);
  }

  function doSend(): void {
    if (disposed || queue.length === 0 || inFlight) return;
    inFlight = true;
    inflightBatch = queue.splice(0);
    sendAttempts = 0;
    attemptSend();
  }

  function scheduleFlush(attempt: number): void {
    if (disposed || queue.length === 0 || inFlight) return;
    if (cfg.busyPolicy === "park" && attempt > 0) return;
    if (backoffTimer !== undefined) {
      clearTimeout(backoffTimer);
      backoffTimer = undefined;
    }
    if (isBusy() && attempt < cfg.backoff.max) {
      backoffTimer = setTimeout(() => {
        backoffTimer = undefined;
        scheduleFlush(attempt + 1);
      }, cfg.backoff.ms);
      return;
    }
    doSend();
  }

  return {
    send(msg, opts) {
      if (disposed) return;
      if (!port.supportedPayloads.includes(msg.payload.kind)) {
        cfg.warn(`unsupported payload kind: ${msg.payload.kind}`);
        return;
      }
      if (dedupSet) {
        if (msg.dedupeKey !== undefined) {
          if (dedupSet.has(msg.dedupeKey)) return;
          dedupSet.add(msg.dedupeKey);
        }
      }
      queue.push(msg);
      const useMerge =
        opts?.merge ??
        (cfg.mergeWindowMs > 0 && cfg.mergeHoldActive != null && cfg.mergeHoldActive());
      if (useMerge) {
        if (mergeTimer !== undefined) clearTimeout(mergeTimer);
        mergeTimer = setTimeout(() => {
          mergeTimer = undefined;
          scheduleFlush(0);
        }, cfg.mergeWindowMs);
        return;
      }
      if (mergeTimer !== undefined) {
        clearTimeout(mergeTimer);
        mergeTimer = undefined;
      }
      scheduleFlush(0);
    },
    flush() {
      if (disposed) return;
      if (mergeTimer !== undefined) {
        clearTimeout(mergeTimer);
        mergeTimer = undefined;
      }
      scheduleFlush(0);
    },
    dispose() {
      disposed = true;
      queue.length = 0;
      inflightBatch = [];
      inFlight = false;
      if (backoffTimer !== undefined) clearTimeout(backoffTimer);
      if (mergeTimer !== undefined) clearTimeout(mergeTimer);
    },
  };
}

// 投递内核经通知域窄端口注入（notifier 不再直接 import session-delivery）——
// 「ledger 未 bind 退回内核路径」与「U4 warn 注入」用例依赖内核语义
// （gate / 合批 / onSendFail warn 出口），注入内核等价桩保住回归面；
// afterEach 重置防注入态泄漏。
//
// 同层注入 core host no-op sink：logger facade 经 host-services 动态解析，
// 缺省 NULL_HOST 的 warn/error 走 console（会刷屏且污染「console 零调用」类
// 断言）；no-op sink 保持零噪音。日志断言用例（分桶 / U4 warn / T4③）在自身
// 用例或 beforeEach 内 configureCore 覆盖注入 logCalls sink——覆盖式写入、
// describe 内层后执行，天然生效。
const NOOP_HOST = {
  dataRoot: () => "/fake-notify-ledger-data-root",
  log: () => {},
};
beforeEach(() => {
  configureNotifyDomain({ createDelivery });
  configureCore(NOOP_HOST);
});
afterEach(() => {
  resetNotifyDomainForTests();
  resetCoreForTests();
});

// ─── mock host ─────────────────────────────────────────────

interface LedgerHostMock {
  host: NotifyLedgerHost;
  /** 追加的 plain custom entry（ledger/ack/abandoned 三列，含 customType）。与
   *  sessionEntries 共享同一数组——送达 custom_message entry 也会落入（无 data 字段）。 */
  entries: { type: string; customType: string; data?: Record<string, unknown> }[];
  /** session entries 视图（回执扫描 + 恢复扫描的输入；与 entries 共享同一数组）。 */
  sessionEntries: unknown[];
  /** 送达消息（sendDelivery 调用）。 */
  sentMessages: { customType: string; content: string; display: boolean; details?: unknown }[];
  /** settled 边沿回调（测试手动触发模拟 pi agent_settled 事件）。 */
  settledHandlers: Array<() => void>;
  setIdle(idle: boolean): void;
  /** 送达是否同步落盘为 custom_message entry（模拟 pi：triggerTurn run 结束后落盘）。
   *  false = 模拟回执延迟/丢失（消息滞留内存）/ 回执不可匹配（PS-6 触发态）。 */
  deliverPersists: { value: boolean };
  /** U4：sendDelivery 是否抛异常（模拟受理被拒——下方 sendDelivery 首行 throw）。 */
  deliveryThrows: { value: boolean };
}

function makeLedgerHost(): LedgerHostMock {
  const entries: LedgerHostMock["entries"] = [];
  const sessionEntries: unknown[] = entries;
  const sentMessages: LedgerHostMock["sentMessages"] = [];
  const settledHandlers: Array<() => void> = [];
  const idle = { value: true };
  const deliverPersists = { value: true };
  const deliveryThrows = { value: false };
  const host: NotifyLedgerHost = {
    appendLedgerEntry: (customType, data) => {
      entries.push({ type: "custom", customType, data: data as Record<string, unknown> | undefined });
    },
    readSessionEntries: () => sessionEntries,
    isIdle: () => idle.value,
    onAgentSettled: (handler) => {
      settledHandlers.push(handler);
    },
    sendDelivery: (message) => {
      if (deliveryThrows.value) {
        throw new Error("delivery rejected (mock)");
      }
      sentMessages.push(message);
      if (deliverPersists.value) {
        sessionEntries.push({
          type: "custom_message",
          customType: message.customType,
          content: message.content,
          display: message.display,
          details: message.details,
        });
      }
    },
  };
  return {
    host,
    entries,
    sessionEntries,
    sentMessages,
    settledHandlers,
    setIdle: (v) => {
      idle.value = v;
    },
    deliverPersists,
    deliveryThrows,
  };
}

/** 触发一次 settled 边沿（模拟 pi agent_settled 事件）。 */
function fireSettled(mock: LedgerHostMock): void {
  for (const handler of mock.settledHandlers) handler();
}

/** 未终态号差集：ledger entry 的 notifyId −（ack ∪ abandoned）的 notifyId
 *  （T4③ 后终态有两列：已销账 + 已放弃；两列均不算「未投完」）。 */
function unsettledDiff(mock: LedgerHostMock): Set<string> {
  const ledgerIds = new Set<string>();
  const settled = new Set<string>();
  for (const e of mock.entries) {
    if (e.customType !== NOTIFY_LEDGER_CUSTOM_TYPE && e.customType !== NOTIFY_ACK_CUSTOM_TYPE && e.customType !== NOTIFY_ABANDONED_CUSTOM_TYPE) {
      continue;
    }
    const notifyId = e.data?.["notifyId"];
    if (typeof notifyId !== "string") continue;
    if (e.customType === NOTIFY_LEDGER_CUSTOM_TYPE) ledgerIds.add(notifyId);
    else settled.add(notifyId);
  }
  for (const id of settled) ledgerIds.delete(id);
  return ledgerIds;
}

function abandonedEntries(mock: LedgerHostMock): { data?: Record<string, unknown> }[] {
  return mock.entries.filter((e) => e.customType === NOTIFY_ABANDONED_CUSTOM_TYPE);
}

/** 从日志 sink 中取放弃 warn（区别于分桶 warn「notify delivery bucket [...]」）。 */
function abandonedWarns(
  logs: Array<{ level: string; component?: string; message: string; data?: unknown }>,
): Array<{
  level: string;
  component?: string;
  message: string;
  data?: unknown;
}> {
  return logs.filter((l) => l.level === "warn" && l.message.includes("abandoned"));
}

// ─── 账本四步生命周期 ─────────────────────────────────────

describe("NotifyLedger — 四步生命周期（D4/D5）", () => {
  beforeEach(() => {
    _resetNotifyLedgerForTest();
  });
  afterEach(() => {
    _resetNotifyLedgerForTest();
  });

  it("①→② 写账先于投递：appendEntry(ledger) 先于 sendDelivery（顺序断言）", () => {
    const mock = makeLedgerHost();
    const ledger = createNotifyLedger(mock.host);

    const recorded = ledger.record("sa-1", "content-1", { notifyId: "sa-1", id: "sa-1" });
    expect(recorded).toBe(true);
    // idle → notify 后立即投递（record 内不自投，attemptDeliver 由调用方驱动；
    // 此处显式调用验证顺序）
    ledger.attemptDeliver();

    expect(mock.sentMessages).toHaveLength(1);
    // 顺序断言：账本 entry（entries[0]）先于送达消息（sentMessages[0]）
    expect(mock.entries[0]?.customType).toBe(NOTIFY_LEDGER_CUSTOM_TYPE);
    expect(mock.sentMessages[0]?.customType).toBe(NOTIFY_CUSTOM_TYPE);
    // 单条投递形态：details = record 本体（notifyId 携带在 details，不在文案）
    expect(mock.sentMessages[0]?.details).toMatchObject({ notifyId: "sa-1" });

    ledger.dispose();
  });

  it("② settled 边沿投递：busy 挂回 pending，isIdle 复查通过后边沿送达", () => {
    const mock = makeLedgerHost();
    const ledger = createNotifyLedger(mock.host);

    // busy：notify 后 attemptDeliver 放弃本次，消息挂回 pending
    mock.setIdle(false);
    expect(ledger.record("sa-busy", "content", { notifyId: "sa-busy" })).toBe(true);
    ledger.attemptDeliver();
    expect(mock.sentMessages).toHaveLength(0);
    expect(ledger.pendingCount()).toBe(1);

    // settled 边沿（边沿回调内 isIdle 复查）：仍 busy → 继续挂 pending
    fireSettled(mock);
    expect(mock.sentMessages).toHaveLength(0);
    expect(ledger.pendingCount()).toBe(1);

    // 主 agent 空闲后的下一 settled 边沿 → 送达
    mock.setIdle(true);
    fireSettled(mock);
    expect(mock.sentMessages).toHaveLength(1);
    expect(ledger.pendingCount()).toBe(0);
    expect(ledger.waitingReceiptCount()).toBe(1);

    ledger.dispose();
  });

  it("②→③ 回执销账：送达 entry 出现后下一 settled 边沿追加 ack entry，差集为空", () => {
    const mock = makeLedgerHost();
    const ledger = createNotifyLedger(mock.host);

    ledger.record("sa-ack", "content", { notifyId: "sa-ack" });
    ledger.attemptDeliver();
    expect(mock.sentMessages).toHaveLength(1);
    expect(unsettledDiff(mock)).toEqual(new Set(["sa-ack"])); // 已送达未销账

    // 下一 settled 边沿：checkReceipts 扫到 custom_message entry（sendDelivery 已
    // 模拟落盘）→ 追加 ack entry → 两列差集为空
    fireSettled(mock);
    expect(unsettledDiff(mock)).toEqual(new Set());
    expect(ledger.waitingReceiptCount()).toBe(0);
    expect(mock.entries.some((e) => e.customType === NOTIFY_ACK_CUSTOM_TYPE)).toBe(true);

    ledger.dispose();
  });

  it("③ 内存不承担销账职责：回执缺失（消息滞留内存）时不销账，差集保留", () => {
    const mock = makeLedgerHost();
    const ledger = createNotifyLedger(mock.host);

    // 模拟消息滞留内存（如竞态窗口掉进 steer 队列）：sendDelivery 不落盘
    mock.deliverPersists.value = false;
    ledger.record("sa-lost", "content", { notifyId: "sa-lost" });
    ledger.attemptDeliver();
    expect(mock.sentMessages).toHaveLength(1);

    fireSettled(mock);
    // 无 custom_message entry 回执 → 不销账（内存不销账，等看门狗重投）
    expect(unsettledDiff(mock)).toEqual(new Set(["sa-lost"]));
    expect(ledger.waitingReceiptCount()).toBe(1);

    ledger.dispose();
  });

  it("④ 重启恢复：新实例扫两列差集，未销账号重放、已销账零重发", () => {
    // 旧实例（模拟崩溃前的进程）：sa-r1/sa-r2 送达销账，sa-r3 入账未投
    const oldMock = makeLedgerHost();
    const oldLedger = createNotifyLedger(oldMock.host);
    for (const id of ["sa-r1", "sa-r2"]) {
      oldLedger.record(id, `content-${id}`, { notifyId: id });
    }
    oldLedger.attemptDeliver();
    fireSettled(oldMock);
    oldLedger.record("sa-r3", "content-sa-r3", { notifyId: "sa-r3" }); // 崩溃前未投
    expect(unsettledDiff(oldMock)).toEqual(new Set(["sa-r3"]));
    oldLedger.dispose();

    // 重启：新实例扫同一 session 文件（sessionEntries 视图保留旧 entry 列）
    const newMock = makeLedgerHost();
    newMock.sessionEntries.push(...oldMock.sessionEntries);
    const newLedger = createNotifyLedger(newMock.host);
    const replayed = newLedger.recoverFromSession();

    expect(replayed).toBe(1); // 仅未销账的 sa-r3 重放
    expect(newMock.sentMessages).toHaveLength(1);
    expect(newMock.sentMessages[0]?.details).toMatchObject({ notifyId: "sa-r3" });
    // 已销账号零重发
    const sentIds = newMock.sentMessages.map((m) => (m.details as { notifyId?: string }).notifyId);
    expect(sentIds).not.toContain("sa-r1");
    expect(sentIds).not.toContain("sa-r2");

    newLedger.dispose();
  });

  it("④ notifyId 幂等：重复 record 同 notifyId 返回 false，不重复投递", () => {
    const mock = makeLedgerHost();
    const ledger = createNotifyLedger(mock.host);

    expect(ledger.record("sa-dup", "content", { notifyId: "sa-dup" })).toBe(true);
    expect(ledger.record("sa-dup", "content", { notifyId: "sa-dup" })).toBe(false);

    ledger.attemptDeliver();
    ledger.attemptDeliver();
    expect(mock.sentMessages).toHaveLength(1); // 至多一次

    // 销账后同 notifyId 再来（重复调用方）→ 仍幂等拒绝（已销账号绝不重发）
    fireSettled(mock);
    expect(ledger.record("sa-dup", "content", { notifyId: "sa-dup" })).toBe(false);

    ledger.dispose();
  });

  it("④ 重复投递条目可识别：批量送达 details.items 每项携带 notifyId（回执匹配）", () => {
    const mock = makeLedgerHost();
    const ledger = createNotifyLedger(mock.host);

    ledger.record("sa-m1", "c1", { notifyId: "sa-m1" });
    ledger.record("sa-m2", "c2", { notifyId: "sa-m2" });
    ledger.attemptDeliver();

    expect(mock.sentMessages).toHaveLength(1); // 合并为一条
    const msg = mock.sentMessages[0]!;
    expect(msg.content).toBe("c1\n\n---\n\nc2");
    const details = msg.details as { batch: boolean; items: Array<{ notifyId?: string }> };
    expect(details.batch).toBe(true);
    expect(details.items.map((i) => i.notifyId)).toEqual(["sa-m1", "sa-m2"]);

    // 批量回执匹配：items[].notifyId 命中 → 两条全部销账
    fireSettled(mock);
    expect(unsettledDiff(mock)).toEqual(new Set());

    ledger.dispose();
  });
});

// ─── 120s 看门狗（fake timers） ───────────────────────────

describe("NotifyLedger — 120s 看门狗（D5 ②兜底触发面）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetNotifyLedgerForTest();
  });
  afterEach(() => {
    _resetNotifyLedgerForTest();
    vi.useRealTimers();
  });

  it("主 session 长期无 settled：busy 挂起的 pending 由看门狗在空闲后补投", () => {
    const mock = makeLedgerHost();
    const ledger = createNotifyLedger(mock.host);

    mock.setIdle(false);
    ledger.record("sa-wd1", "content", { notifyId: "sa-wd1" });
    ledger.attemptDeliver();
    expect(mock.sentMessages).toHaveLength(0);

    // 第一个周期仍 busy → 不投
    vi.advanceTimersByTime(NOTIFY_WATCHDOG_MS);
    expect(mock.sentMessages).toHaveLength(0);

    // 主 agent 空闲（长期无 settled 事件）→ 下一周期看门狗补投
    mock.setIdle(true);
    vi.advanceTimersByTime(NOTIFY_WATCHDOG_MS);
    expect(mock.sentMessages).toHaveLength(1);

    ledger.dispose();
  });

  it("超时重投：sent 后一个周期无回执（消息滞留内存丢失）→ 看门狗重投", () => {
    const mock = makeLedgerHost();
    const ledger = createNotifyLedger(mock.host);

    // 投递但不落盘（模拟 steer 滞留后丢失——回执永不到）
    mock.deliverPersists.value = false;
    ledger.record("sa-wd2", "content", { notifyId: "sa-wd2" });
    ledger.attemptDeliver();
    expect(mock.sentMessages).toHaveLength(1);

    // 一个周期后：无回执 → sentAt 超时转回 pending → 本 tick 重投（at-least-once）
    vi.advanceTimersByTime(NOTIFY_WATCHDOG_MS);
    expect(mock.sentMessages).toHaveLength(2);
    expect(mock.sentMessages[1]?.details).toMatchObject({ notifyId: "sa-wd2" }); // 同 notifyId 可识别

    ledger.dispose();
  });

  it("回执正常时序不重投：送达落盘 + settled 销账后，看门狗空转零动作", () => {
    const mock = makeLedgerHost();
    const ledger = createNotifyLedger(mock.host);

    ledger.record("sa-wd3", "content", { notifyId: "sa-wd3" });
    ledger.attemptDeliver();
    fireSettled(mock); // 销账
    expect(unsettledDiff(mock)).toEqual(new Set());

    vi.advanceTimersByTime(NOTIFY_WATCHDOG_MS * 3);
    expect(mock.sentMessages).toHaveLength(1); // 无重投
    expect(unsettledDiff(mock)).toEqual(new Set()); // 差集保持为空

    ledger.dispose();
  });
});

// ─── U4 投递计数分桶（设计 §5 U4 × §2.2 三条丢失路径） ─────

describe("NotifyLedger — U4 投递计数分桶", () => {
  beforeEach(() => {
    _resetNotifyLedgerForTest();
  });
  afterEach(() => {
    _resetNotifyLedgerForTest();
  });

  it("初始快照：三桶全 0（无投递异常时零计数）", () => {
    const mock = makeLedgerHost();
    const ledger = createNotifyLedger(mock.host);
    expect(ledger.deliveryMetrics()).toEqual({ settleRejected: 0, watchdogReplays: 0, recoveryReplays: 0 });
    ledger.dispose();
  });

  it("②settleRejected 桶：sendDelivery 受理被拒 → +1 且消息挂回 pending；恢复后不再累计", () => {
    const mock = makeLedgerHost();
    const ledger = createNotifyLedger(mock.host);

    mock.deliveryThrows.value = true;
    ledger.record("sa-rj", "content", { notifyId: "sa-rj" });
    ledger.attemptDeliver();

    expect(ledger.deliveryMetrics().settleRejected).toBe(1);
    expect(mock.sentMessages).toHaveLength(0);
    expect(ledger.pendingCount()).toBe(1); // 挂回 pending，账未丢

    // 下一边沿受理恢复：投递成功，rejection 桶不再增长
    mock.deliveryThrows.value = false;
    ledger.attemptDeliver();
    expect(mock.sentMessages).toHaveLength(1);
    expect(ledger.deliveryMetrics().settleRejected).toBe(1);

    ledger.dispose();
  });

  it("①watchdogReplays 桶：销账超时重投按条数累计（同消息反复超时继续累计）", () => {
    vi.useFakeTimers();
    try {
      const mock = makeLedgerHost();
      const ledger = createNotifyLedger(mock.host);

      // 投递但回执永不到（消息滞留内存丢失）
      mock.deliverPersists.value = false;
      ledger.record("sa-wd", "content", { notifyId: "sa-wd" });
      ledger.attemptDeliver();
      expect(ledger.deliveryMetrics().watchdogReplays).toBe(0);

      // 第一个周期：销账超时 → 转回 pending 重投，桶 +1
      vi.advanceTimersByTime(NOTIFY_WATCHDOG_MS);
      expect(mock.sentMessages).toHaveLength(2);
      expect(ledger.deliveryMetrics().watchdogReplays).toBe(1);

      // 第二个周期仍无回执：同消息再重投，桶累计到 2（滞留深度可见）
      vi.advanceTimersByTime(NOTIFY_WATCHDOG_MS);
      expect(mock.sentMessages).toHaveLength(3);
      expect(ledger.deliveryMetrics().watchdogReplays).toBe(2);

      ledger.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("③recoveryReplays 桶：session_start 恢复重放条数与返回值一致，已销账零计数", () => {
    const mock = makeLedgerHost();
    mock.sessionEntries.push(
      { type: "custom", customType: NOTIFY_LEDGER_CUSTOM_TYPE, data: { v: 1, notifyId: "s-a", content: "ca", record: { notifyId: "s-a" } } },
      { type: "custom", customType: NOTIFY_LEDGER_CUSTOM_TYPE, data: { v: 1, notifyId: "s-b", content: "cb", record: { notifyId: "s-b" } } },
      { type: "custom", customType: NOTIFY_ACK_CUSTOM_TYPE, data: { v: 1, notifyId: "s-a" } },
    );

    const ledger = createNotifyLedger(mock.host);
    const replayed = ledger.recoverFromSession();

    expect(replayed).toBe(1); // s-b 未销账重放；s-a 已销账零重发
    expect(ledger.deliveryMetrics().recoveryReplays).toBe(1);

    // 再次恢复（幂等）：差集已入账，零重发零计数
    expect(ledger.recoverFromSession()).toBe(0);
    expect(ledger.deliveryMetrics().recoveryReplays).toBe(1);

    ledger.dispose();
  });

  it("分桶增量经 core logger facade 落日志（warn，msg 固定 key + 动态值在 data）", () => {
    // 用例级 logCalls sink（覆盖文件级 no-op sink）——从零开始收集，断言
    // 「本次投递失败动作」恰产生一条分桶 warn（不受同 describe 前序用例影响）。
    const logCalls: Array<{ level: string; component: string; message: string; data?: unknown }> = [];
    configureCore({
      dataRoot: () => "/fake-notify-ledger-data-root",
      log: (level, component, message, data) => {
        logCalls.push({ level, component, message, data });
      },
    });
    const mock = makeLedgerHost();
    const ledger = createNotifyLedger(mock.host);

    mock.deliveryThrows.value = true;
    ledger.record("sa-log", "content", { notifyId: "sa-log" });
    ledger.attemptDeliver();

    const warns = logCalls.filter((l) => l.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.component).toBe("subagents");
    expect(warns[0]?.message).toContain("notify delivery bucket [settleRejected]");
    expect(warns[0]?.data).toEqual({ total: 1, pending: 1 });

    ledger.dispose();
  });
});

// ─── compaction 降级（P-B4） ───────────────────────────────

describe("NotifyLedger — compaction 降级（P-B4 未验证，条件补写）", () => {
  beforeEach(() => {
    _resetNotifyLedgerForTest();
  });
  afterEach(() => {
    _resetNotifyLedgerForTest();
  });

  it("compaction 清除 ledger/ack entry 后按内存态补写（重建两列差集）", () => {
    const mock = makeLedgerHost();
    const ledger = createNotifyLedger(mock.host);

    // sa-c1 送达销账、sa-c2 入账未投
    ledger.record("sa-c1", "c1", { notifyId: "sa-c1" });
    ledger.attemptDeliver();
    fireSettled(mock);
    ledger.record("sa-c2", "c2", { notifyId: "sa-c2" });
    expect(unsettledDiff(mock)).toEqual(new Set(["sa-c2"]));

    // 模拟 compaction 清掉全部 plain custom entry（ledger/ack 两列全丢，送达
    // custom_message entry 假设保留——保守验证降级闭环）
    mock.sessionEntries.length = 0;

    const rewritten = ledger.compactionCheck();
    expect(rewritten).toBe(2); // 补写 sa-c2 的 ledger + sa-c1 的 ack
    // 补写后差集恢复：仍只有 sa-c2 未销账（sa-c1 销账事实随 ack 补写恢复）
    expect(unsettledDiff(mock)).toEqual(new Set(["sa-c2"]));

    ledger.dispose();
  });

  it("entry 存活时 compactionCheck no-op（零补写）", () => {
    const mock = makeLedgerHost();
    const ledger = createNotifyLedger(mock.host);
    ledger.record("sa-nc", "c", { notifyId: "sa-nc" });
    ledger.attemptDeliver();
    fireSettled(mock);

    expect(ledger.compactionCheck()).toBe(0);
    ledger.dispose();
  });
});

// ─── session_start 恢复钩子（bindNotifyLedgerHost） ────────

describe("bindNotifyLedgerHost — session_start 恢复钩子", () => {
  beforeEach(() => {
    _resetNotifyLedgerForTest();
  });
  afterEach(() => {
    _resetNotifyLedgerForTest();
  });

  it("bind + recoverFromSession：mock session 含 ledger/ack entry → 重放差集", () => {
    const mock = makeLedgerHost();
    // 预置 session 文件内容（模拟重启前的落盘）：2 条 ledger + 1 条 ack + 1 条已送达
    mock.sessionEntries.push(
      { type: "custom", customType: NOTIFY_LEDGER_CUSTOM_TYPE, data: { v: 1, notifyId: "s-a", content: "ca", record: { notifyId: "s-a" } } },
      { type: "custom", customType: NOTIFY_LEDGER_CUSTOM_TYPE, data: { v: 1, notifyId: "s-b", content: "cb", record: { notifyId: "s-b" } } },
      { type: "custom", customType: NOTIFY_ACK_CUSTOM_TYPE, data: { v: 1, notifyId: "s-a" } },
      { type: "custom_message", customType: NOTIFY_CUSTOM_TYPE, content: "ca", display: true, details: { notifyId: "s-a" } },
    );

    const ledger = bindNotifyLedgerHost(mock.host);
    const replayed = ledger.recoverFromSession();

    expect(replayed).toBe(1); // s-b 未销账重放；s-a 已销账零重发
    expect(mock.sentMessages).toHaveLength(1);
    expect(mock.sentMessages[0]?.content).toBe("cb");
    expect(mock.sentMessages[0]?.details).toMatchObject({ notifyId: "s-b" });
  });

  it("重复 bind 替换旧实例（/resume /fork /new 的 session_start）", () => {
    const mock1 = makeLedgerHost();
    bindNotifyLedgerHost(mock1.host);
    expect(bindNotifyLedgerHost(makeLedgerHost().host)).toBeDefined();
    // 旧实例已 dispose（settled 回调静默）
    fireSettled(mock1);
    expect(mock1.sentMessages).toHaveLength(0);
  });

  it("损坏 / 形态不符 entry 跳过不 throw（无 notifyId / data 非 object）", () => {
    const mock = makeLedgerHost();
    mock.sessionEntries.push(
      { type: "custom", customType: NOTIFY_LEDGER_CUSTOM_TYPE, data: { v: 1 } }, // 无 notifyId
      { type: "custom", customType: NOTIFY_LEDGER_CUSTOM_TYPE }, // 无 data
      { type: "custom", customType: "unrelated-type", data: { notifyId: "x" } },
      null,
    );
    const ledger = bindNotifyLedgerHost(mock.host);
    expect(ledger.recoverFromSession()).toBe(0);
  });
});

// ─── notifier 四步接线（createNotifier × ledger） ─────────

describe("createNotifier — ledger 四步接线（U2）", () => {
  beforeEach(() => {
    _resetNotifyLedgerForTest();
  });
  afterEach(() => {
    _resetNotifyLedgerForTest();
  });

  /** notifier 侧 mock host：sendMessage 是 ledger sendDelivery 的下游（index.ts
   *  装配 sendDelivery = pi.sendMessage({triggerTurn:true})，此处直接捕获）。 */
  function makeNotifierHost(): NotifierHost & {
    sentOptions: unknown[];
    sentMessages: { customType: string; content: string; display: boolean; details?: unknown }[];
  } {
    const sentOptions: unknown[] = [];
    const sentMessages: { customType: string; content: string; display: boolean; details?: unknown }[] = [];
    return {
      sentOptions,
      sentMessages,
      sendMessage(message, options) {
        sentOptions.push(options);
        sentMessages.push(message);
      },
      hasRunningBackground: () => false,
      isIdle: () => true,
    };
  }

  function oneShotRecord(id: string, result = "done"): BgNotifyRecord {
    return { id, status: "closed", agent: "worker", result, startedAt: 1, endedAt: 2 };
  }

  it("notify → 写账 → 投递 → 回执销账全链路（notifyId = id，G4 文案不变）", () => {
    const ledgerMock = makeLedgerHost();
    // sendDelivery 桥接到 notifier host.sendMessage（模拟 index.ts 装配）
    const notifierHost = makeNotifierHost();
    ledgerMock.host.sendDelivery = (message) => {
      ledgerMock.sentMessages.push(message);
      if (ledgerMock.deliverPersists.value) {
        ledgerMock.sessionEntries.push({
          type: "custom_message",
          customType: message.customType,
          content: message.content,
          display: message.display,
          details: message.details,
        });
      }
      notifierHost.sendMessage(message, { triggerTurn: true });
    };
    bindNotifyLedgerHost(ledgerMock.host);

    const notifier = createNotifier(notifierHost);
    notifier.notify(oneShotRecord("sa-n1"));

    // ① 写账先于 ② 投递：ledger entry 落盘且消息已送达
    expect(ledgerMock.entries[0]?.customType).toBe(NOTIFY_LEDGER_CUSTOM_TYPE);
    expect(notifierHost.sentMessages).toHaveLength(1);
    // 单通道断言：options 只有 triggerTurn，无 deliverAs
    expect(notifierHost.sentOptions[0]).toEqual({ triggerTurn: true });
    // G4 文案锚：one-shot 完成通知逐字节不变（notifyId 不进文案）
    expect(notifierHost.sentMessages[0]?.content).toBe('Subagent "worker" (sa-n1) completed. Result:\ndone');
    // details 携带 notifyId + outcome 物化（U3）
    expect(notifierHost.sentMessages[0]?.details).toMatchObject({ notifyId: "sa-n1", outcome: "completed" });

    // ③ 回执销账：settled 边沿 → ack entry + 差集为空
    fireSettled(ledgerMock);
    expect(unsettledDiff(ledgerMock)).toEqual(new Set());

    notifier.dispose();
  });

  it("chatMode round dedupe key 平移：notifyId = `${id}:${round}`，规则不变", () => {
    const ledgerMock = makeLedgerHost();
    const notifierHost = makeNotifierHost();
    // 桥接：ledger sendDelivery → notifier host.sendMessage（模拟 index.ts 装配）
    ledgerMock.host.sendDelivery = (message) => {
      notifierHost.sendMessage(message, { triggerTurn: true });
      if (ledgerMock.deliverPersists.value) {
        ledgerMock.sessionEntries.push({
          type: "custom_message",
          customType: message.customType,
          content: message.content,
          display: message.display,
          details: message.details,
        });
      }
    };
    bindNotifyLedgerHost(ledgerMock.host);

    const notifier = createNotifier(notifierHost);
    notifier.notify({ id: "sa-chat", status: "running", agent: "w", round: 1, result: "r1", startedAt: 1, endedAt: 2 });
    notifier.notify({ id: "sa-chat", status: "running", agent: "w", round: 2, result: "r2", startedAt: 3, endedAt: 4 });
    // 同 id 同 round 第二次被 notifyId 幂等吞
    notifier.notify({ id: "sa-chat", status: "running", agent: "w", round: 1, result: "r1-again", startedAt: 5, endedAt: 6 });

    expect(notifierHost.sentMessages).toHaveLength(2);
    expect(notifierHost.sentMessages[0]?.details).toMatchObject({ notifyId: "sa-chat:1" });
    expect(notifierHost.sentMessages[1]?.details).toMatchObject({ notifyId: "sa-chat:2" });
    // chatMode 轮次通知文案（running 分支）不变
    expect(notifierHost.sentMessages[0]?.content).toBe('Subagent "w" (sa-chat) finished a round. Reply:\nr1');

    notifier.dispose();
  });

  it("dedupKey 显式覆盖 notifyId（drain 丢弃通知独立身份）：同轮失败通知 key 不互吞，同 key 重放仍幂等；缺省回退 `id` / `id:round` 不变", () => {
    const ledgerMock = makeLedgerHost();
    const notifierHost = makeNotifierHost();
    // 桥接：ledger sendDelivery → notifier host.sendMessage（模拟 index.ts 装配）
    ledgerMock.host.sendDelivery = (message) => {
      notifierHost.sendMessage(message, { triggerTurn: true });
      if (ledgerMock.deliverPersists.value) {
        ledgerMock.sessionEntries.push({
          type: "custom_message",
          customType: message.customType,
          content: message.content,
          display: message.display,
          details: message.details,
        });
      }
    };
    bindNotifyLedgerHost(ledgerMock.host);

    const notifier = createNotifier(notifierHost);
    // 场景复刻（conversation-continuation drain 丢弃修复）：同 id 同轮——失败单发缺省
    // key `id:round`，丢弃通知 dedupKey `id:round:drain-drop` → 两条都写账送达（修复
    // 前丢弃通知沿用缺省 key 被幂等吞，「队列消息被丢」反馈永不可达）。
    const failedRound = { id: "sa-drain", status: "closed" as const, outcome: "failed" as const, agent: "w", round: 1, startedAt: 1, endedAt: 2 };
    notifier.notify({ ...failedRound, error: "round did not complete: crash" });
    notifier.notify({ ...failedRound, error: "queued message could not be dispatched", dedupKey: "sa-drain:1:drain-drop" });
    // 同 dedupKey 重放 = 同一显式反馈 → 幂等吞（去重语义保留，非全量放行）
    notifier.notify({ ...failedRound, error: "dropped again", dedupKey: "sa-drain:1:drain-drop" });

    expect(notifierHost.sentMessages).toHaveLength(2);
    expect(notifierHost.sentMessages[0]?.details).toMatchObject({ notifyId: "sa-drain:1" });
    expect(notifierHost.sentMessages[1]?.details).toMatchObject({ notifyId: "sa-drain:1:drain-drop" });

    // 缺省回退（dedupKey 未设）：无 round → 裸 id（notifyClosed 终态通知消费形态），
    // 与 `id:round` / `id:round:drain-drop` 互不吞——key 空间三形态互斥
    notifier.notify({ ...failedRound, round: undefined, error: "closed" });
    expect(notifierHost.sentMessages).toHaveLength(3);
    expect(notifierHost.sentMessages[2]?.details).toMatchObject({ notifyId: "sa-drain" });

    notifier.dispose();
  });

  it("ledger 未 bind 时退回内核路径（向后兼容，options 仍单通道 triggerTurn）", () => {
    const notifierHost = makeNotifierHost();
    const notifier = createNotifier(notifierHost);
    notifier.notify(oneShotRecord("sa-nb"));

    expect(notifierHost.sentMessages).toHaveLength(1);
    expect(notifierHost.sentOptions[0]).toEqual({ triggerTurn: true });
    expect(notifierHost.sentMessages[0]?.content).toBe('Subagent "worker" (sa-nb) completed. Result:\ndone');

    notifier.dispose();
  });

  it("U4 warn 注入：内核路径 port.send 失败 → 警告经 core logger 出口，console.warn 零调用", () => {
    // logger facade 经 host-services 动态解析（无 vi.mock）：用例级注入 logCalls
    // sink 覆盖文件级 no-op sink——U4 意图断言保持：警告落可检索通道（注入出口）
    // 而非 console.warn（NULL_HOST 缺省出口，被 spy 监听断言零调用）。
    const logCalls: Array<{ level: string; message: string; data?: unknown }> = [];
    configureCore({
      dataRoot: () => "/fake-notify-ledger-data-root",
      log: (level, _component, message, data) => {
        logCalls.push({ level, message, data });
      },
    });
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const notifierHost = makeNotifierHost();
      // sendMessage 抛异常 = port.send 同步失败 → 内核 onSendFail → warn（经注入出口）
      notifierHost.sendMessage = () => {
        throw new Error("channel closed (mock)");
      };
      const notifier = createNotifier(notifierHost);
      notifier.notify(oneShotRecord("sa-warn"));

      const sendFailLogged = logCalls.some(
        (l) => l.level === "warn" && typeof l.message === "string" && l.message.includes("port.send failed"),
      );
      expect(sendFailLogged).toBe(true);
      expect(consoleWarnSpy).not.toHaveBeenCalled();

      notifier.dispose();
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it("dispose 摘除模块级绑定：后续 notify 走内核路径，settled 边沿静默", () => {
    const ledgerMock = makeLedgerHost();
    bindNotifyLedgerHost(ledgerMock.host);
    const notifierHost = makeNotifierHost();
    const notifier = createNotifier(notifierHost);
    notifier.dispose();

    fireSettled(ledgerMock);
    // revive（/resume /fork /new 后）：notifier 复活，但 ledger 已随 dispose 摘除
    //——notify 退回内核路径
    notifier.revive();
    notifier.notify(oneShotRecord("sa-post-dispose"));
    expect(notifierHost.sentMessages).toHaveLength(1); // 内核路径立即投（无 ledger）
  });

});

// ─── MF-5: settled 监听单例化 ──────────────────────────────
//
// 回归背景：index.ts:428-430 每次 session_start 注册新 pi.on("agent_settled")
// handler，旧实例 dispose 只置标志不移除物理监听（pi 0.84.4 on() 无 off）——
// 长会话 N 次切换累积 N 个死 handler。修复：bind 路径首次注册模块级单例
// handler（settledEdgeDispatch），后续 bind 只换 boundLedger 引用。

describe("MF-5: settled 监听单例化（多次 bind 物理监听数不增）", () => {
  beforeEach(() => {
    _resetNotifyLedgerForTest();
  });
  afterEach(() => {
    _resetNotifyLedgerForTest();
  });

  it("连续 3 次 bind（/resume /fork /new 的 session_start）→ onAgentSettled 注册仅首次发生", () => {
    const mocks = [makeLedgerHost(), makeLedgerHost(), makeLedgerHost()];
    const registerSpies = mocks.map((mock) => {
      const spy = vi.fn();
      mock.host.onAgentSettled = spy;
      return spy;
    });

    bindNotifyLedgerHost(mocks[0]!.host);
    bindNotifyLedgerHost(mocks[1]!.host);
    bindNotifyLedgerHost(mocks[2]!.host);

    // 首次 bind 注册一次（单例 handler）；后续 bind 只换 boundLedger 引用
    expect(registerSpies[0]).toHaveBeenCalledTimes(1);
    expect(registerSpies[1]).not.toHaveBeenCalled();
    expect(registerSpies[2]).not.toHaveBeenCalled();
  });

  it("边沿分发到当前活跃实例：旧 mock 上的边沿事件驱动新 ledger 投递，旧实例零动作", () => {
    const mock1 = makeLedgerHost();
    bindNotifyLedgerHost(mock1.host);
    const mock2 = makeLedgerHost();
    bindNotifyLedgerHost(mock2.host);

    // 活跃实例（mock2 的 ledger）入账 pending
    const ledger = getBoundNotifyLedger();
    expect(ledger).toBeDefined();
    ledger!.record("sa-active", "content", { notifyId: "sa-active" });

    // 旧 mock（mock1）上触发边沿——单例 handler 分发到 boundLedger（mock2）
    fireSettled(mock1);
    expect(mock2.sentMessages).toHaveLength(1);
    expect(mock2.sentMessages[0]?.details).toMatchObject({ notifyId: "sa-active" });
    // 旧实例无动作（disposed 短路语义：不会成为分发目标）
    expect(mock1.sentMessages).toHaveLength(0);
  });

  it("活跃实例 dispose 后边沿静默（boundLedger 摘除 → 单例 handler 无分发目标）", () => {
    const mock1 = makeLedgerHost();
    bindNotifyLedgerHost(mock1.host);
    getBoundNotifyLedger()!.dispose();

    fireSettled(mock1);
    expect(mock1.sentMessages).toHaveLength(0);
  });

  it("直调 createNotifyLedger 注册行为不变（默认注册 / 显式 registerSettledListener:false 跳过）", () => {
    const mockDefault = makeLedgerHost();
    const ledgerDefault = createNotifyLedger(mockDefault.host);
    expect(mockDefault.settledHandlers).toHaveLength(1);
    ledgerDefault.dispose();

    const mockSkip = makeLedgerHost();
    const ledgerSkip = createNotifyLedger(mockSkip.host, { registerSettledListener: false });
    expect(mockSkip.settledHandlers).toHaveLength(0);
    ledgerSkip.dispose();
  });
});

// ─── 常量等值钉住（notify-ledger 与 notifier/渲染器共用字符串） ──

describe("notify-ledger 常量锚", () => {
  it("NOTIFY_CUSTOM_TYPE 与 notifier 送达 customType / ledger 回执扫描同源", async () => {
    const notifierModule = await import("../notifier.ts");
    // notifier 模块不再自带本地常量（单一常量源 = notify-ledger）；用运行时行为钉住：
    // ledger 回执扫描匹配的 customType === notifier 送达消息的 customType。
    const mock = makeLedgerHost();
    const notifierHost: NotifierHost = {
      sendMessage: (message) => {
        mock.host.sendDelivery(message);
      },
      hasRunningBackground: () => false,
      isIdle: () => true,
    };
    const ledger = bindNotifyLedgerHost(mock.host);
    const notifier = createNotifier(notifierHost);
    notifier.notify({ id: "sa-cst", status: "closed", agent: "w", result: "r", startedAt: 1, endedAt: 2 });
    fireSettled(mock);
    // 全链路销账成功 === 三处 customType 同一字符串（否则回执扫描不命中）
    expect(unsettledDiff(mock)).toEqual(new Set());
    expect(typeof notifierModule.createNotifier).toBe("function");
    ledger.dispose();
    _resetNotifyLedgerForTest();
  });
});

// ─── T4③ 重投止损（PS-6） ─────────────────────────────────

describe("NotifyLedger — T4③ 重投止损（PS-6）", () => {
  let logCalls: Array<{ level: string; component: string; message: string; data?: unknown }>;

  beforeEach(() => {
    vi.useFakeTimers();
    logCalls = [];
    configureCore({
      dataRoot: () => "/fake-notify-ledger-data-root",
      log: (level, component, message, data) => {
        logCalls.push({ level, component, message, data });
      },
    });
    _resetNotifyLedgerForTest();
  });
  afterEach(() => {
    _resetNotifyLedgerForTest();
    vi.useRealTimers();
  });

  it("① 回执不可匹配 → 重投至 attempts 上限后放弃：abandoned 终态 entry + warn 含恢复指引，此后零重投", () => {
    const mock = makeLedgerHost();
    // 回执永不可匹配（模拟 compaction 清除送达 entry —— PS-6 触发态）
    mock.deliverPersists.value = false;
    const ledger = createNotifyLedger(mock.host);

    ledger.record("sa-cap", "content", { notifyId: "sa-cap", id: "sa-cap", agent: "worker" });
    ledger.attemptDeliver(); // 第 1 次投递（attempts=1）
    expect(mock.sentMessages).toHaveLength(1);

    // 未达上限：每周期照常超时重投（共 4 次重投，attempts 累至上限）
    for (let i = 2; i <= NOTIFY_REDELIVERY_MAX_ATTEMPTS; i += 1) {
      vi.advanceTimersByTime(NOTIFY_WATCHDOG_MS);
      expect(mock.sentMessages).toHaveLength(i);
    }
    expect(abandonedEntries(mock)).toHaveLength(0);
    expect(ledger.waitingReceiptCount()).toBe(1);

    // 第 5 个周期：attempts 已达上限仍无回执 → 放弃，不再重投
    vi.advanceTimersByTime(NOTIFY_WATCHDOG_MS);
    expect(mock.sentMessages).toHaveLength(NOTIFY_REDELIVERY_MAX_ATTEMPTS); // 零新增
    // 终态 entry 落盘（与 ack 同形：{ v:1, notifyId }）
    const abandoned = abandonedEntries(mock);
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]?.data).toEqual({ v: 1, notifyId: "sa-cap" });
    // 账面摘除：pending / waiting 归零，差集为空（ledger − ack − abandoned）
    expect(ledger.pendingCount()).toBe(0);
    expect(ledger.waitingReceiptCount()).toBe(0);
    expect(unsettledDiff(mock)).toEqual(new Set());
    // 放弃不计入 watchdogReplays 桶（该桶口径 = 实际重投条数 = 上限 − 1）
    expect(ledger.deliveryMetrics().watchdogReplays).toBe(NOTIFY_REDELIVERY_MAX_ATTEMPTS - 1);

    // warn：含 subagent 标识（agent 名）与 subagents action:"list" 恢复指引；
    // notifyId / attempts 动态值在 data（D4 约定，msg 近固定 key）
    const warns = abandonedWarns(logCalls);
    expect(warns).toHaveLength(1);
    expect(warns[0]?.component).toBe("subagents");
    expect(warns[0]?.message).toContain("worker");
    expect(warns[0]?.message).toContain('subagents action:"list"');
    expect(warns[0]?.data).toEqual({ notifyId: "sa-cap", attempts: NOTIFY_REDELIVERY_MAX_ATTEMPTS });

    // 止损后看门狗空转：同一条通知不无限重复注入
    vi.advanceTimersByTime(NOTIFY_WATCHDOG_MS * 3);
    expect(mock.sentMessages).toHaveLength(NOTIFY_REDELIVERY_MAX_ATTEMPTS);

    // 放弃是终态：同 notifyId 再 record 被幂等拒绝（绝不重发）
    expect(ledger.record("sa-cap", "content", { notifyId: "sa-cap" })).toBe(false);

    ledger.dispose();
  });

  it("② 放弃条目重启恢复不复活：recoverFromSession 跳过 abandoned 差集，watchdog/settled 零投递", () => {
    const mock = makeLedgerHost();
    // 模拟重启前落盘：s-gone 已放弃（ledger + abandoned 两列），s-live 未销账未放弃
    mock.sessionEntries.push(
      { type: "custom", customType: NOTIFY_LEDGER_CUSTOM_TYPE, data: { v: 1, notifyId: "s-gone", content: "cg", record: { notifyId: "s-gone", agent: "gone-agent" } } },
      { type: "custom", customType: NOTIFY_ABANDONED_CUSTOM_TYPE, data: { v: 1, notifyId: "s-gone" } },
      { type: "custom", customType: NOTIFY_LEDGER_CUSTOM_TYPE, data: { v: 1, notifyId: "s-live", content: "cl", record: { notifyId: "s-live" } } },
    );
    mock.setIdle(false); // busy：恢复路径的 attemptDeliver 挂 pending，隔离投递时机

    const ledger = createNotifyLedger(mock.host);
    // 仅 s-live 重放；s-gone 被放弃终态挡住
    expect(ledger.recoverFromSession()).toBe(1);
    expect(mock.sentMessages).toHaveLength(0);
    expect(ledger.pendingCount()).toBe(1);

    // 放弃号幂等拒绝（重启后 record 也不复活）
    expect(ledger.record("s-gone", "cg", { notifyId: "s-gone" })).toBe(false);

    // 看门狗多周期 + settled 边沿：s-gone 零投递
    vi.advanceTimersByTime(NOTIFY_WATCHDOG_MS * 3);
    expect(mock.sentMessages).toHaveLength(0);
    fireSettled(mock);
    expect(mock.sentMessages).toHaveLength(0);

    // 对照：idle 后 s-live 正常补投（证明差集重放本身未被破坏）
    mock.setIdle(true);
    fireSettled(mock);
    expect(mock.sentMessages).toHaveLength(1);
    expect(mock.sentMessages[0]?.details).toMatchObject({ notifyId: "s-live" });

    ledger.dispose();
  });

  it("同 notifyId 在账重复 record 幂等拒绝零副作用（⛔2 补强：U3 批 hash 幂等依赖）", () => {
    const mock = makeLedgerHost();
    const ledger = createNotifyLedger(mock.host);

    expect(ledger.record("sa-dup", "content-v1", { notifyId: "sa-dup", agent: "first" })).toBe(true);
    const ledgerEntriesBefore = mock.entries.filter((e) => e.customType === NOTIFY_LEDGER_CUSTOM_TYPE).length;
    expect(ledgerEntriesBefore).toBe(1);

    // 同 notifyId 二次 record：返回 false，零副作用（不新增 entry、账面不被覆盖）
    expect(ledger.record("sa-dup", "content-v2-attempted-overwrite", { notifyId: "sa-dup", agent: "second" })).toBe(false);
    expect(mock.entries.filter((e) => e.customType === NOTIFY_LEDGER_CUSTOM_TYPE)).toHaveLength(ledgerEntriesBefore);
    expect(ledger.pendingCount()).toBe(1);

    // 投递面零副作用：只送首条 content（后写不覆盖），回执匹配不受污染
    mock.setIdle(true);
    ledger.attemptDeliver();
    expect(mock.sentMessages).toHaveLength(1);
    expect(mock.sentMessages[0]?.content).toBe("content-v1");

    // 销账后同号仍拒绝（已销账幂等，E1 补发窗口依赖）
    fireSettled(mock);
    expect(ledger.waitingReceiptCount()).toBe(0);
    expect(ledger.record("sa-dup", "content-v1", { notifyId: "sa-dup" })).toBe(false);

    ledger.dispose();
  });

  it("③ 未达上限时正常重投行为不变：照常超时重投，回执到达后照常销账", () => {
    const mock = makeLedgerHost();
    // 前三轮回执不可匹配（重投路径）
    mock.deliverPersists.value = false;
    const ledger = createNotifyLedger(mock.host);

    ledger.record("sa-ok", "content", { notifyId: "sa-ok", id: "sa-ok", agent: "worker" });
    ledger.attemptDeliver(); // 第 1 次投递
    expect(mock.sentMessages).toHaveLength(1);

    // 两个周期无回执 → 两次照常重投（attempts=3 < 上限），无任何放弃痕迹
    vi.advanceTimersByTime(NOTIFY_WATCHDOG_MS * 2);
    expect(mock.sentMessages).toHaveLength(3);
    expect(abandonedEntries(mock)).toHaveLength(0);
    expect(abandonedWarns(logCalls)).toHaveLength(0);
    expect(ledger.deliveryMetrics().watchdogReplays).toBe(2);

    // 回执恢复可达：本周期重投落盘 → settled 边沿销账（既有 at-least-once 闭环不变）
    mock.deliverPersists.value = true;
    vi.advanceTimersByTime(NOTIFY_WATCHDOG_MS); // 第 3 次重投（本次落盘）
    expect(mock.sentMessages).toHaveLength(4);
    fireSettled(mock);
    expect(unsettledDiff(mock)).toEqual(new Set());
    expect(ledger.waitingReceiptCount()).toBe(0);
    expect(abandonedEntries(mock)).toHaveLength(0);

    ledger.dispose();
  });

  it("放弃终态持久化：abandoned entry 被 compaction 清除后按内存态补写，重启仍不复活", () => {
    const mock = makeLedgerHost();
    mock.deliverPersists.value = false;
    const ledger = createNotifyLedger(mock.host);

    ledger.record("sa-cp", "content", { notifyId: "sa-cp", id: "sa-cp", agent: "worker" });
    ledger.attemptDeliver();
    vi.advanceTimersByTime(NOTIFY_WATCHDOG_MS * NOTIFY_REDELIVERY_MAX_ATTEMPTS); // 达上限放弃
    expect(abandonedEntries(mock)).toHaveLength(1);

    // 模拟 compaction 只清掉 abandoned entry（ledger entry 保留）
    const idx = mock.entries.findIndex((e) => e.customType === NOTIFY_ABANDONED_CUSTOM_TYPE);
    expect(idx).toBeGreaterThanOrEqual(0);
    mock.entries.splice(idx, 1);

    // compaction 降级补写放弃终态（内存是权威）
    expect(ledger.compactionCheck()).toBe(1);
    expect(abandonedEntries(mock)).toHaveLength(1);
    ledger.dispose();

    // 重启：abandoned 在场 → 不复活不重投
    const mock2 = makeLedgerHost();
    mock2.sessionEntries.push(...mock.entries);
    mock2.setIdle(false);
    const ledger2 = createNotifyLedger(mock2.host);
    expect(ledger2.recoverFromSession()).toBe(0);
    mock2.setIdle(true);
    fireSettled(mock2);
    expect(mock2.sentMessages).toHaveLength(0);
    ledger2.dispose();
  });
});
