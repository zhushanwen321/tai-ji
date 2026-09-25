// src/__tests__/workflow-stall-watchdog.test.ts
//
// stall watchdog 模块直测（D6-2 拆出后）：直接 createStallWatchdog 注入 fake
// deps——零 mock 兄弟模块、零 fs（readLastProgress 注入 fake），覆盖判定/恰一次
// /回退/防御/围栏/arm 幂等/dispose。装配接线（sessionState 投影 + 真实 journal
// IO + notifyStall 发送）由 workflow-stall-notify.test.ts 经装配面守护——两层
// 测试面：模块行为在此，接线正确在彼。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createStallWatchdog,
  type StallRunView,
  type StallWatchdogDeps,
} from "../workflow-stall-watchdog.ts";

const THRESHOLD_MS = 20 * 60_000;
const TICK_MS = 60_000;

function makeView(overrides: Partial<StallRunView> = {}): StallRunView {
  return {
    runId: "wf-direct",
    scriptName: "deploy",
    startedAtMs: Date.now(),
    journalPath: "/tmp/none/wf-direct.events.jsonl",
    ...overrides,
  };
}

function makeDeps(views: StallRunView[], lastProgress: number | undefined) {
  const notifyStalled = vi.fn();
  const onTickError = vi.fn();
  const deps: StallWatchdogDeps = {
    getRunningRuns: () => views,
    readLastProgress: () => lastProgress,
    notifyStalled,
    onTickError,
    thresholdMs: THRESHOLD_MS,
  };
  return { deps, notifyStalled, onTickError };
}

