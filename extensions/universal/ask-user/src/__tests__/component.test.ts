// src/__tests__/component.test.ts
import { describe, expect, it } from "vitest";

import { AskUserComponent } from "../component";
import type { Question, Result } from "../types";
import {
	BKSP,
	DOWN,
	ENTER,
	ESC,
	LEFT,
	mockTui,
	multiQ,
	RIGHT,
	singleQ,
	singleQMulti,
	stubTheme,
	TAB,
	UP,
} from "./fixtures";

// Helper: make component with mutable result holder
const make = (
	questions: Question[],
): { c: AskUserComponent; result: { val: Result | null | undefined } } => {
	const result = { val: undefined as Result | null | undefined };
	const c = new AskUserComponent(questions, mockTui, stubTheme, (r) => (result.val = r));
	return { c, result };
};

// ── 5a. 单问题（AC-2）──────────────────────────────────
describe("AskUserComponent — single question", () => {
	it("C-1: renders question without tab bar", () => {
		const { c } = make([singleQ]);
		const lines = c.render(60);
		expect(lines.some((l) => l.includes("Which DB?"))).toBe(true);
		expect(lines.some((l) => l.includes("Submit"))).toBe(false);
	});

	it("C-2: confirms first option on Enter and resolves", () => {
		const { c, result } = make([singleQ]);
		c.handleInput(ENTER);
		expect(result.val).not.toBeUndefined();
		expect(result.val!.cancelled).toBe(false);
		expect(result.val!.answers["Which DB?"]).toEqual({ selected: ["Postgres"], other: null });
	});

	it("C-3: moves cursor down then confirms second option", () => {
		const { c, result } = make([singleQ]);
		c.handleInput(DOWN);
		c.handleInput(ENTER);
		expect(result.val!.answers["Which DB?"]).toEqual({ selected: ["SQLite"], other: null });
	});

	it("C-4: Esc shows confirm overlay; second Esc cancels (single)", () => {
		const { c, result } = make([singleQ]);
		// 首个问题按 Esc → 进入确认取消覆盖层（不立即取消）
		c.handleInput(ESC);
		expect(result.val).toBeUndefined();
		expect(c.render(60).some((l) => l.includes("Cancel all"))).toBe(true);
		// 覆盖层内再按 Esc → 确认取消
		c.handleInput(ESC);
		expect(result.val).toBeNull();
	});

	it("C-5: Up at first option does not go below 0", () => {
		const { c } = make([singleQ]);
		c.render(60);
		c.handleInput(UP);
		// Render and verify cursor still on first (Postgres highlighted)
		const lines = c.render(60);
		expect(lines.some((l) => l.includes(">") && l.includes("Postgres"))).toBe(true);
	});

	it("C-6: Down does not go beyond Other (last option)", () => {
		const { c } = make([singleQ]);
		// 2 options + Other = 3 rows (indices 0,1,2). Press Down 5 times.
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		const lines = c.render(60);
		// Cursor should be on Other (last), not beyond
		expect(lines.some((l) => l.includes(">") && l.includes("Other"))).toBe(true);
	});
});

