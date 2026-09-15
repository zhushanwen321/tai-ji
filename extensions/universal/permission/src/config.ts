/**
 * 配置加载 / 保存（委托 llm-shared 泛型 config）
 *
 * 对应 I6 loadAndWatchConfig。参考 pi-permission-system extension-config.ts。
 * 文件位置：<agentDir>/config/permission-ext-config.json（PI_CODING_AGENT_DIR 覆盖，llm-shared 推导）。
 *
 * [HISTORICAL] 2026-08 路径收敛 + 范式统一：
 * - 路径从 <agentDir>/permission-config.json 迁到 <agentDir>/config/permission-ext-config.json。
 *   迁移在 session_start hook 运行时完成（migrateLegacyConfig，见 src/index.ts），
 *   幂等、过渡性（Added in v1.0.0, remove after v2.0.0）；运行时不双读旧路径。
 *   ensureConfigFile 仅在旧路径残留时 warn 提醒（降级兜底，见下方）。
 * - 原实现自研 mtime+size 缓存 / 原子写 / tmp 清理，与 llm-shared 泛型 config 重复，
 *   读/写/缓存全部委托 llm-shared；本文件只保留 permission 特有行为：
 *   文件缺失时创建默认配置文件（llm-shared loadConfig 不建文件）。
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isRecord, toErrorMessage } from "@zhushanwen/pi-ext-guards";
import {
	clearConfigCache,
	getConfigPath as getLlmConfigPath,
	isThinkingLevel,
	loadConfig,
	saveConfig as saveLlmConfig,
} from "@zhushanwen/pi-llm-shared";
import { getLogger } from "@zhushanwen/pi-extension-logger";

import {
	DEFAULT_CLASSIFIER_CONFIG,
	DEFAULT_CONFIG,
	isValidPermissionMode,
	type ClassifierConfig,
	type PermissionConfig,
	type Rule,
} from "./types.js";

/** llm-shared 泛型 config 的包名（决定文件名 permission-ext-config.json，llm-shared getConfigPath 追加 -ext-config.json 后缀）。 */
const CONFIG_PKG = "permission";

const logger = getLogger("pi-permission");

// ──────────────────────── 路径解析 ────────────────────────

/** 配置文件完整路径：<agentDir>/config/permission-ext-config.json（llm-shared 推导）。 */
export function getConfigPath(): string {
	return getLlmConfigPath(CONFIG_PKG);
}

// ──────────────────────── 归一化 ────────────────────────

function normalizeClassifierConfig(raw: unknown): ClassifierConfig {
	const record = isRecord(raw) ? raw : {};
	const timeout = Number(record.timeout);
	// C3b：classifier.model 只接受 string（'auto' 或 'provider/model-id'）。对象形式（如
	// `{ "type": "available" }`）不受支持，此前会被静默忽略回落默认——现在显式 warn 消除静默。
	if (record.model !== undefined && !(typeof record.model === "string" && record.model.length > 0)) {
		logger.warn("Ignoring invalid classifier.model (expected string 'auto' or 'provider/model-id'), using default auto");
	}
	// thinkingLevel 校验：合法值为 'off'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max'
	const thinkingLevel = isThinkingLevel(record.thinkingLevel)
		? record.thinkingLevel
		: DEFAULT_CLASSIFIER_CONFIG.thinkingLevel;
	return {
		enabled: record.enabled !== false,
		model: typeof record.model === "string" && record.model.length > 0 ? record.model : DEFAULT_CLASSIFIER_CONFIG.model,
		timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_CLASSIFIER_CONFIG.timeout,
		autoApproveLowRisk: record.autoApproveLowRisk !== false,
		autoDenyHighRisk: record.autoDenyHighRisk !== false,
		thinkingLevel,
	};
}

function normalizeRule(raw: unknown, fallbackId: string): Rule | null {
	if (!isRecord(raw)) return null;
	const tool = typeof raw.tool === "string" ? raw.tool : "*";
	const pattern = typeof raw.pattern === "string" ? raw.pattern : "*";
	const action = raw.action;
	if (action !== "allow" && action !== "deny" && action !== "ask") return null;
	const source = raw.source === "user" ? "user" : raw.source === "builtin-safe" ? "builtin-safe" : raw.source === "builtin-danger" ? "builtin-danger" : "user";
	const id = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : fallbackId;
	const description = typeof raw.description === "string" ? raw.description : undefined;
	return { id, tool, pattern, action, source, ...(description !== undefined ? { description } : {}) };
}

