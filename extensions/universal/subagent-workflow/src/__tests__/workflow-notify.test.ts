// src/__tests__/workflow-notify.test.ts
//
// notifyDone 域合一文件（组 4 收尾段：四文件合一 + stale-guard notifyDone 半边 +
// M10 守卫条迁入）。构成与出处：
//   - 账本四步生命周期 / 降级直发 / content 分支矩阵全文锚定
//     ← workflow-notify-notify-ledger.test.ts（主体）
//   - 终局载荷 D7（三态 outcome + resultSummary/errorCode + 产物与 journal 指针）
//     ← workflow-notify-notify-payload.test.ts
//   - bounded 序列化等价锚定 + 截断边界 ← workflow-notify-bounded-serialize.test.ts
//   - GUI 协议 + trackNotifiedRunId 有界 FIFO ← workflow-notify-gui.test.ts
//   - stale ctx 守卫（notifyDone 降级直发分支）← notify-stale-guard.test.ts
//     （sendDelivery 半边的被测入口是 session-lifecycle 的 bindLedgerHostAndRecover，
//     归属 session-lifecycle 域——已迁 session-lifecycle.test.ts）
//   - M10 源码锚定（boundedPrettySerialize 调用点守卫，bounded 性能契约唯一防线）
//     ← robustness-medium-batch2-interface.test.ts
//
// [u9] notifyDone 账本化（C-ext-19 迁移——实施计划 u9 验收条款 ③ 的 mock 轨证据面，
// S7 断连重放真机验收前置）。账本路径覆盖验收面：
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
//
// mock 面单一定义：RunMock / makePi / LedgerHostMock 各一处（makePi 可注入
// sendMessage 实现——stale 守卫用例经此注入抛错形态）。「无绑定环境」前置由
// 文件级 afterEach 构造性保证（每用例后摘除模块级 ledger 绑定），不依赖
// describe 声明顺序——账本路径用例 bind 后，降级直发 / GUI / stale / bounded
// 用例恒从无绑定状态起步。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GuiRenderResult } from "@zhushanwen/extension-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { STALE_CTX_MARKER } from "@zhushanwen/pi-ext-guards";

const { loggerFns } = vi.hoisted(() => ({
  loggerFns: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@zhushanwen/pi-extension-logger", () => ({
  getLogger: () => loggerFns,
  setPiHandle: vi.fn(),
}));

import { bindNotifyLedgerHost, getBoundNotifyLedger, type NotifyLedgerHost } from "@zhushanwen/subagent-core";

import {
  MAX_NOTIFIED_RUN_IDS,
  notifyDone,
  trackNotifiedRunId,
  WORKFLOW_DONE_NOTIFY_ID_PREFIX,
} from "../workflow-notify.ts";

// ── core 账本常量镜像（见文件头说明） ──────────────────────────

const NOTIFY_LEDGER_CUSTOM_TYPE = "subagent-bg-notify-ledger";
const NOTIFY_ACK_CUSTOM_TYPE = "subagent-bg-notify-ack";
const WORKFLOW_RESULT_CUSTOM_TYPE = "workflow-result";

/** pi 实装 stale 文案的完整形态（E1 崩溃堆栈原文，探针 PS-30 守卫其稳定性）。 */
const PI_STALE_ERROR = `This extension ctx is stale ${STALE_CTX_MARKER} or reload. Do not use a captured pi or command ctx after ctx.newSession().`;

// ── mock 面（全文件单一定义；helpers-gui.test.ts 同款 duck typing） ──

type RunMock = {
  spec: { scriptName: string; slug?: string };
  meta?: { startedAt: string };
  state: {
    status: string;
    reason?: string;
    scriptResult?: unknown;
    /** failed 终局时 extractFailureErrorCode 遍历的调用注册表（其他形态不触达）。 */
    calls?: Map<unknown, unknown>;
    trace: { toArray: () => Array<{ stepIndex: number; agent: string; status: string }> };
  };
};

function makeRun(overrides?: {
  scriptName?: string;
  slug?: string;
  status?: string;
  reason?: string;
  scriptResult?: unknown;
  trace?: Array<{ stepIndex: number; agent: string; status: string }>;
  /** failed 终局 errorCode 提取的消费面（calls.set(1, { result })，payload 域用）。 */
  failedCall?: { error: string; failureKind: string };
}): RunMock {
  const calls = new Map<unknown, unknown>();
  if (overrides?.failedCall) {
    calls.set(1, { result: overrides.failedCall });
  }
  return {
    spec: { scriptName: overrides?.scriptName ?? "build", slug: overrides?.slug },
    meta: { startedAt: new Date().toISOString() },
    state: {
      status: overrides?.status ?? "done",
      // reason 不设默认：生产 reason 恒由 settlement 派生（W2/V1 载荷换源后
      // state.reason 不被读取），显式传值仅服务 details.reason 断言面
      reason: overrides?.reason,
      scriptResult: overrides?.scriptResult,
      calls,
      trace: { toArray: () => overrides?.trace ?? [] },
    },
  };
}

const runAsParam = (r: RunMock): Parameters<typeof notifyDone>[2] => r as never;

function makePi(sendMessageImpl?: (...args: unknown[]) => void): {
  pi: ExtensionAPI;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const sendMessage = vi.fn(sendMessageImpl);
  const pi = { sendMessage } as unknown as ExtensionAPI;
  return { pi, sendMessage };
}

/** 从 sendMessage 第 call 次调用的消息里取 details（GUI 协议观察面）。 */
function sentDetails(sendMessage: ReturnType<typeof vi.fn>, call = 0): unknown {
  return (sendMessage.mock.calls[call] as [{ details: unknown }])[0].details;
}

type LedgerHostMock = {
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
};

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

/** [W2/V1] 终局记录构造（notifyDone 载荷源换帧直取后的测试通道——reason 词表 →
 *  (outcome, errorCode) 按 D5 映射反构）。 */