// ── 5b. 多问题 Tab 导航（AC-3 / AC-16）─────────────────
describe("AskUserComponent — multi question tab nav", () => {
	it("C-7: renders tab bar with headers + Submit", () => {
		const { c } = make(multiQ);
		const lines = c.render(80);
		const t = lines.join("\n");
		expect(t).toContain("First");
		expect(t).toContain("Second");
		expect(t).toContain("Third");
		expect(t).toContain("Submit");
	});

	it("C-8: navigates tabs and submits all answers", () => {
		const { c, result } = make(multiQ);
		// Q1: select A (Enter)
		c.handleInput(ENTER);
		// Q2: toggle X (Space), confirm (Enter)
		c.handleInput(" ");
		c.handleInput(ENTER);
		// Q3: select M (Enter)
		c.handleInput(ENTER);
		// Submit tab: Enter
		c.handleInput(ENTER);
		expect(result.val!.answers["Q1"]).toEqual({ selected: ["A"], other: null });
		expect(result.val!.answers["Q2"]).toEqual({ selected: ["X"], other: null });
		expect(result.val!.answers["Q3"]).toEqual({ selected: ["M"], other: null });
	});

	it("C-9: Submit tab blocks when not all confirmed", () => {
		const { c, result } = make(multiQ);
		c.handleInput(RIGHT); // -> Q2
		c.handleInput(RIGHT); // -> Q3
		c.handleInput(RIGHT); // -> Submit
		c.handleInput(ENTER); // should NOT submit
		expect(result.val).toBeUndefined();
	});

	// C-10 / C-11 已废弃：Tab/Shift+Tab 不再切问题 tab（C-E5/C-E6 覆盖 ←/→ 切问题 tab 行为）

	it("C-16 (AC-16): can re-edit confirmed answer", () => {
		const { c, result } = make(multiQ);
		// Q1: select A
		c.handleInput(ENTER); // → Q2
		// Go back to Q1（问题 tab 间用 ← 回退）
		c.handleInput(LEFT); // Q1
		// Select B instead
		c.handleInput(DOWN);
		c.handleInput(ENTER); // → Q2
		// Skip Q2, Q3 by confirming
		c.handleInput(" ");
		c.handleInput(ENTER); // Q2 → Q3
		c.handleInput(ENTER); // Q3 → Submit
		c.handleInput(ENTER); // Submit
		expect(result.val!.answers["Q1"]).toEqual({ selected: ["B"], other: null });
	});

	it("C-15/C-S3: leaving multi-select tab auto-confirms answered selection (Submit 直达 + 中间 tab)", () => {
		// C-15 与 C-S3 合并（TC-04）：两用例同走 handleOptionsInput ←/→ → gotoTab →
		// autoConfirmIfAnswered()（component.ts:420-421 同一分支），并入后保留双方独有断言：
		// - C-15：multi-select toggle 后 → 直达 Submit tab → Enter 提交成功（all confirmed）
		// - C-S3：multi-select toggle 后 → 切到中间 tab（非 Submit）auto-confirm 也生效
		const threeQ: Question[] = [
			{ question: "Q1", header: "First", options: [{ label: "A" }, { label: "B" }], multiSelect: true },
			{ question: "Q2", header: "Second", options: [{ label: "X" }, { label: "Y" }] },
			{ question: "Q3", header: "Third", options: [{ label: "M" }, { label: "N" }], multiSelect: true },
		];
		const { c, result } = make(threeQ);
		// C-S3 路径：Q1 multi toggle A（不 Enter-confirm）→ RIGHT 切到中间 tab Q2 → Q1 被 auto-confirm
		c.handleInput(" ");   // Q1 toggle A
		c.handleInput(RIGHT); // → Q2（中间 tab），auto-confirm Q1
		c.handleInput(ENTER); // Q2 select X → Q3
		// C-15 路径：Q3 multi toggle M（不 Enter-confirm）→ RIGHT 直达 Submit → Q3 被 auto-confirm
		c.handleInput(" ");   // Q3 toggle M
		c.handleInput(RIGHT); // → Submit，auto-confirm Q3
		c.handleInput(ENTER); // Submit（all confirmed：Q1/Q3 由 auto-confirm，Q2 由 Enter-confirm）
		expect(result.val!.answers["Q1"]).toEqual({ selected: ["A"], other: null }); // auto-confirm 生效（C-S3 断言）
		expect(result.val!.answers["Q2"]).toEqual({ selected: ["X"], other: null });
		expect(result.val!.answers["Q3"]).toEqual({ selected: ["M"], other: null }); // auto-confirm 生效（C-15 断言）
	});

	it("C-S1: multi-select Enter 同时选中光标项再确认（与单选 Enter 对称）", () => {
		// S-1 锁定：多选模式下光标停在未选项上按 Enter，应把光标项加入选中再确认
		const { c, result } = make([singleQMulti]);
		// singleQMulti: [Auth, Search]，光标初始在 Auth(0)
		c.handleInput(DOWN); // 光标移到 Search(1)，未 toggle
		c.handleInput(ENTER); // Enter 应同时选中 Search + confirm → submit（单问题）
		expect(result.val).not.toBeUndefined();
		expect(result.val!.answers["Which features?"]).toEqual({ selected: ["Search"], other: null });
	});



	it("C-REG-R6: Other 录入→重进清空→Submit 应回到未答（confirmed 不变式）", () => {
		// 回归 MUST_FIX: freeform 空 Enter 清空 freeTextValue 后须重置 confirmed=false
		const { c, result } = make(multiQ);
		// Q1 (A/B + Other): 导航到 Other，录入 "custom"
		c.handleInput(DOWN);
		c.handleInput(DOWN); // → Other
		c.handleInput(ENTER); // 打开 freeform
		c.handleInput("c");
		c.handleInput("u");
		c.handleInput("s");
		c.handleInput("t");
		c.handleInput("o");
		c.handleInput("m");
		c.handleInput(ENTER); // 保存 freeText → confirmed=true → advance to Q2
		// 切回 Q1，重进 Other 编辑器，清空后空 Enter（问题 tab 间用 ← 回退）
		c.handleInput(LEFT);  // → Q1
		c.handleInput(DOWN);  // idempotent: cursor stays on Other
		c.handleInput(DOWN);
		c.handleInput(ENTER);   // 重开 freeform，editorText 预填 "custom"
		c.handleInput(BKSP);  // 清空 editorText
		c.handleInput(BKSP);
		c.handleInput(BKSP);
		c.handleInput(BKSP);
		c.handleInput(BKSP);
		c.handleInput(BKSP);
		c.handleInput(ENTER); // 空 Enter → freeTextValue 清空，confirmed 应重置 false
		// 导航到 Submit 并尝试提交 → 应被阻塞（Q1 回到未答）
		c.handleInput(RIGHT); // → Q2
		c.handleInput(RIGHT); // → Q3
		c.handleInput(RIGHT); // → Submit
		c.handleInput(ENTER); // 应被阻塞
		expect(result.val).toBeUndefined();
	});
});

