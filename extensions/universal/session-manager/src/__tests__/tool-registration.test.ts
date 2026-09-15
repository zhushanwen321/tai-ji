// tool-registration.test.ts — U5-A1: 6 tools registered with correct name/description/parameters + SESSION_MANAGER_MARKER import

import { describe, it, expect, vi } from "vitest";
import { SESSION_MANAGER_MARKER } from "@taiji/extension-protocol";
import registerExtension from "../index.ts";

/** Proxy-based mock: capture registerTool calls for assertion. */
function createMockPi() {
	const registered: Array<{ name: string; description: string; parameters: unknown }> = [];
	const pi = {
		registerTool: (tool: { name: string; description: string; parameters: unknown }) => {
			registered.push(tool);
		},
		on: vi.fn(),
		getAllTools: vi.fn(() => []),
		setActiveTools: vi.fn(),
	};
	return { pi, registered };
}

const EXPECTED_TOOL_NAMES = [
	"create_managed_session",
	"send_to_session",
	"read_session_history",
	"list_my_sessions",
	"get_session_status",
	"abort_session",
] as const;

describe("U5-A1 tool-registration", () => {
	it("registers exactly 6 tools", () => {
		const { pi, registered } = createMockPi();
		registerExtension(pi as never);
		expect(registered).toHaveLength(6);
	});

	it.each(EXPECTED_TOOL_NAMES)('registers tool "%s"', (name) => {
		const { pi, registered } = createMockPi();
		registerExtension(pi as never);
		const tool = registered.find((t) => t.name === name);
		expect(tool).toBeDefined();
		expect(tool!.name).toBe(name);
	});

	it("every tool has a non-empty description", () => {
		const { pi, registered } = createMockPi();
		registerExtension(pi as never);
		for (const tool of registered) {
			expect(typeof tool.description).toBe("string");
			expect(tool.description.length).toBeGreaterThan(0);
		}
	});

	it("every tool has a parameters schema (object type)", () => {
		const { pi, registered } = createMockPi();
		registerExtension(pi as never);
		for (const tool of registered) {
			expect(tool.parameters).toBeDefined();
			const schema = tool.parameters as Record<string, unknown>;
			expect(schema.type).toBe("object");
		}
	});

	it("SESSION_MANAGER_MARKER is imported from @taiji/extension-protocol", () => {
		expect(typeof SESSION_MANAGER_MARKER).toBe("string");
	});

	it("SESSION_MANAGER_MARKER value is '\\x00TAIJI_SESSION_MANAGER' (NUL prefix, 22 chars)", () => {
		expect(SESSION_MANAGER_MARKER).toBe("\x00TAIJI_SESSION_MANAGER");
		expect(SESSION_MANAGER_MARKER).toHaveLength(22);
	});
});
