// src/__tests__/helpers-notify-ledger.test.ts
//
// [u9] notifyDone 账本化单测（C-ext-19 迁移——实施计划 u9 验收条款 ③ 的 mock 轨
// 证据面，S7 断连重放真机验收前置）。
//
// 覆盖验收面：
//   - 账本路径接线：写账（notifyId = wf-done:<runId>）→ courier 投递，送达通道
//     保持 "workflow-result"（runtime W18 workflow-record 失效信号的前提）、
//     content 字节不变（G4）、pi.sendMessage 零调用
//   - 幂等键拒绝：同一 runId 重复 notifyDone（绕过内存 Set 层）不双投递
//   - 回执销账：settled 边沿扫到送达 entry → ack → 同 runId 再收口零投递
//   - 未-ack 重放恰好一次（at-least-once + 去重）：投递受理但回执不可达（模拟
//     relay 瞬断消息丢失）→ 账本恢复重放恰好一次，二次恢复零重放
//   - 已销账恢复零重发：正常送达 + 销账后重启恢复零重放
//   - 降级路径：ledger 未 bind → fire-once 直发（triggerTurn 单通道，无 deliverAs）
//
// 形态参照：core notify-ledger.test.ts 的 mock host（entries/sessionEntries/
// sentMessages/settledHandlers 同构）+ helpers-gui.test.ts 的 RunMock duck typing。
// 账本常量（NOTIFY_LEDGER_CUSTOM_TYPE 等）core 包出口未导出——本地镜像（同
// helpers-gui.test.ts「内联镜像」惯例；账本 entry customType 值由 core 契约钉死，
// 漂移时 core 自有用例先红）。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bindNotifyLedgerHost, getBoundNotifyLedger, type NotifyLedgerHost } from "@zhushanwen/subagent-core";

import { notifyDone, WORKFLOW_DONE_NOTIFY_ID_PREFIX } from "../interface/helpers.ts";

// ── core 账本常量镜像（见文件头说明） ──────────────────────────

const NOTIFY_LEDGER_CUSTOM_TYPE = "subagent-bg-notify-ledger";
const NOTIFY_ACK_CUSTOM_TYPE = "subagent-bg-notify-ack";
const WORKFLOW_RESULT_CUSTOM_TYPE = "workflow-result";

// ── mock 面（helpers-gui.test.ts 同款 duck typing） ────────────

type RunMock = {
  spec: { scriptName: string; slug?: string };
  state: {
    status: string;
    reason?: string;
    scriptResult?: unknown;
    trace: { toArray: () => Array<{ stepIndex: number; agent: string; status: string }> };
  };
};

function makeRun(overrides?: { scriptName?: string; scriptResult?: unknown }): RunMock {
  return {
    spec: { scriptName: overrides?.scriptName ?? "build" },
    state: {
      status: "done",
      reason: "completed",
      scriptResult: overrides?.scriptResult,
      trace: { toArray: () => [] },
    },
  };
}

const runAsParam = (r: RunMock): Parameters<typeof notifyDone>[2] => r as never;

function makePi(): { pi: ExtensionAPI; sendMessage: ReturnType<typeof vi.fn> } {
  const sendMessage = vi.fn();
  const pi = { sendMessage } as unknown as ExtensionAPI;
  return { pi, sendMessage };
}

interface LedgerHostMock {
  host: NotifyLedgerHost;
  /** appendLedgerEntry 落下的 plain custom entry（ledger/ack 列）。 */
  entries: { type: string; customType: string; data?: Record<string, unknown> }[];
  /** session entries 视图（回执/恢复扫描输入；与 entries 共享数组）。 */
  sessionEntries: unknown[];
  /** 送达消息（sendDelivery 调用）。 */
  sentMessages: { customType: string; content: string; display: boolean; details?: unknown }[];
  settledHandlers: Array<() => void>;
  setIdle(idle: boolean): void;
  /** 送达是否同步落盘为 custom_message entry（false = 模拟回执不可达）。 */
  deliverPersists: { value: boolean };
}

function makeLedgerHost(): LedgerHostMock {
  const entries: LedgerHostMock["entries"] = [];
  const sessionEntries: unknown[] = entries;
  const sentMessages: LedgerHostMock["sentMessages"] = [];
  const settledHandlers: Array<() => void> = [];
  const idle = { value: true };
  const deliverPersists = { value: true };
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
  };
}

/**
 * 触发一次 settled 边沿：直调当前绑定 ledger 的 checkReceipts + attemptDeliver
 * 两连——与生产 settledEdgeDispatch（notify-ledger.ts 模块级单例 handler）逐行
 * 等价。不遍历 mock.settledHandlers：bind 路径的物理监听只在首次 bind 注册一次
 * （listenerRegistered 跨用例保留），后续 mock host 的 handler 数组恒空——
 * 这正是 [MF-5] 单例化的设计行为，测试按绑定引用驱动而非按注册驱动。
 */
