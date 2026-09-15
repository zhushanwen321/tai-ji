/**
 * Widget 渲染逻辑（projection 层）— 状态栏和侧边栏面板
 *
 * 设计要点：
 * - 不 import Pi 类型（theme 能力经 ports.ts 的 ThemeLike 抽象，fg 接收 string）
 * - 类型 import 自 engine/types.ts 与 ports.ts（ThemeLike 上移至接口层）
 * - 工具函数 import 自 engine/budget.ts
 * - 时间计算基于 state.timeUsedSeconds（不含 Date.now() 副作用段）
 * - updateWidget(session, uiPort) 含 FR-6.6 hasUI 守卫
 * - 仅 token 维度预算（time budget 已移除）；耗时仅作记账显示
 *
 * slug 精简（widget 显示优化）：
 * - 状态栏/侧边栏标题用 slug（AI 生成），无 slug fallback objective 截断。
 * - 完整 objective 仍注入 prompt（不在此显示），用户要看全文用 /goal status。
 * - budget 显示：配了 token 预算显示 used/budget；没配显示已消耗绝对值（D-widget-3）。
 */

import {
	OBJECTIVE_DISPLAY_LIMIT,
	OBJECTIVE_TRUNCATE_KEEP,
	PERCENT_FACTOR,
	PROGRESS_BAR_DEFAULT_WIDTH,
	SECONDS_PER_MINUTE,
	TOKEN_K_THRESHOLD,
} from "../constants";
import { getBudgetColor, getTokenUsagePercent } from "../engine/budget";
import { isTerminalStatus } from "../engine/goal";
import type { GoalRuntimeState } from "../engine/types";
import type { ThemeLike, UiPort } from "../ports";
import type { GoalSession } from "../session";
import { buildGoalGui } from "./gui";

/**
 * 将多行文本压缩为单行，用于 widget 渲染。
 * 多行 content 泄漏到 widget 会导致 markdown 表格/标题等破坏布局。
 */
export function toSingleLine(text: string): string {
	return text.replace(/\r?\n/g, " ").trim();
}

// ── token 缩写格式化（GAP-7）──────────────────────────

/**
 * 把 token 数缩写为紧凑形式：≥1000 用 k 单位（12000 → "12k"，1500 → "1.5k"）。
 * 用于 widget 状态栏，避免长数字挤占空间。
 */
export function formatTokens(n: number): string {
	if (n >= TOKEN_K_THRESHOLD) {
		const k = n / TOKEN_K_THRESHOLD;
		// 整数 k 不带小数（12k），非整数保留一位小数（1.5k）
		return Number.isInteger(k) ? `${k}k` : `${k.toFixed(1)}k`;
	}
	return String(n);
}

// ── slug 标题（fallback objective 截断，GAP-8）─────────

/**
 * 返回 widget 标题：优先 slug，无 slug fallback objective 截断（单行）。
 */
function getTitle(state: GoalRuntimeState): string {
	if (state.slug) return state.slug;
	const objSingleLine = toSingleLine(state.objective);
	return objSingleLine.length > OBJECTIVE_DISPLAY_LIMIT
		? `${objSingleLine.slice(0, OBJECTIVE_TRUNCATE_KEEP)}...`
		: objSingleLine;
}

function renderProgressBar(pct: number, width: number = PROGRESS_BAR_DEFAULT_WIDTH): string {
	const clamped = Math.min(Math.max(pct, 0), 1);
	const filled = Math.round(clamped * width);
	return "█".repeat(filled) + "░".repeat(width - filled);
}

/**
 * 返回累计耗时秒数（仅基于 state 内字段，不含 Date.now() 副作用）。
 * 终态 / blocked 状态下停止累计，直接返回已记录值。
 * adapter/service 在调用 projection 前已通过 budget.tick() 把当前活跃段计入
 * state.timeUsedSeconds，因此此处直接读取即可。
 */
function getElapsedSeconds(state: GoalRuntimeState): number {
	return state.timeUsedSeconds;
}

export function formatMinutes(seconds: number): string {
	const mins = Math.floor(seconds / SECONDS_PER_MINUTE);
	const secs = Math.floor(seconds % SECONDS_PER_MINUTE);
	return secs > 0 ? `${mins}m${secs}s` : `${mins}m`;
}

