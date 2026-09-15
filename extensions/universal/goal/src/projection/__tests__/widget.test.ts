/**
 * widget.ts 测试 — projection 层渲染（TC-2）
 *
 * 覆盖：
 * - toSingleLine: 多行压缩
 * - renderStatusLine: slug 标题（fallback objective 截断）+ 状态后缀 + cancelled 短路 + token/耗时显示
 * - renderWidgetLines: cancelled 短路 + 标题行 + criteria 摘要单行 + 预算进度条（Objective 全文行已移除，GAP-8）
 * - renderTerminalStatusLine: 终态单行 + cancelled 短路
 * - updateWidget: FR-6.6 hasUI 守卫 + 终态折叠 + cancelled 清除
 *
 * 用 passthrough ThemeLike（fg/bold 返回原文），断言渲染逻辑而非颜色。
 */
import { describe, expect, it } from "vitest";

import { createGoalState } from "../../engine/goal";
import type { GoalRuntimeState, GoalStatus } from "../../engine/types";
import type { ThemeLike, UiPort } from "../../ports";
import { createGoalSession } from "../../session";
import { OBJECTIVE_DISPLAY_LIMIT, OBJECTIVE_TRUNCATE_KEEP } from "../../constants";
import {
	renderStatusLine,
	renderTerminalStatusLine,
	renderWidgetLines,
	toSingleLine,
	updateWidget,
} from "../widget";

// ── Passthrough theme（断言渲染逻辑，不含颜色干扰）────

const theme: ThemeLike = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

// ── 辅助 ─────────────────────────────────────────────

function makeState(overrides?: Partial<GoalRuntimeState>): GoalRuntimeState {
	return {
		...createGoalState("test objective"),
		status: "active",
		...overrides,
	};
}

// ── toSingleLine ─────────────────────────────────────

describe("toSingleLine", () => {
	it("多行 → 空格分隔单行 + 去首尾空白（不折叠连续空格）", () => {
		expect(toSingleLine("hello\nworld")).toBe("hello world");
		expect(toSingleLine("a\nb\nc")).toBe("a b c");
		expect(toSingleLine("  trimmed  ")).toBe("trimmed");
	});
	it("单行原样返回（trim）", () => {
		expect(toSingleLine("  single  ")).toBe("single");
	});
});

// ── renderStatusLine ─────────────────────────────────

describe("renderStatusLine", () => {
	it("cancelled → 空字符串（短路）", () => {
		expect(renderStatusLine(makeState({ status: "cancelled" }), theme)).toBe("");
	});

	it("active 状态：标题用 slug（fallback objective）+ turn 计数", () => {
		const text = renderStatusLine(makeState({ status: "active", currentTurnIndex: 3 }), theme);
		// 无 slug 时 fallback 到 objective 截断
		expect(text).toContain("◆ test objective");
		expect(text).toContain("Turn 3"); // currentTurnIndex
	});

	it("active 状态有 slug → 标题用 slug", () => {
		const text = renderStatusLine(
			makeState({ status: "active", slug: "refactor-auth", currentTurnIndex: 2 }),
			theme,
		);
		expect(text).toContain("◆ refactor-auth");
		expect(text).not.toContain("test objective"); // slug 优先，objective 不显示
	});

	it("无预算 → 显示已消耗绝对值 token 段（非百分比分支）", () => {
		const text = renderStatusLine(
			makeState({ status: "active", tokensUsed: 12000, timeUsedSeconds: 90 }),
			theme,
		);
		// 无预算走绝对值分支：含 "tokens" 不含 "% tokens"。
		// 缩写(12k)/时间格式(1m30s)的正确性已下沉到 format.test.ts 直接测。
		expect(text).toContain("tokens");
		expect(text).not.toContain("% tokens");
	});

	it.each([
		["blocked", "⊘ Blocked"],
		["paused", "⏸ Paused"],
		["complete", "✓ Completed"],
		["budget_limited", "⊗ Token budget exhausted"],
	])("renderStatusLine %s → 含后缀 %s", (status, suffix) => {
		expect(renderStatusLine(makeState({ status: status as GoalStatus }), theme)).toContain(suffix);
	});

	it("tokenBudget > 0 → 显示 token 百分比", () => {
		const text = renderStatusLine(
			makeState({
				status: "active",
				budget: { tokenBudget: 1000 },
				tokensUsed: 500,
			}),
			theme,
		);
		expect(text).toContain("50% tokens");
	});
});

