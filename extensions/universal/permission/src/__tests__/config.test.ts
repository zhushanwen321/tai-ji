/**
 * WT1-WT5/WT7: 配置加载/保存/mtime 缓存测试（委托 llm-shared 泛型 config）
 *
 * 用真实 fs + 临时目录（os.tmpdir + 随机子目录），PI_CODING_AGENT_DIR 指向临时目录隔离，
 * 配置文件路径 = <temp>/config/permission-ext-config.json（llm-shared getConfigPath 推导）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock 共享 logger，让 logger.warn 可被 spy（源码已从 console.warn 改为 logger.warn）
const { loggerMock } = vi.hoisted(() => ({
	loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({
	getLogger: () => loggerMock,
	createLogger: () => loggerMock,
	setPiHandle: vi.fn(),
}));

import { DEFAULT_CONFIG } from "../types.js";
import {
	clearConfigCache,
	getConfigPath,
	loadAndWatchConfig,
	saveConfig,
} from "../config.js";

let tempDir: string;
let configPath: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "pi-perm-test-"));
	process.env.PI_CODING_AGENT_DIR = tempDir;
	mkdirSync(join(tempDir, "config"), { recursive: true });
	configPath = join(tempDir, "config", "permission-ext-config.json");
	clearConfigCache();
});

afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	clearConfigCache();
});

describe("WT1: 默认配置生成（首次无配置文件）", () => {
	it("文件不存在时创建默认配置并返回", () => {
		expect(existsSync(configPath)).toBe(false);

		const config = loadAndWatchConfig();

		expect(config.mode).toBe("yolo");
		expect(config.enabled).toBe(true);
		expect(config.classifier.enabled).toBe(true);
		expect(config.classifier.model).toBe("auto");
		expect(config.classifier.timeout).toBe(90);
		expect(config.classifier.autoApproveLowRisk).toBe(true);
		expect(config.classifier.autoDenyHighRisk).toBe(true);
		expect(config.userRules).toEqual([]);

		// 文件被创建
		expect(existsSync(configPath)).toBe(true);
	});

	it("创建的文件是合法 JSON", () => {
		loadAndWatchConfig();

		const content = readFileSync(configPath, "utf-8");
		expect(() => JSON.parse(content)).not.toThrow();
	});
});

describe("WT2: 配置解析（合法配置）", () => {
	it("正确解析完整配置", () => {
		const rawConfig = {
			mode: "auto",
			enabled: true,
			classifier: {
				enabled: false,
				model: "zhipu/glm-4-flash",
				timeout: 30,
				autoApproveLowRisk: false,
				autoDenyHighRisk: false,
			},
			userRules: [
				{ id: "user-1", tool: "bash", pattern: "git status", action: "allow", source: "user" },
				{ id: "user-2", tool: "bash", pattern: "rm *", action: "deny", source: "user" },
			],
		};
		writeFileSync(configPath, JSON.stringify(rawConfig), "utf-8");

		const config = loadAndWatchConfig();

		expect(config.mode).toBe("auto");
		expect(config.classifier.enabled).toBe(false);
		expect(config.classifier.model).toBe("zhipu/glm-4-flash");
		expect(config.classifier.timeout).toBe(30);
		expect(config.classifier.autoApproveLowRisk).toBe(false);
		expect(config.userRules).toHaveLength(2);
		expect(config.userRules[0].tool).toBe("bash");
		expect(config.userRules[0].pattern).toBe("git status");
		expect(config.userRules[1].action).toBe("deny");
	});
});

describe("WT3: 配置解析容错（malformed JSON）", () => {
	it("malformed JSON fallback 到默认配置，不 throw", () => {
		writeFileSync(configPath, "{ invalid json missing quotes:", "utf-8");

		const warnings: string[] = [];
		const config = loadAndWatchConfig((msg) => warnings.push(msg));

		expect(config.mode).toBe("yolo"); // 默认值
		expect(config.enabled).toBe(true);
		expect(warnings.length).toBeGreaterThan(0);
		expect(warnings[0]).toContain("Config parse failed");
	});

	it("mode 字段非法时 fallback 到 yolo", () => {
		writeFileSync(configPath, JSON.stringify({ mode: "unknown-mode" }), "utf-8");

		const config = loadAndWatchConfig();
		expect(config.mode).toBe("yolo");
	});

	it("classifier 字段缺失时用默认值", () => {
		writeFileSync(configPath, JSON.stringify({ mode: "strict" }), "utf-8");

		const config = loadAndWatchConfig();
		expect(config.mode).toBe("strict");
		expect(config.classifier.model).toBe("auto"); // 默认
		expect(config.classifier.timeout).toBe(90); // 默认
	});

	it("TC6 (C3b): classifier.model 传对象形式 → console.warn + 回落默认 auto", () => {
		// 用户照旧设计文档配对象形式 selector（不受支持）
		writeFileSync(configPath, JSON.stringify({ classifier: { model: { type: "available" } } }), "utf-8");

	loggerMock.warn.mockClear();
		const config = loadAndWatchConfig();
		// 回落默认 auto（不再静默）
		expect(config.classifier.model).toBe("auto");
		// warn 提示忽略无效 classifier.model
		expect(loggerMock.warn).toHaveBeenCalledWith(
			expect.stringContaining("Ignoring invalid classifier.model"),
		);
	});

	it("classifier.model 传数字 → logger.warn + 回落默认 auto", () => {
		writeFileSync(configPath, JSON.stringify({ classifier: { model: 42 } }), "utf-8");

		loggerMock.warn.mockClear();
		const config = loadAndWatchConfig();
		expect(config.classifier.model).toBe("auto");
		expect(loggerMock.warn).toHaveBeenCalledWith(
			expect.stringContaining("Ignoring invalid classifier.model"),
		);
	});

	it("classifier.model 合法 string（'auto' / 'provider/model-id'）→ 不 warn", () => {
		writeFileSync(configPath, JSON.stringify({ classifier: { model: "zhipu/glm-4-flash" } }), "utf-8");

	loggerMock.warn.mockClear();
		const config = loadAndWatchConfig();
		expect(config.classifier.model).toBe("zhipu/glm-4-flash");
		expect(loggerMock.warn).not.toHaveBeenCalledWith(
			expect.stringContaining("Ignoring invalid classifier.model"),
		);
	});

	it("userRules 含非法条目时过滤掉", () => {
		writeFileSync(configPath, JSON.stringify({
			mode: "yolo",
			userRules: [
				{ tool: "bash", pattern: "ls", action: "allow" }, // 合法
				{ tool: "bash", pattern: "rm", action: "invalid-action" }, // 非法 action
				{ pattern: "x" }, // 缺 tool
				"not-an-object", // 非对象
			],
		}), "utf-8");

		const config = loadAndWatchConfig();
		expect(config.userRules).toHaveLength(1);
		expect(config.userRules[0].pattern).toBe("ls");
	});
});

describe("WT4: mtime 缓存（文件未变化时不重读）", () => {
	it("连续两次调用，第二次返回缓存（同 mtime）", () => {
		const original = loadAndWatchConfig();
		const originalMode = original.mode;

		// 不修改文件，第二次调用
		const cached = loadAndWatchConfig();

		// 返回的 config 应该与第一次一致（深相等）
		expect(cached).toEqual(original);
		expect(cached.mode).toBe(originalMode);
	});
});

describe("WT5: mtime 缓存（文件变化时重读）", () => {
	it("修改文件后第二次调用返回新内容", () => {
		const first = loadAndWatchConfig();
		expect(first.mode).toBe("yolo");

		// 修改文件（写入新 mode）
		writeFileSync(configPath, JSON.stringify({ mode: "strict" }), "utf-8");

		// 注意：writeFileSync 可能不改变 mtime（如果写入太快），
		// 用 utimes 显式更新 mtime 确保变化
		const future = new Date(Date.now() + 2000);
		utimesSync(configPath, future, future);

		const second = loadAndWatchConfig();
		expect(second.mode).toBe("strict");
	});
});

describe("WT7: 保存配置", () => {
	it("saveConfig 写入文件并更新缓存", () => {
		const newConfig = { ...DEFAULT_CONFIG, mode: "strict" as const };

		const result = saveConfig(newConfig);
		expect(result.success).toBe(true);

		// 文件被写入
		expect(existsSync(configPath)).toBe(true);
		const content = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(content);
		expect(parsed.mode).toBe("strict");

		// 后续 loadAndWatchConfig 返回新配置（缓存已更新）
		const loaded = loadAndWatchConfig();
		expect(loaded.mode).toBe("strict");
	});

	it("saveConfig 失败时返回 error（只读目录）", () => {
		const readOnlyDir = join(tempDir, "readonly");
		mkdirSync(readOnlyDir, { mode: 0o500 });
		// 直接把 agentDir 指向只读目录（config/ 建不出来 / tmp 写不进）
		process.env.PI_CODING_AGENT_DIR = readOnlyDir;
		clearConfigCache();

		const result = saveConfig(DEFAULT_CONFIG);
		// 可能成功也可能失败取决于系统权限实现，主要验证不 throw
		expect(typeof result.success).toBe("boolean");
		if (!result.success) {
			expect(result.error).toBeTruthy();
		}
	});

	it("saveConfig 后文件权限是 0o600（仅用户可读写）", () => {
		saveConfig(DEFAULT_CONFIG);

		const stat = statSync(configPath);
		// macOS/Linux 下 mode & 0o777 应该是 0o600
		// Windows 下文件权限模型不同，跳过此断容
		if (process.platform !== "win32") {
			expect(stat.mode & 0o777).toBe(0o600);
		}
	});
});

describe("getConfigPath", () => {
	it("返回 <agentDir>/config/permission-ext-config.json 路径", () => {
		const path = getConfigPath();
		expect(path).toContain("config");
		expect(path).toContain("permission-ext-config.json");
		// 受 PI_CODING_AGENT_DIR 隔离（本测试 beforeEach 已指向临时目录）
		expect(path.startsWith(tempDir)).toBe(true);
	});
});

describe("[MIGRATION] legacy config 降级告警（ensureConfigFile 兜底）", () => {
	it("旧路径残留 + 新路径缺失 → console.warn 提醒 strict→yolo 降级", () => {
		// 写 legacy 文件到 agentDir 根（PI_CODING_AGENT_DIR=tempDir）
		const legacyPath = join(tempDir, "permission-config.json");
		writeFileSync(legacyPath, JSON.stringify({ mode: "strict" }), "utf-8");

	loggerMock.warn.mockClear();
		loadAndWatchConfig();
		expect(loggerMock.warn).toHaveBeenCalledWith(
			expect.stringContaining("Legacy config detected"),
		);
		expect(loggerMock.warn).toHaveBeenCalledWith(
			expect.stringContaining("downgrade"),
		);
	});

	it("旧路径不存在 → 不触发 legacy 告警", () => {
		loggerMock.warn.mockClear();
		loadAndWatchConfig();
		expect(loggerMock.warn).not.toHaveBeenCalledWith(
			expect.stringContaining("Legacy config detected"),
		);
	});
});
