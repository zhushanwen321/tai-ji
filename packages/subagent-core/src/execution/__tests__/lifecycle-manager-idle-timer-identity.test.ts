// src/execution/__tests__/lifecycle-manager-idle-timer-identity.test.ts
//
// [LC-5/T6①] armIdleTimer 超时回调身份比对（按值守卫，对齐 session-runner
// removeChildRegistration 先例）。
//
// 覆盖（设计 §4.3 LC-5 + §11-2）：
//   1. 「旧 timer 已到期、回调迟到执行」与「同 recordId re-arm」精确交错 → 守卫不误删
//      新条目（旧代码此处误删 = 新 timer 脱管、disarm 失效 → turn 中途误杀）。
//   2. 无交错时旧 timer 到点删除自己的条目 + 后续 re-arm 正常（既有语义不回归）。
//   3. fake timers 下「re-arm 发生在旧 timer 到期回调处置中」的同轮交错端到端：
//      新 timer 存活、到点正常触发、Map 清理干净。
//
// 交错构造说明（§11-2 勘误锚点）：sinon fake clock 的同步 tick 模型在「时间推进」的
// 同一同步流程内立即执行到期回调，不存在「已到期、回调已入队、尚未执行」的中间态
// 暴露给 clearTimeout——纯 fake timers 无法表达 Node 真实窗口（fire 后回调入
// macrotask 队列，clearTimeout 不可撤销）。用例 1/2 以手动排程 fake（stub setTimeout
// 捕获回调、测试显式控制 fire 时机）精确复现该中间态；用例 3 补真实 clock 语义下的
// 同轮交错端到端回归。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetLifecycleState,
  armIdleTimer,
  disarmIdleTimer,
  hasIdleTimer,
} from "../lifecycle/lifecycle-manager.ts";

/** 手动排程 fake 捕获的到期回调（fire = 模拟 timer 到点，时机由用例显式控制）。 */
let scheduled: Array<{ fire: () => void; timer: object }>;

beforeEach(() => {
  _resetLifecycleState();
  scheduled = [];
  // 手动排程模型：setTimeout 只登记不排程；clearTimeout no-op（「已入队回调不可撤销」
  // 的真实语义由用例不 fire 被撤销者来表达）。
  vi.stubGlobal(
    "setTimeout",
    (cb: () => void, _delay?: number) => {
      void _delay;
      const timer: object = {};
      scheduled.push({ fire: cb, timer });
      return Object.assign(timer, { unref() {} });
    },
  );
  vi.stubGlobal("clearTimeout", (_t?: unknown) => {
    void _t;
  });
});

afterEach(() => {
  _resetLifecycleState();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("[LC-5] armIdleTimer 超时回调身份比对", () => {
  it("旧 timer 到点回调迟到执行（re-arm 已覆盖条目）→ 守卫不误删新条目，disarm 仍有效", () => {
    const onTimeoutA = vi.fn();
    const onTimeoutB = vi.fn();

    armIdleTimer("sa-x", onTimeoutA, 1000); // timerA 入手 排程表，Map: timerA
    // re-arm（agent_settled 刷新）：disarm 旧 timer（真实 Node 中 clearTimeout 对已
    // 入队回调无效）→ timerB 入表，Map: timerB。此后 timerA 的回调才迟到执行。
    armIdleTimer("sa-x", onTimeoutB, 1000);
    expect(hasIdleTimer("sa-x")).toBe(true);

    scheduled[0]?.fire(); // 旧 timerA 回调迟到执行

    expect(onTimeoutA).toHaveBeenCalledTimes(1); // 旧超时回调本身照常触发
    expect(hasIdleTimer("sa-x")).toBe(true); // [核心] 新条目未被误删（旧代码此处 false = 脱管）

    disarmIdleTimer("sa-x"); // B 未脱管：disarm 有效
    expect(hasIdleTimer("sa-x")).toBe(false);
    expect(onTimeoutB).not.toHaveBeenCalled();
  });

  it("无交错：旧 timer 到点删除自己的条目（守卫不改变既有语义），后续 re-arm 正常", () => {
    const onTimeoutA = vi.fn();
    const onTimeoutB = vi.fn();

    armIdleTimer("sa-y", onTimeoutA, 1000);
    expect(hasIdleTimer("sa-y")).toBe(true);

    scheduled[0]?.fire(); // 正常到点：Map 中是自己 → delete → 回调

    expect(onTimeoutA).toHaveBeenCalledTimes(1);
    expect(hasIdleTimer("sa-y")).toBe(false); // 旧条目删除正常（不残留失效 entry）

    armIdleTimer("sa-y", onTimeoutB, 1000); // 后续 re-arm 正常
    expect(hasIdleTimer("sa-y")).toBe(true);
    scheduled[1]?.fire();
    expect(onTimeoutB).toHaveBeenCalledTimes(1);
    expect(hasIdleTimer("sa-y")).toBe(false);
  });

  it("fake timers 同轮交错：re-arm 发生在旧 timer 到期回调处置中 → 新 timer 存活到点触发", () => {
    vi.useFakeTimers();
    const onTimeoutB = vi.fn();
    const onTimeoutA = vi.fn(() => {
      // 到期回调处置中同步 re-arm（同轮交错的 fake-timer 可达形态）
      armIdleTimer("sa-z", onTimeoutB, 1000);
    });

    armIdleTimer("sa-z", onTimeoutA, 1000);
    vi.advanceTimersByTime(1000); // A 到点：删自己 → onTimeoutA → re-arm B

    expect(onTimeoutA).toHaveBeenCalledTimes(1);
    expect(hasIdleTimer("sa-z")).toBe(true); // B armed，交错不丢 timer

    vi.advanceTimersByTime(999);
    expect(onTimeoutB).not.toHaveBeenCalled(); // B 从 arm 时刻重新计时
    vi.advanceTimersByTime(1);
    expect(onTimeoutB).toHaveBeenCalledTimes(1); // B 存活到点正常触发
    expect(hasIdleTimer("sa-z")).toBe(false); // 触发后 Map 清理干净
  });
});
