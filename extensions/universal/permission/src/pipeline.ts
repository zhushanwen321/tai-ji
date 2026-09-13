/**
 * checkPermission 纯函数主入口 + 四档模式分支 + 层 2/3 编排（W5 集成层）。
 *
 * 架构（自上而下）：
 *  - checkPermission：纯函数，按 mode 分发。deps 全注入（测试可 mock，不触碰 fs/network）。
 *  - runLayer2：bash 走 matchRulesForArgv（遍历 AST 拆出的 argv[]）；非 bash 走
 *    matchNonBashTool（G1：让 Read/Write/Edit 也评估用户规则；pattern 双语义与
 *    last-match-wins 循环均经 matcher 单源，wildcardToRegExp 只编译 tool 字段）。
 *  - runLayer3WithRacing：AI Classifier + 用户审批竞速（移植 classifier-racing.ts）。
 *    G3：用户审批的 ctx.ui.custom 工厂在调之前先检查 signal.aborted，避免 AI 先于
 *    UI 触发 abort 时 comp 尚未创建导致 cancel 落空。
 *  - applyAutoApproveOverrides：W4 WT7 偏差补丁（low+allow+autoApproveLowRisk=false → ask；
 *    high+allow+autoDenyHighRisk=true → deny），独立纯函数便于单测。
 *
 * fail-closed 原则：任何异常路径 → ask（交人工，不静默放行）。
 * checkPermission 永不 throw（caller index.ts 的 tool_call handler 依赖此契约）。
 */

import { getLogger } from "@zhushanwen/pi-extension-logger";
import { lastMatchWins, matchRules, resolvePattern } from "./rules/matcher.js";
import { wildcardToRegExp } from "./rules/wildcard.js";
import type {
	ApprovalRequest,
	CheckPermissionDeps,
	ClassifierConfig,
	ClassifierResult,
	PermissionAction,
	PermissionDecision,
	PermissionMode,
	Rule,
	RuleMatchResult,
	ToolInvocationContext,
	UserDecision,
} from "./types.js";

// ──────────────────────── 依赖注入接口（W6 T8 迁移到 types.ts） ────────────────────────

// CheckPermissionDeps 与 ApprovalRequest 已迁移到 types.ts（W6 T8 统一类型声明）。
// 此处 re-export 保持 public API 不变（下游 approval.ts / production.ts / 测试仍从
// pipeline.js import 这些类型，不破坏现有 import 路径）。
export type { ApprovalRequest, CheckPermissionDeps } from "./types.js";

const logger = getLogger("pi-permission");

// ──────────────────────── buildApprovalRequest ────────────────────────

/**
 * 构造审批 UI 需要的数据（纯函数）。
 *
 * @param toolName 工具名（bash/read/write/...）
 * @param command 命令字符串（bash 用，其他工具 undefined）
 * @param trigger 触发审批的原因（如 "AST detected dangerous structure: subshell"）
 * @param preClassification AI 先返回的分类（仅 auto 模式 racing AI 赢时携带）
 */
export function buildApprovalRequest(
	toolName: string,
	command: string | undefined,
	trigger: string,
	preClassification?: ClassifierResult,
): ApprovalRequest {
	const cmdPart = command !== undefined && command.length > 0 ? `: ${command}` : "";
	const reason = `[${toolName}${cmdPart}] ${trigger}`;
	return { toolName, command, reason, ...(preClassification !== undefined ? { preClassification } : {}) };
}

// ──────────────────────── runLayer2（含 G1 非 bash helper） ────────────────────────

/**
 * G1 修正：非 bash 工具规则匹配 helper。
 *
 * W5 需要让 Read/Write/Edit 也评估用户规则（用户可能写 `read ~/.ssh/*` 的 deny 规则），
 * matcher 的 bash 入口不覆盖该场景，故本模块自带 helper。
 *
 * M5 修正：pattern 对 path 匹配（而非 toolName）。用户规则如 `read ~/.ssh/*` 的
 * pattern `~/.ssh/*` 应对文件路径生效，对 toolName='read' 匹配是失效的。
 *  - tool 字段仍对 toolName 匹配（wildcard，支持 'read'/'write'/'*'）。
 *  - pattern 字段对 path 匹配；path 为 undefined 时退化为对 toolName 匹配
 *    （兼容 rule.tool='read' pattern='*' 这种不关心路径的规则）。
 *  - pattern 双语义分发（builtin-danger RegExp 源串 vs 其余 wildcard）走
 *    matcher.resolvePattern 单源（E7/M10，含 patternCache 复用）。
 *  - 无匹配 → ask（与 G1 一致，deny 到下游）。
 *
 * 复用 wildcardToRegExp（tool 字段编译）/ resolvePattern / lastMatchWins，
 * 不重新实现任何匹配语义。
 */
