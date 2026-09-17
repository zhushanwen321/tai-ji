import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearConfigCache, getConfigPath } from "@zhushanwen/pi-llm-shared";

import {
	DEFAULT_RENAME_CONFIG,
	cleanTitle,
	countSuccessfulAssistantReplies,
	countUserMessages,
	loadRenameConfig,
	normalizeRenameConfig,
	saveRenameConfig,
	setAutoRenameSwitch,
} from "../pure.js";

// ────────────────────────────────────────────────────
// countSuccessfulAssistantReplies（触发判定用的成功-turn 计数）
// ────────────────────────────────────────────────────

describe("countSuccessfulAssistantReplies", () => {
	it("TC-S1: 混合 stopReason（stop×1/toolUse/error/length/user/compaction）→ 只数 stop 的 assistant，返回 1", () => {
		const entries = [
			{ type: "message", message: { role: "user" } },
			{ type: "message", message: { role: "assistant", stopReason: "toolUse" } },
			{ type: "message", message: { role: "assistant", stopReason: "error" } },
			{ type: "message", message: { role: "assistant", stopReason: "length" } },
			{ type: "message", message: { role: "assistant", stopReason: "stop" } },
			{ type: "compaction" },
		];
		expect(countSuccessfulAssistantReplies(entries)).toBe(1);
	});

	it("TC-S2: 工具型首轮（多 toolUse + 最终 1 stop）→ 1（轮末最终 iteration 才触发）", () => {
		const entries = [
			{ type: "message", message: { role: "user" } },
			{ type: "message", message: { role: "assistant", stopReason: "toolUse" } },
			{ type: "message", message: { role: "assistant", stopReason: "toolUse" } },
			{ type: "message", message: { role: "assistant", stopReason: "stop" } },
		];
		expect(countSuccessfulAssistantReplies(entries)).toBe(1);
	});

	it("TC-S3: 仅 error 轮 → 0（error 轮不命名，延迟到下一成功轮）", () => {
		const entries = [
			{ type: "message", message: { role: "user" } },
			{ type: "message", message: { role: "assistant", stopReason: "error" } },
		];
		expect(countSuccessfulAssistantReplies(entries)).toBe(0);
	});

	it("TC-S4: 2 个 stop（已有成功轮后的新 session round）→ 2（不再触发）", () => {
		const entries = [
			{ type: "message", message: { role: "user" } },
			{ type: "message", message: { role: "assistant", stopReason: "stop" } },
			{ type: "message", message: { role: "user" } },
			{ type: "message", message: { role: "assistant", stopReason: "stop" } },
		];
		expect(countSuccessfulAssistantReplies(entries)).toBe(2);
	});

	it("TC-S5: assistant 无 stopReason 字段 → 不计（只认显式 stop，宽松数据不误触发）", () => {
		const entries = [
			{ type: "message", message: { role: "user" } },
			{ type: "message", message: { role: "assistant" } },
		];
		expect(countSuccessfulAssistantReplies(entries)).toBe(0);
	});
});

// ────────────────────────────────────────────────────
// countUserMessages（first-prompt 模式首条判定——message_end(user) handler 内
// entries 计数 === 0 ⇔ 本条即 session 首条 user，探针 P1 实测该时点 entries 不含本条）
// ────────────────────────────────────────────────────

