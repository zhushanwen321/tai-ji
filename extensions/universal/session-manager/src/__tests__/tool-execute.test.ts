// tool-execute.test.ts — U5-A2: each tool's execute calls ctx.ui.select with SESSION_MANAGER_MARKER + JSON payload

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SESSION_MANAGER_MARKER } from "@zhushanwen/extension-protocol";
import registerExtension from "../index.ts";

/** Capture registered tools and provide a mock ctx.ui.select. */
function createHarness() {
	const registered: Array<{ name: string; execute: Function }> = [];
	const selectMock = vi.fn().mockResolvedValue('{"ok":true}');
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

describe("U5-A2 tool-execute", () => {
	let harness: ReturnType<typeof createHarness>;

	beforeEach(() => {
		harness = createHarness();
	});

	it.each([
		["create_managed_session", "create", { cwd: "/tmp" }],
		["send_to_session", "send", { sessionId: "s1", prompt: "hello" }],
		["read_session_history", "history", { sessionId: "s1" }],
		["list_my_sessions", "list", {}],
		["get_session_status", "status", { sessionId: "s1" }],
		["abort_session", "abort", { sessionId: "s1" }],
	])('tool "%s" calls select with action="%s"', async (toolName, expectedAction, params) => {
		const tool = harness.registered.find((t) => t.name === toolName)!;
		harness.selectMock.mockClear();
		harness.selectMock.mockResolvedValue('{"ok":true}');

		await tool.execute("call-1", params, undefined, undefined, harness.ctx);

		expect(harness.selectMock).toHaveBeenCalledTimes(1);
		const [marker, options, opts] = harness.selectMock.mock.calls[0];
		// first arg = SESSION_MANAGER_MARKER
		expect(marker).toBe(SESSION_MANAGER_MARKER);
		// second arg = string array with JSON payload containing action
		expect(Array.isArray(options)).toBe(true);
		expect(options).toHaveLength(1);
		const payload = JSON.parse(options[0]);
		expect(payload.action).toBe(expectedAction);
		// third arg has timeout
		expect(opts).toHaveProperty("timeout");
	});

	it("create_managed_session includes cwd and label in payload.params", async () => {
		const tool = harness.registered.find((t) => t.name === "create_managed_session")!;
		harness.selectMock.mockResolvedValue('{"sessionId":"s1"}');
		await tool.execute("call-1", { cwd: "/work", label: "test" }, undefined, undefined, harness.ctx);
		const payload = JSON.parse(harness.selectMock.mock.calls[0][1][0]);
		expect(payload.params.cwd).toBe("/work");
		expect(payload.params.label).toBe("test");
	});

	it("send_to_session includes sessionId and prompt in payload.params", async () => {
		const tool = harness.registered.find((t) => t.name === "send_to_session")!;
		harness.selectMock.mockResolvedValue('{"queued":true}');
		await tool.execute("call-1", { sessionId: "s1", prompt: "hi" }, undefined, undefined, harness.ctx);
		const payload = JSON.parse(harness.selectMock.mock.calls[0][1][0]);
		expect(payload.params.sessionId).toBe("s1");
		expect(payload.params.prompt).toBe("hi");
	});

	it("read_session_history includes tailTurns in payload.params when provided", async () => {
		const tool = harness.registered.find((t) => t.name === "read_session_history")!;
		harness.selectMock.mockResolvedValue('{"messages":[]}');
		await tool.execute("call-1", { sessionId: "s1", tailTurns: 5 }, undefined, undefined, harness.ctx);
		const payload = JSON.parse(harness.selectMock.mock.calls[0][1][0]);
		expect(payload.params.tailTurns).toBe(5);
	});

	it("read_session_history omits tailTurns from payload.params when not provided", async () => {
		const tool = harness.registered.find((t) => t.name === "read_session_history")!;
		harness.selectMock.mockResolvedValue('{"messages":[]}');
		await tool.execute("call-1", { sessionId: "s1" }, undefined, undefined, harness.ctx);
		const payload = JSON.parse(harness.selectMock.mock.calls[0][1][0]);
		expect(payload.params.tailTurns).toBeUndefined();
	});

	it("select result is returned as text content", async () => {
		const tool = harness.registered.find((t) => t.name === "list_my_sessions")!;
		harness.selectMock.mockResolvedValue('{"sessions":[]}');
		const result = await tool.execute("call-1", {}, undefined, undefined, harness.ctx);
		expect(result.content).toHaveLength(1);
		expect(result.content[0].type).toBe("text");
		expect(result.content[0].text).toBe('{"sessions":[]}');
	});
});
