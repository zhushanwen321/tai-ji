// structured-output renderResult 测试：两种注册变体（workflow / daily）成功轮折叠态均为
// 固定一行摘要、错误轮（context.isError）为 content 首行、展开态为 content 纯文本；
// details（数据本体）不被摘要污染。

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

function renderedText(
	renderResult: (r: unknown, o: { expanded: boolean }, t: Theme, c?: { isError?: boolean }) => unknown,
	result: unknown,
	expanded: boolean,
	context?: { isError?: boolean },
): string {
	const node = renderResult(result, { expanded }, mockTheme, context) as { render: (width: number) => string[] };
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

	it("错误轮（context.isError）→ 折叠态显示 content 首行，不显示 schema validated", () => {
		const failed = {
			content: [{
				type: "text",
				text: "Validation error: /score must be number\n\nReceived: {\"score\":\"high\"}",
			}],
			details: {},
		};
		const rendered = renderedText(renderStructuredOutputResult, failed, false, { isError: true });
		expect(rendered).toBe("Validation error: /score must be number");
		expect(rendered).not.toContain("schema validated");
	});

	it("context.isError === false（成功轮）→ 仍为固定一行摘要", () => {
		expect(renderedText(renderStructuredOutputResult, result, false, { isError: false })).toBe(
			STRUCTURED_OUTPUT_SUMMARY,
		);
	});
});

// ── 两种注册变体均挂 renderResult ────────────────────

describe("tool definition renderResult wiring", () => {
	it("workflow 变体挂 renderResult 且折叠态输出固定摘要", () => {
		const def = createWorkflowToolDefinition(
			JSON.stringify({ type: "object", properties: { score: { type: "number" } }, required: ["score"] }),
		) as {
			renderResult?: (r: unknown, o: { expanded: boolean }, t: Theme, c?: { isError?: boolean }) => unknown;
		};
		expect(typeof def.renderResult).toBe("function");
		expect(
			renderedText(def.renderResult!, { content: [{ type: "text", text: "ok" }], details: { score: 1 } }, false),
		).toBe("Final result reported (schema validated)");
	});

	it("daily 变体挂 renderResult 且折叠态输出固定摘要", () => {
		const def = createDailyToolDefinition() as {
			renderResult?: (r: unknown, o: { expanded: boolean }, t: Theme, c?: { isError?: boolean }) => unknown;
		};
		expect(typeof def.renderResult).toBe("function");
		expect(
			renderedText(def.renderResult!, { content: [{ type: "text", text: "ok" }], details: { score: 1 } }, false),
		).toBe("Final result reported (schema validated)");
	});

	it("两变体均把第 4 参 context 透传给 render-result（错误轮 → content 首行）", () => {
		const failed = {
			content: [{ type: "text", text: "Schema validation failed: /age must be number\nmore detail" }],
			details: {},
		};
		const variants = [
			createWorkflowToolDefinition(
				JSON.stringify({ type: "object", properties: { age: { type: "number" } }, required: ["age"] }),
			),
			createDailyToolDefinition(),
		] as Array<{
			renderResult: (r: unknown, o: { expanded: boolean }, t: Theme, c?: { isError?: boolean }) => unknown;
		}>;
		for (const def of variants) {
			expect(renderedText(def.renderResult, failed, false, { isError: true })).toBe(
				"Schema validation failed: /age must be number",
			);
		}
	});
});
