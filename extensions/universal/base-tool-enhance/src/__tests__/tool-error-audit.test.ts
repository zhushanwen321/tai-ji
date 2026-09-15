// src/__tests__/tool-error-audit.test.ts
// 审计 hook 等价迁移守卫：customType 与 entry 形态必须与 unified-hooks
// tool-error-handler 逐字段一致（D11 落点，M1 验收点）。
import { describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { setupToolErrorAudit } from "../tool-error-audit.ts";

interface MockPi {
	on: ReturnType<typeof vi.fn>;
	appendEntry: ReturnType<typeof vi.fn>;
}

function createMockPi(): MockPi {
	return {
		on: vi.fn(),
		appendEntry: vi.fn(),
	};
}

function getRegisteredHandler(pi: MockPi): (event: unknown) => Promise<void> {
	const call = pi.on.mock.calls.find((c: unknown[]) => c[0] === "tool_execution_end");
	expect(call).toBeDefined();
	return call![1] as (event: unknown) => Promise<void>;
}

describe("setupToolErrorAudit", () => {
	it("registers a handler on the tool_execution_end event (pi has no tool_error event)", () => {
		const pi = createMockPi();
		setupToolErrorAudit(pi as unknown as ExtensionAPI);
		expect(pi.on).toHaveBeenCalledWith("tool_execution_end", expect.any(Function));
		expect(pi.on).toHaveBeenCalledTimes(1);
	});

	it("appends audit entry with the unified-hooks customType and exact field shape on isError:true", async () => {
		const pi = createMockPi();
		setupToolErrorAudit(pi as unknown as ExtensionAPI);
		const handler = getRegisteredHandler(pi);
		const before = Date.now();

		await handler({
			isError: true,
			toolName: "bash",
			toolCallId: "call-42",
			result: { content: [{ type: "text", text: "timeout:30" }] },
		});

		expect(pi.appendEntry).toHaveBeenCalledTimes(1);
		const [customType, entry] = pi.appendEntry.mock.calls[0] as [string, Record<string, unknown>];
		expect(customType).toBe("unified-hooks:tool-error");
		// 逐字段一致：timestamp（毫秒区间内）/ toolName / toolCallId / errorText 从 result.content 提取
		expect(typeof entry.timestamp).toBe("number");
		expect(entry.timestamp).toBeGreaterThanOrEqual(before);
		expect(entry.timestamp).toBeLessThanOrEqual(Date.now());
		expect(entry.toolName).toBe("bash");
		expect(entry.toolCallId).toBe("call-42");
		expect(entry.errorText).toBe("timeout:30");
	});

	it("falls back to null errorText when result carries no extractable text", async () => {
		const pi = createMockPi();
		setupToolErrorAudit(pi as unknown as ExtensionAPI);
		const handler = getRegisteredHandler(pi);

		await handler({ isError: true, toolName: "read", toolCallId: "call-1" });

		const [, entry] = pi.appendEntry.mock.calls[0] as [string, Record<string, unknown>];
		expect(entry.errorText).toBeNull();
	});

	it("falls back to result.error string when content array is absent", async () => {
		const pi = createMockPi();
		setupToolErrorAudit(pi as unknown as ExtensionAPI);
		const handler = getRegisteredHandler(pi);

		await handler({ isError: true, toolName: "edit", toolCallId: "call-2", result: { error: "bad edit" } });

		const [, entry] = pi.appendEntry.mock.calls[0] as [string, Record<string, unknown>];
		expect(entry.errorText).toBe("bad edit");
	});

	it("does not appendEntry when isError is false", async () => {
		const pi = createMockPi();
		setupToolErrorAudit(pi as unknown as ExtensionAPI);
		const handler = getRegisteredHandler(pi);

		await handler({ isError: false, toolName: "bash", toolCallId: "call-3", result: { content: [] } });

		expect(pi.appendEntry).not.toHaveBeenCalled();
	});
});
