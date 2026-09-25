// tool-error-handling.test.ts — U5-A4: null/undefined returns → cancelled throw; exceptions → propagate;
// {error} respond → throw（W4 throw 范式：pi agent-loop 仅在 execute throw 时置 isError:true——
// pi-agent-core dist/agent-loop.js:453-483 executePreparedToolCall 正常 return 硬编码 isError:false；
// 语义登记 PS-56）

import { describe, it, expect, vi, beforeEach } from "vitest";
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

describe("U5-A4 tool-error-handling", () => {
	it("select returning undefined (user cancel/timeout) → cancelled throw（W4 范式：错误路径 throw）", async () => {
		const { registered, ctx } = createHarness(vi.fn().mockResolvedValue(undefined));
		const tool = registered.find((t) => t.name === "create_managed_session")!;
		await expect(tool.execute("call-1", { cwd: "/tmp" }, undefined, undefined, ctx)).rejects.toThrow(
			/cancelled/,
		);
	});

	it("select returning null → cancelled throw", async () => {
		const { registered, ctx } = createHarness(vi.fn().mockResolvedValue(null));
		const tool = registered.find((t) => t.name === "send_to_session")!;
		await expect(
			tool.execute("call-1", { sessionId: "s1", prompt: "hi" }, undefined, undefined, ctx),
		).rejects.toThrow(/cancelled/);
	});

	it("select throwing exception → cancelled throw（select 通道异常同折叠）", async () => {
		const { registered, ctx } = createHarness(vi.fn().mockRejectedValue(new Error("channel closed")));
		const tool = registered.find((t) => t.name === "get_session_status")!;
		await expect(tool.execute("call-1", { sessionId: "s1" }, undefined, undefined, ctx)).rejects.toThrow(
			/cancelled/,
		);
	});

	it("select throwing non-Error → cancelled throw", async () => {
		const { registered, ctx } = createHarness(vi.fn().mockRejectedValue("string error"));
		const tool = registered.find((t) => t.name === "abort_session")!;
		await expect(tool.execute("call-1", { sessionId: "s1" }, undefined, undefined, ctx)).rejects.toThrow(
			/cancelled/,
		);
	});

	it("runtime respond 携带 {error} JSON → throw（禁止错误成功模式；pi 置 isError:true）", async () => {
		const { registered, ctx } = createHarness(
			vi.fn().mockResolvedValue(JSON.stringify({ error: "session unreachable", hint: "check get_session_status" })),
		);
		const tool = registered.find((t) => t.name === "send_to_session")!;
		await expect(
			tool.execute("call-1", { sessionId: "s1", prompt: "hi" }, undefined, undefined, ctx),
		).rejects.toThrow(/session unreachable[\s\S]*hint/);
	});

	it("runtime respond 正常 JSON → 成功返回（不含 isError 字段）", async () => {
		const { registered, ctx } = createHarness(
			vi.fn().mockResolvedValue(JSON.stringify({ queued: true })),
		);
		const tool = registered.find((t) => t.name === "send_to_session")!;
		const result = await tool.execute("call-1", { sessionId: "s1", prompt: "hi" }, undefined, undefined, ctx);
		expect(Object.hasOwn(result, "isError")).toBe(false);
		expect(JSON.parse(result.content[0].text)).toEqual({ queued: true });
	});

	it("all 6 tools handle null gracefully（cancelled throw）", async () => {
		const { registered, ctx } = createHarness(vi.fn().mockResolvedValue(null));
		for (const tool of registered) {
			const params = tool.name === "create_managed_session"
				? { cwd: "/tmp" }
				: tool.name === "send_to_session"
					? { sessionId: "s1", prompt: "hi" }
					: tool.name === "read_session_history"
						? { sessionId: "s1" }
						: tool.name === "list_my_sessions"
							? {}
							: { sessionId: "s1" };
			await expect(tool.execute("call-1", params, undefined, undefined, ctx)).rejects.toThrow(
				/cancelled/,
			);
		}
	});
});
