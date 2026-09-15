// src/__tests__/component-keymap.test.ts
// Key leak regression tests (#1 parseKey whitelist interception)
import { describe, expect, it } from "vitest";

import { AskUserComponent } from "../component";
import type { Question } from "../types";
import {
	ALT_DOWN,
	ALT_LEFT,
	ALT_RIGHT,
	ALT_UP,
	APC,
	BKSP,
	CTRL_DOWN,
	CTRL_LEFT,
	CTRL_RIGHT,
	CTRL_SHIFT_DOWN,
	CTRL_SHIFT_UP,
	CTRL_UP,
	DA1,
	DA2,
	DCS,
	DELETE,
	DOWN,
	END,
	ENTER,
	ESC,
	F1,
	HOME,
	INSERT,
	LEFT,
	make,
	OSC_BEL,
	OSC_ST,
	PAGE_DOWN,
	PAGE_UP,
	RIGHT,
	SHIFT_DOWN,
	SHIFT_LEFT,
	SHIFT_RIGHT,
	SHIFT_UP,
	singleQ,
	SUPER_DOWN,
	SUPER_LEFT,
	SUPER_RIGHT,
	SUPER_UP,
	TAB,
	UNKNOWN_CSI,
	UNKNOWN_SS3,
	UP,
} from "./fixtures";

/** Helper: 打开 freeform 编辑器并返回 component（不渲染，避免缓存） */
function openFreeform(q: Question[]): AskUserComponent {
	const { c } = make(q);
	// Navigate to Other (last option) and open editor
	for (let i = 0; i < 10; i++) c.handleInput(DOWN); // go to last
	c.handleInput(ENTER); // open freeform
	return c;
}

