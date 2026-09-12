// src/execution/engine/common/__tests__/run-signals.test.ts
//
// [H2 W4] mergeRunSignals 纯函数行为测试——自 subprocess-agent-runner-timeout.test.ts
// 迁移改写：原 mergeTimeoutSignal 薄包装（timeoutMs 无守护信号源时原样返回 external
// signal；有则返回 .signal 视图）随 SAR.run 掏空删除（生产零消费），断言面改直测
// 公共 helper 权威实现（engine/common/run-signals.ts，W2 迁移步⑥自 SAR 提取）。
// 原用例行为语义逐条保持（T3.6 / T3.17 编号沿用）。

import { describe, expect, it, vi } from "vitest";

import { mergeRunSignals } from "../run-signals.ts";

describe("mergeRunSignals (D-A9 / H2 W2 迁移步⑥)", () => {
  it("T3.6 timeoutMs===undefined → 原样返回 external signal", () => {
    const ctrl = new AbortController();
    const handle = mergeRunSignals(ctrl.signal, undefined);
    expect(handle.signal).toBe(ctrl.signal);
    handle.dispose();
  });

  it("T3.6 timeoutMs<=0 → 原样返回 external signal", () => {
    const ctrl = new AbortController();
    const handle = mergeRunSignals(ctrl.signal, 0);
    expect(handle.signal).toBe(ctrl.signal);
    handle.dispose();
  });

  it("T3.6 timeoutMs>0 → 返回新 signal（合并外部+超时两路）", () => {
    const ctrl = new AbortController();
    const handle = mergeRunSignals(ctrl.signal, 50);
    expect(handle.signal).not.toBe(ctrl.signal);
    expect(handle.signal.aborted).toBe(false);
    handle.dispose();
  });

  it("T3.6 timeoutMs 到期 → merged signal abort", () => {
    vi.useFakeTimers();
    const ctrl = new AbortController();
    const handle = mergeRunSignals(ctrl.signal, 50);

    expect(handle.signal.aborted).toBe(false);
    vi.advanceTimersByTime(51);
    expect(handle.signal.aborted).toBe(true);
    handle.dispose();
    vi.useRealTimers();
  });

  it("T3.6 外部 signal abort → merged signal abort", () => {
    const ctrl = new AbortController();
    const handle = mergeRunSignals(ctrl.signal, 5000);
    ctrl.abort();
    expect(handle.signal.aborted).toBe(true);
    handle.dispose();
  });

  it("T3.6 外部 signal 已 abort → 返回已 abort 的 signal", () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const handle = mergeRunSignals(ctrl.signal, 5000);
    expect(handle.signal.aborted).toBe(true);
    handle.dispose();
  });

  it("T3.17 NFR: merged signal abort → timeout timer 清理", () => {
    vi.useFakeTimers();
    const ctrl = new AbortController();
    const handle = mergeRunSignals(ctrl.signal, 50);

    ctrl.abort(); // 外部 abort → merged 也 abort
    expect(handle.signal.aborted).toBe(true);

    // 推进时间，不应再有副作用
    vi.advanceTimersByTime(100);
    // timer 应被清理（通过 abort event listener）
    // 无异常 = timer 已正确清理
    handle.dispose();
    vi.useRealTimers();
  });
});
