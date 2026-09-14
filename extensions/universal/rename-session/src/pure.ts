import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

import { isEnoentError } from "@zhushanwen/pi-ext-guards";
import {
	isThinkingLevel,
	loadConfig,
	normalizeModelSelector,
	saveConfig,
	type ModelSelector,
} from "@zhushanwen/pi-llm-shared";

// ──────────────────────── 配置 ────────────────────────

/** 触发模式三值枚举（设计 rename-session-three-modes.md D1）：互斥，默认 "first-stop"（零行为迁移）。 */
export type RenameMode = "first-prompt" | "first-stop" | "agent-tool";

/**
 * rename-session 配置 schema（落盘到 `<agentDir>/config/rename-session-ext-config.json`，路径由 llm-shared 推导）。
 *
 * 收口自旧版 pure.ts 的 `RenameConfig`（switchFilePath/maxTitleLength/renameInstruction 硬编码常量）：
 * - 开关双机制：`enabled` 字段（pi CLI 用户主开关，默认 false）+ xyz-agent runtime 的
 *   auto-rename-enabled flag 文件（live 覆盖源，存在即开，见下方 [COMPAT] 契约）
 * - model 从「搭便车 ctx.model」改为独立 `ModelSelector`（仅支持 ref 精确指定；空 ref 跟随会话主模型，见 llm.ts 的空 ref fallback）
 * - maxTitleLength 保留（默认 50）
 * - renameInstruction 不进配置（i18n 留未来），由代码常量 RENAME_INSTRUCTION 承载
 * - mode（设计 rename-session-three-modes.md D1）：first-prompt 首条 user 消息触发 / first-stop 首个成功 round 末触发（默认，现状）/
 *   agent-tool 不自动生成、注册 rename_session 工具由 agent 自主改名
 */
export interface RenameSessionConfig {
	/** 自动重命名开关（默认 false）。 */
	enabled: boolean;
	/** 标题生成用的模型 selector（仅支持 ref 精确指定；未配置时默认为空 ref，空 ref 跟随会话主模型）。 */
	model: ModelSelector;
	/** 触发模式（三值互斥，默认 "first-stop"——首个成功 round 末命名，现状行为）。 */
	mode: RenameMode;
	/** 标题最大长度（Unicode 码点数）。 */
	maxTitleLength: number;
	/**
	 * 标题生成 LLM 的 thinking 级别（pi 的 ModelThinkingLevel，THINKING_ORDER SSOT）。
	 * 默认 "off"：不传 pi-ai reasoning（provider 默认行为，与旧版本一致）；
	 * "minimal"~"max" 透传给 SimpleStreamOptions.reasoning（provider 不支持时静默忽略）。
	 */
	thinkingLevel: ModelThinkingLevel;
}

// ──────────────────────── 枚举校验 ────────────────────────

/** 合法触发模式清单（与 RenameMode 一致；normalize 校验用）。Set 免 as 断言。 */
const RENAME_MODES: ReadonlySet<string> = new Set(["first-prompt", "first-stop", "agent-tool"]);

/**
 * 类型谓词：unknown 是否为合法触发模式（normalizeRenameConfig 校验用，单点断言）。
 * Set.has 运行时兜底 + 类型收窄，调用方无需再断言。
 */
function isRenameMode(raw: unknown): raw is RenameMode {
	return typeof raw === "string" && RENAME_MODES.has(raw);
}

/** 默认配置：关闭、空 ref（跟随会话主模型，见 llm.ts 的空 ref fallback）、first-stop 触发、标题上限 50、不启用 thinking。 */
export const DEFAULT_RENAME_CONFIG: RenameSessionConfig = {
	enabled: false,
	model: { type: "ref", ref: "" },
	mode: "first-stop",
	maxTitleLength: 50,
	thinkingLevel: "off",
};

/** llm-shared loadConfig/saveConfig 的包名（决定文件名 rename-session-ext-config.json，llm-shared getConfigPath 追加 -ext-config.json 后缀）。 */
const CONFIG_PKG = "rename-session";

// ──────────────────────── xyz-agent runtime 开关契约（live 覆盖源） ────────────────────────

/**
 * [COMPAT] xyz-agent runtime 开关契约文件：<agentDir>/auto-rename-enabled（存在=开，不存在=关）。
 * Added in v0.4.0. Remove after v1.0.0（旧 runtime 版本淘汰后随 flag 契约一并移除）。
 *
 * 背景：已发布的 xyz-agent runtime（worktree-config-helper.ts）只认这个 flag 文件——
 * SystemPage 开关读写它、首启 ensureAutoRenameDefault 默认创建它，且这部分代码随桌面 app
 * 发布、不随本 extension 升级。若本扩展单方面改为只读 config JSON 并在迁移时删除 flag，
 * 则 mandatory 自动升级后所有未更新桌面 app 的用户：UI 显示 OFF 而 extension 实际 ON，
 * 且 SystemPage toggle 永久失效（旧 runtime 只写 flag，新 extension 不再读）。
 *
 * 契约语义（loadRenameConfig 每次调用 live 检查，非一次性迁移）：
 * - flag 存在 → enabled 强制 true（xyz-agent runtime 的开关打开，覆盖 config.enabled）
 * - flag 不存在 → 回落 config.enabled（pi CLI 用户的主开关机制，见 config skill）
 * - 扩展永不删除/创建该文件，除非用户通过 /auto-rename on|off 显式操作（commands.ts 双写同步）
 */
