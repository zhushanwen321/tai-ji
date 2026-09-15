// kill-chain.test.ts —— 杀链两分支 + 超时终态合成 + abort 两级编排（fake timers）。
//
// 实现体已收编 @zhushanwen/subagent-engine-sdk（common/kill-chain.ts 为 re-export
// shim，s4-reuse 簇 1）：SDK 侧 __tests__/kill-chain.test.ts 是超集演进版（+
// LoggerSink 捕获 + kill 抛错幂等用例），本文件保留 core 侧独有断言——engine: pi
// 重跑建议文案、stdout 尾部 2000 字截断、signalCode 形态退出、grace 贴边不升级。
// SDK 版 synthesizeTimeoutOutcome 的 engineId 必填（core 原缺省 "pi" 已删），用例显式传。
//
// 三视角：①构建者——SIGTERM 优雅 / 超时 SIGKILL 两分支的信号序列正确；②使用者——
// abortWithFallback 对 CLI-only 与 native-interrupt 引擎都收敛不悬挂；③观察者——
// 合成终态的 error 含 stdout 尾部与 exitCode=null（被信号杀死判据）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  abortWithFallback,
  killChain,
  synthesizeTimeoutOutcome,
} from "../../common/kill-chain.ts";
import type { KillableChild } from "../../common/kill-chain.ts";

/** fake 子进程：记录 kill 信号序列，emitExit 模拟退出（置退出态 + 触发 exit listener）。 */
function makeFakeChild(): {
  child: KillableChild;
  signals: string[];
  emitExit(code: number | null, signal: NodeJS.Signals | null): void;
} {
  const listeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const signals: string[] = [];
  const child: KillableChild = {
    exitCode: null,
    signalCode: null,
    kill(signal?: NodeJS.Signals | number): boolean {
      signals.push(String(signal ?? "SIGTERM"));
      return true;
    },
    once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): KillableChild {
      if (event === "exit") listeners.push(listener);
      return child;
    },
  };
  return {
    child,
    signals,
    emitExit(code, signal) {
      (child as { exitCode: number | null }).exitCode = code;
      (child as { signalCode: string | null }).signalCode = signal;
      for (const l of listeners.splice(0)) l(code, signal);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("killChain", () => {
  it("SIGTERM 后进程优雅退出 → 'terminated'，无 SIGKILL", async () => {
    const { child, signals, emitExit } = makeFakeChild();
    const p = killChain(child, { graceMs: 5_000 });
    emitExit(0, null); // SIGTERM 被 trap 后正常退出
    expect(await p).toBe("terminated");
    expect(signals).toEqual(["SIGTERM"]);
  });

  it("SIGTERM 超时未退 → SIGKILL 兜底 → 'killed'（fake timers 推进两级窗口）", async () => {
    const { child, signals } = makeFakeChild();
    const p = killChain(child, { graceMs: 5_000 });
    expect(signals).toEqual(["SIGTERM"]); // kill 同步发出
    await vi.advanceTimersByTimeAsync(5_000); // grace 窗口走完，进程仍活
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    await vi.advanceTimersByTimeAsync(10_000); // SIGKILL 收尸窗口（进程不退也返回）
    expect(await p).toBe("killed");
  });

  it("进程已退出（调用前）→ 不发任何信号，'terminated'", async () => {
    const { child, signals, emitExit } = makeFakeChild();
    emitExit(1, null);
    expect(await killChain(child, { graceMs: 5_000 })).toBe("terminated");
    expect(signals).toEqual([]);
  });

  it("grace 窗口内恰在超时前一毫秒退出 → 复核退出态，不误发 SIGKILL", async () => {
    const { child, signals, emitExit } = makeFakeChild();
    const p = killChain(child, { graceMs: 5_000 });
    emitExit(null, "SIGTERM"); // 被 SIGTERM 杀死（signalCode 形态）
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await p).toBe("terminated");
    expect(signals).toEqual(["SIGTERM"]);
  });
});

describe("killChain grace 参数化（D3-① 杀链合一：pi=30s / zcode=5s，现状语义逐字节保持）", () => {
  it("pi 参数形态（graceMs=30s + unrefTimers + escalationNote）：29s 未升级，越 30s 窗口 SIGKILL", async () => {
    const { child, signals } = makeFakeChild();
    const p = killChain(child, {
      graceMs: 30_000,
      unrefTimers: true,
      escalationNote: "child sa-x (source: spawn watchdog)",
    });
    expect(signals).toEqual(["SIGTERM"]); // SIGTERM 同步发出（信号序不变）
    await vi.advanceTimersByTimeAsync(29_000);
    expect(signals).toEqual(["SIGTERM"]); // 窗口内不升级（非贴边断言）
    await vi.advanceTimersByTimeAsync(1_100); // 越过 30s 优雅窗口
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]); // 升级 SIGKILL（race-F4 语义）
    await vi.advanceTimersByTimeAsync(10_000); // 有界收尸窗口
    expect(await p).toBe("killed");
  });

  it("escalationNote 缺省（zcode 现状形态）：graceMs=5s 越窗 SIGKILL，升级路径同构", async () => {
    const { child, signals } = makeFakeChild();
    const p = killChain(child, { graceMs: 5_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await p).toBe("killed");
  });
});