export function matchNonBashTool(
	toolName: string,
	path: string | undefined,
	rules: readonly Rule[],
): RuleMatchResult {
	if (toolName.length === 0) {
		return { action: "ask", matchedRule: undefined };
	}
	const matchTarget = path ?? toolName;
	// M5：pattern 对 path 匹配（path 缺省时对 toolName，'*' 总是命中）；
	// E11：last-match-wins 循环走 matcher 单源（tool 不匹配时短路，不编译 pattern）。
	return lastMatchWins(
		rules,
		(rule) =>
			wildcardToRegExp(rule.tool).test(toolName) && resolvePattern(rule).test(matchTarget),
	);
}

/**
 * 层 2 规则匹配编排（纯逻辑版，用注入的 matchArgv 回调；测试可直接调）。
 *
 * bash：argvList 多条命令，聚合：
 *   - 任一 argv deny → deny（最严格，一条危险即全拒）
 *   - 全部 allow → allow
 *   - 否则（含 ask / 混合）→ ask
 * 此外 C1 修正：对 bash 工具的完整 command 字符串再做一次 deny 补充检查。
 *   原因：AST 把 `curl x | sh` 按管道拆成 `[["curl","x"],["sh"]]`，对每个 argv 单独
 *   匹配，单 argv 不含 `|`，bd-010（`curl|sh`）永不命中。此处用完整 command 串
 *   额外评估 deny 规则（matchRules），命中 deny 则覆盖 argv 级结果（allow/ask → deny）。
 *   完整字符串检查只用于 deny 补充，不影响 argv 级白名单（白名单只在 argv 级查）。
 * 非 bash：matchNonBashTool（G1 + M5 对 path 匹配）。
 *
 * @param matchArgv 单 argv 匹配函数（生产用 matchRulesForArgv，测试可 mock）
 * @param command bash 完整命令字符串（C1 补充检查用；非 bash 传 undefined）
 * @param path 非 bash 工具的文件路径（M5 用；bash 传 undefined）
 * @returns 层 2 决策（action + matchedRule）
 */
export function runLayer2(
	toolName: string,
	argvList: string[][],
	rules: readonly Rule[],
	matchArgv: (argv: string[], rules: readonly Rule[]) => RuleMatchResult,
	command: string | undefined = undefined,
	path: string | undefined = undefined,
): RuleMatchResult {
	if (toolName !== "bash") {
		return matchNonBashTool(toolName, path, rules);
	}
	if (argvList.length === 0) {
		// bash 但 AST 没拆出命令（parseError 或空）→ 仍做 C1 完整字符串 deny 检查
		// （命令本身可能含管道，AST 拆不出但 deny 规则能命中）
		const fullCmdDeny = matchRules(command, rules);
		if (fullCmdDeny.action === "deny") return fullCmdDeny;
		return { action: "ask", matchedRule: undefined };
	}
	let sawAsk = false;
	let lastAllow: RuleMatchResult | undefined;
	for (const argv of argvList) {
		if (argv.length === 0) {
			sawAsk = true;
			continue;
		}
		const r = matchArgv(argv, rules);
		if (r.action === "deny") return r;
		if (r.action === "ask") sawAsk = true;
		if (r.action === "allow") lastAllow = r;
	}
	// C1：对完整 command 字符串做 deny 补充检查（覆盖跨 argv 管道如 curl|sh）。
	// 仅 deny 能覆盖 argv 级结果；完整字符串检查不查白名单（matchRules 语义），
	// 故不会把 argv 级 deny/ask 提升为 allow。
	const fullCmdDeny = matchRules(command, rules);
	if (fullCmdDeny.action === "deny") return fullCmdDeny;
	if (sawAsk) return { action: "ask", matchedRule: undefined };
	return lastAllow ?? { action: "ask", matchedRule: undefined };
}

