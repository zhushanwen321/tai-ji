import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
	buildRenameSessionSummary,
	renderRenameSessionResult,
} from "../render";

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

/** Text 实例的渲染行（width 足够宽避免 wrap；每行被 pad 到宽度，断言用 trim 后全等） */
function renderedText(result: unknown, expanded = false): string {
	return renderRenameSessionResult(result, { expanded }, mockTheme)
		.render(400)
		.map((line) => line.trimEnd())
		.join("\n");
}

// ── buildRenameSessionSummary ───────────────────────

describe("buildRenameSessionSummary", () => {
	it("动作 + 清洗后标题，一行英文摘要", () => {
		expect(buildRenameSessionSummary({ title: "修复登录超时" })).toBe(
			'Renamed session to "修复登录超时"',
		);
		expect(buildRenameSessionSummary({ title: "refactor-config-loader" })).toBe(
			'Renamed session to "refactor-config-loader"',
		);
	});
});

// ── renderRenameSessionResult ───────────────────────

describe("renderRenameSessionResult", () => {
	const result = {
		content: [{ type: "text", text: "已命名：修复登录超时" }],
		details: { summary: 'Renamed session to "修复登录超时"' },
	};

	it("折叠态 → details.summary 一行摘要", () => {
		expect(renderedText(result, false)).toBe('Renamed session to "修复登录超时"');
	});

	it("展开态 → content 纯文本", () => {
		expect(renderedText(result, true)).toBe("已命名：修复登录超时");
	});

	it("无 details（旧版本持久化 entry）→ 折叠态回退 content 文本", () => {
		const legacy = { content: [{ type: "text", text: "已命名：legacy" }] };
		expect(renderedText(legacy, false)).toBe("已命名：legacy");
	});

	it("content 非 text 类型 → 折叠态兜底 Renamed", () => {
		const odd = { content: [{ type: "image" }], details: {} };
		expect(renderedText(odd, false)).toBe("Renamed");
	});

	it("result 非对象（防御）→ 兜底 Renamed 不抛错", () => {
		expect(renderedText(undefined, false)).toBe("Renamed");
	});
});
