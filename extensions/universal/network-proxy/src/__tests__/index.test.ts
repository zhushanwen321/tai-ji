/**
 * extension 入口行为单测（真实组件 + tmp agentDir，不 mock 配置读取链）：
 * 工厂加载序列（校验过 → 包装 globalThis.fetch / 非法 → error + 全直连）、turn 粒度热生效
 * （turn_start 重读配置、turn_end flush 计数）。vi.resetModules 隔离模块级 installed 状态。
 * fs-guard 白名单：写入目标 = PI_CODING_AGENT_DIR 注入的 mkdtemp tmp 目录。
 */
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
	loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({
	getLogger: () => loggerMock,
	createLogger: () => loggerMock,
	setPiHandle: vi.fn(),
}));

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

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

let agentDir: string;
let savedFetch: FetchLike;
let fakeFetch: FetchLike;
let fakeCalls: number;

function writeConfigFile(content: string): void {
	mkdirSync(join(agentDir, "config"), { recursive: true });
	writeFileSync(join(agentDir, "config", "network-proxy-ext-config.json"), content);
}

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "network-proxy-index-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	savedFetch = globalThis.fetch;
	fakeCalls = 0;
	fakeFetch = async () => {
		fakeCalls += 1;
		return new Response("fake-original");
	};
	globalThis.fetch = fakeFetch;
	loggerMock.error.mockClear();
});

afterEach(() => {
	globalThis.fetch = savedFetch;
	vi.unstubAllEnvs();
	vi.resetModules();
});

describe("networkProxyExtension 工厂加载序列", () => {
	it("enabled 且校验过：包装 globalThis.fetch（未命中规则时委托 fake 原 fetch）", async () => {
		writeConfigFile(JSON.stringify(ENABLED_CONFIG));
		const { default: networkProxyExtension } = await import("../index.ts");
		networkProxyExtension(createFakePi().pi);
		expect(globalThis.fetch).not.toBe(fakeFetch);
		const response = await globalThis.fetch("https://open.bigmodel.cn/api");
		expect(await response.text()).toBe("fake-original");
		expect(fakeCalls).toBe(1);
		expect(loggerMock.error).not.toHaveBeenCalled();
	});

	it("enabled=false：不包装（globalThis.fetch 保持原实现），零 error", async () => {
		writeConfigFile(JSON.stringify({ ...ENABLED_CONFIG, enabled: false }));
		const { default: networkProxyExtension } = await import("../index.ts");
		networkProxyExtension(createFakePi().pi);
		expect(globalThis.fetch).toBe(fakeFetch);
		expect(loggerMock.error).not.toHaveBeenCalled();
	});

	it("非法配置（坏 JSON）：不抛、不包装（全部直连），error 含恢复动作（配置文件路径）", async () => {
		writeConfigFile("{ not valid json");
		const { default: networkProxyExtension } = await import("../index.ts");
		expect(() => networkProxyExtension(createFakePi().pi)).not.toThrow();
		expect(globalThis.fetch).toBe(fakeFetch);
		const messages = loggerMock.error.mock.calls.map((c) => String(c[0]));
		expect(messages.some((m) => m.includes("network-proxy-ext-config.json"))).toBe(true);
	});

	it("非法字段（端口越界）：loadConfig 回落 defaults（enabled=false → 不包装）+ error 可归因", async () => {
		writeConfigFile(JSON.stringify({ ...ENABLED_CONFIG, proxy: { ...ENABLED_CONFIG.proxy, port: 99999 } }));
		const { default: networkProxyExtension } = await import("../index.ts");
		expect(() => networkProxyExtension(createFakePi().pi)).not.toThrow();
		expect(globalThis.fetch).toBe(fakeFetch);
		expect(loggerMock.error.mock.calls.length).toBeGreaterThan(0);
	});
});

describe("turn 粒度热生效", () => {
	it("turn_start 重读配置：指纹变化换新包装，未变零动作", async () => {
		writeConfigFile(JSON.stringify(ENABLED_CONFIG));
		const { default: networkProxyExtension } = await import("../index.ts");
		const { pi, emit } = createFakePi();
		networkProxyExtension(pi);
		const first = globalThis.fetch;

		// 未变配置：同包装函数（不重建）
		emit("turn_start");
		expect(globalThis.fetch).toBe(first);

		// 改写配置（size 变化 → mtime+size 缓存失效）：指纹变化换新包装
		writeConfigFile(JSON.stringify({ ...ENABLED_CONFIG, rules: ["api.openai.com"] }));
		emit("turn_start");
		expect(globalThis.fetch).not.toBe(first);
	});

	it("pi 重装 globalThis.fetch（configureHttpDispatcher）后 turn_start 重新包装覆盖者", async () => {
		writeConfigFile(JSON.stringify(ENABLED_CONFIG));
		const { default: networkProxyExtension } = await import("../index.ts");
		const { pi, emit } = createFakePi();
		networkProxyExtension(pi);

		let piReinstalledCalls = 0;
		const piReinstalled: FetchLike = async () => {
			piReinstalledCalls += 1;
			return new Response("pi-native");
		};
		globalThis.fetch = piReinstalled;
		emit("turn_start");

		expect(globalThis.fetch).not.toBe(piReinstalled);
		const response = await globalThis.fetch("https://open.bigmodel.cn/api");
		expect(await response.text()).toBe("pi-native");
		expect(piReinstalledCalls).toBe(1);
	});

	it("turn_end flush 计数增量到 stats JSONL（recordDispatch → turn_end → 落盘行）", async () => {
		writeConfigFile(JSON.stringify(ENABLED_CONFIG));
		const { default: networkProxyExtension } = await import("../index.ts");
		// resetModules 后 index.ts 与此处 import 的 stats.ts 是同一模块图刷新的同一实例
		const { recordDispatch, statsFilePath } = await import("../stats.ts");
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

	it("enabled true→false：turn_start 后恢复原 fetch（禁用生效）", async () => {
		writeConfigFile(JSON.stringify(ENABLED_CONFIG));
		const { default: networkProxyExtension } = await import("../index.ts");
		const { pi, emit } = createFakePi();
		networkProxyExtension(pi);
		expect(globalThis.fetch).not.toBe(fakeFetch);

		writeConfigFile(JSON.stringify({ ...ENABLED_CONFIG, enabled: false }));
		emit("turn_start");
		expect(globalThis.fetch).toBe(fakeFetch);
	});
});