// ──────────────────────── applyAutoApproveOverrides（W4 WT7 偏差补丁） ────────────────────────

/**
 * W4 WT7 偏差补丁：根据 ClassifierConfig 调整 AI 分类结果。
 *
 * 规则（独立纯函数，便于单测）：
 *  - risk='low' + outcome='allow' + autoApproveLowRisk=false → ask（不让 AI 自动放行低风险）
 *  - risk='high' + outcome='allow' + autoDenyHighRisk=true → deny（高风险即使 AI 说放行也拒）
 *  - 其余透传（含 outcome='deny'/'ask' 不改，避免与 autoApprove/autoDeny 语义冲突）
 *
 * 不修改原对象（返回新对象），保持 ClassifierResult 不可变语义。
 */
export function applyAutoApproveOverrides(
	result: ClassifierResult,
	config: ClassifierConfig,
): ClassifierResult {
	// 高风险 + allow + autoDenyHighRisk → 强制 deny
	if (result.risk_level === "high" && result.outcome === "allow" && config.autoDenyHighRisk) {
		return {
			...result,
			outcome: "deny",
			reasoning: `auto-denied (high risk, autoDenyHighRisk=true); original: ${result.reasoning}`,
		};
	}
	// 低风险 + allow + autoApproveLowRisk=false → 强制 ask（交人工）
	if (result.risk_level === "low" && result.outcome === "allow" && !config.autoApproveLowRisk) {
		return {
			...result,
			outcome: "ask",
			reasoning: `auto-ask (low risk but autoApproveLowRisk=false); original: ${result.reasoning}`,
		};
	}
	return result;
}

// ──────────────────────── runLayer3WithRacing（G3 abort 时序） ────────────────────────

/** 外层 abort 传播到内层 controller（session abort 时级联取消 AI + 用户审批）。 */
function linkOuterSignal(controller: AbortController, outerSignal: AbortSignal | undefined): void {
	if (outerSignal) {
		if (outerSignal.aborted) controller.abort();
		else outerSignal.addEventListener("abort", () => controller.abort(), { once: true });
	}
}

/**
 * 启动 AI 分类 promise。
 * M4：aiPromise 挂 .catch 转 fallback（确保永不 reject）。
 * classifier 内部有 try/catch，但 resolveModel/buildModel/buildContext 在 try 外，
 * 用户先返回 abort 后 classifier 晚 reject → race 已 settle → unhandledRejection。
 */
function startAiClassification(
	deps: CheckPermissionDeps,
	ctx: ToolInvocationContext,
	config: ClassifierConfig,
	signal: AbortSignal,
): Promise<ClassifierResult> {
	return deps.classifier.classifyRisk(ctx, config, signal).catch((err: unknown) => {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			outcome: "ask" as const,
			risk_level: "medium" as const,
			reasoning: `classifier error: ${msg}`,
			confidence: 0,
		};
	});
}

/** AI 判定 → PermissionDecision 信封（source='ai'，透传 overridden 的 reasoning/风险/置信度）。 */
function aiDecision(action: PermissionAction, overridden: ClassifierResult): PermissionDecision {
	return {
		action,
		reason: overridden.reasoning,
		source: "ai",
		riskLevel: overridden.risk_level,
		confidence: overridden.confidence,
	};
}

/**
 * M1：headless 模式（json/print）下纯等 AI，不启动 user promise。
 * 否则 requestHeadless 立即 deny 会抢占 race → AI 永远没机会赢 → auto 退化为 strict。
 * AI 返回 allow/deny → 按结果返回；AI 返回 ask/超时/fail → fail-closed deny。
 */
async function settleHeadlessAi(
	aiPromise: Promise<ClassifierResult>,
	controller: AbortController,
	config: ClassifierConfig,
): Promise<PermissionDecision> {
	const aiResult = await aiPromise;
	const overridden = applyAutoApproveOverrides(aiResult, config);
	if (overridden.outcome === "allow") {
		controller.abort();
		return aiDecision("allow", overridden);
	}
	if (overridden.outcome === "deny") {
		controller.abort();
		return aiDecision("deny", overridden);
	}
	// AI ask → headless 无 UI 可问 → fail-closed deny
	controller.abort();
	return {
		action: "deny",
		reason: "headless mode: AI inconclusive (ask), fail-closed deny",
		source: "ai",
		riskLevel: overridden.risk_level,
		confidence: overridden.confidence,
	};
}

