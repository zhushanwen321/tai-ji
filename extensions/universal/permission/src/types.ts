/**
 * @zhushanwen/pi-permission — 类型定义
 *
 * 全部类型统一在此声明，W2-W5 import 使用，避免跨模块类型碎片化。
 * 对应 slice plan 的 DM1-DM5 数据模型。
 */

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

// ──────────────────────── DM1: PermissionMode ────────────────────────

/** 四档权限模式，按严格等级排序（yolo 最低，strict 最高） */
export type PermissionMode = "yolo" | "auto" | "approve" | "strict";

/** 模式枚举顺序（严格等级从低到高） */
export const PERMISSION_MODES: PermissionMode[] = ["yolo", "auto", "approve", "strict"];

/** 模式人类可读描述 */
export const MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
	yolo: "完全无防护，所有工具调用放行",
	auto: "安全命令规则直接放行 + 非安全命令过 AI 审查 + AI 认为安全放行/AI 认为非安全人工审批",
	approve: "自动模式去除 AI，规则匹配后安全放行、非安全直接人工审批",
	strict: "全部审批",
};

/** 模式简短标签（statusline / 命令输出用） */
export const MODE_LABELS: Record<PermissionMode, string> = {
	yolo: "YOLO",
	auto: "Auto",
	approve: "Approve",
	strict: "Strict",
};

/** PermissionMode 类型守卫 */
export function isValidPermissionMode(value: unknown): value is PermissionMode {
	return typeof value === "string" && PERMISSION_MODES.includes(value as PermissionMode);
}

// ──────────────────────── DM2: Rule ────────────────────────

/** 权限规则（层 2 规则匹配用） */
export interface Rule {
	/**
	 * 唯一 id。实际格式：
	 *  - 用户规则 'user-<n>'（缺省时 makeNextIdCounter / normalizeRule 自动分配）
	 *  - 白名单兜底的虚拟规则固定 'builtin-safe'（无编号，matcher.ts 构造）
	 *  - 内置危险规则 'bd-<n>'（builtins.ts BUILTIN_DANGER_RULES 硬编码）
	 */
	id: string;
	/** 工具名匹配模式，wildcard（'*' 匹配全部，'bash' 精确匹配） */
	tool: string;
	/** 匹配模式，wildcard（bash 工具对命令行匹配；非 bash 工具对文件路径匹配，path 缺省时对工具名） */
	pattern: string;
	/** 决策动作 */
	action: PermissionAction;
	/** 规则来源 */
	source: RuleSource;
	/** 可选描述（UI 展示用） */
	description?: string;
}

/** 权限决策动作（三态） */
export type PermissionAction = "allow" | "deny" | "ask";

/** 规则来源 */
export type RuleSource = "builtin-safe" | "builtin-danger" | "user";

// ──────────────────────── DM3: PermissionDecision ────────────────────────

/** 权限决策结果（checkPermission 返回） */
export interface PermissionDecision {
	/** 最终动作 */
	action: PermissionAction;
	/** 人类可读原因（UI 展示 + 拒绝理由回传 agent） */
	reason: string;
	/** 决策来源（审计/调试用） */
	source: DecisionSource;
	/** AI 风险等级（仅 source='ai'） */
	riskLevel?: RiskLevel;
	/** 匹配的规则（仅 source='rule'） */
	matchedRule?: Rule;
	/** AI 置信度 0-1（仅 source='ai'） */
	confidence?: number;
}

/** 决策来源（实际产生值：mode/rule/ai/user；AST 分析不直接产生决策，只改变后续路径） */
export type DecisionSource = "mode" | "rule" | "ai" | "user";

/** AI 风险等级 */
export type RiskLevel = "low" | "medium" | "high";

// ──────────────────────── DM4: ClassifierConfig ────────────────────────

/** AI Classifier 配置（层 3 用，W4 实现） */
export interface ClassifierConfig {
	/**
	 * AI 层开关，默认 true。
	 * false 时 auto 模式跳过 classifier 与 racing，ask 直接转人工审批（不调 LLM）；
	 * 其他模式本就不走 AI 层，此字段无效果。
	 */
	enabled: boolean;
	/** 模型：'auto'（取 modelRegistry.getAvailable() 首个可用）或精确 'provider/model-id'（如 'zhipu/glm-4-flash'） */
	model: string;
	/** 超时秒数 */
	timeout: number;
	/** 低风险是否自动放行 */
	autoApproveLowRisk: boolean;
	/** 高风险是否强制 deny（不问人：high+allow 时直接拒绝） */
	autoDenyHighRisk: boolean;
	/**
	 * 标题生成 LLM 的 thinking 级别（pi 的 ModelThinkingLevel，THINKING_ORDER SSOT）。
	 * 默认 "off"：不传 pi-ai reasoning（provider 默认行为）；
	 * "minimal"~"max" 透传给 SimpleStreamOptions.reasoning（provider 不支持时静默忽略）。
	 */
	thinkingLevel: ModelThinkingLevel;
}

// ──────────────────────── DM5: PermissionConfig ────────────────────────

