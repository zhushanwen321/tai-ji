/**
 * Budget 决策引擎 — 纯函数
 *
 * 零 Pi 依赖。import from "./types"。
 *
 * FR-6.5: tick 是纯函数（不调 Date.now，不查 status）
 * 仅 token 维度预算（time budget 已移除）
 * FR-8.6: accumulateTokens token 累加算法
 */

import type { GoalRuntimeState } from "./types";
import {
	BUDGET_RATIO_HIGH,
	BUDGET_RATIO_LOW,
	MS_PER_SECOND,
	PERCENT_FACTOR,
} from "../constants";

// 加权系数（与 @zhushanwen/pi-subagent-workflow Budget.consume 对齐，ADR-030 token 口径统一）
const INPUT_WEIGHT = 1;
const CACHE_READ_WEIGHT = 0.02;
const OUTPUT_WEIGHT = 2;

// ── 类型 ────────────────────────────────────────────

export interface TokenUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	totalTokens?: number;
}

export interface TickResult {
	timeUsedSeconds: number;
	timeStartedAt: number;
}

export type BudgetDecision = { type: "warning70" } | { type: "warning90" };

export interface BudgetCheckResult {
	terminal: { type: "exceeded" } | null;
	warnings: BudgetDecision[];
	shouldSendSteering: boolean;
}

// ── token 累加（FR-8.6）──────────────────────────────

export function accumulateTokens(currentTokensUsed: number, usage: TokenUsage): number {
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	if (input > 0 || output > 0) {
		// 加权口径：input×1 + cacheRead×0.02 + output×2
		// 与 @zhushanwen/pi-subagent-workflow Budget.consume() 对齐（ADR-030 token 口径统一），
		// 修复旧公式 max(input-cacheRead,0)+output 在长 session 中 cacheRead>0 时低估预算消耗
		return currentTokensUsed + input * INPUT_WEIGHT + cacheRead * CACHE_READ_WEIGHT + output * OUTPUT_WEIGHT;
	}
	return currentTokensUsed + (usage.totalTokens ?? 0);
}

// ── 时间累计（FR-6.5 纯函数）──────────────────────────

export function tick(
	timeStartedAt: number,
	timeUsedSeconds: number,
	now: number,
	isRunning: boolean,
): TickResult {
	if (isRunning && timeStartedAt > 0) {
		const elapsed = (now - timeStartedAt) / MS_PER_SECOND;
		return { timeUsedSeconds: timeUsedSeconds + elapsed, timeStartedAt: now };
	}
	return { timeUsedSeconds, timeStartedAt: now };
}

// ── 百分比计算 ───────────────────────────────────────

export function getTokenUsagePercent(state: GoalRuntimeState): number {
	if (!state.budget.tokenBudget || state.budget.tokenBudget <= 0) return 0;
	return (state.tokensUsed / state.budget.tokenBudget) * PERCENT_FACTOR;
}

export type BudgetSeverity = "ok" | "warn" | "danger";

/**
 * 按 token 消耗比例（0-1）映射严重度。阈值单源（BUDGET_RATIO_HIGH/LOW），
 * buildGoalGui（percent→severity）与 getBudgetColor（percent→color）共用，
 * 消除阈值重复（H4）。
 *
 *   ratio >= 0.9 → danger
 *   ratio >= 0.7 → warn
 *   else         → ok
 */
export function getBudgetSeverity(ratio: number): BudgetSeverity {
	if (ratio >= BUDGET_RATIO_HIGH) return "danger";
	if (ratio >= BUDGET_RATIO_LOW) return "warn";
	return "ok";
}

export function getBudgetColor(percent: number): "error" | "warning" | "muted" {
	// 复用 getBudgetSeverity（阈值单源）：percent→ratio→severity→ThemeColor
	switch (getBudgetSeverity(percent / PERCENT_FACTOR)) {
		case "danger":
			return "error";
		case "warn":
			return "warning";
		case "ok":
		default:
			return "muted";
	}
}

// ── turn end 预算检查（仅 token 维度）───────────────────

/**
 * 仅 token 维度预算检查（time budget 已移除）。
 *
 * token 终态需 budgetLimitSteeringSent=true（90% steering 已发）——token 有 90% steering
 * 中间态（给 agent 收尾机会），需 steering 已发才确认「agent 已被提醒但未收尾」→ 终态合理。
 */
export function checkBudgetOnTurnEnd(state: GoalRuntimeState): BudgetCheckResult {
	const result: BudgetCheckResult = { terminal: null, warnings: [], shouldSendSteering: false };

	if (state.budget.tokenBudget) {
		const tokenPct = state.tokensUsed / state.budget.tokenBudget;
		if (tokenPct >= 1 && state.budgetLimitSteeringSent) {
			result.terminal = { type: "exceeded" };
			return result;
		}
		if (tokenPct >= BUDGET_RATIO_HIGH && !state.budgetLimitSteeringSent) {
			result.shouldSendSteering = true;
		} else if (tokenPct >= BUDGET_RATIO_HIGH && !state.tokenWarning90Sent) {
			result.warnings.push({ type: "warning90" });
		} else if (tokenPct >= BUDGET_RATIO_LOW && !state.tokenWarning70Sent) {
			result.warnings.push({ type: "warning70" });
		}
	}

	return result;
}

// ── resume 预算重检 ──────────────────────────────────

export function checkBudgetOnResume(state: GoalRuntimeState): { type: "exceeded" } | null {
	if (state.budget.tokenBudget && state.tokensUsed >= state.budget.tokenBudget) {
		return { type: "exceeded" };
	}
	return null;
}
