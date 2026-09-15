/**
 * buildGoalGui 测试 — v1.1 meta head 架构。
 *
 * 覆盖：
 * - 内容根 = group（透明组合容器）：stats-line（status/turn[+tokens]）+ list-tree（criteria）
 * - meta：title=slug、状态点语义（done/failed/idle/running）、token 进度（取整 + 百分比 + 阈值 severity）
 * - successCriteria 逐行 list-tree（不压扁/不截断/无 icon/不编号）
 * - token 展示走 formatTokens（无 budget 分支）
 */
import { describe, expect, it } from "vitest";

import { buildGoalGui } from "../projection/gui";
import { createGoalState } from "../engine/goal";
import type { GoalRuntimeState, GoalStatus } from "../engine/types";

function makeState(overrides: Partial<GoalRuntimeState> = {}): GoalRuntimeState {
	return {
		...createGoalState("test"),
		...overrides,
	};
}

/** 从 group children 中按 type 取组件（每个类型至多一个）。 */
function findChildComp(
	gui: ReturnType<typeof buildGoalGui>,
	type: string,
): { type: string; props: Record<string, unknown> } {
	if (gui.component.type !== "group") throw new Error(`root 应为 group，实际 ${gui.component.type}`);
	const children = gui.component.props.children as { type: string; props: Record<string, unknown> }[];
	const found = children.find((c) => c.type === type);
	if (!found) throw new Error(`children 中无 ${type} 组件`);
	return found;
}

