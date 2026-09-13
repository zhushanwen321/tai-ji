// src/__tests__/notify-batch-golden.test.ts
//
// sync 批通知 golden（subagent-sync-collect U3）：新批文案字节锁（设计 §3.3 D3——
// 「批是新文案，新 golden；旧 golden 不动全绿」G3 异步字节锁不受影响）。
//
// 锁定面：
//   - 批头行 `Subagent batch completed: N finished, M failed, K cancelled.` 精确形态
//   - 批头与成员条目、成员条目两两之间的 "\n\n---\n\n" join 分隔（对齐既有合批形态）
//   - 成员条目复用 buildLlmContent 语义（completed/failed/cancelled 三态逐字节）
//   - details 形态 { batch:true, notifyId, items } —— bg-notify-render 批量分支
//     端到端渲染锁（⛔1：extractBatch 对该形态的渲染支持，含新增顶层 notifyId 键透明）
//
// 手法对齐 notifier-golden-snapshot.test.ts（无 ledger 装配 → 内核降级路径捕获
// sendMessage content；每用例独立 notifier + dispose）。不引用旧 golden 文件与
// notifier-golden-snapshot.test.ts（G3：旧文件零改动）。

import type { Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDelivery } from "@xyz-agent/session-delivery";
import { configureNotifyDomain, resetNotifyDomainForTests } from "@zhushanwen/subagent-core/core/notify-ports.ts";
import {
  buildBatchNotifyId,
  createNotifier,
  type BgNotifyRecord,
  type NotifierHost,
} from "@zhushanwen/subagent-core/execution/notify/notifier.ts";
import { renderBgNotifyMessage } from "../interface/bg-notify-render.ts";

beforeEach(() => {
  configureNotifyDomain({ createDelivery });
});
afterEach(() => {
  resetNotifyDomainForTests();
});

/** 渲染锁用 mock theme（与 notifier-golden-snapshot.test.ts 同款：透传文本）。 */
function makeRenderTheme(): { theme: Theme } {
  return {
    theme: {
      fg: (_tag: string, text: string) => text,
      bold: (text: string) => text,
      bg: (_color: string, text: string) => text,
    } as unknown as Theme,
  };
}

/** 调用 notifyBatch 并捕获投递消息（content + details）。
 *  前置：无 ledger 装配 → 内核降级直发（每批单条 send）。 */
function captureBatch(members: BgNotifyRecord[]): {
  content: string;
  details: { batch: boolean; notifyId: string; items: BgNotifyRecord[] };
} {
  let captured: { content: string; details: unknown } | undefined;
  const host: NotifierHost = {
    sendMessage: (msg) => {
      captured = { content: (msg as { content: string }).content, details: (msg as { details?: unknown }).details };
    },
    hasRunningBackground: () => false,
    isIdle: () => true,
  };
  const notifier = createNotifier(host);
  const accepted = notifier.notifyBatch(members);
  expect(accepted).toBe(true);
  notifier.dispose();
  expect(captured).toBeDefined();
  return {
    content: captured!.content,
    details: captured!.details as { batch: boolean; notifyId: string; items: BgNotifyRecord[] },
  };
}

