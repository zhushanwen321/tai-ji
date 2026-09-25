// tool-non-json-response.test.ts — 行为微变①（D8）：非 JSON 回包 → throw + 留痕
//
// [HISTORICAL] 改前行为（D8 前）：executeTool 对回包 try JSON.parse、catch 后
// parsed=undefined，非 JSON 字符串静默当成功文本返回（content[0].text = raw、无
// isError）——runtime 协议漂移对 agent 不可辨。D8
// （docs/architecture/ext-simplify-17-shared-extraction.md §3.3，有意微变）统一为
// 对齐 plugin-bridge 形态：logger.error 留痕（callMarkerRpc 原语经注入的 log 承担）
// + 错误路径 throw（W4 范式：pi agent-loop 仅在 execute throw 时置 isError:true——
// pi-agent-core dist/agent-loop.js:453-483，语义登记 PS-56）。

import { describe, it, expect, vi, beforeEach } from "vitest";

const loggerMock = vi.hoisted(() => ({
	error: vi.fn(),
	warn: vi.fn(),
	debug: vi.fn(),
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({
	getLogger: () => loggerMock,
	setPiHandle: vi.fn(),
}));

import registerExtension from "../index.ts";

function createHarness(selectImpl: (...args: unknown[]) => Promise<unknown>) {
	const registered: Array<{ name: string; execute: Function }> = [];
	const selectMock = vi.fn(selectImpl);
	const pi = {
		registerTool: (tool: { name: string; execute: Function }) => registered.push(tool),
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

describe("D8 行为微变①：非 JSON 回包 → throw + 留痕", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("非 JSON 回包 → throw 提示文本（不再静默当成功文本返回；pi 侧置 isError:true）", async () => {
		const { registered, ctx } = createHarness(vi.fn().mockResolvedValue("plain text response"));
		const tool = registered.find((t) => t.name === "send_to_session")!;
		await expect(
			tool.execute("call-1", { sessionId: "s1", prompt: "hi" }, undefined, undefined, ctx),
		).rejects.toThrow(/non-JSON/);
		// 改前对照：text 曾是 raw 本身（'plain text response'）静默当成功
	});

	it("留痕：logger.error 收到 non-JSON 消息 + responseHead（原语经注入 log 承担）", async () => {
		const { registered, ctx } = createHarness(vi.fn().mockResolvedValue("plain text response"));
		const tool = registered.find((t) => t.name === "list_my_sessions")!;
		await expect(tool.execute("call-2", {}, undefined, undefined, ctx)).rejects.toThrow(/non-JSON/);
		expect(loggerMock.error).toHaveBeenCalled();
		const [msg, detail] = loggerMock.error.mock.calls.at(-1)!;
		expect(msg).toContain("[session-manager]");
		expect(msg).toContain("non-JSON");
		expect(detail).toMatchObject({ responseHead: "plain text response" });
	});

	it("对照：合法 JSON 回包仍走成功路径（raw 透传、无 isError 字段、无留痕）", async () => {
		const { registered, ctx } = createHarness(vi.fn().mockResolvedValue('{"queued":true}'));
		const tool = registered.find((t) => t.name === "send_to_session")!;
		const result = await tool.execute("call-3", { sessionId: "s1", prompt: "hi" }, undefined, undefined, ctx);
		expect(Object.hasOwn(result, "isError")).toBe(false);
		expect(result.content[0].text).toBe('{"queued":true}');
		expect(loggerMock.error).not.toHaveBeenCalled();
	});
});
