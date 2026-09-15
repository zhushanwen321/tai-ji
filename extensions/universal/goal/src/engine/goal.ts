/**
 * Goal 聚合状态机 — 纯函数
 *
 * 零 Pi 依赖。import from "./types"。
 */

import type { BudgetConfig, GoalRuntimeState, GoalStatus } from "./types";
import { DEFAULT_BUDGET, TERMINAL_GOAL_STATUSES, VALID_TRANSITIONS } from "./types";

export function isTerminalStatus(status: GoalStatus): boolean {
	return TERMINAL_GOAL_STATUSES.has(status);
}

export function isActiveStatus(status: GoalStatus): boolean {
	return status === "active";
}

/**
 * 安全的状态转换。查 VALID_TRANSITIONS 表，非法转换 throw。
 *
 * 调用方必须在终态转换前自行检查 isTerminalStatus（如 finalizeAndPersist），
 * 因为终态→终态不是合法转换（表为空）。对 active→终态、active→paused/blocked、
 * paused/blocked→active/cancelled 这些合法路径直接返回 next。
 */
export function transitionStatus(current: GoalStatus, next: GoalStatus): GoalStatus {
	const allowed = VALID_TRANSITIONS[current];
	if (allowed && allowed.includes(next)) {
		return next;
	}
	throw new Error(`Invalid goal state transition: ${current} → ${next}`);
}

/**
 * 创建初始 GoalRuntimeState。纯数据构造，无副作用。
 */
export function createGoalState(
	objective: string,
	budgetOverrides?: Partial<BudgetConfig>,
	slug?: string,
	successCriteria?: string[],
): GoalRuntimeState {
	const now = Date.now();
	return {
		goalId: crypto.randomUUID(),
		objective,
		successCriteria,
		slug,
		status: "active",
		tokensUsed: 0,
		timeStartedAt: now,
		timeUsedSeconds: 0,
		budget: { ...DEFAULT_BUDGET, ...budgetOverrides },
		budgetLimitSteeringSent: false,
		lastBlockerReason: null,
		tokenWarning70Sent: false,
		tokenWarning90Sent: false,
		lastTurnTokensUsed: 0,
		currentTurnIndex: 0,
		// W5 熔断计数从零开始（chat-domain-v1x D4）
		continuationsSent: 0,
		noProgressTurns: 0,
		continuationCapNotified: false,
		lastDeferredPendingIds: [],
		toolCallsSeen: 0,
	};
}
