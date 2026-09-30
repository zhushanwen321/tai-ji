// src/execution/__tests__/session-baselines-pi-generation.test.ts
//
// [§1.4 (a)] pi 绑定代际机制单测（登记 docs/todo/subagent-workflow-issues.md §1.4 修复 (a)）：
//   1. initSession 注入递增代际、pi getter 返回句柄、readAssertState 携带代际；
//   2. invalidatePiBinding 作废后旧句柄消费返回 null（代际不符 = pi 不在场）+
//      RecordStore 快照同步清空 + 重复作废幂等；
//   3. 再次 initSession 新代际句柄恢复（等待者被唤醒）；
//   4. waitForUsablePi 三形态：可用立即返回 / 作废后等到新代际注入（有界等待完成写）
//      / 超时降级 null + warn 留痕；从未注入立即返回（无等待）；
//   5. assertReady 对作废态给出可操作错误（区分「从未注入」）。
// 本文件直构 SessionBaselines（deps 形态 = 壳装配闭包的同构 fake）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

import {
  SessionBaselines,
  type SessionBaselinesDeps,
  type SubagentServiceSessionInit,
} from "../service/session-baselines.ts";
import { makePi, type PiMock } from "./helpers/pi-mock.ts";

/** 壳装配同构的 deps fake：readAssertState 经 baselines 自身读面组装（生产 = 壳闭包
 *  `() => ({pi: this.pi, disposed, piGeneration})` 的镜像），store/回调全 spy。 */
function makeBaselines(): {
  baselines: SessionBaselines;
  deps: SessionBaselinesDeps;
  store: { setPi: ReturnType<typeof vi.fn>; revive: ReturnType<typeof vi.fn> };
} {
  let disposed = false;
  let baselinesRef: SessionBaselines | undefined;
  const store = { setPi: vi.fn(), revive: vi.fn() };
  const deps: SessionBaselinesDeps = {
    // 生产形态镜像：pi 走代际校验后的 getter（作废 → null）。
    readAssertState: () => ({
      pi: baselinesRef?.pi ?? null,
      disposed,
      piGeneration: baselinesRef?.piGeneration ?? 0,
    }),
    reviveDisposed: () => {
      disposed = false;
    },
    getStore: () => store,
    getNotifyHost: () => ({ revive: vi.fn() }),
    recoverOrphans: vi.fn(),
    runPendingReconcileSweep: vi.fn(),
  };
  const baselines = new SessionBaselines({ cwd: "/tmp/baselines-gen" }, deps);
  baselinesRef = baselines;
  return { baselines, deps, store };
}

function initOf(pi: PiMock): SubagentServiceSessionInit {
  return { pi, sessionId: "sess-gen" };
}

