// resource-policy 单测 —— SP-6 资源策略配置化（idleTimeoutMs + env 覆盖）。
//
// 测试策略：
//   - 验证 armIdleTimer 的三层优先级：参数 > env XYZ_SUBAGENT_IDLE_TIMEOUT_MS > 默认 300000ms。
//   - 用 vi.useFakeTimers() 控制时间流逝。
//   - 每个用例 beforeEach/afterEach 清理 env + reset lifecycle state。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_IDLE_TIMEOUT_MS,
  _resetLifecycleState,
  armIdleTimer,
  hasIdleTimer,
} from "../lifecycle/lifecycle-manager.ts";

describe("resource-policy — SP-6 idleTimeoutMs 配置化", () => {
  const ENV_KEY = "XYZ_SUBAGENT_IDLE_TIMEOUT_MS";

  beforeEach(() => {
    vi.useFakeTimers();
    _resetLifecycleState();
    // 清理 env，确保用例间隔离。
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    _resetLifecycleState();
    vi.useRealTimers();
    delete process.env[ENV_KEY];
  });

  // TC-1: idleTimeoutMs 参数透传生效
  it("TC-1: explicit timeoutMs 参数直接生效（不看 env）", () => {
    const onTimeout = vi.fn();
    armIdleTimer("sa-tc1", onTimeout, 1234);

    expect(hasIdleTimer("sa-tc1")).toBe(true);

    // 差 1ms 不触发
    vi.advanceTimersByTime(1233);
    expect(onTimeout).not.toHaveBeenCalled();

    // 到点触发
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  // TC-2: env XYZ_SUBAGENT_IDLE_TIMEOUT_MS 覆盖默认值
  it("TC-2: env XYZ_SUBAGENT_IDLE_TIMEOUT_MS 覆盖默认值（不传参数时）", () => {
    process.env[ENV_KEY] = "5000"; // 5 秒

    const onTimeout = vi.fn();
    armIdleTimer("sa-tc2", onTimeout); // 不传 timeoutMs

    // 4.9s 不触发
    vi.advanceTimersByTime(4999);
    expect(onTimeout).not.toHaveBeenCalled();

    // 5s 触发（env 值，不是默认 300s）
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  // TC-3: 参数优先于 env
  it("TC-3: explicit timeoutMs 参数优先于 env", () => {
    process.env[ENV_KEY] = "99999"; // env 设大值

    const onTimeout = vi.fn();
    armIdleTimer("sa-tc3", onTimeout, 2000); // 参数设小值

    // 2s 触发（参数优先，不等 env 的 99s）
    vi.advanceTimersByTime(1999);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  // TC-4: 都不设时默认 5min (300000ms)
  it("TC-4: 无参数无 env 时默认 300000ms (5min)", () => {
    const onTimeout = vi.fn();
    armIdleTimer("sa-tc4", onTimeout); // 不传 timeoutMs，env 也未设

    // 差 1ms 不触发
    vi.advanceTimersByTime(DEFAULT_IDLE_TIMEOUT_MS - 1);
    expect(onTimeout).not.toHaveBeenCalled();

    // 到点触发
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  // TC-5 (额外): env 非法值回落默认
  it("TC-5: env 非法值（负数/非数字）回落默认 300000ms", () => {
    process.env[ENV_KEY] = "not-a-number";

    const onTimeout = vi.fn();
    armIdleTimer("sa-tc5", onTimeout); // 不传 timeoutMs

    // 非法 env → 回落默认 300s。299s 不触发。
    vi.advanceTimersByTime(DEFAULT_IDLE_TIMEOUT_MS - 1);
    expect(onTimeout).not.toHaveBeenCalled();

    // 到点触发
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledOnce();
  });
});
