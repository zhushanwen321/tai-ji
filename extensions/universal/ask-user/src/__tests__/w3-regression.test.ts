// src/__tests__/w3-regression.test.ts
// W3: Forward regression — freeform/bksp edge cases.
// No-op keymap coverage moved to component-keymap.test.ts (deduplicated).
import { describe, expect, it } from "vitest";

import { AskUserComponent } from "../component";
import type { Question, Result } from "../types";
import {
	BACKSPACE,
	DOWN,
	ENTER,
	ESC,
	HOME,
	LEFT,
	mockTui,
	multiQ,
	RIGHT,
	singleQ,
	stubTheme,
} from "./fixtures";

const make = (
	questions: Question[] = [singleQ],
): { c: AskUserComponent; result: { val: Result | null | undefined } } => {
	const result = { val: undefined as Result | null | undefined };
	const c = new AskUserComponent(questions, mockTui, stubTheme, (r) => (result.val = r));
	return { c, result };
};

/** Helper: open freeform editor on singleQ (navigate to Other → Enter) */
function openFreeform(c: AskUserComponent): void {
	c.handleInput(DOWN); // 0→1
	c.handleInput(DOWN); // 1→2 (Other)
	c.handleInput(ENTER); // open freeform
}

// ── C-BC4B: freeform Enter clears selectedIndex (BC-4b regression) ──
describe("W3 — freeform Enter clears selectedIndex (C-BC4B)", () => {
	it("C-BC4B: freeform text overrides selected option in result", () => {
		const { c, result } = make([singleQ]);
		// Navigate to Other (index 2) and open freeform
		c.handleInput(DOWN); // 0→1
		c.handleInput(DOWN); // 1→2 (Other)
		c.handleInput(ENTER); // open freeform
		c.handleInput("custom answer");
		c.handleInput(ENTER); // confirm freeform → afterConfirm → submit
		expect(result.val).toBeDefined();
		// The answer should be the freeform text
		expect(result.val!.answers["Which DB?"]).toEqual({ selected: [], other: "custom answer" });
	});

	it("C-BC4B-SELECT: freeform on same question clears selectedIndex", () => {
		const { c, result } = make(multiQ);
		// Q1: stay on cursorIndex=0 (A), open freeform via Other
		c.handleInput(DOWN); // 0→1
		c.handleInput(DOWN); // 1→2 (Other)
		c.handleInput(ENTER); // open freeform
		c.handleInput("override");
		c.handleInput(ENTER); // confirm freeform → afterConfirm → advance to Q2
		// Q2: select X
		c.handleInput(ENTER); // select X
		c.handleInput(ENTER); // confirm → advance to Q3
		// Q3: select M
		c.handleInput(ENTER); // select M
		c.handleInput(ENTER); // confirm → advance to submit
		// Submit
		c.handleInput(ENTER);
		expect(result.val).toBeDefined();
		// Q1 answer should be the freeform text only
		expect(result.val!.answers["Q1"]).toEqual({ selected: [], other: "override" });
	});
});

// ── C-BKSP-EDGE: backspace at cursorIndex=0 ──

describe("W3 — backspace at cursorIndex=0 (C-BKSP-EDGE)", () => {
	it("C-BKSP-EDGE: backspace at cursorIndex=0 is no-op on empty text", () => {
		const { c } = make();
		// 打开 freeform 编辑器
		openFreeform(c);
		c.handleInput(BACKSPACE); // 空文本 + cursorIndex=0
		// 不应 crash
		const lines = c.render(60);
		// 编辑器仍然可见（反色空格光标）
		expect(lines.some((l: string) => l.includes("\x1b[7m"))).toBe(true);
	});

	it("C-BKSP-EDGE-2: backspace at cursorIndex=0 on non-empty text is no-op", () => {
		const { c } = make();
		openFreeform(c);
		c.handleInput("abc");
		c.handleInput(HOME); // 移到开头
		c.handleInput(BACKSPACE); // cursorIndex=0，不应删除
		const lines = c.render(60);
		const editorLine = lines.find((l: string) => l.includes("\x1b[7m"));
		// 文本完整保留（去除 ANSI 转义码后检查）
		const stripped = editorLine!.replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped).toContain("abc");
	});
});