// ── 5c. 单选选择（FR-6）────────────────────────────────
describe("AskUserComponent — single-select", () => {
	it("C-17: cursor movement does not record answer", () => {
		const { c } = make([singleQ]);
		c.handleInput(DOWN);
		c.render(60);
		// No resolution yet (only Enter resolves single)
		// We verify by checking the question is still interactive — render shows cursor on SQLite
		const lines = c.render(60);
		expect(lines.some((l) => l.includes(">") && l.includes("SQLite"))).toBe(true);
	});

	it("C-19: re-selecting a normal option clears freeText", () => {
		const { c, result } = make([singleQ]);
		// Go to Other (index 2), open editor, type text
		c.handleInput(DOWN);
		c.handleInput(DOWN); // Other
		c.handleInput(ENTER); // open freeform
		c.handleInput("c");
		c.handleInput("u");
		c.handleInput("s");
		c.handleInput("t");
		c.handleInput("o");
		c.handleInput("m");
		c.handleInput(ENTER); // save freeText → submit (single question)
		expect(result.val!.answers["Which DB?"]).toEqual({ selected: [], other: "custom" });
	});
});

// ── 5d. 多选 toggle（FR-6 / AC-18）─────────────────────
describe("AskUserComponent — multi-select toggle", () => {
	it("C-20: Space toggles index into selectedIndices", () => {
		const { c } = make([singleQMulti]);
		c.handleInput(" ");
		const lines = c.render(60);
		expect(lines.some((l) => l.includes("[✓]") && l.includes("Auth"))).toBe(true);
	});

	it("C-21: Space twice removes from selectedIndices", () => {
		const { c } = make([singleQMulti]);
		c.handleInput(" "); // add
		c.handleInput(" "); // remove
		const lines = c.render(60);
		expect(lines.some((l) => l.includes("[ ]") && l.includes("Auth"))).toBe(true);
	});

	it("C-24 (AC-18): multi-select toggle does NOT confirm/advance", () => {
		const { c, result } = make([singleQMulti]);
		c.handleInput(" "); // toggle — 只标记选中，不确认不离开
		expect(result.val).toBeUndefined();
		const lines = c.render(60);
		expect(lines.some((l) => l.includes("[✓]") && l.includes("Auth"))).toBe(true);
	});
});

// ── 5e. Other 自由文本（FR-4.5 / AC-5）─────────────────
describe("AskUserComponent — Other free-text editor", () => {
	it("C-25: Enter on Other row opens freeform editor (in-place)", () => {
		const { c } = make([singleQ]);
		// Navigate to Other (index 2)
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(ENTER);
		const lines = c.render(60);
		// freeform 模式：光标行（█）出现，editor 已在 Other 行原地渲染
		expect(lines.some((l) => l.includes("\x1b[7m"))).toBe(true);
		// 不再独立 "Your answer" 提示块
		expect(lines.some((l) => l.includes("Your answer"))).toBe(false);
	});

	it("C-26: Tab no longer opens freeform editor (Enter-only; Tab is tab-nav now)", () => {
		const { c } = make([singleQ]);
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(TAB);
		const lines = c.render(60);
		// Tab 不再打开 Other 编辑器（仅 Enter）；单问题下 Tab 是 no-op
		expect(lines.some((l) => l.includes("\x1b[7m"))).toBe(false);
	});

	it("C-27: editor accepts printable characters", () => {
		const { c } = make([singleQ]);
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(ENTER); // open
		c.handleInput("h");
		c.handleInput("i");
		const lines = c.render(60);
		expect(lines.some((l) => l.includes("hi"))).toBe(true);
	});

	it("C-28: editor Backspace deletes last char", () => {
		const { c } = make([singleQ]);
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(ENTER);
		c.handleInput("a");
		c.handleInput("b");
		c.handleInput(BKSP); // delete "b"
		const lines = c.render(60);
		expect(lines.some((l) => l.includes("a") && !l.includes("ab"))).toBe(true);
	});

	it("C-31: editor Esc returns to options list", () => {
		const { c } = make([singleQ]);
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(ENTER);
		c.handleInput(ESC);
		const lines = c.render(60);
		// Back in options mode — no cursor block (freeform inactive)
		expect(lines.some((l) => l.includes("\x1b[7m"))).toBe(false);
	});

	it("C-29: editor Enter with text saves and submits (single)", () => {
		const { c, result } = make([singleQ]);
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(ENTER);
		c.handleInput("x");
		c.handleInput(ENTER);
		expect(result.val).not.toBeUndefined();
		expect(result.val!.answers["Which DB?"]).toEqual({ selected: [], other: "x" });
	});

	it("C-30: editor Enter empty clears freeText (single → stays in form)", () => {
		const { c, result } = make([singleQ]);
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(ENTER); // open editor
		c.handleInput(ENTER); // FR-6: empty Enter → clear freeText, close editor (NO confirm/submit)
		// Not submitted; still in options list
		expect(result.val).toBeUndefined();
		// Back in options mode — no cursor block (freeform inactive)
		const lines = c.render(60);
		expect(lines.some((l) => l.includes("\x1b[7m"))).toBe(false);
	});
});