beforeEach(() => {
  loggerMock.debug.mockClear();
  loggerMock.warn.mockClear();
  loggerMock.error.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("SessionBaselines pi 绑定代际（[§1.4 (a)]）", () => {
  it("initSession 注入递增代际；getter 返回句柄；readAssertState 携带当前代际", () => {
    const { baselines } = makeBaselines();
    const pi1 = makePi();
    expect(baselines.piGeneration).toBe(0);
    baselines.initSession(initOf(pi1));
    expect(baselines.piGeneration).toBe(1);
    expect(baselines.pi).toBe(pi1);
    expect(() => baselines.assertReady()).not.toThrow();

    const pi2 = makePi();
    baselines.initSession(initOf(pi2));
    expect(baselines.piGeneration).toBe(2);
    expect(baselines.pi).toBe(pi2);
  });

  it("作废后旧句柄消费返回 null + store 快照清空；重复作废幂等", () => {
    const { baselines, store } = makeBaselines();
    const pi1 = makePi();
    baselines.initSession(initOf(pi1));
    expect(store.setPi).toHaveBeenLastCalledWith(pi1);

    baselines.invalidatePiBinding("test invalidation");

    // 代际不变（只在注入时递增），但句柄消费降级 null（旧代际不可用）。
    expect(baselines.piGeneration).toBe(1);
    expect(baselines.pi).toBeNull();
    // RecordStore 的句柄快照同步清空（7 处条目写点同规则降级）。
    expect(store.setPi).toHaveBeenLastCalledWith(null);

    // 幂等：重复作废不重复留痕、不重复写 store。
    store.setPi.mockClear();
    loggerMock.debug.mockClear();
    baselines.invalidatePiBinding("test invalidation again");
    expect(store.setPi).not.toHaveBeenCalled();
    expect(loggerMock.debug).not.toHaveBeenCalled();
    expect(baselines.pi).toBeNull();
  });

  it("作废后重新 initSession：代际 +1、句柄恢复为新代际、store 重新注入", () => {
    const { baselines, store } = makeBaselines();
    const pi1 = makePi();
    baselines.initSession(initOf(pi1));
    baselines.invalidatePiBinding("reload window");
    const pi2 = makePi();
    baselines.initSession(initOf(pi2));
    expect(baselines.piGeneration).toBe(2);
    expect(baselines.pi).toBe(pi2);
    expect(store.setPi).toHaveBeenLastCalledWith(pi2);
  });

  it("waitForUsablePi：可用 → 立即返回句柄（零等待）；从未注入 → 立即 null（无等待）", async () => {
    const { baselines } = makeBaselines();
    // 从未注入：没有「新代际注入」可等——立即降级（headless/纯内存测试形态零开销）。
    await expect(baselines.waitForUsablePi(50, "never-injected")).resolves.toBeNull();

    const pi = makePi();
    baselines.initSession(initOf(pi));
    await expect(baselines.waitForUsablePi(50, "usable")).resolves.toBe(pi);
  });

  it("waitForUsablePi：作废窗内等待 → initSession 注入新代际即唤醒并返回新句柄（有界等待完成写）", async () => {
    const { baselines } = makeBaselines();
    const pi1 = makePi();
    baselines.initSession(initOf(pi1));
    baselines.invalidatePiBinding("reload window");

    const pending = baselines.waitForUsablePi(2_000, "round final (record=sa-1)");
    // 注入前未 settle（等待者已登记，仅 initSession 注入唤醒）。
    let settled: unknown = "pending";
    void pending.then((v) => {
      settled = v;
    });
    await Promise.resolve();
    expect(settled).toBe("pending");

    const pi2 = makePi();
    baselines.initSession(initOf(pi2));
    await expect(pending).resolves.toBe(pi2);
  });

  it("waitForUsablePi：超时降级 null + warn 留痕含恢复指引（fake timers）", async () => {
    vi.useFakeTimers();
    const { baselines } = makeBaselines();
    const pi1 = makePi();
    baselines.initSession(initOf(pi1));
    baselines.invalidatePiBinding("reload window");

    const pending = baselines.waitForUsablePi(100, "round final (record=sa-2)");
    vi.advanceTimersByTime(101);
    await expect(pending).resolves.toBeNull();
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    const warnArg = String(loggerMock.warn.mock.calls[0]?.[0]);
    expect(warnArg).toContain("pi re-bind wait timed out after 100ms");
    expect(warnArg).toContain("round final (record=sa-2)");
    expect(warnArg).toContain("recovery: none required");
  });

  it("assertReady：作废态给出可操作错误（区分「从未注入」）", () => {
    const { baselines } = makeBaselines();
    // 从未注入：原语义保持。
    expect(() => baselines.assertReady()).toThrowError("pi not injected (initSession not called?)");

    const pi = makePi();
    baselines.initSession(initOf(pi));
    baselines.invalidatePiBinding("session replacement");
    const err = (() => {
      try {
        baselines.assertReady();
        return undefined;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain("pi binding invalidated (session replacement in progress after generation 1)");
    expect(err?.message).toContain("Recovery: retry after the replacement completes");
  });
});
