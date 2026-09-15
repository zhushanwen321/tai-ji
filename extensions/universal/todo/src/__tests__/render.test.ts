import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import type { Todo, TodoDetails } from "../model";
import { renderDualColumn, renderTodoResult } from "../render";

// ── mock theme（fg 直通，便于断言纯文本）────────────

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

// ── fixture ─────────────────────────────────────────

const todos: Todo[] = [
	{ id: 1, text: "Write docs", status: "completed" },
	{ id: 2, text: "Ship it", status: "in_progress" },
];

const listDetails: TodoDetails = { action: "list", todos, nextId: 3 };

/** Text 实例的渲染行（width 足够宽避免 wrap；每行被 pad，断言用 toContain） */
function renderedText(result: unknown, expanded = false): string {
	return renderTodoResult(result, { expanded }, mockTheme).render(400).join("\n");
}

// ── renderTodoResult ────────────────────────────────

describe("renderTodoResult", () => {
	it("无 details → 渲染 content[0] 的 text", () => {
		const result = { content: [{ type: "text", text: "Unknown payload" }] };
		expect(renderedText(result)).toContain("Unknown payload");
	});

	it("无 details 且 content[0] 非 text 类型 → 空文本（渲染为空）", () => {
		const result = { content: [{ type: "image", text: "ignored" }] };
		expect(renderTodoResult(result, { expanded: false }, mockTheme).render(400)).toEqual([]);
	});

	it("无 details 且 content[0].text 缺失 → 空文本", () => {
		const result = { content: [{ type: "text" }] };
		expect(renderTodoResult(result, { expanded: false }, mockTheme).render(400)).toEqual([]);
	});

	it("action=list → 渲染全量列表（标题 + 每条 mark/#id/文本）", () => {
		const result = { content: [{ type: "text", text: "ignored" }], details: listDetails };
		const out = renderedText(result);
		expect(out).toContain("2 todos:");
		expect(out).toContain("✓ #1 Write docs");
		expect(out).toContain("● #2 Ship it");
	});

	it.each(["add", "update", "delete"] as const)(
		"action=%s → 确认消息 + 空行 + 全量列表",
		(action) => {
			const result = {
				content: [{ type: "text", text: "Done thing" }],
				details: { action, todos, nextId: 3 },
			};
			const out = renderedText(result);
			expect(out).toContain("✓ Done thing");
			expect(out).toContain("2 todos:");
			expect(out).toContain("#1 Write docs");
		},
	);

	it("action=delete 时 details 有 text 缺失 → 确认段为空串，列表仍在", () => {
		const result = {
			content: [{ type: "text" }],
			details: { action: "delete", todos, nextId: 3 },
		};
		const out = renderedText(result);
		expect(out).toContain("2 todos:");
	});

	it("未知 action + 有消息 → dim 渲染消息原文", () => {
		const result = {
			content: [{ type: "text", text: "Archived" }],
			details: { action: "archive", todos: [], nextId: 1 } as unknown as TodoDetails,
		};
		expect(renderedText(result)).toContain("Archived");
	});

	it("未知 action + 无消息 → 兜底 Done", () => {
		const result = {
			content: [{ type: "text" }],
			details: { action: "archive", todos: [], nextId: 1 } as unknown as TodoDetails,
		};
		expect(renderedText(result)).toContain("Done");
	});
});

// ── renderDualColumn 列宽行为锁定 ──────────────────────
// 锁定 D14 替换前的列宽补齐/截断可见输出（ext-simplify 裁决零行为变化）：
// 截断形态是「前缀 + 6 个点」（内层省略号 + 外层省略号的旧组合）——这是锁定旧行为，不是认可该形态。

describe("renderDualColumn column fitting", () => {
	const longTodos: Todo[] = [
		{ id: 1, text: "x".repeat(30), status: "pending" },
		{ id: 2, text: "y".repeat(30), status: "pending" },
	];

	it("超宽列文本截断为 前缀+6点，两列均恰好列宽", () => {
		const termWidth = 27; // colWidth = floor((27 - 2 - 3) / 2) = 11
		const lines = renderDualColumn(longTodos, mockTheme, termWidth, "  ");
		expect(lines).toHaveLength(1);
		const row = stripTerminalSequences(lines[0]);
		expect(visibleWidth(row)).toBe(11 + 3 + 11);
		const divIdx = row.indexOf("│");
		// divider（" │ "）的前后空格不属于列内容，trim 后再断言
		const left = row.slice(0, divIdx).trimEnd();
		const right = row.slice(divIdx + 1).trimStart();
		// 两列均以 6 个点收尾（前缀+6点旧形态）
		expect(left.endsWith("......")).toBe(true);
		expect(right.endsWith("......")).toBe(true);
		// 点前的前缀可见宽恰为 colWidth - 6
		expect(visibleWidth(left.slice(0, left.length - 6))).toBe(11 - 6);
	});

	it("列内文本未超宽时不产生省略号，补齐到列宽", () => {
		const shortTodos: Todo[] = [
			{ id: 1, text: "ab", status: "pending" },
			{ id: 2, text: "cd", status: "pending" },
		];
		const lines = renderDualColumn(shortTodos, mockTheme, 27, "  ");
		const row = stripTerminalSequences(lines[0]);
		expect(visibleWidth(row)).toBe(11 + 3 + 11);
		expect(row).not.toContain(".");
		expect(row).toContain("#1 ab");
		expect(row).toContain("#2 cd");
	});

	it("colWidth <= 3 时超宽列退化为省略号截片", () => {
		const termWidth = 11; // colWidth = floor((11 - 2 - 3) / 2) = 3
		const lines = renderDualColumn(longTodos, mockTheme, termWidth, "  ");
		const row = stripTerminalSequences(lines[0]);
		expect(visibleWidth(row)).toBe(3 + 3 + 3);
		const divIdx = row.indexOf("│");
		expect(row.slice(0, divIdx).trimEnd()).toBe("...");
	});
});