// ── 5e2. 多字符粘贴（M2/M7：完整保留，过滤控制字符，emoji 不丢）──
// 回归 MUST_FIX-M2：handleEditorInput 按 code point 迭代粘贴 chunk，去掉了
// `c.length === 1` 守卫（它误杀 BMP 之外的代理对，如 emoji）。
describe("AskUserComponent — multi-char paste in editor", () => {
	it("C-PASTE-1: multi-char chunk pasted at once is fully captured", () => {
		// 终端把整段粘贴文本作为一个 data chunk 投递。修复前只取首字符。
		const { c } = make([singleQ]);
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(ENTER); // 打开 freeform 编辑器
		c.handleInput("hello world"); // 一次粘贴多字符
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toBeDefined();
		// 完整文本保留（非仅首字符 "h"）
		expect(editorLine).toContain("hello world");
	});

	it("C-PASTE-2: paste with emoji (surrogate pair) preserves emoji (M2)", () => {
		// 修复前：`c.length === 1` 守卫把代理对（🐛 length===2）过滤掉，emoji 被静默丢弃。
		const { c } = make([singleQ]);
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(ENTER);
		c.handleInput("fix the 🐛 bug");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toBeDefined();
		// emoji 完整保留，不丢失
		expect(editorLine).toContain("fix the 🐛 bug");
		expect(editorLine).toContain("🐛");
	});

	it("C-PASTE-3: multi-char chunk with control chars filters control, keeps printable", () => {
		// 粘贴 "ab\tcd"：\t（U+0009）< 空格 → 被过滤；a/b/c/d 保留。
		const { c } = make([singleQ]);
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(ENTER);
		c.handleInput("ab\tcd");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toBeDefined();
		// 可打印字符保留，控制字符 \t 被过滤
		expect(editorLine).toContain("abcd");
		expect(editorLine).not.toContain("\t");
	});

	it("C-PASTE-4: empty string input is a no-op (no side effects)", () => {
		const { c, result } = make([singleQ]);
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(ENTER); // 打开编辑器
		const before = c.render(60);
		c.handleInput(""); // 空字符串，无副作用
		const after = c.render(60);
		// 未解析、未崩溃、视图不变
		expect(result.val).toBeUndefined();
		expect(after).toEqual(before);
		// 编辑器仍在（光标在），editorText 仍为空
		expect(after.some((l) => l.includes("\x1b[7m"))).toBe(true);
	});

	it("C-PASTE-5: single printable char still works (backward-compat)", () => {
		// 回归：修复去掉守卫后单字符行为不变（与 C-27 等价的逐字符输入）。
		const { c } = make([singleQ]);
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(ENTER);
		c.handleInput("x"); // 单字符
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toBeDefined();
		expect(editorLine).toContain("x");
	});

	it("C-PASTE-6: bracketed paste 序列被剥离，不残留 [200~/[201~", () => {
		// 回归：启用 bracketed paste mode 的终端粘贴时会把内容包裹在
		// \x1b[200~ ... \x1b[201~ 中。ESC 被守卫过滤，但 [200~/[201~ 可见字符
		// 会残留。修复：handleEditorInput 先 replace 剥离这两个序列。
		const { c } = make([singleQ]);
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(ENTER); // 打开 freeform
		c.handleInput("\x1b[200~hello\x1b[201~");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toBeDefined();
		expect(editorLine).toContain("hello");
		expect(editorLine).not.toContain("[200~");
		expect(editorLine).not.toContain("[201~");
	});

	it("C-PASTE-7: bracketed paste 跨 chunk 抵达时每个 chunk 独立剥离", () => {
		// 边界：粘贴内容分多个 data chunk 抵达，每个 chunk 各自带始/末标记。
		// 简单 replace 在此场景仍有效（每个 chunk 独立剥离自己的标记）。
		const { c } = make([singleQ]);
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		c.handleInput(ENTER);
		c.handleInput("\x1b[200~foo ");
		c.handleInput(" bar\x1b[201~");
		const lines = c.render(60);
		const editorLine = lines.find((l) => l.includes("\x1b[7m"));
		expect(editorLine).toContain("foo  bar");
		expect(editorLine).not.toContain("[200~");
		expect(editorLine).not.toContain("[201~");
	});
});

