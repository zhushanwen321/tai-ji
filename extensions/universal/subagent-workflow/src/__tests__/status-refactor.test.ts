// src/__tests__/status-refactor.test.ts
//
// SP-1: L1/L2 状态机重构验证测试。
//
// 验证：
//   1. ClosedReason 枚举完整性（6 个值）
//   2. tryTransition → closed + closedReason 写入
//   3. completeRecord → closed + closedReason 写入
//   4. notifier dedupKey: round 参与去重（MF-1 修复，idle 按 id:round 去重）
//   5. ExecutionStatus 不含 done/failed/crashed 字面量
//   6. mapExternalState closed → ended
//   7. statusGlyph closed → ✓ success
//   8. BgNotifyRecord.status 不含 done/failed

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDelivery } from "@xyz-agent/session-delivery";
import { configureNotifyDomain, resetNotifyDomainForTests } from "@zhushanwen/subagent-core/core/notify-ports.ts";
import { completeRecord, createRecord, tryTransition } from "@zhushanwen/subagent-core/execution/persistence/execution-record.ts";
import { createNotifier } from "@zhushanwen/subagent-core/execution/notify/notifier.ts";
import type { BgNotifyRecord, BgNotifier, NotifierHost } from "@zhushanwen/subagent-core/execution/notify/notifier.ts";
import { mapExternalState } from "../interface/subagent-actions.ts";
import { statusGlyph } from "../interface/format.ts";
import type { ClosedReason, ExecutionRecord, ExecutionStatus } from "@zhushanwen/subagent-core";

// 投递内核经通知域窄端口注入（notifier 不再直接 import session-delivery）——
// BgNotifier dedupKey 用例依赖真实内核 dedupe 语义，注入真实 createDelivery；
// afterEach 重置防注入态泄漏。
beforeEach(() => {
  configureNotifyDomain({ createDelivery });
});
afterEach(() => {
  resetNotifyDomainForTests();
});

// ============================================================
// ClosedReason 枚举完整性
// ============================================================

describe("ClosedReason enum", () => {
  it("包含全部 6 个值", () => {
    const reasons: ClosedReason[] = [
      "parent-shutdown",
      "parent-fork",
      "parent-new",
      "user-close",
      "cancelled",
      "gc",
    ];
    // 类型检查：赋值不报错即通过
    expect(reasons).toHaveLength(6);
  });

  it("ClosedReason 值类型正确", () => {
    const r: ClosedReason = "gc";
    expect(typeof r).toBe("string");
  });
});

// ============================================================
// ExecutionStatus 不含旧字面量
// ============================================================

describe("ExecutionStatus type", () => {
  it("合法值只有 running/closed（v4 B-1 两态收敛）", () => {
    const validStatuses: ExecutionStatus[] = ["running", "idle"];
    expect(validStatuses).toHaveLength(2);
  });

  it("done/failed/crashed 不是合法 ExecutionStatus", () => {
    // 编译期验证：以下赋值应报 TS 类型错误（通过 @ts-expect-error 验证）
    // @ts-expect-error SP-1: done 已移除
    const _done: ExecutionStatus = "done";
    // @ts-expect-error SP-1: failed 已移除
    const _failed: ExecutionStatus = "failed";
    // @ts-expect-error SP-1: crashed 已移除
    const _crashed: ExecutionStatus = "crashed";
    // 如果编译通过说明类型未正确收窄——此测试不应到达运行时
    expect(_done).toBe("done"); // never reached if tsc errors
  });
});

// ============================================================
// tryTransition + closedReason
// ============================================================

