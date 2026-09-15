/**
 * goal_control adapter 测试 — handler 用 fake ports
 *
 * 覆盖 #3 验收：
 * - complete: active 守卫 + evidence 必填 + finalizeAndPersist（status→complete + history）
 * - report_blocked: active 守卫 + reason 必填 + tickState + transitionStatus(active→blocked) + persistState
 *
 * 全解耦后不再测 todo 前置检查（checkCompletePrerequisites / buildProgressInput / findIncompleteTodos 已删）。
 * complete 不做 todo 完成硬检查——AI 自行判断（prompt 软建议）。
 *
 * 不 import Pi SDK（handler 接收 ServicePorts，纯逻辑）。
 */
import { describe, expect, it } from "vitest";

import {
	handleComplete,
	handleCreate,
	handleReportBlocked,
} from "../adapters/goal-control-adapter";
import { createGoalState } from "../engine/goal";
import type { GoalRuntimeState } from "../engine/types";
import type { UiPort } from "../ports";
import type { ServicePorts } from "../service";
import { createGoalSession } from "../session";

// ── Fake Ports ───────────────────────────────────────

function makeFakePorts(): ServicePorts & {
	states: GoalRuntimeState[];
	history: unknown[];
	notifications: Array<{ text: string; level: string }>;
} {
	const states: GoalRuntimeState[] = [];
	const history: unknown[] = [];
	const notifications: Array<{ text: string; level: string }> = [];
	return {
		states,
		history,
		notifications,
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
			notify: (text, level) => {
				notifications.push({ text, level });
			},
			hasUI: true,
			// widget 渲染读 UiPort.theme（ports.ts 的 uiPort 同样以 theme 嵌套成员提供）
			theme: {
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			},
		} as UiPort,
		messaging: {
			sendContextMessage: () => {},
			sendUserMessage: () => {},
		},
		session: {
			getEntries: () => [],
		},
	};
}

const activeState = (overrides: Partial<GoalRuntimeState> = {}): GoalRuntimeState => ({
	...createGoalState("test"),
	...overrides,
});

// ── handleComplete ───────────────────────────────────

describe("handleComplete — active 守卫 + evidence + finalizeAndPersist", () => {
	it("active + evidence → status complete + 写 history", () => {
		const session = createGoalSession();
		session.state = activeState();
		const ports = makeFakePorts();

		const details = handleComplete({ action: "complete", evidence: "tests pass" }, session, ports);

		expect(details.action).toBe("complete");
		expect(details.status).toBe("complete");
		expect(session.state!.status).toBe("complete");
		// finalizeAndPersist 写 history（FR-8.7）
		expect(ports.history).toHaveLength(1);
		expect(ports.notifications[0]?.level).toBe("info");
	});

	it("非 active（blocked）→ throw", () => {
		const session = createGoalSession();
		session.state = activeState({ status: "blocked" });
		expect(() => handleComplete({ action: "complete", evidence: "x" }, session, makeFakePorts())).toThrow(
			/not active/,
		);
	});

	it("evidence 空 → throw", () => {
		const session = createGoalSession();
		session.state = activeState();
		expect(() =>
			handleComplete({ action: "complete", evidence: "   " }, session, makeFakePorts()),
		).toThrow(/evidence/);
	});

	it("evidence undefined → throw（schema 降级后 handler 唯一兜底：'required' 错误）", () => {
		const session = createGoalSession();
		session.state = activeState();
		expect(() => handleComplete({ action: "complete" }, session, makeFakePorts())).toThrow(
			/evidence.*required/,
		);
	});
});

// ── handleCreate ─────────────────────────────────────

