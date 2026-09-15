/**
 * goal_control tool — agent 控制入口（create / complete / report_blocked）
 *
 * #3：替代已删除的 goal_manager tool。
 *
 * 职责分层：
 * - execute 层（adapter 职责）：signal 守卫
 * - handler 层（goal 业务，契约对齐 code-architecture §3 handleCreate/handleComplete/handleReportBlocked）：
 *   active 守卫 + evidence/reason 空串校验 + 状态转换
 *
 * 全解耦：goal 不再读 todo/plan 状态。complete 不做 todo 完成前置硬检查——
 * todo 是否全完成由 AI 自行判断，goal 仅通过 prompt 软建议（见 prompts.ts）。
 *
 * 复用 engine/service 既有函数，不重写：
 * - create: service.createGoal（FR-3.1 唯一创建入口；非终态旧 goal 拒绝，对齐 D25 / Codex create_goal）
 * - complete: finalizeAndPersist(state, "complete", ...)（内部已含 tickState → finalizeGoal → persist）
 * - report_blocked: 手动 tickState（status 仍 active 才累加当前运行段）→ transitionStatus(active→blocked) → persistState
 *
 * create 不调 sendUserMessage：toolcall 时 AI 已在 turn 中，返回结果后自行续跑
 * （与 /goal set 的 followUp 触发区分；对齐 Codex create_goal 不自动续跑）。
 *
 * schema：扁平 Type.Object（OpenAI 兼容，C3）——parameters 顶层必须是 type:"object"，
 * 顶层 Type.Union 序列化后只有 anyOf 无 type，会被严格 OpenAI 兼容网关 400 拒绝。故采用
 * 扁平 Object + action 字段级 Type.Union（等价 enum）+ 各字段 Optional + additionalProperties:false。
 * 分支隔离从 schema 层降级为运行时 handler 字段存在性校验（见各 handler 开头）；
 * pi 生产校验器为 typebox/compile 的 Compile(schema).Check(args)，缺失/错误 action、额外字段
 * 在 schema 层拒绝，缺必填字段由 handler 校验兜底。
 *
 * executionMode: "sequential"——状态变更 tool，不可与同批其他 tool 并行执行。
 *
 * 错误处理：用 throw new Error（extension-conventions.md Tool 设计规范），不返回错误成功模式。
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

import { SHORT_ID_LENGTH } from "../constants";
import { isActiveStatus, isTerminalStatus, transitionStatus } from "../engine/goal";
import type { BudgetConfig, GoalStatus } from "../engine/types";
import { updateWidget } from "../projection/widget";
import { createGoal, finalizeAndPersist, persistState, type ServicePorts, tickState } from "../service";
import type { GoalSession } from "../session";
import { buildPorts } from "./ports";
import { CRITERIA_HINTS_TOOL, validateSuccessCriteriaItems } from "./success-criteria";

// ── Params schema（扁平 Type.Object，OpenAI 兼容）────────────

/**
 * goal_control 参数 schema。扁平 Type.Object + action 字段级 Type.Union（等价 enum）。
 *
 * OpenAI function calling 规范要求 parameters 顶层必须是 type:"object"；顶层 Type.Union
 * 序列化后只有 anyOf 无 type 字段，会被严格的 OpenAI 兼容网关 400 拒绝整个会话。故采用
 * 扁平 Object + action enum，分支隔离从 schema 层降级为运行时 handler 字段存在性校验
 * （见各 handler 开头）。范式对齐 scheduler ScheduleControlParams。
 *
 * additionalProperties:false 阻挡未知字段；缺失/错误 action 仍由 schema 层拒绝。
 */
