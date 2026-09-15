// src/__tests__/submit-view.test.ts
import { describe, expect, it } from "vitest";

import { buildResult, getAnswerText, renderSubmitView } from "../submit-view";
import { createQuestionState, type Question, type QuestionState, type ThemeLike } from "../types";

const stubTheme: ThemeLike = {
	fg: (_t: string, s: string) => s,
	bg: (_t: string, s: string) => s,
	bold: (s: string) => s,
};

const q1: Question = {
	question: "Which DB?",
	header: "Database",
	options: [{ label: "Postgres" }, { label: "SQLite" }],
};

const makeState = (over: Partial<QuestionState> = {}): QuestionState => ({
	...createQuestionState(),
	...over,
});

// ── S-1 ~ S-4: renderSubmitView ──────────────────────────
describe("renderSubmitView", () => {
	it("S-1: shows 'Ready to submit' when all confirmed", () => {
		const states = [makeState({ confirmed: true, selectedIndex: 0 })];
		const lines = renderSubmitView([q1], states, stubTheme, 60);
		expect(lines.some((l) => l.includes("Ready to submit"))).toBe(true);
		expect(lines.some((l) => l.includes("All questions answered"))).toBe(true);
	});

	it("S-2: shows 'Unanswered' when not all confirmed", () => {
		const states = [makeState({ confirmed: false })];
		const lines = renderSubmitView([q1], states, stubTheme, 60);
		expect(lines.some((l) => l.includes("Unanswered"))).toBe(true);
		expect(lines.some((l) => l.includes("Database"))).toBe(true);
	});

	it("S-13: shows 'Still needed: <headers>' line when not all confirmed", () => {
		// S-13 锁定未全确认时渲染的 'Still needed: <missing headers>' 行
		const questions: Question[] = [
			{ question: "Q1", header: "First", options: [{ label: "A" }, { label: "B" }] },
			{ question: "Q2", header: "Second", options: [{ label: "X" }, { label: "Y" }] },
		];
		// Q1 已答，Q2 未答 → Still needed 应列出 Second
		const states = [
			makeState({ confirmed: true, selectedIndex: 0 }),
			makeState({ confirmed: false }),
		];
		const lines = renderSubmitView(questions, states, stubTheme, 60);
		const t = lines.join("\n");
		expect(t).toContain("Still needed");
		expect(t).toContain("Second");
		expect(t).not.toContain("Still needed: First"); // First 已答，不谈入
	});

	it("S-3: lists answered header: answer", () => {
		const states = [makeState({ confirmed: true, selectedIndex: 0 })];
		const lines = renderSubmitView([q1], states, stubTheme, 60);
		expect(lines.some((l) => l.includes("Database") && l.includes("Postgres"))).toBe(true);
	});

	it("S-4: shows dash for unanswered", () => {
		const states = [makeState({ confirmed: false })];
		const lines = renderSubmitView([q1], states, stubTheme, 60);
		expect(lines.some((l) => l.includes("Database") && l.includes("—"))).toBe(true);
	});

	// S-13: 提示行已上移至组件级按钮栏（renderButtonBar）
	it("S-13: submit view does not render its own submit/cancel hints (moved to button bar)", () => {
		const states = [makeState({ confirmed: true, selectedIndex: 0 })];
		const lines = renderSubmitView([q1], states, stubTheme, 60);
		const t = lines.join("\n");
		// 旧的内联提示不再由 submit-view 渲染（由 component.renderButtonBar 负责）
		expect(t).not.toContain("switch tabs");
		expect(t).not.toContain("Press Enter to submit");
	});
});

