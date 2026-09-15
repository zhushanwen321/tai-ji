// src/__tests__/config.test.ts —— M4 配置 normalize 全矩阵 + 读时刷新热重载
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// logger mock：断言「单键回退默认 + warn」的可证伪性（真实 logger 行为不在本文件验证面）
const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }));
vi.mock("@zhushanwen/pi-extension-logger", () => ({
	getLogger: () => ({ debug: vi.fn(), warn: warnMock, error: vi.fn() }),
}));

// getAgentDir → 测试临时目录（loadConfig 经 llm-shared getConfigPath 用它推导路径）
const { agentDirRef } = vi.hoisted(() => ({ agentDirRef: { dir: "" } }));
vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => agentDirRef.dir,
}));

import { clearConfigCache } from "@zhushanwen/pi-llm-shared";

import {
	DEFAULT_BASE_TOOL_ENHANCE_CONFIG,
	getConfigFilePath,
	loadBaseToolEnhanceConfig,
	normalizeBaseToolEnhanceConfig,
} from "../config.ts";

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "bte-config-"));
	agentDirRef.dir = tempDir;
	warnMock.mockClear();
	clearConfigCache();
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function writeConfigFile(content: string): void {
	const path = getConfigFilePath();
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content, "utf8");
}

describe("normalizeBaseToolEnhanceConfig（键级矩阵）", () => {
	it("合法全量配置原样通过（含 null timeout 与正则数组）", () => {
		const config = normalizeBaseToolEnhanceConfig({
			forceBackgroundPatterns: ["sleep \\d+", "make .*"],
			disableBuiltinForcePatterns: true,
			foregroundTimeoutSeconds: 30,
			backgroundTimeoutSeconds: 600,
			maxConcurrentBackground: 16,
		});
		expect(config).toEqual({
			forceBackgroundPatterns: ["sleep \\d+", "make .*"],
			disableBuiltinForcePatterns: true,
			foregroundTimeoutSeconds: 30,
			backgroundTimeoutSeconds: 600,
			maxConcurrentBackground: 16,
		});
		expect(warnMock).not.toHaveBeenCalled();
	});

	it("零输入（undefined/null/空对象）→ 全默认值", () => {
		for (const raw of [undefined, null, {}]) {
			expect(normalizeBaseToolEnhanceConfig(raw)).toEqual(DEFAULT_BASE_TOOL_ENHANCE_CONFIG);
		}
		// null/undefined 是合法缺省，不 warn；空对象也不 warn
		expect(warnMock).not.toHaveBeenCalled();
	});

	it("根非对象（数组/字符串/数字）→ 全默认 + warn 指向路径", () => {
		expect(normalizeBaseToolEnhanceConfig(["npm test"])).toEqual(DEFAULT_BASE_TOOL_ENHANCE_CONFIG);
		expect(warnMock).toHaveBeenCalledTimes(1);
		expect(warnMock.mock.calls[0]?.[0]).toContain("not a JSON object");
		expect(warnMock.mock.calls[0]?.[0]).toContain("base-tool-enhance-ext-config.json");
	});

	it("timeout：负数/0/字符串/NaN/Infinity → 回退 null + warn", () => {
		for (const bad of [-5, 0, "10", Number.NaN, Number.POSITIVE_INFINITY]) {
			warnMock.mockClear();
			const config = normalizeBaseToolEnhanceConfig({ foregroundTimeoutSeconds: bad });
			expect(config.foregroundTimeoutSeconds).toBeNull();
			expect(warnMock).toHaveBeenCalledTimes(1);
		}
		const config2 = normalizeBaseToolEnhanceConfig({ backgroundTimeoutSeconds: -1 });
		expect(config2.backgroundTimeoutSeconds).toBeNull();
		expect(warnMock).toHaveBeenCalled();
	});

	it("timeout：换算毫秒超 int32 上限 → clamp 至 int32 毫秒对应秒数 + warn", () => {
		const config = normalizeBaseToolEnhanceConfig({ foregroundTimeoutSeconds: 1_000_000_000 });
		// int32 ms 上限 2147483647 → 2147483.647s
		expect(config.foregroundTimeoutSeconds).toBeCloseTo(2147483.647, 3);
		expect(warnMock).toHaveBeenCalledTimes(1);
		expect(warnMock.mock.calls[0]?.[0]).toContain("clamped");
		// 上限内（2147483s = 2147483000ms < int32 max）不 clamp
		expect(normalizeBaseToolEnhanceConfig({ foregroundTimeoutSeconds: 2_147_483 }).foregroundTimeoutSeconds).toBe(
			2_147_483,
		);
	});

	it("forceBackgroundPatterns：非数组 → 空 + warn；缺省/null → 空且不 warn", () => {
		expect(normalizeBaseToolEnhanceConfig({ forceBackgroundPatterns: "sleep \\d+" }).forceBackgroundPatterns).toEqual(
			[],
		);
		expect(warnMock).toHaveBeenCalledTimes(1);
		warnMock.mockClear();
		expect(normalizeBaseToolEnhanceConfig({}).forceBackgroundPatterns).toEqual([]);
		expect(normalizeBaseToolEnhanceConfig({ forceBackgroundPatterns: null }).forceBackgroundPatterns).toEqual([]);
		expect(warnMock).not.toHaveBeenCalled();
	});

	it("forceBackgroundPatterns：单条坏正则仅丢弃该条，其余保留（一条坏正则不拖垮全部）", () => {
		const config = normalizeBaseToolEnhanceConfig({
			forceBackgroundPatterns: ["sleep \\d+", "([bad", "make .*", 42],
		});
		expect(config.forceBackgroundPatterns).toEqual(["sleep \\d+", "make .*"]);
		expect(warnMock).toHaveBeenCalledTimes(2); // 坏正则 + 非字符串各一条
		expect(warnMock.mock.calls[0]?.[0]).toContain("not a valid regex");
	});

	it("disableBuiltinForcePatterns：非 boolean → false + warn；boolean 原样", () => {
		expect(normalizeBaseToolEnhanceConfig({ disableBuiltinForcePatterns: true }).disableBuiltinForcePatterns).toBe(
			true,
		);
		expect(normalizeBaseToolEnhanceConfig({ disableBuiltinForcePatterns: false }).disableBuiltinForcePatterns).toBe(
			false,
		);
		const config = normalizeBaseToolEnhanceConfig({ disableBuiltinForcePatterns: "yes" });
		expect(config.disableBuiltinForcePatterns).toBe(false);
		expect(warnMock).toHaveBeenCalledTimes(1);
	});

	it("maxConcurrentBackground：0/负数/字符串 → 默认 8 + warn；小数 floor；合法整数原样", () => {
		for (const bad of [0, -1, "8", Number.NaN]) {
			warnMock.mockClear();
			expect(normalizeBaseToolEnhanceConfig({ maxConcurrentBackground: bad }).maxConcurrentBackground).toBe(8);
			expect(warnMock).toHaveBeenCalledTimes(1);
		}
		expect(normalizeBaseToolEnhanceConfig({ maxConcurrentBackground: 4.9 }).maxConcurrentBackground).toBe(4);
		expect(normalizeBaseToolEnhanceConfig({ maxConcurrentBackground: 16 }).maxConcurrentBackground).toBe(16);
	});

	it("未知键忽略（前向兼容，不 warn 不拒载）", () => {
		const config = normalizeBaseToolEnhanceConfig({ futureKey: "x", foregroundTimeoutSeconds: 5 });
		expect(config.foregroundTimeoutSeconds).toBe(5);
		expect(warnMock).not.toHaveBeenCalled();
	});
});

