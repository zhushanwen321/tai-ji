// src/__tests__/kill-chain.test.ts
//
// killChain（SIGTERM → grace → SIGKILL）与 abortWithFallback（abort 两级中断编排）
// 的行为面。child 用结构 fake——KillableChild 接口注释明示「测试可注入 fake
// （ChildProcess 全字段构造过重）」，退出态经 emitExit 手工推进，不 spawn 真实
// 进程、不碰引擎进程。timer 窗口（grace / nativeGrace / SIGKILL 收尸）用 fake
// timers 推进；日志经 LoggerSink 注入捕获（同时避免缺省 console 出口刷屏）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_NATIVE_INTERRUPT_GRACE_MS,
  abortWithFallback,
  killChain,
  synthesizeTimeoutOutcome,
  type KillableChild,
} from "../kill-chain.ts";
import { configureLoggerSink, resetLoggerSinkForTests, type LoggerSink } from "../logger.ts";

interface FakeChild extends KillableChild {
  /** 已收到的信号序列（断言杀链升级路径）。 */
  readonly signals: readonly NodeJS.Signals[];
  /** 手工推进退出态并触发 exit listeners（fake 进程的收尸入口，幂等）。 */
  emitExit(code: number | null, signal: NodeJS.Signals | null): void;
}

function fakeChild(
  opts: {
    exitCode?: number;
    signalCode?: string;
    /** kill() 行为注入（缺省只记录信号、进程不理会——退出靠 emitExit 手工推进）。 */
    kill?: (signal: NodeJS.Signals) => void;
  } = {},
): FakeChild {
  let exitCode: number | null = opts.exitCode ?? null;
  let signalCode: string | null = opts.signalCode ?? null;
  const listeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const signals: NodeJS.Signals[] = [];
  const child: FakeChild = {
    get exitCode() {
      return exitCode;
    },
    get signalCode() {
      return signalCode;
    },
    get signals() {
      return signals;
    },
    kill(signal?: NodeJS.Signals | number): boolean {
      signals.push(signal as NodeJS.Signals);
      opts.kill?.(signal as NodeJS.Signals);
      return true;
    },
    once(_event, listener) {
      listeners.push(listener);
      return listener;
    },
    emitExit(code, signal) {
      if (exitCode !== null || signalCode !== null) return;
      exitCode = code;
      signalCode = signal;
      for (const l of [...listeners]) l(code, signal);
    },
  };
  return child;
}

/** 注入日志捕获 sink（替代缺省 console 出口），返回留痕列表。 */
function captureSink(): Array<{ level: string; msg: string }> {
  const logs: Array<{ level: string; msg: string }> = [];
  const sink: LoggerSink = {
    log(level, _component, message) {
      logs.push({ level, msg: message });
    },
  };
  configureLoggerSink(sink);
  return logs;
}

/** SIGKILL 发出后的收尸等待上限（ms）——与 src/kill-chain.ts 私有常量同值（未导出，测试侧镜像）。 */
const SIGKILL_REAP_TIMEOUT_MS = 10_000;

/** 杀链快速窗口（ms）：fake timers 下用短 grace 缩短用例推进量。 */
const SHORT_GRACE_MS = 100;

