// src/__tests__/turn-limiter.test.ts
import { describe, expect, it, vi } from "vitest";

import { createTurnLimiter } from "../turn-limiter.ts";

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