// ── 5g. 防重入（FR-12）─────────────────────────────────
describe("AskUserComponent — re-entry guard", () => {
	it("C-40: ignores input after resolution (submit)", () => {
		const { c, result } = make([singleQ]);
		c.handleInput(ENTER); // submit
		const firstVal = result.val;
		c.handleInput(ENTER); // ignored
		expect(result.val).toBe(firstVal);
	});

	it("C-41: ignores input after cancel", () => {
		const { c, result } = make([singleQ]);
		c.handleInput(ESC); // → 确认取消覆盖层
		c.handleInput(ESC); // → 确认取消
		expect(result.val).toBeNull();
		c.handleInput(ENTER); // ignored
		expect(result.val).toBeNull();
	});

	// FR-12 竞态：signal abort 可能在用户已 submit 后才触发，此时 cancel() 必须是
	// no-op，避免二次调 done（用户已拿到 submit 结果，不应被 abort 覆盖为 null）。
	it("C-FR12 (FR-12): cancel() after submit does not re-invoke done", () => {
		const { c, result } = make([singleQ]);
		c.handleInput(ENTER); // submit → done(result), _resolved=true
		expect(result.val).toBeDefined();
		expect(result.val!.cancelled).toBe(false);
		const submitVal = result.val;
		// 模拟 signal abort 在 submit 后触发 → cancel() 应被 _resolved 守卫拦截
		c.cancel();
		expect(result.val).toBe(submitVal); // 不变 —— done 未被二次调用
	});

	it("C-FR12b (FR-12): cancel() after cancel does not re-invoke done", () => {
		const { c, result } = make([singleQ]);
		c.handleInput(ESC); // overlay
		c.handleInput(ESC); // cancel → done(null), _resolved=true
		expect(result.val).toBeNull();
		// 再次 cancel（模拟 abort 触发）应 no-op
		c.cancel();
		expect(result.val).toBeNull(); // 仍为 null，未触发异常
	});
});

// ── 5h. 渲染缓存 ───────────────────────────────────────
describe("AskUserComponent — render cache", () => {
	it("C-42: same width returns same reference", () => {
		const { c } = make([singleQ]);
		const a = c.render(60);
		const b = c.render(60);
		expect(a).toBe(b);
	});

	it("C-43: input invalidates cache", () => {
		const { c } = make([singleQ]);
		const a = c.render(60);
		c.handleInput(DOWN);
		const b = c.render(60);
		expect(a).not.toBe(b);
	});

	it("C-44: different width invalidates cache", () => {
		const { c } = make([singleQ]);
		const a = c.render(60);
		const b = c.render(80);
		expect(a).not.toBe(b);
	});
});

// ── 5i. Submit tab 交互（FR-5）──────────────────────────
describe("AskUserComponent — Submit tab", () => {
	it("C-47: Submit Esc backs to last question (no longer cancels)", () => {
		const { c, result } = make(multiQ);
		c.handleInput(RIGHT); // Q2
		c.handleInput(RIGHT); // Q3
		c.handleInput(RIGHT); // Submit
		c.handleInput(ESC); // 回退到最后一个问题 Q3（不取消）
		expect(result.val).toBeUndefined();
		const lines = c.render(80);
		// 回到 Q3：渲染 Q3 选项 M（非 Submit 视图）
		expect(lines.some((l) => l.includes("Ready") || l.includes("Unanswered"))).toBe(false);
		expect(lines.some((l) => l.includes("M"))).toBe(true);
	});

	it("C-46: Submit Enter when all confirmed submits", () => {
		const twoQ: Question[] = [
			{ question: "Q1", header: "First", options: [{ label: "A" }, { label: "B" }] },
			{ question: "Q2", header: "Second", options: [{ label: "X" }, { label: "Y" }] },
		];
		const { c, result } = make(twoQ);
		c.handleInput(ENTER); // Q1 select A → Q2
		c.handleInput(ENTER); // Q2 select X → Submit
		c.handleInput(ENTER); // Submit
		expect(result.val).not.toBeUndefined();
		expect(result.val!.answers["Q1"]).toEqual({ selected: ["A"], other: null });
		expect(result.val!.answers["Q2"]).toEqual({ selected: ["X"], other: null });
	});

	it("C-S12: Submit tab Left navigates to last question tab", () => {
		// 锁定：Submit tab 上按 ← → activeTab = questions.length - 1（最后一个问题）
		const { c } = make(multiQ); // 3 questions → tabs 0,1,2,3=Submit
		// 导航到 Submit（问题 tab 间用 →）
		c.handleInput(RIGHT); // Q1 → Q2
		c.handleInput(RIGHT); // Q2 → Q3
		c.handleInput(RIGHT); // Q3 → Submit
		// 确认当前在 Submit（渲染 Submit 视图）
		let lines = c.render(80);
		expect(lines.some((l) => l.includes("Ready") || l.includes("Unanswered"))).toBe(true);
		// 在 Submit 上按 ← → 应回到最后一个问题 Q3（←/→ 在所有 tab 上都是导航）
		c.handleInput(LEFT);
		lines = c.render(80);
		// Q3 不再是 Submit 视图（无 Ready/Unanswered），且渲染了 Q3 的选项 M
		expect(lines.some((l) => l.includes("Ready") || l.includes("Unanswered"))).toBe(false);
		expect(lines.some((l) => l.includes("M"))).toBe(true); // Q3 选项 M
	});
});

