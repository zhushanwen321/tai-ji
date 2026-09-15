/**
 * FR-5/FR-7.3: deserializeState — 严格解析（必填缺失 throw；旧格式容忍面见 persistence.ts 各迁移点注释）
 *
 * round-trip property 覆盖全字段 serialize→deserialize 双向一致性，替代手写还原用例。
 * 保留：throw 路径（缺必填）+ 向后兼容（缺 optional）+ 旧 tasks 字段忽略。
 */
import { describe, expect } from "vitest";
import { it, fc } from "@fast-check/vitest";

import { deserializeState, serializeState } from "../persistence";
import { isTerminalStatus } from "../engine/goal";
import type { GoalRuntimeState, GoalStatus } from "../engine/types";

const STATUS_VALUES: GoalStatus[] = ["active", "paused", "blocked", "complete", "budget_limited", "cancelled"];

// GoalRuntimeState 全字段生成器（optional 字段用 fc.option 覆盖有/无两态）。
// successCriteria 生成域对齐 schema 语义（review nit 11）：元素非空且不含换行、
// 数组长度 1~8——避免 property 生成 schema 层非法数据掩盖 round-trip 语义漂移。
const goalStateArb = fc.record({
	goalId: fc.uuid(),
	objective: fc.string({ minLength: 1 }),
	successCriteria: fc.option(
		fc.array(
			fc.string({ minLength: 1 }).filter((s) => !/\r|\n/.test(s)),
			{ minLength: 1, maxLength: 8 },
		),
		{ nil: undefined },
	),
	slug: fc.option(fc.string({ minLength: 1 })),
	status: fc.constantFrom(...STATUS_VALUES),
	tokensUsed: fc.nat(),
	timeStartedAt: fc.integer({ min: 0 }),
	timeUsedSeconds: fc.nat(),
	budget: fc.record({ tokenBudget: fc.option(fc.integer({ min: 0 })) }),
	budgetLimitSteeringSent: fc.boolean(),
	lastBlockerReason: fc.option(fc.string(), { nil: null }), // string | null
	tokenWarning70Sent: fc.boolean(),
	tokenWarning90Sent: fc.boolean(),
	lastTurnTokensUsed: fc.nat(),
	currentTurnIndex: fc.nat(),
	completedAtTurnIndex: fc.option(fc.nat()),
	// W5 熔断计数（chat-domain-v1x D4）：round-trip 双向一致性覆盖
	continuationsSent: fc.nat(),
	noProgressTurns: fc.nat(),
	continuationCapNotified: fc.boolean(),
	lastDeferredPendingIds: fc.array(fc.string()),
	toolCallsSeen: fc.nat(),
}) as unknown as fc.Arbitrary<GoalRuntimeState>;

// 旧 entry 模拟（含已废弃 tasks 字段，验证向后兼容忽略）
const FULL_DATA: Record<string, unknown> = {
	goalId: "g1",
	objective: "test",
	status: "active",
	tasks: [{ id: 1, description: "task 1", status: "completed", lastUpdatedTurn: 5 }],
	tokensUsed: 0,
	timeStartedAt: 1000,
	timeUsedSeconds: 0,
	budget: {},
	budgetLimitSteeringSent: false,
	lastBlockerReason: null,
	tokenWarning70Sent: false,
	tokenWarning90Sent: false,
	lastTurnTokensUsed: 0,
	currentTurnIndex: 0,
};

describe("deserializeState — round-trip", () => {
	// ⭐ serialize→deserialize 深相等：覆盖全 21 字段双向一致性（含 optional 有/无两态）
	it.prop([goalStateArb])("deserializeState(serializeState(s)) 深相等 s", (s) => {
		const rt = deserializeState(serializeState(s) as unknown as Record<string, unknown>);
		expect(rt).toEqual(s);
	});
});

describe("deserializeState — 旧 string 迁移 property（U15 第二路）", () => {
	// ⭐ 任意 string（旧格式）迁移后恒为规范形态：undefined（空态归一）或
	// every(trim 非空、无换行) 的 string[]——锁死按行拆分 + trim + 去空行语义
	it.prop([fc.string()])("任意 string → undefined 或 every(trim 非空、无换行) 的数组", (s) => {
		const rt = deserializeState({ ...FULL_DATA, successCriteria: s });
		if (rt.successCriteria === undefined) return;
		expect(Array.isArray(rt.successCriteria)).toBe(true);
		expect(
			rt.successCriteria.every(
				(item) => typeof item === "string" && item === item.trim() && item.length > 0 && !/[\r\n]/.test(item),
			),
		).toBe(true);
	});
});