describe("killChain（SIGTERM → grace → SIGKILL 杀链）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetLoggerSinkForTests();
  });

  it("进程已退出（exitCode 非 null）→ 不发任何信号，按优雅终止口径返回", async () => {
    const child = fakeChild({ exitCode: 0 });
    await expect(killChain(child, { graceMs: 1_000 })).resolves.toBe("terminated");
    expect(child.signals).toEqual([]);
  });

  it("SIGTERM 后 grace 窗口内退出 → 'terminated'，不升级 SIGKILL", async () => {
    const child = fakeChild({
      kill: (s) => {
        if (s === "SIGTERM") child.emitExit(0, null);
      },
    });
    await expect(killChain(child, { graceMs: 1_000 })).resolves.toBe("terminated");
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("grace 超时仍存活 → escalationNote warn 留痕并升级 SIGKILL，返回 'killed'；unrefTimers 透传", async () => {
    const logs = captureSink();
    const child = fakeChild(); // 忽略一切信号：SIGTERM/SIGKILL 后仍存活
    const done = killChain(child, {
      graceMs: DEFAULT_KILL_GRACE_MS,
      unrefTimers: true,
      escalationNote: "child sa-1 (source: test)",
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_KILL_GRACE_MS - 1);
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(logs.filter((l) => l.level === "warn")).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(logs.filter((l) => l.level === "warn")[0]?.msg).toBe(
      "[kill-chain] child sa-1 (source: test) still alive 5s after SIGTERM, escalating to SIGKILL",
    );

    // SIGKILL 收尸窗口走满仍有界返回
    await vi.advanceTimersByTimeAsync(SIGKILL_REAP_TIMEOUT_MS);
    await expect(done).resolves.toBe("killed");
  });

  it("grace 超时未传 escalationNote → 升级静默（无 warn），仍返回 'killed'", async () => {
    const logs = captureSink();
    const child = fakeChild();
    const done = killChain(child, { graceMs: SHORT_GRACE_MS });
    // 一次推进覆盖 grace 窗口 + SIGKILL 收尸窗口全程
    await vi.advanceTimersByTimeAsync(SHORT_GRACE_MS + SIGKILL_REAP_TIMEOUT_MS);
    await expect(done).resolves.toBe("killed");
    expect(logs.filter((l) => l.level === "warn")).toEqual([]);
  });

  it("kill 抛错（进程恰在发信号前自退）→ 幂等吞掉 + debug 留痕，杀链语义不阻断", async () => {
    const logs = captureSink();
    const child = fakeChild({
      kill: () => {
        throw new Error("simulated kill race: process already reaped");
      },
    });
    const done = killChain(child, { graceMs: 1_000 });
    // 发信号瞬间进程自退：exit 事件仍会到达（waitForExit 已挂 listener）
    child.emitExit(0, null);
    await expect(done).resolves.toBe("terminated");
    const debug = logs.filter((l) => l.level === "debug");
    expect(debug).toHaveLength(1);
    expect(debug[0]?.msg).toContain("SIGTERM on exited process");
    expect(debug[0]?.msg).toContain("simulated kill race: process already reaped");
  });

  it("synthesizeTimeoutOutcome：description 缺省 → slug=unknown（错误信息自包含定位）", () => {
    const outcome = synthesizeTimeoutOutcome({ prompt: "p" }, "tail", "pi");
    expect(outcome.error).toContain("slug=unknown");
    expect(outcome.error).toContain("tail");
    expect(outcome.engineId).toBe("pi");
  });
});

describe("abortWithFallback（abort 两级中断编排）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetLoggerSinkForTests();
  });

  it("进程已退出 → 立即以 'terminated' settle，无信号", async () => {
    const child = fakeChild({ exitCode: 0 });
    await expect(abortWithFallback(child, new AbortController().signal)).resolves.toBe(
      "terminated",
    );
    expect(child.signals).toEqual([]);
  });

  it("signal 已 aborted + 无原生中断（CLI-only 引擎）→ 直接落杀链", async () => {
    const child = fakeChild({
      kill: (s) => {
        if (s === "SIGTERM") child.emitExit(0, null);
      },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(abortWithFallback(child, controller.signal)).resolves.toBe("terminated");
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("abort → 原生中断在宽限窗口内生效 → 不落杀链（零信号）", async () => {
    const child = fakeChild();
    const controller = new AbortController();
    const done = abortWithFallback(child, controller.signal, async () => {
      child.emitExit(0, null);
    });
    controller.abort();
    await expect(done).resolves.toBe("terminated");
    expect(child.signals).toEqual([]);
  });

  it("原生中断抛错 → debug 留痕并直接落杀链兜底（中断失败不阻断）", async () => {
    const logs = captureSink();
    const child = fakeChild({
      kill: (s) => {
        if (s === "SIGTERM") child.emitExit(0, null);
      },
    });
    const controller = new AbortController();
    const done = abortWithFallback(child, controller.signal, async () => {
      throw new Error("protocol pipe broken");
    });
    controller.abort();
    // 中断 reject 后仍先等原生宽限窗口（raceTimeout）走满才落杀链
    await vi.advanceTimersByTimeAsync(DEFAULT_NATIVE_INTERRUPT_GRACE_MS);
    await expect(done).resolves.toBe("terminated");
    expect(logs.filter((l) => l.level === "debug")[0]?.msg).toContain("native interrupt failed");
    expect(logs.filter((l) => l.level === "debug")[0]?.msg).toContain("protocol pipe broken");
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("原生中断未在宽限窗口内停 → 杀链兜底（缺省 nativeGraceMs）", async () => {
    const child = fakeChild({
      kill: (s) => {
        if (s === "SIGTERM") child.emitExit(0, null);
      },
    });
    const controller = new AbortController();
    const done = abortWithFallback(child, controller.signal, async () => {
      // 引擎收到中断但迟迟不停：宽限窗口走满 → 杀链
    });
    controller.abort();
    await vi.advanceTimersByTimeAsync(DEFAULT_NATIVE_INTERRUPT_GRACE_MS);
    await expect(done).resolves.toBe("terminated");
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("signal 永不 abort、进程自然退出 → 以 'terminated' settle（exit listener 路径，不悬挂）", async () => {
    const child = fakeChild();
    const done = abortWithFallback(child, new AbortController().signal);
    child.emitExit(0, null);
    await expect(done).resolves.toBe("terminated");
    expect(child.signals).toEqual([]);
  });
});
