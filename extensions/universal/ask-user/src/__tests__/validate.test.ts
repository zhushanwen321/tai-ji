// src/__tests__/validate.test.ts
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";

import { HEADER_MAX_CHARS, InputSchema, type Question } from "../types";
import { validateInput } from "../validate";

const q = (overrides: Partial<Question> = {}): Question => ({
	question: "Q1",
	options: [{ label: "A" }, { label: "B" }],
	...overrides,
});

describe("validateInput", () => {
	it("returns null for valid single question", () => {
		expect(validateInput([q()])).toBeNull();
	});

	it("returns null for valid multiple questions with headers", () => {
		expect(
			validateInput([
				q({ question: "Q1", header: "First" }),
				q({ question: "Q2", header: "Second" }),
			]),
		).toBeNull();
	});

	it("returns null for single question without header", () => {
		expect(validateInput([q()])).toBeNull();
	});

	it("detects duplicate question text", () => {
		const result = validateInput([
			q({ question: "Same", header: "A" }),
			q({ question: "Same", header: "B" }),
		]);
		expect(result).toContain("Duplicate question");
		expect(result).toContain("Same");
	});

	it("detects duplicate option labels within a question", () => {
		const result = validateInput([
			q({ options: [{ label: "A" }, { label: "A" }] }),
		]);
		expect(result).toContain("Duplicate option label");
		expect(result).toContain("A");
	});

	it("detects missing header in multi-question", () => {
		const result = validateInput([
			q({ question: "Q1", header: "First" }),
			q({ question: "Q2" }), // no header
		]);
		expect(result).toContain("header");
		expect(result).toContain("Q2");
	});

	it("allows whitespace-only header on single question (header unused)", () => {
		const result = validateInput([
			q({ question: "Q1", header: "  " }),
		]);
		expect(result).toBeNull();
	});

	it("detects empty-string header in multi-question", () => {
		const result = validateInput([
			q({ question: "Q1", header: "First" }),
			q({ question: "Q2", header: "  " }),
		]);
		expect(result).toContain("header");
	});

	// V-9: 4 个问题上限
	it("accepts 4 questions (maxItems boundary)", () => {
		const result = validateInput([
			q({ question: "Q1", header: "H1" }),
			q({ question: "Q2", header: "H2" }),
			q({ question: "Q3", header: "H3" }),
			q({ question: "Q4", header: "H4" }),
		]);
		expect(result).toBeNull();
	});

	// V-10/S3: 多 question 时 header 必须唯一——重复 header 会导致 askUserKey 碰撞
	// （协议 helper 用 header 作 answers 读取 key，后一个覆盖前一个的 Other）
	it("rejects duplicate headers across different questions", () => {
		const result = validateInput([
			q({ question: "Q1", header: "Same" }),
			q({ question: "Q2", header: "Same" }),
		]);
		expect(result).not.toBeNull();
		expect(result).toContain("Duplicate header");
	});

	// V-11: option description 不参与唯一性校验
	it("allows duplicate descriptions across options", () => {
		const result = validateInput([
			q({
				options: [
					{ label: "A", description: "same desc" },
					{ label: "B", description: "same desc" },
				],
			}),
		]);
		expect(result).toBeNull();
	});

	// V-12: question 文本超过 QUESTION_MAX_CHARS(1000) 上限
	it("rejects question text exceeding QUESTION_MAX_CHARS (1000)", () => {
		const result = validateInput([q({ question: "x".repeat(1001) })]);
		expect(result).not.toBeNull();
		expect(result).toContain("1000");
	});

	// V-13: question 文本恰好 1000 字符（边界值，合法）
	it("accepts question text at exactly QUESTION_MAX_CHARS (1000)", () => {
		expect(validateInput([q({ question: "x".repeat(1000) })])).toBeNull();
	});

	// V-14: question 文本含控制字符（\n \t \r \x00）被拒绝
	it("rejects question text containing control characters", () => {
		for (const text of ["line1\nline2", "a\tb", "a\rb", "a\x00b"]) {
			const result = validateInput([q({ question: text })]);
			expect(result).toContain("control characters");
		}
	});

	// V-15: header 超过 HEADER_MAX_CHARS(12) 上限被拒绝（A3：补 validate 层校验）
	it("rejects header exceeding HEADER_MAX_CHARS (12)", () => {
		const result = validateInput([q({ header: "This header is too long" })]);
		expect(result).not.toBeNull();
		expect(result).toContain("Header exceeds");
		expect(result).toContain(`${HEADER_MAX_CHARS}`);
	});

	// V-16: header 恰好 12 字符（边界值，合法）
	it("accepts header at exactly HEADER_MAX_CHARS (12)", () => {
		expect(validateInput([q({ header: "123456789012" })])).toBeNull();
	});

	// V-17: options 元素是 string（弱模型最高频误用 "options":["A","B"]）→ 友好错误带 Correct 正例。
	// schema 层已放宽让 string options 能进到这里（见 types.ts InputSchema），故可直接传 string[]。
	it("rejects string option elements with a Correct example (weak-model misuse)", () => {
		const result = validateInput([
			{ question: "Which DB?", options: ["Postgres", "SQLite"] },
		]);
		expect(result).not.toBeNull();
		expect(result).toContain("objects, not strings");
		expect(result).toContain('Correct: "options":[{"label"');
	});

	// V-18: 混合 [string, object] → 仍友好拦截第一个 string 元素
	it("rejects mixed string/object options", () => {
		const result = validateInput([
			{ question: "Q", options: ["A", { label: "B" }] },
		]);
		expect(result).toContain("objects, not strings");
	});

	// V-19: header 缺失错误带 Correct 正例（A. runtime 友好纠错）
	it("header-missing error includes a Correct example", () => {
		const result = validateInput([
			q({ question: "Q1", header: "H1" }),
			q({ question: "Q2" }), // no header
		]);
		expect(result).toContain("Correct:");
		expect(result).toContain('"header"');
	});

	// V-20/M23: label 恰为保留字 "Other" → 拦截。Other 自由输入行由 extension 自动追加，
	// LLM 自带会渲染出同名双行；文案含 reserved 与改名指引（rename + e.g. 示例）。
	it("rejects option label 'Other' as reserved with rename guidance", () => {
		const result = validateInput([
			q({ options: [{ label: "Postgres" }, { label: "Other" }] }),
		]);
		expect(result).not.toBeNull();
		expect(result).toContain("reserved");
		expect(result).toContain("rename");
	});

	// V-21/D2: 空白变体 " Other " 与合成 Other 行视觉不可分辨（仅差不可见空白），同样拦截
	it("rejects whitespace variants of the reserved label (' Other ')", () => {
		const result = validateInput([
			q({ options: [{ label: "Postgres" }, { label: " Other " }] }),
		]);
		expect(result).toContain("reserved");
	});

	// V-22/D2: 含 Other 子串的合法标签不被拦截（精确匹配不误杀）——catch-all 语义可经命名传达
	it("allows labels containing 'Other' as a substring (e.g. 'Other database')", () => {
		const result = validateInput([
			q({ options: [{ label: "Postgres" }, { label: "Other database" }] }),
		]);
		expect(result).toBeNull();
	});
});

