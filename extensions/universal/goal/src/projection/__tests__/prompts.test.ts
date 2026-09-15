/**
 * projection/prompts.test.ts 测试 — prompt 生成函数 + budget 片段格式化
 *
 * 覆盖：
 * - formatBudgetPercent / formatBudgetLine
 * - escapeXmlText（XML 注入防护）
 * - continuationPrompt / budgetLimitPrompt / objectiveUpdatedPrompt / contextInjectionPrompt
 *
 * 全解耦后 stalenessReminderPrompt 已删（原依赖 pi.__todoGetList，跨 ext 失效）。
 *
 * 纯函数测试，不 import Pi SDK。
 */
import { describe, expect, it } from "vitest";

import { createGoalState } from "../../engine/goal";
import type { GoalRuntimeState } from "../../engine/types";
import {
	budgetLimitPrompt,
	contextInjectionPrompt,
	continuationPrompt,
	escapeXmlText,
	formatBudgetLine,
	formatBudgetPercent,
	objectiveUpdatedPrompt,
} from "../prompts";

// ── 辅助 ─────────────────────────────────────────────

function makeState(overrides?: Partial<GoalRuntimeState>): GoalRuntimeState {
	return {
		...createGoalState("test objective"),
		...overrides,
	};
}

// ── budget 片段格式化 ────────────────────────────────

describe("formatBudgetPercent", () => {
	it("有预算 → Token 百分比", () => {
		const state = makeState({
			budget: { tokenBudget: 1000 },
			tokensUsed: 500,
		});
		const out = formatBudgetPercent(state);
		expect(out).toContain("Token: 50%");
	});

	it("无预算 → 空字符串", () => {
		const state = makeState();
		expect(formatBudgetPercent(state)).toBe("");
	});
});

describe("formatBudgetLine", () => {
	it("有预算 → 剩余/总量格式", () => {
		const state = makeState({
			budget: { tokenBudget: 1000 },
			tokensUsed: 300,
		});
		const out = formatBudgetLine(state);
		expect(out).toContain("Tokens: 700/1000");
	});

	it("无预算 → 空字符串", () => {
		const state = makeState();
		expect(formatBudgetLine(state)).toBe("");
	});
});

// ── escapeXmlText（XML 注入防护）──────────────────────

describe("XML escaping in prompts", () => {
	it("objective 中的 <>& 被转义（continuationPrompt）", () => {
		const state = makeState({ objective: "<script>alert('x')</script> & data" });
		const out = continuationPrompt(state);
		expect(out).toContain("&lt;script&gt;");
		expect(out).toContain("&amp; data");
		expect(out).not.toContain("<script>");
	});

	it("objectiveUpdatedPrompt 转义新旧 objective", () => {
		const state = makeState({ objective: "new <b>x</b>" });
		const out = objectiveUpdatedPrompt(state, "old <i>y</i> & z");
		expect(out).toContain("&lt;b&gt;x&lt;/b&gt;");
		expect(out).toContain("&lt;i&gt;y&lt;/i&gt;");
		expect(out).toContain("&amp; z");
	});

	it("U16b: 已转义输入无条件二次转义（行为锁定，不做实体识别）", () => {
		expect(escapeXmlText("already escaped: &amp; <tag>")).toBe(
			"already escaped: &amp;amp; &lt;tag&gt;",
		);
	});
});

// ── continuationPrompt ───────────────────────────────

