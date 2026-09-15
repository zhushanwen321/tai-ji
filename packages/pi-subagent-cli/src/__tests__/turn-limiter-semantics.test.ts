// src/execution/__tests__/turn-limiter-semantics.test.ts
//
// SP-9: turn-limiter 轮次语义——agent_settled 后 maxTurns 每轮 reset（不跨轮累计）。
// 设计 D9 决策：续聊本质是无限轮，累计上限违背 G1。（[modeless 波2] 全体 run 均为
// 轮次形态，spawn-event-translator 在 agent_settled 恒调 reset。）

import { describe, expect, it, vi } from "vitest";

import { createTurnLimiter } from "../turn-limiter.ts";

describe("SP-9: turn-limiter round semantics (maxTurns reset per round)", () => {
  describe("TC-1: 多轮后 maxTurns 每轮 reset（不累计）", () => {
    it("reset 后 maxTurns 不累计——第二轮从 0 开始，不触发 steer/abort", () => {
      const steer = vi.fn();
      const abort = vi.fn();
      const limiter = createTurnLimiter({ maxTurns: 3, graceTurns: 2, steer, abort });

      // 第一轮：3 turns → steer（达到 maxTurns=3）
      limiter.onTurnEnd(1);
      limiter.onTurnEnd(2);
      limiter.onTurnEnd(3);
      expect(steer).toHaveBeenCalledTimes(1);
      expect(abort).not.toHaveBeenCalled();

      // agent_settled → reset（每轮 reset，modeless 下全体 run 同语义）
      limiter.reset();

      // 第二轮从 turnCount=0 开始（record.turnCount 由 session-runner 归零）：
      // 2 turns 不触发 steer（距离 maxTurns=3 还差 1）
      limiter.onTurnEnd(1);
      limiter.onTurnEnd(2);
      // steer 仍然是 1 次（第一轮那次），第二轮未触发
      expect(steer).toHaveBeenCalledTimes(1);
      expect(abort).not.toHaveBeenCalled();
    });

    it("reset 后第二轮同样达到 maxTurns 时仍触发 steer", () => {
      const steer = vi.fn();
      const abort = vi.fn();
      const limiter = createTurnLimiter({ maxTurns: 2, graceTurns: 1, steer, abort });

      // 第一轮：steer + grace + abort
      limiter.onTurnEnd(1);
      limiter.onTurnEnd(2); // steer
      limiter.onTurnEnd(3); // abort
      expect(steer).toHaveBeenCalledTimes(1);
      expect(abort).toHaveBeenCalledTimes(1);

      // reset（新轮）
      limiter.reset();
      expect(limiter.didSteer).toBe(false);
      expect(limiter.didAbort).toBe(false);

      // 第二轮：同样走完 steer + grace 路径
      limiter.onTurnEnd(1);
      limiter.onTurnEnd(2); // steer again
      expect(steer).toHaveBeenCalledTimes(2);
      expect(abort).toHaveBeenCalledTimes(1); // 还没到 abort

      limiter.onTurnEnd(3); // abort again
      expect(abort).toHaveBeenCalledTimes(2);
    });

    it("多轮连续 reset 后 limiter 始终可用", () => {
      const steer = vi.fn();
      const abort = vi.fn();
      const limiter = createTurnLimiter({ maxTurns: 2, graceTurns: 0, steer, abort });

      for (let round = 1; round <= 5; round++) {
        limiter.onTurnEnd(1);
        limiter.onTurnEnd(2); // steer + abort (graceTurns=0)
        expect(steer).toHaveBeenCalledTimes(round);
        expect(abort).toHaveBeenCalledTimes(round);
        limiter.reset();
      }
    });
  });

  describe("TC-2: graceTurns 每轮 reset", () => {
    it("reset 后 graceTurns 从 0 重新计数", () => {
      const steer = vi.fn();
      const abort = vi.fn();
      const limiter = createTurnLimiter({ maxTurns: 2, graceTurns: 3, steer, abort });

      // 第一轮：steer at turn 2，用掉 1 个 grace turn
      limiter.onTurnEnd(1);
      limiter.onTurnEnd(2); // steer
      limiter.onTurnEnd(3); // grace turn 1
      expect(abort).not.toHaveBeenCalled();

      // reset（模拟 agent_settled）
      limiter.reset();

      // 第二轮：从 turn 1 开始，graceTurns 重新从 0 计数
      limiter.onTurnEnd(1);
      limiter.onTurnEnd(2); // steer again
      limiter.onTurnEnd(3); // grace turn 1（重计）
      limiter.onTurnEnd(4); // grace turn 2
      limiter.onTurnEnd(5); // grace turn 3 → abort
      expect(abort).toHaveBeenCalledTimes(1);
    });

    it("reset 前未 steer 时 reset 后仍正常工作", () => {
      const steer = vi.fn();
      const abort = vi.fn();
      const limiter = createTurnLimiter({ maxTurns: 5, graceTurns: 2, steer, abort });

      // 第一轮：只走了 2 turns（未达 maxTurns）
      limiter.onTurnEnd(1);
      limiter.onTurnEnd(2);
      expect(steer).not.toHaveBeenCalled();

      limiter.reset();

      // 第二轮：从 turn 1 开始，到 maxTurns=5 触发 steer
      limiter.onTurnEnd(1);
      limiter.onTurnEnd(2);
      limiter.onTurnEnd(3);
      limiter.onTurnEnd(4);
      limiter.onTurnEnd(5); // steer
      expect(steer).toHaveBeenCalledTimes(1);
      limiter.onTurnEnd(6);
      limiter.onTurnEnd(7); // abort (5+2)
      expect(abort).toHaveBeenCalledTimes(1);
    });
  });

  describe("TC-3: 无 reset 时全程累计（limiter 原语行为锁定）", () => {
    it("不调用 reset 时 turn-limiter 行为与原来完全一致", () => {
      const steer = vi.fn();
      const abort = vi.fn();
      const limiter = createTurnLimiter({ maxTurns: 3, graceTurns: 2, steer, abort });

      // 全程累计（不 reset——原语行为锁定）：3→steer，5→abort
      limiter.onTurnEnd(1);
      limiter.onTurnEnd(2);
      limiter.onTurnEnd(3); // steer
      expect(steer).toHaveBeenCalledTimes(1);
      limiter.onTurnEnd(4); // grace 1
      limiter.onTurnEnd(5); // grace 2 → abort
      expect(abort).toHaveBeenCalledTimes(1);
      expect(limiter.didSteer).toBe(true);
      expect(limiter.didAbort).toBe(true);
    });

    it("maxTurns=0（禁用）不因 reset 而误启用", () => {
      const steer = vi.fn();
      const abort = vi.fn();
      const limiter = createTurnLimiter({ maxTurns: 0, graceTurns: 2, steer, abort });

      limiter.onTurnEnd(100);
      expect(steer).not.toHaveBeenCalled();

      limiter.reset();
      limiter.onTurnEnd(100);
      // maxTurns=0（禁用），即使 reset 也不触发
      expect(steer).not.toHaveBeenCalled();
      expect(abort).not.toHaveBeenCalled();
    });

    it("全程累计（不 reset）达到 maxTurns+graceTurns 后不再触发", () => {
      const steer = vi.fn();
      const abort = vi.fn();
      const limiter = createTurnLimiter({ maxTurns: 2, graceTurns: 1, steer, abort });

      limiter.onTurnEnd(1);
      limiter.onTurnEnd(2); // steer
      limiter.onTurnEnd(3); // abort
      expect(steer).toHaveBeenCalledTimes(1);
      expect(abort).toHaveBeenCalledTimes(1);

      // 已 abort 后继续调用 onTurnEnd（不应再次触发）
      limiter.onTurnEnd(4);
      limiter.onTurnEnd(5);
      expect(steer).toHaveBeenCalledTimes(1);
      expect(abort).toHaveBeenCalledTimes(1);
    });
  });

  describe("TC-4: reset 诊断属性", () => {
    it("reset 清除 didSteer 和 didAbort 诊断标志", () => {
      const steer = vi.fn();
      const abort = vi.fn();
      const limiter = createTurnLimiter({ maxTurns: 1, graceTurns: 0, steer, abort });

      limiter.onTurnEnd(1); // steer + abort (graceTurns=0)
      expect(limiter.didSteer).toBe(true);
      expect(limiter.didAbort).toBe(true);

      limiter.reset();
      expect(limiter.didSteer).toBe(false);
      expect(limiter.didAbort).toBe(false);
    });
  });
});
