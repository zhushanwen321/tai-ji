/**
 * service.ts 测试 — 用 fake ports（内存实现 ports.ts 接口）
 *
 * FR-7.2: service 层测试，不 import Pi SDK
 */
import { describe, expect, it } from "vitest";

import { createGoalState } from "../engine/goal";
import type { GoalRuntimeState } from "../engine/types";
import { applyEvent, createGoal, finalizeGoal, persistAndUpdate, type ServicePorts } from "../service";
import { createGoalSession } from "../session";

// ── Fake Ports ───────────────────────────────────────

function makeFakePorts(): ServicePorts & {
	states: GoalRuntimeState[];
	history: unknown[];
} {
	const states: GoalRuntimeState[] = [];
	const history: unknown[] = [];
	return {
		states,
		history,
		persistence: {
			appendState: (s) => {
				states.push(s);
			},
			appendHistory: (e) => {
				history.push(e);
			},
		},
		ui: {
			setWidget: () => {},
			setStatus: () => {},
			notify: () => {},
			hasUI: true,
			// ThemeLike 嵌套成员（UiPort.theme 显式声明，updateWidget 直读 uiPort.theme）
			theme: {
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			},
		},
		messaging: {
			sendContextMessage: () => {},
			sendUserMessage: () => {},
		},
		session: {
			getEntries: () => [],
		},
	};
}

const makeState = (): GoalRuntimeState => createGoalState("test");

// ── createGoal 测试 ──────────────────────────────────

describe("createGoal — 唯一创建入口", () => {
	it("成功创建：state 构造 + persist", () => {
		const session = createGoalSession();
		const ports = makeFakePorts();
		const ok = createGoal(session, "my objective", {}, ports);
		expect(ok).toBe(true);
		expect(session.state).not.toBeNull();
		expect(session.state!.objective).toBe("my objective");
		expect(ports.states.length).toBeGreaterThanOrEqual(1);
	});

	it("U23c: createGoal(..., slug, successCriteria) → state.successCriteria 深等于入参数组", () => {
		const session = createGoalSession();
		const ports = makeFakePorts();
		const ok = createGoal(session, "obj", {}, ports, "slug", ["a", "b"]);
		expect(ok).toBe(true);
		// string[] 透传：types/goal/service 类型链的直接断言
		expect(session.state!.successCriteria).toEqual(["a", "b"]);
	});

	it("已有 active goal → 拒绝创建（返回 false）", () => {
		const session = createGoalSession();
		const ports = makeFakePorts();
		createGoal(session, "first", {}, ports);
		const ok = createGoal(session, "second", {}, ports);
		expect(ok).toBe(false);
		expect(session.state!.objective).toBe("first"); // 保持原 goal
	});

	it("终态 goal → 允许创建（覆盖）", () => {
		const session = createGoalSession();
		const ports = makeFakePorts();
		session.state = makeState();
		session.state.status = "complete"; // 终态
		const ok = createGoal(session, "new", {}, ports);
		expect(ok).toBe(true);
		expect(session.state.objective).toBe("new");
	});
});

// ── finalizeGoal — history 写入矩阵 ──────────────────

describe("finalizeGoal — history 写入矩阵", () => {
	it("complete → 写 history", () => {
		const ports = makeFakePorts();
		const state = makeState();
		finalizeGoal(state, "complete", ports);
		expect(ports.history.length).toBe(1);
		expect((ports.history[0] as { status: string }).status).toBe("complete");
		expect(state.completedAtTurnIndex).toBe(state.currentTurnIndex);
	});

	it("cancelled → 写 history", () => {
		const ports = makeFakePorts();
		const state = makeState();
		finalizeGoal(state, "cancelled", ports);
		expect(ports.history.length).toBe(1);
	});

	it("budget_limited → 写 history", () => {
		const ports = makeFakePorts();
		const state = makeState();
		finalizeGoal(state, "budget_limited", ports);
		expect(ports.history.length).toBe(1);
	});

	it("终态 goal 再 finalize → throw（查表非法转换）", () => {
		const ports = makeFakePorts();
		const state = makeState();
		state.status = "complete";
		// transitionStatus 查表：终态不可转，调用方须先 isTerminalStatus 守卫
		expect(() => finalizeGoal(state, "cancelled", ports)).toThrow();
		expect(state.status).toBe("complete");
	});
});

// ── applyEvent — 简单事件（路径 B）────────────────────

