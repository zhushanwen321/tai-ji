/**
 * goal_control 收起态摘要测试：buildGoalControlSummary 三分支文案 + execute 补齐
 * details.summary + renderResult 折叠/展开/旧形态回退。
 *
 * mock 形态对齐 goal-control-rpc.test.ts（捕获 registerTool 后直接调 execute/renderResult）。
 */
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
	buildGoalControlSummary,
	registerGoalControlTool,
	type GoalControlDetails,
} from "../adapters/goal-control-adapter";
import { createGoalSession } from "../session";

// ── mock：logger + updateWidget（与 rpc 测试同款 no-op）──
vi.mock("@zhushanwen/pi-extension-logger", () => ({
	getLogger: () => ({ warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
vi.mock("../projection/widget", () => ({ updateWidget: vi.fn() }));

// ── buildGoalControlSummary ──────────────────────────

describe("buildGoalControlSummary", () => {
	it("create → Goal created: <slug>", () => {
		const details = { action: "create", goalId: "g1", status: "active", slug: "refactor-auth" } as GoalControlDetails;
		expect(buildGoalControlSummary({ action: "create" } as never, details)).toBe(
			"Goal created: refactor-auth",
		);
	});

	it("create 无 slug → 省略后缀", () => {
		const details = { action: "create", goalId: "g1", status: "active" } as GoalControlDetails;
		expect(buildGoalControlSummary({ action: "create" } as never, details)).toBe("Goal created");
	});

	it("complete → Goal completed: <goalId>（complete 的 details 无 slug）", () => {
		const details = { action: "complete", goalId: "abc123", status: "complete" } as GoalControlDetails;
		expect(buildGoalControlSummary({ action: "complete" } as never, details)).toBe(
			"Goal completed: abc123",
		);
	});

	it("report_blocked → Blocked: <reason 首 40 字>（超长加省略号）", () => {
		const details = { action: "report_blocked", goalId: "g1", status: "blocked" } as GoalControlDetails;
		const params = { action: "report_blocked", reason: "等待上游 API 修复" } as never;
		expect(buildGoalControlSummary(params, details)).toBe("Blocked: 等待上游 API 修复");

		const long = "x".repeat(50);
		expect(buildGoalControlSummary({ action: "report_blocked", reason: long } as never, details)).toBe(
			`Blocked: ${"x".repeat(40)}…`,
		);
	});

	it("report_blocked 无 reason → 省略后缀", () => {
		const details = { action: "report_blocked", goalId: "g1", status: "blocked" } as GoalControlDetails;
		expect(buildGoalControlSummary({ action: "report_blocked" } as never, details)).toBe("Blocked");
	});
});

// ── execute 补齐 details.summary + renderResult ──────

interface CapturedTool {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: ExtensionContext,
	) => Promise<{ content: Array<{ type: "text"; text: string }>; details: GoalControlDetails }>;
	renderResult: (result: unknown, options: { expanded: boolean }, theme: Theme) => { content: unknown };
}

function captureTool(): CapturedTool {
	let captured: CapturedTool | undefined;
	const pi = {
		registerTool(tool: CapturedTool): void {
			captured = tool;
		},
		on: () => {},
		appendEntry: () => {},
		notify: () => {},
	} as unknown as ExtensionAPI;
	registerGoalControlTool(pi, createGoalSession());
	if (!captured) throw new Error("registerGoalControlTool did not register a tool");
	return captured;
}

const ctx = {
	mode: "rpc",
	hasUI: true,
	ui: {
		theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		setWidget: () => {},
		setStatus: () => {},
		notify: () => {},
	},
	sessionManager: { getEntries: () => [] },
} as unknown as ExtensionContext;

describe("goal_control execute details.summary", () => {
	it("create → details 带现有字段 + summary", async () => {
		const tool = captureTool();
		const res = await tool.execute(
			"id",
			{
				action: "create",
				slug: "refactor-auth",
				objective: "refactor the auth module",
				successCriteria: ["tests pass"],
			},
			undefined,
			undefined,
			ctx,
		);
		expect(res.details).toMatchObject({
			action: "create",
			status: "active",
			slug: "refactor-auth",
			summary: "Goal created: refactor-auth",
		});
	});

	it("report_blocked → details.summary 带 reason 首段", async () => {
		const tool = captureTool();
		const create = await tool.execute(
			"id",
			{ action: "create", slug: "g", objective: "obj", successCriteria: ["c"] },
			undefined,
			undefined,
			ctx,
		);
		void create;
		const res = await tool.execute(
			"id",
			{ action: "report_blocked", reason: "blocked by missing credentials" },
			undefined,
			undefined,
			ctx,
		);
		expect(res.details).toMatchObject({
			action: "report_blocked",
			status: "blocked",
			summary: "Blocked: blocked by missing credentials",
		});
	});
});

// ── renderResult 分态 ────────────────────────────────

const mockTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	inverse: (text: string) => text,
	strikethrough: (text: string) => text,
	getFgAnsi: (_color: string) => "",
	getBgAnsi: (_color: string) => "",
	getColorMode: () => "truecolor" as const,
	getThinkingBorderColor: () => (text: string) => text,
	getBashModeBorderColor: () => (text: string) => text,
} as unknown as Theme;

describe("goal_control renderResult", () => {
	const tool = captureTool();

	it("折叠态 → details.summary 一行（dim）", () => {
		const result = {
			content: [{ type: "text", text: "Goal created.\nGoal ID: g1" }],
			details: { action: "create", goalId: "g1", status: "active", slug: "refactor-auth", summary: "Goal created: refactor-auth" },
		};
		expect(tool.renderResult(result, { expanded: false }, mockTheme).content).toBe(
			"Goal created: refactor-auth",
		);
	});

	it("展开态 → content 纯文本（多行）", () => {
		const result = {
			content: [{ type: "text", text: "Goal created.\nGoal ID: g1" }],
			details: { action: "create", goalId: "g1", status: "active", slug: "refactor-auth", summary: "Goal created: refactor-auth" },
		};
		expect(tool.renderResult(result, { expanded: true }, mockTheme).content).toBe(
			"Goal created.\nGoal ID: g1",
		);
	});

	it("旧 entry 无 summary → 折叠态回退 ◆ 状态行", () => {
		const result = {
			content: [{ type: "text", text: "Goal created." }],
			details: { action: "complete", goalId: "g1", status: "complete" },
		};
		expect(tool.renderResult(result, { expanded: false }, mockTheme).content).toBe(
			"◆ Goal Completed",
		);
	});
});
