// src/__tests__/helpers-notify-payload.test.ts
//
// [P4 / D7] notifyDone 终局载荷扩展单测（impl-plan P4 验收条款 a：成功/失败/取消
// 各恰好一条，载荷含 outcome / 结果摘要或 errorCode / 产物与 journal 指针）。
//
// 覆盖面：
//   - 三态 outcome 映射：completed→completed、failed→failed、aborted→cancelled
//     （mapDoneReasonToOutcome 与 core dispatchFinalRunSettle 同构）
//   - 成功载荷：resultSummary（bounded 截断）+ 产物目录与 events journal 指针
//   - 失败载荷：errorCode（最后失败 call 的 failureKind）+ 证据指针；零 resultSummary
//   - 取消载荷：零 errorCode / 零 resultSummary（cancelled 无失败帧语义）
//   - 幂等键沿用 wf-done:<runId>、送达通道保持 workflow-result、每 run 恰好一条
//
// 形态参照：helpers-notify-ledger.test.ts（mock ledger host + RunMock duck typing）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { bindNotifyLedgerHost, getBoundNotifyLedger, type NotifyLedgerHost } from "@zhushanwen/subagent-core";

import { notifyDone, WORKFLOW_DONE_NOTIFY_ID_PREFIX } from "../workflow-notify.ts";

// ── mock 面（helpers-notify-ledger.test.ts 同款 duck typing） ────────────

type RunMock = {
  spec: { scriptName: string; slug?: string };
  meta: { startedAt: string };
  state: {
    status: string;
    reason?: string;
    scriptResult?: unknown;
    calls: Map<number, { result?: { error?: string; failureKind?: string } }>;
    trace: { toArray: () => Array<{ stepIndex: number; agent: string; status: string }> };
  };
};

function makeRun(overrides?: {
  reason?: string;
  scriptResult?: unknown;
  failedCall?: { error: string; failureKind: string };
}): RunMock {
  const calls = new Map<number, { result?: { error?: string; failureKind?: string } }>();
  if (overrides?.failedCall) {
    calls.set(1, { result: overrides.failedCall });
  }
  return {
    spec: { scriptName: overrides?.reason === undefined ? "build" : "build" },
    meta: { startedAt: new Date().toISOString() },
    state: {
      status: "done",
      reason: overrides?.reason ?? "completed",
      scriptResult: overrides?.scriptResult,
      calls,
      trace: { toArray: () => [] },
    },
  };
}

const runAsParam = (r: RunMock): Parameters<typeof notifyDone>[2] => r as never;

interface LedgerHarness {
  host: NotifyLedgerHost;
  deliveries: { customType: string; content: string; display: boolean; details?: unknown }[];
  setIdle(idle: boolean): void;
}

function makeLedgerHarness(): LedgerHarness {
  let idle = true;
  const deliveries: LedgerHarness["deliveries"] = [];
  const host: NotifyLedgerHost = {
    appendLedgerEntry: vi.fn(),
    readSessionEntries: vi.fn(() => []),
    isIdle: () => idle,
    onAgentSettled: vi.fn(),
    sendDelivery: vi.fn((message: { customType: string; content: string; display: boolean; details?: unknown }) => {
      deliveries.push(message);
    }),
  };
  return { host, deliveries, setIdle: (v: boolean) => (idle = v) };
}

function makePi(): ExtensionAPI {
  return { sendMessage: vi.fn() } as unknown as ExtensionAPI;
}

const ARTIFACTS_DIR = "/tmp/wf-state-root/workflow-state";

beforeEach(() => {
  // 隔离：清上一用例的模块级绑定（各用例内 makeLedgerHarness 后自行 bind 新 host
  // ——helpers-notify-ledger.test.ts 同款纪律）
  getBoundNotifyLedger()?.dispose();
});

// ── 三态载荷 ─────────────────────────────────────────────────

describe("notifyDone 终局载荷（D7）", () => {
  it("成功：outcome=completed + resultSummary + 产物目录与 journal 指针，恰好一条", () => {
    const harness = makeLedgerHarness();
    bindNotifyLedgerHost(harness.host);
    const run = makeRun({ reason: "completed", scriptResult: { ok: true, files: 3 } });

    notifyDone(makePi(), "wf-payload-ok", runAsParam(run), new Set(), undefined, ARTIFACTS_DIR);

    expect(harness.deliveries).toHaveLength(1);
    const delivery = harness.deliveries[0]!;
    expect(delivery.customType).toBe("workflow-result");
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
    const harness = makeLedgerHarness();
    bindNotifyLedgerHost(harness.host);
    const run = makeRun({ reason: "failed", failedCall: { error: "engine crashed", failureKind: "unknown" } });

    notifyDone(makePi(), "wf-payload-fail", runAsParam(run), new Set(), undefined, ARTIFACTS_DIR);

    expect(harness.deliveries).toHaveLength(1);
    const details = harness.deliveries[0]!.details as Record<string, unknown>;
    expect(details["outcome"]).toBe("failed");
    expect(details["errorCode"]).toBe("unknown");
    expect(details["resultSummary"]).toBeUndefined();
    expect(details["eventsJournalPath"]).toBe(`${ARTIFACTS_DIR}/wf-payload-fail.events.jsonl`);
  });

  it("取消：outcome=cancelled（aborted 经 cancel-requested 同构映射），零 errorCode / 零 resultSummary", () => {
    const harness = makeLedgerHarness();
    bindNotifyLedgerHost(harness.host);
    const run = makeRun({ reason: "aborted" });

    notifyDone(makePi(), "wf-payload-cancel", runAsParam(run), new Set(), undefined, ARTIFACTS_DIR);

    expect(harness.deliveries).toHaveLength(1);
    const details = harness.deliveries[0]!.details as Record<string, unknown>;
    expect(details["outcome"]).toBe("cancelled");
    expect(details["errorCode"]).toBeUndefined();
    expect(details["resultSummary"]).toBeUndefined();
  });

  it("成功但 scriptResult 缺省 → resultSummary 缺省（载荷字段可缺席）；artifactsDir 未注入 → 指针面整体缺席", () => {
    const harness = makeLedgerHarness();
    bindNotifyLedgerHost(harness.host);
    const run = makeRun({ reason: "completed" });

    notifyDone(makePi(), "wf-payload-bare", runAsParam(run), new Set(), undefined);

    expect(harness.deliveries).toHaveLength(1);
    const details = harness.deliveries[0]!.details as Record<string, unknown>;
    expect(details["outcome"]).toBe("completed");
    expect(details["resultSummary"]).toBeUndefined();
    expect(details["artifactsDir"]).toBeUndefined();
    expect(details["eventsJournalPath"]).toBeUndefined();
    // 旧调用兼容：content 无 Artifacts 段（字节形态与扩展前一致）
    expect(harness.deliveries[0]!.content).not.toContain("Artifacts dir:");
  });

  it("resultSummary bounded 截断（500 上限，超限带截断标记不截断为裸切片）", () => {
    const harness = makeLedgerHarness();
    bindNotifyLedgerHost(harness.host);
    const big = "x".repeat(2000);
    const run = makeRun({ reason: "completed", scriptResult: big });

    notifyDone(makePi(), "wf-payload-big", runAsParam(run), new Set(), undefined, ARTIFACTS_DIR);

    const summary = (harness.deliveries[0]!.details as Record<string, unknown>)["resultSummary"] as string;
    expect(summary.length).toBeLessThanOrEqual(600); // 500 + 截断标记余量
    expect(summary).toContain("x");
  });
});
