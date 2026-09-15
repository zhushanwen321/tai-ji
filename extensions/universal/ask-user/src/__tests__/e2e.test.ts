// src/__tests__/e2e.test.ts
// E2E test cases for ask_user. Drives tool.execute() → real AskUserComponent
// → simulated keypresses → asserts on final execute() result contract.
// （原始 spec 文件已不在仓内——用例自包含，编号 E2E-x 沿用原始 spec 命名）

import { describe, expect, it } from "vitest";

import { makeE2E } from "./e2e-harness";

// ── E2E-1: 单问题无评论 — 选第二项提交 ─────────────────
describe("E2E-1: single question — pick 2nd option", () => {
	const questions = [
		{
			question: "Which DB?",
			options: [{ label: "Postgres" }, { label: "SQLite" }],
		},
	];

	it("selects SQLite on ↓ + Enter and returns answers", async () => {
		const e = makeE2E(questions);
		e.keys(["\x1b[B", "\r"]); // ↓ + Enter
		const result = await e.getExecuted();
		const details = result.details;

		// User-facing summary
		expect(result.content[0].text).toContain("Which DB?");
		expect(result.content[0].text).toContain("SQLite");
		// Data contract
		expect(details.cancelled).toBe(false);
		expect(details.answers["Which DB?"]).toEqual({ selected: ["SQLite"], other: null });
		expect(details.questions.length).toBe(1);
	});
});

// ── E2E-4: 多问题提交 — 逐题选择后 Submit tab 提交（S-11）──────
describe("E2E-4: multi-question submit — answer each then Submit tab", () => {
	const questions = [
		{ question: "Q1", header: "First", options: [{ label: "A" }, { label: "B" }] },
		{ question: "Q2", header: "Second", options: [{ label: "X" }, { label: "Y" }] },
	];

	it("answers both via Enter + Enter on Submit tab", async () => {
		const e = makeE2E(questions);
		// Q1: Enter 选 A（auto-confirm → advance 到 Q2）
		// Q2: Enter 选 X（auto-confirm → advance 到 Submit tab）
		// Submit: Enter（allConfirmed）→ 提交
		e.keys(["\r", "\r", "\r"]);
		const result = await e.getExecuted();
		const details = result.details;

		expect(details.cancelled).toBe(false);
		expect(details.answers["Q1"]).toEqual({ selected: ["A"], other: null });
		expect(details.answers["Q2"]).toEqual({ selected: ["X"], other: null });
		expect(result.content[0].text).toContain("Q1");
		expect(result.content[0].text).toContain("Q2");
	});
});

// ── E2E-5: 多选 — Space 勾选多项后 Enter 提交（S-11）──────────
describe("E2E-5: multi-select — Space toggle two options then Enter", () => {
	const questions = [
		{
			question: "Which features?",
			multiSelect: true,
			options: [{ label: "Auth" }, { label: "Search" }],
		},
	];

	it("toggles Auth + Search via Space and submits on Enter", async () => {
		const e = makeE2E(questions);
		// Space 选 Auth（cursor@0）→ ↓ → Space 选 Search（cursor@1）→ Enter 确认（单问题→submit）
		e.keys([" ", "\x1b[B", " ", "\r"]);
		const result = await e.getExecuted();
		const details = result.details;

		expect(details.cancelled).toBe(false);
		expect(details.answers["Which features?"]).toEqual({ selected: ["Auth", "Search"], other: null });
	});
});

// ── E2E-6: Other 自由文本 — 输入自定义答案（S-11）─────────────
describe("E2E-6: Other free-text — type custom answer", () => {
	const questions = [
		{ question: "Which DB?", options: [{ label: "Postgres" }, { label: "SQLite" }] },
	];

	it("navigates to Other, types a custom answer, submits", async () => {
		const e = makeE2E(questions);
		// ↓↓ 到 Other（cursor@2，2 个普通选项 + Other）→ Enter 开 freeform 编辑器
		// → 输 "redis" → Enter 保存（afterConfirm → advance → submit）
		e.keys(["\x1b[B", "\x1b[B", "\r", "r", "e", "d", "i", "s", "\r"]);
		const result = await e.getExecuted();
		const details = result.details;

		expect(details.cancelled).toBe(false);
		expect(details.answers["Which DB?"]).toEqual({ selected: [], other: "redis" });
	});
});

// ── E2E-7: 取消 — Esc 进入确认层 → Esc 确认取消（S-11）────────
describe("E2E-7: cancel — Esc confirm overlay → Esc cancels", () => {
	const questions = [
		{ question: "Which DB?", options: [{ label: "Postgres" }, { label: "SQLite" }] },
	];

	it("single Esc raises confirm overlay, second Esc confirms cancel", async () => {
		const e = makeE2E(questions);
		// 单问题首个 tab：Esc → pendingCancel 覆盖层；再 Esc → cancel() → done(null)
		e.keys(["\x1b", "\x1b"]);
		const result = await e.getExecuted();
		const details = result.details;

		expect(details.cancelled).toBe(true);
		expect(result.content[0].text).toContain("cancelled");
		// 取消时 answers 为空对象
		expect(Object.keys(details.answers)).toHaveLength(0);
	});
});

// ── E2E-8: cancel 在多问题场景 — 首个问题 Esc→Esc 取消（S-11 cancel 多问题路径）─
describe("E2E-8: cancel during multi-question — Esc overlay then confirm", () => {
	const questions = [
		{ question: "Q1", header: "First", options: [{ label: "A" }, { label: "B" }] },
		{ question: "Q2", header: "Second", options: [{ label: "X" }, { label: "Y" }] },
	];

	it("Esc on first question raises overlay, second Esc cancels all", async () => {
		const e = makeE2E(questions);
		e.keys(["\x1b", "\x1b"]);
		const result = await e.getExecuted();
		const details = result.details;

		expect(details.cancelled).toBe(true);
		// 取消返回 details.answers = {}，details.questions 仍回传（renderResult 数据源）
		expect(Object.keys(details.answers)).toHaveLength(0);
	});
});
