/**
 * 纯函数层：配置 schema / 加载 / 门控判定 / 阈值检查 / 摘要后处理。
 *
 * 无副作用（fs 读取经 llm-shared loadConfig 的缓存封装），全部可单测。
 * 设计文档：docs/extensions/smart-context/design.md（D5 门控矩阵 / D6 阈值保护 / D8 配置 schema）。
 */

import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { ModelSelector } from "@zhushanwen/pi-llm-shared";
import { loadConfig, normalizeModelSelector } from "@zhushanwen/pi-llm-shared";

// ──────────────────────── 配置 schema（D8） ────────────────────────

/** 单 K 的 token 数（显示格式化用）。 */
const TOKENS_PER_K = 1_000;
/** chars/4 的 token 估算口径（对齐 pi estimateTokens 启发式）。 */
export const CHARS_PER_TOKEN_ESTIMATE = 4;
/** 提醒阈值最大档数（3 档）。 */
const MAX_THRESHOLD_TIERS = 3;

/** 3 档提醒阈值默认值（token 绝对数）：200K / 400K / 600K。 */
const DEFAULT_REMINDER_THRESHOLD_TIER_1_TOKENS = 200_000;
const DEFAULT_REMINDER_THRESHOLD_TIER_2_TOKENS = 400_000;
const DEFAULT_REMINDER_THRESHOLD_TIER_3_TOKENS = 600_000;
const DEFAULT_REMINDER_THRESHOLDS: readonly number[] = [
	DEFAULT_REMINDER_THRESHOLD_TIER_1_TOKENS,
	DEFAULT_REMINDER_THRESHOLD_TIER_2_TOKENS,
	DEFAULT_REMINDER_THRESHOLD_TIER_3_TOKENS,
];

/** smart-context 磁盘配置（<agentDir>/config/smart-context-ext-config.json）。 */
export interface SmartContextConfig {
	enabled: boolean;
	/** 压缩模型 ref；与当前会话模型一致 → same-model 模式（D12）。 */
	compactModel: ModelSelector;
	/** 3 档提醒阈值（token 绝对数，升序）。 */
	reminderThresholds: number[];
	/** 排除模型列表：完整 provider/modelId 精准等值匹配（D5）。 */
	excludedModels: string[];
}

export const DEFAULT_SMART_CONTEXT_CONFIG: SmartContextConfig = {
	enabled: true,
	compactModel: { type: "ref", ref: "" },
	reminderThresholds: [...DEFAULT_REMINDER_THRESHOLDS],
	excludedModels: [],
};

/**
 * 配置 normalize：字段缺失/非法回退默认值（向后兼容，规范要求 deserializeState 同款纪律）。
 * - reminderThresholds：过滤非正数 → 升序 → 截 3 档；空数组回退默认
 * - excludedModels：过滤非字符串与不含 "/" 的条目（精准匹配要求完整 provider/modelId）→ 去重
 * - compactModel：ref 非字符串按空串
 */
export function normalizeSmartContextConfig(raw: unknown): SmartContextConfig {
	const base = DEFAULT_SMART_CONTEXT_CONFIG;
	if (typeof raw !== "object" || raw === null) return { ...base, reminderThresholds: [...base.reminderThresholds] };
	const r = raw as Record<string, unknown>;

	const enabled = typeof r.enabled === "boolean" ? r.enabled : base.enabled;

	const compactModel: ModelSelector =
		normalizeModelSelector(r.compactModel) ?? { type: "ref", ref: "" };

	const rawThresholds = Array.isArray(r.reminderThresholds)
		? r.reminderThresholds
		: [];
	const thresholds = rawThresholds
		.filter((t): t is number => typeof t === "number" && Number.isFinite(t) && t > 0)
		.sort((a, b) => a - b)
		.slice(0, MAX_THRESHOLD_TIERS);
	const reminderThresholds = thresholds.length > 0 ? thresholds : [...base.reminderThresholds];

	const rawExcluded = Array.isArray(r.excludedModels) ? r.excludedModels : [];
	const excludedModels = [
		...new Set(
			rawExcluded.filter((m): m is string => typeof m === "string" && m.includes("/")),
		),
	];

	return { enabled, compactModel, reminderThresholds, excludedModels };
}

