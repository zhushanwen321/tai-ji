/**
 * Golden snapshot 固化测试：记录 notifier.buildLlmContent 在各种输入下的输出。
 *
 * 此测试在迁移**前**运行并固化结果——迁移后必须逐字节一致（G4）。
 *
 * 这些测试直接测试 BgNotifier 的输出内容，不涉及 send/handle 机制，
 * 因此迁移后应通过内核装配 + 同一 buildLlmContent 产生相同输出。
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDelivery } from "@xyz-agent/session-delivery";
import { configureNotifyDomain, resetNotifyDomainForTests } from "@zhushanwen/subagent-core/core/notify-ports.ts";
import { createNotifier, type BgNotifyRecord, type NotifierHost } from "@zhushanwen/subagent-core/execution/notify/notifier.ts";
import { renderBgNotifyMessage } from "../interface/bg-notify-render.ts";

// 投递内核经通知域窄端口注入（notifier 不再直接 import session-delivery）——
// batch merge 用例依赖真实内核合批语义，注入真实 createDelivery 保住回归面。
beforeEach(() => {
  configureNotifyDomain({ createDelivery });
});
afterEach(() => {
  resetNotifyDomainForTests();
});

/** 渲染锁用 mock theme（与 bg-notify-render.test.ts 同款：透传文本，记录色 token）。 */
function makeRenderTheme(): { theme: Theme } {
  return {
    theme: {
      fg: (_tag: string, text: string) => text,
      bold: (text: string) => text,
      bg: (_color: string, text: string) => text,
    } as unknown as Theme,
  };
}

/** 创建 mock host，notifier 会立即 flush（hasRunningBackground=false）。 */
function makeMockHost(): NotifierHost {
  return {
    sendMessage: () => {},
    hasRunningBackground: () => false,
    isIdle: () => true,
  };
}

/**
 * 调用 notifier.notify 并捕获 sendMessage 的 content 参数。
 * 前置条件：hasRunningBackground=false → notify 立即 flush。
 */
function captureNotificationContent(record: BgNotifyRecord): string {
  let capturedContent = "";
  const host: NotifierHost = {
    sendMessage: (msg) => {
      capturedContent = (msg as { content: string }).content;
    },
    hasRunningBackground: () => false,
    isIdle: () => true,
  };
  const notifier = createNotifier(host);
  notifier.notify(record);
  notifier.dispose();
  return capturedContent;
}

describe("U3_UNIT notifier golden snapshots (pre-migration freeze)", () => {
  it("single closed success — one-shot completed notification", () => {
    const content = captureNotificationContent({
      id: "sa-ptr-7",
      status: "closed",
      agent: "worker",
      result: "done",
      startedAt: 1,
      endedAt: 2,
    });
    expect(content).toBe('Subagent "worker" (sa-ptr-7) completed. Result:\ndone');
  });

  it("single closed + sessionFile — pointer line appended", () => {
    const content = captureNotificationContent({
      id: "sa-ptr-2",
      status: "closed",
      agent: "w",
      result: "final result",
      sessionFile: "/tmp/sessions/child-2.jsonl",
      startedAt: 1,
      endedAt: 2,
    });
    expect(content).toBe(
      'Subagent "w" (sa-ptr-2) completed. Result:\nfinal result\n\nFull transcript: /tmp/sessions/child-2.jsonl',
    );
  });

  it("single running round (chatMode) — round notification", () => {
    const content = captureNotificationContent({
      id: "sa-ptr-4",
      status: "running",
      agent: "w",
      round: 2,
      result: "round2 text",
      startedAt: 1,
      endedAt: 2,
    });
    expect(content).toBe('Subagent "w" (sa-ptr-4) finished a round. Reply:\nround2 text');
  });

  it("single running round + sessionFile — pointer appended to round notification", () => {
    const content = captureNotificationContent({
      id: "sa-ptr-1",
      status: "running",
      agent: "w",
      round: 1,
      result: "round1 text",
      sessionFile: "/tmp/sessions/child-1.jsonl",
      startedAt: 1,
      endedAt: 2,
    });
    expect(content).toBe(
      'Subagent "w" (sa-ptr-1) finished a round. Reply:\nround1 text\n\nFull transcript: /tmp/sessions/child-1.jsonl',
    );
  });

  it("single cancelled — cancelled message, no pointer", () => {
    const content = captureNotificationContent({
      id: "sa-ptr-5",
      status: "closed",
      closedReason: "cancelled",
      agent: "w",
      startedAt: 1,
      endedAt: 2,
    });
    expect(content).toBe('Subagent "w" (sa-ptr-5) cancelled.');
  });

  it("single gc-failed — error message, no pointer", () => {
    const content = captureNotificationContent({
      id: "sa-ptr-6",
      status: "closed",
      closedReason: "gc",
      agent: "w",
      error: "spawn EPIPE",
      startedAt: 1,
      endedAt: 2,
    });
    expect(content).toBe('Subagent "w" (sa-ptr-6) failed: spawn EPIPE');
  });

  it("single gc-failed + patchFile — failed takes priority, no patch hint", () => {
    const content = captureNotificationContent({
      id: "sa-ptr-8",
      status: "closed",
      closedReason: "gc",
      agent: "w",
      error: "spawn EPIPE",
      patchFile: "/tmp/patches/sa-ptr-8.patch",
      startedAt: 1,
      endedAt: 2,
    });
    expect(content).toBe('Subagent "w" (sa-ptr-8) failed: spawn EPIPE');
  });

  it("single closed + patchFile + sessionFile — patch hint + pointer", () => {
    const content = captureNotificationContent({
      id: "sa-ptr-3",
      status: "closed",
      agent: "w",
      result: "did work",
      patchFile: "/tmp/patches/sa-ptr-3.patch",
      sessionFile: "/tmp/sessions/child-3.jsonl",
      startedAt: 1,
      endedAt: 2,
    });
    expect(content).toContain("git apply /tmp/patches/sa-ptr-3.patch");
    expect(content.endsWith("\n\nFull transcript: /tmp/sessions/child-3.jsonl")).toBe(true);
  });

  it("closed + totalRounds — chatMode close with round stats", () => {
    const content = captureNotificationContent({
      id: "sa-rounds-1",
      status: "closed",
      agent: "w",
      totalRounds: 3,
      result: "",
      sessionFile: "/tmp/sessions/child-rounds.jsonl",
      startedAt: 1,
      endedAt: 2,
    });
    expect(content).toBe(
      "Subagent \"w\" (sa-rounds-1) completed after 3 rounds. Result:\n\n\nFull transcript: /tmp/sessions/child-rounds.jsonl",
    );
  });

  it("closed no totalRounds — one-shot, no round stats", () => {
    const content = captureNotificationContent({
      id: "sa-rounds-2",
      status: "closed",
      agent: "w",
      result: "done",
      sessionFile: "/tmp/sessions/child-oneshot.jsonl",
      startedAt: 1,
      endedAt: 2,
    });
    expect(content).toBe(
      'Subagent "w" (sa-rounds-2) completed. Result:\ndone\n\nFull transcript: /tmp/sessions/child-oneshot.jsonl',
    );
  });
});

