/**
 * 提醒与通知文案构造（D3/D4/D5/D13-12）。
 *
 * 全部为纯函数：文案 + 越档判定。注入由 src/index.ts 用 pi.sendUserMessage 执行。
 * 措辞原则（目标 3）：提醒是数据投递不是指令——给三条件自查清单 + 明确的"可忽略"出口，
 * 避免 agent 见提醒就压缩。
 */

import {
	DEGRADATION_HINT_MIN_COMPACTIONS,
	formatK,
} from "./pure.js";

/** 百分比换算基数（tokens/contextWindow 比例 → 百分数显示）。 */
const PERCENT_SCALE = 100;
/** pi 内建自动压缩触发线的 reserveTokens 默认值（window − 16K）。 */
const PI_DEFAULT_RESERVE_TOKENS = 16_384;

/**
 * 阈值提醒消息（D3/D4）：越档信息 + 用量数据 + 工具名 + 三条件自查 + 可忽略出口。
 * 多档同时越过合并为一条（D3 去重规则）。
 */
export function buildThresholdReminder(
	crossedThresholds: readonly number[],
	tokens: number,
	contextWindow: number,
	compactionCount: number,
): string {
	const percent = contextWindow > 0 ? ((tokens / contextWindow) * PERCENT_SCALE).toFixed(1) : "?";
	const tiers = crossedThresholds
		.map((t, index) => `${formatK(t)}（第 ${index + 1} 档）`)
		.join("、");
	const lines = [
		`[smart-context 提示] 上下文当前 ${formatK(tokens)} / ${formatK(contextWindow)} tokens（${percent}%），已超过提醒阈值 ${tiers}。`,
		``,
		`compact_context 工具可用于压缩上下文。请自行判断是否现在压缩——仅当以下三个条件同时满足时才调用：`,
		`1. 当前任务的一个阶段已完成并验证（如一批文件改完、测试通过）；`,
		`2. 后续工作不再依赖将被压缩的早期细节；`,
		`3. 上下文已超过阈值（本提示即第 3 条的数据依据）。`,
		``,
		`若任务仍在进行中、或近期仍需引用早期上下文，忽略本提示继续工作即可（本档位不会重复提醒，压缩后会重置）。`,
	];
	if (compactionCount >= DEGRADATION_HINT_MIN_COMPACTIONS) {
		lines.push(``, buildDegradationHintLine());
	}
	return lines.join("\n");
}

/** 降智提示单行（D13-12，工具结果复用）。 */
export function buildDegradationHintLine(): string {
	return `Note: this session has been compacted multiple times; fine-grained details may be lost. If the task allows, consider starting a new session.`;
}

/** 切换跨界通知（D5）：进入排除 / 恢复可用 两态。 */
export function buildSwitchNotice(kind: "unavailable" | "available", modelId: string): string {
	if (kind === "unavailable") {
		return `[smart-context] 压缩工具暂时不可用：当前模型 ${modelId} 已配置为排除（smart-context excludedModels），本会话将使用 pi 原生压缩行为。`;
	}
	return `[smart-context] 压缩工具恢复可用：当前模型 ${modelId} 支持压缩（不在排除列表）。超阈值时将收到提醒。`;
}

/**
 * downshift 检测（D5）：新模型窗口更小且当前 tokens 将触线 → 提醒建议先压缩。
 * 返回 null = 无需提醒。
 */
export function buildDownshiftNotice(
	tokens: number | null | undefined,
	previousWindow: number | undefined,
	newWindow: number | undefined,
): string | null {
	if (typeof tokens !== "number" || typeof previousWindow !== "number" || typeof newWindow !== "number") {
		return null;
	}
	if (newWindow >= previousWindow) return null;
	const triggerLine = newWindow - PI_DEFAULT_RESERVE_TOKENS; // pi 内建触发线（window − reserveTokens 默认值）
	if (tokens < triggerLine) return null;
	return `[smart-context] 当前上下文 ${formatK(tokens)} tokens，已接近新模型窗口上限（${formatK(newWindow)}）。建议尽快压缩（调用 compact_context 或 /compact），否则内建自动压缩将在触线时强制执行。`;
}