// ── renderTerminalStatusLine ─────────────────────────

describe("renderTerminalStatusLine", () => {
	it("cancelled → 空字符串", () => {
		expect(renderTerminalStatusLine(makeState({ status: "cancelled" }), theme)).toBe("");
	});
});

// ── renderWidgetLines ────────────────────────────────

describe("renderWidgetLines", () => {
	it("cancelled → 空数组", () => {
		expect(renderWidgetLines(makeState({ status: "cancelled" }), theme)).toEqual([]);
	});

	it("active → 不含 objective 全文行（精简，slug 作标题）", () => {
		const lines = renderWidgetLines(makeState({ status: "active" }), theme);
		// GAP-8: 移除 Objective 全文行（slug 已作标题）
		expect(lines.some((l) => l.includes("Objective:"))).toBe(false);
	});

	it("active 无 slug → 标题 fallback objective 截断", () => {
		const lines = renderWidgetLines(makeState({ status: "active" }), theme);
		expect(lines[0]).toContain("◆ test objective");
	});

	it("tokenBudget → 含 token 进度条行（used/total 格式）", () => {
		const lines = renderWidgetLines(
			makeState({
				status: "active",
				budget: { tokenBudget: 1000 },
				tokensUsed: 250,
				timeUsedSeconds: 540,
			}),
			theme,
		);
		// token 进度条行渲染（缩写 250/1k 的正确性下沉到 format.test.ts）
		expect(lines.some((l) => l.includes("Token:"))).toBe(true);
		expect(lines.some((l) => /[█░]/.test(l))).toBe(true);
	});

	it("无预算 → token 显示已消耗绝对值，time 显示纯耗时", () => {
		const lines = renderWidgetLines(
			makeState({ status: "active", tokensUsed: 5000, timeUsedSeconds: 120 }),
			theme,
		);
		// 无预算绝对值分支结构（缩写 5k / 2m 的正确性下沉到 format.test.ts）
		expect(lines.some((l) => l.includes("used (no budget)"))).toBe(true);
		expect(lines.some((l) => l.includes("Time:") && l.includes("elapsed"))).toBe(true);
	});

	it("有 successCriteria → 含 ✓ 摘要行", () => {
		const lines = renderWidgetLines(
			makeState({ status: "active", successCriteria: ["all tests green"] }),
			theme,
		);
		expect(lines.some((l) => l.includes("✓") && l.includes("all tests green"))).toBe(true);
	});

	it("successCriteria 多项 → 分号连接显示", () => {
		const lines = renderWidgetLines(
			makeState({ status: "active", successCriteria: ["tests pass", "tsc clean"] }),
			theme,
		);
		expect(lines.some((l) => l.includes("✓") && l.includes("tests pass; tsc clean"))).toBe(true);
	});

	it("successCriteria 超长 → 截断为 ...（OBJECTIVE_TRUNCATE_KEEP）", () => {
		const long = "x".repeat(OBJECTIVE_DISPLAY_LIMIT + 10); // > 80 字符触发截断
		const lines = renderWidgetLines(
			makeState({ status: "active", successCriteria: [long] }),
			theme,
		);
		const criteriaLine = lines.find((l) => l.includes("✓"))!;
		expect(criteriaLine).toContain("...");
		// 截断后保留前 OBJECTIVE_TRUNCATE_KEEP(77) 字符
		expect(criteriaLine).toContain("x".repeat(OBJECTIVE_TRUNCATE_KEEP));
	});

	it("无 successCriteria → 不出现 ✓ 摘要行", () => {
		const lines = renderWidgetLines(makeState({ status: "active" }), theme);
		// active 状态行无 ✓（✓ Completed 仅出现在 complete 终态行）
		expect(lines.some((l) => l.includes("✓"))).toBe(false);
	});
});

// ── updateWidget（FR-6.6 hasUI 守卫 + dual payload）──

interface RecordedCall {
	method: "setWidget" | "setStatus";
	args: unknown[];
}

/** UiPort fake：记录 setWidget/setStatus 调用（setWidget 现为 dual payload 单签名）。 */
function makeUiPort(hasUI: boolean): { ui: UiPort; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const ui = {
		hasUI,
		setWidget(name: string, content: unknown) {
			calls.push({ method: "setWidget", args: [name, content] });
		},
		setStatus(name: string, text: unknown) {
			calls.push({ method: "setStatus", args: [name, text] });
		},
		notify() {},
		theme: {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		},
	} as UiPort;
	return { ui, calls };
}

