// src/__tests__/notify-stale-guard.test.ts
//
// stale ctx 守卫接入单测（crash-resilience D1 / ext-guards 审计 §7 blockers#1 收口）：
// - notifyDone（interface/helpers.ts）：pi.sendMessage 裸调经 guardStaleCtx 包裹后
//   stale 错误（含 PS-30 分诊词）静默降级不外抛；非 stale 错误原样上抛（同一错误
//   实例，守卫不吞真实 bug）；正常路径参数透传零变化（A2 负面验证的单测面）。
// - sendDelivery（session-lifecycle.ts ledgerHost）：同链路家族同判，经
//   bindLedgerHostAndRecover 测试直入 seam 取装配后的 host 验证同一分诊三面。
//
// 形态对齐 ext-guards guard-stale-ctx.test.ts（PI_STALE_ERROR 文案 fixture）与
// helpers-bounded-serialize.test.ts（pi duck-typing mock）。分诊无 isCtxStale 注入
// （与生产接入一致，文案兜底由 PS-30 门禁守卫）。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { STALE_CTX_MARKER } from "@zhushanwen/pi-ext-guards";

import { notifyDone } from "../interface/helpers.ts";
import { bindLedgerHostAndRecover } from "../session-lifecycle.ts";

/** pi 实装 stale 文案的完整形态（E1 崩溃堆栈原文，探针 PS-30 守卫其稳定性）。 */
const PI_STALE_ERROR = `This extension ctx is stale ${STALE_CTX_MARKER} or reload. Do not use a captured pi or command ctx after ctx.newSession().`;

// ── notifyDone 侧 mock（helpers-bounded-serialize.test.ts 同款 duck typing）─────

type RunMock = {
  spec: { scriptName: string };
  state: {
    status: string;
    reason?: string;
    scriptResult?: unknown;
    trace: { toArray: () => [] };
  };
};

function makeRun(): RunMock {
  return {
    spec: { scriptName: "build" },
    state: {
      status: "done",
      reason: "completed",
      scriptResult: { ok: 1 },
      trace: { toArray: () => [] },
    },
  };
}

function makePi(sendMessageImpl?: (...args: unknown[]) => void): {
  pi: ExtensionAPI;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const sendMessage = vi.fn(sendMessageImpl);
  const pi = { sendMessage } as unknown as ExtensionAPI;
  return { pi, sendMessage };
}

// ── sendDelivery 侧 mock（bindLedgerHostAndRecover 最小 pi/ctx 面）──────────────

function makeLedgerPi(sendMessageImpl?: (...args: unknown[]) => void): {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const sendMessage = vi.fn(sendMessageImpl);
  const noop = (): void => {
    /* mock */
  };
  const pi = {
    appendEntry: noop,
    on: noop,
    sendMessage,
  } as unknown as ExtensionAPI;
  const ctx = {
    sessionManager: { getEntries: () => [] },
    isIdle: () => true,
  } as unknown as ExtensionContext;
  return { pi, ctx, sendMessage };
}

const DELIVERY_MESSAGE = {
  customType: "bg-notify",
  content: "subagent done: reviewer",
  display: true,
};

// ── notifyDone ─────────────────────────────────────────────────────

describe("notifyDone stale ctx 守卫（guardStaleCtx 接入）", () => {
  it("stale 错误静默降级：不外抛（session 替换窗口不再崩 pi）", () => {
    const { pi, sendMessage } = makePi(() => {
      throw new Error(PI_STALE_ERROR);
    });

    expect(() => notifyDone(pi, "run-stale", makeRun() as never, new Set())).not.toThrow();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("非 stale 错误原样上抛：同一错误实例，守卫不吞真实 bug", () => {
    const boom = new Error("real bug: serialization exploded");
    const { pi } = makePi(() => {
      throw boom;
    });

    expect(() => notifyDone(pi, "run-boom", makeRun() as never, new Set())).toThrow(boom);
  });

  it("正常路径零变化：workflow-result 消息与 deliverAs:steer 参数原样透传", () => {
    const { pi, sendMessage } = makePi();

    notifyDone(pi, "run-ok", makeRun() as never, new Set());

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = sendMessage.mock.calls[0] as [
      { customType: string; content: string; display: boolean },
      Record<string, unknown>,
    ];
    expect(msg.customType).toBe("workflow-result");
    expect(msg.display).toBe(true);
    expect(msg.content).toContain("Workflow 'build' done");
    expect(opts).toEqual({ triggerTurn: true, deliverAs: "steer" });
  });
});

// ── sendDelivery（同链路家族同判）────────────────────────────────────

describe("sendDelivery stale ctx 守卫（bindLedgerHostAndRecover seam）", () => {
  it("stale 错误静默降级：不外抛，投递不放大为无人接 rejection", () => {
    const { pi, ctx, sendMessage } = makeLedgerPi(() => {
      throw new Error(PI_STALE_ERROR);
    });
    const host = bindLedgerHostAndRecover(pi, ctx);
    expect(host).toBeDefined();

    expect(() => host!.sendDelivery(DELIVERY_MESSAGE)).not.toThrow();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("非 stale 错误原样上抛：attemptDeliver 既有 catch（settleRejected 留账重试）仍可接住", () => {
    const boom = new Error("delivery rejected by runtime");
    const { pi, ctx } = makeLedgerPi(() => {
      throw boom;
    });
    const host = bindLedgerHostAndRecover(pi, ctx);

    expect(() => host!.sendDelivery(DELIVERY_MESSAGE)).toThrow(boom);
  });

  it("正常路径零变化：单通道形态 sendCustomMessage({triggerTurn:true}) 原样透传", () => {
    const { pi, ctx, sendMessage } = makeLedgerPi();
    const host = bindLedgerHostAndRecover(pi, ctx);

    host!.sendDelivery(DELIVERY_MESSAGE);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = sendMessage.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(msg).toEqual(DELIVERY_MESSAGE);
    expect(opts).toEqual({ triggerTurn: true });
  });
});
