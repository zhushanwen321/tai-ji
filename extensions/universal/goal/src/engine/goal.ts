/**
 * Goal 聚合状态机 — 纯函数
 *
 * 零 Pi 依赖。import from "./types"。
 */

import { defineStateMachine } from "@zhushanwen/state-machine";

import type { BudgetConfig, GoalRuntimeState, GoalStatus } from "./types";
import { DEFAULT_BUDGET, TERMINAL_GOAL_STATUSES } from "./types";

// ── Goal 状态机声明（@zhushanwen/state-machine 行式表，M3 迁移）────────
// 事件词表从 transitionStatus 调用点目标态语义派生（D6 M3）：
// - pause / report_blocked / hit_budget_limit / complete / cancel = 用户或 agent
//   的领域动作（/goal pause、goal_control report_blocked、token 预算耗尽、
//   goal_control complete、/goal clear）；
// - cancel 与 resume 各覆盖多源态（clear/resume 对 paused、blocked 对称）。
// 终态标志与 TERMINAL_GOAL_STATUSES（types.ts，域查询用）是同一事实的两处
// 声明。表行为由两层穷举锁定（__tests__/goal.test.ts）：机器级
// generateTableTests 全状态×全事件生成组（D5/D6）+ 包装层 (from,target)
// 6×6 基线（V7 对账矩阵）。新增状态或转移时必须同步更新此表与两层基线
// （forcing function）。

/** Goal 机器事件词表（类型层与下方 events 声明键集互为对账）。 */
type GoalEvent =
	| "pause"
	| "report_blocked"
	| "complete"
	| "hit_budget_limit"
	| "cancel"
	| "resume";

export const GOAL_MACHINE = defineStateMachine<GoalStatus, GoalEvent>({
	name: "goal",
	states: {
		active: {},
		paused: {},
		blocked: {},
		complete: { terminal: true },
		budget_limited: { terminal: true },
		cancelled: { terminal: true },
	},
	initial: "active",
	events: {
		pause: {},
		report_blocked: {},
		complete: {},
		hit_budget_limit: {},
		cancel: {},
		resume: {},
	},
	transitions: [
		{ from: "active", on: "pause", to: "paused" },
		{ from: "active", on: "report_blocked", to: "blocked" },
		{ from: "active", on: "complete", to: "complete" },
		{ from: "active", on: "hit_budget_limit", to: "budget_limited" },
		{ from: ["active", "paused", "blocked"], on: "cancel", to: "cancelled" },
		{ from: ["paused", "blocked"], on: "resume", to: "active" },
	],
	errorPolicy: "throw",
});

/** (from, target) → 事件名索引：从机器行式表派生，transitionStatus 据此查边。 */
const edgeEventIndex = new Map<GoalStatus, Map<GoalStatus, GoalEvent>>();
for (const row of GOAL_MACHINE.definition.transitions) {
	if (row.to === null) continue; // goal 域无实体消亡行（to: null）
	const froms = Array.isArray(row.from) ? row.from : [row.from];
	for (const from of froms) {
		let byTarget = edgeEventIndex.get(from);
		if (!byTarget) {
			byTarget = new Map<GoalStatus, GoalEvent>();
			edgeEventIndex.set(from, byTarget);
		}
		byTarget.set(row.to, row.on);
	}
}

export function isTerminalStatus(status: GoalStatus): boolean {
	return TERMINAL_GOAL_STATUSES.has(status);
}

export function isActiveStatus(status: GoalStatus): boolean {
	return status === "active";
}

/**
 * 安全的状态转换（M3 迁移后形态：机器保形包装）。
 *
 * 签名与语义不变：查 (current, next) 边的事件名喂机器 transition 并断言
 * to === next；表外 (current, next) throw（消息与迁移前一致）。
 * 调用方必须在终态转换前自行检查 isTerminalStatus（如 finalizeAndPersist），
 * 因为终态→终态不是合法转换（表为空）。对 active→终态、active→paused/blocked、
 * paused/blocked→active/cancelled 这些合法路径直接返回 next。
 */
export function transitionStatus(current: GoalStatus, next: GoalStatus): GoalStatus {
	const event = edgeEventIndex.get(current)?.get(next);
	if (event === undefined) {
		throw new Error(`Invalid goal state transition: ${current} → ${next}`);
	}
	const result = GOAL_MACHINE.transition(current, event);
	if (result.state !== next) {
		throw new Error(
			`Goal state machine invariant broken: transition(${current}, ${event}) returned ${String(result.state)}, expected ${next}.`,
		);
	}
	return next;
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
