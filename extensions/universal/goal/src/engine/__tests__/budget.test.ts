/**
 * engine/budget.ts 测试
 *
 * getBudgetSeverity 单调性 + 分区边界用 fast-check property 覆盖比率连续空间，
 * 替代固定点枚举（severity 6 条 → 单调 1 + 分区 3 property）。
 */
import { describe, expect } from "vitest";
import { it, fc } from "@fast-check/vitest";

import {
	accumulateTokens,
	checkBudgetOnResume,
	checkBudgetOnTurnEnd,
	getBudgetColor,
	getBudgetSeverity,
	getTokenUsagePercent,
	tick,
} from "../budget";
import { createGoalState } from "../goal";
import type { GoalRuntimeState } from "../types";

// 复用 createGoalState 作合法 state 工厂，checkBudget 测试只覆盖预算相关字段
const makeState = (overrides: Partial<GoalRuntimeState> = {}): GoalRuntimeState => ({
	...createGoalState("test"),
	timeStartedAt: 1000,
	...overrides,
});

const RANK: Record<"ok" | "warn" | "danger", number> = { ok: 0, warn: 1, danger: 2 };
const f64 = (min: number, max: number) =>
	fc.double({ min, max, noNaN: true, noDefaultInfinity: true });
const ratioArb = f64(0, 1);

// ── accumulateTokens（FR-8.6）─────────────────────────

describe("accumulateTokens", () => {
	it("input/output 有 → 加权 input×1 + cacheRead×0.02 + output×2", () => {
		expect(accumulateTokens(1000, { input: 100, output: 50, cacheRead: 20 })).toBe(1200.4);
	});
	it("input=0 output=0 → fallback totalTokens", () => {
		expect(accumulateTokens(1000, { totalTokens: 200 })).toBe(1200);
	});
	it("全空 → 不累加", () => {
		expect(accumulateTokens(1000, {})).toBe(1000);
	});
});

// ── tick（FR-6.5 纯函数）──────────────────────────────

describe("tick", () => {
	it("isRunning=true → 累加 (now-start)/1000 并叠加已有 timeUsedSeconds", () => {
		expect(tick(1000000, 100, 1600000, true)).toEqual({ timeUsedSeconds: 700, timeStartedAt: 1600000 });
	});
	it("isRunning=false → 不累加，重置 timeStartedAt=now", () => {
		expect(tick(1000000, 500, 2000000, false)).toEqual({ timeUsedSeconds: 500, timeStartedAt: 2000000 });
	});
});

// ── checkBudgetOnTurnEnd（仅 token 维度）──────────────

describe("checkBudgetOnTurnEnd — 无预算", () => {
	it("无 token budget → ok（无 terminal/warnings/steering）", () => {
		const r = checkBudgetOnTurnEnd(makeState());
		expect(r.terminal).toBeNull();
		expect(r.warnings).toEqual([]);
		expect(r.shouldSendSteering).toBe(false);
	});
});

describe("checkBudgetOnTurnEnd — token 阈值", () => {
	it("token < 70% → 无预警", () => {
		expect(checkBudgetOnTurnEnd(makeState({ tokensUsed: 600, budget: { tokenBudget: 1000 } })).warnings).toEqual([]);
	});
	it("token >= 70% 未发 → warning70", () => {
		const s = makeState({ tokensUsed: 700, budget: { tokenBudget: 1000 } });
		expect(checkBudgetOnTurnEnd(s).warnings).toContainEqual({ type: "warning70" });
	});
	it("token >= 70% 已发 → 不重复", () => {
		const s = makeState({ tokensUsed: 750, tokenWarning70Sent: true, budget: { tokenBudget: 1000 } });
		expect(checkBudgetOnTurnEnd(s).warnings).not.toContainEqual({ type: "warning70" });
	});
	it("token >= 90% 未发 steering → shouldSendSteering", () => {
		const s = makeState({ tokensUsed: 950, budget: { tokenBudget: 1000 } });
		expect(checkBudgetOnTurnEnd(s).shouldSendSteering).toBe(true);
	});
	it("token >= 100% 已发 steering → terminal exceeded", () => {
		const s = makeState({ tokensUsed: 1000, budgetLimitSteeringSent: true, budget: { tokenBudget: 1000 } });
		expect(checkBudgetOnTurnEnd(s).terminal).toEqual({ type: "exceeded" });
	});
});

// ── checkBudgetOnResume ──────────────────────────────

describe("checkBudgetOnResume", () => {
	// 注意：用 @fast-check/vitest 的 it 时普通断言须用块体（表达式体返回 matcher 结果会被 fast-check 当 property predicate 判 false）
	it("无预算 → null", () => {
		expect(checkBudgetOnResume(makeState())).toBeNull();
	});
	it("token 超额 → exceeded", () => {
		const s = makeState({ tokensUsed: 1000, budget: { tokenBudget: 1000 } });
		expect(checkBudgetOnResume(s)).toEqual({ type: "exceeded" });
	});
	it("未超额 → null", () => {
		const s = makeState({ tokensUsed: 500, budget: { tokenBudget: 1000 } });
		expect(checkBudgetOnResume(s)).toBeNull();
	});
});

// ── 百分比 ────────────────────────────────────────────

describe("getTokenUsagePercent", () => {
	it("无 tokenBudget → 0", () => {
		expect(getTokenUsagePercent(makeState())).toBe(0);
	});
	it("50% token", () => {
		expect(getTokenUsagePercent(makeState({ tokensUsed: 500, budget: { tokenBudget: 1000 } }))).toBe(50);
	});
});

// ── getBudgetSeverity（H4 阈值单源）──────────────────

describe("getBudgetSeverity", () => {
	// 单调非递减：比率越大严重度不降（不硬编码阈值，捕捉排序 bug）
	it.prop([ratioArb, ratioArb])("单调非递减：r1 ≤ r2 ⟹ rank(severity(r1)) ≤ rank(severity(r2))", (a, b) => {
		const [r1, r2] = a <= b ? [a, b] : [b, a];
		return RANK[getBudgetSeverity(r1)] <= RANK[getBudgetSeverity(r2)];
	});
	// 三分区 property 钉死阈值边界（捕捉 0.9/0.7 被改）
	it.prop([f64(0.9, 1)])("r ≥ 0.9 → danger", (r) => getBudgetSeverity(r) === "danger");
	it.prop([f64(0.7, 0.9).filter((r) => r < 0.9)])("0.7 ≤ r < 0.9 → warn", (r) => getBudgetSeverity(r) === "warn");
	it.prop([f64(0, 0.7).filter((r) => r < 0.7)])("r < 0.7 → ok", (r) => getBudgetSeverity(r) === "ok");
});

// ── getBudgetColor（复用 severity 阈值，映射 ThemeColor）──

describe("getBudgetColor", () => {
	it("severity → color 映射（danger→error / warn→warning / ok→muted）", () => {
		expect(getBudgetColor(95)).toBe("error");
		expect(getBudgetColor(75)).toBe("warning");
		expect(getBudgetColor(50)).toBe("muted");
	});
});