describe("tryTransition with closed + closedReason", () => {
  function makeRunningRecord(): ExecutionRecord {
    return createRecord("test-1", {
      agent: "test-agent",
      model: "test-model",
      mode: "background",
      task: "test task",
      slug: "test-slug",
      startedAt: Date.now(),
    });
  }

  it("running → closed + gc 写入 closedReason", () => {
    const record = makeRunningRecord();
    expect(record.status).toBe("running");

    const ok = tryTransition(record, "closed", "gc");
    expect(ok).toBe(true);
    expect(record.status).toBe("idle");
    expect(record.closedReason).toBe("gc");
  });

  it("running → closed + user-close 写入 closedReason", () => {
    const record = makeRunningRecord();
    const ok = tryTransition(record, "closed", "user-close");
    expect(ok).toBe(true);
    expect(record.status).toBe("idle");
    expect(record.closedReason).toBe("user-close");
  });

  it("running → closed 无 closedReason 默认 gc", () => {
    const record = makeRunningRecord();
    const ok = tryTransition(record, "closed");
    expect(ok).toBe(true);
    expect(record.status).toBe("idle");
    expect(record.closedReason).toBe("gc");
  });

  it("running → closed + cancelled 写入 closedReason（cancelled 折入 closed）", () => {
    const record = makeRunningRecord();
    const ok = tryTransition(record, "closed", "cancelled");
    expect(ok).toBe(true);
    expect(record.status).toBe("idle");
    expect(record.closedReason).toBe("cancelled");
  });

  it("closed 不可再转（CAS 互斥锁）", () => {
    const record = makeRunningRecord();
    tryTransition(record, "closed", "gc");
    const ok = tryTransition(record, "closed", "user-close");
    expect(ok).toBe(false);
    expect(record.status).toBe("idle");
    expect(record.closedReason).toBe("gc"); // 未被覆盖
  });

  it("closed + cancelled 不可再转（CAS 互斥锁，closedReason 不可覆盖）", () => {
    const record = makeRunningRecord();
    tryTransition(record, "closed", "cancelled");
    const ok = tryTransition(record, "closed", "gc");
    expect(ok).toBe(false);
    expect(record.status).toBe("idle");
    expect(record.closedReason).toBe("cancelled"); // 未被覆盖
  });
});

// ============================================================
// completeRecord + closedReason
// ============================================================

describe("completeRecord with closed + closedReason", () => {
  function makeRunningRecord(): ExecutionRecord {
    return createRecord("test-cr", {
      agent: "test-agent",
      model: "test-model",
      mode: "background",
      task: "test task",
      slug: "test-slug",
      startedAt: Date.now(),
    });
  }

  it("closed + gc 写入 closedReason + endedAt", () => {
    const record = makeRunningRecord();
    const result = { text: "done", turns: 1, durationMs: 100, success: true, sessionId: "s", toolCalls: [] };
    completeRecord(record, result, "closed", "gc");

    expect(record.status).toBe("idle");
    expect(record.closedReason).toBe("gc");
    expect(record.endedAt).toBeDefined();
    expect(record.result).toBe("done");
  });

  it("closed + user-close 写入 closedReason", () => {
    const record = makeRunningRecord();
    const result = { text: "", turns: 0, durationMs: 0, success: true, sessionId: "s", toolCalls: [] };
    completeRecord(record, result, "closed", "user-close");

    expect(record.status).toBe("idle");
    expect(record.closedReason).toBe("user-close");
  });

  it("closed 无 closedReason 默认 gc", () => {
    const record = makeRunningRecord();
    const result = { text: "", turns: 0, durationMs: 0, success: true, sessionId: "s", toolCalls: [] };
    completeRecord(record, result, "closed");

    expect(record.closedReason).toBe("gc");
  });

  it("closed + cancelled 写入 closedReason（cancelled 折入 closed）", () => {
    const record = makeRunningRecord();
    const result = { text: "", turns: 0, durationMs: 0, success: false, error: "cancelled", sessionId: "s", toolCalls: [] };
    completeRecord(record, result, "closed", "cancelled");

    expect(record.status).toBe("idle");
    expect(record.closedReason).toBe("cancelled");
  });
});

// ============================================================
// Notifier dedupKey: round 参与去重（MF-1 修复）
// ============================================================