const AUTO_RENAME_FLAG_FILE = "auto-rename-enabled";

/** flag 文件完整路径（getAgentDir 派生，尊重 PI_CODING_AGENT_DIR）。 */
function getAutoRenameFlagPath(): string {
	return join(getAgentDir(), AUTO_RENAME_FLAG_FILE);
}

/**
 * 设置 xyz-agent runtime 开关契约 flag（/auto-rename on|off 命令调用，与 config 双写同步）。
 * enabled=true 创建空 flag 文件；enabled=false 删除（不存在时视为成功）。best-effort 不抛错。
 */
export function setAutoRenameSwitch(enabled: boolean): void {
	const flagPath = getAutoRenameFlagPath();
	if (enabled) {
		mkdirSync(dirname(flagPath), { recursive: true });
		if (!existsSync(flagPath)) {
			writeFileSync(flagPath, "", "utf-8");
		}
	} else {
		try {
			rmSync(flagPath);
		} catch (e: unknown) {
			// flag 不存在视为已关（吞 ENOENT）；其他错误（如权限）如实抛出，不静默
			if (!isEnoentError(e)) throw e;
		}
	}
}

/**
 * 把磁盘上的 unknown JSON 归一化成 RenameSessionConfig。
 *
 * 容错策略（逐字段校验 + 默认值回填）：坏字段不影响其他字段（粒度容错），
 * 整体坏（非对象 / null / 数组）返回全默认。宁可静默回默认，不抛错阻断 rename。
 */
export function normalizeRenameConfig(raw: unknown): RenameSessionConfig {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ...DEFAULT_RENAME_CONFIG };
	}
	const obj = raw as Record<string, unknown>;

	const enabled = typeof obj.enabled === "boolean" ? obj.enabled : DEFAULT_RENAME_CONFIG.enabled;

	// mode 逐字段校验（设计 rename-session-three-modes.md D1）：旧 config 无字段 / 非法值 → 默认 first-stop（零迁移，现状行为）
	const mode = isRenameMode(obj.mode) ? obj.mode : DEFAULT_RENAME_CONFIG.mode;

	const maxTitleLength =
		typeof obj.maxTitleLength === "number" &&
		Number.isInteger(obj.maxTitleLength) &&
		obj.maxTitleLength > 0
			? obj.maxTitleLength
			: DEFAULT_RENAME_CONFIG.maxTitleLength;

	// normalizeModelSelector：llm-shared 导出（ext-simplify-17 D6 收口）
	const model = normalizeModelSelector(obj.model) ?? DEFAULT_RENAME_CONFIG.model;

	const thinkingLevel = isThinkingLevel(obj.thinkingLevel)
		? obj.thinkingLevel
		: DEFAULT_RENAME_CONFIG.thinkingLevel;

	return { enabled, model, mode, maxTitleLength, thinkingLevel };
}

/**
 * 加载配置（mtime+size 缓存；文件缺失/损坏返回默认，不抛错）。
 *
 * 配置值优先级（从高到低）：
 * 1. xyz-agent runtime 开关契约（flag 文件存在 → enabled=true）
 * 2. 配置文件（<agentDir>/config/rename-session-ext-config.json）
 * 3. 默认值
 *
 * [HISTORICAL] 原 env 覆盖层（`PI_` + 包名前缀四键，最高优先级）已删（设计 rename-session-three-modes.md D6，吸收 ext-simplify-15 D1）：
 * 全仓 0 生产 setter、4 键中 3 键从未被用过，唯一用法是 1 个历史验收场景。预置该前缀的
 * 环境变量不再有任何效果（幽灵负面场景见设计 rename-session-three-modes.md V8，负面用例在 pure.test.ts）。
 */
export function loadRenameConfig(): RenameSessionConfig {
	// 1. 从配置文件加载基础配置（带 mtime+size 缓存）
	const fileConfig = loadConfig(CONFIG_PKG, DEFAULT_RENAME_CONFIG, normalizeRenameConfig);

	// 2. xyz-agent runtime 开关契约（flag 文件存在 → enabled 强制 true，覆盖 config）
	if (existsSync(getAutoRenameFlagPath())) {
		return { ...fileConfig, enabled: true };
	}

	return fileConfig;
}

/** 保存配置（原子写 tmp+rename）。返回 {success, error?}。 */
export function saveRenameConfig(
	config: RenameSessionConfig,
): { success: boolean; error?: string } {
	return saveConfig(CONFIG_PKG, config);
}

// ──────────────────────── 首 turn / 首 prompt 判定 ────────────────────────