describe("workflow stall watchdog（模块直测）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("超阈值：通知一次，二次 tick 零重发（恰一次）", () => {
    const view = makeView();
    const stalledTs = Date.now() - (THRESHOLD_MS + 5 * 60_000);
    const { deps, notifyStalled } = makeDeps([view], stalledTs);
    const watchdog = createStallWatchdog(deps);
    watchdog.arm();

    vi.advanceTimersByTime(TICK_MS);
    expect(notifyStalled).toHaveBeenCalledTimes(1);
    // stalledMs = tick 时刻(now=构造时刻+TICK) - 进展时间戳
    expect(notifyStalled).toHaveBeenCalledWith(view, THRESHOLD_MS + 5 * 60_000 + TICK_MS, stalledTs);
    expect(watchdog.hasNotified(view.runId)).toBe(true);

    vi.advanceTimersByTime(TICK_MS);
    expect(notifyStalled).toHaveBeenCalledTimes(1);
    watchdog.dispose();
  });

  it("恰一次标记先于发送落下（notifyStalled 回调内可见）", () => {
    const view = makeView();
    const { deps, notifyStalled } = makeDeps([view], Date.now() - (THRESHOLD_MS + 60_000));
    const seenDuringNotify: boolean[] = [];
    let watchdogRef: ReturnType<typeof createStallWatchdog> | undefined;
    notifyStalled.mockImplementation(() => {
      seenDuringNotify.push(watchdogRef?.hasNotified(view.runId) ?? false);
    });
    watchdogRef = createStallWatchdog(deps);
    watchdogRef.arm();

    vi.advanceTimersByTime(TICK_MS);
    expect(seenDuringNotify).toEqual([true]);
    watchdogRef.dispose();
  });

  it("阈值内（进展新鲜）零通知", () => {
    const { deps, notifyStalled } = makeDeps([makeView()], Date.now() - 60_000);
    const watchdog = createStallWatchdog(deps);
    watchdog.arm();

    vi.advanceTimersByTime(TICK_MS);
    expect(notifyStalled).not.toHaveBeenCalled();
    watchdog.dispose();
  });

  it("readLastProgress 返回 undefined → 回退 startedAtMs 判定（不因无帧静默）", () => {
    const view = makeView({ startedAtMs: Date.now() - (THRESHOLD_MS + 10 * 60_000) });
    const { deps, notifyStalled } = makeDeps([view], undefined);
    const watchdog = createStallWatchdog(deps);
    watchdog.arm();

    vi.advanceTimersByTime(TICK_MS);
    expect(notifyStalled).toHaveBeenCalledTimes(1);
    watchdog.dispose();
  });

  it("startedAtMs 无效（NaN）且回退命中 → 跳过，不通知不标记", () => {
    const view = makeView({ startedAtMs: Number.NaN });
    const { deps, notifyStalled } = makeDeps([view], undefined);
    const watchdog = createStallWatchdog(deps);
    watchdog.arm();

    vi.advanceTimersByTime(TICK_MS);
    expect(notifyStalled).not.toHaveBeenCalled();
    expect(watchdog.hasNotified(view.runId)).toBe(false);
    watchdog.dispose();
  });

  it("noteRunSettled 回收恰一次标记", () => {
    const view = makeView();
    const { deps } = makeDeps([view], Date.now() - (THRESHOLD_MS + 60_000));
    const watchdog = createStallWatchdog(deps);
    watchdog.arm();

    vi.advanceTimersByTime(TICK_MS);
    expect(watchdog.hasNotified(view.runId)).toBe(true);
    watchdog.noteRunSettled(view.runId);
    expect(watchdog.hasNotified(view.runId)).toBe(false);
    watchdog.dispose();
  });

  it("notifyStalled 抛错 → onTickError 收到，timer 存活（下一 tick 补扫其余 run）", () => {
    const viewA = makeView({ runId: "wf-err" });
    const viewB = makeView({ runId: "wf-next" });
    const { deps, notifyStalled, onTickError } = makeDeps(
      [viewA, viewB],
      Date.now() - (THRESHOLD_MS + 60_000),
    );
    notifyStalled.mockImplementation((v) => {
      if (v.runId === "wf-err") throw new Error("send failed");
    });
    const watchdog = createStallWatchdog(deps);
    watchdog.arm();

    // viewA：标记已落（先标记后发送）、发送抛错 → 本 tick 循环中断（viewB 未及
    // 处理，与拆出前语义一致——围栏在 tick 整体，错误不炸 timer）
    vi.advanceTimersByTime(TICK_MS);
    expect(notifyStalled).toHaveBeenCalledTimes(1);
    expect(watchdog.hasNotified("wf-err")).toBe(true);
    expect(watchdog.hasNotified("wf-next")).toBe(false);
    expect(onTickError).toHaveBeenCalledTimes(1);
    expect(onTickError.mock.calls[0]![0]).toBeInstanceOf(Error);

    // 下一 tick：viewA 已标记不重试，viewB 补扫正常通知
    vi.advanceTimersByTime(TICK_MS);
    expect(notifyStalled).toHaveBeenCalledTimes(2);
    expect(onTickError).toHaveBeenCalledTimes(1);
    watchdog.dispose();
  });

  it("arm 幂等：重复 arm 清旧 timer，单周期只 tick 一次", () => {
    const view = makeView();
    const { deps, notifyStalled } = makeDeps([view], Date.now() - (THRESHOLD_MS + 60_000));
    const watchdog = createStallWatchdog(deps);
    watchdog.arm();
    watchdog.arm(); // reload 形态：factory 重跑再 arm

    vi.advanceTimersByTime(TICK_MS);
    expect(notifyStalled).toHaveBeenCalledTimes(1);
    watchdog.dispose();
  });

  it("dispose 后零 tick；dispose 幂等", () => {
    const view = makeView();
    const { deps, notifyStalled } = makeDeps([view], Date.now() - (THRESHOLD_MS + 60_000));
    const watchdog = createStallWatchdog(deps);
    watchdog.arm();
    watchdog.dispose();
    watchdog.dispose();

    vi.advanceTimersByTime(TICK_MS * 3);
    expect(notifyStalled).not.toHaveBeenCalled();
  });
});
