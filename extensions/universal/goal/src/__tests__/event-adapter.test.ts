/**
 * event-handlers 行为测试 — agent_end / before_agent_start 核心逻辑
 *
 * 覆盖 agent_end 的 continuation + ESC 守卫（FR-6.7）+
 * before_agent_start 的 AUTO_CLEAR/context wrap-up。
 *
 * 全解耦后不再测 allTasksDone followUp（原依赖 pi.__todoGetList，已删）。
 * agent_end 流程简化为：budget 检查 → continuation 去抖。
 *
 * 用 fake pi + fake ctx（不 import Pi SDK）。handler 签名 (pi, session, ctx) → void/result。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { handleAgentEnd } from "../adapters/event-handlers/agent-end";
import { handleBeforeAgentStart } from "../adapters/event-handlers/before-agent-start";
import { createGoalState } from "../engine/goal";
import type { GoalRuntimeState } from "../engine/types";
import { createGoalSession } from "../session";

// ── Fake pi / ctx ────────────────────────────────────

interface RecordedCall {
	kind: "appendState" | "appendHistory" | "notify" | "sendContext" | "sendUser" | "setStatus" | "setWidget";
	payload?: unknown;
	text?: string;
	level?: string;
	content?: string;
	deliverAs?: string;
	customType?: string;
	key?: string;
}

function makeFakePi(): { pi: ExtensionAPI; calls: RecordedCall[]; states: unknown[]; history: unknown[] } {
	const calls: RecordedCall[] = [];
	const states: unknown[] = [];
	const history: unknown[] = [];
	const pi = {
		appendEntry(customType: string, data?: unknown): void {
			calls.push({ kind: customType === "goal-history" ? "appendHistory" : "appendState", payload: data });
			if (customType === "goal-history") history.push(data);
			else states.push(data);
		},
		sendMessage(message: unknown, _options?: unknown): void {
			const msg = message as { customType?: string; content?: string; display?: boolean };
			calls.push({
				kind: "sendContext",
				content: msg.content,
				customType: msg.customType,
				payload: _options,
			});
		},
		sendUserMessage(content: string | unknown[], options?: unknown): void {
			calls.push({
				kind: "sendUser",
				content: typeof content === "string" ? content : undefined,
				payload: options,
			});
		},
	} as unknown as ExtensionAPI;
	return { pi, calls, states, history };
}

function makeFakeCtx(overrides?: {
	aborted?: boolean;
	hasUI?: boolean;
	contextUsage?: { tokens?: number; contextWindow?: number };
	entries?: unknown[];
}): { ctx: ExtensionContext; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const signal = { aborted: overrides?.aborted ?? false } as AbortSignal;
	const ctx = {
		hasUI: overrides?.hasUI ?? true,
		signal,
		getContextUsage: () => overrides?.contextUsage,
		ui: {
			notify: (text: string, level: string) => {
				calls.push({ kind: "notify", text, level });
			},
			setStatus: (key: string, text: string | undefined) => {
				calls.push({ kind: "setStatus", key, text });
			},
			setWidget: (key: string, _content: unknown) => {
				calls.push({ kind: "setWidget", key });
			},
			theme: {
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			},
		},
		sessionManager: { getEntries: () => overrides?.entries ?? [], getBranch: () => undefined, getSessionId: () => "test-session" },
	} as unknown as ExtensionContext;
	return { ctx, calls };
}

function allCalls(piCalls: RecordedCall[], ctxCalls: RecordedCall[]): RecordedCall[] {
	return [...piCalls, ...ctxCalls];
}

// ── 辅助：构造 state ──────────────────────────────────

function makeRunningState(overrides?: Partial<GoalRuntimeState>): GoalRuntimeState {
	return {
		...createGoalState("test objective"),
		timeStartedAt: 0, // 关闭时间累计（避免测试随机性）
		...overrides,
	};
}

// ── handleAgentEnd：ESC 守卫 ──────────────────────────

describe("handleAgentEnd — FR-6.7 ESC 守卫", () => {
	it("aborted=true：不发 continuation、不做 budget 检查、goal 保持 active", async () => {
		const { pi, calls: piCalls, states } = makeFakePi();
		const { ctx, calls: ctxCalls } = makeFakeCtx({ aborted: true });
		const session = createGoalSession();
		session.state = makeRunningState({ tokensUsed: 1000, lastTurnTokensUsed: 0 });

		await handleAgentEnd(pi, session, ctx);
		const all = allCalls(piCalls, ctxCalls);

		// 不发 continuation（无 sendContext/sendUser）
		expect(all.filter((c) => c.kind === "sendContext" || c.kind === "sendUser")).toHaveLength(0);
		// 不做 budget 检查（无 notify 关于 budget）
		expect(all.filter((c) => c.kind === "notify")).toHaveLength(0);
		// goal 保持 active（status 不变）
		expect(session.state!.status).toBe("active");
		// 不 persist（ESC 不触发副作用）
		expect(states).toHaveLength(0);
	});

	it("aborted=true + 终态：仍走终态 notify（ESC 不影响终态路径）", async () => {
		const { pi, calls: piCalls } = makeFakePi();
		const { ctx, calls: ctxCalls } = makeFakeCtx({ aborted: true });
		const session = createGoalSession();
		session.state = makeRunningState({ status: "complete" });

		await handleAgentEnd(pi, session, ctx);
		const all = allCalls(piCalls, ctxCalls);

		// 终态 notify 仍触发
		const notify = all.filter((c) => c.kind === "notify");
		expect(notify).toHaveLength(1);
		expect(notify[0]!.text).toContain("Objective completed");
	});
});

// ── handleAgentEnd：continuation（去抖 + 正常发送）──────

describe("handleAgentEnd — continuation", () => {
	it("continuation 去抖：tokenDelta=0（空 turn）不发", async () => {
		const { pi, calls: piCalls } = makeFakePi();
		const { ctx, calls: ctxCalls } = makeFakeCtx();
		const session = createGoalSession();
		session.state = makeRunningState({
			tokensUsed: 100,
			lastTurnTokensUsed: 100, // tokenDelta = 0
		});

		await handleAgentEnd(pi, session, ctx);
		const all = allCalls(piCalls, ctxCalls);

		const sendContext = all.filter((c) => c.kind === "sendContext");
		expect(sendContext).toHaveLength(0); // 空 turn 不发
	});

	it("continuation 正常：tokenDelta>0 → 发 continuationPrompt", async () => {
		const { pi, calls: piCalls } = makeFakePi();
		const { ctx, calls: ctxCalls } = makeFakeCtx();
		const session = createGoalSession();
		session.state = makeRunningState({
			tokensUsed: 200,
			lastTurnTokensUsed: 0, // tokenDelta = 200 > 0
		});

		await handleAgentEnd(pi, session, ctx);
		const all = allCalls(piCalls, ctxCalls);

		const sendContext = all.filter((c) => c.kind === "sendContext");
		expect(sendContext).toHaveLength(1);
		expect(sendContext[0]!.content).toContain("[GOAL]");
	});

	// ── pending 守卫：background subagent/workflow 运行时不死循环 ──

	it("有活跃 pending → 不发 continuation（pending 守卫生效）", async () => {
		const { pi, calls: piCalls } = makeFakePi();
		const { ctx, calls: ctxCalls } = makeFakeCtx({
			entries: [
				{ type: "custom", customType: "pending:register", data: { id: "bg-1", type: "subagent", name: "worker" } },
			],
		});
		const session = createGoalSession();
		session.state = makeRunningState({ tokensUsed: 200, lastTurnTokensUsed: 0 });

		await handleAgentEnd(pi, session, ctx);
		const all = allCalls(piCalls, ctxCalls);

		const followUp = all.filter(
			(c) => c.kind === "sendContext" && (c.payload as { deliverAs?: string } | undefined)?.deliverAs === "followUp",
		);
		expect(followUp).toHaveLength(0); // 有活跃 pending，不发 continuation
	});

	it("pending register 已 unregister → 差集归零，正常发 continuation", async () => {
		const { pi, calls: piCalls } = makeFakePi();
		const { ctx, calls: ctxCalls } = makeFakeCtx({
			entries: [
				{ type: "custom", customType: "pending:register", data: { id: "bg-1" } },
				{ type: "custom", customType: "pending:unregister", data: { id: "bg-1" } },
			],
		});
		const session = createGoalSession();
		session.state = makeRunningState({ tokensUsed: 200, lastTurnTokensUsed: 0 });

		await handleAgentEnd(pi, session, ctx);
		const all = allCalls(piCalls, ctxCalls);

		const followUp = all.filter(
			(c) => c.kind === "sendContext" && (c.payload as { deliverAs?: string } | undefined)?.deliverAs === "followUp",
		);
		expect(followUp).toHaveLength(1);
	});

	it("pending expiresAt 已过期 → 仍判活跃不发 continuation（刻意不校验 TTL）", async () => {
		const { pi, calls: piCalls } = makeFakePi();
		const { ctx, calls: ctxCalls } = makeFakeCtx({
			entries: [
				{ type: "custom", customType: "pending:register", data: { id: "bg-1", expiresAt: Date.now() - 1000 } },
			],
		});
		const session = createGoalSession();
		session.state = makeRunningState({ tokensUsed: 200, lastTurnTokensUsed: 0 });

		await handleAgentEnd(pi, session, ctx);
		const all = allCalls(piCalls, ctxCalls);

		const followUp = all.filter(
			(c) => c.kind === "sendContext" && (c.payload as { deliverAs?: string } | undefined)?.deliverAs === "followUp",
		);
		expect(followUp).toHaveLength(0); // 过期仍判活跃，避免长任务死循环复现
	});

	it("有活跃 pending → appendEntry goal:log 诊断记录（多元素计数 + ids 透出）", async () => {
		const { pi, states } = makeFakePi();
		const { ctx } = makeFakeCtx({
			entries: [
				{ type: "custom", customType: "pending:register", data: { id: "bg-1" } },
				{ type: "custom", customType: "pending:register", data: { id: "bg-2" } },
			],
		});
		const session = createGoalSession();
		session.state = makeRunningState({ tokensUsed: 200, lastTurnTokensUsed: 0 });

		await handleAgentEnd(pi, session, ctx);

		// goal:log 走 appendEntry（非 goal-history）→ 进 states
		const deferredLog = states.find(
			(s) =>
				(s as { component?: string } | undefined)?.component === "goal:agent-end" &&
				/continuation deferred/.test(String((s as { message?: string } | undefined)?.message ?? "")),
		);
		const data = (deferredLog as { data?: { activePending?: number; ids?: string[] } } | undefined)?.data;
		expect(data?.activePending).toBe(2); // 多元素计数（替代原 >=1 弱断言）
		expect(data?.ids).toEqual(["bg-1", "bg-2"]); // ids 透出
	});

	it("重复 register 同 id → 去重计为 1（seen.has 守卫）", async () => {
		const { pi, calls: piCalls, states } = makeFakePi();
		const { ctx, calls: ctxCalls } = makeFakeCtx({
			entries: [
				{ type: "custom", customType: "pending:register", data: { id: "bg-1" } },
				{ type: "custom", customType: "pending:register", data: { id: "bg-1" } },
			],
		});
		const session = createGoalSession();
		session.state = makeRunningState({ tokensUsed: 200, lastTurnTokensUsed: 0 });

		await handleAgentEnd(pi, session, ctx);
		const all = allCalls(piCalls, ctxCalls);

		// 守卫触发：count>0 不发 continuation
		const followUp = all.filter(
			(c) => c.kind === "sendContext" && (c.payload as { deliverAs?: string } | undefined)?.deliverAs === "followUp",
		);
		expect(followUp).toHaveLength(0);
		// seen 去重：2 条同 id register 计为 1（非 2）
		const deferredLog = states.find(
			(s) => (s as { component?: string } | undefined)?.component === "goal:agent-end",
		);
		expect((deferredLog as { data?: { activePending?: number } } | undefined)?.data?.activePending).toBe(1);
	});

	it("非字符串/缺失 id 的 register → 被忽略，正常发 continuation（typeof id 防御）", async () => {
		const { pi, calls: piCalls } = makeFakePi();
		const { ctx, calls: ctxCalls } = makeFakeCtx({
			entries: [
				{ type: "custom", customType: "pending:register", data: { id: 123 } }, // 数字 id（非字符串）
				{ type: "custom", customType: "pending:register", data: {} }, // 无 id
			],
		});
		const session = createGoalSession();
		session.state = makeRunningState({ tokensUsed: 200, lastTurnTokensUsed: 0 });

		await handleAgentEnd(pi, session, ctx);
		const all = allCalls(piCalls, ctxCalls);

		// count=0，守卫不触发，走正常 continuation
		const followUp = all.filter(
			(c) => c.kind === "sendContext" && (c.payload as { deliverAs?: string } | undefined)?.deliverAs === "followUp",
		);
		expect(followUp).toHaveLength(1);
	});

	it("无 pending entries → 正常发 continuation（回归保护）", async () => {
		const { pi, calls: piCalls } = makeFakePi();
		const { ctx, calls: ctxCalls } = makeFakeCtx(); // getEntries 默认空
		const session = createGoalSession();
		session.state = makeRunningState({ tokensUsed: 200, lastTurnTokensUsed: 0 });

		await handleAgentEnd(pi, session, ctx);
		const all = allCalls(piCalls, ctxCalls);

		const followUp = all.filter(
			(c) => c.kind === "sendContext" && (c.payload as { deliverAs?: string } | undefined)?.deliverAs === "followUp",
		);
		expect(followUp).toHaveLength(1);
	});
});

// ── handleAgentEnd：并发保护（G-021）+ stale（G-020）───

describe("handleAgentEnd — 并发保护 + stale 快照", () => {
	it("isProcessing=true → 直接返回（防重入）", async () => {
		const { pi, calls: piCalls } = makeFakePi();
		const { ctx, calls: ctxCalls } = makeFakeCtx();
		const session = createGoalSession();
		session.state = makeRunningState();
		session.isProcessing = true; // 已锁

		await handleAgentEnd(pi, session, ctx);
		const all = allCalls(piCalls, ctxCalls);

		// 无任何副作用
		expect(all).toHaveLength(0);
	});

	it("finally 块释放 isProcessing（即使中途 return）", async () => {
		const { pi } = makeFakePi();
		const { ctx } = makeFakeCtx({ aborted: true });
		const session = createGoalSession();
		session.state = makeRunningState();

		await handleAgentEnd(pi, session, ctx);

		expect(session.isProcessing).toBe(false);
	});

	it("state=null → 直接返回（无 goal 时）", async () => {
		const { pi, calls: piCalls } = makeFakePi();
		const { ctx, calls: ctxCalls } = makeFakeCtx();
		const session = createGoalSession();
		// session.state 保持 null

		await handleAgentEnd(pi, session, ctx);

		expect(allCalls(piCalls, ctxCalls)).toHaveLength(0);
	});
});

// ── handleBeforeAgentStart ────────────────────────────

describe("handleBeforeAgentStart", () => {
	it("state=null → 返回 undefined", async () => {
		const { pi } = makeFakePi();
		const { ctx } = makeFakeCtx();
		const session = createGoalSession();

		const result = await handleBeforeAgentStart(pi, session, ctx);

		expect(result).toBeUndefined();
	});

	it("正常 active goal → 返回 context injection 消息", async () => {
		const { pi } = makeFakePi();
		const { ctx } = makeFakeCtx();
		const session = createGoalSession();
		session.state = makeRunningState();

		const result = await handleBeforeAgentStart(pi, session, ctx);

		expect(result!.message.customType).toBe("goal-context");
		expect(result!.message.content).toContain("[GOAL mode activated]");
		expect(result!.message.display).toBe(false);
	});

	// contextInjection 精简（planAvailable 参数已删，plan 提示收敛到 continuationPrompt）
	it("context injection 不含 plan mode 提示（收敛到 continuation）", async () => {
		const { pi } = makeFakePi();
		const { ctx } = makeFakeCtx();
		const session = createGoalSession();
		session.state = makeRunningState();

		const result = await handleBeforeAgentStart(pi, session, ctx);

		expect(result!.message.customType).toBe("goal-context");
		// plan 引导段已删（收敛到 continuationPrompt，agent_end 发）
		expect(result!.message.content).not.toContain("plan mode");
		expect(result!.message.content).not.toContain("__planStart");
	});

	// FR-8.1 G-007: AUTO_CLEAR_TURNS=2
	it("终态 + turnsInTerminal >= 2 → clearGoalSession（state 清空）", async () => {
		const { pi } = makeFakePi();
		const { ctx } = makeFakeCtx();
		const session = createGoalSession();
		session.state = makeRunningState({
			status: "complete",
			currentTurnIndex: 10,
			completedAtTurnIndex: 8, // turnsInTerminal = 2 >= AUTO_CLEAR_TURNS
		});

		const result = await handleBeforeAgentStart(pi, session, ctx);

		expect(result).toBeUndefined();
		expect(session.state).toBeNull();
	});

	it("终态 + turnsInTerminal < 2 → 不清理，折叠 status bar", async () => {
		const { pi, calls: piCalls } = makeFakePi();
		const { ctx, calls: ctxCalls } = makeFakeCtx({ hasUI: true });
		const session = createGoalSession();
		session.state = makeRunningState({
			status: "complete",
			currentTurnIndex: 10,
			completedAtTurnIndex: 9, // turnsInTerminal = 1 < 2
		});

		const result = await handleBeforeAgentStart(pi, session, ctx);
		const all = allCalls(piCalls, ctxCalls);

		expect(result).toBeUndefined();
		expect(session.state).not.toBeNull(); // 未清理
		// setStatus 触发（折叠为终态单行）
		expect(all.filter((c) => c.kind === "setStatus" && c.key === "goal")).toHaveLength(1);
	});

	// ADR-002 context usage 提示（CONTEXT_USAGE_RATIO_LIMIT=0.85，保持 active）
	it("context 使用率 > 85% → 保持 active + 注入 wrap-up 指令", async () => {
		const { pi } = makeFakePi();
		const { ctx } = makeFakeCtx({ contextUsage: { tokens: 9000, contextWindow: 10000 } }); // 90% > 85%
		const session = createGoalSession();
		session.state = makeRunningState();

		const result = await handleBeforeAgentStart(pi, session, ctx);

		expect(result!.message.customType).toBe("goal-context-exceeded");
		// ADR-002：goal 保持 active（不转 paused）
		expect(session.state!.status).toBe("active");
	});

	it("context 使用率 <= 85% → 正常 context injection", async () => {
		const { pi } = makeFakePi();
		const { ctx } = makeFakeCtx({ contextUsage: { tokens: 5000, contextWindow: 10000 } }); // 50%
		const session = createGoalSession();
		session.state = makeRunningState();

		const result = await handleBeforeAgentStart(pi, session, ctx);

		expect(result!.message.customType).toBe("goal-context");
		expect(session.state!.status).toBe("active");
	});

	it("非 active（blocked）→ 返回 undefined（不注入）", async () => {
		const { pi } = makeFakePi();
		const { ctx } = makeFakeCtx();
		const session = createGoalSession();
		session.state = makeRunningState({ status: "blocked" });

		const result = await handleBeforeAgentStart(pi, session, ctx);

		expect(result).toBeUndefined();
	});

	// ── pending-notifications（W2 跨扩展集成）───────────────────

	// pendingHint 已删除（pending 感知交给 LLM 调 pending_notifications tool），
	// 无论是否有活跃 pending entries，content 都不含 pending 提示——轻量回归保护。
	const PENDING_HINT_CASES: Array<[string, unknown[]]> = [
		["有活跃 pending", [{ type: "custom", customType: "pending:register", data: { id: "wf-1" } }]],
		["无 pending", []],
	];
	it.each(PENDING_HINT_CASES)(
		"pendingHint 已移除：%s → content 不含 pending 提示",
		async (_label, entries) => {
			const { pi } = makeFakePi();
			const { ctx } = makeFakeCtx({ entries });
			const session = createGoalSession();
			session.state = makeRunningState();

			const result = await handleBeforeAgentStart(pi, session, ctx);

			expect(result!.message.customType).toBe("goal-context");
			expect(result!.message.content).not.toContain("pending async operation");
		},
	);
});