/**
 * 数 session entries 中的 user message 条数（first-prompt 模式首条判定用，设计 rename-session-three-modes.md D2）。
 *
 * 调用时点契约：pi 的 extension handler 先于该条 message 的 entries append 执行
 * （agent-session.js `_emitExtensionEvent` 先于 `appendMessage`，探针 P1 已实测），
 * 故 message_end(role=user) handler 内计数 === 0 ⇔ 本条即 session 首条 user
 * （此后任何 user message_end 到达时首条已入 entries，计数 ≥ 1，天然不重复触发）。
 */
export function countUserMessages(entries: ReadonlyArray<EntryLike>): number {
	let count = 0;
	for (const entry of entries) {
		if (entry.type === "message" && entry.message?.role === "user") {
			count++;
		}
	}
	return count;
}

/** entry 的宽松类型（structural typing，兼容 pi 的 SessionEntry[] 但不依赖 pi 类型）。 */
interface EntryLike {
	type: string;
	message?: { role?: string; stopReason?: string };
}

/**
 * 数 session 中「成功完成」的 assistant 回复数（stopReason === "stop"），触发判定用（===1 触发 rename）。
 *
 * 只数 stop 的理由：pi 的 turn_end 每个 iteration 发一次，中间 iteration 的
 * stopReason 是 toolUse；error/aborted 轮的错误上下文不该用来命名（延迟到下一个成功轮）；
 * length（输出被 max token 截断）截断文本质量无保证，与 error 同等对待。
 * 无 stopReason 字段的宽松数据不计（只认显式 stop，防误触发）。
 */
export function countSuccessfulAssistantReplies(entries: ReadonlyArray<EntryLike>): number {
	let count = 0;
	for (const entry of entries) {
		if (
			entry.type === "message" &&
			entry.message?.role === "assistant" &&
			entry.message.stopReason === "stop"
		) {
			count++;
		}
	}
	return count;
}

// ──────────────────────── 标题清洗 ────────────────────────

/**
 * 按 Unicode 码点截断（ext-simplify-17 D13：收口包内三处同构 `Array.from` 骨架——
 * cleanTitle / truncateForTitle / previewText，三处差异全部参数化）。
 *
 * Array.from 按码点切分，星面字符（emoji 等，占 2 个 UTF-16 码元）不会被劈成半个代理对。
 * 码点数 ≤ max（含恰好等于）原样返回；超长返回「前 head 码点 + tail + 原文最后 keepTail 码点」。
 *
 * @param max 判定阈值：码点数 ≤ max 原样返回（与 head 独立——previewText 的 300/200/100 是
 *   15 号 §6.4 D4 裁决的三个独立契约数字，不得由 head+keepTail 推导）
 * @param tail 超长时追加在 head 段后的字面中缀（如 "…"；单段形态传 ""）
 * @param head 超长时保留的头部码点数（默认 = max，单段形态下阈值即截断长度）
 * @param keepTail 超长时保留的原文尾部码点数（默认 0 = 单段形态；双段形态的调用方
 *   自负 head/keepTail 不重叠——本包内 previewText 的 300/200/100 在超长区间恒不重叠）
 */
export function truncateCodePoints(
	text: string,
	max: number,
	tail: string,
	head = max,
	keepTail = 0,
): string {
	const chars = Array.from(text);
	if (chars.length <= max) return text;
	return (
		chars.slice(0, head).join("") +
		tail +
		(keepTail > 0 ? chars.slice(-keepTail).join("") : "")
	);
}

/**
 * rename 专属后处理：去首尾成对引号（单/双/中文）+ markdown 强调标记（* ** ` _）+ 尾部标点，按 Unicode 码点截断。
 *
 * 输入是 callLLM 已 extractText+trim 的 string（llm-shared/call.ts 的 extractText 负责从
 * AssistantMessage.content 提取 text block 拼接并 trim）。本函数只做 rename 特有的包装清理，
 * 是旧版 extractTitle（从 resp.content 提取）的收口后形态。
 */
export function cleanTitle(content: string, maxLength: number): string {
	const trimmed = content.trim();
	if (!trimmed) return "";

	// B1: 归一化内部空白——把所有连续空白（含 \n / \r / \t）压成单空格，
	// 避免 LLM 返回多行标题（如 "重构API层\n更新文档"）原样落库破坏 UI 标题/列表渲染
	const normalized = trimmed.replace(/\s+/g, " ");

	// 去首部引号/markdown 标记 + 尾部引号/markdown/标点（。．.，,、;；!！?？：:）。
	// 尾部标点是 slug 风格约束的兜底（prompt 已约束「不要句尾标点」，LLM 漏遵从时在此清除）；
	// 只清首尾——中间标点保留（如 version 号 'v1.2.3' 中间的点）。
	const cleaned = normalized
		.replace(/^["“”'`*_]+|["“”'`*_。．.，,、;；!！?？：:]+$/g, "")
		.trim();
	if (!cleaned) return "";

	// 按 Unicode 码点截断（避免截断多字节字符；无尾部后缀的单段形态）
	return truncateCodePoints(cleaned, maxLength, "");
}
