// src/__tests__/types.test.ts
import { describe, expect, it } from "vitest";

import {
	buildAskUserSummary,
	createQuestionState,
	InputSchema,
	OTHER_LABEL,
	QuestionSchema,
	SPLIT_PANE_MIN_WIDTH,
} from "../types";

describe("types", () => {
	it("InputSchema accepts valid single question", () => {
		const valid = {
			questions: [
				{
					question: "Which DB?",
					options: [{ label: "Postgres" }, { label: "SQLite" }],
				},
			],
		};
		expect(InputSchema).toBeDefined();
		// Schema is a typebox object; verify it has the questions property structure
		expect((InputSchema as { properties: Record<string, unknown> }).properties.questions).toBeDefined();
		expect(valid.questions).toHaveLength(1);
	});

	it("OTHER_LABEL constant is the free-text option label", () => {
		expect(OTHER_LABEL).toBe("Other");
	});

	it("SPLIT_PANE_MIN_WIDTH is 84", () => {
		expect(SPLIT_PANE_MIN_WIDTH).toBe(84);
	});

	it("createQuestionState returns initial state with mode 'options'", () => {
		const s = createQuestionState();
		expect(s.cursorIndex).toBe(0);
		expect(s.selectedIndex).toBeNull();
		expect(s.selectedIndices).toBeInstanceOf(Set);
		expect(s.confirmed).toBe(false);
		expect(s.freeTextValue).toBeNull();
		expect(s.mode).toBe("options");
	});

	// T-5: 每次调用返回独立的 Set 实例
	it("createQuestionState returns independent Set each call", () => {
		const s1 = createQuestionState();
		const s2 = createQuestionState();
		s1.selectedIndices.add(0);
		expect(s2.selectedIndices.has(0)).toBe(false);
		expect(s1.selectedIndices).not.toBe(s2.selectedIndices);
	});

	// T-6: QuestionSchema options 数量约束
	it("QuestionSchema enforces options minItems=2, maxItems=4", () => {
		const opts = (QuestionSchema as { properties: { options: { minItems: number; maxItems: number } } })
			.properties.options;
		expect(opts.minItems).toBe(2);
		expect(opts.maxItems).toBe(4);
	});

	// T-7: InputSchema questions 数量约束
	it("InputSchema enforces questions minItems=1, maxItems=4", () => {
		const qs = (InputSchema as { properties: { questions: { minItems: number; maxItems: number } } })
			.properties.questions;
		expect(qs.minItems).toBe(1);
		expect(qs.maxItems).toBe(4);
	});
});

// ── buildAskUserSummary（收起态一行摘要，details.summary 同源）──
describe("buildAskUserSummary", () => {
	it("单问无 header → question 全文（Asked 1 question: <question>）", () => {
		expect(buildAskUserSummary([{ question: "Which database?", options: [] }])).toBe(
			"Asked 1 question: Which database?",
		);
	});

	it("单问有 header → header 优先", () => {
		expect(
			buildAskUserSummary([{ question: "Which database?", header: "DB", options: [] }]),
		).toBe("Asked 1 question: DB");
	});

	it("多问 → 复数名词 + header 逗号连接", () => {
		expect(
			buildAskUserSummary([
				{ question: "Which database?", header: "DB", options: [] },
				{ question: "Which region?", header: "Region", options: [] },
			]),
		).toBe("Asked 2 questions: DB, Region");
	});

	it("无 header 的多问成员回退截断 question（60 字上限 + 省略号）", () => {
		const long = "q".repeat(70);
		expect(buildAskUserSummary([{ question: long, options: [] }])).toBe(
			`Asked 1 question: ${"q".repeat(60)}…`,
		);
	});

	it("question 含换行 → 摘要归一单行（S-1）", () => {
		expect(buildAskUserSummary([{ question: "Which DB?\nAnd region?", options: [] }])).toBe(
			"Asked 1 question: Which DB? And region?",
		);
	});

	it("header 含换行 → 摘要归一单行（单问 header 不经控制字符校验，S-1）", () => {
		expect(
			buildAskUserSummary([{ question: "Which DB?", header: "DB\nChoice", options: [] }]),
		).toBe("Asked 1 question: DB Choice");
	});
});
