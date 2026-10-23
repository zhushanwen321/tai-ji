// src/turn-limiter.ts
//
// soft/hard turn 限制器（W7 自 core 迁入 pi 包——纯模块，无依赖）。maxTurns 到达
// → steer 提醒收尾；graceTurns 后仍不结束 → abort。
//
// [subagent-observability §3.3.9 预算显式化] 优雅收敛管道的引擎侧唯一执法点：
// maxTurns 显式传参时 WRAP_UP 提示 → 宽限轮（DEFAULT_GRACE_TURNS，调用方可显式
// 覆盖）→ abort；abort 携带 TurnBudgetExhaustion 事实（{used, limit}）供轮失败
// cause `harness.turn_budget_exhausted` 结构化承载（UC-10——轮失败不裸死，
// 「打到第几轮 / 上限多少」可查询）。maxTurns 缺省/0 = unbounded（limit 取
// Infinity，不 steer 不 abort），默认行为不变（规则 19：任务级默认无超时）。

/** steer 提醒消息：要求 agent 总结已完成/未完成/下一步，不得谎报完成。 */
const WRAP_UP_MESSAGE = [
  "You have reached your turn limit. Wrap up now:",
  "1. Summarize what you have completed (with evidence: file paths, command output).",
  "2. List what remains undone and why.",
  "3. State the single most important next step for whoever continues.",
  "Do NOT claim the task is complete if any part remains unfinished.",
].join(" ");

/**
 * 预防性 wrap-up 提示（启动时注入 --append-system-prompt）。
 *
 * rpc steer 通道未接通时的短期补偿（见 spawn-runner limiter 注释）。
 */
export const WRAP_UP_HINT = [
  `You have a turn limit. As you sense you are approaching it, proactively wrap up:`,
  "1. Summarize what you have completed (with evidence: file paths, command output).",
  "2. List what remains undone and why.",
  "3. State the single most important next step for whoever continues.",
  "Do NOT claim the task is complete if any part remains unfinished.",
].join(" ");

/**
 * [subagent-observability §3.3.9] graceTurns 权威缺省（常量登记）：WRAP_UP 提示后
 * 两轮收敛窗口；调用方可显式覆盖（TurnLimiterOptions.graceTurns，显式 0 = steer 后
 * 同轮 abort 的既有语义保留）。原缺省值分散在 spawn-event-translator 本地常量，
 * 预算管道启用后上移本文件单点。
 */
export const DEFAULT_GRACE_TURNS = 2;

/**
 * [subagent-observability §3.3.9/UC-10] turn 预算耗尽事实（abort 边沿一次产出）。
 *   used  — abort 时的轮数（onTurnEnd 入参原值，失败尝试计入：limiter 裁决发生在
 *           turn_end 边沿，P5 失败尝试切片是轮收条计账口径，不影响执法边沿事实）；
 *   limit — 显式 maxTurns 上界（unbounded 时 limiter 永不 abort，本事实不产出）。
 */
export interface TurnBudgetExhaustion {
  used: number;
  limit: number;
}

/** turn limiter 配置。 */
export interface TurnLimiterOptions {
  maxTurns: number;
  /**
   * WRAP_UP 提示后的宽限轮数；缺省 {@link DEFAULT_GRACE_TURNS}（§3.3.9 常量登记，
   * 调用方可显式覆盖——显式 0 = steer 后同轮 abort）。
   */
  graceTurns?: number;
  steer: (msg: string) => void;
  /** [§3.3.9] abort 携带耗尽事实（{used, limit}）——cause 结构化承载的产点。 */
  abort: (info: TurnBudgetExhaustion) => void;
}

/**
 * soft/hard turn 限制。
 *
 *   onTurnEnd(currentTurns):
 *     已 aborted 或 maxTurns<=0（unbounded 禁用）→ 直接 return
 *     currentTurns >= maxTurns 且未 steer → steer(WRAP_UP_MESSAGE)（仅一次）
 *     已 steer 且 currentTurns >= maxTurns + graceTurns → abort({used, limit})（仅一次）
 */
export interface TurnLimiter {
  /** 每次 turn_end 调用。 */
  onTurnEnd(currentTurns: number): void;
  /** 重置 steered/aborted 标志（新一轮开始）。 */
  reset(): void;
  /** 是否已发过 steer（诊断用）。 */
  readonly didSteer: boolean;
  /** 是否已 abort（诊断用）。 */
  readonly didAbort: boolean;
  /**
   * [§3.3.9/UC-10] 最近一次 abort 的耗尽事实（{used, limit}）；未 abort =
   * undefined。translator 收尾边沿据此填充 EngineRoundErrorFact.turnBudget。
   */
  readonly turnBudgetExhaustion: TurnBudgetExhaustion | undefined;
}

/** 工厂函数。 */
export function createTurnLimiter(opts: TurnLimiterOptions): TurnLimiter {
  let steered = false;
  let aborted = false;
  let exhaustion: TurnBudgetExhaustion | undefined;
  const limit = opts.maxTurns > 0 ? opts.maxTurns : Infinity;
  // graceTurns 缺省 2（DEFAULT_GRACE_TURNS）；显式传值（含 0）按调用方覆盖——
  // `?? DEFAULT` 再走 `> 0` 校验，NaN/负值回落 0（同轮 abort 的防御语义）。
  const grace = (() => {
    const g = opts.graceTurns ?? DEFAULT_GRACE_TURNS;
    return g > 0 ? g : 0;
  })();

  const onTurnEnd = (turn: number): void => {
    if (aborted || !Number.isFinite(limit)) return;
    if (!steered && turn >= limit) {
      steered = true;
      opts.steer(WRAP_UP_MESSAGE);
    }
    if (steered && turn >= limit + grace) {
      aborted = true;
      exhaustion = { used: turn, limit };
      opts.abort(exhaustion);
    }
  };

  const reset = (): void => {
    steered = false;
    aborted = false;
    exhaustion = undefined;
  };

  return {
    onTurnEnd,
    reset,
    get didSteer(): boolean {
      return steered;
    },
    get didAbort(): boolean {
      return aborted;
    },
    get turnBudgetExhaustion(): TurnBudgetExhaustion | undefined {
      return exhaustion;
    },
  };
}