/**
 * AI 赢（非 ask）分支：先 abort 再 resolveUser 关闭用户对话框，返回 AI 决策
 * （G3：先 abort 再 resolveUser，保证 UI factory 看到 aborted 状态短路）。
 * 返回 null = AI ask → 转人工（不 resolveUser，等用户最终决策）。
 */
function settleAiWin(
	overridden: ClassifierResult,
	controller: AbortController,
	resolveUser: (d: UserDecision) => void,
): PermissionDecision | null {
	if (overridden.outcome === "allow") {
		// AI 放行 → 关闭用户对话框（若已弹出），返回 allow
		controller.abort();
		resolveUser({ approved: false, reason: "AI classifier allowed; dialog dismissed" });
		return aiDecision("allow", overridden);
	}
	if (overridden.outcome === "deny") {
		controller.abort();
		resolveUser({ approved: false, reason: "AI classifier denied; dialog dismissed" });
		return aiDecision("deny", overridden);
	}
	return null;
}

/**
 * AI ask → 转 human（等用户最终决策，不关闭对话框）。
 * M3：超时兜底防止永久挂起。若 AI 返回 ask 后用户恰好与 AI 在同一 tick 操作，
 * comp.cancel() 因 _resolved 守卫不调 done → requestUserApproval promise 永不
 * resolve → realUserPromise pending → 永久挂起（G5 串行化放大为全链卡死）。
 * 5 分钟超时后 fail-closed 拒绝（不静默放行）。
 */
async function awaitUserAfterAiAsk(
	realUserPromise: Promise<UserDecision>,
): Promise<PermissionDecision> {
	const APPROVAL_TIMEOUT_MS = 300_000;
	const userFinal = await Promise.race<UserDecision>([
		realUserPromise,
		new Promise<UserDecision>((resolve) =>
			setTimeout(
				() => resolve({ approved: false, reason: "approval dialog timeout (fail-closed)" }),
				APPROVAL_TIMEOUT_MS,
			),
		),
	]);
	const action: PermissionAction = userFinal.approved ? "allow" : "deny";
	return {
		action,
		reason: userFinal.reason ?? (userFinal.approved ? "approved by user (after AI ask)" : "denied by user (after AI ask)"),
		source: "user",
	};
}

/** 竞速主体（TUI 形态）：AI vs 用户并行，race 后按先 settle 的一侧出决策。 */
async function raceAiWithUser(
	deps: CheckPermissionDeps,
	ctx: ToolInvocationContext,
	config: ClassifierConfig,
	aiPromise: Promise<ClassifierResult>,
	controller: AbortController,
	trigger: string,
): Promise<PermissionDecision> {
	// 用户审批 promise：可被 resolveUser 外部 resolve（AI 赢时关闭对话框）
	let resolveUser: (d: UserDecision) => void = () => {
		/* 占位，下方立即覆写 */
	};
	const userPromise = new Promise<UserDecision>((resolve) => {
		resolveUser = resolve;
	});

	const req = buildApprovalRequest(ctx.toolName, ctx.command, trigger);

	// 启动用户审批（真实对话框）。用户先返回 → abort AI。
	//
	// W6 G6（F9 结论固化）：userPromise 与 realUserPromise 双 promise 都是必要的：
	//  - realUserPromise：承载 requestUserApproval 的真实返回值 + abort 副作用
	//    （用户决策后 controller.abort() 取消 AI）。它驱动 AI-ask 分支的最终 await。
	//  - userPromise：可被 resolveUser 外部 resolve（AI 赢时关闭对话框），用于 race
	//    透传（AI allow/deny 时 resolveUser 关闭 UI，userPromise 立即 settle）。
	// 删除任一都会破坏一种竞态：仅 realUserPromise → AI 赢时无法关闭对话框；
	// 仅 userPromise → AI-ask 分支无法拿到用户的最终决策（userPromise 只能被
	// resolveUser resolve，AI-ask 时不调 resolveUser）。F9 测试已验证两者缺一不可。
	const realUserPromise = deps.requestUserApproval(req, ctx, controller.signal).then((d) => {
		controller.abort(); // 用户已决策，取消 AI
		resolveUser(d); // 透传给 userPromise（race 用）
		return d;
	});

	// race：AI vs 用户。AI outcome='ask' 时仍可能先 settle，但语义是「转人工」，
	// 此时不能 resolveUser 关闭对话框——需等用户。故 race 后据 AI outcome 分支。
	const aiSettled = await Promise.race([
		aiPromise.then((r) => ({ kind: "ai" as const, result: r })),
		userPromise.then((d) => ({ kind: "user" as const, decision: d })),
		realUserPromise.then((d) => ({ kind: "user" as const, decision: d })),
	]);

	if (aiSettled.kind === "user") {
		// 用户赢了（或 AI ask 后用户最终决策）
		const d = aiSettled.decision;
		const action: PermissionAction = d.approved ? "allow" : "deny";
		return {
			action,
			reason: d.reason ?? (d.approved ? "approved by user" : "denied by user"),
			source: "user",
		};
	}

	// AI 赢
	const overridden = applyAutoApproveOverrides(aiSettled.result, config);
	const decided = settleAiWin(overridden, controller, resolveUser);
	if (decided !== null) return decided;
	return await awaitUserAfterAiAsk(realUserPromise);
}