// ── S-5 ~ S-10: getAnswerText ────────────────────────────
describe("getAnswerText", () => {
	it("S-5: single-select returns AnswerValue with label", () => {
		const s = makeState({ confirmed: true, selectedIndex: 0 });
		expect(getAnswerText(q1, s)).toEqual({ selected: ["Postgres"], other: null });
	});

	it("S-6: multi-select returns labels sorted in index order", () => {
		const multiQ: Question = {
			question: "Features",
			multiSelect: true,
			options: [{ label: "A" }, { label: "B" }, { label: "C" }],
		};
		const s = makeState({ confirmed: true, selectedIndices: new Set([0, 1]) });
		expect(getAnswerText(multiQ, s)).toEqual({ selected: ["A", "B"], other: null });
	});

	it("S-7: multi-select out-of-order toggle still sorts by index", () => {
		const multiQ: Question = {
			question: "Features",
			multiSelect: true,
			options: [{ label: "A" }, { label: "B" }, { label: "C" }],
		};
		// toggle order: 1, then 0, then 2 → Set may iterate 1,0,2 but output should be A, B, C
		const s = makeState({ confirmed: true, selectedIndices: new Set([1, 0, 2]) });
		expect(getAnswerText(multiQ, s)).toEqual({ selected: ["A", "B", "C"], other: null });
	});

	it("S-7b: multi-select out-of-range indices are filtered out (defensive branch)", () => {
		// 锁定 getAnswerText 的防御性 .filter：selectedIndices 含越界 index（超出 options 范围）
		// 时，q.options[idx]?.label 为 undefined，被过滤掉，不污染答案。
		const multiQ: Question = {
			question: "Features",
			multiSelect: true,
			options: [{ label: "A" }, { label: "B" }],
		};
		// index 5 越界（只有 2 个选项），应被过滤；只保留 A
		const s = makeState({ confirmed: true, selectedIndices: new Set([0, 5]) });
		expect(getAnswerText(multiQ, s)).toEqual({ selected: ["A"], other: null });
	});

	it("S-8: Other free-text goes to other field", () => {
		const s = makeState({ confirmed: true, selectedIndex: null, freeTextValue: "custom" });
		expect(getAnswerText(q1, s)).toEqual({ selected: [], other: "custom" });
	});

	it("S-10: unconfirmed returns null", () => {
		const s = makeState({ confirmed: false });
		expect(getAnswerText(q1, s)).toBeNull();
	});

	it("S-11: confirmed but empty (no selection, no freeText, empty multi) returns null", () => {
		// S-11 锁定防御分支：confirmed=true 但无任何答案内容时 getAnswerText 返回 null
		// 场景：单选 selectedIndex=null + freeTextValue=null
		const sEmptySingle = makeState({ confirmed: true, selectedIndex: null, freeTextValue: null });
		expect(getAnswerText(q1, sEmptySingle)).toBeNull();
		// 场景：多选 selectedIndices 空集合
		const multiQ: Question = {
			question: "Features",
			multiSelect: true,
			options: [{ label: "A" }, { label: "B" }],
		};
		const sEmptyMulti = makeState({ confirmed: true, selectedIndices: new Set<number>() });
		expect(getAnswerText(multiQ, sEmptyMulti)).toBeNull();
	});

	it("S-9: selected + other combined in one AnswerValue", () => {
		const multiQ: Question = {
			question: "Features",
			multiSelect: true,
			options: [{ label: "A" }, { label: "B" }],
		};
		const s = makeState({
			confirmed: true,
			selectedIndices: new Set([0, 1]),
			freeTextValue: "nice",
		});
		expect(getAnswerText(multiQ, s)).toEqual({ selected: ["A", "B"], other: "nice" });
	});
});

// ── S-11 ~ S-12: buildResult ─────────────────────────────
describe("buildResult", () => {
	it("S-11: builds answers for all confirmed questions", () => {
		const questions = [q1];
		const states = [makeState({ confirmed: true, selectedIndex: 1 })];
		const result = buildResult(questions, states);
		expect(result.cancelled).toBe(false);
		expect(result.answers["Which DB?"]).toEqual({ selected: ["SQLite"], other: null });
		expect(result.questions).toBe(questions);
	});

	it("S-12: omits unconfirmed questions from answers", () => {
		const questions: Question[] = [
			{ question: "Q1", header: "H1", options: [{ label: "A" }, { label: "B" }] },
			{ question: "Q2", header: "H2", options: [{ label: "X" }, { label: "Y" }] },
		];
		const states = [
			makeState({ confirmed: true, selectedIndex: 0 }),
			makeState({ confirmed: false }),
		];
		const result = buildResult(questions, states);
		expect(result.answers["Q1"]).toEqual({ selected: ["A"], other: null });
		expect(result.answers["Q2"]).toBeUndefined();
	});
});