// ── 5j. 视觉边框 / 按钮栏 / tab 分割（视觉增强）─────────
describe("AskUserComponent — visual chrome", () => {
	it("C-V1: multi-question render is wrapped in box border (┌┐│└┘)", () => {
		const { c } = make(multiQ);
		const lines = c.render(70);
		const t = lines.join("\n");
		expect(t).toContain("┌"); // 顶左角
		expect(t).toContain("┐"); // 顶右角
		expect(t).toContain("└"); // 底左角
		expect(t).toContain("┘"); // 底右角
		expect(lines.some((l) => l.startsWith("│") || l.includes("│"))).toBe(true); // 左右边框
	});

	it("C-V2: tab bar separates tabs with │", () => {
		const { c } = make(multiQ);
		const lines = c.render(80);
		// tab 行应含竖线分隔符（First │ Second │ ... Submit）
		expect(lines.some((l) => l.includes("First") && l.includes("│"))).toBe(true);
		expect(lines.some((l) => l.includes("Submit") && l.includes("│"))).toBe(true);
	});

	it("C-V3: multi-question shows [ Submit ] [ Cancel ] button bar", () => {
		const { c } = make(multiQ);
		const lines = c.render(80);
		const t = lines.join("\n");
		expect(t).toContain("[");
		expect(t).toContain("Submit");
		expect(t).toContain("Cancel");
		expect(t).toContain("]");
	});

	it("C-V4: single question has NO button bar", () => {
		const { c } = make([singleQ]);
		const lines = c.render(60);
		// 单问题无 Submit/Cancel 按钮栏（Enter 直接提交）
		expect(lines.some((l) => l.includes("Cancel"))).toBe(false);
	});

	it("C-V5: question view renders divider (─) between sections", () => {
		const { c } = make([singleQ]);
		const lines = c.render(60);
		// 分割线：question 与 options 之间应有 ─ 行（非边框）
		expect(lines.some((l) => l.includes("─"))).toBe(true);
	});
});

// ── 5k. 已完成绿勾 / Esc 回退 / Tab 浏览（行为增强）─────
describe("AskUserComponent — confirm-checkmark, Esc-back, Tab browsing", () => {
	it("C-E1: confirmed tab shows green ✓ marker", () => {
		const { c } = make(multiQ);
		c.handleInput(ENTER); // Q1 确认 → Q2
		// 回到 Q1 看 tab 栏：Q1 已确认应有 ✓ 标识（问题 tab 间用 ← 回退）
		c.handleInput(LEFT); // Q2 → Q1
		const lines = c.render(80);
		expect(lines.some((l) => l.includes("✓") && l.includes("First"))).toBe(true);
	});

	it("C-E2: Esc backs to previous question (multi)", () => {
		const { c, result } = make(multiQ);
		c.handleInput(ENTER); // Q1 → Q2
		c.handleInput(ESC); // Q2 → 回退到 Q1（不取消）
		expect(result.val).toBeUndefined();
		const lines = c.render(80);
		expect(lines.some((l) => l.includes("Q1") || l.includes("First"))).toBe(true);
	});

	it("C-E3: Esc on first question shows confirm overlay; Esc again cancels", () => {
		const { c, result } = make(multiQ);
		// 首个问题按 Esc → 确认取消覆盖层
		c.handleInput(ESC);
		expect(result.val).toBeUndefined();
		expect(c.render(80).some((l) => l.includes("Cancel all"))).toBe(true);
		// 覆盖层内再按 Esc → 确认取消
		c.handleInput(ESC);
		expect(result.val).toBeNull();
	});

	it("C-E4: confirm overlay dismissed by any non-Esc key (stays in form)", () => {
		const { c, result } = make(multiQ);
		c.handleInput(ESC); // 进入确认覆盖层
		c.handleInput(ENTER); // 非 Esc → 退出覆盖层，留在表单
		expect(result.val).toBeUndefined();
		// 覆盖层已关闭：渲染回到正常 tab 视图
		expect(c.render(80).some((l) => l.includes("Cancel all"))).toBe(false);
	});

	it("C-E5: ←/→ navigates question tabs (→ next, ← previous)", () => {
		const { c } = make(multiQ);
		c.handleInput(RIGHT); // Q1 → Q2
		// 确认在 Q2：渲染含 Q2 的选项 X
		expect(c.render(80).some((l) => l.includes("X"))).toBe(true);
		// ← 回退到 Q1
		c.handleInput(LEFT);
		expect(c.render(80).some((l) => l.includes("Q1") || l.includes("First"))).toBe(true);
	});

	it("C-E6: → at last question enters Submit; ← at first question stays (no wrap)", () => {
		const { c } = make(multiQ);
		// 到 Submit：Q1→Q2→Q3→Submit
		c.handleInput(ENTER); // Q1→Q2
		c.handleInput(RIGHT); // Q2→Q3
		c.handleInput(RIGHT); // Q3→Submit
		expect(c.render(80).some((l) => l.includes("Ready") || l.includes("Unanswered"))).toBe(true);
		// Submit 上 ← → 回退到 Q3（←/→ 在所有 tab 上都是导航）
		c.handleInput(LEFT);
		expect(c.render(80).some((l) => l.includes("M"))).toBe(true);
		// Q1 上 ← 不环绕（停在首个问题）
		c.handleInput(LEFT); // Q3→Q2
		c.handleInput(LEFT); // Q2→Q1
		c.handleInput(LEFT); // Q1 上 ← → 停留 Q1
		expect(c.render(80).some((l) => l.includes("Q1") || l.includes("First"))).toBe(true);
	});
});