/**
 * 层 3：AI Classifier + 用户审批竞速（移植 pi-permission-system classifier-racing.ts）。
 *
 * 竞速语义：
 *  - 启动 AI 分类（aiPromise）+ 用户审批（userPromise）。
 *  - 用户先返回 → controller.abort() 取消 AI（已无用的 AI 计算尽早终止）。
 *  - AI 先返回：
 *      - AI outcome='allow' → resolveUser({approved:false}) 关闭用户对话框，返回 allow。
 *      - AI outcome='deny'  → resolveUser({approved:false}) 关闭用户对话框，返回 deny。
 *      - AI outcome='ask'   → 不 resolveUser，等用户最终决策（AI 不确定时转人工）。
 *
 * G3 修正：requestUserApproval（TUI 分支）在调 ctx.ui.custom 前先检查 signal.aborted，
 * 避免 AI 先于 UI factory 执行时 controller.abort() 触发但 comp 尚未创建导致 cancel 落空。
 * 此处再叠一层：AI 赢且 outcome 是 allow/deny 时，先 abort 再 resolveUser，
 * 保证 UI factory 看到 aborted 状态短路。
 *
 * classifier.enabled=false：AI 层被用户显式关闭 → 跳过 classifier 与 racing，直接人工审批
 * （复用 askUser 路径）。headless 下 requestUserApproval 走 requestHeadless 立即 fail-closed
 * deny，与 AI 判定 ask 时的短路 deny 语义一致。
 *
 * @param deps 注入依赖（classifier + requestUserApproval）
 * @param ctx 工具调用上下文
 * @param config classifier 配置
 * @param outerSignal 外层 signal（session abort 时传播）
 * @param trigger 审批触发原因（m2：AST 检测到的具体危险结构等；默认通用文案）
 * @returns PermissionDecision（source='ai' 或 'user'）
 */
export async function runLayer3WithRacing(
	deps: CheckPermissionDeps,
	ctx: ToolInvocationContext,
	config: ClassifierConfig,
	outerSignal: AbortSignal | undefined,
	trigger: string = "awaiting approval (auto mode: AI classifier racing with user prompt)",
): Promise<PermissionDecision> {
	// classifier.enabled=false → AI 层关闭，直接人工审批（不启动 AI promise，不进入 racing）
	if (config.enabled === false) {
		return await askUser(deps, ctx, "AI classifier disabled (classifier.enabled=false)", outerSignal);
	}
	const controller = new AbortController();
	// 外层 abort 传播到内层
	linkOuterSignal(controller, outerSignal);

	const aiPromise = startAiClassification(deps, ctx, config, controller.signal);

	// M1：headless 模式下纯等 AI（不启动 user promise）
	if (deps.isHeadless()) {
		return await settleHeadlessAi(aiPromise, controller, config);
	}
	return await raceAiWithUser(deps, ctx, config, aiPromise, controller, trigger);
}

// ──────────────────────── checkPermission（纯函数主入口） ────────────────────────