describe("countUserMessages", () => {
	it("TC-D2-1: 空 entries（session 刚创建，本条 user 尚未 append）→ 0（first-prompt 触发态）", () => {
		expect(countUserMessages([])).toBe(0);
	});

	it("TC-D2-2: 含非 user entry（session_info / compaction / assistant）但无 user → 0（探针 P1 实测形态）", () => {
		const entries = [
			{ type: "session_info", data: {} },
			{ type: "message", message: { role: "assistant", stopReason: "stop" } },
			{ type: "compaction" },
		];
		expect(countUserMessages(entries)).toBe(0);
	});

	it("TC-D2-3: 首条 user 已 append（本条之后到达的 message_end 视角）→ 1（不再触发）", () => {
		const entries = [
			{ type: "message", message: { role: "user", content: "首条" } },
			{ type: "message", message: { role: "assistant", stopReason: "stop" } },
		];
		expect(countUserMessages(entries)).toBe(1);
	});

	it("TC-D2-4: 多 user 混排（steering/多轮）→ 只数 user，计数 ≥2 不触发", () => {
		const entries = [
			{ type: "message", message: { role: "user", content: "第一条" } },
			{ type: "message", message: { role: "user", content: "第二条" } },
			{ type: "message", message: { role: "assistant", stopReason: "stop" } },
			{ type: "message", message: { role: "user", content: "第三条" } },
		];
		expect(countUserMessages(entries)).toBe(3);
	});

	it("TC-D2-5: message entry 缺 message 字段 / role 缺失 → 不计（宽松数据不误触发）", () => {
		const entries = [{ type: "message" }, { type: "message", message: {} }];
		expect(countUserMessages(entries)).toBe(0);
	});
});

// ────────────────────────────────────────────────────
// cleanTitle（收口自旧 extractTitle，输入改为 string：callLLM 已 extractText+trim）
// ────────────────────────────────────────────────────

describe("cleanTitle", () => {
	it("trim 首尾空白 → '修复登录 bug'", () => {
		expect(cleanTitle("  修复登录 bug  \n", 50)).toBe("修复登录 bug");
	});

	it("去引号 + markdown 强调 → '重构 API 层'", () => {
		expect(cleanTitle('"**重构 API 层**"', 50)).toBe("重构 API 层");
	});

	it("去中文引号 → '标题'", () => {
		expect(cleanTitle("“标题”", 50)).toBe("标题");
	});

	it("超长文本截断到 maxLength 码点", () => {
		const long = "这是一个非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常长的标题".repeat(3);
		const result = cleanTitle(long, 50);
		expect(Array.from(result).length).toBe(50);
	});

	it("空串 → ''", () => {
		expect(cleanTitle("", 50)).toBe("");
	});

	it("纯空白 → ''", () => {
		expect(cleanTitle("   \n\t  ", 50)).toBe("");
	});

	it("仅引号/markdown → ''（去完为空）", () => {
		expect(cleanTitle('""**``', 50)).toBe("");
	});

	it("maxLength 小于标题长度 → 截断", () => {
		expect(Array.from(cleanTitle("abcdefghij", 5)).length).toBe(5);
	});

	it("标题长度等于 maxLength → 原样", () => {
		expect(cleanTitle("abcde", 5)).toBe("abcde");
	});

	// ── B1: 内部空白归一化（多行标题不破坏 UI 渲染） ──

	it("B1: 多行标题（含 \n）→ 换行压成单空格", () => {
		expect(cleanTitle("重构API层\n更新文档", 50)).toBe("重构API层 更新文档");
	});

	it("B1: 混合空白（\r\n\t 多个）→ 全部压成单空格", () => {
		expect(cleanTitle("重构\tAPI\r\n层  更新", 50)).toBe("重构 API 层 更新");
	});

	it("B1: 首尾空白仍被 trim（归一化不影响首尾裁剪）", () => {
		expect(cleanTitle("  \n修复登录 bug\n  ", 50)).toBe("修复登录 bug");
	});

	// ── 尾部标点清理（slug 风格配套：标题不带句尾标点，LLM 漏遵从时兜底） ──

	it("尾部中文句号清除 → '修复登录超时'", () => {
		expect(cleanTitle("修复登录超时。", 50)).toBe("修复登录超时");
	});

	it("尾部英文逗号清除 → 'refactor-loader'", () => {
		expect(cleanTitle("refactor-loader,", 50)).toBe("refactor-loader");
	});

	it("尾部感叹号清除（中间全角冒号保留）→ '重构：配置'", () => {
		expect(cleanTitle("重构：配置！", 50)).toBe("重构：配置");
	});

	it("中间标点保留（version 号的点不在首尾）→ 'v1.2.3'", () => {
		expect(cleanTitle("v1.2.3", 50)).toBe("v1.2.3");
	});

	it("尾部标点+引号连排一次清干净 → '修复登录超时'", () => {
		expect(cleanTitle('修复登录超时。”"', 50)).toBe("修复登录超时");
	});

	it("全尾部标点标题 → ''（清完为空）", () => {
		expect(cleanTitle("。。。", 50)).toBe("");
	});

	it("尾部标点后随空白 → 标点清除后 trim 仍干净 → '重构配置'", () => {
		expect(cleanTitle("重构配置。 ", 50)).toBe("重构配置");
	});
});

