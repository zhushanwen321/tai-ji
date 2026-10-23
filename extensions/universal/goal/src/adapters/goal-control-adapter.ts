/**
 * goal_control tool — agent 控制入口（create / complete / report_blocked）
 *
 * #3：替代已删除的 goal_manager tool。
 *
 * 职责分层：
 * - execute 层（adapter 职责）：signal 检查
 * - handler 层（goal 业务，契约对齐 code-architecture §3 handleCreate/handleComplete/handleReportBlocked）：
 *   active 检查 + evidence/reason 空串校验 + 状态转换
 *
 * 全解耦：goal 不再读 todo/plan 状态。complete 不做 todo 完成前置硬检查——
 * todo 是否全完成由 AI 自行判断，goal 仅通过 prompt 软建议（见 prompts.ts）。
 *
 * 复用 engine/service 既有函数，不重写：
 * - create: service.createGoal（FR-3.1 唯一创建入口；非终态旧 goal 拒绝，对齐 D25 / Codex create_goal）
 * - complete: finalizeAndPersist(state, "complete", ...)（内部已含 tickState → finalizeGoal → persist）
 * - report_blocked: 手动 tickState（status 仍 active 才累加当前运行段）→ transitionStatus(active→blocked) → persistState
 *
 * create 不发消息注入：toolcall 时 AI 已在 turn 中，返回结果后自行续跑
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
import { resultContentText } from "@zhushanwen/extension-protocol";
import { getLogger } from "@zhushanwen/pi-extension-logger";
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
					"可选。新目标的 token 预算（正数）。默认不设——设置条件见 guidelines 的 budget 条目。",
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

const logger = getLogger("goal");

/**
 * 辅助 UI 通道降级包装：updateWidget / notify 失败只 warn 留痕不上抛。
 *
 * 调用点全部位于核心副作用（createGoal / finalizeAndPersist / persistState）之后——
 * 状态已落盘，UI 通道故障不能翻转工具结果（与 base-tool-enhance notify.ts 的接入点
 * 降级同构）。错误串格式化内联（Error message / String）而非复用
 * @zhushanwen/pi-ext-guards 的 toErrorMessage——不为一个一行 helper 引入运行时依赖。
 */
function runUiChannelSafe(action: GoalControlDetails["action"], goalId: string, fn: () => void): void {
	try {
		fn();
	} catch (err) {
		logger.warn(`goal_control ${action}: ui channel failed; persisted state unaffected`, {
			detail: { goalId, err: err instanceof Error ? err.message : String(err) },
		});
	}
}

// ── Details（renderResult 数据来源）──────────────────

export interface GoalControlDetails {
	action: "create" | "complete" | "report_blocked";
	goalId: string;
	status: GoalStatus;
	slug?: string;
	/** 收起态一行摘要（buildGoalControlSummary 产出；handler 返回后由 execute 统一补齐，
	 *  历史 entry 无此字段——GUI 收起态与 TUI 折叠态共用）。 */
	summary?: string;
}

/** 收起态摘要中 reason 的保留长度（超长截断加省略号）。 */
const BLOCKED_REASON_SUMMARY_CHARS = 40;

/** 多行文本 → 单行摘要文本（换行与连续空白折叠为单空格；plan tool.ts 同模式）。
 *  details.summary 单行契约见 extension-conventions.md「Tool result details.summary 约定」
 *  （自由文本 reason 可含 \n，截断前先归一）。 */
function toSingleLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** 码点安全截断到上限（超长补省略号；Array.from 按码点切分，emoji 代理对不劈半）。 */
function elide(text: string, max: number): string {
	const chars = Array.from(text);
	return chars.length > max ? chars.slice(0, max).join("") + "…" : text;
}

/** 收起态一行摘要：create → slug；complete → goalId（complete 的 details 无 slug）；
 *  report_blocked → reason 归一单行后码点安全截断（超长加省略号）。 */
export function buildGoalControlSummary(
	params: GoalControlParamsT,
	details: GoalControlDetails,
): string {
	switch (details.action) {
		case "create":
			return details.slug ? `Goal created: ${details.slug}` : "Goal created";
		case "complete":
			return `Goal completed: ${details.goalId}`;
		case "report_blocked": {
			const reason = toSingleLine(params.reason ?? "");
			if (reason === "") return "Blocked";
			return `Blocked: ${elide(reason, BLOCKED_REASON_SUMMARY_CHARS)}`;
		}
		default:
			return "Done";
	}
}

