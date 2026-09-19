// src/__tests__/form-adapter.test.ts
//
// 包内归一 adapter（form-adapter.ts）的映射规则单测——设计 ui-presentation-protocol
// D2/D3：askUserInteract 退役后 AskUserQuestion↔FormQuestion 归一职责下沉本包。
// 键位规则对拍基准 = e2e/ask-user-real.spec.ts A1 协议面：无 allowComment、Other 保留
// （__other 键）、多选 JSON 序列化。
import { describe, expect, it } from "vitest";

import {
	askUserToFormQuestions,
	formToAskUserQuestions,
	formToInternalQuestions,
	internalToFormQuestions,
} from "../form-adapter";
import type { Question } from "../types";

// ── 样例 internal Question（tool 路径的源形态）──────────────
const internalSingle: Question = {
	question: "Which DB?",
	options: [
		{ label: "Postgres", description: "Mature" },
		{ label: "SQLite" },
	],
};
const internalMulti: Question = {
	question: "Which tools?",
	header: "Tools",
	context: "pick many",
	options: [{ label: "A" }, { label: "B" }],
	multiSelect: true,
};

describe("internalToFormQuestions（wire 形态构造）", () => {
	it("options 必填 → 恒 choice；multiSelect → multi 重命名；allowOther 固定 true", () => {
		const [q] = internalToFormQuestions([internalSingle]);
		expect(q).toEqual({
			type: "choice",
			question: "Which DB?",
			options: [
				{ label: "Postgres", description: "Mature" },
				{ label: "SQLite" },
			],
			allowOther: true,
		});
		const [m] = internalToFormQuestions([internalMulti]);
		expect(m.type).toBe("choice");
		expect(m.multi).toBe(true);
		expect(m.multiSelect).toBeUndefined();
		expect(m.header).toBe("Tools");
		expect(m.context).toBe("pick many");
	});

	it("wire 形态无 allowComment / 无 comment 类字段（A1 对拍基准）", () => {
		for (const q of internalToFormQuestions([internalSingle, internalMulti])) {
			for (const key of Object.keys(q)) {
				expect(key.includes("comment"), `字段 ${key} 不应含 comment`).toBe(false);
			}
		}
	});
});

describe("askUserToFormQuestions（D9 旧 payload 归一）", () => {
	it("有 options → choice（multiSelect → multi）", () => {
		const [q] = askUserToFormQuestions([
			{ question: "q", header: "h", multiSelect: true, options: [{ label: "A" }] },
		]);
		expect(q).toEqual({
			type: "choice",
			header: "h",
			question: "q",
			options: [{ label: "A" }],
			multi: true,
		});
	});

	it("无 options → text（协议值域完备保留）", () => {
		const [q] = askUserToFormQuestions([{ question: "free text q", header: "h" }]);
		expect(q).toEqual({ type: "text", header: "h", question: "free text q" });
	});
});

describe("formToAskUserQuestions（解码视图）", () => {
	it("choice：multi 还原为 multiSelect，保持解码 helper 契约", () => {
		const [q] = formToAskUserQuestions([
			{ type: "choice", question: "q", options: [{ label: "A" }], multi: true },
		]);
		expect(q).toEqual({ question: "q", options: [{ label: "A" }], multiSelect: true });
	});

	it("text：无 options 字段（答案经 __other 键解码）", () => {
		const [q] = formToAskUserQuestions([{ type: "text", question: "q" }]);
		expect(q).toEqual({ question: "q" });
	});

	it("schedule：跳过（ask-user 链路不产生）", () => {
		const out = formToAskUserQuestions([
			{ type: "schedule", question: "when?" },
			{ type: "text", question: "q" },
		]);
		expect(out).toEqual([{ question: "q" }]);
	});

	it("round trip：internal → Form → AskUser 与旧 toProtoQuestions 语义等价", () => {
		const form = internalToFormQuestions([internalSingle, internalMulti]);
		const decodeView = formToAskUserQuestions(form);
		expect(decodeView[0]).toEqual({
			question: "Which DB?",
			options: [
				{ label: "Postgres", description: "Mature" },
				{ label: "SQLite" },
			],
			allowOther: true,
		});
		expect(decodeView[1]).toEqual({
			question: "Which tools?",
			header: "Tools",
			context: "pick many",
			options: [{ label: "A" }, { label: "B" }],
			multiSelect: true,
			allowOther: true,
		});
	});
});

describe("formToInternalQuestions（TUI 组件形态）", () => {
	it("choice → options 原样 + multiSelect 还原", () => {
		const [q] = formToInternalQuestions([
			{
				type: "choice",
				question: "q",
				header: "h",
				options: [{ label: "A", description: "d" }],
				multi: true,
			},
		]);
		expect(q).toEqual({
			question: "q",
			header: "h",
			options: [{ label: "A", description: "d" }],
			multiSelect: true,
		});
	});

	it("text → 空 options（组件渲染为自由输入，与旧无 options payload 现状一致）", () => {
		const [q] = formToInternalQuestions([{ type: "text", question: "q" }]);
		expect(q).toEqual({ question: "q", options: [] });
	});

	it("schedule → 跳过", () => {
		const out = formToInternalQuestions([
			{ type: "schedule", question: "when?" },
			{ type: "text", question: "q" },
		]);
		expect(out).toEqual([{ question: "q", options: [] }]);
	});
});
