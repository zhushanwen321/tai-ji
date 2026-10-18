// compact_context 收起态摘要测试：buildCompactContextSummary 文案 + execute 产出的
// details.summary + renderResult 折叠/展开形态。mock 形态沿用 tool.test.ts。

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

// mock 配置加载（不落盘，形态对齐 tool.test.ts）
vi.mock("../pure.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../pure.js")>();
	return {
		...actual,
		loadSmartContextConfig: vi.fn(),
	};
});

import { DEFAULT_SMART_CONTEXT_CONFIG, loadSmartContextConfig } from "../pure.js";
import { buildCompactContextSummary, registerCompactContextTool } from "../tool.js";
import { renderCompactContextResult } from "../render-result.js";

const mockedLoad = vi.mocked(loadSmartContextConfig);

beforeEach(() => {
	mockedLoad.mockReturnValue({ ...DEFAULT_SMART_CONTEXT_CONFIG });
});

interface RegisteredTool { // oe-exempt:20261017:test:测试 harness 契约——断言面引用其字段类型，非抽象接口
	name: string;
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal: undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
	renderResult: (result: unknown, options: { expanded: boolean }, theme: Theme) => { content: unknown };
}

function makePi() {
	const tools: RegisteredTool[] = [];
	const pi = {
		registerTool: (t: RegisteredTool) => tools.push(t),
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
	} as unknown as ExtensionAPI;
	return { pi, tools };
}

function makeCtx(): ExtensionContext {
	return {
		model: { provider: "zai", id: "glm" },
		getContextUsage: () => ({ tokens: 450_000, contextWindow: 1_000_000 }),
		sessionManager: { getEntries: () => [] },
		compact: () => {},
	} as unknown as ExtensionContext;
}

// ── buildCompactContextSummary ───────────────────────

describe("buildCompactContextSummary", () => {
	it("恒为 Context compacted（R2 降级态：返回时压缩未完成，无比例数据）", () => {
		expect(buildCompactContextSummary()).toBe("Context compacted");
	});
});

// ── execute 产出的 details.summary ───────────────────

describe("compact_context execute details.summary", () => {
	it("details 带现有字段 + summary", async () => {
		const { pi, tools } = makePi();
		registerCompactContextTool(pi);
		const res = await tools[0]!.execute("t1", {}, undefined, undefined, makeCtx());
		expect(res.details).toMatchObject({
			mode: "same-model",
			launched: true,
			fellBack: false,
			summary: "Context compacted",
		});
	});
});

// ── renderCompactContextResult（TUI renderResult）────

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

function renderedText(result: unknown, expanded: boolean): string {
	return renderCompactContextResult(result, { expanded }, mockTheme)
		.render(400)
		.map((line) => line.trimEnd())
		.join("\n");
}

describe("renderCompactContextResult", () => {
	const result = {
		content: [{ type: "text", text: "压缩已启动（same-model 模式）..." }],
		details: { mode: "same-model", launched: true, summary: "Context compacted" },
	};

	it("折叠态 → details.summary 一行", () => {
		expect(renderedText(result, false)).toBe("Context compacted");
	});

	it("展开态 → content 纯文本", () => {
		expect(renderedText(result, true)).toContain("压缩已启动");
	});

	it("无 summary（旧 entry）→ 折叠态回退 content 首行", () => {
		const legacy = { content: [{ type: "text", text: "压缩已启动（same-model 模式）" }], details: {} };
		expect(renderedText(legacy, false)).toBe("压缩已启动（same-model 模式）");
	});
});