/** ctxBase 形态（checkPermission 第四参之后注入的上下文基线）。 */
interface ContextBase {
	cwd: string;
	agentName?: string;
	signal?: AbortSignal;
}

/** 从 input 装配 ToolInvocationContext（command 用 AST/规则，path 其余字段透传给 UI）。 */
function buildInvocationContext(
	toolName: string,
	command: string | undefined,
	input: Record<string, unknown>,
	ctxBase: ContextBase,
): ToolInvocationContext {
	return {
		toolName,
		...(command !== undefined ? { command } : {}),
		path: typeof input.path === "string" ? input.path : undefined,
		cwd: ctxBase.cwd,
		...(ctxBase.agentName !== undefined ? { agentName: ctxBase.agentName } : {}),
	};
}

/** 层 2 allow/deny 结果 → PermissionDecision 装配（ask 返回 null 交下游）。 */
function ruleDecision(layer2: RuleMatchResult): PermissionDecision | null {
	if (layer2.action === "allow") {
		return {
			action: "allow",
			reason: layer2.matchedRule
				? `allowed by rule ${layer2.matchedRule.id}`
				: "allowed by rules (no deny matched)",
			source: "rule",
			...(layer2.matchedRule ? { matchedRule: layer2.matchedRule } : {}),
		};
	}
	if (layer2.action === "deny") {
		return {
			action: "deny",
			reason: layer2.matchedRule
				? `denied by rule ${layer2.matchedRule.id}`
				: "denied by rules",
			source: "rule",
			...(layer2.matchedRule ? { matchedRule: layer2.matchedRule } : {}),
		};
	}
	return null;
}

/** 层 1 AST 输出：层 2 需要的 argvList + 提前决策（null = 无提前决策，继续层 2）。 */
interface AstLayerOutcome {
	argvList: string[][];
	earlyDecision: PermissionDecision | null;
}

/**
 * 层 1 AST（仅 bash 且有 command 时执行）：clean → 透传 argvList 继续；
 * 非 clean / 异常 → 按模式提前决策（approve 人工 / auto 进层 3 Racing）。
 */
async function runAstLayer(
	toolName: string,
	command: string | undefined,
	mode: PermissionMode,
	config: ClassifierConfig,
	ctx: ToolInvocationContext,
	deps: CheckPermissionDeps,
	ctxBase: ContextBase,
): Promise<AstLayerOutcome> {
	let argvList: string[][] = [];
	if (toolName === "bash" && command !== undefined) {
		try {
			const analysis = await deps.analyzeBashStructure(command);
			argvList = analysis.commands;
			// AST 检测到危险结构（非 clean）→ 直接 ask（auto→AI，approve→人工）
			if (!analysis.clean) {
				const trigger = `AST detected dangerous structure: ${analysis.dangerousStructures.join(", ") || "unknown"}`;
				if (mode === "approve") {
					return { argvList, earlyDecision: await askUser(deps, ctx, trigger, ctxBase.signal) };
				}
				// auto：进层 3（AI 评估危险命令）。m2：透传 AST 检测的具体危险原因。
				return { argvList, earlyDecision: await runLayer3WithRacing(deps, ctx, config, ctxBase.signal, trigger) };
			}
		} catch {
			// AST 异常 → fail-closed ask（auto→AI，approve→人工）
			if (mode === "approve") {
				return { argvList, earlyDecision: await askUser(deps, ctx, "AST analysis failed (fail-closed)", ctxBase.signal) };
			}
			return { argvList, earlyDecision: await runLayer3WithRacing(deps, ctx, config, ctxBase.signal) };
		}
	}
	return { argvList, earlyDecision: null };
}

/**
 * 权限检查主入口（纯函数，deps 注入）。主函数只留编排：
 * yolo/strict 快速路径 → 层 1 AST（runAstLayer）→ 层 2 规则（ruleDecision）→ 下游。
 *
 * 四档模式分支：
 *  - yolo：完全放行（return allow，source='mode'）。不跑任何层。
 *  - auto：AST → 规则（allow 通过 / deny 拒绝 / ask → 层 3 Racing AI+用户；
 *    classifier.enabled=false 时 ask → 直接人工审批，无 AI）。
 *  - approve：AST → 规则（allow 通过 / deny+ask → 人工审批，无 AI）。
 *  - strict：全部人工审批（不跑 AST/规则/AI）。
 *
 * config.enabled=false 等同 yolo（保留配置但不拦截）。
 * 永不 throw（fail-closed：异常 → ask）。
 *
 * @param toolName 工具名
 * @param input 工具输入（bash={command}, 其他={path,...}）。command 用 AST/规则，其余字段透传给 UI。
 * @param mode 当前权限模式
 * @param config classifier 配置（auto 模式用）
 * @param userRules 用户规则（与 getDefaultRules 拼接）
 * @param deps 注入依赖
 * @param ctxBase 工具调用上下文基线（cwd/agentName）
 * @param signal 外层 abort signal
 */
