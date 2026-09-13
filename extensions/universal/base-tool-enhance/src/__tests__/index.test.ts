// src/__tests__/index.test.ts —— 入口集成：工具注册（bash / bash_output / bash_kill）+
// 审计 hook 挂载 + M3 接线（D17 引用刷新 / exit 边沿通知 / session_start 对账链）
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

const { createBashToolDefinitionMock, dataDirRef } = vi.hoisted(() => ({
	createBashToolDefinitionMock: vi.fn(),
	dataDirRef: { dir: "/tmp/bte-fake-agent-dir" },
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
	createBashToolDefinition: createBashToolDefinitionMock,
	getAgentDir: () => dataDirRef.dir,
}));

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { getRegistryPath, writeRegistryEntry } from "../background/registry.ts";
import { resetNotifyForTest } from "../background/notify.ts";
import baseToolEnhanceExtension from "../index.ts";

function createMockPi() {
	return {
		registerTool: vi.fn(),
		on: vi.fn(),
		appendEntry: vi.fn(),
		events: { emit: vi.fn(), on: vi.fn() },
		sendMessage: vi.fn(),
	};
}

function setupOfficialFactory() {
	createBashToolDefinitionMock.mockReset();
	createBashToolDefinitionMock.mockReturnValue({
		name: "bash",
		label: "bash",
		description: "official",
		parameters: {},
		execute: vi.fn(),
	});
}

describe("baseToolEnhanceExtension entry", () => {
	it("registers bash (override), bash_output and bash_kill tools by name", () => {
		setupOfficialFactory();
		const pi = createMockPi();

		baseToolEnhanceExtension(pi as unknown as ExtensionAPI);

		expect(pi.registerTool).toHaveBeenCalledTimes(3);
		const names = pi.registerTool.mock.calls.map((call) => (call[0] as { name: string }).name);
		expect(names).toEqual(["bash", "bash_output", "bash_kill"]);
	});

	it("mounts the tool error audit hook", () => {
		setupOfficialFactory();
		const pi = createMockPi();

		baseToolEnhanceExtension(pi as unknown as ExtensionAPI);

		expect(pi.on).toHaveBeenCalledWith("tool_execution_end", expect.any(Function));
	});

	it("registers a session_start handler (reconcile chain, M3)", () => {
		setupOfficialFactory();
		const pi = createMockPi();

		baseToolEnhanceExtension(pi as unknown as ExtensionAPI);

		expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
	});
});

describe("session_start chain: reconcile (M3, reap sunk into runtime by u-bte-remove)", () => {
	it("settles a zombie register via appendEntry on the SAME pi reference", async () => {
		setupOfficialFactory();
		// 独立临时 dataDir（维护链只读不扫：收殓已下沉 runtime），registry 预置终态僵尸条目
		const dataDir = mkdtempSync(join(tmpdir(), "bte-index-"));
		dataDirRef.dir = dataDir;
		try {
			const sessionId = "sess-index";
			writeRegistryEntry(getRegistryPath(dataDir, sessionId), {
				taskId: "bt-1700000000-idx001",
				pid: 12345,
				command: "sleep 3600",
				outputFile: "/tmp/idx.log",
				startedAt: 1_700_000_000_000,
				state: "orphaned",
				ownerPiPid: 1,
				sessionId,
			});
			const pi = createMockPi();
			baseToolEnhanceExtension(pi as unknown as ExtensionAPI);

			const handler = pi.on.mock.calls.find((call) => call[0] === "session_start")?.[1] as (
				event: unknown,
				ctx: { sessionManager: { getSessionId: () => string; getEntries: () => unknown[] } },
			) => void;
			expect(handler).toBeDefined();
			// pi runner emit session_start 必带事件（SessionStartEvent.reason 必填，
			// pi 0.84.4 实装核实）——维护链入口日志消费 reason
			handler({ type: "session_start", reason: "resume" }, {
				sessionManager: {
					getSessionId: () => sessionId,
					getEntries: () => [
						{
							customType: "pending:register",
							data: { id: "bt-1700000000-idx001", type: "bash", name: "sleep 3600" },
						},
					],
				},
			});

			// handler 同步直跑对账（u-bte-remove 后无 reap await）——等待落定
			await vi.waitFor(() =>
				expect(pi.appendEntry).toHaveBeenCalledWith("pending:unregister", {
					id: "bt-1700000000-idx001",
					reason: "cancelled",
					status: "cancelled",
				}),
			);
			// 尽力补 emit 已随 ext-simplify-13 删除（恒 no-op 死路径）——对账后不得有任何
			// bus emit，appendEntry 即唯一权威路径
			expect(pi.events.emit).not.toHaveBeenCalled();
		} finally {
			rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
			dataDirRef.dir = "/tmp/bte-fake-agent-dir";
			resetNotifyForTest();
		}
	});
});