export const GoalControlParams = Type.Object(
	{
		action: Type.Union(
			[Type.Literal("create"), Type.Literal("complete"), Type.Literal("report_blocked")],
			{ description: "create | complete | report_blocked" },
		),
		slug: Type.Optional(
			Type.String({
				description: "可选。状态栏标题用的短 kebab-case 标识，仅用于显示，不注入 prompt。",
			}),
		),
		objective: Type.Optional(
			Type.String({
				description:
				"必填。用你自己的话重述真实目标——用户实际想要达成什么，而非字面复述请求。模糊时推断最可能的意图并明确陈述。",
			}),
		),
		successCriteria: Type.Optional(
			Type.Array(
				Type.String({ minLength: 1, pattern: "^[^\\r\\n]+$" }),
				{
					minItems: 1,
					maxItems: 8,
					description:
						"必填。可检查的完成条件数组（1~8 条、每条单行短条件）。" +
						"高层终态条件（如「测试通过」「文件 X 存在且含内容 Y」「命令 Z 输出 W」），" +
						"不是愿景或「能用就行」。细粒度检查清单放 todo/plan，只引用不复制。" +
						"禁止倾倒完整规格——每条 ≤80 字符，面向用户可感知的终态。" +
						"这是 complete 前必须逐条满足的门槛。",
				}
			),
		),
		tokenBudget: Type.Optional(
			Type.Number({
				description:
					"可选。新目标的 token 预算（正数）。默认不设——仅在用户明确要求（如「控制在 1 万 token 内」）或你已获得用户明确同意时才设。切勿自行决定设置预算。",
			}),
		),
		evidence: Type.Optional(
			Type.String({
				description:
				"必填。具体完成证据（改动/新建的文件、通过的测试、运行的命令）。不要基于假设、意图或部分进度标记完成。",
			}),
		),
		reason: Type.Optional(
			Type.String({
				description:
				"必填。具体阻塞条件及已尝试的方案。不要用于不确定、困难、缓慢或未完成的工作——继续做。",
			}),
		),
	},
	{ additionalProperties: false },
);

export type GoalControlParamsT = Static<typeof GoalControlParams>;

// ── Details（renderResult 数据来源）──────────────────

export interface GoalControlDetails {
	action: "create" | "complete" | "report_blocked";
	goalId: string;
	status: GoalStatus;
	slug?: string;
}

// ── 业务 handler（契约对齐 §3，可测：fake ports）──────

/**
 * create 业务逻辑：objective + successCriteria 必填（schema 层已强制，此处仅校验空串）
 * + 非终态旧 goal 守卫 + service.createGoal。
 *
 * slug：AI 生成的短标识，仅 widget 标题 + history 用，不注入 prompt。真 optional。
 * objective：完整描述，注入每轮 context prompt（保证方向感）。
 *
 * 全解耦：不读 todo/plan。toolcall 时 AI 已在 turn 中，**不**调 sendUserMessage
 * （AI 返回后自行续跑，对齐 Codex create_goal）。
 *
 * 守卫用 D25 严格语义：非终态 active/paused/blocked 全挡，提示用 /goal resume 或
 * /goal clear——防 AI 静默覆盖含未完成工作的 goal。
 * 终态旧 goal 走 createGoal 快速路径覆盖（createGoal 内部 active 守卫，终态可覆盖）。
 *
 * 参数校验拆分至 requireCreateObjective / requireCreateSuccessCriteria /
 * resolveCreateBudget（圈复杂度拆分），校验顺序与错误消息不变。
 */
/** create 的 objective 校验（schema optional 兜底）：必填 + 非空串，返回 trim 后值。 */
function requireCreateObjective(params: GoalControlParamsT): string {
	if (params.objective === undefined) {
		throw new Error("'objective' required for create. Correct: {\"action\":\"create\",\"objective\":\"...\",\"successCriteria\":[\"<condition 1>\",\"<condition 2>\"]}");
	}
	const objective = params.objective.trim();
	if (!objective) {
		// schema 已放行（扁平化后 optional），此处挡空串（LLM 可能传空串）
		throw new Error(
			"'objective' must not be empty. Describe the concrete objective to pursue. Correct: {\"action\":\"create\",\"slug\":\"<kebab-case>\",\"objective\":\"<concrete objective>\",\"successCriteria\":[\"<condition 1>\",\"<condition 2>\"]}",
		);
	}
	return objective;
}

/**
 * create 的 successCriteria 校验：必填 + 非空数组 + 逐条 string/非空/单行，返回 trim 后数组。
 * 逐条校验共享 validateSuccessCriteriaItems（与 /goal update 同规则），tool 通道正例
 * 见 CRITERIA_HINTS_TOOL；校验顺序与错误消息不变。
 */
function requireCreateSuccessCriteria(params: GoalControlParamsT): string[] {
	if (params.successCriteria === undefined) {
		throw new Error("'successCriteria' required for create. Correct: {\"action\":\"create\",\"objective\":\"...\",\"successCriteria\":[\"<condition 1>\",\"<condition 2>\"]}");
	}
	const successCriteriaRaw = params.successCriteria;
	if (!Array.isArray(successCriteriaRaw) || successCriteriaRaw.length === 0) {
		throw new Error(
			"'successCriteria' must be a non-empty array of 1~8 checkable conditions. Correct: {\"action\":\"create\",\"slug\":\"refactor-auth\",\"objective\":\"...\",\"successCriteria\":[\"tests pass\",\"tsc clean\",\"src/auth.ts uses JWT\"]}",
		);
	}
	return validateSuccessCriteriaItems(successCriteriaRaw, CRITERIA_HINTS_TOOL);
}