describe("loadBaseToolEnhanceConfig（llm-shared loadConfig 集成）", () => {
	it("文件不存在 → 全默认值（工具照常工作）", () => {
		expect(loadBaseToolEnhanceConfig()).toEqual(DEFAULT_BASE_TOOL_ENHANCE_CONFIG);
	});

	it("文件整体损坏（坏 JSON）→ 全默认值 + warn 指向路径", () => {
		writeConfigFile("{ not json !!!");
		const config = loadBaseToolEnhanceConfig();
		expect(config).toEqual(DEFAULT_BASE_TOOL_ENHANCE_CONFIG);
		expect(warnMock).toHaveBeenCalledTimes(1);
		expect(warnMock.mock.calls[0]?.[0]).toContain("base-tool-enhance-ext-config.json");
	});

	it("键级坏配置经 loadConfig 读取同样键级回退（normalize 永不整体拒载）", () => {
		writeConfigFile(JSON.stringify({ foregroundTimeoutSeconds: -3, maxConcurrentBackground: 4 }));
		const config = loadBaseToolEnhanceConfig();
		expect(config.foregroundTimeoutSeconds).toBeNull();
		expect(config.maxConcurrentBackground).toBe(4);
	});

	it("热重载：改配置文件后（不重启、不手动刷新）再次 load 拿到新值（mtime+size 读时刷新）", () => {
		writeConfigFile(JSON.stringify({ foregroundTimeoutSeconds: 11 }));
		expect(loadBaseToolEnhanceConfig().foregroundTimeoutSeconds).toBe(11);

		// 内容变化（size 变化触发 mtime+size 缓存失效）
		writeConfigFile(JSON.stringify({ foregroundTimeoutSeconds: 222 }));
		expect(loadBaseToolEnhanceConfig().foregroundTimeoutSeconds).toBe(222);

		// 删除文件 → 回默认（缓存同样失效）
		rmSync(getConfigFilePath());
		expect(loadBaseToolEnhanceConfig()).toEqual(DEFAULT_BASE_TOOL_ENHANCE_CONFIG);
	});

	it("配置文件路径 = <agentDir>/config/base-tool-enhance-ext-config.json", () => {
		expect(getConfigFilePath()).toBe(join(tempDir, "config", "base-tool-enhance-ext-config.json"));
		writeConfigFile("{}");
		expect(existsSync(getConfigFilePath())).toBe(true);
	});
});