describe("deserializeState — 严格解析（缺必填 throw）", () => {
	it("完整数据（含旧 tasks 字段）→ 正确还原，tasks 被忽略", () => {
		const state = deserializeState(FULL_DATA);
		expect(state.tokenWarning70Sent).toBe(false);
		expect(state.objective).toBe("test");
		expect((state as unknown as { tasks?: unknown }).tasks).toBeUndefined();
	});

	it("顶层缺 budget → throw", () => {
		expect(() => deserializeState({ goalId: "g1", objective: "test", status: "active" })).toThrow();
	});

	it("缺 tokenWarning70Sent → throw", () => {
		const data = { ...FULL_DATA };
		delete data.tokenWarning70Sent;
		expect(() => deserializeState(data)).toThrow();
	});
});

describe("deserializeState — legacy entry 含已删字段（P-m14-1，D2 白名单兼容）", () => {
	// ext-simplify-03 D2：lastProgressTurn/objectiveUpdatedAt 已从 GoalRuntimeState 一步删除。
	// 0.13.0 形状 entry 仍携带这两个字段——deserializeState 是白名单模式（只对已知 key 逐个
	// req()/可选解析，从不遍历 entry 全部 key，与 tasks 字段先例同一机制），entry 多出的
	// 字段天然被忽略：不 throw、state 完整重建（G3：旧数据加载兼容）。
	const LEGACY_0_13: Record<string, unknown> = {
		...FULL_DATA,
		lastProgressTurn: 3,
		objectiveUpdatedAt: 2000,
	};

	it("0.13.0 形状 entry（含已删两字段）→ 不 throw，返回完整 state", () => {
		const state = deserializeState(LEGACY_0_13);
		expect(state.goalId).toBe("g1");
		expect(state.objective).toBe("test");
		expect(state.status).toBe("active");
		expect(state.budgetLimitSteeringSent).toBe(false);
	});

	it("已删字段被白名单忽略：返回对象不含 lastProgressTurn/objectiveUpdatedAt", () => {
		const state = deserializeState(LEGACY_0_13);
		expect(state).not.toHaveProperty("lastProgressTurn");
		expect(state).not.toHaveProperty("objectiveUpdatedAt");
	});
});

describe("deserializeState — optional 字段向后兼容（GAP-4 旧数据）", () => {
	it("缺 completedAtTurnIndex → undefined", () => {
		expect(deserializeState(FULL_DATA).completedAtTurnIndex).toBeUndefined();
	});
	it("缺 slug → undefined", () => {
		expect(deserializeState(FULL_DATA).slug).toBeUndefined();
	});
	it("缺 successCriteria → undefined", () => {
		expect(deserializeState(FULL_DATA).successCriteria).toBeUndefined();
	});
	// W5：旧持久化数据（熔断字段引入前）缺 5 个熔断字段 → 归零/空集/false（新周期语义）
	it("缺 W5 熔断字段 → 计数归零 / 空集合 / flag false", () => {
		const state = deserializeState(FULL_DATA);
		expect(state.continuationsSent).toBe(0);
		expect(state.noProgressTurns).toBe(0);
		expect(state.continuationCapNotified).toBe(false);
		expect(state.lastDeferredPendingIds).toEqual([]);
		expect(state.toolCallsSeen).toBe(0);
	});
	it("W5 熔断字段为脏值（负数/非数组）→ 同样归零/空集（防御性默认）", () => {
		const state = deserializeState({
			...FULL_DATA,
			continuationsSent: -3,
			noProgressTurns: "many" as unknown as number,
			lastDeferredPendingIds: [1, null] as unknown as string[],
		});
		expect(state.continuationsSent).toBe(0);
		expect(state.noProgressTurns).toBe(0);
		expect(state.lastDeferredPendingIds).toEqual([]);
	});
});

describe("deserializeState — 旧数据迁移（time_limited → budget_limited，MF-1）", () => {
	// npm pi-goal 0.7.x 持久化格式：status=time_limited + timeWarning* 遗留字段（时间预算维度已移除）
	const LEGACY_DATA: Record<string, unknown> = {
		...FULL_DATA,
		status: "time_limited",
		timeWarning70Sent: true,
		timeWarning90Sent: true,
	};

	it("旧 entry status=time_limited → 归一化 budget_limited，遗留字段被忽略", () => {
		const state = deserializeState(LEGACY_DATA);
		expect(state.status).toBe("budget_limited");
		expect((state as unknown as { timeWarning70Sent?: unknown }).timeWarning70Sent).toBeUndefined();
		expect((state as unknown as { timeWarning90Sent?: unknown }).timeWarning90Sent).toBeUndefined();
	});

	it("归一化后是合法终态：/goal clear 守卫（!isTerminalStatus）跳过 transitionStatus，不 throw", () => {
		const state = deserializeState(LEGACY_DATA);
		// handleClear（command-adapter.ts）的守卫：!isTerminalStatus 为 false → 直接 clearSession，
		// 不再走 finalizeAndPersist("cancelled") 的 transitionStatus 查表（旧值会 throw）。
		expect(isTerminalStatus(state.status)).toBe(true);
	});

	it("新格式 status 不受影响（time_limited 之外的六态原样透传）", () => {
		for (const status of STATUS_VALUES) {
			expect(deserializeState({ ...FULL_DATA, status }).status).toBe(status);
		}
	});
});