/**
 * 读取配置（llm-shared loadConfig：mtime+size 读时刷新，热重载契约禁止上层缓存）。
 * 文件不存在/损坏 → 默认值。
 */
export function loadSmartContextConfig(): SmartContextConfig {
	return loadConfig("smart-context", DEFAULT_SMART_CONTEXT_CONFIG, normalizeSmartContextConfig);
}

// ──────────────────────── 门控判定（D5 矩阵） ────────────────────────

// 当前模型 ID 拼接口径单点在 llm-shared
export { getCurrentModelId } from "@zhushanwen/pi-llm-shared";

/**
 * 门控是否放行（D5 矩阵第一列）：enabled 且当前模型未精准命中排除列表。
 * 每次事件回调现场调用（热读配置），不缓存。
 */
export function isGatingActive(config: SmartContextConfig, currentModelId: string): boolean {
	if (!config.enabled) return false;
	if (currentModelId === "") return false;
	return !config.excludedModels.includes(currentModelId);
}

/**
 * 模式判定（D12）：compactModel.ref 等于当前模型（或未配置 = 跟随当前模型）→ "same-model"；
 * 否则 "cross-model"。
 */
export function pickMode(config: SmartContextConfig, currentModelId: string): "same-model" | "cross-model" {
	const ref = config.compactModel.ref;
	if (ref === "" || ref === currentModelId) return "same-model";
	return "cross-model";
}

// ──────────────────────── 阈值检查（D3/D6） ────────────────────────

/**
 * 越档检查：返回本次应提醒的档位（已 fired 的排除；多档合并由调用方组装成一条消息）。
 * tokens 为 null（压缩后首响应前，R7）→ 空数组（跳过本轮检查）。
 */
export function findCrossedThresholds(
	thresholds: readonly number[],
	tokens: number | null | undefined,
	fired: ReadonlySet<number>,
): number[] {
	if (typeof tokens !== "number" || !Number.isFinite(tokens)) return [];
	return thresholds.filter((t) => tokens >= t && !fired.has(t));
}

/**
 * 工具最低阈值保护（D6）：返回 null = 放行；返回字符串 = 拒绝原因（含当前用量数据）。
 * tokens 为 null → 拒绝（"用量未知"，null 窗口期紧随压缩完成，不应再压）。
 */
export function checkToolThresholdGuard(
	thresholds: readonly number[],
	tokens: number | null | undefined,
): string | null {
	const min = Math.min(...thresholds);
	if (typeof tokens !== "number" || !Number.isFinite(tokens)) {
		return `当前上下文用量未知（可能刚完成一次压缩），暂不执行压缩。若确有必要，请稍后重试。`;
	}
	if (tokens < min) {
		return `当前上下文 ${formatK(tokens)} tokens，未达第 1 档提醒阈值 ${formatK(min)}，无需压缩。继续你的工作即可。`;
	}
	return null;
}

// ──────────────────────── 摘要后处理（D13 纯函数部分） ────────────────────────

/** token 数格式化为 K 显示（200000 → "200K"；非整数 K 保留一位小数）。 */
export function formatK(tokens: number): string {
	const k = tokens / TOKENS_PER_K;
	return Number.isInteger(k) ? `${k}K` : `${k.toFixed(1)}K`;
}

/**
 * 收缩校验（D13-1）：摘要 token 数 ≥ 被压段 token 数 → 不合格（返回 true）。
 * 估算口径与 pi 一致（chars/4）。
 */
export function isSummaryInflated(summaryTokens: number, shadowedTokens: number): boolean {
	return summaryTokens >= shadowedTokens;
}

/** chars/4 估算 token（对齐 pi estimateTokens 口径的文本版）。 */
export function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

/** 降智提示阈值（D13-12）：累计 compaction 次数 ≥2 时提示开新会话。 */
export const DEGRADATION_HINT_MIN_COMPACTIONS = 2;

/**
 * fileOps 形状（对齐 pi createFileOps：{read/written/edited: Set<string>}）的宽松结构。
 * preparation.fileOps 直接传入。
 */
export interface FileOpsLike {
	read: Iterable<string>;
	written: Iterable<string>;
	edited: Iterable<string>;
}

/**
 * 计算文件清单（对齐 pi computeFileLists 语义：只读 = read − modified；modified = edited ∪ written）。
 * 返回排序后的两个列表。
 */
