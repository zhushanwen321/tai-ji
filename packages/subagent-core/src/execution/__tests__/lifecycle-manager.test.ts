// lifecycle-manager 单测 —— V2 §5.2 模块 1 现存唯一职责（idle timer）。原职责 2/3/4
// 骨架未接线、职责 5 activate 互斥无生产调用方，已随简化清扫删除。
//
// [round5-g 合并产物] 吸收同被测模块（lifecycle-manager idle timer 域）姊妹件：
// - lifecycle-manager-idle-timer-identity.test.ts（armIdleTimer 回调身份比对）。
//   其顶层 setTimeout/clearTimeout 全局 stub hook 已下沉进自身 describe（防泄漏
//   摧毁其余节的 timer 语义）。
// - resource-policy.test.ts（idleTimeoutMs 三层优先级）。logger 桩与基座同款去重。
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
} from "../lifecycle/lifecycle-manager.ts";

describe("lifecycle-manager — V2 §5.2 模块 1", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetLifecycleState();
    loggerMock.debug.mockClear();
    loggerMock.warn.mockClear();
    loggerMock.error.mockClear();
    // [F-4 同源修复] env 隔离：「默认超时」用例依赖 TAIJI_SUBAGENT_IDLE_TIMEOUT_MS
    // 未设基线（getEnvIdleTimeoutMs 会覆盖 DEFAULT），宿主 export 即假红。空串 = 未设。
    vi.stubEnv("TAIJI_SUBAGENT_IDLE_TIMEOUT_MS", "");
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

    it("env TAIJI_SUBAGENT_IDLE_TIMEOUT_MS 溢出 → fail-fast throw（arm 入口统一拦截）", () => {
      vi.stubEnv("TAIJI_SUBAGENT_IDLE_TIMEOUT_MS", "3000000000");
      const onTimeout = vi.fn();
      expect(() => armIdleTimer("sa-env-overflow", onTimeout)).toThrowError(/2147483647/);
      expect(hasIdleTimer("sa-env-overflow")).toBe(false);
    });

    // [LC-7/T7①] env 非法值回落默认不再静默：warn 留痕（env 名 + 实际值 + 生效行为）。
    // 「以为设了极长保活、实际回落 5min」的语义漂移必须可诊断。
    it("[LC-7] env 非法值（'30m' 非纯数字）→ 回落 DEFAULT_IDLE_TIMEOUT_MS 且 warn 留痕", () => {
      vi.stubEnv("TAIJI_SUBAGENT_IDLE_TIMEOUT_MS", "30m");
      const onTimeout = vi.fn();
      armIdleTimer("sa-lc7-invalid", onTimeout); // 不传 timeoutMs → env（非法）→ DEFAULT

      // 生效行为 = 默认 5min（非法值没有按字面 '30m' 也不按禁用处理）
      vi.advanceTimersByTime(DEFAULT_IDLE_TIMEOUT_MS - 1);
      expect(onTimeout).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onTimeout).toHaveBeenCalledTimes(1);

      expect(loggerMock.warn).toHaveBeenCalledTimes(1);
      const msg = String(loggerMock.warn.mock.calls[0]?.[0] ?? "");
      expect(msg).toContain("TAIJI_SUBAGENT_IDLE_TIMEOUT_MS"); // env 变量名
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

// ══════ 来源: lifecycle-manager-idle-timer-identity.test.ts ══════

// src/execution/__tests__/lifecycle-manager-idle-timer-identity.test.ts
//
// [LC-5/T6①] armIdleTimer 超时回调身份比对（按值检查，对齐 session-runner
// removeChildRegistration 先例）。
//
// 覆盖（设计 §4.3 LC-5 + §11-2）：
//   1. 「旧 timer 已到期、回调迟到执行」与「同 recordId re-arm」精确交错 → 检查不误删
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



describe("[LC-5] armIdleTimer 超时回调身份比对", () => {

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
  it("旧 timer 到点回调迟到执行（re-arm 已覆盖条目）→ 检查不误删新条目，disarm 仍有效", () => {
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

  it("无交错：旧 timer 到点删除自己的条目（检查不改变既有语义），后续 re-arm 正常", () => {
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

// ══════ 来源: resource-policy.test.ts ══════

// resource-policy 单测 —— SP-6 资源策略配置化（idleTimeoutMs + env 覆盖）。
//
// 测试策略：
//   - 验证 armIdleTimer 的三层优先级：参数 > env TAIJI_SUBAGENT_IDLE_TIMEOUT_MS > 默认 300000ms。
//   - 用 vi.useFakeTimers() 控制时间流逝。
//   - 每个用例 beforeEach/afterEach 清理 env + reset lifecycle state。



// [teardown 竞态修复] 被测链（lifecycle-manager 非法 env 回落 warn）传递性 logger 输出经
// console 落 stderr——同步用例的刷写落在文件结束的 teardown 窗口，与 worker rpc 关闭
// 竞态 → vitest EnvironmentTeardownError（onUserConsoleLog pending）→ run 退出码 1。
// 本文件对 logger 零断言依赖，mock 静默（rebuild-indexes.test.ts 同款先例）。
describe("resource-policy — SP-6 idleTimeoutMs 配置化", () => {
  const ENV_KEY = "TAIJI_SUBAGENT_IDLE_TIMEOUT_MS";

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

  // TC-2: env TAIJI_SUBAGENT_IDLE_TIMEOUT_MS 覆盖默认值
  it("TC-2: env TAIJI_SUBAGENT_IDLE_TIMEOUT_MS 覆盖默认值（不传参数时）", () => {
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
