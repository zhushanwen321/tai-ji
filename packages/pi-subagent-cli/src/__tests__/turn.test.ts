// turn.test.ts —— pi-subagent-cli C03 簇合并产物（round5-G）。
// 共同被测业务模块：`src/turn-limiter.ts`。mock 相容：全簇零 vi.mock。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/__tests__/turn-limiter-semantics.test.ts（9 用例，skip 0）
//   - src/__tests__/turn-limiter.test.ts（11 用例，skip 0）

import { describe, expect, it, vi } from 'vitest'
import { createTurnLimiter, DEFAULT_GRACE_TURNS, type TurnBudgetExhaustion } from '../turn-limiter.ts'

// ======== 来源：turn-limiter-semantics.test.ts ========
describe("turn-limiter-semantics", () => {
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
});

// ======== 来源：turn-limiter.test.ts ========
describe("turn-limiter", () => {
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
});
