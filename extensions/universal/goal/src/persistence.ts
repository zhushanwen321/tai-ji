/**
 * 持久化层 — serialize/deserialize + history entry 构造
 *
 * FR-5：必填字段缺失直接 throw；旧格式容忍面（time_limited → budget_limited 迁移、
 * successCriteria 旧格式归一、W5 熔断计数缺省归零、slug/completedAtTurnIndex 可选解析、
 * tasks 及未知字段白名单忽略）见 deserializeState 各迁移点注释。零 Pi 依赖。
 */

import type { GoalRuntimeState, GoalStatus } from "./engine/types";
import type { GoalHistoryEntry } from "./ports";

// ── 常量 ──────────────────────────────────────────────

export const ENTRY_TYPE = "goal-state";
export const HISTORY_ENTRY_TYPE = "goal-history";

// ── serialize（深拷贝，纯函数）────────────────────────

export function serializeState(state: GoalRuntimeState): GoalRuntimeState {
	return {
		...state,
		budget: { ...state.budget },
	};
}

// ── deserialize（FR-5 严格解析，缺必填字段 throw）──────────

/**
 * 旧持久化状态归一化（唯一迁移点）。
 *
 * npm pi-goal 0.7.x（base 968b9d76）经 finalizeAndPersist 真实写入过 `time_limited`（时间预算
 * 维度，新状态机已删除该状态）。若不归一化，升级用户持有该状态的 goal 会功能死锁：
 * /goal clear 的 transitionStatus 查表 throw、goal_control create 误报 already active、
 * resume/update 被 isActiveStatus 守卫拒绝——唯一出口是手动删 session 文件。
 * 归一化为语义最接近的 `budget_limited`（预算耗尽终态），clear 走 isTerminalStatus 快速路径。
 * 其余值原样透传（不做值域校验，保持现状）。
 */
function normalizeStatus(status: string): GoalStatus {
	return status === "time_limited" ? "budget_limited" : (status as GoalStatus);
}

/**
 * successCriteria 旧数据迁移（W1：string → string[]）。
 *
 * 输入形态与归一规则（plan 决策①②③⑤）：
 * - undefined/null → undefined
 * - string（旧格式自由文本）→ 按行拆分（/\r\n|\r|\n/ 覆盖 LF/CR/CRLF 三形态）+ 逐条 trim + 去空行；
 *   拆分结果为空（全空白、纯分隔符）→ undefined（空态归一）；超 8 条不截断（迁移容忍旧数据）
 * - string[]（新格式）→ every-string 则原样保留（不二次拆分、不 trim，round-trip 一致）；
 *   非 every-string（嵌套数组/null/数值元素）→ undefined（防御性丢弃——criteria 是 optional 字段，
 *   降级优于下游 escapeXmlText/.trim 的 TypeError throw）
 * - 其他类型（number/boolean）→ undefined
 */
function normalizeSuccessCriteria(raw: unknown): string[] | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (Array.isArray(raw)) {
		return raw.every((item) => typeof item === "string") ? (raw as string[]) : undefined;
	}
	if (typeof raw === "string") {
		const items = raw
			.split(/\r\n|\r|\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
		return items.length > 0 ? items : undefined;
	}
	return undefined;
}

/**
 * 反序列化持久化 state。
 *
 * 向后兼容：旧 entry 可能含 `tasks` 字段（task CRUD 删除前的格式），此处忽略不 throw。
 * 其余必填字段缺失仍 throw（FR-5）。
 */
export function deserializeState(data: Record<string, unknown>): GoalRuntimeState {
	const req = <T>(key: string): T => {
		if (!(key in data) || data[key] === undefined) {
			throw new Error(`Missing required field: ${key}`);
		}
		return data[key] as T;
	};

	return {
		goalId: req("goalId"),
		objective: req("objective"),
		// successCriteria：结构化为 string[]（W1）。向后兼容三种旧格式：
		// 1. undefined（旧数据无此字段）→ undefined
		// 2. string（单条自由文本）→ 按行拆分为 string[]（空态归一 undefined，见 normalizeSuccessCriteria）
		// 3. string[]（新格式）→ every-string 原样保留；脏元素防御性丢弃为 undefined
		successCriteria: normalizeSuccessCriteria(data.successCriteria),
		// slug 用可选解析：旧持久化数据无此字段，不能误用 req()（否则旧数据 throw → state 全丢，GAP-4）
		slug: data.slug as string | undefined,
		// 旧数据迁移：0.7.x 的 time_limited → budget_limited（见 normalizeStatus）
		status: normalizeStatus(req<string>("status")),
		tokensUsed: req("tokensUsed"),
		timeStartedAt: req("timeStartedAt"),
		timeUsedSeconds: req("timeUsedSeconds"),
		budget: req("budget"),
		budgetLimitSteeringSent: req("budgetLimitSteeringSent"),
		lastBlockerReason: req("lastBlockerReason"),
		tokenWarning70Sent: req("tokenWarning70Sent"),
		tokenWarning90Sent: req("tokenWarning90Sent"),
		lastTurnTokensUsed: req("lastTurnTokensUsed"),
		currentTurnIndex: req("currentTurnIndex"),
		completedAtTurnIndex: data.completedAtTurnIndex as number | undefined,
		// W5 熔断计数（chat-domain-v1x D4）：旧持久化数据无这些字段 → 归零/空集
		// （新激活周期语义：升级前的旧 goal 不携带历史熔断账）。slug 同款可选解析，
		// 不用 req()（否则旧数据 throw → state 全丢，GAP-4）。
		continuationsSent: nonNegativeNumber(data.continuationsSent),
		noProgressTurns: nonNegativeNumber(data.noProgressTurns),
		continuationCapNotified: data.continuationCapNotified === true,
		lastDeferredPendingIds: normalizeStringArray(data.lastDeferredPendingIds),
		toolCallsSeen: nonNegativeNumber(data.toolCallsSeen),
	};
}

/** 数值字段归一化：非负有限数原样保留，其余（含 undefined）→ 0。 */
function nonNegativeNumber(raw: unknown): number {
	return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

/** string[] 字段归一化：every-string 原样保留，其余（含 undefined）→ []。 */
function normalizeStringArray(raw: unknown): string[] {
	return Array.isArray(raw) && raw.every((item) => typeof item === "string") ? raw : [];
}

// ── makeHistoryEntry ─────────────────────────────────

/**
 * 从 state 构造 GoalHistoryEntry（纯函数）。
 */
export function makeHistoryEntry(state: GoalRuntimeState): GoalHistoryEntry {
	return {
		goalId: state.goalId,
		objective: state.objective,
		successCriteria: state.successCriteria,
		slug: state.slug,
		status: state.status,
		elapsedSeconds: Math.floor(state.timeUsedSeconds),
		timestamp: Date.now(),
	};
}