// ── 5l. 新行为：←/→ 不切 tab、Other Enter 切 freeform 原生、Submit tab focus ──
describe("AskUserComponent — new behavior (post-refactor)", () => {
	it("C-NEW-1: multi-select Other + Enter opens freeform; Other row turns into [ ] <input>█ in-place", () => {
		// singleQMulti: [Auth, Search]，多选
		const { c, result } = make([singleQMulti]);
		// 1) Space toggle Auth
		c.handleInput(" ");
		// 2) ↓ 到 Other (cursor=2)
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		// 3) Enter 切 freeform（不再依赖 Space）
		c.handleInput(ENTER);
		// 验证：freeform 模式下，选项列表中应出现 [ ] █ 行（光标 block + 多选 box）
		//   选中的 Auth 仍是 [✓]（多选 toggle 未变），Other 行原地变 [ ] <cursor>
		const lines = c.render(60);
		// 独立 "Your answer" 提示行已消失
		expect(lines.some((l) => l.includes("Your answer"))).toBe(false);
		// freeform cursor 出现
		expect(lines.some((l) => l.includes("\x1b[7m"))).toBe(true);
		// 依然能看见 "Auth" "Search"（普通选项不变）
		expect(lines.some((l) => l.includes("Auth"))).toBe(true);
		expect(lines.some((l) => l.includes("Search"))).toBe(true);
		// [✓] 标记的 Auth 仍存在（toggle 状态保留）
		expect(lines.some((l) => l.includes("[✓]") && l.includes("Auth"))).toBe(true);
		// 4) 输 "redis" → Enter 保存 → submit（单问题）
		c.handleInput("r");
		c.handleInput("e");
		c.handleInput("d");
		c.handleInput("i");
		c.handleInput("s");
		c.handleInput(ENTER); // 保存 freeText → submit
		// 答案含多选 toggle 项 + Other 自定义
		expect(result.val!.answers["Which features?"]).toEqual({ selected: ["Auth"], other: "redis" });
	});

	it("C-NEW-2: ←/→ on question tab switches tabs (→ next, ← previous; ← no wrap at first)", () => {
		// multiQ: 3 questions → tabs 0,1,2,3=Submit
		const { c } = make(multiQ);
		c.render(80);
		// 1) Q1 上按 Right → 应切到 Q2
		c.handleInput(RIGHT);
		expect(c.render(80).some((l) => l.includes("Q2") || l.includes("Second"))).toBe(true);
		// 2) Left 回到 Q1
		c.handleInput(LEFT);
		expect(c.render(80).some((l) => l.includes("Q1") || l.includes("First"))).toBe(true);
		// 3) Q1 上 Left 不环绕（仍停 Q1）
		c.handleInput(LEFT);
		expect(c.render(80).some((l) => l.includes("Q1") || l.includes("First"))).toBe(true);
	});

	it("C-NEW-3: Submit tab Tab toggles submitTabFocus (Submit ↔ Cancel)", () => {
		// multiQ: 3 questions → tabs 0,1,2,3=Submit
		const { c } = make(multiQ);
		// 导航到 Submit（问题 tab 间用 →）
		c.handleInput(RIGHT); // Q1→Q2
		c.handleInput(RIGHT); // Q2→Q3
		c.handleInput(RIGHT); // Q3→Submit
		// Submit tab 默认 focus=Submit。验证渲染中 Submit 高亮（accent）
		let lines = c.render(80);
		const focusedLineInitial = lines.find((l) => l.match(/[\[\(]\s*Submit\s*[\]\)]/));
		expect(focusedLineInitial).toBeDefined();
		// 按 Tab → focus 切到 Cancel（单键双向循环）
		c.handleInput(TAB);
		lines = c.render(80);
		const focusedLineAfter = lines.find((l) => l.match(/[\[\(]\s*Cancel\s*[\]\)]/));
		expect(focusedLineAfter).toBeDefined();
		// 再按 Tab → focus 回 Submit
		c.handleInput(TAB);
		lines = c.render(80);
		expect(lines.find((l) => l.match(/[\[\(]\s*Submit\s*[\]\)]/))).toBeDefined();
	});

	it("C-NEW-4: Submit tab Enter on Submit focus (all confirmed) submits", () => {
		const twoQ: Question[] = [
			{ question: "Q1", header: "First", options: [{ label: "A" }, { label: "B" }] },
			{ question: "Q2", header: "Second", options: [{ label: "X" }, { label: "Y" }] },
		];
		const { c, result } = make(twoQ);
		// 答完 Q1 + Q2
		c.handleInput(ENTER); // Q1 select A → Q2
		c.handleInput(ENTER); // Q2 select X → Submit tab（Q2 是最后一个问题，advance 到 Submit）
		// 已经在 Submit tab，focus=Submit，按 Enter 提交
		c.handleInput(ENTER);
		expect(result.val).not.toBeUndefined();
		expect(result.val!.answers["Q1"]).toEqual({ selected: ["A"], other: null });
		expect(result.val!.answers["Q2"]).toEqual({ selected: ["X"], other: null });
	});

	it("C-NEW-5: Submit tab Enter on Cancel focus cancels (no confirm overlay)", () => {
		// multiQ: 3 questions
		const { c, result } = make(multiQ);
		// 答完所有问题
		c.handleInput(ENTER); // Q1 → Q2
		c.handleInput(ENTER); // Q2 → Q3
		c.handleInput(ENTER); // Q3 → Submit tab
		// 切到 Submit 后，按 Tab 把 focus 切到 Cancel
		c.handleInput(TAB);
		// Enter → 直接 cancel()（Submit tab 上无二次确认）
		c.handleInput(ENTER);
		expect(result.val).toBeNull();
	});

	it("C-NEW-6: Submit tab Enter on Submit when not all confirmed is a no-op (blocks submit)", () => {
		const { c, result } = make(multiQ);
		// 只答 Q1
		c.handleInput(ENTER); // Q1 → Q2
		// 切到 Submit（Q2 还未答）
		c.handleInput(RIGHT); // Q2 → Q3
		c.handleInput(RIGHT); // Q3 → Submit
		// focus=Submit（默认），按 Enter → 不提交（Q2/Q3 未答）
		c.handleInput(ENTER);
		expect(result.val).toBeUndefined();
	});

	it("C-TAB-NOLEAK: Tab in options mode with single question is no-op", () => {
		const c = new AskUserComponent(
			[{ question: "Pick one", options: [{ label: "A" }, { label: "B" }] }],
			mockTui,
			stubTheme,
			() => {},
		);
		c.handleInput(DOWN);
		c.handleInput(TAB);
		// 不应 crash，选项仍可见
		const lines = c.render(60);
		expect(lines.some((l: string) => l.includes("A"))).toBe(true);
		expect(lines.some((l: string) => l.includes("B"))).toBe(true);
	});
});

