// structured-output renderResult 测试：两种注册变体（workflow / daily）折叠态均为固定
// 一行摘要、展开态为 content 纯文本；details（数据本体）不被摘要污染。

import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { STRUCTURED_OUTPUT_SUMMARY, renderStructuredOutputResult } from "../render-result.js";
import { createDailyToolDefinition, createWorkflowToolDefinition } from "../tool-definition.js";

const mockTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	inverse: (text: string) => text,
	strikethrough: (text: string) => text,
	getFgAnsi: (_color: string) => "",
	getBgAnsi: (_color: string) => "",
	getColorMode: () => "truecolor" as const,
	getThinkingBorderColor: () => (text: string) => text,
	getBashModeBorderColor: () => (text: string) => text,
} as unknown as Theme;

function renderedText(renderResult: (r: unknown, o: { expanded: boolean }, t: Theme) => unknown, result: unknown, expanded: boolean): string {
	const node = renderResult(result, { expanded }, mockTheme) as { render: (width: number) => string[] };
	return node
		.render(400)
		.map((line) => line.trimEnd())
		.join("\n");
}

// ── renderStructuredOutputResult ─────────────────────

describe("renderStructuredOutputResult", () => {
	const result = {
		content: [{ type: "text", text: "Structured output recorded successfully." }],
		details: { score: 42 },
	};

	it("折叠态 → 固定一行摘要（Final result reported）", () => {
		expect(renderedText(renderStructuredOutputResult, result, false)).toBe(
			"Final result reported (schema validated)",
		);
	});

	it("展开态 → content 纯文本", () => {
		expect(renderedText(renderStructuredOutputResult, result, true)).toBe(
			"Structured output recorded successfully.",
		);
	});

	it("primitive details（数据本体形态）不参与渲染文案", () => {
		const primitive = {
			content: [{ type: "text", text: "Structured output recorded successfully." }],
			details: 42,
		};
		expect(renderedText(renderStructuredOutputResult, primitive, false)).toBe(
			STRUCTURED_OUTPUT_SUMMARY,
		);
	});
});

// ── 两种注册变体均挂 renderResult ────────────────────

describe("tool definition renderResult wiring", () => {
	it("workflow 变体挂 renderResult 且折叠态输出固定摘要", () => {
		const def = createWorkflowToolDefinition(
			JSON.stringify({ type: "object", properties: { score: { type: "number" } }, required: ["score"] }),
		) as { renderResult?: (r: unknown, o: { expanded: boolean }, t: Theme) => unknown };
		expect(typeof def.renderResult).toBe("function");
		expect(
			renderedText(def.renderResult!, { content: [{ type: "text", text: "ok" }], details: { score: 1 } }, false),
		).toBe("Final result reported (schema validated)");
	});

	it("daily 变体挂 renderResult 且折叠态输出固定摘要", () => {
		const def = createDailyToolDefinition() as {
			renderResult?: (r: unknown, o: { expanded: boolean }, t: Theme) => unknown;
		};
		expect(typeof def.renderResult).toBe("function");
		expect(
			renderedText(def.renderResult!, { content: [{ type: "text", text: "ok" }], details: { score: 1 } }, false),
		).toBe("Final result reported (schema validated)");
	});
});