// ────────────────────────────────────────────────────
// DEFAULT_RENAME_CONFIG
// ────────────────────────────────────────────────────

describe("DEFAULT_RENAME_CONFIG", () => {
	it("默认值：enabled=false / model=空 ref / mode=first-stop / maxTitleLength=50 / thinkingLevel=off", () => {
		expect(DEFAULT_RENAME_CONFIG.enabled).toBe(false);
		expect(DEFAULT_RENAME_CONFIG.model).toEqual({ type: "ref", ref: "" });
		expect(DEFAULT_RENAME_CONFIG.mode).toBe("first-stop");
		expect(DEFAULT_RENAME_CONFIG.maxTitleLength).toBe(50);
		expect(DEFAULT_RENAME_CONFIG.thinkingLevel).toBe("off");
	});
});

// ────────────────────────────────────────────────────
// normalizeRenameConfig
// ────────────────────────────────────────────────────

describe("normalizeRenameConfig", () => {
	it("非对象（string/null/array）→ 全默认", () => {
		expect(normalizeRenameConfig("x")).toEqual(DEFAULT_RENAME_CONFIG);
		expect(normalizeRenameConfig(null)).toEqual(DEFAULT_RENAME_CONFIG);
		expect(normalizeRenameConfig([])).toEqual(DEFAULT_RENAME_CONFIG);
	});

	it("空对象 → 全默认", () => {
		expect(normalizeRenameConfig({})).toEqual(DEFAULT_RENAME_CONFIG);
	});

	it("合法完整配置 → 原样返回", () => {
		const cfg = {
			enabled: true,
			model: { type: "ref", ref: "deepseek/chat" },
			mode: "first-prompt",
			maxTitleLength: 30,
			thinkingLevel: "high",
		};
		expect(normalizeRenameConfig(cfg)).toEqual(cfg);
	});

	// ── mode 三值枚举（normalize 逐字段校验回默认） ──

	it("mode 三个合法值（first-prompt/first-stop/agent-tool）→ 原样保留", () => {
		for (const mode of ["first-prompt", "first-stop", "agent-tool"] as const) {
			expect(normalizeRenameConfig({ mode }).mode).toBe(mode);
		}
	});

	it("TC-D1-1: 旧 config 无 mode 字段 → first-stop（零迁移，现状行为）", () => {
		const r = normalizeRenameConfig({ enabled: true, maxTitleLength: 30 });
		expect(r.mode).toBe("first-stop");
	});

	it("TC-D1-2: mode 非法值（未知字符串 / 非字符串 / null）→ first-stop，其余字段不受影响（粒度容错）", () => {
		expect(normalizeRenameConfig({ mode: "always" }).mode).toBe("first-stop");
		expect(normalizeRenameConfig({ mode: 42 }).mode).toBe("first-stop");
		expect(normalizeRenameConfig({ mode: null }).mode).toBe("first-stop");
		const r = normalizeRenameConfig({ mode: "always", enabled: true, maxTitleLength: 20 });
		expect(r).toEqual({
			enabled: true,
			model: { type: "ref", ref: "" },
			mode: "first-stop",
			maxTitleLength: 20,
			thinkingLevel: "off",
		});
	});

	it("enabled 非 boolean → 回默认 false，但合法 ref 仍保留", () => {
		const r = normalizeRenameConfig({ enabled: "yes", model: { type: "ref", ref: "a/b" } });
		expect(r.enabled).toBe(false);
		expect(r.model).toEqual({ type: "ref", ref: "a/b" });
	});

	it("maxTitleLength 非正整数 → 回默认 50", () => {
		expect(normalizeRenameConfig({ maxTitleLength: 0 }).maxTitleLength).toBe(50);
		expect(normalizeRenameConfig({ maxTitleLength: -5 }).maxTitleLength).toBe(50);
		expect(normalizeRenameConfig({ maxTitleLength: 1.5 }).maxTitleLength).toBe(50);
		expect(normalizeRenameConfig({ maxTitleLength: "x" }).maxTitleLength).toBe(50);
	});

	it("model 非法（未知 type / 非 object / 非 ref 形式）→ 回默认空 ref", () => {
		expect(normalizeRenameConfig({ model: { type: "unknown" } }).model).toEqual({ type: "ref", ref: "" });
		expect(normalizeRenameConfig({ model: "scoped" }).model).toEqual({ type: "ref", ref: "" });
		expect(normalizeRenameConfig({ model: { type: "available" } }).model).toEqual({ type: "ref", ref: "" });
		expect(normalizeRenameConfig({ model: { type: "scoped" } }).model).toEqual({ type: "ref", ref: "" });
		expect(normalizeRenameConfig({ model: { type: "fallback", refs: ["a/b"] } }).model).toEqual({ type: "ref", ref: "" });
	});

	it("model ref 缺 ref 字段 / ref 非 string → 回默认空 ref", () => {
		expect(normalizeRenameConfig({ model: { type: "ref" } }).model).toEqual({ type: "ref", ref: "" });
		expect(normalizeRenameConfig({ model: { type: "ref", ref: 123 } }).model).toEqual({ type: "ref", ref: "" });
	});

	it("thinkingLevel 合法值（minimal/max/off）→ 保留", () => {
		expect(normalizeRenameConfig({ thinkingLevel: "minimal" }).thinkingLevel).toBe("minimal");
		expect(normalizeRenameConfig({ thinkingLevel: "max" }).thinkingLevel).toBe("max");
		expect(normalizeRenameConfig({ thinkingLevel: "off" }).thinkingLevel).toBe("off");
	});

	it("thinkingLevel 非法（未知值 / 非字符串）→ 回默认 off", () => {
		expect(normalizeRenameConfig({ thinkingLevel: "ultra" }).thinkingLevel).toBe("off");
		expect(normalizeRenameConfig({ thinkingLevel: 5 }).thinkingLevel).toBe("off");
		expect(normalizeRenameConfig({ thinkingLevel: null }).thinkingLevel).toBe("off");
		// 缺失字段 → 默认 off（旧配置文件兼容：无 thinkingLevel 字段的存量配置自动回填）
		expect(normalizeRenameConfig({ enabled: true }).thinkingLevel).toBe("off");
	});

	it("model 只支持 ref 精确指定；合法 ref 原样返回", () => {
		expect(normalizeRenameConfig({ model: { type: "ref", ref: "a/b" } }).model).toEqual({
			type: "ref",
			ref: "a/b",
		});
	});

	it("粒度容错：enabled 坏但 model/maxTitleLength 合法时各自独立处理", () => {
		const r = normalizeRenameConfig({
			enabled: "bad",
			model: { type: "ref", ref: "a/b" },
			maxTitleLength: 20,
		});
		expect(r).toEqual({
			enabled: false,
			model: { type: "ref", ref: "a/b" },
			mode: "first-stop",
			maxTitleLength: 20,
			thinkingLevel: "off",
		});
	});
});

