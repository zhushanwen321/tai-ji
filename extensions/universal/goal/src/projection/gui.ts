/**
 * GUI 渲染描述符构造（projection 层）— buildGoalGui + goalStatusSeverity
 *
 * H4 拆层：从 adapters/goal-control-adapter.ts 抽出。GUI 渲染描述符归 projection 层，
 * goal-control-adapter 回归纯 tool 注册（M17 后不再调用本模块）。
 *
 * 与 projection/widget.ts 的分工：
 * - widget.ts：TUI 模式渲染（ANSI 字符串，经 ctx.ui.setWidget）
 * - gui.ts：RPC 模式渲染（结构化 GuiComponent 描述符，经 guiSetWidget 推送给 M17 对话流 widget 面板）
 *
 * 预算阈值经 engine/budget.ts 的 getBudgetSeverity 单源化（H4）：
 * buildGoalGui（percent→severity）与 widget.getBudgetColor（percent→color）共用阈值。
 */

import {
	type GuiComponent,
	guiComponent,
	type GuiRenderResult,
	guiResult,
	type TreeItem,
	type WidgetMeta,
} from "@taiji/extension-protocol";

import { PERCENT_FACTOR, SHORT_ID_LENGTH } from "../constants";
import { getBudgetSeverity } from "../engine/budget";
import type { GoalRuntimeState, GoalStatus } from "../engine/types";
import { formatTokens } from "./widget";

/**
 * 按 GoalStatus 映射 stats-line severity（S#2）。
 *
 *   active/complete → ok（正常运行/成功完成）
 *   paused          → warn（暂停可恢复）
 *   blocked         → danger（阻塞需干预）
 *   budget_limited/cancelled → danger（预算耗尽/取消，错误终态）
 *
 * 维度说明：status→severity（本函数）与 percent→color（widget.getBudgetColor）输入输出
 * 双维度不同，不合并——本函数只管「状态语义」的严重度。
 */
function goalStatusSeverity(status: GoalStatus): "ok" | "warn" | "danger" {
	switch (status) {
		case "active":
		case "complete":
			return "ok";
		case "paused":
			return "warn";
		case "blocked":
		case "budget_limited":
		case "cancelled":
			return "danger";
	}
}

/** GoalStatus → head 状态点语义（WidgetMeta.status）。 */
function metaStatus(status: GoalStatus): WidgetMeta["status"] {
	switch (status) {
		case "complete":
			return "done";
		case "blocked":
		case "budget_limited":
		case "cancelled":
			return "failed";
		case "paused":
			return "idle";
		case "active":
			return "running";
	}
}

/**
 * 构造 goal 的 GUI 渲染描述符（v1.1 meta head 架构）。
 *
 * - meta（标题=slug / 状态点 / token 进度）由宿主壳层渲染成唯一 head；
 *   有预算时进度计数用百分比 + 预算阈值 severity（70/90 warn/danger 单源）。
 * - 内容根 = group（透明组合容器）：stats-line（status/turn，无预算时补 token
 *   绝对值）+ list-tree（criteria 逐行，无 icon——所有行同 icon 是无信息量装饰，
 *   不编号——criteria 文本常自带 "1. 2." 编号）。
 */
export function buildGoalGui(state: GoalRuntimeState): GuiRenderResult {
	const slug = state.slug ?? state.goalId.slice(0, SHORT_ID_LENGTH);
	// statusSeverity 按 GoalStatus 完整覆盖（S#2），stats-line status item 消费
	const statusSeverity = goalStatusSeverity(state.status);

	// hasBudget 与进度判定统一口径：用 > 0 而非 truthy（I#1：tokenBudget=0 不应触发预算展示）
	const tokenBudget = state.budget.tokenBudget;
	const hasBudget = (tokenBudget ?? 0) > 0;

	const children: GuiComponent[] = [];

	// 状态 + turn 统计行；无预算时补 token 绝对值（有预算时 head 进度已表达，不重复）。
	// token 走 formatTokens（12000 → "12k"），避免浮点原样泄漏到 UI
	children.push(
		guiComponent("stats-line", {
			items: [
				{ label: "status", value: state.status, severity: statusSeverity },
				{ label: "turn", value: String(state.currentTurnIndex) },
				...(hasBudget ? [] : [{ label: "tokens", value: formatTokens(state.tokensUsed) }]),
			],
		}),
	);

	// successCriteria 逐行呈现（用户看「怎么算完成」）。
	// 直读数组：旧 string 的行拆分迁移已归 persistence.normalizeSuccessCriteria（唯一迁移点），
	// 此处收到的必为 string[] | undefined；仅做 trim + 空行过滤的展示归一。
	const criteriaLines = (state.successCriteria ?? [])
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (criteriaLines.length > 0) {
		children.push(
			guiComponent("list-tree", {
				items: criteriaLines.map((line): TreeItem => ({ label: line, depth: 0 })),
			}),
		);
	}

	const meta: WidgetMeta = {
		title: slug,
		status: metaStatus(state.status),
		...(hasBudget
			? {
					progress: {
						// tokensUsed 是累计加权浮点（如 1454.8400…1），取整后再进 UI
						current: Math.round(state.tokensUsed),
						total: tokenBudget!,
						label: `${Math.round((state.tokensUsed / tokenBudget!) * PERCENT_FACTOR)}%`,
						severity: getBudgetSeverity(state.tokensUsed / tokenBudget!),
					},
				}
			: {}),
	};

	return guiResult(guiComponent("group", { children }), meta);
}
