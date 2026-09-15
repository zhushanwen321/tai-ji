/**
 * /goal 命令定义和参数解析
 */

import { UPDATE_PREFIX_LENGTH } from "./constants";
import type { BudgetConfig } from "./engine/types";

export interface GoalCommandArgs {
	action: "set" | "status" | "pause" | "resume" | "clear" | "update" | "history";
	objective?: string;
	budget?: Partial<BudgetConfig>;
	/** update 的可选新 successCriteria（`/goal update <obj> --criteria <a;b;c>`）；undefined = 未提供，保留旧值 */
	criteria?: string[];
}

/**
 * 无 objective 的简单子命令 → action（表驱动分发；空串 = 纯 /goal，归 status）。
 * 用 Map 而非普通对象：输入是外部字符串，普通对象查表会命中 Object.prototype 上的键
 *（如 "constructor"），导致与原 if 链不同的错误路由。
 */
const SIMPLE_SUBCOMMAND_ACTIONS = new Map<string, GoalCommandArgs["action"]>([
	["", "status"],
	["status", "status"],
	["resume", "resume"],
	["pause", "pause"],
	["clear", "clear"],
	["history", "history"],
]);

export function parseGoalArgs(raw: string): GoalCommandArgs {
	const trimmed = raw.trim().toLowerCase();
	const fullRaw = raw.trim();

	// Subcommands without objective（表驱动分发）
	const simpleAction = SIMPLE_SUBCOMMAND_ACTIONS.get(trimmed);
	if (simpleAction) {
		return { action: simpleAction };
	}

	// /goal update <new objective> [--criteria <a;b;c>]
	if (trimmed.startsWith("update ")) {
		return parseUpdateArgs(fullRaw);
	}
	// /goal update (without argument) → 报错
	if (trimmed === "update") {
		return { action: "update" };
	}

	// /goal <objective> [--tokens N]
	return parseSetArgs(fullRaw);
}

/** /goal update 分支：--criteria 分隔标记切出 objective + criteria 列表 */
function parseUpdateArgs(fullRaw: string): GoalCommandArgs {
	const rest = fullRaw.slice(UPDATE_PREFIX_LENGTH).trim();
	// --criteria 作分隔标记（要求两侧空白，避免误切 objective 内文本）
	const criteriaSep = rest.match(/\s--criteria\s+/);
	if (!criteriaSep) {
		return { action: "update", objective: rest };
	}
	const sepStart = criteriaSep.index ?? 0;
	const objective = rest.slice(0, sepStart).trim();
	const criteriaText = rest.slice(sepStart + criteriaSep[0].length).trim();
	return { action: "update", objective, criteria: parseCriteriaList(criteriaText) };
}

/**
 * 分号拆分 + 逐段 trim + 去空段（"a;;b" → ["a","b"]）；全空段 → undefined
 * （决策④：`--criteria "  "` / `";;"` 不产出空数组，handleUpdate 保留旧值）
 */
function parseCriteriaList(criteriaText: string): string[] | undefined {
	const criteria = criteriaText.split(";").map((s) => s.trim()).filter(Boolean);
	return criteria.length > 0 ? criteria : undefined;
}

/** /goal <objective> [--tokens N] 分支：objective 剥已知 flag + budget 解析 */
function parseSetArgs(fullRaw: string): GoalCommandArgs {
	const objective = stripKnownTokenFlag(fullRaw);
	const budget = parseTokenBudget(fullRaw);
	if (!objective) {
		return { action: "status" };
	}
	return { action: "set", objective, budget };
}

/** 只匹配已知 flag，避免误删 objective 中的 -- 文本 */
function stripKnownTokenFlag(fullRaw: string): string {
	return fullRaw.replace(/--tokens\s+\d+/g, "").trim();
}

/** 提取 --tokens N 的数值；缺失 / 非法（isNaN 或 ≤0）→ 空 budget */
function parseTokenBudget(fullRaw: string): Partial<BudgetConfig> {
	const budget: Partial<BudgetConfig> = {};
	const tokenMatch = fullRaw.match(/--tokens\s+(\d+)/);
	if (tokenMatch) {
		const val = parseInt(tokenMatch[1]!, 10);
		if (!isNaN(val) && val > 0) budget.tokenBudget = val;
	}
	return budget;
}