describe("continuationPrompt", () => {
	it("含 objective + Turn + Completion audit 段落", () => {
		const state = makeState({ currentTurnIndex: 3 });
		const out = continuationPrompt(state);
		expect(out).toContain("Turn 3");
		expect(out).toContain("test objective");
		expect(out).toContain("Completion audit");
	});

	it("对标 Codex 三约束：Completion audit / Fidelity / Blocked 完整", () => {
		const state = makeState();
		const out = continuationPrompt(state);
		// Completion audit: 逐项证据验证
		expect(out).toContain("Completion audit");
		expect(out).toContain("Evidence must prove completion");
		expect(out).toContain("are NOT evidence");
		// Fidelity: 不缩小目标范围
		expect(out).toContain("Fidelity");
		expect(out).toContain("requested end state");
		expect(out).toContain("narrower or safer solution");
		// Blocked: 不首次就放弃
		expect(out).toContain("Blocked");
		expect(out).toContain("Do not report blocked the first time");
		expect(out).toContain("try alternative approaches first");
	});

	it("软建议 complete 前完成所有 todo（FR-6，全解耦后非强制）", () => {
		const state = makeState();
		const out = continuationPrompt(state);
		expect(out).toContain("Recommend finishing all todos");
		expect(out).toContain("verification todos");
	});

	it("含 plan audit 软提醒（FR-7/D27 prompt 驱动）", () => {
		const state = makeState();
		const out = continuationPrompt(state);
		expect(out).toContain("plan.md step was executed");
	});
});

// ── budgetLimitPrompt ────────────────────────────────

describe("budgetLimitPrompt", () => {
	it("token 预算 → TOKEN budget 提示", () => {
		const state = makeState({
			budget: { tokenBudget: 1000 },
			tokensUsed: 950,
		});
		const out = budgetLimitPrompt(state);
		expect(out).toContain("TOKEN budget");
		expect(out).toContain("Tokens used: 950 / 1000");
		expect(out).toContain("wrap up immediately");
	});
});

// ── objectiveUpdatedPrompt ───────────────────────────

describe("objectiveUpdatedPrompt", () => {
	it("显示新旧 objective + 指令", () => {
		const state = makeState({ objective: "new obj" });
		const out = objectiveUpdatedPrompt(state, "old obj");
		expect(out).toContain("Objective updated");
		expect(out).toContain("Previous objective: old obj");
		expect(out).toContain("new obj");
		expect(out).toContain("supersedes");
	});
});

// ── contextInjectionPrompt ───────────────────────────

describe("contextInjectionPrompt", () => {
	it("包含 objective/status/turn + 预算百分比 + 3 条铁律（TC2 核心段保留）", () => {
		const state = makeState({
			status: "active",
			currentTurnIndex: 2,
			budget: { tokenBudget: 1000 },
			tokensUsed: 200,
		});
		const out = contextInjectionPrompt(state);
		expect(out).toContain("GOAL mode activated");
		expect(out).toContain("Status: active");
		expect(out).toContain("Turn: 2");
		expect(out).toContain("Token: 20%"); // 200/1000
		expect(out).toContain("test objective");
		// 3 条铁律（C3：原 4 条合并为 3 条）
		expect(out).toContain("Work from evidence");
		expect(out).toContain("Track remaining work");
		expect(out).toContain("report blocked with what you tried");
	});

	it("完整 state（含 budget+successCriteria）≤600 chars（TC1 硬指标）", () => {
		const state = makeState({
			objective: "Refactor the auth module to use JWT and add integration tests",
			successCriteria: ["src/auth.ts uses JWT", "pnpm test auth green", "tsc --noEmit clean"],
			status: "active",
			currentTurnIndex: 2,
			budget: { tokenBudget: 1000 },
			tokensUsed: 200,
		});
		const out = contextInjectionPrompt(state);
		expect(out.length).toBeLessThanOrEqual(600);
	});

	it("删除冗余段（TC3）：不含 todo 引导/plan 提示/Fidelity/Audit", () => {
		const state = makeState();
		const out = contextInjectionPrompt(state);
		// todo 引导段已删（收敛到 continuation 软建议）
		expect(out).not.toContain("Track work with todos");
		expect(out).not.toContain("todo tool");
		// plan 提示段已删（收敛到 continuation）
		expect(out).not.toContain("plan mode");
		expect(out).not.toContain("__planStart");
		// Fidelity/Audit 段已删（收敛到 continuation）
		expect(out).not.toContain("Fidelity");
		expect(out).not.toContain("Audit");
	});

	it("无 goal_manager 引用（#1 清理后）", () => {
		const state = makeState();
		const out = contextInjectionPrompt(state);
		expect(out).not.toContain("goal_manager");
		expect(out).not.toContain("create_tasks");
		expect(out).not.toContain("add_subtasks");
	});

	it("无 planAvailable 参数（TC4 签名精简：仅 state）", () => {
		// planAvailable 恒 true 死分支已删；签名仅 (state)
		const state = makeState();
		expect(() => contextInjectionPrompt(state)).not.toThrow();
		const out = contextInjectionPrompt(state);
		expect(out).toContain("[GOAL mode activated]");
	});
});