// ── 业务 handler（契约对齐 §3，可测：fake ports）──────

/**
 * create 业务逻辑：objective + successCriteria 必填（schema 层已强制，此处仅校验空串）
 * + 非终态旧 goal 检查 + service.createGoal。
 *
 * slug：AI 生成的短标识，仅 widget 标题 + history 用，不注入 prompt。真 optional。
 * objective：完整描述，注入每轮 context prompt（保证方向感）。
 *
 * 全解耦：不读 todo/plan。toolcall 时 AI 已在 turn 中，**不**发消息注入
 * （AI 返回后自行续跑，对齐 Codex create_goal）。
 *
 * 检查用 D25 严格语义：非终态 active/paused/blocked 全挡，提示用 /goal resume 或
 * /goal clear——防 AI 静默覆盖含未完成工作的 goal。
 * 终态旧 goal 走 createGoal 快速路径覆盖（createGoal 内部 active 检查，终态可覆盖）。
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

	// D25 严格检查：非终态旧 goal（active/paused/blocked）→ 拒绝创建（防静默覆盖未完成工作）
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
		// createGoal 内部 active 检查兜底（理论上上面检查已挡；防御性）
		throw new Error("Goal already active. Cannot create a new one.");
	}

	const state = session.state!;
	// slug fallback：未提供时用 goalId 截断作标题（与 buildGoalGui 一致，避免 [undefined]）
	const slug = state.slug ?? state.goalId.slice(0, SHORT_ID_LENGTH);
	const budgetNotice: string[] = [];
	if (budget.tokenBudget) budgetNotice.push(`Token budget: ${budget.tokenBudget}`);
	runUiChannelSafe("create", state.goalId, () => {
		updateWidget(session, ports.ui);
		ports.ui.notify([`Goal created [${slug}]: ${objective}`, ...budgetNotice].join("\n"), "info");
	});

	return { action: "create", goalId: state.goalId, status: state.status, slug };
}

/**
 * complete 业务逻辑：active 检查 + evidence 空串校验 + finalizeAndPersist。
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
	runUiChannelSafe("complete", state.goalId, () => {
		updateWidget(session, ports.ui);
		ports.ui.notify(`Goal completed: ${state.objective}`, "info");
	});

	return { action: "complete", goalId: state.goalId, status: state.status };
}

/**
 * report_blocked 业务逻辑：active 检查 + reason 空串校验 + tickState + transitionStatus + persistState。
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
	runUiChannelSafe("report_blocked", state.goalId, () => {
		updateWidget(session, ports.ui);
		ports.ui.notify(`Goal blocked: ${reason}`, "warning");
	});

	return { action: "report_blocked", goalId: state.goalId, status: state.status };
}

/** renderResult 的 result 是否含 details 字段（类型检查，替代全可选结构断言 as {details?}）。
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
		description: `管理当前会话的目标（goal）。目标用于追踪需要完成验证的复杂工作。动作：create（创建）| complete（完成）| report_blocked（阻塞报告）——各参数必填性与用法见 schema 字段说明，触发纪律见 guidelines。

控制权归属：pause/resume 和 budget 变更由用户经 /goal 命令控制，你不能修改。`,
		promptSnippet:
			"用 goal_control 管理会话目标：为复杂多步骤工作主动 create（含 slug + objective + successCriteria），达成时 complete（含满足每条 successCriteria 的 evidence），穷尽方案后 report_blocked（含 reason）。",
		// promptGuidelines：进 system prompt guidelines 段（强信号位）。
		// D1 单源化后本层是使用纪律的唯一承载位（何时该用/禁用什么）；字段语义
		// （参数是什么、必填性、合法值）单源在 schema 字段说明，此处不复述。
		promptGuidelines: [
			// create：主动用于复杂多步骤任务，翻转原「显式启动」策略——让 goal 真正可用。
			// 门槛：3+ 步骤 / 多文件 / 需完成验证，避免对琐碎任务滥建 goal 变噪音。
			// 非终态旧 goal 挡 create——恢复/清理由用户经 /goal 命令做。
			"create: proactively start a goal for complex, multi-step work (3+ steps, multi-file, or needs completion verification). Do NOT create for trivial single-step tasks, ordinary lookups, or when an active/paused/blocked goal already exists — creating then fails; ask the user to run /goal resume or /goal clear first. Test: 'is this worth tracking to completion with verification?' — if yes, create a goal.",
			// budget：默认不设预算——仅当用户显式要求（或明确同意）时才设（纪律单源位，
			// description 与 tokenBudget 参数说明不再复述）。
			"budget: never set tokenBudget on your own initiative — the default is no budget. Set a budget only when the user explicitly requested one (e.g. \"keep it under 10k tokens\") or you obtained explicit user consent first. If you think a budget is warranted but the user never mentioned one, ask the user before creating the goal.",
			// 全解耦下 todo 非硬前置——objective 实际达成才算（与 handleComplete「todo 由 AI 自判」一致）
			"complete: proactively call when the active goal's objective is actually achieved, not merely in progress. Evidence must meet every successCriteria condition — not assumptions, intent, or partial progress. Finishing all todos (incl. verification todos) is the usual readiness signal, but the real bar is the objective being met — you decide. If a budget was set, report the final token usage in your summary.",
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
			// 收起态一行摘要：details 追加 summary（现有字段保留），GUI 收起态与 TUI 折叠态共用
			details = { ...details, summary: buildGoalControlSummary(params, details) };

			// 扁平化后 params.objective/reason 为 string|undefined（schema 不再按 action 收窄）；
			// handler 已对必填字段做存在性校验，此处用 ?. 兜底，未定义时空串
			const text =
				params.action === "create"
					? `Goal created.\nGoal ID: ${details.goalId}\nSlug: ${details.slug ?? ""}\nObjective: ${params.objective?.trim() ?? ""}`
					: params.action === "complete"
						? `Goal completed.\nGoal ID: ${details.goalId}`
						: `Goal reported blocked.\nGoal ID: ${details.goalId}\nReason: ${params.reason?.trim() ?? ""}`;

			// 状态展示不再进 tool result（GUI 渲染字段已移除）：GUI 由 handle* 内的 updateWidget
			// 经 setWidgetDual 推送（GUI 臂 = guiSetWidget/marker 通道，低层原语不单独调用；
			// 渲染终点 = composer 任务托盘的协议 widget 区）。
			return { content: [{ type: "text", text }], details };
		},

		renderCall(args: Record<string, unknown>, theme: Theme): Text {
			// TUI 渲染先于 schema 校验（args 是未经 schema 收窄的原始形态）：非对象整体
			// 走安全占位（不抛错）；action/slug 逐个 typeof 检查替代裸断言——非法 action
			// 落 report_blocked 回落分支（与原行为一致）
			if (typeof args !== "object" || args === null) {
				return new Text(
					theme.fg("toolTitle", theme.bold("goal_control ")) + theme.fg("muted", "(invalid args)"),
					0,
					0,
				);
			}
			const action = typeof args.action === "string" ? args.action : "";
			const slug = typeof args.slug === "string" ? args.slug : "";
			const actionLabel =
				action === "create"
					? theme.fg("accent", "create") + (slug ? theme.fg("dim", ` ${slug}`) : "")
					: action === "complete"
						? theme.fg("success", "complete")
						: theme.fg("error", "report_blocked");
			return new Text(theme.fg("toolTitle", theme.bold("goal_control ")) + actionLabel, 0, 0);
		},

		renderResult(result: unknown, options: { expanded: boolean }, theme: Theme): Text {
			const d = hasGoalDetails(result) ? result.details : undefined;
			// 展开态 = content 纯文本（多行详情）；content 缺失时回退折叠形态
			if (options.expanded) {
				const content = resultContentText(result);
				if (content !== "") return new Text(content, 0, 0);
			}
			// 折叠态 = details.summary 一行（dim）；旧 entry 无 summary 时保留原 ◆ 状态行
			if (d?.summary !== undefined) {
				return new Text(theme.fg("dim", d.summary), 0, 0);
			}
			return renderLegacyGoalResult(d, theme);
		},
	});
}

/** 旧形态回退（details 无 summary 的历史 entry）：原 ◆ 状态行，视觉零变化。 */
function renderLegacyGoalResult(d: GoalControlDetails | undefined, theme: Theme): Text {
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
}
