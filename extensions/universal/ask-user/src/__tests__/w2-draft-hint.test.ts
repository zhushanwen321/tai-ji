// src/__tests__/w2-draft-hint.test.ts
// W2: draftText migration (#2) + handleInput split (#3) + hint line (#4)
import { describe, expect, it } from "vitest";

import { AskUserComponent } from "../component";
import type { Question, Result } from "../types";
import {
	DOWN,
	ENTER,
	ESC,
	LEFT,
	mockTui,
	multiQ,
	RIGHT,
	singleQ,
	stubTheme,
	UP,
} from "./fixtures";

const make = (
	questions: Question[],
): { c: AskUserComponent; result: { val: Result | null | undefined } } => {
	const result = { val: undefined as Result | null | undefined };
	const c = new AskUserComponent(questions, mockTui, stubTheme, (r) => (result.val = r));
	return { c, result };
};

// ── draftText migration: per-question draft persistence ──
describe("W2 — draftText migration", () => {
	it("C-DRAFT-1: freeform draft persists when switching tabs away and back", () => {
		const { c } = make(multiQ);
		// Q1: navigate to Other (index 2), open freeform, type "abc"
		c.handleInput(DOWN); // 0→1
		c.handleInput(DOWN); // 1→2 (Other)
		c.handleInput(ENTER);
		c.handleInput("abc");
		c.handleInput(ESC); // back to options
		// Switch to Q2 and back to Q1
		c.handleInput(RIGHT);
		c.handleInput(LEFT);
		// Re-enter freeform
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(ENTER);
		const lines = c.render(80);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toBeDefined();
		expect(editorLine).toContain("abc");
	});

	it("C-DRAFT-2: drafts on different questions are independent", () => {
		const { c } = make(multiQ);
		// Q1: type "aaa"
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(ENTER);
		c.handleInput("aaa");
		c.handleInput(ESC);
		// Navigate to Q3
		c.handleInput(RIGHT);
		c.handleInput(RIGHT);
		// Q3: type "ccc"
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(ENTER);
		c.handleInput("ccc");
		c.handleInput(ESC);
		// Go back to Q1
		c.handleInput(LEFT);
		c.handleInput(LEFT);
		// Re-enter freeform on Q1
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(ENTER);
		const lines1 = c.render(80);
		const editorLine1 = lines1.find((l) => l.includes("\x1b[7m"));
		expect(editorLine1).toContain("aaa");
		expect(editorLine1).not.toContain("ccc");
	});
});

// ── hint line: append-only UX hint ──
describe("W2 — hint line", () => {
	it("C-HINT-1: freeform editor hint contains all expected hints", () => {
		const { c } = make([singleQ]);
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(ENTER);
		const lines = c.render(80);
		const hintLine = lines.find((l: string) => l.includes("move") && l.includes("Backspace deletes"));
		expect(hintLine).toBeDefined();
		expect(hintLine).toContain("Enter submit");
		expect(hintLine).toContain("Esc back");
	});
});

// ── freeDraft 隔离：丢弃的 freeform 草稿不污染答案、不触发 auto-confirm ──
describe("C-FREEDRAFT: discarded draft isolation", () => {
	it("C-FREEDRAFT-1: discarded freeform draft blocks submit (Q1 stays unconfirmed)", () => {
		const { c, result } = make(multiQ);
		// Q1: 打开 freeform，输入草稿 "abc"，ESC 丢弃（存入 freeDraft，但不 confirmed）
		c.handleInput(DOWN);  // 0→1
		c.handleInput(DOWN);  // 1→2 (Other)
		c.handleInput(ENTER); // 打开 freeform
		c.handleInput("abc");
		c.handleInput(ESC);   // freeDraft="abc"，回到 options，Q1 仍未答
		// 跳到 Submit tab 尝试提交
		c.handleInput(RIGHT); // → Q2
		c.handleInput(RIGHT); // → Q3
		c.handleInput(RIGHT); // → Submit tab
		c.handleInput(ENTER); // allConfirmed=false → 提交被阻塞
		expect(result.val).toBeUndefined();
	});

	it("C-FREEDRAFT-2: discarded draft does not appear in submitted answers", () => {
		const { c, result } = make(multiQ);
		// Q1: freeform 草稿 "abc" → ESC 丢弃 → 改选选项 A
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(ENTER); // freeform
		c.handleInput("abc");
		c.handleInput(ESC);   // 丢弃草稿，光标回到 Other
		c.handleInput(UP);    // 2→1
		c.handleInput(UP);    // 1→0 (A)
		c.handleInput(ENTER); // 选 A → confirmed → advance Q2
		// Q2 (multiSelect): 选 X → confirmed → advance Q3
		c.handleInput(ENTER);
		// Q3: 选 M → confirmed → advance Submit tab
		c.handleInput(ENTER);
		// Submit
		c.handleInput(ENTER);
		expect(result.val).toBeDefined();
		expect(result.val!.answers["Q1"]).toEqual({ selected: ["A"], other: null });
		// 丢弃的草稿 "abc" 不应出现在任何答案中
		expect(JSON.stringify(result.val!.answers)).not.toContain("abc");
	});
});