function settlementFor(reason: string | undefined): import("../jsonl-run-store.ts").RunSettlementRecord {
  switch (reason) {
    case "completed":
      return { outcome: "completed", settledAt: 0 };
    case "aborted":
      return { outcome: "cancelled", settledAt: 0 };
    case "failed":
      return { outcome: "failed", errorCode: "unknown", settledAt: 0 };
    case "budget_limited":
      return { outcome: "failed", errorCode: "budget_limited", settledAt: 0 };
    case "time_limited":
      return { outcome: "failed", errorCode: "time_limited", settledAt: 0 };
    case undefined:
      return { outcome: "completed", settledAt: 0 };
    default:
      return { outcome: "failed", errorCode: "unknown", settledAt: 0 };
  }
}

// 「无绑定环境」构造性保证：任何用例（含账本路径 describe 内 bind / 用例中途
// re-bind）结束后摘除模块级 ledger 绑定——后续降级直发 / GUI / stale / bounded
// 用例恒走 getBoundNotifyLedger() === undefined 的降级分支。
afterEach(() => {
  getBoundNotifyLedger()?.dispose();
});

// ── 账本路径（bindNotifyLedgerHost 生产入口装配） ──────────────

describe("notifyDone — 账本四步生命周期（C-ext-19 迁移）", () => {
  let mock: LedgerHostMock;

  beforeEach(() => {
    mock = makeLedgerHost();
    bindNotifyLedgerHost(mock.host);
  });

  it("①→② 写账先于投递：notifyId = wf-done:<runId>，送达通道保持 workflow-result，content 不变，pi 直发零调用", () => {
    const { pi, sendMessage } = makePi();
    const run = makeRun({ scriptName: "fan-out", scriptResult: { status: "ok" } });

    notifyDone(pi, "wf-17abc", runAsParam(run), new Set(), undefined, undefined, settlementFor(run.state.reason));

    // ① 写账：ledger entry 落盘，幂等键形态 wf-done:<runId>
    expect(ledgerNotifyIds(mock)).toEqual(new Set([`${WORKFLOW_DONE_NOTIFY_ID_PREFIX}wf-17abc`]));
    // ② courier 投递：送达通道 workflow-result（W18 信号前提），details 携带 notifyId
    expect(mock.sentMessages).toHaveLength(1);
    expect(mock.sentMessages[0]?.customType).toBe(WORKFLOW_RESULT_CUSTOM_TYPE);
    // 全文逐字锚定（分支矩阵锁见文末 describe）：header + Script Result + Agent Trace
    expect(mock.sentMessages[0]?.content).toBe(
      "Workflow 'fan-out' done: done (completed)\n" +
        "\n" +
        "--- Script Result ---\n" +
        '{\n  "status": "ok"\n}\n' +
        "\n" +
        "--- Agent Trace ---",
    );
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

    notifyDone(pi, "wf-dup", runAsParam(run), new Set(), undefined, undefined, settlementFor(run.state.reason));
    // 第二次调用持全新 Set（模拟内存窗口挤出 / 重启后的重复收口回调）——
    // 持久层幂等键承接去重
    notifyDone(pi, "wf-dup", runAsParam(run), new Set(), undefined, undefined, settlementFor(run.state.reason));

    expect(mock.sentMessages).toHaveLength(1);
    // 账本单条：后写不覆盖（同键二次写账被拒）
    expect(mock.entries.filter((e) => e.customType === NOTIFY_LEDGER_CUSTOM_TYPE)).toHaveLength(1);
  });

  it("record 抛（reload 窗口 appendEntry assertActive 形态）→ error 留痕（含 notifyId/content 摘要）后原样上抛，去重不标记", () => {
    const { pi } = makePi();
    const run = makeRun();
    const notified = new Set<string>();

    // 已知丢失面（如实登记，见 notifyDone 注释）：appendLedgerEntry 抛 = 账面
    // entry 未写、无重放源——该终局通知丢失，仅 error 日志留痕供手工补偿。
    const origAppend = mock.host.appendLedgerEntry;
    mock.host.appendLedgerEntry = () => {
      throw new Error("session context is no longer active (assertActive)");
    };
    expect(() => notifyDone(pi, "wf-stale", runAsParam(run), notified, undefined, undefined, settlementFor(run.state.reason))).toThrow("assertActive");
    // error 留痕：含 notifyId 与 content 摘要（事后按 run 手工补偿的检索入口）
    expect(loggerFns.error).toHaveBeenCalledWith(
      expect.stringContaining("ledger record failed"),
      expect.objectContaining({
        runId: "wf-stale",
        notifyId: `${WORKFLOW_DONE_NOTIFY_ID_PREFIX}wf-stale`,
        contentPreview: expect.stringContaining("Workflow 'build' done"),
      }),
    );
    // 去重未标记：进程内的重复收口回调不被去重阻断（防御形态）
    expect(notified.has("wf-stale")).toBe(false);

    // 重复收口回调（若到达）：appendLedgerEntry 恢复 → 写账 + 投递成功
    mock.host.appendLedgerEntry = origAppend;
    notifyDone(pi, "wf-stale", runAsParam(run), notified, undefined, undefined, settlementFor(run.state.reason));
    expect(ledgerNotifyIds(mock)).toEqual(new Set([`${WORKFLOW_DONE_NOTIFY_ID_PREFIX}wf-stale`]));
    expect(mock.sentMessages).toHaveLength(1);
    expect(notified.has("wf-stale")).toBe(true);
  });

  it("③ 回执销账：settled 边沿 ack 后，同 runId 再收口零投递", () => {
    const { pi } = makePi();
    const run = makeRun();

    notifyDone(pi, "wf-ack", runAsParam(run), new Set(), undefined, undefined, settlementFor(run.state.reason));
    expect(mock.sentMessages).toHaveLength(1);

    // 送达 entry 已落盘（sendDelivery mock 同步持久化）→ settled 边沿销账
    fireSettled();
    expect(mock.entries.some((e) => e.customType === NOTIFY_ACK_CUSTOM_TYPE)).toBe(true);

    // 已销账号再收口：record 幂等拒绝（终态不重发）
    notifyDone(pi, "wf-ack", runAsParam(run), new Set(), undefined, undefined, settlementFor(run.state.reason));
    expect(mock.sentMessages).toHaveLength(1);
  });

  it("④ 未-ack 重放恰好一次（at-least-once + 去重）：回执不可达 → 恢复重放 1 次，二次恢复零重放", () => {
    const { pi } = makePi();
    const run = makeRun();

    // 投递受理但回执不可达（deliverPersists=false——模拟 relay 瞬断，消息丢失、
    // custom_message entry 未落盘）
    mock.deliverPersists.value = false;
    notifyDone(pi, "wf-lost", runAsParam(run), new Set(), undefined, undefined, settlementFor(run.state.reason));
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

    notifyDone(pi, "wf-done-ok", runAsParam(run), new Set(), undefined, undefined, settlementFor(run.state.reason));
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
  // 无绑定环境由文件级 afterEach 构造性保证：notifyDone 走
  // getBoundNotifyLedger() === undefined 的降级分支。
  it("fire-once 直发 pi.sendMessage：triggerTurn 单通道（无 deliverAs），details 携带 notifyId", () => {
    const { pi, sendMessage } = makePi();
    const run = makeRun();

    notifyDone(pi, "wf-fallback", runAsParam(run), new Set(), undefined, undefined, settlementFor(run.state.reason));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = sendMessage.mock.calls[0] as [
      { customType: string; content: string; display: boolean; details: { notifyId?: string } },
      Record<string, unknown>,
    ];
    expect(msg.customType).toBe(WORKFLOW_RESULT_CUSTOM_TYPE);
    expect(msg.display).toBe(true);
    // 全文逐字锚定：completed + 无 scriptResult + 空 trace + 无 artifacts 的最小形态
    expect(msg.content).toBe("Workflow 'build' done: done (completed)\n\n--- Agent Trace ---");
    expect(msg.details.notifyId).toBe(`${WORKFLOW_DONE_NOTIFY_ID_PREFIX}wf-fallback`);
    // u9 偏差裁决（D7 账本化配套）：deliverAs 已删
    expect(opts).toEqual({ triggerTurn: true });
    expect(getBoundNotifyLedger()).toBeUndefined();
  });
});

// ── content 全文锚定（LLM 可见文本锁） ────────────────────────

// notifyDone 的 content 分支矩阵（workflow-notify.ts parts 构造，期望值逐字取自实现）：
//   ① header 恒有：`Workflow '<name>' done: <status>[ (<reason>)]`
//   ② F3 防偷懒收尾指令段：reason ∈ isTerminalDoneReason 词表（failed/aborted/
//     invalid_args/budget_limited/time_limited——completed 不含）时追加
//   ③ Script Result 段：scriptResult 非 undefined 且非 null 时追加（含 bounded
//     pretty 序列化形态，序列化本体由 core bounded-serialize.test.ts 锚定）
//   ④ Agent Trace 段恒有：空 trace = 仅标题；非空 = `[<i>] <agent>: <status>` 行
//   ⑤ Artifacts 段：artifactsDir 传入时追加（含 events journal 派生路径）
// 经降级路径直测（ledger 未 bind → pi.sendMessage 直发）；prompt-quality 的源码
// 关键词断言是源码级防线，与这里的输出级锚定互补，不在此重复。

describe("notifyDone — content 分支矩阵全文锚定", () => {
  it("F3 段：terminal reason（budget_limited）→ 追加防偷懒收尾指令（逐字）", () => {
    const { pi, sendMessage } = makePi();
    const run = makeRun({ reason: "budget_limited" });

    notifyDone(pi, "wf-budget", runAsParam(run), new Set(), undefined, undefined, settlementFor(run.state.reason));

    const [msg] = sendMessage.mock.calls[0] as [{ content: string }];
    expect(msg.content).toBe(
      "Workflow 'build' done: done (budget_limited)\n" +
        "\n" +
        "This is NOT task completion. Summarize what was DONE and VERIFIED, list what remains NOT DONE, and give the user the single most important next step.\n" +
        "\n" +
        "--- Agent Trace ---",
    );
  });

  it("Artifacts 段：artifactsDir 传入 → 末尾追加产物指针（含 events journal 派生路径）", () => {
    const { pi, sendMessage } = makePi();
    const run = makeRun();

    notifyDone(pi, "wf-art-1", runAsParam(run), new Set(), undefined, "/tmp/wf-state", settlementFor(run.state.reason));

    const [msg] = sendMessage.mock.calls[0] as [{ content: string }];
    expect(msg.content).toBe(
      "Workflow 'build' done: done (completed)\n" +
        "\n" +
        "--- Agent Trace ---\n" +
        "\n" +
        "--- Artifacts ---\n" +
        "Artifacts dir: /tmp/wf-state\n" +
        "Events journal: /tmp/wf-state/wf-art-1.events.jsonl",
    );
  });

  it("全段组合：failed + 无 scriptResult + 非空 trace + artifactsDir（F3/Trace 行/Artifacts 齐）", () => {
    const { pi, sendMessage } = makePi();
    const run = makeRun({
      reason: "failed",
      trace: [
        { stepIndex: 0, agent: "builder", status: "completed" },
        { stepIndex: 1, agent: "reviewer", status: "failed" },
      ],
    });

    notifyDone(pi, "wf-full-1", runAsParam(run), new Set(), undefined, "/tmp/wf-state", settlementFor(run.state.reason));

    const [msg] = sendMessage.mock.calls[0] as [{ content: string }];
    expect(msg.content).toBe(
      "Workflow 'build' done: done (failed)\n" +
        "\n" +
        "This is NOT task completion. Summarize what was DONE and VERIFIED, list what remains NOT DONE, and give the user the single most important next step.\n" +
        "\n" +
        "--- Agent Trace ---\n" +
        "[0] builder: completed\n" +
        "[1] reviewer: failed\n" +
        "\n" +
        "--- Artifacts ---\n" +
        "Artifacts dir: /tmp/wf-state\n" +
        "Events journal: /tmp/wf-state/wf-full-1.events.jsonl",
    );
  });

  it("scriptResult null → 无 Script Result 段（null 与 undefined 同为缺省形态）", () => {
    const { pi, sendMessage } = makePi();
    const run = makeRun({ scriptResult: null });

    notifyDone(pi, "wf-null", runAsParam(run), new Set(), undefined, undefined, settlementFor(run.state.reason));

    const [msg] = sendMessage.mock.calls[0] as [{ content: string }];
    expect(msg.content).toBe("Workflow 'build' done: done (completed)\n\n--- Agent Trace ---");
  });

  it("[W2/V1] settlement completed（reason 缺省的联合派生形态）→ header 带 completed 后缀，无 F3 段", () => {
    const { pi, sendMessage } = makePi();
    const run: RunMock = {
      spec: { scriptName: "build" },
      state: { status: "done", trace: { toArray: () => [] } },
    };

    notifyDone(pi, "wf-noreason", runAsParam(run), new Set(), undefined, undefined, settlementFor((run as { state?: { reason?: string } }).state?.reason));

    const [msg] = sendMessage.mock.calls[0] as [{ content: string }];
    // [W2/V1 D1 第 7 行] 载荷源换终局记录——reason 恒由 settlement 派生（completed
    // 派生自带后缀），原 I2 兜底的「无后缀」异常形态退役
    expect(msg.content).toBe("Workflow 'build' done: done (completed)\n\n--- Agent Trace ---");
  });
});

// ── 终局载荷（D7） ───────────────────────────────────────────

// [P4 / D7] notifyDone 终局载荷扩展（impl-plan P4 验收条款 a：成功/失败/取消
// 各恰好一条，载荷含 outcome / 结果摘要或 errorCode / 产物与 journal 指针）。
// 覆盖面：三态 outcome 映射（completed→completed、failed→failed、aborted→
// cancelled，与 core doneReasonToRunOutcome（dispatchFinalRunSettle 消费）同构）；
// 成功载荷 resultSummary（bounded 截断）+ 指针面；失败载荷 errorCode（最后失败
// call 的 failureKind）+ 证据指针、零 resultSummary；取消载荷零 errorCode /
// 零 resultSummary（cancelled 无失败帧语义）；幂等键沿用 wf-done:<runId>、
// 送达通道保持 workflow-result、每 run 恰好一条。

const ARTIFACTS_DIR = "/tmp/wf-state-root/workflow-state";

describe("notifyDone 终局载荷（D7）", () => {
  it("成功：outcome=completed + resultSummary + 产物目录与 journal 指针，恰好一条", () => {
    const mock = makeLedgerHost();
    bindNotifyLedgerHost(mock.host);
    const run = makeRun({ reason: "completed", scriptResult: { ok: true, files: 3 } });

    notifyDone(makePi().pi, "wf-payload-ok", runAsParam(run), new Set(), undefined, ARTIFACTS_DIR, settlementFor(run.state.reason));

    expect(mock.sentMessages).toHaveLength(1);
    const delivery = mock.sentMessages[0]!;
    expect(delivery.customType).toBe(WORKFLOW_RESULT_CUSTOM_TYPE);
    const details = delivery.details as Record<string, unknown>;
    expect(details["notifyId"]).toBe(`${WORKFLOW_DONE_NOTIFY_ID_PREFIX}wf-payload-ok`);
    expect(details["outcome"]).toBe("completed");
    expect(typeof details["resultSummary"]).toBe("string");
    expect(details["resultSummary"]).toContain("ok");
    expect(details["errorCode"]).toBeUndefined();
    expect(details["artifactsDir"]).toBe(ARTIFACTS_DIR);
    expect(details["eventsJournalPath"]).toBe(`${ARTIFACTS_DIR}/wf-payload-ok.events.jsonl`);
    // 文案含产物指针段（主 agent 可操作的入口）
    expect(delivery.content).toContain("Artifacts dir:");
    expect(delivery.content).toContain(`Events journal: ${ARTIFACTS_DIR}/wf-payload-ok.events.jsonl`);
  });

  it("失败：outcome=failed + errorCode（最后失败 call 的 failureKind）+ 证据指针，零 resultSummary", () => {
    const mock = makeLedgerHost();
    bindNotifyLedgerHost(mock.host);
    const run = makeRun({ reason: "failed", failedCall: { error: "engine crashed", failureKind: "unknown" } });

    notifyDone(makePi().pi, "wf-payload-fail", runAsParam(run), new Set(), undefined, ARTIFACTS_DIR, settlementFor(run.state.reason));

    expect(mock.sentMessages).toHaveLength(1);
    const details = mock.sentMessages[0]!.details as Record<string, unknown>;
    expect(details["outcome"]).toBe("failed");
    expect(details["errorCode"]).toBe("unknown");
    expect(details["resultSummary"]).toBeUndefined();
    expect(details["eventsJournalPath"]).toBe(`${ARTIFACTS_DIR}/wf-payload-fail.events.jsonl`);
  });

  it("取消：outcome=cancelled（aborted 经 cancel-requested 同构映射），零 errorCode / 零 resultSummary", () => {
    const mock = makeLedgerHost();
    bindNotifyLedgerHost(mock.host);
    const run = makeRun({ reason: "aborted" });

    notifyDone(makePi().pi, "wf-payload-cancel", runAsParam(run), new Set(), undefined, ARTIFACTS_DIR, settlementFor(run.state.reason));

    expect(mock.sentMessages).toHaveLength(1);
    const details = mock.sentMessages[0]!.details as Record<string, unknown>;
    expect(details["outcome"]).toBe("cancelled");
    expect(details["errorCode"]).toBeUndefined();
    expect(details["resultSummary"]).toBeUndefined();
  });

  it("成功但 scriptResult 缺省 → resultSummary 缺省（载荷字段可缺席）；artifactsDir 未注入 → 指针面整体缺席", () => {
    const mock = makeLedgerHost();
    bindNotifyLedgerHost(mock.host);
    const run = makeRun({ reason: "completed" });

    notifyDone(makePi().pi, "wf-payload-bare", runAsParam(run), new Set(), undefined, undefined, settlementFor(run.state.reason));

    expect(mock.sentMessages).toHaveLength(1);
    const details = mock.sentMessages[0]!.details as Record<string, unknown>;
    expect(details["outcome"]).toBe("completed");
    expect(details["resultSummary"]).toBeUndefined();
    expect(details["artifactsDir"]).toBeUndefined();
    expect(details["eventsJournalPath"]).toBeUndefined();
    // 旧调用兼容：content 无 Artifacts 段（字节形态与扩展前一致）
    expect(mock.sentMessages[0]!.content).not.toContain("Artifacts dir:");
  });

  it("resultSummary bounded 截断（500 上限，超限带截断标记不截断为裸切片）", () => {
    const mock = makeLedgerHost();
    bindNotifyLedgerHost(mock.host);
    const big = "x".repeat(2000);
    const run = makeRun({ reason: "completed", scriptResult: big });

    notifyDone(makePi().pi, "wf-payload-big", runAsParam(run), new Set(), undefined, ARTIFACTS_DIR, settlementFor(run.state.reason));

    const summary = (mock.sentMessages[0]!.details as Record<string, unknown>)["resultSummary"] as string;
    expect(summary.length).toBeLessThanOrEqual(600); // 500 + 截断标记余量
    expect(summary).toContain("x");
  });
});

// ── scriptResult 序列化 — boundedPrettySerialize 等价锚定（IF13/#19，TC5/ES5）──
//
// bounded 序列化必须与旧实现（全量 JSON.stringify(x, null, 2) + slice(0,8000)+标记）
// 逐字节等价。断言面（design IF13/ES5 fixture）：
// - 深嵌套大对象 >8000 → slice(0,8000) + "\n... (truncated)" 逐字节一致
// - 循环引用 → String(value) 整串回退
// - 含 BigInt → String(value) 整串回退且不抛出
// - 含 Date（toJSON）→ 与原生逐字节一致（带引号序列化串）
// - undefined/function 属性省略；数组元素 undefined → null
// - 恰好 8000 不加标记 / 8001 → 截到 8000+标记 / 截断点落在转义序列中间
// - ≤8000 全形态（原语/数组/嵌套/NaN/Unicode）与原生逐字节一致
//
// 观察口径：经 notifyDone 公共入口（boundedPrettySerialize 为 helpers 私有），
// 从 sendMessage 的 content 中提取 "--- Script Result ---" 段。

/** 提取 content 中 "--- Script Result ---" 段（空 trace 时结尾固定为 Agent Trace 标头）。 */
function scriptResultSection(sendMessage: ReturnType<typeof vi.fn>): string {
  expect(sendMessage).toHaveBeenCalledTimes(1);
  const msg = sendMessage.mock.calls[0][0] as { content: string };
  const content = msg.content;
  const start = content.indexOf("--- Script Result ---\n");
  expect(start).toBeGreaterThan(-1);
  const end = content.lastIndexOf("\n\n--- Agent Trace ---");
  expect(end).toBeGreaterThan(start);
  return content.slice(start + "--- Script Result ---\n".length, end);
}

/** 旧实现参照（全量序列化 + 截断）。 */
function legacySerialize(x: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(x, null, 2);
  } catch {
    serialized = String(x);
  }
  return serialized.length > 8000
    ? serialized.slice(0, 8000) + "\n... (truncated)"
    : serialized;
}

function runAndGetSection(scriptResult: unknown): string {
  const { pi, sendMessage } = makePi();
  notifyDone(pi, "run-if13", runAsParam(makeRun({ scriptResult })), new Set(), undefined, undefined, settlementFor(undefined));
  return scriptResultSection(sendMessage);
}

// ── 深嵌套大对象 fixture ──────────────────────────────────────

function deepNested(): unknown {
  const root: Record<string, unknown> = {};
  let cur = root;
  for (let i = 0; i < 60; i++) {
    cur.header = `level-${i}-数据`;
    cur.items = Array.from({ length: 12 }, (__, j) => ({
      id: j,
      name: `item-${i}-${j}`,
      tags: ["alpha", "βeta", "γλυφ"],
      nested: { deep: { deeper: { value: i * 1000 + j } } },
    }));
    cur.next = {};
    cur = cur.next as Record<string, unknown>;
  }
  cur.end = "leaf";
  return root;
}

describe("notifyDone scriptResult — bounded 序列化等价锚定（IF13）", () => {
  it("深嵌套大对象（>8000）：与全量 stringify 后 slice+标记 逐字节一致", () => {
    const x = deepNested();
    expect(JSON.stringify(x, null, 2).length).toBeGreaterThan(10_000); // 确认确实超预算
    expect(runAndGetSection(x)).toBe(legacySerialize(x));
  });

  it("循环引用 → String(value) 整串回退（不抛出）", () => {
    const x: Record<string, unknown> = { a: 1 };
    x.self = x;
    expect(runAndGetSection(x)).toBe(legacySerialize(x));
    expect(runAndGetSection(x)).toBe(String(x));
  });

  it("含 BigInt → String(value) 整串回退且不抛出（对齐旧整体 catch）", () => {
    const x = { count: 10n, label: "big" };
    expect(runAndGetSection(x)).toBe(String(x));
    expect(runAndGetSection(x)).toBe(legacySerialize(x));
  });

  it("含 Date（toJSON）→ 与原生逐字节一致（带引号序列化串）", () => {
    const x = { at: new Date(0), note: "ts" };
    expect(runAndGetSection(x)).toBe(legacySerialize(x));
    expect(runAndGetSection(x)).toContain('"1970-01-01T00:00:00.000Z"');
  });

  it("undefined/function 属性省略与原生一致；数组内 undefined/function → null", () => {
    const x = {
      keep: 1,
      dropU: undefined,
      dropF: () => 1,
      arr: [undefined, 2, () => 3, null],
    };
    expect(runAndGetSection(x)).toBe(legacySerialize(x));
    expect(runAndGetSection(x)).toBe(JSON.stringify(x, null, 2));
  });

  it("≤8000 全形态与原生逐字节一致（原语/数组/嵌套/NaN/Infinity/Unicode）", () => {
    // 注：null / undefined 顶层被 notifyDone 上游守卫（!== undefined && !== null）
    // 跳过整段，不进序列化路径，不在此用例面内。
    const cases: unknown[] = [
      "plain string",
      42,
      true,
      NaN,
      Infinity,
      [1, [2, [3, "x"]]],
      { a: { b: { c: [1, "汉", { d: null }] } } },
      { emptyObj: {}, emptyArr: [] },
      { unicode: "line sep  pic ⌘" },
    ];
    for (const x of cases) {
      expect(runAndGetSection(x)).toBe(legacySerialize(x));
    }
  });
});

describe("notifyDone scriptResult — 截断边界（恰好 8000 / 8001 / 转义序列中间）", () => {
  /** 构造 pretty 全文恰好 len 字符的对象：{\n  "a": "<S>"\n} = 13 + S.length。 */
  function sizedStringObject(totalLen: number): { a: string } {
    return { a: "x".repeat(totalLen - 13) };
  }

  it("恰好 8000：不加标记，输出 === 原生全文", () => {
    const x = sizedStringObject(8000);
    expect(JSON.stringify(x, null, 2).length).toBe(8000); // 前置校验构造正确
    const section = runAndGetSection(x);
    expect(section).toBe(JSON.stringify(x, null, 2));
    expect(section).not.toContain("(truncated)");
    expect(section.length).toBe(8000);
  });

  it("8001：截到 8000 + 标记", () => {
    const x = sizedStringObject(8001);
    expect(JSON.stringify(x, null, 2).length).toBe(8001);
    const section = runAndGetSection(x);
    expect(section).toBe(JSON.stringify(x, null, 2).slice(0, 8000) + "\n... (truncated)");
    expect(section.length).toBe(8000 + "\n... (truncated)".length);
  });

  it("截断点落在转义序列中间（\\u0001 被切半）：与 slice 逐字节一致", () => {
    // 控制字符 U+0001 被 JSON.stringify 转义为 6 字符序列 \u0001（现代 Node 对
    // U+2028 不转义——ES2019 JSON superset，实测 JSON.stringify("\\u2028") 输出原字符，
    // 故用必转义的控制字符）。pad 逐字符平移使全文第 8000 字符扫过转义序列内部，
    // 命中起始反斜杠——截断点切在转义序列中间（不补任何转义闭合，末尾裸反斜杠）。
    const esc = "\u0001";
    let x: unknown = null;
    let full = "";
    for (let pad = 0; pad < 40; pad++) {
      const candidate = { pad: "p".repeat(pad), payload: Array.from({ length: 1200 }, () => esc + "汉") };
      const s = JSON.stringify(candidate, null, 2);
      if (s.length > 8000 && s.charCodeAt(7999) === 92) {
        x = candidate;
        full = s;
        break;
      }
    }
    expect(x).not.toBeNull();
    expect(full.charCodeAt(7999)).toBe(92); // 第 8000 字符 = 反斜杠（转义序列开头被切）
    const section = runAndGetSection(x);
    expect(section).toBe(full.slice(0, 8000) + "\n... (truncated)");
    // 截断段（前 8000 字符）末尾是裸反斜杠——切在转义序列中间，未补转义/结构闭合
    expect(section.slice(0, 8000).endsWith("\\")).toBe(true);
  });
});

// ── GUI 协议（S#13） ─────────────────────────────────────────

// notifyDone 在 run 到达 done 终态时发送完成通知，RPC 模式下附加 __gui__ list-tree。
// 覆盖：RPC 模式下 details.__gui__ 正确构造（list-tree + status/icon 映射）；reason
// 非空时 statusStr 拼接后映射正确（如 done (failed) → failed/cross）；reason 为空时
// 的映射；非 RPC 模式不附加 __gui__；label 格式含 slug（I#3 对齐）。

/** notifyDone details 内联镜像（helpers.ts WorkflowNotifyDetails 已去 export 为模块私有）。 */
type WorkflowNotifyDetails = {
  runId: string;
  name: string;
  status: string;
  reason: string | undefined;
  traceLength: number;
  /** [u9] 账本幂等键（wf-done:<runId>）——无 ledger 绑定，走降级直发，字段原样携带。 */
  notifyId: string;
  __gui__?: GuiRenderResult;
};

describe("notifyDone — GUI 协议", () => {
  it("RPC 模式 + reason=failed → __gui__ list-tree status=failed icon=cross", () => {
    const { pi, sendMessage } = makePi();
    const run = makeRun({ status: "done", reason: "failed", slug: "ci" });

    notifyDone(pi, "run-abc12345", runAsParam(run), new Set(), { mode: "rpc", hasUI: true }, undefined, settlementFor(run.state.reason));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const details = sentDetails(sendMessage) as WorkflowNotifyDetails;
    expect(details.__gui__).toBeDefined();
    const comp = details.__gui__!.component;
    expect(comp.type).toBe("list-tree");
    const items = comp.props.items as Array<{ status: string; icon: string }>;
    // statusStr = "done (failed)" → mapRunStatus 含 "failed" → failed
    expect(items[0].status).toBe("failed");
    expect(items[0].icon).toBe("cross");
  });

  it("RPC 模式 + 无 reason → __gui__ status=done icon=check", () => {
    const { pi, sendMessage } = makePi();
    const run = makeRun({ status: "done", reason: undefined, slug: "deploy" });

    notifyDone(pi, "run-defg1234", runAsParam(run), new Set(), { mode: "rpc", hasUI: true }, undefined, settlementFor(run.state.reason));

    const details = sentDetails(sendMessage) as WorkflowNotifyDetails;
    const items = details.__gui__!.component.props.items as Array<{ status: string; icon: string }>;
    expect(items[0].status).toBe("done");
    expect(items[0].icon).toBe("check");
  });

  it("RPC 模式 + reason=completed → __gui__ status=done icon=check", () => {
    const { pi, sendMessage } = makePi();
    const run = makeRun({ status: "done", reason: "completed", slug: "deploy" });

    notifyDone(pi, "run-comp1234", runAsParam(run), new Set(), { mode: "rpc", hasUI: true }, undefined, settlementFor(run.state.reason));

    const details = sentDetails(sendMessage) as WorkflowNotifyDetails;
    const items = details.__gui__!.component.props.items as Array<{ status: string; icon: string }>;
    expect(items[0].status).toBe("done");
    expect(items[0].icon).toBe("check");
  });

  it("RPC 模式 + label 含 slug（I#3 对齐 buildWorkflowGui 格式）", () => {
    const { pi, sendMessage } = makePi();
    const run = makeRun({ status: "done", reason: "completed", slug: "ci" });

    notifyDone(pi, "abcdefgh1234", runAsParam(run), new Set(), { mode: "rpc", hasUI: true }, undefined, settlementFor(run.state.reason));

    const details = sentDetails(sendMessage) as WorkflowNotifyDetails;
    const items = details.__gui__!.component.props.items as Array<{ label: string }>;
    // label = `${name} ${slug} ${runId.slice(0,8)}`.trim()
    expect(items[0].label).toBe("build ci abcdefgh");
  });

  it("RPC 模式 + 无 slug → label 不含多余空格（filter(Boolean) 生效）", () => {
    const { pi, sendMessage } = makePi();
    const run = makeRun({ status: "done", reason: "completed", slug: undefined });

    notifyDone(pi, "abcdefgh1234", runAsParam(run), new Set(), { mode: "rpc", hasUI: true }, undefined, settlementFor(run.state.reason));

    const details = sentDetails(sendMessage) as WorkflowNotifyDetails;
    const items = details.__gui__!.component.props.items as Array<{ label: string }>;
    // slug 为 undefined → filter(Boolean) 过滤空段 → "build abcdefgh"（单空格）
    expect(items[0].label).toBe("build abcdefgh");
  });

  it("非 RPC 模式 → 不附加 __gui__", () => {
    const { pi, sendMessage } = makePi();
    const run = makeRun({ status: "done", reason: "completed" });

    notifyDone(pi, "run-xxx", runAsParam(run), new Set(), { mode: "tui", hasUI: true }, undefined, settlementFor(run.state.reason));

    const details = sentDetails(sendMessage) as WorkflowNotifyDetails;
    expect(details.__gui__).toBeUndefined();
  });

  it("无 ctx → 不附加 __gui__", () => {
    const { pi, sendMessage } = makePi();
    const run = makeRun({ status: "done", reason: "completed" });

    notifyDone(pi, "run-yyy", runAsParam(run), new Set(), undefined, undefined, settlementFor(run.state.reason));

    const details = sentDetails(sendMessage) as WorkflowNotifyDetails;
    expect(details.__gui__).toBeUndefined();
  });

  it("去重：同一 runId 第二次调用不发送消息", () => {
    const { pi, sendMessage } = makePi();
    const run = makeRun({ status: "done", reason: "completed" });
    const notified = new Set<string>();

    notifyDone(pi, "run-dedup", runAsParam(run), notified, { mode: "rpc", hasUI: true }, undefined, settlementFor(run.state.reason));
    notifyDone(pi, "run-dedup", runAsParam(run), notified, { mode: "rpc", hasUI: true }, undefined, settlementFor(run.state.reason));

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("details 基础字段正确（runId/name/status/reason/traceLength）", () => {
    const { pi, sendMessage } = makePi();
    const run = makeRun({
      status: "done",
      reason: "completed",
      scriptName: "my-workflow",
      trace: [
        { stepIndex: 0, agent: "coder", status: "done" },
        { stepIndex: 1, agent: "reviewer", status: "done" },
      ],
    });

    notifyDone(pi, "run-base123", runAsParam(run), new Set(), { mode: "rpc", hasUI: true }, undefined, settlementFor(run.state.reason));

    const details = sentDetails(sendMessage) as WorkflowNotifyDetails;
    expect(details.runId).toBe("run-base123");
    expect(details.name).toBe("my-workflow");
    expect(details.status).toBe("done");
    expect(details.reason).toBe("completed");
    expect(details.traceLength).toBe(2);
  });
});

describe("trackNotifiedRunId（notifiedRunIds 有界 FIFO）", () => {
  it("W3TC11: 有界 FIFO——超 cap 删最旧（Set 迭代序=插入序）", () => {
    const set = new Set<string>();
    trackNotifiedRunId(set, "a", 3);
    trackNotifiedRunId(set, "b", 3);
    trackNotifiedRunId(set, "c", 3);
    trackNotifiedRunId(set, "d", 3);

    // "a" 最旧被删——Set 迭代序=插入序，删迭代器首元素即删最旧
    expect(set.size).toBe(3);
    expect(Array.from(set)).toEqual(["b", "c", "d"]);
  });

  it("W3TC12: 有界后旧 id 不再去重——被挤出窗口的 runId 再 notifyDone 会重新发送", () => {
    const { pi, sendMessage } = makePi();
    const run = makeRun({ status: "done", reason: "completed" });
    const set = new Set<string>();
    const ctx = { mode: "rpc", hasUI: true } as const;

    // old 首次通知 + track
    notifyDone(pi, "old", runAsParam(run), set, ctx, undefined, settlementFor(run.state.reason));
    trackNotifiedRunId(set, "old", 3);
    // 3 个新 run 依次通知 + track——"old" 被挤出窗口（set 现为 n1/n2/n3）
    for (const id of ["n1", "n2", "n3"]) {
      notifyDone(pi, id, runAsParam(run), set, ctx, undefined, settlementFor(run.state.reason));
      trackNotifiedRunId(set, id, 3);
    }
    expect(set.size).toBe(3);
    expect(Array.from(set)).toEqual(["n1", "n2", "n3"]);

    // 第二次对 "old" 的 notifyDone：has 为 false → 重新发送
    notifyDone(pi, "old", runAsParam(run), set, ctx, undefined, settlementFor(run.state.reason));

    // 旧行为『永不重复』在挤出窗口后不成立——边界显式钉死：
    // old 首次 + n1/n2/n3 + old 二次 = 5 次
    expect(pi.sendMessage).toHaveBeenCalledTimes(5);
  });

  it("W3TC13: 幂等——重复 track 同一 id 不改变插入位置", () => {
    const set = new Set<string>();
    trackNotifiedRunId(set, "x", 3);
    trackNotifiedRunId(set, "x", 3); // 重复：Set.add 不改变迭代位置
    trackNotifiedRunId(set, "y", 3);
    trackNotifiedRunId(set, "z", 3);
    trackNotifiedRunId(set, "w", 3); // 触发超限：若第二次 track("x") 误重置位置，被删的将错为 y

    // 被删的是 "x"（首次插入位置不变仍最旧），非 "y"
    expect(set.size).toBe(3);
    expect(Array.from(set)).toEqual(["y", "z", "w"]);
  });

  it("生产默认 cap 锚定：不传 cap 时窗口上限 === MAX_NOTIFIED_RUN_IDS（循环实测 1001 次）", () => {
    expect(MAX_NOTIFIED_RUN_IDS).toBe(1000);
    const set = new Set<string>();
    for (let i = 0; i < 1001; i++) {
      trackNotifiedRunId(set, `run-${i}`);
    }
    expect(set.size).toBe(MAX_NOTIFIED_RUN_IDS);
    // 最旧的 run-0 已被挤出窗口
    expect(set.has("run-0")).toBe(false);
    expect(set.has("run-1")).toBe(true);
    expect(set.has("run-1000")).toBe(true);
  });
});

// ── stale ctx 守卫（guardStaleCtx 接入，出自 notify-stale-guard.test.ts）──────
//
// stale ctx 守卫接入（crash-resilience D1 / ext-guards 审计 §7 blockers#1 收口）：
// notifyDone（workflow-notify.ts）[u9 账本化] 主路径走 ledger（courier 装配层
// sendDelivery 已内置 stale 防御）；本组用例覆盖的是 ledger 未 bind 的降级直发
// 分支——pi.sendMessage 经 guardStaleCtx 包裹后 stale 错误（含 PS-30 分诊词）静默
// 降级不外抛；非 stale 错误原样上抛（同一错误实例，守卫不吞真实 bug）；正常路径
// 参数透传零变化（A2 负面验证的单测面）。sendDelivery 半边（同链路家族同判，
// 被测入口是 session-lifecycle 的 bindLedgerHostAndRecover seam）已迁
// session-lifecycle.test.ts。形态对齐 ext-guards guard-stale-ctx.test.ts；分诊无
// isCtxStale 注入（与生产接入一致，文案兜底由 PS-30 门禁守卫）。

describe("notifyDone stale ctx 守卫（guardStaleCtx 接入）", () => {
  it("stale 错误静默降级：不外抛（session 替换窗口不再崩 pi）", () => {
    const { pi, sendMessage } = makePi(() => {
      throw new Error(PI_STALE_ERROR);
    });

    expect(() => notifyDone(pi, "run-stale", runAsParam(makeRun({ scriptResult: { ok: 1 } })), new Set(), undefined, undefined, settlementFor(undefined))).not.toThrow();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("非 stale 错误原样上抛：同一错误实例，守卫不吞真实 bug", () => {
    const boom = new Error("real bug: serialization exploded");
    const { pi } = makePi(() => {
      throw boom;
    });

    expect(() => notifyDone(pi, "run-boom", runAsParam(makeRun({ scriptResult: { ok: 1 } })), new Set(), undefined, undefined, settlementFor(undefined))).toThrow(boom);
  });

  it("正常路径零变化：workflow-result 消息与单通道 triggerTurn 参数原样透传（[u9] 账本化后直发仅存于 ledger 未 bind 的降级形态——deliverAs 已删，本组无绑定环境）", () => {
    const { pi, sendMessage } = makePi();

    notifyDone(pi, "run-ok", runAsParam(makeRun({ scriptResult: { ok: 1 } })), new Set(), undefined, undefined, settlementFor(undefined));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = sendMessage.mock.calls[0] as [
      { customType: string; content: string; display: boolean },
      Record<string, unknown>,
    ];
    expect(msg.customType).toBe(WORKFLOW_RESULT_CUSTOM_TYPE);
    expect(msg.display).toBe(true);
    expect(msg.content).toContain("Workflow 'build' done");
    expect(opts).toEqual({ triggerTurn: true });
  });
});

// ── M10: notifyDone 序列化有循环引用保护（IF13 后形态，源码锚定）─────────
//
// IF13（#19）：notifyDone 的 scriptResult 序列化从「整体 try { JSON.stringify(x, null, 2) }
// catch { String(x) }」重构为 boundedPrettySerialize（只生成 ≤8000 前缀）。循环引用
// 保护语义不变，锚定点：(1) notifyDone 调用 boundedPrettySerialize(scriptResult)；
// (2) 实现内祖先 Set 守卫（命中 throw）+ 顶层 try-catch 整体回退 String(value)
// ——(2) 已随实现下沉锚定于 core __tests__/bounded-serialize.test.ts。
// 行为级等价（回退输出与旧实现逐字节一致）由本文件 bounded 序列化 describe 锚定。
// 本条是 bounded 性能契约在壳侧的唯一防线（robustness-medium-batch2 豁免保留项，
// 出自 robustness-medium-batch2-interface.test.ts）。

describe("M10: notifyDone serialization has circular ref protection", () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const PKG_ROOT = join(__dirname, "..", "..");

  function readSrc(relPath: string): string {
    return readFileSync(join(PKG_ROOT, relPath), "utf-8");
  }

  const src = readSrc(join("src", "workflow-notify.ts"));

  it("notifyDone serializes scriptResult via boundedPrettySerialize", () => {
    // 调用点：scriptResult 不再直接 JSON.stringify，走 bounded 序列化
    const callMatch = src.match(/boundedPrettySerialize\(run\.state\.scriptResult,\s*MAX_RESULT_LENGTH\)/);
    expect(callMatch).toBeTruthy();
  });
});
