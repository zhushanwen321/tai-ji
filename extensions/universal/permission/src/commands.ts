/**
 * /permission 命令
 *
 * W1 版本：文本菜单模式（ctx.ui.notify 显示当前模式 + 提示用 /permission <mode> 切换）。
 * 交互式方向键菜单（ctx.ui.custom + 自定义 Component）留待 W6 或后续迭代。
 *
 * 用法：
 *   /permission              显示当前模式和可用模式列表
 *   /permission yolo         切换到 yolo 模式
 *   /permission auto         切换到 auto 模式
 *   /permission approve      切换到 approve 模式
 *   /permission strict       切换到 strict 模式
 *   /permission status       显示当前配置详情
 */

import { listAvailableModels } from "./classifier/model-resolver.js";
import { type ModelPickerContext,pickModelViaOverlay } from "./model-picker.js";
import { editRulesViaOverlay, type RuleEditorContext } from "./rule-editor.js";
import { applyOps } from "./rule-templates.js";
import {
	isValidPermissionMode,
	MODE_DESCRIPTIONS,
	MODE_LABELS,
	PERMISSION_MODES,
	type PermissionConfig,
	type PermissionMode,
} from "./types.js";

/** 命令处理器返回的文本消息（由 ctx.ui.notify 显示） */
export function handlePermissionCommand(
	args: string | undefined,
	config: PermissionConfig,
	onSave: (config: PermissionConfig) => { success: boolean; error?: string },
): string {
	const trimmed = (args ?? "").trim();

	// 无参数：显示当前模式 + 可用模式
	if (!trimmed) {
		return formatStatusMessage(config);
	}

	// status 子命令：详细配置
	if (trimmed === "status") {
		return formatDetailedStatus(config);
	}

	// 切换模式
	if (isValidPermissionMode(trimmed)) {
		return switchMode(trimmed, config, onSave);
	}

	// 未知参数
	return `[pi-permission] Unknown mode '${trimmed}'. Available: ${PERMISSION_MODES.join(", ")}. Usage: /permission [mode|status|rule|model]`;
}

// ──────────────────────── 消息格式化 ────────────────────────

/** 模式列表 mode 列的 padEnd 宽度（最长 'approve' 7 字符 + 1 间隔，保证描述列对齐）。 */
const MODE_COLUMN_WIDTH = 8;

function formatStatusMessage(config: PermissionConfig): string {
	const lines: string[] = [];
	lines.push("[pi-permission] Current mode: " + modeHighlight(config.mode));
	lines.push("");
	lines.push("Available modes (by strictness, low → high):");
	for (const mode of PERMISSION_MODES) {
		const marker = mode === config.mode ? "►" : " ";
		lines.push(`  ${marker} ${mode.padEnd(MODE_COLUMN_WIDTH)} — ${MODE_DESCRIPTIONS[mode]}`);
	}
	lines.push("");
	lines.push("Switch with: /permission <mode>");
	return lines.join("\n");
}

function formatDetailedStatus(config: PermissionConfig): string {
	const lines: string[] = [];
	lines.push("[pi-permission] Configuration:");
	lines.push(`  mode:       ${modeHighlight(config.mode)}`);
	lines.push(`  enabled:    ${config.enabled}`);
	lines.push(`  classifier:`);
	lines.push(`    enabled:           ${config.classifier.enabled}`);
	lines.push(`    model:             ${config.classifier.model}`);
	lines.push(`    timeout:           ${config.classifier.timeout}s`);
	lines.push(`    autoApproveLow:    ${config.classifier.autoApproveLowRisk}`);
	lines.push(`    autoDenyHigh:      ${config.classifier.autoDenyHighRisk}`);
	lines.push(`  userRules:  ${config.userRules.length} rule(s)`);
	return lines.join("\n");
}

function switchMode(
	mode: PermissionMode,
	config: PermissionConfig,
	onSave: (config: PermissionConfig) => { success: boolean; error?: string },
): string {
	if (mode === config.mode) {
		return `[pi-permission] Already in ${MODE_LABELS[mode]} mode.`;
	}

	const newConfig: PermissionConfig = {
		mode,
		enabled: config.enabled,
		classifier: { ...config.classifier },
		userRules: config.userRules.map((r) => ({ ...r })),
	};
	const result = onSave(newConfig);

	if (!result.success) {
		return `[pi-permission] Failed to switch to ${MODE_LABELS[mode]} mode: ${result.error ?? "unknown error"}`;
	}

	return `[pi-permission] Switched to ${MODE_LABELS[mode]} mode.\n  ${MODE_DESCRIPTIONS[mode]}`;
}

