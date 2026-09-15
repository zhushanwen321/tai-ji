// src/shared/__tests__/timer-delay.test.ts
//
// assertSafeTimerDelay 纯函数契约——三个 timer 挂载入口（budgetTimeMs /
// TAIJI_SUBAGENT_SPAWN_WATCHDOG_MS / idleTimeoutMs）统一在值流入 setTimeout 前调
// 用本函数 fail-fast，契约由本文件锁定。
//
// [F-3 NaN 穿透修复] 旧实现只挡 `> MAX`：NaN 的 `NaN > MAX` 为 false 静默放行，
// setTimeout(fn, NaN) 被 Node 塌缩为 1ms 立即触发（watchdog 刚启动就误杀）。
// 非有限数（NaN/±Infinity）现在同样 fail-fast，且错误消息区分两种情况。
import { describe, expect, it } from "vitest";

import { MAX_TIMER_DELAY_MS, assertSafeTimerDelay } from "../timer-delay.ts";

describe("assertSafeTimerDelay", () => {
  it("安全域内的有限值放行（0 与上限值不抛）", () => {
    expect(() => assertSafeTimerDelay(0, "t")).not.toThrow();
    expect(() => assertSafeTimerDelay(1000, "t")).not.toThrow();
    expect(() => assertSafeTimerDelay(MAX_TIMER_DELAY_MS, "t")).not.toThrow();
  });

  it("[F-3] NaN → fail-fast throw（旧实现 NaN > MAX 为 false 静默放行）", () => {
    expect(() => assertSafeTimerDelay(Number.NaN, "budgetTimeMs")).toThrowError(/NaN/);
    expect(() => assertSafeTimerDelay(Number.NaN, "budgetTimeMs")).toThrowError(/not a finite number/);
  });

  it("[F-3] ±Infinity → fail-fast throw", () => {
    expect(() => assertSafeTimerDelay(Number.POSITIVE_INFINITY, "t")).toThrowError(/not a finite number/);
    expect(() => assertSafeTimerDelay(Number.NEGATIVE_INFINITY, "t")).toThrowError(/not a finite number/);
  });

  it("非有限值错误消息含来源标识与上游修复指引（非 clamp 指引）", () => {
    expect(() => assertSafeTimerDelay(Number.NaN, "idleTimeoutMs")).toThrowError(/idleTimeoutMs/);
    expect(() => assertSafeTimerDelay(Number.NaN, "idleTimeoutMs")).toThrowError(/fix the upstream computation/);
  });

  it("超出上限 → fail-fast throw，消息含上限值与 clamp 恢复指引（原语义不变）", () => {
    expect(() => assertSafeTimerDelay(MAX_TIMER_DELAY_MS + 1, "budgetTimeMs")).toThrowError(/2147483647/);
    expect(() => assertSafeTimerDelay(3_000_000_000, "budgetTimeMs")).toThrowError(/Recovery: clamp/);
  });

  it("两种错误可区分：非有限值消息不含 clamp 指引，溢出消息不含 upstream 指引", () => {
    const nonFiniteMsg = (() => {
      try {
        assertSafeTimerDelay(Number.NaN, "t");
        return "";
      } catch (err) {
        return (err as Error).message;
      }
    })();
    const overflowMsg = (() => {
      try {
        assertSafeTimerDelay(MAX_TIMER_DELAY_MS + 1, "t");
        return "";
      } catch (err) {
        return (err as Error).message;
      }
    })();
    expect(nonFiniteMsg).not.toContain("clamp");
    expect(overflowMsg).not.toContain("fix the upstream computation");
  });
});