export function computeFileListsLike(fileOps: FileOpsLike): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set<string>([...fileOps.edited, ...fileOps.written]);
	const readFiles = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles, modifiedFiles };
}

/**
 * 文件清单追加（D11-2，对齐 pi formatFileOperations 输出格式：XML tags）。
 */
export function formatFileOperationsLike(readFiles: readonly string[], modifiedFiles: readonly string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

/** 文件重注入预算（D13-11）：≤5 文件 / 每文件 5K 字符 / 总 50K 字符。 */
const REINJECT_MAX_FILES = 5;
const REINJECT_PER_FILE_CHARS = 5_000;
const REINJECT_TOTAL_CHARS = 50_000;

/**
 * 文件重注入选择（D13-11）：从只读文件列表取最近 ≤5 个（Set 保序 = 插入序 ≈ 时间序，
 * 取尾部即最近），返回选中的路径列表（预算裁剪由调用方读文件时执行）。
 * keptReadFiles：保留段已出现过的 Read 结果（跳过，避免重复占上下文）。
 */
export function pickReinjectFiles(readFiles: readonly string[], keptReadFiles: ReadonlySet<string>): string[] {
	return readFiles
		.filter((f) => !keptReadFiles.has(f))
		.slice(-REINJECT_MAX_FILES);
}

/**
 * 组装「Recently read files」节（D13-11）：每文件头 5K 字符 + 截断标记，总 50K 截停。
 * 文件内容缺失（读失败/空）逐文件跳过。
 */
export function buildReinjectSection(contents: ReadonlyArray<{ path: string; content: string }>): string {
	let total = 0;
	const parts: string[] = [];
	for (const { path, content } of contents) {
		if (content === "") continue;
		const budgetFile = Math.min(REINJECT_PER_FILE_CHARS, REINJECT_TOTAL_CHARS - total);
		if (budgetFile <= 0) break;
		const text = content.length <= budgetFile
			? content
			: `${content.slice(0, budgetFile)}\n[... truncated]`;
		total += text.length;
		parts.push(`### ${path}\n\`\`\`\n${text}\n\`\`\``);
	}
	if (parts.length === 0) return "";
	return `\n\n<recently-read-files>\n${parts.join("\n\n")}\n</recently-read-files>`;
}

// ──────────────────────── session entries 统计（D13 纯函数） ────────────────────────

/** sessionManager entries 的宽松形状（降智计数）。 */
export interface EntryLike {
	type: string;
}

/** 累计 compaction 次数（D13-12 判据）。 */
export function countCompactions(entries: ReadonlyArray<EntryLike>): number {
	return entries.filter((e) => e.type === "compaction").length;
}

/** unknown 的对象收窄（Record 视图；字段消费再经 typeof / Array.isArray 收窄）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * 保留段已 Read 的文件集合（D13-11 去重：重注入跳过保留段已有的 Read 结果）。
 * 保留段 = branchEntries 中 firstKeptEntryId 之后的 message entries；从其 toolCall 参数提取 path。
 */
export function collectKeptReadFiles(branchEntries: ReadonlyArray<unknown>, firstKeptEntryId: string): Set<string> {
	const kept = new Set<string>();
	let found = false;
	for (const entry of branchEntries) {
		if (!isRecord(entry)) continue;
		if (!found) {
			if (entry.id === firstKeptEntryId) found = true;
			continue;
		}
		const msg = isRecord(entry.message) ? entry.message : undefined;
		if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const block of msg.content) {
			if (
				isRecord(block) && block.type === "toolCall" && block.name === "read" &&
				isRecord(block.arguments) && typeof block.arguments.path === "string"
			) {
				kept.add(block.arguments.path);
			}
		}
	}
	return kept;
}

/**
 * 被压段 token 估算（收缩校验分母：仅 messagesToSummarize；turnPrefixMessages 是保留段前缀，
 * 不属于被压段，不计入）。与 pi 自身压缩用量核算同源：逐条 estimateTokens 求和
 * （toolCall arguments 与 thinking 块计入分母），消息类型经其签名反推、随 pi 升级自动跟随。
 */
export function estimateShadowedTokens(
	messagesToSummarize: ReadonlyArray<Parameters<typeof estimateTokens>[0]>,
): number {
	let tokens = 0;
	for (const m of messagesToSummarize) {
		tokens += estimateTokens(m);
	}
	return tokens;
}
