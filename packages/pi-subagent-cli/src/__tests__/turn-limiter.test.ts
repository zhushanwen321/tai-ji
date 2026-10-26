// src/__tests__/turn-limiter.test.ts
import { describe, expect, it, vi } from "vitest";

import { createTurnLimiter, DEFAULT_GRACE_TURNS, type TurnBudgetExhaustion } from "../turn-limiter.ts";

describe("createTurnLimiter", () => {
  it("does nothing before maxTurns", () => {
    const steer = vi.fn();
    const abort = vi.fn();
    const limiter = createTurnLimiter({ maxTurns: 3, graceTurns: 2, steer, abort });
    limiter.onTurnEnd(1);
    limiter.onTurnEnd(2);
    expect(steer).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    expect(limiter.didSteer).toBe(false);
    expect(limiter.didAbort).toBe(false);
  });

  it("steers on maxTurns and aborts after graceTurns", () => {
    const steer = vi.fn();
    const abort = vi.fn();
    const limiter = createTurnLimiter({ maxTurns: 3, graceTurns: 2, steer, abort });
    limiter.onTurnEnd(3); // 达到 maxTurns → steer
    expect(steer).toHaveBeenCalledWith(expect.stringContaining("You have reached your turn limit"));
    expect(abort).not.toHaveBeenCalled();
    expect(limiter.didSteer).toBe(true);
    limiter.onTurnEnd(4); // grace turn 1
    expect(abort).not.toHaveBeenCalled();
    limiter.onTurnEnd(5); // grace turn 2 → abort
    expect(abort).toHaveBeenCalledTimes(1);
    expect(limiter.didAbort).toBe(true);
  });

  it("disables when maxTurns is 0", () => {
    const steer = vi.fn();
    const abort = vi.fn();
    const limiter = createTurnLimiter({ maxTurns: 0, graceTurns: 2, steer, abort });
    limiter.onTurnEnd(100);
    expect(steer).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    expect(limiter.didSteer).toBe(false);
  });

  it("steers only once", () => {
    const steer = vi.fn();
    const abort = vi.fn();
    const limiter = createTurnLimiter({ maxTurns: 2, graceTurns: 3, steer, abort });
    limiter.onTurnEnd(2);
    limiter.onTurnEnd(3);
    expect(steer).toHaveBeenCalledTimes(1);
    expect(limiter.didSteer).toBe(true);
  });

  it("aborts on the same turn as steer when graceTurns is 0", () => {
    const steer = vi.fn();
    const abort = vi.fn();
    const limiter = createTurnLimiter({ maxTurns: 2, graceTurns: 0, steer, abort });
    // grace=0 → limit+grace == limit，steer 后同一 turn 即满足 abort 条件
    limiter.onTurnEnd(2); // maxTurns → steer + abort（同 turn）
    expect(steer).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(limiter.didSteer).toBe(true);
    expect(limiter.didAbort).toBe(true);
  });
});

describe("[subagent-observability §3.3.9/UC-10] 预算耗尽事实（{used, limit}）与 graceTurns 缺省", () => {
  it("abort 携带耗尽事实 {used, limit}（used=abort 时轮数、limit=显式 maxTurns）", () => {
    const steer = vi.fn();
    const abort = vi.fn<(info: TurnBudgetExhaustion) => void>();
    const limiter = createTurnLimiter({ maxTurns: 3, graceTurns: 2, steer, abort });
    limiter.onTurnEnd(1);
    limiter.onTurnEnd(2);
    limiter.onTurnEnd(3); // steer
    limiter.onTurnEnd(4); // grace 1
    limiter.onTurnEnd(5); // grace 2 → abort
    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith({ used: 5, limit: 3 });
    // 事实快照随 abort 落位（诊断位与 abort 入参同源同值）
    expect(limiter.turnBudgetExhaustion).toEqual({ used: 5, limit: 3 });
  });

  it("未 abort → turnBudgetExhaustion 为 undefined（无事实不产结构）", () => {
    const limiter = createTurnLimiter({ maxTurns: 3, graceTurns: 1, steer: vi.fn(), abort: vi.fn() });
    limiter.onTurnEnd(1);
    limiter.onTurnEnd(3); // steer，未到 abort
    expect(limiter.didAbort).toBe(false);
    expect(limiter.turnBudgetExhaustion).toBeUndefined();
  });

  it("unbounded（maxTurns=0）永不 abort、永不产耗尽事实（UC-9 默认行为不变）", () => {
    const steer = vi.fn();
    const abort = vi.fn<(info: TurnBudgetExhaustion) => void>();
    const limiter = createTurnLimiter({ maxTurns: 0, graceTurns: 2, steer, abort });
    for (let turn = 1; turn <= 200; turn++) limiter.onTurnEnd(turn);
    expect(steer).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    expect(limiter.turnBudgetExhaustion).toBeUndefined();
  });

  it("graceTurns 缺省 = DEFAULT_GRACE_TURNS（常量登记 2）：steer 后两轮收敛窗口", () => {
    const steer = vi.fn();
    const abort = vi.fn<(info: TurnBudgetExhaustion) => void>();
    expect(DEFAULT_GRACE_TURNS).toBe(2); // §3.3.9 常量登记（WRAP_UP 提示后两轮收敛）
    const limiter = createTurnLimiter({ maxTurns: 2, steer, abort }); // 不传 graceTurns
    limiter.onTurnEnd(2); // steer
    limiter.onTurnEnd(3); // 缺省宽限轮 1 — 不 abort
    expect(abort).not.toHaveBeenCalled();
    limiter.onTurnEnd(4); // 缺省宽限轮 2 耗尽（limit+2）→ abort
    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith({ used: 4, limit: 2 });
  });

  it("graceTurns 显式覆盖生效（显式 0 = steer 后同轮 abort 的既有语义保留）", () => {
    const steer = vi.fn();
    const abort = vi.fn<(info: TurnBudgetExhaustion) => void>();
    const limiter = createTurnLimiter({ maxTurns: 2, graceTurns: 0, steer, abort });
    limiter.onTurnEnd(2); // steer + 同轮 abort
    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith({ used: 2, limit: 2 });
  });

  it("reset 清耗尽事实快照（新一轮无既有 abort 事实）", () => {
    const limiter = createTurnLimiter({ maxTurns: 1, graceTurns: 0, steer: vi.fn(), abort: vi.fn() });
    limiter.onTurnEnd(1); // steer + 同轮 abort
    expect(limiter.turnBudgetExhaustion).toEqual({ used: 1, limit: 1 });
    limiter.reset();
    expect(limiter.turnBudgetExhaustion).toBeUndefined();
    expect(limiter.didAbort).toBe(false);
  });
});