function fireSettled(): void {
  const ledger = getBoundNotifyLedger();
  ledger?.checkReceipts();
  ledger?.attemptDeliver();
}

/** 账本 entry 列里的 notifyId 集合。 */
function ledgerNotifyIds(mock: LedgerHostMock): Set<string> {
  const ids = new Set<string>();
  for (const e of mock.entries) {
    if (e.customType !== NOTIFY_LEDGER_CUSTOM_TYPE) continue;
    const id = e.data?.["notifyId"];
    if (typeof id === "string") ids.add(id);
  }
  return ids;
}

// ── 账本路径（bindNotifyLedgerHost 生产入口装配） ──────────────

describe("notifyDone — 账本四步生命周期（C-ext-19 迁移）", () => {
  let mock: LedgerHostMock;

  beforeEach(() => {
    mock = makeLedgerHost();
    bindNotifyLedgerHost(mock.host);
  });

  afterEach(() => {
    // bindNotifyLedgerHost 的模块级绑定随实例 dispose 摘除（后续 describe 的
    // 降级用例需要无绑定环境）
    mock.settledHandlers.length = 0;
    getBoundNotifyLedger()?.dispose();
  });

  it("①→② 写账先于投递：notifyId = wf-done:<runId>，送达通道保持 workflow-result，content 不变，pi 直发零调用", () => {
    const { pi, sendMessage } = makePi();
    const run = makeRun({ scriptName: "fan-out", scriptResult: { status: "ok" } });

    notifyDone(pi, "wf-17abc", runAsParam(run), new Set(), undefined);

    // ① 写账：ledger entry 落盘，幂等键形态 wf-done:<runId>
    expect(ledgerNotifyIds(mock)).toEqual(new Set([`${WORKFLOW_DONE_NOTIFY_ID_PREFIX}wf-17abc`]));
    // ② courier 投递：送达通道 workflow-result（W18 信号前提），details 携带 notifyId
    expect(mock.sentMessages).toHaveLength(1);
    expect(mock.sentMessages[0]?.customType).toBe(WORKFLOW_RESULT_CUSTOM_TYPE);
    expect(mock.sentMessages[0]?.content).toContain("Workflow 'fan-out' done: done (completed)");
    expect(mock.sentMessages[0]?.details).toMatchObject({
      notifyId: `${WORKFLOW_DONE_NOTIFY_ID_PREFIX}wf-17abc`,
      runId: "wf-17abc",
    });
    // 账本路径不经 pi 直发（courier 统一出口）
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("幂等键拒绝：同 runId 重复 notifyDone（全新 Set 绕过内存层）不双投递", () => {
    const { pi } = makePi();
    const run = makeRun();

    notifyDone(pi, "wf-dup", runAsParam(run), new Set());
    // 第二次调用持全新 Set（模拟内存窗口挤出 / 重启后的重复收口回调）——
    // 持久层幂等键承接去重
    notifyDone(pi, "wf-dup", runAsParam(run), new Set());

    expect(mock.sentMessages).toHaveLength(1);
    // 账本单条：后写不覆盖（同键二次写账被拒）
    expect(mock.entries.filter((e) => e.customType === NOTIFY_LEDGER_CUSTOM_TYPE)).toHaveLength(1);
  });

  it("record 抛（reload 窗口 appendEntry assertActive 形态）→ 去重不标记，重调可重试（窗口内不永久丢通知）", () => {
    const { pi } = makePi();
    const run = makeRun();
    const notified = new Set<string>();

    // 第一次：appendLedgerEntry 抛（模拟 reload 窗口 pi.appendEntry 命中 assertActive——
    // 异常由 finalizeRun 围栏接住不崩，但账面 entry 未写）
    const origAppend = mock.host.appendLedgerEntry;
    mock.host.appendLedgerEntry = () => {
      throw new Error("session context is no longer active (assertActive)");
    };
    expect(() => notifyDone(pi, "wf-stale", runAsParam(run), notified)).toThrow("assertActive");
    // 关键断言：去重未标记（提前标记 = 去重阻断重试 + 账本无 entry 不可重放 = 永久丢失）
    expect(notified.has("wf-stale")).toBe(false);

    // 第二次（adoption 后重复收口回调）：appendLedgerEntry 恢复 → 写账 + 投递成功
    mock.host.appendLedgerEntry = origAppend;
    notifyDone(pi, "wf-stale", runAsParam(run), notified);
    expect(ledgerNotifyIds(mock)).toEqual(new Set([`${WORKFLOW_DONE_NOTIFY_ID_PREFIX}wf-stale`]));
    expect(mock.sentMessages).toHaveLength(1);
    expect(notified.has("wf-stale")).toBe(true);
  });

  it("③ 回执销账：settled 边沿 ack 后，同 runId 再收口零投递", () => {
    const { pi } = makePi();
    const run = makeRun();

    notifyDone(pi, "wf-ack", runAsParam(run), new Set());
    expect(mock.sentMessages).toHaveLength(1);

    // 送达 entry 已落盘（sendDelivery mock 同步持久化）→ settled 边沿销账
    fireSettled();
    expect(mock.entries.some((e) => e.customType === NOTIFY_ACK_CUSTOM_TYPE)).toBe(true);

    // 已销账号再收口：record 幂等拒绝（终态不重发）
    notifyDone(pi, "wf-ack", runAsParam(run), new Set());
    expect(mock.sentMessages).toHaveLength(1);
  });

  it("④ 未-ack 重放恰好一次（at-least-once + 去重）：回执不可达 → 恢复重放 1 次，二次恢复零重放", () => {
    const { pi } = makePi();
    const run = makeRun();

    // 投递受理但回执不可达（deliverPersists=false——模拟 relay 瞬断，消息丢失、
    // custom_message entry 未落盘）
    mock.deliverPersists.value = false;
    notifyDone(pi, "wf-lost", runAsParam(run), new Set());
    expect(mock.sentMessages).toHaveLength(1);
    expect(ledgerNotifyIds(mock)).toEqual(new Set([`${WORKFLOW_DONE_NOTIFY_ID_PREFIX}wf-lost`]));

    // 重启恢复：新实例扫同一 session 文件（账本 entry 在、回执不在）→ 差集重放
    const newMock = makeLedgerHost();
    newMock.sessionEntries.push(...mock.sessionEntries);
    const newLedger = bindNotifyLedgerHost(newMock.host);
    const replayed = newLedger.recoverFromSession();

    // 重放恰好一次，送达通道保持 workflow-result
    expect(replayed).toBe(1);
    expect(newMock.sentMessages).toHaveLength(1);
    expect(newMock.sentMessages[0]?.customType).toBe(WORKFLOW_RESULT_CUSTOM_TYPE);
    expect(newMock.sentMessages[0]?.details).toMatchObject({
      notifyId: `${WORKFLOW_DONE_NOTIFY_ID_PREFIX}wf-lost`,
    });

    // 同实例二次恢复：差集已入账，零重放（去重不双投递）
    expect(newLedger.recoverFromSession()).toBe(0);
    expect(newMock.sentMessages).toHaveLength(1);
  });

  it("④ 已销账恢复零重发：正常送达 + 销账后重启恢复零重放", () => {
    const { pi } = makePi();
    const run = makeRun();

    notifyDone(pi, "wf-done-ok", runAsParam(run), new Set());
    fireSettled(); // 销账

    const newMock = makeLedgerHost();
    newMock.sessionEntries.push(...mock.sessionEntries);
    const newLedger = bindNotifyLedgerHost(newMock.host);

    expect(newLedger.recoverFromSession()).toBe(0);
    expect(newMock.sentMessages).toHaveLength(0);
  });
});

// ── 降级路径（ledger 未 bind） ────────────────────────────────

describe("notifyDone — 降级直发（ledger 未 bind，向后兼容）", () => {
  // 注意前置：本文件上方 describe 的 afterEach 已 dispose 模块级绑定，
  // 此处 notifyDone 走 getBoundNotifyLedger() === undefined 的降级分支。
  let mock: LedgerHostMock;

  beforeEach(() => {
    mock = makeLedgerHost();
  });

  it("fire-once 直发 pi.sendMessage：triggerTurn 单通道（无 deliverAs），details 携带 notifyId", () => {
    const { pi, sendMessage } = makePi();
    const run = makeRun();

    notifyDone(pi, "wf-fallback", runAsParam(run), new Set());

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = sendMessage.mock.calls[0] as [
      { customType: string; content: string; display: boolean; details: { notifyId?: string } },
      Record<string, unknown>,
    ];
    expect(msg.customType).toBe(WORKFLOW_RESULT_CUSTOM_TYPE);
    expect(msg.display).toBe(true);
    expect(msg.content).toContain("Workflow 'build' done");
    expect(msg.details.notifyId).toBe(`${WORKFLOW_DONE_NOTIFY_ID_PREFIX}wf-fallback`);
    // u9 偏差裁决（D7 账本化配套）：deliverAs 已删
    expect(opts).toEqual({ triggerTurn: true });
    // 账本零写入（无绑定）
    expect(mock.entries).toHaveLength(0);
  });
});