// ────────────────────────────────────────────────────
// env 覆盖层删除负面（PI_RENAME_* 四键已删，预置变量不得有任何幽灵效果）
// ────────────────────────────────────────────────────

describe("env 覆盖层删除负面（PI_RENAME_* 无效果）", () => {
	let tmpAgentDir: string;
	let origEnv: string | undefined;

	beforeEach(() => {
		tmpAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "rename-envneg-"));
		origEnv = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
		clearConfigCache();

		// 预置全部四个已删除的 env 键（壳内残留场景）
		vi.stubEnv("PI_RENAME_ENABLED", "true");
		vi.stubEnv("PI_RENAME_MODEL", "bad/nonexistent");
		vi.stubEnv("PI_RENAME_MAX_TITLE_LENGTH", "1");
		vi.stubEnv("PI_RENAME_THINKING_LEVEL", "high");
	});

	afterEach(() => {
		if (origEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = origEnv;
		vi.unstubAllEnvs();
		clearConfigCache();
		fs.rmSync(tmpAgentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	});

	it("TC-D6-1: 预置 PI_RENAME_* 四键 → 行为与无该变量完全一致（返回默认，无覆盖）", () => {
		expect(loadRenameConfig()).toEqual(DEFAULT_RENAME_CONFIG);
	});

	it("TC-D6-2: 预置 PI_RENAME_ENABLED=false 不能压制 flag 文件（env 优先级层已不存在）", () => {
		fs.writeFileSync(path.join(tmpAgentDir, "auto-rename-enabled"), "");
		const cfg = loadRenameConfig();
		expect(cfg.enabled).toBe(true); // flag 存在即开，env 不再有更高优先级
		expect(cfg.model).toEqual({ type: "ref", ref: "" }); // PI_RENAME_MODEL=bad/x 未生效
		expect(cfg.maxTitleLength).toBe(50); // PI_RENAME_MAX_TITLE_LENGTH=1 未生效
		expect(cfg.thinkingLevel).toBe("off"); // PI_RENAME_THINKING_LEVEL=high 未生效
	});

	it("TC-D6-3: 预置 PI_RENAME_* 不覆盖配置文件值", () => {
		const cfgOnFile = {
			...DEFAULT_RENAME_CONFIG,
			enabled: false,
			model: { type: "ref", ref: "a/b" } as const,
		};
		saveRenameConfig(cfgOnFile);
		clearConfigCache();
		expect(loadRenameConfig()).toEqual(cfgOnFile); // 配置文件值原样读回
	});
});

