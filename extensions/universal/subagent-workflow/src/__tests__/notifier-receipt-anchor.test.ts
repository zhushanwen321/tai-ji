// 通知通路 D1 申报制行为锁（msg-pipeline-debloat U-C1 / 设计 §3.3 D1+D2）。
//
// 锁什么：notifier 内核 fallback 路径的连续投递——两条 custom 通知经真实
// @zhushanwen/session-delivery 内核（configureNotifyDomain 注入，pi-host 同形装配）
// 连续投出，且 gate 保持开（第三条零延迟续投）。
//
// 为什么是行为锁：notifier 通知出站文本无裸标记（无回执锚点），交付依赖
// deliverViaLedgerOrKernel 的 handle.send 申报 receiptAnchor:'acceptance'
// （受理即落地）。重构若丢失该申报，缺省 'marker' 让首条通知受理后滞留 in-flight
// 等一个永不到达的回执（notifier port 无回执通路），gate 内查在途恒真——第二条
// 只能等 50 次退避强发（backoff 100ms × 50 = 5s），零 timer 推进的断言即红。
// 本测试与 runtime 侧 S1 复现单测（session-delivery-registry.test.ts）对齐成对。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDelivery } from "@zhushanwen/session-delivery";
import { configureNotifyDomain, resetNotifyDomainForTests } from "@zhushanwen/subagent-core/core/notify-ports.ts";
import { createNotifier, type BgNotifier, type NotifierHost } from "@zhushanwen/subagent-core/execution/notify/notifier.ts";

// 真实内核注入（与 pi-host.createPiNotifyDomainPorts 生产装配同形）
beforeEach(() => {
  vi.useFakeTimers();
  configureNotifyDomain({ createDelivery });
});
afterEach(() => {
  resetNotifyDomainForTests();
  vi.useRealTimers();
});

/** mock host：捕获所有 sendMessage 调用 + 控制 hasRunningBackground + isIdle（notifier-flush.test.ts 同形）。 */
function makeMockHost(): NotifierHost & {
  sendMessageCalls: { message: unknown; options: unknown }[];
  hasRunningBackground: ReturnType<typeof vi.fn>;
  isIdle: ReturnType<typeof vi.fn>;
} {
  const sendMessageCalls: { message: unknown; options: unknown }[] = [];
  const hasRunningBackground = vi.fn(() => false);
  const isIdle = vi.fn(() => true);
  return {
    sendMessageCalls,
    hasRunningBackground,
    isIdle,
    sendMessage(message, options) {
      sendMessageCalls.push({ message, options });
    },
  };
}

describe("notifier 内核 fallback 路径 D1 申报制行为锁（连续两条 custom 经真实内核）", () => {
  let host: ReturnType<typeof makeMockHost>;
  let notifier: BgNotifier;

  beforeEach(() => {
    host = makeMockHost();
    notifier = createNotifier(host);
  });

  afterEach(() => {
    notifier.dispose();
  });

  it("连续两条 custom 通知立即投出且 gate 开（第三条零延迟续投）——丢申报时本测试红", () => {
    notifier.notify({
      id: "bg-lock-1",
      status: "closed",
      agent: "explorer",
      result: "first done",
      startedAt: Date.now() - 1000,
      endedAt: Date.now(),
    });
    notifier.notify({
      id: "bg-lock-2",
      status: "closed",
      agent: "explorer",
      result: "second done",
      startedAt: Date.now() - 1000,
      endedAt: Date.now(),
    });

    // 零 timer 推进：两条均受理即落地（acceptance 申报）→ in-flight 不积压 → 立即全投。
    // 丢申报红灯形态：首条滞留 in-flight，第二条被 busy gate 挡住（sendCalls 停在 1）。
    expect(host.sendMessageCalls).toHaveLength(2);
    expect(host.sendMessageCalls[0]!.message).toMatchObject({ customType: "subagent-bg-notify" });
    expect(String((host.sendMessageCalls[0]!.message as { content: string }).content)).toContain("first done");
    expect(String((host.sendMessageCalls[1]!.message as { content: string }).content)).toContain("second done");

    // gate 开：第三条零延迟续投（在途内查恒空）
    notifier.notify({
      id: "bg-lock-3",
      status: "closed",
      agent: "explorer",
      result: "third done",
      startedAt: Date.now() - 1000,
      endedAt: Date.now(),
    });
    expect(host.sendMessageCalls).toHaveLength(3);
    expect(String((host.sendMessageCalls[2]!.message as { content: string }).content)).toContain("third done");
  });
});