function modeHighlight(mode: PermissionMode): string {
	// 纯文本标记（项目规范禁 emoji），用括号标注
	return `${MODE_LABELS[mode]} (${mode})`;
}

// ──────────────────────── /permission model（W7） ────────────────────────

/**
 * /permission model 命令：overlay 选择 classifier model（provider/model 或 auto）。
 *
 * 流程：
 *  1. listAvailableModels（ctx.modelRegistry 数据源）：拿可用模型 Map。空 → 降级 notify + return。
 *  2. pickModelViaOverlay：TUI/RPC/headless 三模式分发。
 *  3. 写回：save(newConfig)。失败 → notify error。
 *
 * save 为普通函数参数（唯一真实变化轴：保存 + footer 重绘副作用）。
 * ctx 用 ModelPickerContext 子集（mode + modelRegistry + ui.notify/custom/select）。
 */
export async function handlePermissionModelCommand(
	ctx: ModelPickerContext,
	config: PermissionConfig,
	save: (config: PermissionConfig) => { success: boolean; error?: string },
): Promise<void> {
	const current = config.classifier.model;

	// 1. listAvailableModels（ctx.modelRegistry 数据源）
	const models = listAvailableModels(ctx);
	if (models.size === 0) {
		ctx.ui.notify(
			"[pi-permission] No available models. Run `pi auth login` or configure provider API keys, then retry.",
			"warning",
		);
		return;
	}

	// 2. pickModelViaOverlay
	const selected = await pickModelViaOverlay(ctx, current, models);
	if (selected === undefined) {
		ctx.ui.notify("[pi-permission] Model selection cancelled.", "info");
		return;
	}

	// 3. 写回（仅改 classifier.model，保留其余字段）
	const newConfig: PermissionConfig = {
		mode: config.mode,
		enabled: config.enabled,
		classifier: { ...config.classifier, model: selected },
		userRules: config.userRules.map((r) => ({ ...r })),
	};
	const result = save(newConfig);
	if (!result.success) {
		ctx.ui.notify(
			`[pi-permission] Failed to save: ${result.error ?? "unknown error"}`,
			"error",
		);
		return;
	}
	ctx.ui.notify(`[pi-permission] AI classifier model set to: ${selected}`, "info");
}

// ──────────────────────── /permission rule（W8） ────────────────────────

/**
 * /permission rule 命令：overlay CRUD 编辑 userRules。
 *
 * 流程：
 *  1. editRulesViaOverlay（模块直调）：TUI/RPC/headless 三模式分发。
 *  2. ops 非空 → applyOps + saveConfig + notify。
 *  3. 空 → notify no changes。
 *
 * save 为普通函数参数（唯一真实变化轴：保存 + footer 重绘副作用，与同步路径 onSave 同款）。
 */
export async function handlePermissionRuleCommand(
	ctx: RuleEditorContext,
	config: PermissionConfig,
	sessionIdCounter: () => string,
	save: (config: PermissionConfig) => { success: boolean; error?: string },
): Promise<void> {
	// 1. editRulesViaOverlay
	const ops = await editRulesViaOverlay(ctx, config.userRules, sessionIdCounter);

	if (ops === undefined || ops.length === 0) {
		ctx.ui.notify("[pi-permission] No changes applied.", "info");
		return;
	}

	// 2. applyOps + save
	const newUserRules = applyOps([...config.userRules], ops);
	const newConfig: PermissionConfig = {
		mode: config.mode,
		enabled: config.enabled,
		classifier: { ...config.classifier },
		userRules: newUserRules,
	};
	const result = save(newConfig);
	if (!result.success) {
		ctx.ui.notify(
			`[pi-permission] Failed to save rules: ${result.error ?? "unknown error"}`,
			"error",
		);
		return;
	}

	ctx.ui.notify(`[pi-permission] ${ops.length} change(s) applied.`, "info");
}