describe("AskUserComponent — key leak fix (C-ARROW / C-KEYMAP)", () => {
	// ── C-ARROW-1: 连按 3 次右箭头，editorText 不含 [ 或 C ──
	it("C-ARROW-1: arrow keys do not leak escape sequences into editorText", () => {
		const c = openFreeform([singleQ]);
		c.handleInput(RIGHT); // \x1b[C — should be no-op
		c.handleInput(RIGHT);
		c.handleInput(RIGHT);
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toBeDefined();
		// BUG: before fix, [C[C[C would appear. After fix: editorText stays empty.
		expect(editorLine).not.toContain("\x1b[A"); expect(editorLine).not.toContain("\x1b[B"); expect(editorLine).not.toContain("\x1b[C"); expect(editorLine).not.toContain("\x1b[D");
	});

	// ── C-ARROW-2: direction keys + text input → correct cursor behavior ──
	it("C-ARROW-2: mixed arrow keys and text input with cursor movement", () => {
		const c = openFreeform([singleQ]);
		c.handleInput(DOWN);   // no-op
		c.handleInput(RIGHT);  // no-op (empty text)
		c.handleInput("a");   // insert at 0 → "a", cursor=1
		c.handleInput(UP);     // no-op
		c.handleInput(LEFT);   // cursor 1→0
		c.handleInput("b");   // insert at 0 → "ba", cursor=1
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toBeDefined();
		// cursor at 1: "b█a" — 去 ANSI 后文本为 "ba"（精确顺序证明 insert 位置：b 在 a 前）
		const stripped = editorLine!.replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped).toContain("ba");
		// Ensure no leaked sequences
		expect(editorLine).not.toContain("\x1b[A"); expect(editorLine).not.toContain("\x1b[B"); expect(editorLine).not.toContain("\x1b[C"); expect(editorLine).not.toContain("\x1b[D");
	});

	// ── C-KEYMAP-UP: up key no-op in editor ──
	it("C-KEYMAP-UP: up arrow is no-op in freeform editor", () => {
		const c = openFreeform([singleQ]);
		c.handleInput("a");
		c.handleInput(UP);
		c.handleInput("b");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toContain("ab");
	});

	// ── C-KEYMAP-DOWN: down key no-op in editor ──
	it("C-KEYMAP-DOWN: down arrow is no-op in freeform editor", () => {
		const c = openFreeform([singleQ]);
		c.handleInput("a");
		c.handleInput(DOWN);
		c.handleInput("b");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toContain("ab");
	});

	// ── C-KEYMAP-LEFT: left arrow moves cursor ──
	it("C-KEYMAP-LEFT: left arrow moves cursor left in freeform editor", () => {
		const c = openFreeform([singleQ]);
		c.handleInput("ab");  // "ab", cursor=2
		c.handleInput(LEFT);   // cursor 2→1
		c.handleInput("c");   // insert at 1 → "acb", cursor=2
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		// cursor at 2: "ac█b" — 去 ANSI 后精确文本 "acb"（证明 c 插在 a 与 b 之间）
		const stripped = editorLine!.replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped).toContain("acb");
	});

	// ── C-KEYMAP-HOME: home key moves cursor to start ──
	it("C-KEYMAP-HOME: home key moves cursor to start in freeform editor", () => {
		const c = openFreeform([singleQ]);
		c.handleInput("abc");  // cursor=3
		c.handleInput(HOME);    // cursor 3→0
		c.handleInput("d");    // insert at 0 → "dabc", cursor=1
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		// cursor at 1: "d\x1b[7ma\x1b[27mbc" — 去 ANSI 后精确文本 "dabc"（证明 d 插在开头）
		const stripped = editorLine!.replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped).toContain("dabc");
	});

	// ── C-KEYMAP-END: end key moves cursor to end ──
	it("C-KEYMAP-END: end key moves cursor to end in freeform editor", () => {
		const c = openFreeform([singleQ]);
		c.handleInput("abc");  // cursor=3
		c.handleInput(HOME);    // cursor 3→0
		c.handleInput(END);     // cursor 0→3
		c.handleInput("d");    // insert at 3 → "abcd", cursor=4
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		// cursor at 4 (end): "abcd█"
		expect(editorLine).toContain("abcd");
	});

	// ── C-KEYMAP-INSERT: insert key no-op (cursor preserved) ──
	it("C-KEYMAP-INSERT: insert key is no-op in freeform editor", () => {
		const c = openFreeform([singleQ]);
		c.handleInput("abc");  // cursor=3
		c.handleInput(INSERT);  // no-op, cursor stays at 3
		c.handleInput("d");    // insert at 3 → "abcd", cursor=4
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toContain("abcd");
	});

	// ── C-KEYMAP-PGUP: page up no-op (cursor preserved) ──
	it("C-KEYMAP-PGUP: page up is no-op in freeform editor", () => {
		const c = openFreeform([singleQ]);
		c.handleInput("abc");  // cursor=3
		c.handleInput(PAGE_UP); // no-op, cursor stays at 3
		c.handleInput("d");    // insert at 3 → "abcd", cursor=4
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toContain("abcd");
	});

	// ── C-KEYMAP-PGDN: page down no-op (cursor preserved) ──
	it("C-KEYMAP-PGDN: page down is no-op in freeform editor", () => {
		const c = openFreeform([singleQ]);
		c.handleInput("abc");  // cursor=3
		c.handleInput(PAGE_DOWN); // no-op, cursor stays at 3
		c.handleInput("d");    // insert at 3 → "abcd", cursor=4
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toContain("abcd");
	});

	// ── C-KEYMAP-F1: f1 key no-op (cursor preserved) ──
	it("C-KEYMAP-F1: F1 key is no-op in freeform editor", () => {
		const c = openFreeform([singleQ]);
		c.handleInput("abc");  // cursor=3
		c.handleInput(F1);      // no-op, cursor stays at 3
		c.handleInput("d");    // insert at 3 → "abcd", cursor=4
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toContain("abcd");
	});

	// ── C-KEYMAP-DELETE: delete key no-op (not backspace) ──
	it("C-KEYMAP-DELETE: delete key is no-op in freeform editor (not backspace)", () => {
		const c = openFreeform([singleQ]);
		c.handleInput("abc");  // cursor=3
		c.handleInput(DELETE);  // no-op, cursor stays at 3
		c.handleInput("d");    // insert at 3 → "abcd", cursor=4
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toContain("abcd");
	});

	// ── C-KEYMAP-TAB: Tab 在编辑器内 no-op（不切 tab、不泄漏）──
	it("C-KEYMAP-TAB: Tab is no-op in freeform editor (no tab switch, no leak)", () => {
		const c = openFreeform([singleQ]);
		c.handleInput("a");
		c.handleInput(TAB);  // parseKey 命中 "tab" 但编辑器无对应分支 → no-op
		c.handleInput("b");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toBeDefined();
		const stripped = editorLine!.replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped).toContain("ab");
		expect(stripped).not.toContain("\t");
	});

	// ── C-KEYMAP-SPACE: space character appends correctly ──
	it("C-KEYMAP-SPACE: space character is appended (parseKey special case)", () => {
		const c = openFreeform([singleQ]);
		c.handleInput("a");
		c.handleInput(" "); // space — parseKey(" ") returns "space" not a printable char
		c.handleInput("b");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toBeDefined();
		expect(editorLine).toContain("a b");
	});

	// ── C-KEYMAP-ESC: Esc in editor still works (semantic key) ──
	it("C-KEYMAP-ESC: Esc in freeform still discards and returns to options", () => {
		const c = openFreeform([singleQ]);
		c.handleInput("abc");
		c.handleInput(ESC); // should discard and go back to options
		const lines = c.render(60);
		// No more editor (back in options mode)
		expect(lines.some((l) => l.includes("\x1b[7m"))).toBe(false);
	});

	// ── C-KEYMAP-BKSP: backspace still works (semantic key) ──
	it("C-KEYMAP-BKSP: backspace still deletes last char", () => {
		const c = openFreeform([singleQ]);
		c.handleInput("abc");
		c.handleInput(BKSP); // delete 'c'
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toContain("ab");
		expect(editorLine).not.toContain("abc");
	});

	// ── C-KEYMAP-MOD: modifier key combinations matrix (18 cases) ──
	const modifierCases: Array<{ name: string; seq: string }> = [
		{ name: "ctrl+up", seq: CTRL_UP },
		{ name: "ctrl+down", seq: CTRL_DOWN },
		{ name: "ctrl+left", seq: CTRL_LEFT },
		{ name: "ctrl+right", seq: CTRL_RIGHT },
		{ name: "alt+up", seq: ALT_UP },
		{ name: "alt+down", seq: ALT_DOWN },
		{ name: "alt+left", seq: ALT_LEFT },
		{ name: "alt+right", seq: ALT_RIGHT },
		{ name: "shift+up", seq: SHIFT_UP },
		{ name: "shift+down", seq: SHIFT_DOWN },
		{ name: "shift+left", seq: SHIFT_LEFT },
		{ name: "shift+right", seq: SHIFT_RIGHT },
		{ name: "super+up", seq: SUPER_UP },
		{ name: "super+down", seq: SUPER_DOWN },
		{ name: "super+left", seq: SUPER_LEFT },
		{ name: "super+right", seq: SUPER_RIGHT },
		{ name: "ctrl+shift+up", seq: CTRL_SHIFT_UP },
		{ name: "ctrl+shift+down", seq: CTRL_SHIFT_DOWN },
	];

	for (const { name, seq } of modifierCases) {
		it(`C-KEYMAP-MOD-${name}: ${name} modifier combo is no-op in editor`, () => {
			const c = openFreeform([singleQ]);
			c.handleInput("x");
			c.handleInput(seq); // modifier combo → should be no-op
			c.handleInput("y");
			const lines = c.render(60);
			const editorLine = lines.find((l) => l.includes("\x1b[7m"));
			expect(editorLine).toBeDefined();
			expect(editorLine).toContain("xy");
			// No leaked characters from the escape sequence
			expect(editorLine).not.toContain("\x1b[A"); expect(editorLine).not.toContain("\x1b[B"); expect(editorLine).not.toContain("\x1b[C"); expect(editorLine).not.toContain("\x1b[D");
			expect(editorLine).not.toContain(";");
		});
	}
});