// ────────────────────────────────────────────────────
// loadRenameConfig / saveRenameConfig（需 PI_CODING_AGENT_DIR 隔离到临时目录）
// ────────────────────────────────────────────────────

describe("loadRenameConfig / saveRenameConfig", () => {
	let tmpAgentDir: string;
	let origEnv: string | undefined;

	beforeEach(() => {
		tmpAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "rename-cfg-"));
		origEnv = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
		clearConfigCache();
	});

	afterEach(() => {
		if (origEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = origEnv;
		clearConfigCache();
		fs.rmSync(tmpAgentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	});

	it("配置路径 = <agentDir>/config/rename-session-ext-config.json（走 getAgentDir，实例隔离）", () => {
		expect(getConfigPath("rename-session")).toBe(
			path.join(tmpAgentDir, "config", "rename-session-ext-config.json"),
		);
	});

	it("文件不存在 → 返回默认配置（不抛错）", () => {
		expect(loadRenameConfig()).toEqual(DEFAULT_RENAME_CONFIG);
	});

	it("saveRenameConfig 后 loadRenameConfig 读回（跨缓存清空）", () => {
		const cfg = {
			enabled: true,
			model: { type: "ref", ref: "deepseek/chat" },
			mode: "first-prompt" as const,
			maxTitleLength: 30,
			thinkingLevel: "off",
		};
		const saveResult = saveRenameConfig(cfg);
		expect(saveResult.success).toBe(true);
		clearConfigCache();
		expect(loadRenameConfig()).toEqual(cfg);
	});

	it("saveRenameConfig 实际落盘到隔离目录（不写 ~/.pi/agent）", () => {
		saveRenameConfig({
			enabled: true,
			model: { type: "ref", ref: "" },
			mode: "agent-tool",
			maxTitleLength: 50,
			thinkingLevel: "off",
		});
		const filePath = path.join(tmpAgentDir, "config", "rename-session-ext-config.json");
		expect(fs.existsSync(filePath)).toBe(true);
		const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		expect(raw.enabled).toBe(true);
	});

	it("坏 JSON 文件 → 返回默认（onWarning 不阻断）", () => {
		fs.mkdirSync(path.join(tmpAgentDir, "config"), { recursive: true });
		fs.writeFileSync(path.join(tmpAgentDir, "config", "rename-session-ext-config.json"), "{ bad json");
		expect(loadRenameConfig()).toEqual(DEFAULT_RENAME_CONFIG);
	});

	it("on → off 切换 enabled 字段落盘", () => {
		saveRenameConfig({ ...DEFAULT_RENAME_CONFIG, enabled: true });
		clearConfigCache();
		expect(loadRenameConfig().enabled).toBe(true);
		saveRenameConfig({ ...DEFAULT_RENAME_CONFIG, enabled: false });
		clearConfigCache();
		expect(loadRenameConfig().enabled).toBe(false);
	});

	// ── taiji runtime 开关契约（flag live 覆盖源，见 pure.ts [COMPAT] 注释）──

	it("TC5: flag 文件存在 → enabled 强制 true（不写 config、不删 flag，live 检查）", () => {
		const flagPath = path.join(tmpAgentDir, "auto-rename-enabled");
		fs.writeFileSync(flagPath, "");

		const cfg = loadRenameConfig();

		expect(cfg.enabled).toBe(true);
		// 不做一次性迁移：不写新配置、不删 flag（旧 runtime 只认 flag，删了它 UI 就显示 OFF）
		expect(fs.existsSync(path.join(tmpAgentDir, "config", "rename-session-ext-config.json"))).toBe(false);
		expect(fs.existsSync(flagPath)).toBe(true);
	});

	it("TC6: flag 存在 + config enabled=false → flag 覆盖（runtime 开关优先于 config）", () => {
		saveRenameConfig({ ...DEFAULT_RENAME_CONFIG, enabled: false });
		fs.writeFileSync(path.join(tmpAgentDir, "auto-rename-enabled"), "");
		clearConfigCache();

		expect(loadRenameConfig().enabled).toBe(true);
	});

	it("TC6b: flag 不存在 + config enabled=true → true（pi CLI 用户 config 机制生效）", () => {
		saveRenameConfig({ ...DEFAULT_RENAME_CONFIG, enabled: true });
		clearConfigCache();

		expect(loadRenameConfig().enabled).toBe(true);
	});

	it("TC6c: flag 删除后（taiji SystemPage 关闭路径）→ 回落 config，且默认 false", () => {
		// 预置 flag（模拟 rt 默认开启）+ 无 config
		const flagPath = path.join(tmpAgentDir, "auto-rename-enabled");
		fs.writeFileSync(flagPath, "");
		expect(loadRenameConfig().enabled).toBe(true);

		// 旧 runtime toggle OFF = 删除 flag，不动 config → 扩展应读到 false
		fs.rmSync(flagPath);
		clearConfigCache();
		expect(loadRenameConfig().enabled).toBe(false);
	});

	it("TC7: 无 flag + 无 config → enabled 默认 false，不创建任何文件", () => {
		const cfg = loadRenameConfig();
		expect(cfg.enabled).toBe(false);
		expect(fs.existsSync(path.join(tmpAgentDir, "config", "rename-session-ext-config.json"))).toBe(false);
		expect(fs.existsSync(path.join(tmpAgentDir, "auto-rename-enabled"))).toBe(false);
	});

	it("setAutoRenameSwitch(true/false)：创建/删除 flag 文件（/auto-rename 命令的同步机制）", () => {
		const flagPath = path.join(tmpAgentDir, "auto-rename-enabled");
		setAutoRenameSwitch(true);
		expect(fs.existsSync(flagPath)).toBe(true);
		expect(loadRenameConfig().enabled).toBe(true);

		setAutoRenameSwitch(false);
		expect(fs.existsSync(flagPath)).toBe(false);
		clearConfigCache();
		expect(loadRenameConfig().enabled).toBe(false);

		// 幂等：对不存在的 flag 再关一次不抛错
		setAutoRenameSwitch(false);
	});
});
