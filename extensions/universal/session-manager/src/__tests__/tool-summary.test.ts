// tool-summary.test.ts — details.summary 产出（八工具文案断言，走 execute 骨架）+
// renderSessionManagerResult 两态（折叠态一行摘要 / 展开态原始 content 文本）。

import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, it, expect, vi, beforeEach } from "vitest";
import registerExtension from "../index.ts";
import { renderSessionManagerResult } from "../render.ts";

/** Capture registered tools and provide a mock ctx.ui.select. */
function createHarness() {
	const registered: Array<{ name: string; execute: Function; renderResult?: Function }> = [];
	const selectMock = vi.fn().mockResolvedValue('{"ok":true}');
	const pi = {
		registerTool: (tool: { name: string; execute: Function; renderResult?: Function }) => registered.push(tool),
		on: vi.fn(),
		getAllTools: vi.fn(() => []),
		setActiveTools: vi.fn(),
	};
	const ctx = {
		mode: "rpc" as const,
		hasUI: true,
		ui: { select: selectMock },
	};
	registerExtension(pi as never);
	return { registered, selectMock, ctx };
}

// mock theme（fg 直通，便于断言纯文本；todo render.test.ts 同款）
const mockTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function renderedText(result: unknown, expanded: boolean): string {
	return renderSessionManagerResult(result, { expanded }, mockTheme).render(400).join("\n");
}

describe("execute 组装 details.summary（八工具文案）", () => {
	let harness: ReturnType<typeof createHarness>;

	beforeEach(() => {
		harness = createHarness();
	});

	async function summaryOf(toolName: string, params: Record<string, unknown>, reply: unknown): Promise<string> {
		harness.selectMock.mockResolvedValue(JSON.stringify(reply));
		const tool = harness.registered.find((t) => t.name === toolName)!;
		const result = (await tool.execute("call-1", params, undefined, undefined, harness.ctx)) as {
			details: { summary: string };
		};
		return result.details.summary;
	}

	it("create_managed_session：带 label → 引号 label；无 label → 回退 sessionId", async () => {
		expect(
			await summaryOf("create_managed_session", { cwd: "/work", label: "worker" }, { sessionId: "s1", status: "created" }),
		).toBe('Created session "worker"');
		expect(
			await summaryOf("create_managed_session", { cwd: "/work" }, { sessionId: "s1", status: "created" }),
		).toBe("Created session s1");
	});

	it("send_to_session：Sent message to <sessionId>", async () => {
		expect(await summaryOf("send_to_session", { sessionId: "s1", prompt: "hi" }, { queued: true, willNotify: true })).toBe(
			"Sent message to s1",
		);
	});

	it("read_session_history：messages 计数后缀", async () => {
		expect(
			await summaryOf("read_session_history", { sessionId: "s1" }, { messages: [{}, {}, {}], truncated: false }),
		).toBe("Read history of s1 · 3 entries");
	});

	it("list_my_sessions：sessions 计数", async () => {
		expect(await summaryOf("list_my_sessions", {}, { sessions: [{ id: "s1" }, { id: "s2" }] })).toBe(
			"Listed 2 managed sessions",
		);
	});

	it("get_session_status：<sessionId> · <status>", async () => {
		expect(await summaryOf("get_session_status", { sessionId: "s1" }, { status: "idle", undeliveredResults: 0 })).toBe(
			"s1 · idle",
		);
	});

	it("abort_session：Aborted <sessionId>", async () => {
		expect(await summaryOf("abort_session", { sessionId: "s1" }, { success: true })).toBe("Aborted s1");
	});
});

describe("toSummary 数据缺失分支（形状漂移退化为短文案，不抛错）", () => {
	let harness: ReturnType<typeof createHarness>;

	beforeEach(() => {
		harness = createHarness();
	});

	async function summaryOf(toolName: string, params: Record<string, unknown>, reply: unknown): Promise<string> {
		harness.selectMock.mockResolvedValue(JSON.stringify(reply));
		const tool = harness.registered.find((t) => t.name === toolName)!;
		const result = (await tool.execute("call-1", params, undefined, undefined, harness.ctx)) as {
			details: { summary: string };
		};
		return result.details.summary;
	}

	it("create_managed_session：label 与 sessionId 均缺 → 裸文案", async () => {
		expect(await summaryOf("create_managed_session", { cwd: "/work" }, {})).toBe("Created session");
	});

	it("read_session_history：messages 缺失/非数组 → 无计数后缀", async () => {
		expect(await summaryOf("read_session_history", { sessionId: "s1" }, { truncated: false })).toBe("Read history of s1");
	});

	it("list_my_sessions：sessions 非数组 → 无计数", async () => {
		expect(await summaryOf("list_my_sessions", {}, { sessions: "bad" })).toBe("Listed managed sessions");
	});

	it("get_session_status：status 缺失 → Status of <sessionId>", async () => {
		expect(await summaryOf("get_session_status", { sessionId: "s1" }, {})).toBe("Status of s1");
	});
});

describe("renderSessionManagerResult 两态", () => {
	it("折叠态（expanded=false）：渲染 details.summary 一行摘要，不含原始 JSON", () => {
		const result = {
			content: [{ type: "text", text: '{"messages":[{}]}' }],
			details: { summary: "Read history of s1 · 1 entries" },
		};
		const out = renderedText(result, false);
		expect(out).toContain("Read history of s1 · 1 entries");
		expect(out).not.toContain("messages");
	});

	it("展开态（expanded=true）：渲染 content[0] 原始文本，不含摘要", () => {
		const result = {
			content: [{ type: "text", text: '{"messages":[{}]}' }],
			details: { summary: "Read history of s1 · 1 entries" },
		};
		const out = renderedText(result, true);
		expect(out).toContain('{"messages":[{}]}');
		expect(out).not.toContain("Read history of s1");
	});

	it("折叠态但 details 缺失 / summary 非字符串 → 回退 content 文本", () => {
		expect(renderedText({ content: [{ type: "text", text: "raw" }] }, false)).toContain("raw");
		expect(renderedText({ content: [{ type: "text", text: "raw" }], details: { summary: 7 } }, false)).toContain("raw");
	});

	it("八工具注册的 renderResult 均存在且折叠态行为一致（共用渲染内核）", () => {
		const harness = createHarness();
		const renderFns = harness.registered.map((t) => t.renderResult);
		expect(renderFns).toHaveLength(8);
		for (const fn of renderFns) expect(typeof fn).toBe("function");
		// 抽查一个 handler：折叠态出摘要、不出原始 JSON（handler 是各 registerTool
		// 的方法包装，内核同为 renderSessionManagerResult）
		const out = (renderFns[0] as (r: unknown, o: { expanded: boolean }, t: unknown) => { render: (w: number) => string[] })(
			{ content: [{ type: "text", text: "raw" }], details: { summary: "Aborted s1" } },
			{ expanded: false },
			mockTheme,
		)
			.render(400)
			.join("\n");
		expect(out).toContain("Aborted s1");
		expect(out).not.toContain("raw");
	});
});