// ── successCriteria 注入（完成验证基准，与 objective 成对）──

describe("successCriteria 注入（<successCriteria> 段 + 条件文案）", () => {
	it("continuationPrompt：有 successCriteria → 含 <successCriteria> 段 + 条件文案", () => {
		const state = makeState({ successCriteria: ["pnpm test passes", "tsc clean"] });
		const out = continuationPrompt(state);
		expect(out).toContain("<successCriteria>");
		expect(out).toContain("</successCriteria>");
		expect(out).toContain("1. pnpm test passes");
		expect(out).toContain("2. tsc clean");
		// 条件文案（continuationPrompt 专属）
		expect(out).toContain("every condition there must be met");
	});

	it("budgetLimitPrompt：有 successCriteria → 含 <successCriteria> 段 + 条件文案", () => {
		const state = makeState({
			successCriteria: ["all tests green"],
			budget: { tokenBudget: 1000 },
		});
		const out = budgetLimitPrompt(state);
		expect(out).toContain("<successCriteria>");
		expect(out).toContain("all tests green");
		// 条件文案（budgetLimitPrompt 专属）
		expect(out).toContain("every successCriteria condition is met");
	});

	it("contextInjectionPrompt：有 successCriteria → 含 <successCriteria> 段 + 条件文案", () => {
		const state = makeState({ successCriteria: ["file X exists"] });
		const out = contextInjectionPrompt(state);
		expect(out).toContain("<successCriteria>");
		expect(out).toContain("file X exists");
		// 条件文案（contextInjectionPrompt 专属）
		expect(out).toContain("meeting every successCriteria above");
	});

	it("U29: objectiveUpdatedPrompt：有 successCriteria → 注入编号列表（补齐第 4 个 prompt 函数）", () => {
		const state = makeState({ successCriteria: ["cond A", "cond B"] });
		const out = objectiveUpdatedPrompt(state, "old obj");
		expect(out).toContain("<successCriteria>");
		expect(out).toContain("1. cond A");
		expect(out).toContain("2. cond B");
	});

	it("无 successCriteria → 不含 <successCriteria> 段（锁定 fallback）", () => {
		const state = makeState(); // createGoalState 不带 successCriteria
		const out = continuationPrompt(state);
		expect(out).not.toContain("<successCriteria>");
		expect(out).not.toContain("every condition there must be met");
	});

	it("U17: successCriteria 空数组 → 与 undefined 同为空态，prompt 不增 <successCriteria> 段", () => {
		const state = makeState({ successCriteria: [] });
		expect(continuationPrompt(state)).not.toContain("<successCriteria>");
		expect(budgetLimitPrompt(state)).not.toContain("<successCriteria>");
		expect(objectiveUpdatedPrompt(state, "old obj")).not.toContain("<successCriteria>");
		expect(contextInjectionPrompt(state)).not.toContain("<successCriteria>");
		// 条件文案同样不出现（continuationPrompt 专属分支）
		expect(continuationPrompt(state)).not.toContain("every condition there must be met");
	});

	it("successCriteria 中的 <>& 被转义（防注入）", () => {
		const state = makeState({ successCriteria: ["<x> & y"] });
		const out = continuationPrompt(state);
		expect(out).toContain("&lt;x&gt;");
		expect(out).toContain("&amp; y");
		expect(out).not.toContain("<x>");
	});
});