export function renderStatusLine(state: GoalRuntimeState, th: ThemeLike): string {
	if (state.status === "cancelled") return "";

	let text = th.fg("accent", `◆ ${getTitle(state)}`) + th.fg("muted", ` Turn ${state.currentTurnIndex}`);

	// Budget indicators：配了 token 预算显示百分比，没配显示已消耗绝对值（D-widget-3）
	if (state.budget.tokenBudget && state.budget.tokenBudget > 0) {
		const pct = Math.round(getTokenUsagePercent(state));
		text += th.fg(getBudgetColor(pct), ` | ${pct}% tokens`);
	} else {
		text += th.fg("dim", ` | ${formatTokens(state.tokensUsed)} tokens`);
	}
	// 耗时记账显示（time budget 已移除，仅显示累计耗时）
	text += th.fg("dim", ` | ${formatMinutes(getElapsedSeconds(state))}`);

	// Status suffix：非终态（paused = 用户暂停等待 resume / blocked = agent 报告卡住）
	// + 终态（complete/budget_limited）。paused 非终态，走 renderStatusLine。
	switch (state.status) {
		case "paused":
			text += th.fg("warning", " | ⏸ Paused");
			break;
		case "blocked":
			text += th.fg("error", " | ⊘ Blocked");
			break;
		case "complete":
			text += th.fg("success", " | ✓ Completed");
			break;
		case "budget_limited":
			text += th.fg("error", " | ⊗ Token budget exhausted");
			break;
	}

	return text;
}

export function renderTerminalStatusLine(state: GoalRuntimeState, th: ThemeLike): string {
	if (state.status === "cancelled") return "";

	// GAP-12: 终态行维持现状——只显示状态后缀 + 有 token 预算的百分比。
	// 终态 goal 已结束，显示「used (no budget)」绝对值意义不大。
	let text = th.fg("accent", "◆ Goal");

	// 状态后缀
	switch (state.status) {
		case "complete":
			text += th.fg("success", " ✓ Completed");
			break;
		case "budget_limited":
			text += th.fg("error", " ⊗ Token budget exhausted");
			break;
		default:
			break;
	}

	// 预算摘要（仅 token 维度）
	if (state.budget.tokenBudget && state.budget.tokenBudget > 0) {
		const pct = Math.round(getTokenUsagePercent(state));
		text += th.fg(getBudgetColor(pct), ` | ${pct}% tokens`);
	}

	return text;
}

export function renderWidgetLines(state: GoalRuntimeState, th: ThemeLike): string[] {
	if (state.status === "cancelled") return [];

	const header = renderStatusLine(state, th);
	const lines: string[] = [header];

	// successCriteria 摘要行（与 objective 成对展示；截断避免挤占 widget）
	if (state.successCriteria && state.successCriteria.length > 0) {
		const criteria = toSingleLine(state.successCriteria.join("; "));
		const trimmed =
			criteria.length > OBJECTIVE_DISPLAY_LIMIT
				? `${criteria.slice(0, OBJECTIVE_TRUNCATE_KEEP)}...`
				: criteria;
		lines.push(th.fg("dim", `  ✓ ${trimmed}`));
	}

	// GAP-8: 精简——移除 Objective 全文行（slug 已作标题；完整 objective 注入 prompt，用户看全文用 /goal status）

	// Token 行：配预算显示 used/budget 进度条；没配显示已消耗绝对值
	if (state.budget.tokenBudget && state.budget.tokenBudget > 0) {
		const pct = getTokenUsagePercent(state) / PERCENT_FACTOR;
		const used = formatTokens(state.tokensUsed);
		const total = formatTokens(state.budget.tokenBudget);
		lines.push(`  Token: ${renderProgressBar(pct)} ${used}/${total}`);
	} else {
		lines.push(th.fg("dim", `  Token: ${formatTokens(state.tokensUsed)} used (no budget)`));
	}
	// Time 行：累计耗时记账显示（time budget 已移除）
	lines.push(th.fg("dim", `  Time: ${formatMinutes(getElapsedSeconds(state))} elapsed`));

	return lines;
}

// ── updateWidget（FR-6.6 hasUI 守卫）──

/**
 * 刷新 widget + status bar。
 *
 * FR-6.6：`uiPort.hasUI === false`（headless）时直接 return。
 *
 * widget 推送为双模单调用：setWidget 收 dual payload（{ gui, text }），
 * GUI/TUI 模式分派由 adapter 层委托的 protocol setWidgetDual 单点承担。
 *
 * 终态折叠为单行 status bar（widget 清除）；cancelled/无 state 清除 widget + status。
 */
export function updateWidget(session: GoalSession, uiPort: UiPort): void {
	if (!uiPort.hasUI) return;

	if (!session.state || session.state.status === "cancelled") {
		uiPort.setWidget("goal", undefined);
		uiPort.setStatus("goal", undefined);
		return;
	}

	// 终态折叠为单行 status bar
	if (isTerminalStatus(session.state.status)) {
		const statusText = renderTerminalStatusLine(session.state, uiPort.theme);
		if (statusText) {
			uiPort.setStatus("goal", statusText);
		}
		uiPort.setWidget("goal", undefined);
		return;
	}

	uiPort.setStatus("goal", renderStatusLine(session.state, uiPort.theme));
	// 双模 payload 按值立即构造（buildGoalGui/renderWidgetLines 均为廉价纯函数）：
	// gui 臂复用 projection/gui.ts 的 buildGoalGui（GuiRenderResult：component + meta 宿主元数据）
	uiPort.setWidget("goal", {
		gui: buildGoalGui(session.state),
		text: renderWidgetLines(session.state, uiPort.theme),
	});
}
