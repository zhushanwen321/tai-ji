// 测试框架：vitest
// 运行命令：npx vitest run src/__tests__/state-machine.test.ts
//
// SDK 契约测试（extension-conventions.md「SDK 接口契约」条款）：用最小 mock 的
// ExtensionAPI 走完整事件序列，断言 cache-probe 对 pi SDK 的调用契约与状态机行为：
// baseline / 无变化不写 entry / 增量 entry / error 恢复 / agent_end 丢弃 pending /
// appendEntry 失败不崩 / session_start 重置。

/* eslint-disable taste/no-unsafe-cast */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import cacheProbe from "../index";

interface HandlerMap {
	session_start?: (e: unknown) => void | Promise<void>;
	before_agent_start?: (e: unknown) => void | Promise<void>;
	before_provider_request?: (e: unknown) => void | Promise<void>;
	agent_end?: (e: unknown) => void | Promise<void>;
}

interface MockSetup {
	pi: ExtensionAPI;
	handlers: HandlerMap;
	entries: Array<{ customType: string; data: Record<string, unknown> }>;
	getAllTools: ReturnType<typeof vi.fn>;
}

function options(over: Record<string, unknown> = {}) {
	return {
		cwd: "/w",
		contextFiles: [{ path: "/w/AGENTS.md", content: "base" }],
		skills: [{ name: "s1" }],
		selectedTools: ["read"],
		toolSnippets: { read: "r" },
		appendSystemPrompt: "append",
		promptGuidelines: ["g"],
		customPrompt: undefined,
		...over,
	};
}

function payload(systemContent = "sys") {
	return {
		model: "m",
		messages: [{ role: "developer", content: systemContent }, { role: "user", content: "u" }],
		tools: [{ name: "read", description: "d", parameters: { type: "object" } }],
	};
}

function createMockPi(): MockSetup {
	const handlers: HandlerMap = {};
	const entries: MockSetup["entries"] = [];
	const getAllTools = vi.fn(() => [
		{ name: "read", description: "d", parameters: { type: "object" }, promptGuidelines: undefined },
	]);
	const pi = {
		on: vi.fn((type: string, handler: (e: unknown) => unknown) => {
			handlers[type as keyof HandlerMap] = handler as HandlerMap[keyof HandlerMap];
		}),
		appendEntry: vi.fn((customType: string, data: Record<string, unknown>) => {
			entries.push({ customType, data });
			return String(entries.length);
		}),
		getAllTools,
	};
	return { pi: pi as unknown as ExtensionAPI, handlers, entries, getAllTools };
}

async function runTurn(setup: MockSetup, opts: Record<string, unknown>, payloadArg = payload()) {
	await setup.handlers.before_agent_start!({ type: "before_agent_start", systemPrompt: "s", systemPromptOptions: opts });
	await setup.handlers.before_provider_request!({ type: "before_provider_request", payload: payloadArg });
}

