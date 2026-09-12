// HostBridge 契约 + core 实现 单测（W6；[H1 U6] takeChatRound 交接面用例随 chat 域
// 退役删除）。覆盖：方法委托行为、getRecordForAction 异常 → null、cancel 的 void 包装、
// armIdleTimer/disarmIdleTimer 对 lifecycle-manager 的
// 接线（含超时回调 onIdleTimeout 触发，fake timers）。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  createHostBridge,
  type HostBridge,
  type HostBridgeServiceFace,
} from "../host-bridge.ts";
import {
  _resetLifecycleState,
  hasIdleTimer,
} from "../../../lifecycle-manager.ts";
import type { ExecutionRecord, SubagentRecord } from "../../../types.ts";

/** 最小 record fake（HostBridge 只透传，不读字段）。 */
function fakeRecord(id: string): ExecutionRecord {
  return { id } as ExecutionRecord;
}

/** 服务面 fake：全部方法 vi.fn，逐方法断言委托。 */
function makeService(): HostBridgeServiceFace & {
  spies: Record<string, ReturnType<typeof vi.fn>>;
} {
  const spies = {
    executeAndAwait: vi.fn(async () => ({ content: "ok" })),
    getRecordForAction: vi.fn((id: string) => fakeRecord(id)),
    closeSubagent: vi.fn(async () => {}),
    cancel: vi.fn(() => true),
    collectRecords: vi.fn((): SubagentRecord[] => [{ id: "r1" } as SubagentRecord]),
    reportRecordTransition: vi.fn(() => {}),
  };
  return {
    spies,
    executeAndAwait: spies.executeAndAwait as HostBridgeServiceFace["executeAndAwait"],
    getRecordForAction: spies.getRecordForAction,
    closeSubagent: spies.closeSubagent,
    cancel: spies.cancel,
    collectRecords: spies.collectRecords,
    reportRecordTransition: spies.reportRecordTransition,
  };
}

describe("HostBridge（W6，设计 §3.8 最小示例 9 方法）", () => {
  let service: ReturnType<typeof makeService>;
  let onIdleTimeout: (recordId: string) => void;
  let bridge: HostBridge;

  beforeEach(() => {
    _resetLifecycleState();
    service = makeService();
    onIdleTimeout = vi.fn();
    bridge = createHostBridge({ service, onIdleTimeout });
  });

  afterEach(() => {
    _resetLifecycleState();
  });

  it("executeAndAwait 委托服务面（opts/signal/onEvent/stream 四参透传）", async () => {
    const opts = { task: "t" } as Parameters<HostBridge["executeAndAwait"]>[0];
    const signal = new AbortController().signal;
    const onEvent = () => {};
    const result = await bridge.executeAndAwait(opts, signal, onEvent);
    expect(result).toEqual({ content: "ok" });
    expect(service.spies.executeAndAwait).toHaveBeenCalledWith(opts, signal, onEvent, undefined);
  });

  it("getRecordForAction：存在 → 返回 record；throw → null（resolveRecord 语义内聚）", () => {
    expect(bridge.getRecordForAction("r1")?.id).toBe("r1");
    (service.spies.getRecordForAction as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("not found");
    });
    expect(bridge.getRecordForAction("missing")).toBeNull();
  });

  it("collectRecords 委托（limit/filter 透传）", () => {
    expect(bridge.collectRecords(10, "all")).toEqual([{ id: "r1" }]);
    expect(service.spies.collectRecords).toHaveBeenCalledWith(10, "all");
  });

  it("closeSubagent 委托（record/force 透传，Promise 语义保持）", async () => {
    const record = fakeRecord("r1");
    await bridge.closeSubagent(record, true);
    expect(service.spies.closeSubagent).toHaveBeenCalledWith(record, true);
  });

  it("cancel：服务面 boolean → 契约 void（resolve 语义归引擎侧判 notResumable）", async () => {
    await expect(bridge.cancel("r1")).resolves.toBeUndefined();
    expect(service.spies.cancel).toHaveBeenCalledWith("r1");
  });

  it("reportRecordTransition 委托（record 整体上报，无 patch 形态——见契约头注释）", () => {
    const record = fakeRecord("r1");
    bridge.reportRecordTransition(record);
    expect(service.spies.reportRecordTransition).toHaveBeenCalledWith(record);
  });

  it("armIdleTimer/disarmIdleTimer 接线 lifecycle-manager（D2 表：idle 定时器归 HostBridge）", () => {
    expect(hasIdleTimer("r1")).toBe(false);
    bridge.armIdleTimer("r1", 60_000);
    expect(hasIdleTimer("r1")).toBe(true);
    bridge.disarmIdleTimer("r1");
    expect(hasIdleTimer("r1")).toBe(false);
  });

  it("idle timer 超时触发 onIdleTimeout（宿主杀链注入点）", () => {
    vi.useFakeTimers();
    try {
      bridge.armIdleTimer("r1", 1_000);
      vi.advanceTimersByTime(1_000);
      expect(onIdleTimeout).toHaveBeenCalledWith("r1");
    } finally {
      vi.useRealTimers();
    }
  });
});
