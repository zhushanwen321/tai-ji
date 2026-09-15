/**
 * Goal 运行时组合状态类型 — engine 层共享类型定义
 *
 * 零 Pi 依赖。
 *
 * 仅 token 维度预算（time budget 已移除）。预警 flag 为 token 70/90 两个独立 flag。
 */

// ── Goal 状态枚举 ────────────────────────────────────

export type GoalStatus =
	| "active"
	| "paused"
	| "blocked"
	| "complete"
	| "budget_limited"
	| "cancelled";

export const TERMINAL_GOAL_STATUSES: ReadonlySet<GoalStatus> = new Set([
	"complete",
	"budget_limited",
	"cancelled",
]);

/**
 * 显式状态转换表（system-architecture §5）。终态映射空数组——不可逆。
 * transitionStatus 据此查表，非法转换 throw。新增状态时必须更新此表（forcing function）。
 */
export const VALID_TRANSITIONS: Record<GoalStatus, GoalStatus[]> = {
	active: ["paused", "blocked", "complete", "budget_limited", "cancelled"],
	paused: ["active", "cancelled"],
	blocked: ["active", "cancelled"],
	complete: [],
	budget_limited: [],
	cancelled: [],
};

// ── 预算配置 ────────────────────────────────────────

export interface BudgetConfig {
	tokenBudget?: number;
}

export const DEFAULT_BUDGET: BudgetConfig = {};

// ── 运行时状态（也是持久化格式）─────────────────────

export interface GoalRuntimeState {
	goalId: string;
	objective: string;
	/**
	 * 成功标准——如何验证 objective 已达成。与 objective 成对存储、注入、展示。
	 *
	 * 由 goal_control create 时 AI 自行推导（思考真实目标后定义可检查的完成条件），
	 * 非用户手写。complete 的 evidence 必须对照本字段逐条验证。
	 *
	 * 结构化为条件数组 string[]（1~8 条、每条单行短条件）。
	 * 旧持久化数据可能为 string（单条自由文本），deserialize 自动迁移为 string[]。
	 * optional：旧持久化数据无此字段，向后兼容（deserialize 可选解析，prompt 缺失时省略段）。
	 */
	successCriteria?: string[];
	/**
	 * AI 生成的短标识（kebab-case 风格），仅用于 widget 状态栏标题与 history。
	 * 不注入 prompt（prompt 仍读 objective，保证方向感）。
	 * 由 goal_control create 时 AI 提供；/goal 命令路径走提示词触发器由 AI toolcall 生成。
	 * optional：旧持久化数据无此字段，widget fallback 到 objective 截断。
	 */
	slug?: string;
	status: GoalStatus;
	tokensUsed: number;
	timeStartedAt: number;
	timeUsedSeconds: number;
	budget: BudgetConfig;
	budgetLimitSteeringSent: boolean;
	lastBlockerReason: string | null;
	// token 维度预警 flag（time budget 已移除，仅 token 70/90 两个 flag）
	tokenWarning70Sent: boolean;
	tokenWarning90Sent: boolean;
	lastTurnTokensUsed: number;
	currentTurnIndex: number;
	completedAtTurnIndex?: number;
	// ── 轮次活性熔断计数（chat-domain-v1x D4 / W5，随 state 持久化）──
	/**
	 * 主判据：本激活周期累计发出的 continuation 次数。封顶（LivenessConfig.continuationCap）
	 * 必停发。与「是否调工具」正交——任何路径不得因工具调用清零；唯一重置点 = 用户
	 * 显式 /goal resume（新激活周期）。旧持久化数据无此字段，deserialize 默认 0。
	 */
	continuationsSent: number;
	/**
	 * 辅判据：连续无进展轮数（无工具调用且 tokenDelta 低于阈值）。达到阈值起退避
	 * 间隔 ×2 递增；出现真实进展即清零（只清退避计数，不动 continuationsSent）。
	 */
	noProgressTurns: number;
	/** 封顶停发通知只发一次的锚点（resume 时复位）。 */
	continuationCapNotified: boolean;
	/** defer 通知去重锚：最近一次 defer 时的活跃 pending id 集合（排序后快照）。 */
	lastDeferredPendingIds: string[];
	/**
	 * session entries 内 assistant toolCall 块的累计数。相邻两次 agent_end 的差分 =
	 * 本 turn 的真实工具活动（辅判据输入）。随 state 持久化以在重启后保持差分口径。
	 */
	toolCallsSeen: number;
}
