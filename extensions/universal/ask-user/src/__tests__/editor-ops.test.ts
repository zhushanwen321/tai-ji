// src/__tests__/editor-ops.test.ts
//
// editor-ops.ts 独立单元测试。
// 覆盖审查 S5 发现的 surrogate pair 边界盲区：
//   - moveCursorLeft/Right 在 emoji（surrogate pair）边界正确按 code point 移动
//   - deleteCharBeforeCursor 删整个 emoji code point
//
// 之前仅靠 component.test.ts 黑盒间接覆盖，无法直接锁定 surrogate 行为。

import { describe, expect, it } from "vitest";

import {
	deleteCharBeforeCursor,
	handleEditorPaste,
	insertAtCursor,
	moveCursorEnd,
	moveCursorHome,
	moveCursorLeft,
	moveCursorRight,
} from "../editor-ops.js";
import { createQuestionState, type QuestionState } from "../types.js";

function stateWith(text: string, cursor = text.length): QuestionState {
	const s = createQuestionState();
	s.draftText = text;
	s.cursorIndex = cursor;
	return s;
}

describe("moveCursorLeft", () => {
	it("moves left by 1 for ASCII", () => {
		const s = stateWith("abc", 3);
		moveCursorLeft(s);
		expect(s.cursorIndex).toBe(2);
	});

	it("moves left by 1 code point (2 UTF-16 units) for emoji", () => {
		// "a😀b" → length=4 (a=1, 😀=2, b=1)，光标在末尾(4)
		const s = stateWith("a😀b", 4);
		moveCursorLeft(s); // 从 4 → 跳过 b 到 3
		expect(s.cursorIndex).toBe(3);
		moveCursorLeft(s); // 从 3 → 跳过 emoji 到 1（不是 2）
		expect(s.cursorIndex).toBe(1);
	});

	it("does not go below 0", () => {
		const s = stateWith("abc", 0);
		moveCursorLeft(s);
		expect(s.cursorIndex).toBe(0);
	});

	it("stops at 0 after emoji", () => {
		const s = stateWith("😀", 2);
		moveCursorLeft(s);
		expect(s.cursorIndex).toBe(0);
	});
});

describe("moveCursorRight", () => {
	it("moves right by 1 for ASCII", () => {
		const s = stateWith("abc", 0);
		moveCursorRight(s);
		expect(s.cursorIndex).toBe(1);
	});

	it("moves right by 1 code point (2 UTF-16 units) for emoji", () => {
		// "a😀b" → 光标在 0，右移应到 1（a），再到 3（跳过 emoji 的 2 个 unit）
		const s = stateWith("a😀b", 0);
		moveCursorRight(s); // 0 → 1
		expect(s.cursorIndex).toBe(1);
		moveCursorRight(s); // 1 → 3（跳过 😀 的 2 个 unit）
		expect(s.cursorIndex).toBe(3);
	});

	it("does not exceed draftText.length", () => {
		const s = stateWith("ab", 2);
		moveCursorRight(s);
		expect(s.cursorIndex).toBe(2);
	});

	it("stops at end after emoji", () => {
		const s = stateWith("x😀", 1);
		moveCursorRight(s);
		expect(s.cursorIndex).toBe(3); // 跳到末尾
		moveCursorRight(s); // 不超出
		expect(s.cursorIndex).toBe(3);
	});
});

describe("deleteCharBeforeCursor", () => {
	it("deletes single ASCII char", () => {
		const s = stateWith("abc", 2);
		const changed = deleteCharBeforeCursor(s);
		expect(changed).toBe(true);
		expect(s.draftText).toBe("ac");
		expect(s.cursorIndex).toBe(1);
	});

	it("deletes entire emoji code point (2 UTF-16 units)", () => {
		// "a😀b" 光标在 4（末尾），删除应删掉 b → "a😀"
		const s = stateWith("a😀b", 4);
		deleteCharBeforeCursor(s);
		expect(s.draftText).toBe("a😀");
		expect(s.cursorIndex).toBe(3);
		// 再删一次应删掉整个 emoji（2 units），不是只删 1
		deleteCharBeforeCursor(s);
		expect(s.draftText).toBe("a");
		expect(s.cursorIndex).toBe(1);
	});

	it("returns false at cursor 0 (nothing to delete)", () => {
		const s = stateWith("abc", 0);
		const changed = deleteCharBeforeCursor(s);
		expect(changed).toBe(false);
		expect(s.draftText).toBe("abc");
		expect(s.cursorIndex).toBe(0);
	});

	it("deletes emoji at start of text", () => {
		const s = stateWith("😀hello", 2);
		deleteCharBeforeCursor(s);
		expect(s.draftText).toBe("hello");
		expect(s.cursorIndex).toBe(0);
	});
});

describe("insertAtCursor", () => {
	it("inserts text at cursor position", () => {
		const s = stateWith("abc", 1);
		insertAtCursor(s, "X");
		expect(s.draftText).toBe("aXbc");
		expect(s.cursorIndex).toBe(2);
	});
});

describe("moveCursorHome / moveCursorEnd", () => {
	it("home sets cursor to 0", () => {
		const s = stateWith("abc", 2);
		moveCursorHome(s);
		expect(s.cursorIndex).toBe(0);
	});

	it("end sets cursor to draftText.length", () => {
		const s = stateWith("a😀b", 0);
		moveCursorEnd(s);
		expect(s.cursorIndex).toBe(4);
	});
});

describe("handleEditorPaste", () => {
	it("inserts printable text", () => {
		const s = stateWith("ab", 1);
		const changed = handleEditorPaste(s, "XY");
		expect(changed).toBe(true);
		expect(s.draftText).toBe("aXYb");
		expect(s.cursorIndex).toBe(3);
	});

	it("inserts emoji correctly (surrogate pair via Array.from)", () => {
		const s = stateWith("", 0);
		handleEditorPaste(s, "😀");
		expect(s.draftText).toBe("😀");
		expect(s.cursorIndex).toBe(2);
	});

	it("rejects unknown escape sequences (non-bracketed)", () => {
		const s = stateWith("ab", 1);
		const changed = handleEditorPaste(s, "\x1b[6n");
		expect(changed).toBe(false);
		expect(s.draftText).toBe("ab");
	});

	it("strips bracketed paste markers", () => {
		const s = stateWith("", 0);
		const changed = handleEditorPaste(s, "\x1b[200~hello\x1b[201~");
		expect(changed).toBe(true);
		expect(s.draftText).toBe("hello");
	});
});
