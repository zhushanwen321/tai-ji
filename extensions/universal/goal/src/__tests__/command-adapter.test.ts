/**
 * command-adapter.ts 测试 — /goal 子命令（FR-3 pause/resume 对称；#1 删除 abort + task CRUD）
 *
 * 覆盖：
 * - FR-3: pause（active→paused tick 前置）+ resume（paused/blocked→active 对称 + budget 重检）
 * - MF-3 回归：clear/set-overwrite 转 cancelled 前 tick 累加时间
 * - MF-6 覆盖：命令分发 + 各 FR 分支（G-R2-008/G-014/G-002）
 *
 * 用 fake pi + fake ctx（不 import Pi SDK 真实实现）。
 * handleGoalCommand(pi, session, args, ctx) → Promise<void>。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { handleGoalCommand } from "../adapters/command-adapter";
import {
	MAX_HISTORY_ENTRIES,
	OBJECTIVE_DISPLAY_LIMIT,
	OBJECTIVE_TRUNCATE_KEEP,
} from "../constants";
import { parseGoalArgs } from "../commands";
import { createGoalState } from "../engine/goal";
import type { GoalRuntimeState } from "../engine/types";
import type { GoalHistoryEntry, SessionEntryLike } from "../ports";
import { createGoalSession } from "../session";

// ── Fake pi / ctx ────────────────────────────────────

interface RecordedCall {
	kind: "appendState" | "appendHistory" | "notify" | "sendContext" | "sendUser";
	text?: string;
	level?: string;
	content?: string;
	deliverAs?: string;
	customType?: string;
	payload?: unknown;
}

interface FakeHarness {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	states: unknown[];
	history: unknown[];
	piCalls: RecordedCall[];
	ctxCalls: RecordedCall[];
}

function makeHarness(entries: SessionEntryLike[] = []): FakeHarness {
	const piCalls: RecordedCall[] = [];
	const ctxCalls: RecordedCall[] = [];
	const states: unknown[] = [];
	const history: unknown[] = [];

	const pi = {
		appendEntry(customType: string, data?: unknown): void {
			if (customType === "goal-history") history.push(data);
			else states.push(data);
			piCalls.push({
				kind: customType === "goal-history" ? "appendHistory" : "appendState",
				payload: data,
			});
		},
		sendMessage(message: unknown, _options?: unknown): void {
			const msg = message as { customType?: string; content?: string };
			piCalls.push({ kind: "sendContext", content: msg.content, customType: msg.customType });
		},
		sendUserMessage(content: string | unknown[], _options?: unknown): void {
			piCalls.push({ kind: "sendUser", content: typeof content === "string" ? content : undefined });
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		hasUI: true,
		signal: { aborted: false } as AbortSignal,
		getContextUsage: () => null,
		ui: {
			notify: (text: string, level: string) => ctxCalls.push({ kind: "notify", text, level }),
			setStatus: () => {},
			setWidget: () => {},
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
		sessionManager: { getEntries: () => entries, getBranch: () => undefined },
	} as unknown as ExtensionContext;

	return { pi, ctx, states, history, piCalls, ctxCalls };
}

// ── 辅助 ─────────────────────────────────────────────

function makeActiveState(overrides?: Partial<GoalRuntimeState>): GoalRuntimeState {
	return {
		...createGoalState("test objective"),
		status: "active",
		timeStartedAt: 0, // 默认关闭时间累计
		...overrides,
	};
}

// 构造 goal-history custom entry（模拟 Pi sessionManager.getEntries 返回的 append-only 历史）
function makeHistoryEntries(...overrides: Partial<GoalHistoryEntry>[]): SessionEntryLike[] {
	return overrides.map((o, i) => {
		const data: GoalHistoryEntry = {
			goalId: `g${i}`,
			objective: `objective ${i}`,
			status: "complete",
			elapsedSeconds: 60,
			timestamp: 1000 + i,
			...o,
		};
		return { type: "custom", customType: "goal-history", data };
	});
}

function allCalls(h: FakeHarness): RecordedCall[] {
	return [...h.piCalls, ...h.ctxCalls];
}

function notifyText(h: FakeHarness): string[] {
	return allCalls(h)
		.filter((c) => c.kind === "notify")
		.map((c) => c.text ?? "");
}

// ── /goal status ─────────────────────────────────────

describe("handleGoalCommand — status", () => {
	it("无 active goal → 提示未激活", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		await handleGoalCommand(h.pi, session, "status", h.ctx);
		expect(notifyText(h)[0]).toContain("not active");
	});

	it("有 active goal → 显示 status 面板", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState();
		await handleGoalCommand(h.pi, session, "status", h.ctx);
		const text = notifyText(h).join("\n");
		expect(text).toContain("test objective");
		expect(text).toContain("Status: active");
	});

	it("U23: successCriteria 逐条编号多行显示（不再 join(\"; \") 内联）", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState({ successCriteria: ["s1", "s2"] });
		await handleGoalCommand(h.pi, session, "status", h.ctx);
		const text = notifyText(h).join("\n");
		expect(text).toContain("Success criteria:");
		expect(text).toContain("1. s1");
		expect(text).toContain("2. s2");
		// 旧形态（分号拼接内联一行）不再出现
		expect(text).not.toContain("s1; s2");
	});
});

// ── /goal pause（FR-3 用户暂停 active→paused）──

describe("handleGoalCommand — pause (FR-3 active→paused)", () => {
	it("active → paused：tick 前置累加 + persist + notify", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		const past = Date.now() - 4000;
		session.state = makeActiveState({ timeStartedAt: past, timeUsedSeconds: 6 });
		await handleGoalCommand(h.pi, session, "pause", h.ctx);
		expect(session.state!.status).toBe("paused");
		// tick 前置：转 paused 前累加当前运行段（6 + ~4s）
		expect(session.state!.timeUsedSeconds).toBeGreaterThanOrEqual(9);
		expect(h.states).toHaveLength(1); // persist 恰好 1 次
		expect(notifyText(h).join("\n")).toContain("paused");
		expect(notifyText(h).join("\n")).toContain("resume");
	});

	it("非 active（blocked）→ 拒绝 pause", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState({ status: "blocked" });
		await handleGoalCommand(h.pi, session, "pause", h.ctx);
		expect(session.state!.status).toBe("blocked"); // 未变
		expect(notifyText(h)[0]).toContain("not active");
	});

	it("无 active goal → 提示未激活", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		await handleGoalCommand(h.pi, session, "pause", h.ctx);
		expect(notifyText(h)[0]).toContain("not active");
	});
});

// ── /goal resume（FR-3：paused/blocked→active 对称 + G-014 预算重检）──

describe("handleGoalCommand — resume (FR-3 paused/blocked→active + G-014)", () => {
	const RESUME_STATUSES: GoalRuntimeState["status"][] = ["blocked", "paused"];
	it.each(RESUME_STATUSES)("resume %s → active：成功 + persist + 触发 AI（FR-3 对称）", async (status) => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState({ status });
		await handleGoalCommand(h.pi, session, "resume", h.ctx);
		expect(session.state!.status).toBe("active");
		expect(h.states).toHaveLength(1); // persist 恰好 1 次
		// FR-8.12: resume 后触发 AI
		expect(h.piCalls.filter((c) => c.kind === "sendUser")).toHaveLength(1);
	});

	it("resume 重置 timeStartedAt=now（FR-3.2 重启计时器）", async () => {
		// T2.3 显式断言：resume 时 timeStartedAt 必须重置为当前时刻（command-adapter.ts:144）
		const h = makeHarness();
		const session = createGoalSession();
		const staleTimeStartedAt = Date.now() - 100_000; // 旧值，远早于现在
		session.state = makeActiveState({ status: "paused", timeStartedAt: staleTimeStartedAt });
		const before = Date.now();
		await handleGoalCommand(h.pi, session, "resume", h.ctx);
		const after = Date.now();
		expect(session.state!.status).toBe("active");
		// timeStartedAt 已重置为 resume 调用时刻（落在 [before, after] 窗口内）
		expect(session.state!.timeStartedAt).toBeGreaterThanOrEqual(before);
		expect(session.state!.timeStartedAt).toBeLessThanOrEqual(after);
		expect(session.state!.timeStartedAt).not.toBe(staleTimeStartedAt); // 旧值已废弃
	});

	it("token 预算耗尽 → resume 转 budget_limited（G-014）", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState({
			status: "blocked",
			budget: {
				tokenBudget: 1000,
			},
			tokensUsed: 1200, // 已超 tokenBudget
		});
		await handleGoalCommand(h.pi, session, "resume", h.ctx);
		expect(session.state!.status).toBe("budget_limited");
		expect(notifyText(h)[0]).toContain("Token budget exhausted");
	});

	it("非 paused/blocked 状态（active）→ 无需 resume", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState({ status: "active" });
		await handleGoalCommand(h.pi, session, "resume", h.ctx);
		expect(notifyText(h)[0]).toContain("not paused or blocked");
	});
});

// ── /goal clear（FR-6.3 强制清）──

describe("handleGoalCommand — clear (FR-6.3)", () => {
	it("clear：强制清，写 cancelled history + clearSession", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState();
		await handleGoalCommand(h.pi, session, "clear", h.ctx);
		expect(session.state).toBeNull(); // clearGoalSession 清空
		expect(h.history.length).toBe(1); // 写 cancelled history
		expect(notifyText(h)[0]).toContain("cleared");
	});

	it("clear：MF-3 tick — active goal 转 cancelled 前累加时间", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		const past = Date.now() - 3000;
		session.state = makeActiveState({ timeStartedAt: past, timeUsedSeconds: 5 });
		await handleGoalCommand(h.pi, session, "clear", h.ctx);
		// history 里的 elapsedSeconds 应 ≈ 8（5 + 3）
		const histEntry = h.history[0] as { elapsedSeconds?: number } | undefined;
		expect(histEntry?.elapsedSeconds).toBeGreaterThanOrEqual(7);
	});
});

// ── /goal update（FR-8.4 G-002 重塑）──────────────

describe("handleGoalCommand — update (FR-8.4 G-002)", () => {
	it("重塑：重置 objective/flags/slug，保留 goalId", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		const originalGoalId = "goal-original-123";
		session.state = makeActiveState({
			goalId: originalGoalId,
			objective: "old objective",
			currentTurnIndex: 8,
			slug: "old-slug",
		});
		await handleGoalCommand(h.pi, session, "update brand new objective", h.ctx);

		expect(session.state!.objective).toBe("brand new objective");
		expect(session.state!.goalId).toBe(originalGoalId); // 保留
		expect(session.state!.currentTurnIndex).toBe(0);
		expect(session.state!.budgetLimitSteeringSent).toBe(false);
		expect(session.state!.slug).toBeUndefined(); // GAP-6: update 重置 slug
		expect(h.states).toHaveLength(1); // persist
	});

	it("无参数 → usage 提示", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState();
		await handleGoalCommand(h.pi, session, "update", h.ctx);
		expect(notifyText(h)[0]).toContain("Usage");
	});

	it("带 --criteria → 替换 successCriteria", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState({
			objective: "old objective",
			successCriteria: ["old criteria"],
		});
		await handleGoalCommand(h.pi, session, "update new obj --criteria new criteria text", h.ctx);

		expect(session.state!.objective).toBe("new obj");
		// /goal update --criteria 按分号拆分为 string[]
		expect(session.state!.successCriteria).toEqual(["new criteria text"]);
	});

	it("U22: --criteria 多条（分号分隔）→ 数组直赋值替换", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState({
			objective: "old objective",
			successCriteria: ["old criteria"],
		});
		await handleGoalCommand(h.pi, session, "update new obj --criteria new a; new b", h.ctx);

		expect(session.state!.successCriteria).toEqual(["new a", "new b"]);
	});

	it("U22 决策④: --criteria 拆分后全空（;;）→ 保留旧值（不写入 [\";;\"] 等非法数组）", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState({
			objective: "old objective",
			successCriteria: ["old criteria"],
		});
		await handleGoalCommand(h.pi, session, "update new obj --criteria ;;", h.ctx);

		expect(session.state!.objective).toBe("new obj");
		expect(session.state!.successCriteria).toEqual(["old criteria"]);
	});

	it("U22 决策④: --criteria 值拆分后全空（空格分号）→ 保留旧值", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState({
			objective: "old objective",
			successCriteria: ["old criteria"],
		});
		// 注：纯尾随空白（`--criteria  `）在 parse 层被 trim 后 flag 不匹配、
		// 并入 objective（既有语义）；此处用「分隔符后仅空白+分号」构造拆分后全空
		await handleGoalCommand(h.pi, session, "update new obj --criteria  ;", h.ctx);

		expect(session.state!.objective).toBe("new obj");
		expect(session.state!.successCriteria).toEqual(["old criteria"]);
	});

	it("U22: 条目含换行 → throw 带 Correct: 正例，且 state 重塑字段不动（校验前置）", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState({
			objective: "old objective",
			slug: "old-slug",
			successCriteria: ["old criteria"],
		});
		// 单段内含换行（无分号）→ parse 拆为一条含 \n 的条目，handleUpdate 校验拒绝
		await expect(
			handleGoalCommand(h.pi, session, "update new obj --criteria line1\nline2", h.ctx),
		).rejects.toThrow(/single-line[\s\S]*Correct:/);

		expect(session.state!.objective).toBe("old objective");
		expect(session.state!.slug).toBe("old-slug");
		expect(session.state!.successCriteria).toEqual(["old criteria"]);
		expect(h.states).toHaveLength(0); // 未 persist
	});

	it("不带 --criteria → 保留旧 successCriteria（不静默丢失验证标准）", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState({
			objective: "old objective",
			successCriteria: ["old criteria"],
		});
		await handleGoalCommand(h.pi, session, "update new obj", h.ctx);

		expect(session.state!.objective).toBe("new obj");
		expect(session.state!.successCriteria).toEqual(["old criteria"]);
	});

	it("active 状态重塑 → 注入 objectiveUpdated steering", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState({ objective: "old" });
		await handleGoalCommand(h.pi, session, "update new obj", h.ctx);
		// FR-8.4: active 时发送 steering
		expect(h.piCalls.filter((c) => c.kind === "sendContext")).toHaveLength(1);
	});
});

// ── parseGoalArgs — --criteria 分号拆分（U20/U21）──

describe("parseGoalArgs — --criteria 分号拆分（U20/U21）", () => {
	it("U20: 分号多段 → 逐段 trim + 去空段（\"a; b; c\" → [\"a\",\"b\",\"c\"]）", () => {
		const parsed = parseGoalArgs("update new obj --criteria a; b; c");
		expect(parsed.action).toBe("update");
		expect(parsed.objective).toBe("new obj");
		expect(parsed.criteria).toEqual(["a", "b", "c"]);
	});

	it("U20: 单段 → 单元素数组（\"single\" → [\"single\"]）", () => {
		const parsed = parseGoalArgs("update new obj --criteria single");
		expect(parsed.criteria).toEqual(["single"]);
	});

	it("U21: 连续分号 → 空段被过滤（\"a;;b\" → [\"a\",\"b\"]）", () => {
		const parsed = parseGoalArgs("update new obj --criteria a;;b");
		expect(parsed.criteria).toEqual(["a", "b"]);
	});

	it("U21 决策④: 拆分后全空（\";;\"）→ criteria undefined（不产出空数组）", () => {
		const parsed = parseGoalArgs("update new obj --criteria ;;");
		expect(parsed.criteria).toBeUndefined();
	});
});

// ── parseGoalArgs — 子命令路由（表驱动 + update/set 分支）──

describe("parseGoalArgs — 子命令路由", () => {
	it("空串 / status → status", () => {
		expect(parseGoalArgs("")).toEqual({ action: "status" });
		expect(parseGoalArgs("   ")).toEqual({ action: "status" });
		expect(parseGoalArgs("STATUS")).toEqual({ action: "status" });
	});

	it.each(["resume", "pause", "clear", "history"] as const)(
		"%s（含大小写混写）→ 对应 action",
		(action) => {
			expect(parseGoalArgs(action)).toEqual({ action });
			expect(parseGoalArgs(`  ${action.toUpperCase()} `)).toEqual({ action });
		},
	);

	it("update 无参 → { action: update }（无 objective，上层报错）", () => {
		expect(parseGoalArgs("update")).toEqual({ action: "update" });
		expect(parseGoalArgs("UPDATE")).toEqual({ action: "update" });
	});

	it("update 带 objective（无 --criteria）→ objective 全量保留", () => {
		expect(parseGoalArgs("update ship v2 --draft")).toEqual({
			action: "update",
			objective: "ship v2 --draft",
		});
	});

	it("update 仅接 --criteria（分隔标记要求前导空白）→ 整体作 objective（锚定现状）", () => {
		const parsed = parseGoalArgs("update --criteria a;b");
		expect(parsed.action).toBe("update");
		expect(parsed.objective).toBe("--criteria a;b");
		expect(parsed.criteria).toBeUndefined();
	});

	it("未知文本 → set 路径：objective 剥 --tokens flag + budget 透传", () => {
		expect(parseGoalArgs("write docs --tokens 3000")).toEqual({
			action: "set",
			objective: "write docs",
			budget: { tokenBudget: 3000 },
		});
		expect(parseGoalArgs("write docs")).toEqual({
			action: "set",
			objective: "write docs",
			budget: {},
		});
	});

	it("仅 --tokens（剥空 objective）→ status（非 set）", () => {
		expect(parseGoalArgs("--tokens 500")).toEqual({ action: "status" });
	});

	it("原型链键名（constructor 等）不命中路由表 → set 路径", () => {
		const parsed = parseGoalArgs("constructor");
		expect(parsed.action).toBe("set");
		expect(parsed.objective).toBe("constructor");
	});
});

// ── /goal set（提示词触发器：sendUserMessage 让 AI 调 goal_control create）──

describe("handleGoalCommand — set (提示词触发器 + #11/D25 拒绝非终态)", () => {
	it("无旧 goal → 发触发消息（不直接创建 state）", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		await handleGoalCommand(h.pi, session, "my objective", h.ctx);
		// 提示词触发器：不直接 createGoal，state 仍为 null（由 AI 后续 toolcall 创建）
		expect(session.state).toBeNull();
		expect(h.states).toHaveLength(0); // 不写 state
		// 发送 sendUserMessage 引导 AI 调 create
		const sendUserCalls = h.piCalls.filter((c) => c.kind === "sendUser");
		expect(sendUserCalls).toHaveLength(1);
		expect(sendUserCalls[0]?.content).toContain("my objective");
		expect(sendUserCalls[0]?.content).toContain("goal_control");
	});

	const SET_REJECT_STATUSES: GoalRuntimeState["status"][] = ["active", "paused"];
	it.each(SET_REJECT_STATUSES)(
		"非终态旧 goal（%s）→ 拒绝 + 提示，不发触发消息（#11/D25）",
		async (status) => {
			const h = makeHarness();
			const session = createGoalSession();
			session.state = makeActiveState({ status, objective: `old ${status} goal` });
			const historyBefore = h.history.length;
			await handleGoalCommand(h.pi, session, "new objective", h.ctx);
			// #11: 拒绝，不写 history，不覆盖旧 goal，不发触发消息
			expect(h.history.length).toBe(historyBefore); // 不写 history
			expect(notifyText(h).join("\n")).toContain("Goal already active");
			expect(notifyText(h).join("\n")).toContain("resume");
			expect(notifyText(h).join("\n")).toContain("clear");
			expect(session.state!.status).toBe(status); // 状态不变
			expect(session.state!.objective).toBe(`old ${status} goal`); // 旧 goal 保留
			expect(h.piCalls.filter((c) => c.kind === "sendUser")).toHaveLength(0); // 不触发 AI
		},
	);

	it("终态旧 goal → 发触发消息（AI 会覆盖终态 goal）", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState({ status: "complete", objective: "old done" });
		const historyBefore = h.history.length;
		await handleGoalCommand(h.pi, session, "new objective", h.ctx);
		expect(h.history.length).toBe(historyBefore); // 不写 history（触发器不直接创建）
		// 终态旧 goal 不挡触发器，发消息让 AI 创建
		expect(h.piCalls.filter((c) => c.kind === "sendUser")).toHaveLength(1);
	});

	it("空 objective → usage 提示", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		// parseGoalArgs("") → { action: "status" }，空字符串走 status 路径
		await handleGoalCommand(h.pi, session, "", h.ctx);
		// 空字符串在 parseGoalArgs 里被识别为 status，不是 set；status 路径提示 "not active"
		expect(notifyText(h)[0]).toContain("not active");
	});

	it("--tokens 0 → parseGoalArgs 过滤（val > 0 校验），发触发消息", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		// parseGoalArgs 对 --tokens 0 的 val>0 校验失败，budget.tokenBudget 不设置
		// handleSet 收到 budgetOverrides=undefined（无 tokenBudget），发触发消息（objective 去掉了 flag）
		await handleGoalCommand(h.pi, session, "obj --tokens 0", h.ctx);
		// 提示词触发器不直接创建 state
		expect(session.state).toBeNull();
		const sendUserCalls = h.piCalls.filter((c) => c.kind === "sendUser");
		expect(sendUserCalls).toHaveLength(1);
		expect(sendUserCalls[0]?.content).toContain("obj");
	});

	it("--tokens N → 触发消息含 budget 值", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		await handleGoalCommand(h.pi, session, "obj --tokens 5000", h.ctx);
		const sendUserCalls = h.piCalls.filter((c) => c.kind === "sendUser");
		expect(sendUserCalls).toHaveLength(1);
		expect(sendUserCalls[0]?.content).toContain("5000");
	});
});

// ── /goal history ────────────────────────────────────

describe("handleGoalCommand — history", () => {
	it("无 history → 提示 No goal history", async () => {
		const h = makeHarness();
		await handleGoalCommand(h.pi, createGoalSession(), "history", h.ctx);
		expect(notifyText(h).some((t) => t.includes("No goal history"))).toBe(true);
	});

	// icon 映射 + duration + status 三件套（核心渲染分支，原零覆盖）
	it.each([
		["complete → ✓", "complete", "✓"],
		["cancelled → ✗", "cancelled", "✗"],
		["budget_limited → ⊗", "budget_limited", "⊗"],
		["未知 status → ?", "active", "?"],
	])("有 history → notify 含 icon + duration + status（%s）", async (_name, status, icon) => {
		const entries = makeHistoryEntries({
			status,
			objective: `${status} goal`,
			elapsedSeconds: 90,
		});
		const h = makeHarness(entries);
		await handleGoalCommand(h.pi, createGoalSession(), "history", h.ctx);
		const text = notifyText(h).join("\n");
		expect(text).toContain(icon);
		expect(text).toContain(`| ${status}`);
		expect(text).toContain("1m30s"); // formatDuration(90) = 始终带秒
	});

	it("有 slug → 标题用 slug（不显示 objective）", async () => {
		const entries = makeHistoryEntries({
			slug: "my-slug",
			objective: "ignored long objective text",
		});
		const h = makeHarness(entries);
		await handleGoalCommand(h.pi, createGoalSession(), "history", h.ctx);
		const text = notifyText(h).join("\n");
		expect(text).toContain("my-slug");
		expect(text).not.toContain("ignored long objective text");
	});

	it("无 slug + 长 objective → 截断到 OBJECTIVE_TRUNCATE_KEEP + ...", async () => {
		const long = "x".repeat(OBJECTIVE_DISPLAY_LIMIT + 10);
		const entries = makeHistoryEntries({ objective: long, slug: undefined });
		const h = makeHarness(entries);
		await handleGoalCommand(h.pi, createGoalSession(), "history", h.ctx);
		const text = notifyText(h).join("\n");
		expect(text).toContain(`${"x".repeat(OBJECTIVE_TRUNCATE_KEEP)}...`);
	});

	it("多条 history → 倒序渲染（最近在前）+ 序号 1..N", async () => {
		const entries = makeHistoryEntries({ slug: "first" }, { slug: "second" }, { slug: "third" });
		const h = makeHarness(entries);
		await handleGoalCommand(h.pi, createGoalSession(), "history", h.ctx);
		const text = notifyText(h).join("\n");
		// reverse: third（最后插入=最近）排第一
		expect(text.indexOf("third")).toBeLessThan(text.indexOf("first"));
		expect(text).toContain("1. "); // 序号格式
	});

	it("超过 MAX_HISTORY_ENTRIES → 只显示最近 N 条（最旧被截断）", async () => {
		const entries = makeHistoryEntries(
			...Array.from({ length: MAX_HISTORY_ENTRIES + 5 }, (_, i) => ({ slug: `slug-${i}` })),
		);
		const h = makeHarness(entries);
		await handleGoalCommand(h.pi, createGoalSession(), "history", h.ctx);
		const text = notifyText(h).join("\n");
		// slice(-MAX) 后 reverse：最近一条（slug-24）排第一，第 5 条（slug-5）是保留的最旧一条
		expect(text).toContain("slug-24");
		expect(text).toContain("slug-5");
		// 最旧 5 条（slug-0..slug-4）被截断
		expect(text).not.toContain("slug-0");
		expect(text).not.toContain("slug-4");
	});
});