describe("buildGoalGui（v1.1 meta head 架构）", () => {
	it("内容根 = group(stats-line + list-tree)，无 card（卡壳/head 归宿主壳层）", () => {
		const gui = buildGoalGui(
			makeState({
				tokensUsed: 4200,
				budget: { tokenBudget: 10000 },
				currentTurnIndex: 3,
				successCriteria: ["all tests green"],
			}),
		);
		expect(gui.v).toBe(1);
		expect(gui.component.type).toBe("group");
		const stats = findChildComp(gui, "stats-line");
		expect(stats.props.items).toContainEqual(expect.objectContaining({ label: "status", value: "active" }));
		expect(findChildComp(gui, "list-tree")).toBeDefined();
		// 无 progress-bar（token 进度移入 head meta）
		expect(() => findChildComp(gui, "progress-bar")).toThrow();
	});

	it("meta：title=slug、status=running、progress=取整 current + 百分比 label + 阈值 severity", () => {
		const gui = buildGoalGui(
			makeState({
				slug: "fix-auth",
				tokensUsed: 4200,
				budget: { tokenBudget: 10000 },
			}),
		);
		expect(gui.meta).toEqual({
			title: "fix-auth",
			status: "running",
			progress: { current: 4200, total: 10000, label: "42%", severity: "ok" },
		});
	});

	it("tokensUsed 浮点 → meta.progress.current 取整（1454.84…1 不进 UI）", () => {
		const gui = buildGoalGui(
			makeState({ tokensUsed: 1454.8400000000001, budget: { tokenBudget: 5000 } }),
		);
		expect(gui.meta!.progress!.current).toBe(1455);
		expect(gui.meta!.progress!.label).toBe("29%");
	});

	it.each([
		["9500/10000 ≥90%", 9500, "danger"],
		["9000/10000 =90%", 9000, "danger"],
		["7500/10000 ≥70%", 7500, "warn"],
		["7000/10000 =70%", 7000, "warn"],
	])("token 消耗 %s → meta.progress.severity %s（S#14 边界 ≥）", (_label, used, severity) => {
		const gui = buildGoalGui(makeState({ tokensUsed: used, budget: { tokenBudget: 10000 } }));
		expect(gui.meta!.progress!.severity).toBe(severity);
	});

	it.each([
		["complete", "done"],
		["blocked", "failed"],
		["budget_limited", "failed"],
		["cancelled", "failed"],
		["paused", "idle"],
	])("status %s → meta.status %s", (status, metaStatus) => {
		const gui = buildGoalGui(
			makeState({ status: status as GoalStatus, budget: { tokenBudget: 10000 } }),
		);
		expect(gui.meta!.status).toBe(metaStatus);
	});

	it("无 budget → stats-line 含 tokens（formatTokens，3k），meta 无 progress", () => {
		const gui = buildGoalGui(
			makeState({
				currentTurnIndex: 5,
				tokensUsed: 3000,
			}),
		);
		expect(gui.meta).toEqual({ title: expect.any(String), status: "running" });
		const stats = findChildComp(gui, "stats-line");
		const items = stats.props.items as { label?: string; value?: string }[];
		expect(items.find((i) => i.label === "tokens")).toMatchObject({ value: "3k" });
	});

	it("有 budget 时 stats-line 不重复 tokens（head 进度已表达）", () => {
		const gui = buildGoalGui(makeState({ tokensUsed: 3000, budget: { tokenBudget: 10000 } }));
		const stats = findChildComp(gui, "stats-line");
		const labels = (stats.props.items as { label?: string }[]).map((i) => i.label);
		expect(labels).not.toContain("tokens");
	});

	it("slug 缺省 → meta.title 用 goalId 前 8 字符", () => {
		const state = makeState({ slug: undefined, budget: { tokenBudget: 10000 } });
		expect(buildGoalGui(state).meta!.title).toBe(state.goalId.slice(0, 8));
	});

	it.each([
		["budget_limited", "danger"],
		["cancelled", "danger"],
		["paused", "warn"],
	])("status %s → stats-line status severity %s（S#2）", (status, severity) => {
		const gui = buildGoalGui(makeState({ status: status as GoalStatus, budget: { tokenBudget: 10000 } }));
		const stats = findChildComp(gui, "stats-line");
		const items = stats.props.items as Array<{ label: string; severity?: string }>;
		const statusItem = items.find((i) => i.label === "status")!;
		expect(statusItem.severity).toBe(severity);
	});

	it("tokenBudget=0 → 无预算形态（meta 无 progress，stats-line 含 tokens）（I#1 口径 >0）", () => {
		const gui = buildGoalGui(makeState({ tokensUsed: 0, budget: { tokenBudget: 0 } }));
		expect(gui.meta!.progress).toBeUndefined();
		const stats = findChildComp(gui, "stats-line");
		const labels = (stats.props.items as { label?: string }[]).map((i) => i.label);
		expect(labels).toContain("tokens");
	});

	// ── successCriteria 逐行 list-tree ──

	it("多行 successCriteria → list-tree 每行一条纯文本 item（用户报障场景）", () => {
		const gui = buildGoalGui(
			makeState({
				successCriteria: ["输出 Node.js 版本号", "输出 extensions 目录下的子目录列表"],
				budget: { tokenBudget: 10000 },
			}),
		);
		const tree = findChildComp(gui, "list-tree");
		// 无 icon（所有行同 icon 是无信息量装饰）、不编号（criteria 文本常自带编号）
		expect(tree.props.numbered).toBeUndefined();
		expect(tree.props.items).toEqual([
			{ label: "输出 Node.js 版本号", depth: 0 },
			{ label: "输出 extensions 目录下的子目录列表", depth: 0 },
		]);
	});

	it("超 80 字符的 criteria 行不截断；空行过滤；无 criteria → 无 list-tree", () => {
		const longLine = "x".repeat(120);
		const longGui = buildGoalGui(makeState({ successCriteria: [longLine] }));
		expect(findChildComp(longGui, "list-tree").props.items).toEqual([{ label: longLine, depth: 0 }]);

		const gapGui = buildGoalGui(makeState({ successCriteria: ["a", "b"] }));
		expect(findChildComp(gapGui, "list-tree").props.items).toHaveLength(2);

		const noneGui = buildGoalGui(makeState({ successCriteria: undefined, budget: { tokenBudget: 10000 } }));
		expect(() => findChildComp(noneGui, "list-tree")).toThrow();
	});
});