describe("AskUserComponent — unknown control sequence leak fix (C-CSI)", () => {
	it("C-CSI-1: unknown CSI sequence does not leak into editorText", () => {
		const c = openFreeform([singleQ]);
		c.handleInput(UNKNOWN_CSI);
		c.handleInput("a");
		c.handleInput("b");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toBeDefined();
		expect(editorLine).toContain("ab");
		expect(editorLine).not.toContain("\x1b[A"); expect(editorLine).not.toContain("\x1b[B"); expect(editorLine).not.toContain("\x1b[C"); expect(editorLine).not.toContain("\x1b[D");
		expect(editorLine).not.toContain("9");
		expect(editorLine).not.toContain("~");
	});

	it("C-CSI-2: OSC11 background color response (BEL) does not leak", () => {
		const c = openFreeform([singleQ]);
		c.handleInput(OSC_BEL);
		c.handleInput("x");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toBeDefined();
		expect(editorLine).toContain("x");
		expect(editorLine).not.toContain("]");
		expect(editorLine).not.toContain("rgb");
	});

	it("C-CSI-3: OSC11 background color response (ST) does not leak", () => {
		const c = openFreeform([singleQ]);
		c.handleInput(OSC_ST);
		c.handleInput("y");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toBeDefined();
		expect(editorLine).toContain("y");
		expect(editorLine).not.toContain("]");
		expect(editorLine).not.toContain("rgb");
	});

	it("C-CSI-4: DA2 device attribute response does not leak", () => {
		const c = openFreeform([singleQ]);
		c.handleInput(DA2);
		c.handleInput("m");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toBeDefined();
		expect(editorLine).toContain("m");
		expect(editorLine).not.toContain("\x1b[A"); expect(editorLine).not.toContain("\x1b[B"); expect(editorLine).not.toContain("\x1b[C"); expect(editorLine).not.toContain("\x1b[D");
	});

	it("C-CSI-5: DA1 device attribute response does not leak", () => {
		const c = openFreeform([singleQ]);
		c.handleInput(DA1);
		c.handleInput("n");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toBeDefined();
		expect(editorLine).toContain("n");
		expect(editorLine).not.toContain("?");
	});

	it("C-CSI-6: DCS XTVersion response does not leak", () => {
		const c = openFreeform([singleQ]);
		c.handleInput(DCS);
		c.handleInput("d");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toBeDefined();
		expect(editorLine).toContain("d");
		expect(editorLine).not.toContain("tmux");
	});

	it("C-CSI-7: APC Kitty graphics response does not leak", () => {
		const c = openFreeform([singleQ]);
		c.handleInput(APC);
		c.handleInput("e");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toBeDefined();
		expect(editorLine).toContain("e");
		expect(editorLine).not.toContain("G");
	});

	it("C-CSI-8: unknown SS3 sequence does not leak", () => {
		const c = openFreeform([singleQ]);
		c.handleInput(UNKNOWN_SS3);
		c.handleInput("f");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toBeDefined();
		expect(editorLine).toContain("f");
		expect(editorLine).not.toContain("O");
		expect(editorLine).not.toContain("Z");
	});

	it("C-CSI-9: multiple unknown sequences in a row do not leak", () => {
		const c = openFreeform([singleQ]);
		c.handleInput(UNKNOWN_CSI);
		c.handleInput(DA2);
		c.handleInput("ok");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toBeDefined();
		expect(editorLine).toContain("ok");
		expect(editorLine).not.toContain("\x1b[A"); expect(editorLine).not.toContain("\x1b[B"); expect(editorLine).not.toContain("\x1b[C"); expect(editorLine).not.toContain("\x1b[D");
	});

	it("C-CSI-10: unknown CSI does not leak in editor", () => {
		const c = openFreeform([singleQ]);
		c.handleInput(UNKNOWN_CSI);
		c.handleInput("ab");
		const lines = c.render(60);
		const textLine = lines.find((l) => l.includes("ab"));
		expect(textLine).toBeDefined();
		expect(textLine).toContain("ab");
		const allText = lines.join("\n");
		expect(allText).not.toMatch(/\[9/);
	});

	it("C-CSI-R1: plain text still appended correctly", () => {
		const c = openFreeform([singleQ]);
		c.handleInput("hello");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toContain("hello");
	});

	it("C-CSI-R2: emoji still appended correctly", () => {
		const c = openFreeform([singleQ]);
		c.handleInput("fix the 🐛 bug");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toContain("fix the 🐛 bug");
	});

	it("C-CSI-R3: Chinese text still appended correctly", () => {
		const c = openFreeform([singleQ]);
		c.handleInput("你好");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toContain("你好");
	});

	it("C-CSI-R4: bracketed paste still works", () => {
		const c = openFreeform([singleQ]);
		c.handleInput("\x1b[200~hello\x1b[201~");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toContain("hello");
		expect(editorLine).not.toContain("[200~");
	});
});

// 🐛 = U+1F41B，UTF-16 surrogate pair（占 2 个 code unit，index 1=高代理 / 2=低代理）。
// 验证光标移动/Backspace 按整个 code point 跳跃，不会停在代理中间（index 2）拆散 emoji。
describe("C-SURROGATE: cursor movement across surrogate pairs", () => {
	it("C-SUR-BS: backspace at end deletes a full surrogate pair (deleteCount=2)", () => {
		const c = openFreeform([singleQ]);
		c.handleInput("ab🐛"); // 🐛 在末尾，cursorIndex=4（a b 高 低）
		c.handleInput(BKSP);   // 删整个 🐛（非半个低代理），cursorIndex 4→2
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toBeDefined();
		const stripped = editorLine!.replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped).toContain("ab");
		expect(stripped).not.toContain("🐛");
	});

	it("C-SUR-RIGHT: Right skips surrogate middle (cursor 1→3, not 2)", () => {
		const c = openFreeform([singleQ]);
		c.handleInput("a🐛b"); // cursorIndex=4
		c.handleInput(HOME);   // cursor 4→0
		c.handleInput(RIGHT);  // cursor 0→1（a 后；isHighSurrogate(0)='a'→ false）
		c.handleInput(RIGHT);  // cursor 1→3（isHighSurrogate(1)=高代理 → 跳 2，不停在代理中间 2）
		c.handleInput("X");    // 在 cursor 3 插入 → "a🐛Xb"（X 在 🐛 后、b 前）
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toBeDefined();
		const stripped = editorLine!.replace(/\x1b\[[0-9;]*m/g, "");
		// X 落在 🐛 之后证明 cursor 跳到了 3；若停在代理中间 2 会拆散 🐛，不含完整 "a🐛Xb"
		expect(stripped).toContain("a🐛Xb");
	});

	it("C-SUR-LEFT: Left skips surrogate middle (cursor 4→1, not 2)", () => {
		const c = openFreeform([singleQ]);
		c.handleInput("a🐛b"); // cursorIndex=4
		c.handleInput(END);    // cursor 4（保险，已在末尾）
		c.handleInput(LEFT);   // cursor 4→3（🐛 与 b 之间）
		c.handleInput(LEFT);   // cursor 3→1（newLeft-1=高代理 → 跳 2，不停在代理中间 2）
		c.handleInput("Y");    // 在 cursor 1 插入 → "aY🐛b"（Y 在 🐛 前）
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toBeDefined();
		const stripped = editorLine!.replace(/\x1b\[[0-9;]*m/g, "");
		// Y 落在 🐛 之前证明 cursor 跳到了 1；若停在代理中间 2 会拆散 🐛，不含完整 "aY🐛b"
		expect(stripped).toContain("aY🐛b");
	});
});