// ── options 字符串「下沉」机制集成证明 ──────────────────
// 目标（任务核心）：弱模型误用 "options":["A","B"] 不能被 schema 层干报错拦死，
// 必须能进 validateInput 拿到带 Correct 正例的友好文案。Value.Check 是 Pi 运行时
// TypeCompiler.Check 的等价校验（同一引擎），这里直接断言 schema 行为。
// 原 3 用例缩减为 2（TC-03）："string options then caught by validateInput..." 与
// V-17 逐字重复（同 options:["Postgres","SQLite"]、同 3 断言），已删除；
// 保留的 2 用例是分层增量——V-17 只测 validateInput 层，此 describe 测 schema→validate 链路。
describe("schema-vs-validate integration (options 字符串下沉)", () => {
	it("string options PASS the schema layer (reach execute, not raw ajv error)", () => {
		const malformed = {
			questions: [{ question: "Which DB?", options: ["Postgres", "SQLite"] }],
		};
		expect(Value.Check(InputSchema, malformed)).toBe(true);
	});

	it("well-formed object options still pass schema AND validateInput", () => {
		const wellFormed = {
			questions: [
				{ question: "Which DB?", options: [{ label: "A" }, { label: "B" }] },
			],
		};
		expect(Value.Check(InputSchema, wellFormed)).toBe(true);
		expect(
			validateInput([{ question: "Which DB?", options: [{ label: "A" }, { label: "B" }] }]),
		).toBeNull();
	});
});
