/**
 * goal_control tool — execute handler 级测试（M17 后：tool result 无 __gui__）
 *
 * 覆盖场景：
 * - RPC 模式 create/complete/report_blocked → details 无 __gui__ 字段（状态展示改由
 *   handle* 内 updateWidget 经 guiSetWidget 推送 M17 对话流 widget 面板）
 * - RPC 模式 + session.state = null → 前置 handler throw（分支不可达）
 * - 非 RPC 模式（tui/json/print）→ details 同样无 __gui__，content 文本正常
 *
 * 范式参考 ask-user/src/__tests__/index.test.ts R-1~R-7（handler 级：注册 → 捕获 → 直接调 execute）。
 * 不 mock handleCreate：走真实 createGoal 让 session.state 含完整字段（slug/objective/budget），
 * 避免 hand-rolled state 与生产路径不一致。pi/ctx 用最小 fake（对齐 index.test.ts makeFactoryFixture）。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { registerGoalControlTool, type GoalControlDetails } from "../adapters/goal-control-adapter";
import { createGoalSession } from "../session";

// ── Types ─────────────────────────────────────────────

type ExecuteResult = {
	content: Array<{ type: "text"; text: string }>;
	details: GoalControlDetails;
};

interface CapturedTool {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: ExtensionContext,
	) => Promise<ExecuteResult>;
}

// ── Fake pi + ctx（最小化，对齐 index.test.ts 的 makeFactoryFixture）──

interface FakeFixture {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	notifications: Array<{ text: string; level: string }>;
}

/**
 * 构造最小 fake pi / ctx。ctx.mode 由调用方覆盖（默认 "rpc"）。
 *
 * ports.ts 的 buildPorts 读 ctx.ui.theme.fg/bold、ctx.ui.setWidget/setStatus/notify、
 * ctx.sessionManager.getEntries、ctx.hasUI——全部 mock。
 */
function makeFixture(mode: "rpc" | "tui" | "json" | "print" = "rpc"): FakeFixture {
	const notifications: Array<{ text: string; level: string }> = [];
	const pi = {
		registerTool: () => {},
		on: () => {},
		registerCommand: () => {},
		registerMessageRenderer: () => {},
		appendEntry: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
	} as unknown as ExtensionAPI;

	const ctx = {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		signal: undefined as AbortSignal | undefined,
		cwd: "/tmp",
		getContextUsage: () => null,
		ui: {
			notify: (text: string, level: string) => {
				notifications.push({ text, level });
			},
			setStatus: () => {},
			setWidget: () => {},
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
		sessionManager: { getEntries: () => [], getBranch: () => undefined },
	} as unknown as ExtensionContext;

	return { pi, ctx, notifications };
}

/** 注册 tool 并捕获其 execute handler。 */
function captureTool(pi: ExtensionAPI): CapturedTool {
	let captured: CapturedTool | undefined;
	const capturePi = {
		...pi,
		registerTool(tool: CapturedTool): void {
			captured = tool;
		},
	} as unknown as ExtensionAPI;
	registerGoalControlTool(capturePi, createGoalSession());
	if (!captured) throw new Error("registerGoalControlTool did not register a tool");
	return captured;
}

/** 调一次 create 让 session 持有带 budget 的 active state（走真实路径，state 字段完整）。 */
function createViaHandler(
	tool: CapturedTool,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: { slug: string; objective: string; tokenBudget?: number },
): Promise<ExecuteResult> {
	return tool.execute(
		"call-1",
		{ action: "create", successCriteria: ["tests pass"], ...params },
		undefined,
		undefined,
		ctx,
	);
}

// ── 测试场景 ─────────────────────────────────────────

describe("goal_control execute — RPC 模式 tool result 无 __gui__", () => {
	it("RPC + 有 budget 的 create → details 无 __gui__ 字段（content 仍正常）", async () => {
		const { pi, ctx } = makeFixture("rpc");
		const tool = captureTool(pi);
		const result = await createViaHandler(tool, pi, ctx, {
			slug: "rpc-card",
			objective: "rpc card goal",
			tokenBudget: 10000,
		});
		expect("__gui__" in result.details).toBe(false);
		expect(result.details.action).toBe("create");
		expect(result.details.status).toBe("active");
		expect(result.content[0].text).toContain("Goal created");
	});

	it("RPC + 无 budget 的 create → details 无 __gui__ 字段", async () => {
		const { pi, ctx } = makeFixture("rpc");
		const tool = captureTool(pi);
		const result = await createViaHandler(tool, pi, ctx, {
			slug: "rpc-stats",
			objective: "rpc stats goal",
		});
		expect("__gui__" in result.details).toBe(false);
		expect(result.details.action).toBe("create");
	});

	it("RPC + session.state = null → 前置 handler throw（分支不可达）", async () => {
		// execute 路径上，create 总会 set session.state；complete/report_blocked 前置守卫
		// 要求 session.state 非 null 否则 throw——所以 session.state=null 时不会走到返回路径。
		// 验证：全新 session（state=null）下，complete 前置守卫先 throw。
		const { pi, ctx } = makeFixture("rpc");
		let captured: CapturedTool | undefined;
		const capturePi = {
			...pi,
			registerTool(tool: CapturedTool): void {
				captured = tool;
			},
		} as unknown as ExtensionAPI;
		registerGoalControlTool(capturePi, createGoalSession());
		const tool2 = captured!;
		// complete 在 state=null 时 throw（handleComplete 前置守卫）
		await expect(
			tool2.execute(
				"id",
				{ action: "complete", evidence: "x" },
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow(/not active/i);
	});

	it("RPC + complete 动作 → details 无 __gui__ 字段（终态 status 正确）", async () => {
		const { pi, ctx } = makeFixture("rpc");
		const tool = captureTool(pi);
		// 先 create（建 active state）
		await createViaHandler(tool, pi, ctx, { slug: "comp", objective: "to complete" });
		// 再 complete —— session.state.status=complete
		const result = await tool.execute(
			"call-2",
			{ action: "complete", evidence: "tests green" },
			undefined,
			undefined,
			ctx,
		);
		expect(result.details.status).toBe("complete");
		expect("__gui__" in result.details).toBe(false);
	});

	it("RPC + report_blocked 动作 → details 无 __gui__ 字段（blocked status 正确）", async () => {
		const { pi, ctx } = makeFixture("rpc");
		const tool = captureTool(pi);
		await createViaHandler(tool, pi, ctx, { slug: "blk", objective: "to block" });
		const result = await tool.execute(
			"call-3",
			{ action: "report_blocked", reason: "stuck on dependency" },
			undefined,
			undefined,
			ctx,
		);
		expect(result.details.status).toBe("blocked");
		expect("__gui__" in result.details).toBe(false);
	});

});

// ── 边界：非 RPC 模式（tui/json/print）同样无 __gui__ ──

describe("goal_control execute — 非 RPC 模式无 __gui__", () => {
	const NON_RPC_MODES: Array<"tui" | "json" | "print"> = ["tui", "json", "print"];
	it.each(NON_RPC_MODES)("%s 模式 → details 无 __gui__ 字段（content 仍正常）", async (mode) => {
		const { pi, ctx } = makeFixture(mode);
		const tool = captureTool(pi);
		const result = await createViaHandler(tool, pi, ctx, {
			slug: `${mode}-mode`,
			objective: `${mode} goal`,
			tokenBudget: 1000,
		});
		expect("__gui__" in result.details).toBe(false);
		expect(result.content[0].text).toContain("Goal created");
	});
});
