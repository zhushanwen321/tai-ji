// tool-error-handling.test.ts — U5-A4: null/undefined returns → cancelled result; exceptions → caught error result

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
	it("select returning undefined (user cancel/timeout) → cancelled result, no throw", async () => {
		const { registered, ctx } = createHarness(vi.fn().mockResolvedValue(undefined));
		const tool = registered.find((t) => t.name === "create_managed_session")!;
		const result = await tool.execute("call-1", { cwd: "/tmp" }, undefined, undefined, ctx);
		expect(result.content).toHaveLength(1);
		expect(result.content[0].text).toContain("cancelled");
	});

	it("select returning null → cancelled result, no throw", async () => {
		const { registered, ctx } = createHarness(vi.fn().mockResolvedValue(null));
		const tool = registered.find((t) => t.name === "send_to_session")!;
		const result = await tool.execute("call-1", { sessionId: "s1", prompt: "hi" }, undefined, undefined, ctx);
		expect(result.content).toHaveLength(1);
		expect(result.content[0].text).toContain("cancelled");
	});

	it("select throwing exception → caught, returns error result, no throw", async () => {
		const { registered, ctx } = createHarness(vi.fn().mockRejectedValue(new Error("channel closed")));
		const tool = registered.find((t) => t.name === "get_session_status")!;
		const result = await tool.execute("call-1", { sessionId: "s1" }, undefined, undefined, ctx);
		expect(result.content).toHaveLength(1);
		expect(result.content[0].text).toContain("cancelled");
	});

	it("select throwing non-Error → caught, returns error result, no throw", async () => {
		const { registered, ctx } = createHarness(vi.fn().mockRejectedValue("string error"));
		const tool = registered.find((t) => t.name === "abort_session")!;
		const result = await tool.execute("call-1", { sessionId: "s1" }, undefined, undefined, ctx);
		expect(result.content).toHaveLength(1);
		expect(result.content[0].text).toContain("cancelled");
	});

	it("runtime respond 携带 {error} JSON → isError: true（禁止错误成功模式）", async () => {
		const { registered, ctx } = createHarness(
			vi.fn().mockResolvedValue(JSON.stringify({ error: "session unreachable", hint: "check get_session_status" })),
		);
		const tool = registered.find((t) => t.name === "send_to_session")!;
		const result = await tool.execute("call-1", { sessionId: "s1", prompt: "hi" }, undefined, undefined, ctx);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("session unreachable");
		expect(result.content[0].text).toContain("hint");
	});

	it("runtime respond 正常 JSON → 无 isError", async () => {
		const { registered, ctx } = createHarness(
			vi.fn().mockResolvedValue(JSON.stringify({ queued: true })),
		);
		const tool = registered.find((t) => t.name === "send_to_session")!;
		const result = await tool.execute("call-1", { sessionId: "s1", prompt: "hi" }, undefined, undefined, ctx);
		expect(result.isError).toBeUndefined();
	});

	it("all 6 tools handle null gracefully", async () => {
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
			const result = await tool.execute("call-1", params, undefined, undefined, ctx);
			expect(result.content).toHaveLength(1);
			expect(result.content[0].text).toContain("cancelled");
		}
	});
});