/** create 的 budget 解析：非法预算直接拒绝（不静默截断），未提供时返回空配置。 */
function resolveCreateBudget(params: GoalControlParamsT): Partial<BudgetConfig> {
	const budget: Partial<BudgetConfig> = {};
	if (params.tokenBudget === undefined) {
		return budget;
	}
	if (params.tokenBudget <= 0) {
		throw new Error("'tokenBudget' must be greater than 0.");
	}
	budget.tokenBudget = params.tokenBudget;
	return budget;
}

export function handleCreate(
	params: GoalControlParamsT,
	session: GoalSession,
	ports: ServicePorts,
): GoalControlDetails {
	const objective = requireCreateObjective(params);
	// slug 真 optional（TC11）：缺失时 fallback goalId 截断（与 buildGoalGui 口径一致），不强制必填
	const slugInput = params.slug?.trim();
	const successCriteria = requireCreateSuccessCriteria(params);

	// D25 严格守卫：非终态旧 goal（active/paused/blocked）→ 拒绝创建（防静默覆盖未完成工作）
	if (session.state && !isTerminalStatus(session.state.status)) {
		throw new Error(
			`Goal already active (status: ${session.state.status}). Use /goal resume to continue or /goal clear to reset before creating a new one.`,
		);
	}

	// budget 校验：非法预算直接拒绝，不静默截断
	const budget = resolveCreateBudget(params);

	// FR-3.1: 唯一创建入口。终态旧 goal 走覆盖快速路径。
	const created = createGoal(session, objective, budget, ports, slugInput, successCriteria);
	if (!created) {
		// createGoal 内部 active 守卫兜底（理论上上面守卫已挡；防御性）
		throw new Error("Goal already active. Cannot create a new one.");
	}
	updateWidget(session, ports.ui);

	const state = session.state!;
	// slug fallback：未提供时用 goalId 截断作标题（与 buildGoalGui 一致，避免 [undefined]）
	const slug = state.slug ?? state.goalId.slice(0, SHORT_ID_LENGTH);
	const budgetNotice: string[] = [];
	if (budget.tokenBudget) budgetNotice.push(`Token budget: ${budget.tokenBudget}`);
	ports.ui.notify([`Goal created [${slug}]: ${objective}`, ...budgetNotice].join("\n"), "info");

	return { action: "create", goalId: state.goalId, status: state.status, slug };
}

/**
 * complete 业务逻辑：active 守卫 + evidence 空串校验 + finalizeAndPersist。
 *
 * 全解耦后不再做 todo 完成前置检查——todo 是否全完成由 AI 自行判断（prompt 软建议）。
 */
export function handleComplete(
	params: GoalControlParamsT,
	session: GoalSession,
	ports: ServicePorts,
): GoalControlDetails {
	const state = session.state;
	if (!state) throw new Error("Goal mode not active.");
	if (!isActiveStatus(state.status)) {
		throw new Error(`Goal is not active (status: ${state.status}). Only an active goal can be completed.`);
	}
	if (params.evidence === undefined) {
		throw new Error("'evidence' required for complete. Correct: {\"action\":\"complete\",\"evidence\":\"...\"}");
	}
	const evidence = params.evidence.trim();
	if (!evidence) {
		throw new Error(
			"'evidence' must not be empty. Provide concrete completion evidence. Correct: {\"action\":\"complete\",\"evidence\":\"Modified src/auth.ts; pnpm test auth passed (12/12); tsc --noEmit clean.\"}",
		);
	}

	// FR-3.3: 唯一终态序列入口（内部：tickState → finalizeGoal(transition+history) → persist）
	finalizeAndPersist(state, "complete", ports);
	updateWidget(session, ports.ui);
	ports.ui.notify(`Goal completed: ${state.objective}`, "info");

	return { action: "complete", goalId: state.goalId, status: state.status };
}

/**
 * report_blocked 业务逻辑：active 守卫 + reason 空串校验 + tickState + transitionStatus + persistState。
 *
 * 必须在 transitionStatus **之前** tickState，使 tick 看到 active 状态并累加当前运行段；
 * 否则转 blocked 后 persistState 内部的 tick 因 status≠active 不累加，丢失最后一段运行时间。
 */