describe("notifier golden — batch merge (60s window, two records)", () => {
  it("two closed records joined with separator", () => {
    let capturedContent = "";
    let capturedDetails: unknown;
    const host: NotifierHost = {
      sendMessage: (msg) => {
        capturedContent = (msg as { content: string }).content;
        capturedDetails = (msg as { details: unknown }).details;
      },
      hasRunningBackground: () => true, // true → 合批窗口激活
      isIdle: () => true,
    };
    const notifier = createNotifier(host);

    // 两条通知入队（不立即 flush——hasRunningBackground=true）
    notifier.notify({
      id: "batch-1", status: "closed", agent: "w1", result: "result1",
      startedAt: 1, endedAt: 2,
    });
    notifier.notify({
      id: "batch-2", status: "closed", agent: "w2", result: "result2",
      startedAt: 3, "endedAt": 4,
    });

    // 手动 flush（模拟窗口到期）
    notifier.flushPendingNotifications();

    expect(capturedContent).toBe(
      'Subagent "w1" (batch-1) completed. Result:\nresult1\n\n---\n\nSubagent "w2" (batch-2) completed. Result:\nresult2',
    );
    // details 结构（must-fix #13 / #6 锁死）：items 元素必须是 record 本体（顶层
    // status/agent/id/result——bg-notify-render 的 extractBgNotifyRecord 按此读取），
    // 拦截内核 items 规则回归（曾错装 payload 导致渲染降级默认样式）。
    const details = capturedDetails as { batch: boolean; items: unknown[] };
    expect(details.batch).toBe(true);
    expect(details.items).toHaveLength(2);
    expect(details.items[0]).toMatchObject({
      id: "batch-1",
      status: "closed",
      agent: "w1",
      result: "result1",
      startedAt: 1,
      endedAt: 2,
    });
    expect(details.items[1]).toMatchObject({
      id: "batch-2",
      status: "closed",
      agent: "w2",
      result: "result2",
    });
    // 端到端渲染锁（#6）：合批 details 直接喂 bg-notify-render 必须走批量分支成功渲染
    // （非 undefined 兜底），两条 agent 均可见。
    const { theme } = makeRenderTheme();
    const comp = renderBgNotifyMessage(
      { details: capturedDetails },
      { expanded: false },
      theme,
    );
    expect(comp).toBeDefined();
    const joined = comp!.render(80).join("\n");
    expect(joined).toContain("w1");
    expect(joined).toContain("w2");

    notifier.dispose();
  });
});