function normalizeConfig(raw: unknown): PermissionConfig {
	const record = isRecord(raw) ? raw : {};
	const mode = isValidPermissionMode(record.mode) ? record.mode : DEFAULT_CONFIG.mode;
	const enabled = record.enabled !== false;
	const classifier = normalizeClassifierConfig(record.classifier);
	const userRulesRaw = Array.isArray(record.userRules) ? record.userRules : [];
	const userRules = userRulesRaw
		.map((r, i) => normalizeRule(r, `user-${i + 1}`))
		.filter((r): r is Rule => r !== null);
	return { mode, enabled, classifier, userRules };
}

// ──────────────────────── 默认配置文件创建 ────────────────────────

/** 默认配置文件 JSON 序列化的缩进空格数。 */
const CONFIG_JSON_INDENT_SPACES = 2;

function createDefaultConfigContent(): string {
	return `${JSON.stringify(DEFAULT_CONFIG, null, CONFIG_JSON_INDENT_SPACES)}\n`;
}

function ensureConfigFile(configPath: string, onWarning?: (msg: string) => void): void {
	if (existsSync(configPath)) return;
	// [MIGRATION] Added in v1.0.0. Remove after v2.0.0.
	// 降级兜底：旧路径残留但新路径缺失 → 迁移可能未跑（session_start hook 未触发/失败）。
	// 此时即将建 yolo 默认，用户可能从 strict/auto 意外降级，显眼 warn 提醒手动迁移。
	warnLegacyConfigIfExists();
	try {
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(configPath, createDefaultConfigContent(), { encoding: "utf-8", mode: 0o600 });
	} catch (error) {
		const message = toErrorMessage(error);
		onWarning?.(`[pi-permission] Failed to create default config at '${configPath}': ${message}`);
	}
}

// [MIGRATION] Added in v1.0.0. Remove after v2.0.0.
// 检测旧路径 <agentDir>/permission-config.json 残留：迁移未跑（session_start hook 失败/用户手动放置）
// 时新配置缺失，即将回落 yolo 默认。显眼 warn 提醒，避免 strict→yolo 静默降级。
// 不自动迁移（迁移职责在 session_start hook 的 migrateLegacyConfig），只告警。
function warnLegacyConfigIfExists(): void {
	const legacyPath = join(getAgentDir(), "permission-config.json");
	if (!existsSync(legacyPath)) return;
	const newPath = join(getAgentDir(), "config", "permission-ext-config.json");
	logger.warn(
		`Legacy config detected at '${legacyPath}' but new config '${newPath}' is missing. ` +
			`Migration did not run — defaulting to yolo mode, which may downgrade your previous strict/auto setting. ` +
			`Remove the legacy file or move it to the new path after migrating.`,
	);
}

// ──────────────────────── 加载 ────────────────────────

/**
 * 加载配置：文件缺失时创建默认配置文件并返回默认值；
 * 坏 JSON / normalize 失败回落默认值（onWarning 回调）。mtime+size 缓存由 llm-shared 提供。
 */
export function loadAndWatchConfig(onWarning?: (msg: string) => void): PermissionConfig {
	const configPath = getConfigPath();
	ensureConfigFile(configPath, onWarning);
	return loadConfig(CONFIG_PKG, DEFAULT_CONFIG, normalizeConfig, onWarning);
}

// ──────────────────────── 保存（原子写） ────────────────────────

/**
 * 保存配置（llm-shared 原子写：tmp + rename，0o600）。
 * @returns 成功返回 {success:true}；失败返回 {success:false, error}
 */
export function saveConfig(
	config: PermissionConfig,
): { success: boolean; error?: string } {
	return saveLlmConfig(CONFIG_PKG, config);
}

/** 测试用：清空 llm-shared 模块级缓存。 */
export { clearConfigCache };