describe("cache-probe 状态机（SDK 契约）", () => {
	let setup: MockSetup;
	beforeEach(() => {
		setup = createMockPi();
		cacheProbe(setup.pi);
	});

	it("注册 4 个事件 handler，不注册 tool / 不发消息（零行为影响）", () => {
		expect(setup.handlers.session_start).toBeDefined();
		expect(setup.handlers.before_agent_start).toBeDefined();
		expect(setup.handlers.before_provider_request).toBeDefined();
		expect(setup.handlers.agent_end).toBeDefined();
	});

	it("进程首笔请求写 baseline（v2、全量 9 key、16 hex、cwd、startReason）", async () => {
		await setup.handlers.session_start!({ type: "session_start", reason: "startup" });
		await runTurn(setup, options());
		expect(setup.entries).toHaveLength(1);
		const e = setup.entries[0];
		expect(e.customType).toBe("cache-probe");
		expect(e.data).toMatchObject({ v: 2, seq: 1, baseline: true, startReason: "startup", cwd: "/w", changed: ["*"] });
		const h = e.data.h as Record<string, string>;
		expect(Object.keys(h).sort()).toEqual(
			["append", "contextFiles", "customPrompt", "guidelines", "skills", "spFull", "toolsList", "toolsReg", "toolsSent"].sort(),
		);
		expect(Object.values(h).every((v) => /^[0-9a-f]{16}$/.test(v))).toBe(true);
	});

	it("同状态连续 turn 不写 entry；变化只写增量 entry（省数据量的核心）", async () => {
		await setup.handlers.session_start!({ type: "session_start", reason: "startup" });
		await runTurn(setup, options());
		await runTurn(setup, options());
		await runTurn(setup, options());
		expect(setup.entries).toHaveLength(1); // 3 turn 仅 baseline
		await runTurn(setup, options({ contextFiles: [{ path: "/w/AGENTS.md", content: "changed" }] }));
		expect(setup.entries).toHaveLength(2);
		expect(setup.entries[1].data).toMatchObject({ v: 2, seq: 4, changed: ["contextFiles"] });
		expect(Object.keys(setup.entries[1].data.h as object)).toEqual(["contextFiles"]);
	});

	it("payload 侧变化（spFull）单独可检测（extension 链注入场景）", async () => {
		await setup.handlers.session_start!({ type: "session_start", reason: "startup" });
		await runTurn(setup, options(), payload("sys-1"));
		await runTurn(setup, options(), payload("sys-2"));
		expect(setup.entries).toHaveLength(2);
		expect(setup.entries[1].data.changed).toEqual(["spFull"]);
	});

	it("agent_end 后 pending 被丢弃：无 turn 上下文的 provider 请求不写 entry", async () => {
		await setup.handlers.session_start!({ type: "session_start", reason: "startup" });
		await runTurn(setup, options());
		await setup.handlers.before_agent_start!({ type: "before_agent_start", systemPrompt: "s", systemPromptOptions: options() });
		await setup.handlers.agent_end!({ type: "agent_end" }); // turn 取消，未发请求
		await setup.handlers.before_provider_request!({ type: "before_provider_request", payload: payload() });
		expect(setup.entries).toHaveLength(1);
	});

	it("session_start 重置：跨进程写新 baseline", async () => {
		await setup.handlers.session_start!({ type: "session_start", reason: "startup" });
		await runTurn(setup, options());
		await setup.handlers.session_start!({ type: "session_start", reason: "startup" });
		await runTurn(setup, options());
		expect(setup.entries).toHaveLength(2);
		expect(setup.entries[1].data.baseline).toBe(true);
	});

	it("handler 异常写 error entry 且下一 turn 恢复 baseline", async () => {
		await setup.handlers.session_start!({ type: "session_start", reason: "startup" });
		setup.getAllTools.mockImplementationOnce(() => {
			throw new Error("injected");
		});
		await setup.handlers.before_agent_start!({ type: "before_agent_start", systemPrompt: "s", systemPromptOptions: options() });
		await setup.handlers.before_provider_request!({ type: "before_provider_request", payload: payload() });
		expect(setup.entries).toHaveLength(1);
		expect(setup.entries[0].data).toMatchObject({ v: 2, seq: 1, error: "injected" });
		// 下一 turn 恢复：needsBaseline 已置位
		await runTurn(setup, options());
		expect(setup.entries).toHaveLength(2);
		expect(setup.entries[1].data.baseline).toBe(true);
	});

	it("appendEntry 失败不崩（stderr 诊断吞掉）", async () => {
		const pi = setup.pi as unknown as { appendEntry: ReturnType<typeof vi.fn> };
		pi.appendEntry.mockImplementation(() => {
			throw new Error("disk full");
		});
		await setup.handlers.session_start!({ type: "session_start", reason: "startup" });
		await expect(runTurn(setup, options())).resolves.toBeUndefined();
	});
});
