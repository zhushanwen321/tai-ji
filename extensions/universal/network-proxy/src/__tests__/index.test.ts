/**
 * extension 入口行为单测（真实组件 + tmp agentDir，不 mock undici 全局槽与配置读取链）：
 * 工厂加载序列（校验过 → 安装分流器 / 非法 → error + 全直连）、turn 粒度热生效
 * （turn_start 重读配置、turn_end flush 计数）。vi.resetModules 隔离模块级 installed 状态。
 * fs-guard 白名单：写入目标 = PI_CODING_AGENT_DIR 注入的 mkdtemp tmp 目录。
 */
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";

const { loggerMock } = vi.hoisted(() => ({
	loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({
	getLogger: () => loggerMock,
	createLogger: () => loggerMock,
	setPiHandle: vi.fn(),
}));

import { isRuleDispatchDispatcher, RuleDispatchDispatcher } from "../dispatcher.ts";

/** fake pi ExtensionAPI：收集 on 注册的 handler，emit 触发。 */
function createFakePi() {
	const handlers = new Map<string, Array<() => void>>();
	const pi = {
		on: (event: string, handler: () => void) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
	return {
		pi,
		emit: (event: "turn_start" | "turn_end") => {
			for (const h of handlers.get(event) ?? []) h();
		},
	};
}

const ENABLED_CONFIG = {
	enabled: true,
	proxy: { protocol: "http", host: "127.0.0.1", port: 7890, username: "", password: "" },
	noProxy: ["localhost"],
	rules: ["api.anthropic.com"],
};

let agentDir: string;
let savedDispatcher: Dispatcher;

function writeConfigFile(content: string): void {
	mkdirSync(join(agentDir, "config"), { recursive: true });
	writeFileSync(join(agentDir, "config", "network-proxy-ext-config.json"), content);
}

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "network-proxy-index-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	// 保存 undici 全局槽，afterEach 恢复（工厂安装/摘除都改写这个槽）
	savedDispatcher = getGlobalDispatcher();
	loggerMock.error.mockClear();
});

afterEach(() => {
	setGlobalDispatcher(savedDispatcher);
	vi.unstubAllEnvs();
	vi.resetModules();
});

describe("networkProxyExtension 工厂加载序列", () => {
	it("enabled 且校验过：安装分流器到全局槽（识别走 RuleDispatchDispatcher）", async () => {
		writeConfigFile(JSON.stringify(ENABLED_CONFIG));
		const { default: networkProxyExtension } = await import("../index.ts");
		networkProxyExtension(createFakePi().pi);
		expect(isRuleDispatchDispatcher(getGlobalDispatcher())).toBe(true);
		expect(getGlobalDispatcher()).toBeInstanceOf(RuleDispatchDispatcher);
		expect(loggerMock.error).not.toHaveBeenCalled();
	});

	it("enabled=false：不安装（槽保持 pi 原生分发器），零 error", async () => {
		writeConfigFile(JSON.stringify({ ...ENABLED_CONFIG, enabled: false }));
		const { default: networkProxyExtension } = await import("../index.ts");
		networkProxyExtension(createFakePi().pi);
		expect(getGlobalDispatcher()).toBe(savedDispatcher);
		expect(loggerMock.error).not.toHaveBeenCalled();
	});

	it("非法配置（坏 JSON）：不抛、不安装（全部直连），error 含恢复动作（配置文件路径）", async () => {
		writeConfigFile("{ not valid json");
		const { default: networkProxyExtension } = await import("../index.ts");
		expect(() => networkProxyExtension(createFakePi().pi)).not.toThrow();
		expect(getGlobalDispatcher()).toBe(savedDispatcher);
		const messages = loggerMock.error.mock.calls.map((c) => String(c[0]));
		expect(messages.some((m) => m.includes("network-proxy-ext-config.json"))).toBe(true);
	});

	it("非法字段（端口越界）：loadConfig 回落 defaults（enabled=false → 不安装）+ error 可归因", async () => {
		writeConfigFile(JSON.stringify({ ...ENABLED_CONFIG, proxy: { ...ENABLED_CONFIG.proxy, port: 99999 } }));
		const { default: networkProxyExtension } = await import("../index.ts");
		expect(() => networkProxyExtension(createFakePi().pi)).not.toThrow();
		expect(getGlobalDispatcher()).toBe(savedDispatcher);
		expect(loggerMock.error.mock.calls.length).toBeGreaterThan(0);
	});
});

describe("turn 粒度热生效", () => {
	it("turn_start 重读配置：指纹变化重建（槽上换新分流器），未变零动作", async () => {
		writeConfigFile(JSON.stringify(ENABLED_CONFIG));
		const { default: networkProxyExtension } = await import("../index.ts");
		const { pi, emit } = createFakePi();
		networkProxyExtension(pi);
		const first = getGlobalDispatcher();

		// 未变配置：同分发器（不重建）
		emit("turn_start");
		expect(getGlobalDispatcher()).toBe(first);

		// 改写配置（size 变化 → mtime+size 缓存失效）：指纹变化重建
		writeConfigFile(JSON.stringify({ ...ENABLED_CONFIG, rules: ["api.openai.com"] }));
		emit("turn_start");
		const second = getGlobalDispatcher();
		expect(second).not.toBe(first);
		expect(isRuleDispatchDispatcher(second)).toBe(true);
	});

	it("turn_end flush 计数增量到 stats JSONL（recordDispatch → turn_end → 落盘行）", async () => {
		writeConfigFile(JSON.stringify(ENABLED_CONFIG));
		const { default: networkProxyExtension } = await import("../index.ts");
		// resetModules 后 index.ts 与此处 import 的 stats.ts 是同一模块图刷新的同一实例
		const { recordDispatch } = await import("../stats.ts");
		const { statsFilePath } = await import("../stats.ts");
		const { pi, emit } = createFakePi();
		networkProxyExtension(pi);

		recordDispatch("api.anthropic.com", true);
		recordDispatch("open.bigmodel.cn", false);
		emit("turn_end");

		const lines = readFileSync(statsFilePath(), "utf-8").split("\n").filter((l) => l !== "");
		expect(lines).toHaveLength(2);
		const hosts = lines.map((l) => (JSON.parse(l) as { host: string }).host).sort();
		expect(hosts).toEqual(["api.anthropic.com", "open.bigmodel.cn"]);
	});

	it("enabled true→false：turn_start 后恢复 pi 原生分发器（禁用生效）", async () => {
		writeConfigFile(JSON.stringify(ENABLED_CONFIG));
		const { default: networkProxyExtension } = await import("../index.ts");
		const { pi, emit } = createFakePi();
		networkProxyExtension(pi);
		expect(isRuleDispatchDispatcher(getGlobalDispatcher())).toBe(true);

		writeConfigFile(JSON.stringify({ ...ENABLED_CONFIG, enabled: false }));
		emit("turn_start");
		expect(getGlobalDispatcher()).toBe(savedDispatcher);
	});
});