describe("synthesizeTimeoutOutcome", () => {
  it("合成 engine_timeout 终态：error 含 slug + stdout 尾部 + engine: pi 重跑建议；exitCode=null", () => {
    const outcome = synthesizeTimeoutOutcome(
      { prompt: "review files", description: "review-files" },
      "last stdout lines...",
      "pi",
    );
    expect(outcome.error!).toContain("engine_timeout");
    expect(outcome.error).toContain("review-files");
    expect(outcome.error).toContain("last stdout lines...");
    expect(outcome.error).toMatch(/`engine: pi`/);
    expect(outcome.exitCode).toBe(null);
    expect(outcome.content).toBe("");
    expect(outcome.engineId).toBe("pi");
  });

  it("stdout 尾部超 2000 字截断；engineId 可指定", () => {
    const outcome = synthesizeTimeoutOutcome(
      { prompt: "t", description: "s" },
      "y".repeat(3_000),
      "zcode",
    );
    expect(outcome.engineId).toBe("zcode");
    expect(outcome.error!).toContain("...");
    expect(outcome.error!.length).toBeLessThan(3_000);
  });
});

describe("abortWithFallback", () => {
  it("CLI-only 引擎（无原生中断）：abort → 直接杀链，SIGTERM 退 → 'terminated'", async () => {
    const { child, signals, emitExit } = makeFakeChild();
    const controller = new AbortController();
    const p = abortWithFallback(child, controller.signal);
    controller.abort();
    emitExit(0, null); // SIGTERM 生效
    expect(await p).toBe("terminated");
    expect(signals).toEqual(["SIGTERM"]);
  });

  it("原生中断生效：abort → native interrupt → 进程退出，不走杀链（零 kill 信号）", async () => {
    const { child, signals, emitExit } = makeFakeChild();
    const controller = new AbortController();
    const interrupt = vi.fn(async () => {
      emitExit(0, null); // 引擎原生中断让进程优雅退出
    });
    const p = abortWithFallback(child, controller.signal, interrupt);
    controller.abort();
    expect(await p).toBe("terminated");
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(signals).toEqual([]); // 从未发信号——原生中断足量
  });

  it("原生中断无效（进程未停）→ 宽限窗口后落杀链 SIGKILL → 'killed'", async () => {
    const { child, signals } = makeFakeChild();
    const controller = new AbortController();
    const interrupt = vi.fn(async () => undefined); // 中断送达但进程不退
    const p = abortWithFallback(child, controller.signal, interrupt, {
      nativeGraceMs: 3_000,
      graceMs: 5_000,
    });
    controller.abort();
    expect(interrupt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000); // native 宽限窗口走完
    expect(signals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(5_000); // 杀链 grace 窗口走完
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await p).toBe("killed");
  });

  it("原生中断 throw（协议错）→ 不阻断兜底，继续杀链", async () => {
    const { child, signals, emitExit } = makeFakeChild();
    const controller = new AbortController();
    const interrupt = vi.fn(async () => {
      throw new Error("rpc broken");
    });
    const p = abortWithFallback(child, controller.signal, interrupt, { nativeGraceMs: 100, graceMs: 5_000 });
    controller.abort();
    await vi.advanceTimersByTimeAsync(100);
    emitExit(0, null); // 后续 SIGTERM 生效
    expect(await p).toBe("terminated");
    expect(signals).toEqual(["SIGTERM"]);
  });

  it("进程自然退出（signal 从未 abort）→ 'terminated'，promise 不悬挂", async () => {
    const { child, signals, emitExit } = makeFakeChild();
    const controller = new AbortController();
    const p = abortWithFallback(child, controller.signal);
    emitExit(0, null);
    expect(await p).toBe("terminated");
    expect(signals).toEqual([]);
  });

  it("signal 已 abort 的场景（先 abort 后接线）→ 立即执行两级中断", async () => {
    const { child, signals, emitExit } = makeFakeChild();
    const controller = new AbortController();
    controller.abort(); // 先 abort
    const p = abortWithFallback(child, controller.signal);
    emitExit(0, null);
    expect(await p).toBe("terminated");
    expect(signals).toEqual(["SIGTERM"]);
  });
});