describe("updateWidget (FR-6.6 hasUI guard)", () => {
	it("hasUI=false → 不调 setWidget/setStatus（headless 守卫）", () => {
		const { ui, calls } = makeUiPort(false);
		const session = createGoalSession();
		session.state = makeState({ status: "active" });
		updateWidget(session, ui);
		expect(calls).toHaveLength(0); // FR-6.6
	});

	it("session.state=null → 清除 widget + status", () => {
		const { ui, calls } = makeUiPort(true);
		updateWidget(createGoalSession(), ui);
		expect(calls.some((c) => c.method === "setWidget" && c.args[1] === undefined)).toBe(true);
		expect(calls.some((c) => c.method === "setStatus" && c.args[1] === undefined)).toBe(true);
	});

	it("cancelled → 清除 widget + status", () => {
		const { ui, calls } = makeUiPort(true);
		const session = createGoalSession();
		session.state = makeState({ status: "cancelled" });
		updateWidget(session, ui);
		expect(calls.some((c) => c.method === "setWidget" && c.args[1] === undefined)).toBe(true);
		expect(calls.some((c) => c.method === "setStatus" && c.args[1] === undefined)).toBe(true);
	});

	it("终态（非 cancelled）→ setStatus 终态单行 + setWidget undefined", () => {
		const { ui, calls } = makeUiPort(true);
		const session = createGoalSession();
		session.state = makeState({ status: "complete" });
		updateWidget(session, ui);
		const statusCall = calls.find((c) => c.method === "setStatus");
		expect(statusCall!.args[1]).toEqual(expect.stringContaining("✓ Completed"));
		expect(statusCall!.args[1]).toEqual(expect.stringContaining("◆ Goal")); // renderTerminalStatusLine 前缀
		expect(calls.some((c) => c.method === "setWidget" && c.args[1] === undefined)).toBe(true);
	});

	it("active → setStatus + setWidget dual payload（text 臂正常渲染）", () => {
		const { ui, calls } = makeUiPort(true);
		const session = createGoalSession();
		session.state = makeState({ status: "active" });
		updateWidget(session, ui);
		const statusCall = calls.find((c) => c.method === "setStatus");
		expect(statusCall!.args[1]).toEqual(expect.stringContaining("◆"));
		expect(statusCall!.args[1]).toEqual(expect.stringContaining("Turn"));
		const widgetCall = calls.find((c) => c.method === "setWidget");
		const payload = widgetCall!.args[1] as { gui: unknown; text: string[] };
		expect(payload.text).toEqual(expect.arrayContaining([expect.stringContaining("Token:")]));
	});
});

// ── updateWidget dual payload（gui 臂 = projection/gui.ts buildGoalGui 信封）──

describe("updateWidget dual payload（gui 臂）", () => {
	it("active + 有预算 → gui 臂 v1.1 信封（group + meta.progress）", () => {
		const { ui, calls } = makeUiPort(true);
		const session = createGoalSession();
		session.state = makeState({ status: "active", budget: { tokenBudget: 10000 } });
		updateWidget(session, ui);
		const widgetCall = calls.find((c) => c.method === "setWidget" && c.args[0] === "goal");
		const payload = widgetCall!.args[1] as {
			gui: { component: { type: string }; meta: { title: string; progress?: { total: number } } };
			text: string[];
		};
		// v1.1：gui 臂整个 GuiRenderResult（group 组合根 + meta 宿主元数据，head 由壳层渲染）
		expect(payload.gui.component.type).toBe("group");
		expect(payload.gui.meta.progress).toMatchObject({ total: 10000 });
		// text 臂同步构造（TUI 渲染行）
		expect(payload.text.length).toBeGreaterThan(0);
	});

	it("active 无预算 → gui 臂 meta 无 progress", () => {
		const { ui, calls } = makeUiPort(true);
		const session = createGoalSession();
		session.state = makeState({ status: "active" });
		updateWidget(session, ui);
		const widgetCall = calls.find((c) => c.method === "setWidget" && c.args[0] === "goal");
		const payload = widgetCall!.args[1] as {
			gui: { component: { type: string }; meta: { title: string; progress?: unknown } };
		};
		expect(payload.gui.component.type).toBe("group");
		expect(payload.gui.meta.progress).toBeUndefined();
	});
});