describe("applyEvent — 简单事件", () => {
	it("message_end 累加 assistant token（FR-8.6）", () => {
		const session = createGoalSession();
		session.state = makeState();
		const before = session.state.tokensUsed;
		applyEvent(session, "message_end", {
			message: {
				role: "assistant",
				usage: { input: 100, output: 50, cacheRead: 20 },
			},
		});
		// accumulateTokens: 100×1 + 20×0.02 + 50×2 = 200.4（加权口径，对齐 workflow 包）
		expect(session.state.tokensUsed).toBe(before + 200.4);
	});

	it("message_end 忽略非 assistant 消息", () => {
		const session = createGoalSession();
		session.state = makeState();
		const before = session.state.tokensUsed;
		applyEvent(session, "message_end", {
			message: { role: "user", usage: { input: 100, output: 50 } },
		});
		expect(session.state.tokensUsed).toBe(before);
	});

	it("message_end 缺 usage → 不变", () => {
		const session = createGoalSession();
		session.state = makeState();
		const before = session.state.tokensUsed;
		applyEvent(session, "message_end", { message: { role: "assistant" } });
		expect(session.state.tokensUsed).toBe(before);
	});

	it("回归#1: message_end 非 active（blocked）→ 不累加 token（FR-8.6 G-R2-001）", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.status = "blocked"; // 非 active
		const before = session.state.tokensUsed;
		applyEvent(session, "message_end", {
			message: {
				role: "assistant",
				usage: { input: 100, output: 50, cacheRead: 20 },
			},
		});
		// 回归修复：blocked 状态不累加 token（原 bug：缺 isActiveStatus 守卫）
		expect(session.state.tokensUsed).toBe(before);
	});

	it("turn_end → currentTurnIndex++（H3：applyEvent void，updateWidget 由 turn-end handler 直接调用）", () => {
		const session = createGoalSession();
		session.state = makeState();
		const before = session.state.currentTurnIndex;
		applyEvent(session, "turn_end", {});
		expect(session.state.currentTurnIndex).toBe(before + 1);
	});

	it("session.state=null → no-op（H3：applyEvent void）", () => {
		const session = createGoalSession();
		expect(() => applyEvent(session, "turn_end", {})).not.toThrow();
	});

	it("未知事件 → no-op（H3：applyEvent void，不报错）", () => {
		const session = createGoalSession();
		session.state = makeState();
		const before = session.state.currentTurnIndex;
		expect(() => applyEvent(session, "unknown_event", {})).not.toThrow();
		expect(session.state.currentTurnIndex).toBe(before);
	});
});

// ── persistAndUpdate — #5 budget 终态检查（事件路径单一检查点，NFR F2）──

describe("persistAndUpdate — #5 budget 终态检查（事件路径单一检查点）", () => {
	it("active + token 超额（steering 已发）→ status 转 budget_limited + 写 history", () => {
		const session = createGoalSession();
		session.state = {
			...makeState(),
			status: "active",
			timeStartedAt: 0, // 关闭时间累计，保证 tick 不额外累加
			budget: { tokenBudget: 1000 },
			tokensUsed: 1000, // >= tokenBudget
			budgetLimitSteeringSent: true, // token terminal 要求 steering 已发
		};
		const ports = makeFakePorts();
		const stale = persistAndUpdate(session, ports);

		expect(stale).toBe(false);
		expect(session.state!.status).toBe("budget_limited");
		expect(ports.history.length).toBe(1); // FR-8.7: 终态写 history
		expect((ports.history[0] as { status: string }).status).toBe("budget_limited");
	});

	it("token 终态分支不重复 appendState（finalizeAndPersist 已含持久化）", () => {
		const session = createGoalSession();
		session.state = {
			...makeState(),
			status: "active",
			timeStartedAt: 0,
			budget: { tokenBudget: 1000 },
			tokensUsed: 1000,
			budgetLimitSteeringSent: true,
		};
		const ports = makeFakePorts();
		persistAndUpdate(session, ports);
		// 仅 finalizeAndPersist 内部 1 次 appendState，不再走正常 appendState
		expect(ports.states.length).toBe(1);
	});

	it("非 active（blocked）→ 不触发 budget 检查，保持 blocked", () => {
		const session = createGoalSession();
		session.state = {
			...makeState(),
			status: "blocked",
			timeStartedAt: 0,
			budget: { tokenBudget: 1000 },
			tokensUsed: 1000, // 已超额，但 blocked 不检查
			budgetLimitSteeringSent: true,
		};
		const ports = makeFakePorts();
		persistAndUpdate(session, ports);

		expect(session.state!.status).toBe("blocked"); // 未变
		expect(ports.history.length).toBe(0); // blocked 不写 history
		expect(ports.states.length).toBe(1); // 走正常 appendState 路径
	});

	it("active 但未超额 → 正常 persist（无终态、无 history）", () => {
		const session = createGoalSession();
		session.state = {
			...makeState(),
			status: "active",
			timeStartedAt: 0,
			budget: { tokenBudget: 1000 },
			tokensUsed: 100, // 未超额
		};
		const ports = makeFakePorts();
		persistAndUpdate(session, ports);

		expect(session.state!.status).toBe("active"); // 未变
		expect(ports.history.length).toBe(0);
		expect(ports.states.length).toBe(1); // 正常 appendState
	});

	it("终态处理后 checkStale 触发 → 返回 true（status 已转终态）", () => {
		const session = createGoalSession();
		session.state = {
			...makeState(),
			status: "active",
			timeStartedAt: 0,
			budget: { tokenBudget: 1000 },
			tokensUsed: 1000,
			budgetLimitSteeringSent: true,
		};
		const ports = makeFakePorts();
		const stale = persistAndUpdate(session, ports, () => true);
		expect(stale).toBe(true);
		// finalizeAndPersist 已执行，status 已转终态
		expect(session.state!.status).toBe("budget_limited");
	});
});
