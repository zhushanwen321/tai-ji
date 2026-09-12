// lifecycle-manager 单测 —— V2 §5.2 模块 1 现存唯一职责（idle timer）。原职责 2/3/4
// 骨架未接线、职责 5 activate 互斥无生产调用方，已随简化清扫删除。
//
// 测试策略：
//   - idle timer 用 vi.useFakeTimers() + advanceTimersByTime。
//   - 每个用例 beforeEach 调 _resetLifecycleState() 隔离模块级单例状态。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// [LC-7/T7①] Mock 共享 logger：env 非法值回落默认的 warn 留痕可被断言
//（对齐 channel-registry-handshake.test.ts 模式；vi.mock 自动 hoist 到 import 前）。
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({
  getLogger: () => loggerMock,
}));

import {
  DEFAULT_IDLE_TIMEOUT_MS,
  _resetLifecycleState,
  armIdleTimer,
  disarmIdleTimer,
  hasIdleTimer,
} from "../lifecycle-manager.ts";

describe("lifecycle-manager — V2 §5.2 模块 1", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetLifecycleState();
    loggerMock.debug.mockClear();
    loggerMock.warn.mockClear();
    loggerMock.error.mockClear();
    // [F-4 同源修复] env 隔离：「默认超时」用例依赖 XYZ_SUBAGENT_IDLE_TIMEOUT_MS
    // 未设基线（getEnvIdleTimeoutMs 会覆盖 DEFAULT），宿主 export 即假红。空串 = 未设。
    vi.stubEnv("XYZ_SUBAGENT_IDLE_TIMEOUT_MS", "");
  });

  afterEach(() => {
    _resetLifecycleState();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  // ============================================================
  // 职责 1：idle timer
  // ============================================================
  describe("职责1 idle timer", () => {
    it("arm 后到 timeoutMs 触发 onTimeout（边界：差 1ms 不触发）", () => {
      const onTimeout = vi.fn();
      armIdleTimer("sa-1", onTimeout, 1000);

      expect(hasIdleTimer("sa-1")).toBe(true);
      vi.advanceTimersByTime(999);
      expect(onTimeout).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(onTimeout).toHaveBeenCalledTimes(1);
      // 触发后自动从 Map 移除（不残留失效 entry）
      expect(hasIdleTimer("sa-1")).toBe(false);
    });

    it("disarm 后不再触发 onTimeout", () => {
      const onTimeout = vi.fn();
      armIdleTimer("sa-1", onTimeout, 1000);
      disarmIdleTimer("sa-1");

      expect(hasIdleTimer("sa-1")).toBe(false);
      vi.advanceTimersByTime(5000);
      expect(onTimeout).not.toHaveBeenCalled();
    });

    it("disarm 不存在的 record 为 no-op（不抛错）", () => {
      expect(() => disarmIdleTimer("never-armed")).not.toThrow();
    });

    it("重复 arm 刷新 timer：旧 timer 作废、重新计时", () => {
      const onTimeout = vi.fn();
      armIdleTimer("sa-1", onTimeout, 1000);
      vi.advanceTimersByTime(500); // 过了 500ms

      armIdleTimer("sa-1", onTimeout, 1000); // 刷新：重新计 1000ms
      vi.advanceTimersByTime(999);
      expect(onTimeout).not.toHaveBeenCalled(); // 旧 timer 已作废，新的还没到

      vi.advanceTimersByTime(1);
      expect(onTimeout).toHaveBeenCalledTimes(1);
    });

    it("默认超时 = DEFAULT_IDLE_TIMEOUT_MS", () => {
      const onTimeout = vi.fn();
      armIdleTimer("sa-1", onTimeout); // 不传 timeoutMs

      vi.advanceTimersByTime(DEFAULT_IDLE_TIMEOUT_MS - 1);
      expect(onTimeout).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(onTimeout).toHaveBeenCalledTimes(1);
    });

    it("显式禁用值（0/负数）→ 不挂 timer（预算语义对齐：idle GC 可显式关闭；旧实现 0 落成 setTimeout(0) 立即 kill）", () => {
      const onTimeout = vi.fn();
      armIdleTimer("sa-disable-0", onTimeout, 0);
      expect(hasIdleTimer("sa-disable-0")).toBe(false);
      armIdleTimer("sa-disable-neg", onTimeout, -1);
      expect(hasIdleTimer("sa-disable-neg")).toBe(false);

      vi.advanceTimersByTime(DEFAULT_IDLE_TIMEOUT_MS * 2);
      expect(onTimeout).not.toHaveBeenCalled();
    });

    it("显式禁用值顺带 disarm 已有 armed timer（禁用不形同虚设）", () => {
      const onTimeout = vi.fn();
      armIdleTimer("sa-disable-late", onTimeout, 1000);
      expect(hasIdleTimer("sa-disable-late")).toBe(true);
      armIdleTimer("sa-disable-late", onTimeout, 0);
      expect(hasIdleTimer("sa-disable-late")).toBe(false);
      vi.advanceTimersByTime(2000);
      expect(onTimeout).not.toHaveBeenCalled();
    });

    // [U1] setTimeout 2^31-1 溢出 fail-fast：溢出 delay 被 Node 置 1ms 立即触发
    //（「长空闲保活」变「立即 kill」），arm 入口拦截且错误含上限值与恢复指引。
    // 显式禁用通道（<=0）不受影响（上方用例已锁）。
    it("idleTimeoutMs 溢出（>2^31-1）→ fail-fast throw，不挂 timer", () => {
      const onTimeout = vi.fn();
      expect(() => armIdleTimer("sa-overflow", onTimeout, 3_000_000_000)).toThrowError(/2147483647/);
      expect(() => armIdleTimer("sa-overflow", onTimeout, Number.MAX_SAFE_INTEGER)).toThrowError(
        /Recovery/,
      );
      expect(hasIdleTimer("sa-overflow")).toBe(false);
      vi.advanceTimersByTime(3_000_000_000);
      expect(onTimeout).not.toHaveBeenCalled();
    });

    it("env XYZ_SUBAGENT_IDLE_TIMEOUT_MS 溢出 → fail-fast throw（arm 入口统一拦截）", () => {
      vi.stubEnv("XYZ_SUBAGENT_IDLE_TIMEOUT_MS", "3000000000");
      const onTimeout = vi.fn();
      expect(() => armIdleTimer("sa-env-overflow", onTimeout)).toThrowError(/2147483647/);
      expect(hasIdleTimer("sa-env-overflow")).toBe(false);
    });

    // [LC-7/T7①] env 非法值回落默认不再静默：warn 留痕（env 名 + 实际值 + 生效行为）。
    // 「以为设了极长保活、实际回落 5min」的语义漂移必须可诊断。
    it("[LC-7] env 非法值（'30m' 非纯数字）→ 回落 DEFAULT_IDLE_TIMEOUT_MS 且 warn 留痕", () => {
      vi.stubEnv("XYZ_SUBAGENT_IDLE_TIMEOUT_MS", "30m");
      const onTimeout = vi.fn();
      armIdleTimer("sa-lc7-invalid", onTimeout); // 不传 timeoutMs → env（非法）→ DEFAULT

      // 生效行为 = 默认 5min（非法值没有按字面 '30m' 也不按禁用处理）
      vi.advanceTimersByTime(DEFAULT_IDLE_TIMEOUT_MS - 1);
      expect(onTimeout).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onTimeout).toHaveBeenCalledTimes(1);

      expect(loggerMock.warn).toHaveBeenCalledTimes(1);
      const msg = String(loggerMock.warn.mock.calls[0]?.[0] ?? "");
      expect(msg).toContain("XYZ_SUBAGENT_IDLE_TIMEOUT_MS"); // env 变量名
      expect(msg).toContain("30m"); // 实际值
      expect(msg).toContain("DEFAULT_IDLE_TIMEOUT_MS"); // 生效行为：回落默认
    });

    it("[LC-7] env 未设（空串基线）→ 静默走 DEFAULT，零 warn（未配置不是异常）", () => {
      const onTimeout = vi.fn();
      armIdleTimer("sa-lc7-clean", onTimeout);
      expect(hasIdleTimer("sa-lc7-clean")).toBe(true);
      expect(loggerMock.warn).not.toHaveBeenCalled();
    });
  });

});
