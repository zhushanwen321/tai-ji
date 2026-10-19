// 通知通路 D1 申报制行为锁（msg-pipeline-debloat U-C1 / 设计 §3.3 D1+D2）——
// unified-delivery 波 2 送达凭据行为锁更新（impl-plan A5）。
//
// 锁什么：notifier 通知通路的连续投递——多条 custom 通知连续提交无死锁、无积压
// （第三条零延迟续投）。
//
// 波 2 形态对位（原「内核 fallback 路径 receiptAnchor:'acceptance' 申报」锁面）：
// 内核 gate / in-flight 死锁形态随内核队列持有退役——port 主投走内核 v3 on-accept
// 模式（受理即出站，无 gate 内查死锁面），送达凭据 = 'details-id'（端口注入前统一
// 写 details.deliveryId，u2 套件「四步对位」锁定）；port 缺席降级 = 直发兜底（无
// gate 无队列，连续投递构造性成立）。本文件双段锁定两形态的连续投递：丢申报类
// 回归（历史红灯形态：首条滞留 in-flight 等永不到达的回执）在两形态下均结构性
// 不可达——本测试保持为「连续投递不断流」的回归锚。
//
// 本测试与 runtime 侧 S1 复现单测（session-delivery-registry.test.ts）对齐成对。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureNotifyDomain,
  resetNotifyDomainForTests,
  type DeliveryPortHandle,
} from "@zhushanwen/subagent-core/core/notify-ports.ts";
import { createNotifier, type BgNotifier, type NotifierHost } from "@zhushanwen/subagent-core/execution/notify/notifier.ts";

/** mock host：捕获所有 sendMessage 调用 + 控制 hasRunningBackground（直发兜底观测点）。 */
function makeMockHost(): NotifierHost & {
  sendMessageCalls: { message: unknown; options: unknown }[];
  hasRunningBackground: ReturnType<typeof vi.fn>;
} {
  const sendMessageCalls: { message: unknown; options: unknown }[] = [];
  const hasRunningBackground = vi.fn(() => false);
  return {
    sendMessageCalls,
    hasRunningBackground,
    sendMessage(message, options) {
      sendMessageCalls.push({ message, options });
    },
  };
}

/** fake 投递端口（逐条受理记录——port 本体行为由 pi-delivery-port 套件锁定）。 */
function makeFakePort() {
  const acceptedIds: string[] = [];
  const handle: DeliveryPortHandle = {
    deliver(envelope) {
      const id = envelope.id ?? "gen-id";
      acceptedIds.push(id);
      return { kind: "accepted", id };
    },
    flush: () => {},
  };
  return { handle, acceptedIds };
}

beforeEach(() => {
  resetNotifyDomainForTests();
});

afterEach(() => {
  resetNotifyDomainForTests();
  vi.useRealTimers();
});

const notifyRecord = (id: string, result: string) => ({
  id,
  status: "closed" as const,
  agent: "explorer",
  result,
  startedAt: Date.now() - 1000,
  endedAt: Date.now(),
});

describe("notifier port 主投路径连续投递行为锁（details-id 凭据，on-accept 无死锁面）", () => {
  let fake: ReturnType<typeof makeFakePort>;
  let notifier: BgNotifier;

  beforeEach(() => {
    vi.useFakeTimers();
    fake = makeFakePort();
    configureNotifyDomain({ getDeliveryPort: () => fake.handle });
    notifier = createNotifier(makeMockHost());
  });

  afterEach(() => {
    notifier.dispose();
  });

  it("连续三条 custom 通知全部受理（零 timer 推进即受理）——丢幂等键/受理即堵时本测试红", () => {
    notifier.notify(notifyRecord("bg-lock-1", "first done"));
    notifier.notify(notifyRecord("bg-lock-2", "second done"));

    // 零 timer 推进：两条均受理（on-accept 模式无 gate 积压）
    expect(fake.acceptedIds).toEqual(["bg-lock-1", "bg-lock-2"]);

    // gate 开：第三条零延迟续投
    notifier.notify(notifyRecord("bg-lock-3", "third done"));
    expect(fake.acceptedIds).toEqual(["bg-lock-1", "bg-lock-2", "bg-lock-3"]);
    // 幂等键随条（port 判重锚 = notifier 构造的 notifyId）
    expect(fake.acceptedIds[0]).toBe("bg-lock-1");
  });
});

describe("notifier 缺席直发兜底连续投递行为锁（port 缺席窗口，无 gate 无队列）", () => {
  let host: ReturnType<typeof makeMockHost>;
  let notifier: BgNotifier;

  beforeEach(() => {
    vi.useFakeTimers();
    host = makeMockHost();
    notifier = createNotifier(host);
  });

  afterEach(() => {
    notifier.dispose();
  });

  it("连续三条 custom 通知立即直投（缺省直发无回执锚点死锁形态）", () => {
    notifier.notify(notifyRecord("bg-fb-1", "first done"));
    notifier.notify(notifyRecord("bg-fb-2", "second done"));
    notifier.notify(notifyRecord("bg-fb-3", "third done"));

    expect(host.sendMessageCalls).toHaveLength(3);
    expect(host.sendMessageCalls.map((c) => (c.message as { content: string }).content)).toEqual([
      expect.stringContaining("first done"),
      expect.stringContaining("second done"),
      expect.stringContaining("third done"),
    ]);
    // 直发单通道：options 恰 { triggerTurn: true }
    for (const call of host.sendMessageCalls) {
      expect(call.options).toEqual({ triggerTurn: true });
    }
  });
});
