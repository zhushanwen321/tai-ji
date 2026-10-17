// pending_notifications 收起态摘要测试：buildPendingNotificationsSummary 纯函数文案 +
// execute 产出的 details.summary + renderResult 折叠/展开形态。
//
// mock 形态沿用 pending-notifications.test.ts（最小 ExtensionAPI/ExtensionContext mock）。

import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import pendingNotificationsExtension, { buildPendingNotificationsSummary } from "../index";
import { renderPendingNotificationsResult } from "../render-result";

// ── mock（最小 ExtensionAPI / ExtensionContext）──────

function setup() {
	const registerToolMock = vi.fn();
	const entries: Array<{ customType: string; data: Record<string, unknown> }> = [];
	const pi = {
		appendEntry: vi.fn((customType: string, data: Record<string, unknown>) => {
			entries.push({ customType, data });
		}),
		registerTool: registerToolMock,
		sendMessage: vi.fn(),
		on: vi.fn(),
		events: { emit: vi.fn(), on: vi.fn() },
	};
	pendingNotificationsExtension(pi as never);
	const ctx = {
		sessionManager: {
			getEntries: () => entries,
			getSessionId: () => "sess-current",
		},
	};
	return { registerToolMock, entries, ctx };
}

async function runTool(
	setup: ReturnType<typeof setup>,
	params: { action: "count" | "list" },
): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> {
	const tool = setup.registerToolMock.mock.calls[0]![0] as {
		execute: (
			toolCallId: string,
			p: unknown,
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: unknown,
		) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
	};
	const res = await tool.execute("test-call-id", params, undefined, undefined, setup.ctx);
	return { ...res, details: res.details as Record<string, unknown> };
}

/** 注入 2 条活跃 pending entry（register 落盘、无 unregister） */
function seedActive(setup: ReturnType<typeof setup>, ids: string[]): void {
	for (const id of ids) {
		setup.entries.push({
			customType: "pending:register",
			data: { id, type: "workflow", name: `op-${id}`, registeredAt: 0, sessionId: "sess-current" },
		});
	}
}

// ── buildPendingNotificationsSummary ────────────────

describe("buildPendingNotificationsSummary", () => {
	it("count → N pending operations", () => {
		expect(buildPendingNotificationsSummary({ action: "count", count: 2 })).toBe(
			"2 pending operations",
		);
	});

	it("list → N entries listed", () => {
		expect(buildPendingNotificationsSummary({ action: "list", count: 4 })).toBe(
			"4 entries listed",
		);
	});

	it("零值 → No pending operations（与 content 文案零值口径一致）", () => {
		expect(buildPendingNotificationsSummary({ action: "count", count: 0 })).toBe(
			"No pending operations",
		);
		expect(buildPendingNotificationsSummary({ action: "list", count: 0 })).toBe(
			"No pending operations",
		);
	});
});

// ── execute 产出的 details.summary ───────────────────

describe("pending_notifications execute details.summary", () => {
	it("count action → details 带现有字段 + summary", async () => {
		const s = setup();
		const res = await runTool(s, { action: "count" });
		expect(res.details).toMatchObject({ action: "count", count: 0, summary: "No pending operations" });
	});

	it("list action → details 带现有字段 + summary", async () => {
		const s = setup();
		seedActive(s, ["a", "b", "c", "d"]);
		const res = await runTool(s, { action: "list" });
		expect(res.details).toMatchObject({ action: "list", count: 4, summary: "4 entries listed" });
		expect(Array.isArray(res.details.items)).toBe(true);
	});
});

// ── renderPendingNotificationsResult（TUI renderResult）──

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
	return renderPendingNotificationsResult(result, { expanded }, mockTheme)
		.render(400)
		.map((line) => line.trimEnd())
		.join("\n");
}

describe("renderPendingNotificationsResult", () => {
	it("折叠态 → details.summary 一行", () => {
		const r = {
			content: [{ type: "text", text: "2 pending operation(s):\n- [workflow] a" }],
			details: { action: "count", count: 2, summary: "2 pending operations" },
		};
		expect(renderedText(r, false)).toBe("2 pending operations");
	});

	it("展开态 → content 纯文本", () => {
		const r = {
			content: [{ type: "text", text: "line1\nline2" }],
			details: { action: "list", count: 2, summary: "2 entries listed" },
		};
		expect(renderedText(r, true)).toBe("line1\nline2");
	});

	it("无 summary（旧 entry）→ 折叠态回退 content 首行", () => {
		const r = { content: [{ type: "text", text: "2 pending operation(s):\n- [workflow] a" }], details: {} };
		expect(renderedText(r, false)).toBe("2 pending operation(s):");
	});
});