export function handleReportBlocked(
	params: GoalControlParamsT,
	session: GoalSession,
	ports: ServicePorts,
): GoalControlDetails {
	const state = session.state;
	if (!state) throw new Error("Goal mode not active.");
	if (state.status !== "active") {
		throw new Error(`Goal is not active (status: ${state.status}). Only an active goal can report_blocked.`);
	}
	if (params.reason === undefined) {
		throw new Error("'reason' required for report_blocked. Correct: {\"action\":\"report_blocked\",\"reason\":\"...\"}");
	}
	const reason = params.reason.trim();
	if (!reason) {
		throw new Error(
			"'reason' must not be empty. Describe the blocking condition and what you tried. Correct: {\"action\":\"report_blocked\",\"reason\":\"<blocker + what you tried>\"}",
		);
	}

	state.lastBlockerReason = reason;
	// 先 tickState 累加当前运行段（此时 status 仍为 active）
	tickState(state);
	state.status = transitionStatus(state.status, "blocked");

	persistState(session, ports);
	updateWidget(session, ports.ui);
	ports.ui.notify(`Goal blocked: ${reason}`, "warning");

	return { action: "report_blocked", goalId: state.goalId, status: state.status };
}

/** renderResult 的 result 是否含 details 字段（类型守卫，替代全可选结构断言 as {details?}）。
 * 收紧：除检查 "details" in r 外，还验证其值为 object 或 undefined（防 details 是 string/number
 * 时下游读 d.status 得到 undefined 却被类型系统当作 GoalControlDetails）。 */
function hasGoalDetails(r: unknown): r is { details?: GoalControlDetails } {
	if (typeof r !== "object" || r === null || !("details" in r)) return false;
	const d = (r as Record<string, unknown>).details;
	return d === undefined || typeof d === "object";
}

// ── Tool 注册 ────────────────────────────────────────

