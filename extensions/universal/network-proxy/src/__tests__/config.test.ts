/**
 * 配置校验语义镜像 + 指纹 + 热重载读取。
 *
 * 校验/默认值语义 SSOT = packages/shared/src/network-proxy.ts（复制体镜像锁定——本文件
 * 关键形态断言的字面文案与 shared validateNetworkProxyConfig 一致）；DEFAULT 与
 * startupConfig 声明的深相等由 startup-config-declaration.test.ts 另锁。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearConfigCache } from "@zhushanwen/pi-llm-shared";

import {
	DEFAULT_NETWORK_PROXY_CONFIG,
	loadNetworkProxyConfig,
	networkProxyFingerprint,
	normalizeNetworkProxyConfig,
	validateNetworkProxyConfig,
	type NetworkProxyConfig,
} from "../config.ts";

// mock 掉共享 logger（loadConfig 的 onWarning 由本测试显式断言，logger 通道静音防噪音）
const { loggerMock } = vi.hoisted(() => ({
	loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({
	getLogger: () => loggerMock,
	createLogger: () => loggerMock,
	setPiHandle: vi.fn(),
}));

let agentDir: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "network-proxy-cfg-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	clearConfigCache();
});

afterEach(() => {
	vi.unstubAllEnvs();
});

function writeConfigFile(content: unknown): void {
	mkdirSync(join(agentDir, "config"), { recursive: true });
	writeFileSync(
		join(agentDir, "config", "network-proxy-ext-config.json"),
		JSON.stringify(content, null, 2),
		"utf-8",
	);
}

function validConfig(overrides?: Partial<NetworkProxyConfig>): NetworkProxyConfig {
	return {
		enabled: true,
		proxy: { protocol: "http", host: "127.0.0.1", port: 7890, username: "", password: "" },
		noProxy: ["localhost"],
		rules: ["api.anthropic.com"],
		ipv4Only: [],
		...overrides,
	};
}

describe("validateNetworkProxyConfig（语义镜像）", () => {
	it("合法配置 ok", () => {
		expect(validateNetworkProxyConfig(validConfig())).toEqual({ ok: true });
		expect(validateNetworkProxyConfig(DEFAULT_NETWORK_PROXY_CONFIG)).toEqual({ ok: true });
	});

	it("协议白名单：非法协议报错且文案与 shared 一致", () => {
		const result = validateNetworkProxyConfig(validConfig({
			proxy: { protocol: "socks4" as never, host: "127.0.0.1", port: 7890, username: "", password: "" },
		}));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0]).toContain("http / https / socks5");
		}
	});

	it("端口越界（70000 / 0 / 非整数）逐项报错，不短路", () => {
		for (const port of [70000, 0, 1.5]) {
			const result = validateNetworkProxyConfig(validConfig({
				proxy: { protocol: "http", host: "127.0.0.1", port, username: "", password: "" },
			}));
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.errors.some((e) => e.includes("1-65535"))).toBe(true);
			}
		}
	});

	it("凭据单边报错（成对约束）", () => {
		const onlyUser = validateNetworkProxyConfig(validConfig({
			proxy: { protocol: "http", host: "h", port: 1, username: "u", password: "" },
		}));
		const onlyPass = validateNetworkProxyConfig(validConfig({
			proxy: { protocol: "http", host: "h", port: 1, username: "", password: "p" },
		}));
		expect(onlyUser.ok).toBe(false);
		expect(onlyPass.ok).toBe(false);
		// 成对非空合法
		expect(validateNetworkProxyConfig(validConfig({
			proxy: { protocol: "http", host: "h", port: 1, username: "u", password: "p" },
		})).ok).toBe(true);
	});

	it("enabled 非布尔报错", () => {
		const result = validateNetworkProxyConfig(validConfig({ enabled: "yes" as never }));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0]).toContain("开或关");
		}
	});

	it("noProxy/rules 条目空串与非列表报错", () => {
		const emptyEntry = validateNetworkProxyConfig(validConfig({ rules: ["  "] }));
		expect(emptyEntry.ok).toBe(false);
		const notArray = validateNetworkProxyConfig(validConfig({ noProxy: "localhost" as never }));
		expect(notArray.ok).toBe(false);
	});

	it("noProxy/rules 条目空白字符拒绝（首尾与内部同等拒绝——归一化不 trim，带空白恒不匹配故校验显式拒绝，文案与 shared 一致）", () => {
		const leading = validateNetworkProxyConfig(validConfig({ rules: [" api.anthropic.com"] }));
		expect(leading.ok).toBe(false);
		if (!leading.ok) {
			expect(leading.errors[0]).toContain("第 1 条含空白字符");
		}
		const trailingTab = validateNetworkProxyConfig(validConfig({ noProxy: ["localhost\t"] }));
		expect(trailingTab.ok).toBe(false);
		if (!trailingTab.ok) {
			expect(trailingTab.errors[0]).toContain("含空白字符，请删除空白后保存");
		}
		// 内部空白（如「api. anthropic.com」）同样拒绝：对真实主机名恒不匹配，静默不生效
		const inner = validateNetworkProxyConfig(validConfig({ rules: ["api. anthropic.com"] }));
		expect(inner.ok).toBe(false);
		if (!inner.ok) {
			expect(inner.errors[0]).toContain("含空白字符，请删除空白后保存");
		}
		// 纯空白条目仍走「为空」分支，不误报为「含空白」
		const blankOnly = validateNetworkProxyConfig(validConfig({ rules: [" "] }));
		expect(blankOnly.ok).toBe(false);
		if (!blankOnly.ok) {
			expect(blankOnly.errors[0]).toContain("第 1 条为空");
		}
	});

	it("对象性守卫：null / 数组 / 标量返回错误信封而非抛异常", () => {
		for (const bad of [null, [validConfig()], "config", 42]) {
			const result = validateNetworkProxyConfig(bad);
			expect(result.ok).toBe(false);
		}
	});
});

describe("normalizeNetworkProxyConfig（读取路径校验闸）", () => {
	it("合法 raw 原样返回", () => {
		const config = validConfig();
		expect(normalizeNetworkProxyConfig(config)).toEqual(config);
	});

	it("非法 raw throw 且消息含逐项错误（loadConfig 捕获后回落 defaults + onWarning）", () => {
		expect(() =>
			normalizeNetworkProxyConfig(validConfig({
				proxy: { protocol: "http", host: "127.0.0.1", port: 70000, username: "", password: "" },
			})),
		).toThrow(/1-65535/);
	});
});

describe("networkProxyFingerprint（指纹比对）", () => {
	it("同配置同指纹", () => {
		expect(networkProxyFingerprint(validConfig())).toBe(networkProxyFingerprint(validConfig()));
	});

	it("enabled 翻转 / proxy 变更 / noProxy 变更 / rules 变更各自产生不同指纹", () => {
		const base = networkProxyFingerprint(validConfig());
		expect(networkProxyFingerprint(validConfig({ enabled: false }))).not.toBe(base);
		expect(networkProxyFingerprint(validConfig({
			proxy: { protocol: "http", host: "10.0.0.1", port: 7890, username: "", password: "" },
		}))).not.toBe(base);
		expect(networkProxyFingerprint(validConfig({ noProxy: ["localhost", "internal.test"] }))).not.toBe(base);
		expect(networkProxyFingerprint(validConfig({ rules: ["api.openai.com"] }))).not.toBe(base);
	});

	it("重复条目不影响指纹（去重语义——匹配幂等，重建判据不受条目重复干扰）", () => {
		expect(networkProxyFingerprint(validConfig({ rules: ["a.test", "a.test"] }))).toBe(
			networkProxyFingerprint(validConfig({ rules: ["a.test"] })),
		);
	});
});

describe("loadNetworkProxyConfig（llm-shared 读时刷新热重载）", () => {
	it("文件缺失回落 defaults", () => {
		expect(loadNetworkProxyConfig()).toEqual(DEFAULT_NETWORK_PROXY_CONFIG);
	});

	it("合法文件返回配置；改文件后同进程重读即时生效（热重载）", () => {
		writeConfigFile(validConfig());
		expect(loadNetworkProxyConfig()?.enabled).toBe(true);

		writeConfigFile(validConfig({ enabled: false }));
		expect(loadNetworkProxyConfig()?.enabled).toBe(false);
	});

	it("非法文件（字段非法）回落 defaults 并经 onWarning 报错（验收场景 10 的读取侧形态）", () => {
		const warnings: string[] = [];
		writeConfigFile(validConfig({
			proxy: { protocol: "http", host: "127.0.0.1", port: 70000, username: "", password: "" },
		}));
		const config = loadNetworkProxyConfig((msg) => warnings.push(msg));
		expect(config).toEqual(DEFAULT_NETWORK_PROXY_CONFIG);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("1-65535");
	});

	it("手编文件带空白字符条目（内部空白形态）回落 defaults 并经 onWarning 报错（不再静默不生效）", () => {
		const warnings: string[] = [];
		writeConfigFile(validConfig({ noProxy: ["api. anthropic.com"] }));
		const config = loadNetworkProxyConfig((msg) => warnings.push(msg));
		expect(config).toEqual(DEFAULT_NETWORK_PROXY_CONFIG);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("含空白字符，请删除空白后保存");
	});

	it("坏 JSON 回落 defaults 并经 onWarning 报错", () => {
		const warnings: string[] = [];
		mkdirSync(join(agentDir, "config"), { recursive: true });
		writeFileSync(join(agentDir, "config", "network-proxy-ext-config.json"), "{not json", "utf-8");
		const config = loadNetworkProxyConfig((msg) => warnings.push(msg));
		expect(config).toEqual(DEFAULT_NETWORK_PROXY_CONFIG);
		expect(warnings).toHaveLength(1);
	});
});