describe("sync batch notification golden (U3 — batch format lock, design §3.1.1)", () => {
  it("3 finished — full golden: header + three entries joined by separators", () => {
    const { content, details } = captureBatch([
      { id: "bg-aaa", status: "closed", agent: "explore-runtime", result: "runtime result body", startedAt: 1, endedAt: 2 },
      { id: "bg-bbb", status: "closed", agent: "explore-renderer", result: "renderer result body", startedAt: 3, endedAt: 4 },
      { id: "bg-ccc", status: "closed", agent: "explore-ext", result: "ext result body", startedAt: 5, endedAt: 6 },
    ]);
    expect(content).toBe(
      [
        "Subagent batch completed: 3 finished, 0 failed, 0 cancelled.",
        'Subagent "explore-runtime" (bg-aaa) completed. Result:\nruntime result body',
        'Subagent "explore-renderer" (bg-bbb) completed. Result:\nrenderer result body',
        'Subagent "explore-ext" (bg-ccc) completed. Result:\next result body',
      ].join("\n\n---\n\n"),
    );
    expect(details.batch).toBe(true);
    expect(details.notifyId).toBe(buildBatchNotifyId(["bg-aaa", "bg-bbb", "bg-ccc"]));
    expect(details.items).toHaveLength(3);
  });

  it("2 finished + 1 failed — header counts and failed entry carries error first line", () => {
    const { content } = captureBatch([
      { id: "sa-ok1", status: "closed", agent: "worker-a", result: "fine", startedAt: 1, endedAt: 2 },
      { id: "sa-bad", status: "closed", agent: "worker-b", error: "spawn EPIPE", startedAt: 1, endedAt: 2 },
      { id: "sa-ok2", status: "closed", agent: "worker-c", result: "also fine", startedAt: 1, endedAt: 2 },
    ]);
    expect(content).toBe(
      [
        "Subagent batch completed: 2 finished, 1 failed, 0 cancelled.",
        'Subagent "worker-a" (sa-ok1) completed. Result:\nfine',
        'Subagent "worker-b" (sa-bad) failed: spawn EPIPE',
        'Subagent "worker-c" (sa-ok2) completed. Result:\nalso fine',
      ].join("\n\n---\n\n"),
    );
  });

  it("cancelled member — header counts cancelled, entry is the short cancelled line", () => {
    const { content } = captureBatch([
      { id: "sa-live", status: "closed", agent: "worker-live", result: "done", startedAt: 1, endedAt: 2 },
      { id: "sa-gone", status: "closed", agent: "worker-gone", closedReason: "cancelled", startedAt: 1, endedAt: 2 },
    ]);
    expect(content).toBe(
      [
        "Subagent batch completed: 1 finished, 0 failed, 1 cancelled.",
        'Subagent "worker-live" (sa-live) completed. Result:\ndone',
        'Subagent "worker-gone" (sa-gone) cancelled.',
      ].join("\n\n---\n\n"),
    );
  });

  it("single-member batch — same batch format (residual single sync member)", () => {
    const { content } = captureBatch([
      { id: "sa-solo", status: "closed", agent: "worker-solo", result: "solo result", startedAt: 1, endedAt: 2 },
    ]);
    expect(content).toBe(
      [
        "Subagent batch completed: 1 finished, 0 failed, 0 cancelled.",
        'Subagent "worker-solo" (sa-solo) completed. Result:\nsolo result',
      ].join("\n\n---\n\n"),
    );
  });
});

describe("sync batch details — bg-notify-render batch branch end-to-end (⛔1 渲染核对)", () => {
  it("batch details render through the batch branch: every member visible", () => {
    const { details } = captureBatch([
      { id: "bg-aaa", status: "closed", agent: "explore-runtime", result: "runtime body", startedAt: 1, endedAt: 2 },
      { id: "bg-bbb", status: "closed", agent: "explore-renderer", error: "boom", startedAt: 3, endedAt: 4 },
      { id: "bg-ccc", status: "closed", agent: "explore-ext", closedReason: "cancelled", startedAt: 5, endedAt: 6 },
    ]);
    const { theme } = makeRenderTheme();
    const comp = renderBgNotifyMessage({ details }, { expanded: false }, theme);
    expect(comp).toBeDefined();
    const joined = comp!.render(80).join("\n");
    // 三成员全部可见（finished / failed / cancelled 三态各一条渲染行）
    expect(joined).toContain("explore-runtime");
    expect(joined).toContain("explore-renderer");
    expect(joined).toContain("boom");
    expect(joined).toContain("explore-ext");
    // 顶层新增 notifyId 键对渲染透明（extractBatch 只认 batch/items 两键）
    expect(details.notifyId).toBe(buildBatchNotifyId(["bg-aaa", "bg-bbb", "bg-ccc"]));
  });
});