describe("handleCreate — objective/successCriteria 必填（handler 运行时校验）+ slug 真 optional + 非终态守卫 + createGoal", () => {
	it("无旧 goal + slug + objective → status active + slug 写入 + 持久化 + notify", () => {
		const session = createGoalSession();
		const ports = makeFakePorts();

		const details = handleCreate(
			{ action: "create", slug: "ship-feature-x", objective: "ship feature X", successCriteria: ["feature X shipped"] },
			session,
			ports,
		);

		expect(details.action).toBe("create");
		expect(details.status).toBe("active");
		expect(details.slug).toBe("ship-feature-x");
		expect(session.state).not.toBeNull();
		expect(session.state!.objective).toBe("ship feature X");
		expect(session.state!.slug).toBe("ship-feature-x");
		expect(session.state!.successCriteria).toEqual(["feature X shipped"]);
		expect(session.state!.status).toBe("active");
		// createGoal 内部 persistState 写一条 state
		expect(ports.states).toHaveLength(1);
		expect(ports.notifications[0]?.level).toBe("info");
		expect(ports.notifications[0]?.text).toContain("ship feature X");
	});

	it("objective 空 → throw", () => {
		const session = createGoalSession();
		expect(() =>
			handleCreate({ action: "create", slug: "x", objective: "   ", successCriteria: ["done"] }, session, makeFakePorts()),
		).toThrow(/objective/);
	});

	it("objective undefined → throw（schema 降级后 handler 唯一兜底：'required' 错误）", () => {
		const session = createGoalSession();
		expect(() => handleCreate({ action: "create", successCriteria: ["y"] }, session, makeFakePorts())).toThrow(
			/objective.*required/,
		);
	});

	it("successCriteria 空 → throw（即使有 slug + objective）", () => {
		const session = createGoalSession();
		expect(() =>
			handleCreate(
				{ action: "create", slug: "x", objective: "do thing", successCriteria: ["   "] },
				session,
				makeFakePorts(),
			),
		).toThrow(/successCriteria/);
	});

	it("successCriteria undefined → throw（schema 降级后 handler 唯一兜底：'required' 错误）", () => {
		const session = createGoalSession();
		expect(() => handleCreate({ action: "create", objective: "x" }, session, makeFakePorts())).toThrow(
			/successCriteria.*required/,
		);
	});

	const NON_TERMINAL_STATUSES: GoalRuntimeState["status"][] = ["active", "paused", "blocked"];
	it.each(NON_TERMINAL_STATUSES)("已有 %s goal → throw（D25 非终态守卫）", (status) => {
		const session = createGoalSession();
		session.state = activeState({ status });
		expect(() =>
			handleCreate(
				{ action: "create", slug: "new", objective: "new obj", successCriteria: ["done"] },
				session,
				makeFakePorts(),
			),
		).toThrow(/already active/i);
	});

	it("已有终态 goal → 覆盖创建（快速路径，goalId 变新，slug 写入）", () => {
		const session = createGoalSession();
		session.state = activeState({ status: "complete" });
		const oldId = session.state!.goalId;
		const ports = makeFakePorts();

		const details = handleCreate(
			{ action: "create", slug: "next-obj", objective: "next obj", successCriteria: ["next done"] },
			session,
			ports,
		);

		expect(details.status).toBe("active");
		expect(session.state!.objective).toBe("next obj");
		expect(session.state!.slug).toBe("next-obj");
		expect(session.state!.goalId).not.toBe(oldId);
	});

	it("tokenBudget <= 0 → throw", () => {
		const session = createGoalSession();
		expect(() =>
			handleCreate(
				{ action: "create", slug: "x", objective: "x", successCriteria: ["done"], tokenBudget: 0 },
				session,
				makeFakePorts(),
			),
		).toThrow(/tokenBudget/);
	});

	it("合法 budget → 合并进新 state", () => {
		const session = createGoalSession();
		const ports = makeFakePorts();

		handleCreate(
			{ action: "create", slug: "x", objective: "x", successCriteria: ["done"], tokenBudget: 8000 },
			session,
			ports,
		);

		expect(session.state!.budget.tokenBudget).toBe(8000);
	});
});

// ── handleReportBlocked ──────────────────────────────

describe("handleReportBlocked — active 守卫 + tick + transition + persist", () => {
	it("active + reason → status blocked + reason 记录 + tick 累加", () => {
		const session = createGoalSession();
		const past = Date.now() - 4000;
		session.state = activeState({ timeStartedAt: past, timeUsedSeconds: 6 });
		const ports = makeFakePorts();

		const details = handleReportBlocked(
			{ action: "report_blocked", reason: "stuck on X" },
			session,
			ports,
		);

		expect(details.action).toBe("report_blocked");
		expect(details.status).toBe("blocked");
		expect(session.state!.status).toBe("blocked");
		expect(session.state!.lastBlockerReason).toBe("stuck on X");
		// MF-3 tick：转 blocked 前累加当前运行段（6 + ~4s）
		expect(session.state!.timeUsedSeconds).toBeGreaterThanOrEqual(9);
		// persistState 持久化
		expect(ports.states).toHaveLength(1);
		expect(ports.notifications[0]?.level).toBe("warning");
	});

	it("非 active（complete）→ throw", () => {
		const session = createGoalSession();
		session.state = activeState({ status: "complete" });
		expect(() =>
			handleReportBlocked({ action: "report_blocked", reason: "x" }, session, makeFakePorts()),
		).toThrow(/not active/);
	});

	it("reason 空 → throw", () => {
		const session = createGoalSession();
		session.state = activeState();
		expect(() =>
			handleReportBlocked({ action: "report_blocked", reason: "" }, session, makeFakePorts()),
		).toThrow(/reason/);
	});

	it("reason undefined → throw（schema 降级后 handler 唯一兜底：'required' 错误）", () => {
		const session = createGoalSession();
		session.state = activeState();
		expect(() => handleReportBlocked({ action: "report_blocked" }, session, makeFakePorts())).toThrow(
			/reason.*required/,
		);
	});
});
