// src/turn-limiter.ts
//
// soft/hard turn 限制器（W7 迁 pi 包，core engines/pi/turn-limiter.ts 逐字等价
// 副本——纯模块，无依赖）。maxTurns 到达 → steer 提醒收尾；graceTurns 后仍不
// 结束 → abort。

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

/** turn limiter 配置。 */
export interface TurnLimiterOptions {
  maxTurns: number;
  graceTurns: number;
  steer: (msg: string) => void;
  abort: () => void;
}

/**
 * soft/hard turn 限制。
 *
 *   onTurnEnd(currentTurns):
 *     已 aborted 或 maxTurns<=0（禁用）→ 直接 return
 *     currentTurns >= maxTurns 且未 steer → steer(WRAP_UP_MESSAGE)（仅一次）
 *     已 steer 且 currentTurns >= maxTurns + graceTurns → abort()（仅一次）
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
}

/** 工厂函数。 */
export function createTurnLimiter(opts: TurnLimiterOptions): TurnLimiter {
  let steered = false;
  let aborted = false;
  const limit = opts.maxTurns > 0 ? opts.maxTurns : Infinity;
  const grace = opts.graceTurns > 0 ? opts.graceTurns : 0;

  const onTurnEnd = (turn: number): void => {
    if (aborted || !Number.isFinite(limit)) return;
    if (!steered && turn >= limit) {
      steered = true;
      opts.steer(WRAP_UP_MESSAGE);
    }
    if (steered && turn >= limit + grace) {
      aborted = true;
      opts.abort();
    }
  };

  const reset = (): void => {
    steered = false;
    aborted = false;
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
  };
}