export async function checkPermission(
	toolName: string,
	input: Record<string, unknown>,
	mode: PermissionMode,
	config: ClassifierConfig,
	userRules: Rule[],
	deps: CheckPermissionDeps,
	ctxBase: ContextBase,
): Promise<PermissionDecision> {
	// yolo / disabled → 完全放行
	if (mode === "yolo") {
		return { action: "allow", reason: "yolo mode: all tools allowed", source: "mode" };
	}

	const command = extractCommand(toolName, input);
	const ctx = buildInvocationContext(toolName, command, input, ctxBase);

	// strict → 全部人工审批（不跑 AST/规则/AI）
	if (mode === "strict") {
		return await askUser(deps, ctx, "strict mode: all tools require approval", ctxBase.signal);
	}

	// auto / approve：层 1 AST + 层 2 规则
	const ast = await runAstLayer(toolName, command, mode, config, ctx, deps, ctxBase);
	if (ast.earlyDecision !== null) {
		return ast.earlyDecision;
	}

	// 层 2 规则（auto + approve 共用）
	const rules = [...deps.getDefaultRules(), ...userRules];
	// C1：传入完整 command（bash 跨 argv 管道 deny 补充检查）；
	// M5：传入 path（非 bash 工具规则对 path 匹配）。
	const layer2 = runLayer2ForArgvList(toolName, ast.argvList, rules, deps, command, ctx.path);

	const decided = ruleDecision(layer2);
	if (decided !== null) {
		return decided;
	}

	// layer2.action === 'ask' → 下游
	if (mode === "approve") {
		// approve：ask → 人工审批（无 AI）
		return await askUser(deps, ctx, "no matching allow rule (approve mode)", ctxBase.signal);
	}

	// auto：ask → 层 3 Racing（AI + 用户）
	return await runLayer3WithRacing(deps, ctx, config, ctxBase.signal);
}

/**
 * 层 2 规则匹配（用注入的 deps.matchRulesForArgv）。
 * 薄封装 runLayer2，把注入的 matcher 传入纯逻辑版。
 */
function runLayer2ForArgvList(
	toolName: string,
	argvList: string[][],
	rules: readonly Rule[],
	deps: CheckPermissionDeps,
	command: string | undefined,
	path: string | undefined,
): RuleMatchResult {
	return runLayer2(toolName, argvList, rules, deps.matchRulesForArgv, command, path);
}

/** approve/strict 模式的人工审批封装（无 AI）。 */
async function askUser(
	deps: CheckPermissionDeps,
	ctx: ToolInvocationContext,
	trigger: string,
	signal: AbortSignal | undefined,
): Promise<PermissionDecision> {
	const req = buildApprovalRequest(ctx.toolName, ctx.command, trigger);
	const decision = await deps.requestUserApproval(req, ctx, signal);
	return {
		action: decision.approved ? "allow" : "deny",
		reason: decision.reason ?? (decision.approved ? "approved by user" : "denied by user"),
		source: "user",
	};
}

/** 从 input 提取 bash command（仅 bash 工具）。 */
function extractCommand(toolName: string, input: Record<string, unknown>): string | undefined {
	if (toolName !== "bash") return undefined;
	const cmd = input.command;
	if (cmd === undefined) return undefined;
	if (typeof cmd === "string") return cmd;
	// m3：bash + command 非字符串（异常输入）→ 记录警告，fail-closed 送下游
	// （不静默跳过 AST，避免危险命令因类型异常绕过检查）。
	logger.warn(
		"bash tool received non-string command (skipping AST analysis, fail-closed: forwarded to downstream layers)",
		{ type: typeof cmd },
	);
	return undefined;
}