/** 扩展配置（<agentDir>/config/permission-ext-config.json 持久化格式） */
export interface PermissionConfig {
	/** 当前权限模式 */
	mode: PermissionMode;
	/** 扩展是否启用（false=完全放行，等同于 yolo 但保留配置） */
	enabled: boolean;
	/** AI Classifier 配置 */
	classifier: ClassifierConfig;
	/** 用户自定义规则（内置规则在代码里硬编码，不进配置） */
	userRules: Rule[];
}

// ──────────────────────── 默认配置 ────────────────────────

export const DEFAULT_CLASSIFIER_CONFIG: ClassifierConfig = {
	enabled: true,
	model: "auto",
	timeout: 90,
	autoApproveLowRisk: true,
	autoDenyHighRisk: true,
	thinkingLevel: "off",
};

export const DEFAULT_CONFIG: PermissionConfig = {
	mode: "yolo",
	enabled: true,
	classifier: { ...DEFAULT_CLASSIFIER_CONFIG },
	userRules: [],
};

// ──────────────────────── 后续 wave 用的类型（W1 声明，W2-W5 import） ────────────────────────

/** bash 结构分析结果（I2 analyzeBashStructure 返回，W2 实现） */
export interface BashAnalysis {
	/** 是否只有白名单结构（干净 SimpleCommand） */
	clean: boolean;
	/** 提取的命令 token 数组（每个元素是一条 SimpleCommand 的 argv） */
	commands: string[][];
	/** 检测到的危险结构节点类型（command_substitution/file_redirect/subshell 等） */
	dangerousStructures: string[];
	/** AST 解析是否失败（malformed 语法） */
	parseError: boolean;
}

/** 规则匹配结果（I3 matchRules 返回，W3 实现） */
export interface RuleMatchResult {
	action: PermissionAction;
	matchedRule?: Rule;
}

/** AI 分类结果（I4 classifyRisk 返回，W4 实现） */
export interface ClassifierResult {
	risk_level: RiskLevel;
	outcome: PermissionAction;
	reasoning: string;
	confidence: number;
}

/** AI 分类器的工具调用上下文（I4 输入） */
export interface ToolInvocationContext {
	toolName: string;
	command?: string;
	path?: string;
	cwd: string;
	agentName?: string;
}

/** 用户审批决策（I5 Racing 的 showUserDialog 返回，W5 实现） */
export interface UserDecision {
	approved: boolean;
	reason?: string;
}

// ──────────────────────── W6 T8: 从 pipeline.ts 迁移的类型 ────────────────────────

/**
 * 用户审批 UI 需要的数据（runLayer3WithRacing / approve / strict 传给 requestUserApproval）。
 *
 * reason 是人类可读的「为什么要审批」（含工具名 + 命令 + 触发原因），由 buildApprovalRequest 构造。
 * preClassification 仅 auto 模式 AI 先返回时携带（让用户看到 AI 的判断，辅助决策）。
 *
 * W6 T8：从 pipeline.ts 迁移到 types.ts（统一类型声明），pipeline.ts re-export 保持 public API。
 */
export interface ApprovalRequest {
	toolName: string;
	command?: string;
	reason: string;
	preClassification?: ClassifierResult;
}

/**
 * checkPermission 的外部依赖（DI 便于测试 mock）。
 *
 * - analyzeBashStructure：W2 AST 分析（层 1）。
 * - matchRulesForArgv：W3 规则匹配（层 2，bash happy path）。
 * - getDefaultRules：W3 内置危险规则（12 条 builtin-danger）。
 * - classifier.classifyRisk：W4 AI 风险分类（层 3）。
 * - requestUserApproval：W5 用户审批 UI（TUI/RPC/headless 三分支）。
 *
 * 生产装配见 production.ts；测试 mock 见 pipeline.test.ts。
 *
 * W6 T8：从 pipeline.ts 迁移到 types.ts（统一类型声明），pipeline.ts re-export 保持 public API。
 */
export interface CheckPermissionDeps {
	analyzeBashStructure: (command: string) => Promise<BashAnalysis>;
	matchRulesForArgv: (argv: string[], rules: readonly Rule[]) => RuleMatchResult;
	getDefaultRules: () => Rule[];
	/**
	 * 是否处于 headless 模式（json/print，无交互 UI）。
	 *
	 * auto 模式 Racing 用此判断：headless 时不启动 user promise（立即 deny 会抢占 AI 的 race），
	 * 纯等 AI classifier 判定；AI 失败/超时则 fail-closed deny。
	 * strict/approve 不受影响——它们的 askUser 走 requestHeadless 立即 deny（无 AI 可兜底）。
	 */
	isHeadless: () => boolean;
	classifier: {
		classifyRisk: (
			ctx: ToolInvocationContext,
			config: ClassifierConfig,
			signal?: AbortSignal,
		) => Promise<ClassifierResult>;
	};
	requestUserApproval: (
		req: ApprovalRequest,
		ctx: ToolInvocationContext,
		signal: AbortSignal | undefined,
	) => Promise<UserDecision>;
}