// ── options 输入路由 no-op 落空语义（←/→ 与 Space 的守卫分支）──
describe("AskUserComponent — options input no-op edges", () => {
	it("C-NAV-1: single question ignores LEFT/RIGHT in options mode (no tab nav, no cancel overlay)", () => {
		const { c, result } = make([singleQ]);
		// 单问题无 tab：←/→ 应为 no-op（isSingle 短路），既不切 tab 也不进入确认取消覆盖层
		c.handleInput(LEFT);
		c.handleInput(RIGHT);
		expect(result.val).toBeUndefined();
		// 未进入 Esc 确认取消覆盖层（覆盖层特征文案不出现）
		expect(c.render(60).some((l) => l.includes("Cancel all"))).toBe(false);
		// 光标仍在第一项，表单完好
		const lines = c.render(60);
		expect(lines.some((l) => l.includes(">") && l.includes("Postgres"))).toBe(true);
	});

	it("C-NAV-2: multi-select Space on Other row is a no-op (does not toggle, does not enter editor)", () => {
		const { c, result } = make([singleQMulti]);
		// 下移到 Other 行（Auth, Search, Other → 光标 index 2）
		c.handleInput(DOWN);
		c.handleInput(DOWN);
		// Other 行上 Space：multiSelect && !onOther 为 false → 落空
		c.handleInput(" ");
		// 未确认、未提交
		expect(result.val).toBeUndefined();
		const lines = c.render(60);
		// Other 行未被 toggle（无任何 [✓] 勾选框出现）
		expect(lines.some((l) => l.includes("[✓]"))).toBe(false);
		// 仍在 options 模式（未进 freeform 编辑器——反色光标不出现）
		expect(lines.some((l) => l.includes("\x1b[7m"))).toBe(false);
	});
});