describe("BgNotifier dedupKey", () => {
  function createMockHost(hasRunning = false): NotifierHost {
    return {
      sendMessage: () => {},
      hasRunningBackground: () => hasRunning,
    };
  }

  it("同 id 不同 round 不被去重（round 参与 dedup key）", () => {
    const host = createMockHost(false);
    const notifier = createNotifier(host);
    const sent: unknown[] = [];
    // 重写 sendMessage 捕获
    (host as { sendMessage: NotifierHost["sendMessage"] }).sendMessage = (msg) => { sent.push(msg); };

    const record1: BgNotifyRecord = {
      id: "sa-123",
      status: "closed",
      agent: "test",
      result: "round 1",
      startedAt: Date.now(),
      endedAt: Date.now(),
      round: 1,
    };
    const record2: BgNotifyRecord = {
      id: "sa-123", // 同 id
      status: "closed",
      agent: "test",
      result: "round 2",
      startedAt: Date.now(),
      endedAt: Date.now(),
      round: 2, // 不同 round
    };

    notifier.notify(record1);
    notifier.notify(record2);

    // MF-1 修复：dedup key=id:round，不同 round 不互相吞
    expect(sent).toHaveLength(2);
  });

  it("不同 id 不被去重", () => {
    const host = createMockHost(false);
    const notifier = createNotifier(host);
    const sent: unknown[] = [];
    (host as { sendMessage: NotifierHost["sendMessage"] }).sendMessage = (msg) => { sent.push(msg); };

    const record1: BgNotifyRecord = {
      id: "sa-111",
      status: "closed",
      agent: "test",
      result: "result 1",
      startedAt: Date.now(),
      endedAt: Date.now(),
    };
    const record2: BgNotifyRecord = {
      id: "sa-222",
      status: "closed",
      agent: "test",
      result: "result 2",
      startedAt: Date.now(),
      endedAt: Date.now(),
    };

    notifier.notify(record1);
    notifier.notify(record2);

    expect(sent).toHaveLength(2);
  });

  it("closed status 被正确入队", () => {
    const host = createMockHost(false);
    const notifier = createNotifier(host);
    const sent: unknown[] = [];
    (host as { sendMessage: NotifierHost["sendMessage"] }).sendMessage = (msg) => { sent.push(msg); };

    const record: BgNotifyRecord = {
      id: "sa-333",
      status: "closed",
      closedReason: "gc",
      agent: "test",
      result: "some result",
      startedAt: Date.now(),
      endedAt: Date.now(),
    };

    notifier.notify(record);
    expect(sent).toHaveLength(1);
  });
});

// ============================================================
// mapExternalState: closed → ended
// ============================================================

describe("mapExternalState", () => {
  it("running → active", () => {
    expect(mapExternalState("running")).toBe("active");
  });

  it("idle → idle（[U2 两态] 永久会话无 ended 形态）", () => {
    expect(mapExternalState("idle")).toBe("idle");
  });
});

// ============================================================
// statusGlyph: closed → ✓ success
// ============================================================

describe("statusGlyph", () => {
  it("idle → ✓ success（[U2 两态] 承接旧 closed 分支视觉基线）", () => {
    const glyph = statusGlyph("idle");
    expect(glyph.icon).toBe("✓");
    expect(glyph.color).toBe("success");
  });

  it("running → accent (no icon)", () => {
    const glyph = statusGlyph("running");
    expect(glyph.icon).toBeUndefined();
    expect(glyph.color).toBe("accent");
  });
});

// ============================================================
// BgNotifyRecord.status 不含 done/failed
// ============================================================

describe("BgNotifyRecord.status", () => {
  it("合法值只有 running/closed（v4 B-1 两态收敛）", () => {
    // 编译期验证
    const valid: BgNotifyRecord["status"][] = ["running", "closed"];
    expect(valid).toHaveLength(2);
  });

  it("closed + closedReason 可构造", () => {
    const record: BgNotifyRecord = {
      id: "test",
      status: "closed",
      closedReason: "user-close",
      agent: "test-agent",
      result: "done",
      startedAt: Date.now(),
      endedAt: Date.now(),
    };
    expect(record.status).toBe("closed");
    expect(record.closedReason).toBe("user-close");
  });
});