export function registerGoalControlTool(pi: ExtensionAPI, session: GoalSession): void {
	pi.registerTool({
		name: "goal_control",
		label: "Goal Control",
		description: `管理当前会话的目标（goal）。目标用于追踪需要完成验证的复杂工作。

预算策略：默认不设 tokenBudget。仅在用户明确要求（如「控制在 1 万 token 内」）或用户的指令明确暗示了一个限制时才设。若你认为应该设预算但用户从未提及，先询问用户获得明确同意，切勿自行决定。

动作：
- create：为复杂的多步骤工作（3+ 步骤、多文件改动、或需要完成验证的工作）主动创建目标。用自己的话重述真实目标，定义可检查的 successCriteria（完成条件数组，3~8 条高层终态条件）。细粒度检查清单放 todo/plan，只引用不复制。禁止倾倒完整规格。琐碎的单步任务、普通提问、查找类任务不要创建目标。若已有 active/paused/blocked 目标会失败——请让用户运行 /goal resume 或 /goal clear 后再创建。
- complete：标记当前 active 目标完成。需要 evidence（具体证据：改动的文件、通过的测试、运行的命令），且必须满足每条 successCriteria 条件。若有预算，在总结里报告最终 token 用量。不要基于假设、意图或部分进度标记完成。
- report_blocked：标记当前 active 目标被真实阻碍阻塞。需要 reason 描述阻塞条件和已尝试的方案。仅在穷尽替代方案后使用——不要用于困难、缓慢或不确定的工作。

控制权归属：
- pause/resume 和 budget 变更由用户经 /goal 命令控制，你不能修改。
- 达到阻塞阈值后报告，不要反复报告同一阻塞。

完成验证标准由你在 create 时定义的 successCriteria 决定——complete 时必须逐条满足。`,
		promptSnippet:
			"用 goal_control 管理会话目标：为复杂多步骤工作主动 create（含 slug + objective + successCriteria），达成时 complete（含满足每条 successCriteria 的 evidence），穷尽方案后 report_blocked（含 reason）。",
		// promptGuidelines：进 system prompt guidelines 段（强信号位）。
		// 三个 action 的正向触发引导——create（复杂任务主动启动）、complete（对照 successCriteria 验证达成）、
		// report_blocked（穷尽替代方案后）。措辞主动，给 system prompt 层常驻强信号。
		promptGuidelines: [
			// create：主动用于复杂多步骤任务。翻转原「显式启动」策略——让 goal 真正可用。
			// 门槛：3+ 步骤 / 多文件 / 需完成验证，避免对琐碎任务滥建 goal 变噪音。
			"create: proactively start a goal for complex, multi-step work (3+ steps, multi-file, or needs completion verification) — restate the real objective and define checkable successCriteria (3~8 high-level terminal conditions as string[]). Fine-grained checklists belong in todo/plan — reference them, do not copy. Do NOT dump full specs into successCriteria. Do NOT create for trivial single-step tasks, ordinary lookups, or when a goal is already active. Test: 'is this worth tracking to completion with verification?' — if yes, create a goal.",
			// budget：默认不设预算——仅当用户显式要求（或明确同意）时才设。
			// 对齐 description 的预算策略段 + tokenBudget 参数的 description（三层信号冗余）。
			"budget: never set tokenBudget on your own initiative — the default is no budget. Set a budget only when the user explicitly requested one (e.g. \"keep it under 10k tokens\") or you obtained explicit user consent first. If you think a budget is warranted but the user never mentioned one, ask the user before creating the goal.",
			// 全解耦下 todo 非硬前置——objective 实际达成才算（与 handleComplete「todo 由 AI 自判」一致）
			"complete: proactively call when the active goal's objective is actually achieved, not merely in progress. Evidence must be concrete artifacts (files changed, tests green, commands run) meeting every successCriteria condition. Finishing all todos (incl. verification todos) is the usual readiness signal, but the real bar is the objective being met — you decide.",
			// ≥3 distinct approaches 或同一 blocker 跨连续 turns（T7）；达到阈值后报告，不反复报告同一 blocker
			"report_blocked: proactively call when genuinely blocked after ≥3 distinct alternative approaches or when the same blocker persists across consecutive turns — not for hard/slow work or uncertainty. State the blocker and what you tried. Once the threshold is met, report — do not repeatedly report the same blocker. Do NOT silently stop or leave the goal hanging.",
		],
		executionMode: "sequential",
		parameters: GoalControlParams,

		async execute(
			_toolCallId: string,
			params: GoalControlParamsT,
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		): Promise<{ content: Array<{ type: "text"; text: string }>; details: GoalControlDetails }> {
			if (signal?.aborted) {
				throw new Error("goal_control aborted by signal.");
			}
			const ports = buildPorts(pi, ctx);

			let details: GoalControlDetails;
			if (params.action === "create") {
				details = handleCreate(params, session, ports);
			} else if (params.action === "complete") {
				// 全解耦：不再做 todo 完成前置硬检查。AI 自行判断 todo 是否全完成（prompt 软建议）。
				details = handleComplete(params, session, ports);
			} else {
				details = handleReportBlocked(params, session, ports);
			}

			// 扁平化后 params.objective/reason 为 string|undefined（schema 不再按 action 收窄）；
			// handler 已对必填字段做存在性校验，此处用 ?. 兜底，未定义时空串
			const text =
				params.action === "create"
					? `Goal created.\nGoal ID: ${details.goalId}\nSlug: ${details.slug ?? ""}\nObjective: ${params.objective?.trim() ?? ""}`
					: params.action === "complete"
						? `Goal completed.\nGoal ID: ${details.goalId}`
						: `Goal reported blocked.\nGoal ID: ${details.goalId}\nReason: ${params.reason?.trim() ?? ""}`;

			// 状态展示不再进 tool result（GUI 渲染字段已移除）：GUI 由 handle* 内的 updateWidget
			// 经 guiSetWidget 推送（M17 对话流 widget 面板）。
			return { content: [{ type: "text", text }], details };
		},

		renderCall(args: Record<string, unknown>, theme: Theme): Text {
			const action = args.action as string;
			const slug = typeof args.slug === "string" ? args.slug : "";
			const actionLabel =
				action === "create"
					? theme.fg("accent", "create") + (slug ? theme.fg("dim", ` ${slug}`) : "")
					: action === "complete"
						? theme.fg("success", "complete")
						: theme.fg("error", "report_blocked");
			return new Text(theme.fg("toolTitle", theme.bold("goal_control ")) + actionLabel, 0, 0);
		},

		renderResult(result: unknown, _options: { expanded: boolean }, theme: Theme): Text {
			const d = hasGoalDetails(result) ? result.details : undefined;
			if (!d) return new Text(theme.fg("dim", "goal_control"), 0, 0);
			const statusColor =
				d.status === "active"
					? "accent"
					: d.status === "complete"
						? "success"
						: d.status === "blocked"
							? "error"
							: "muted";
			const label = d.action === "create" ? "Created" : d.action === "complete" ? "Completed" : "Blocked";
			const slugSuffix = d.slug ? theme.fg("dim", ` ${d.slug}`) : "";
			return new Text(theme.fg(statusColor, `◆ Goal ${label}`) + slugSuffix, 0, 0);
		},
	});
}
