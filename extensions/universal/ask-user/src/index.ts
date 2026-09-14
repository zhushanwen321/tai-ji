// src/index.ts
import { Box, Text, TruncatedText, truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentToolResult, AgentToolUpdateCallback, ExtensionAPI, ExtensionContext, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { type Static } from "typebox";
import {
	type AskUserAnswers,
	askUserInteract,
	type AskUserQuestion,
	getAskUserAnswer,
	getAskUserOther,
} from "@xyz-agent/extension-protocol";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";

import { createAskUserChannelHandler } from "./channel-handler";
import { registerAskUserChannelHandler } from "./channel-registry-register";
import { AskUserComponent } from "./component";
import { answerValueText } from "./submit-view";
import {
	type AnswerValue,
	type AskUserDetails,
	HEADER_MAX_CHARS,
	InputSchema,
	type Option,
	type Question,
	type Result,
	type ThemeLike,
} from "./types";
import { validateInput } from "./validate";

/**
 * execute 的返回形状：复用 SDK AgentToolResult<AskUserDetails>。
 * SDK 的 AgentToolResult 类型未声明 isError（pi-agent-core types.d.ts:316-334）——
 * 因为 pi 契约里返回值不携带错误标记：execute 只有 throw 才被置 isError:true
 * （agent-loop.js:453-483），返回值里的 isError 字段会被丢弃（W4 修复前曾误用）。
 * 取消（用户取消 / abort）不是错误，正常返回 cancelled result。
 */
type ExecuteResult = AgentToolResult<AskUserDetails>;

/** 禁用 ask_user 工具（headless / RPC 通道不可用时调用，防 LLM 反复重试）。 */
function disableAskUser(pi: ExtensionAPI): void {
	pi.setActiveTools(
		pi
			.getAllTools()
			.map((t: { name: string }) => t.name)
			.filter((n: string) => n !== "ask_user"),
	);
}

/** 构造 cancelled 结果（用户取消 / abort 共用；错误路径已改为 throw，不走此函数）。 */
function cancelledResult(questions: Question[], text: string): ExecuteResult {
	return {
		content: [{ type: "text" as const, text }],
		details: { questions, answers: {}, cancelled: true } satisfies Result,
	};
}

/** TUI 模式交互（自定义 Component 实时交互）。 */
async function runTuiInteraction(
	questions: Question[],
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<Result | null> {
	return ctx.ui.custom<Result | null>(
		(tui: unknown, theme: unknown, _kb: unknown, done: (r: Result | null) => void) => {
			const comp = new AskUserComponent(
				questions,
				tui as { requestRender(): void },
				theme as ThemeLike,
				done,
			);
			// signal abort 监听（spec FR-10）：走组件 cancel() 复用 _resolved 守卫，
			// 避免用户已 submit/cancel 后 signal 才 abort 二次调 done（FR-12 竞态）
			if (signal) {
				signal.addEventListener("abort", () => comp.cancel(), { once: true });
			}
			return comp;
		},
		// 不传 options → inline 渲染（spec FR-3）
	);
}

/**
 * expanded 渲染辅助：展开某问题的全部选项，用 ●/○ 标记是否被选中（spec FR-9）。
 * 选中判定：直接读结构化 AnswerValue.selected（Set 精确匹配，无文本解析）。
 * 返回 TruncatedText 数组供 box.addChild 展开。
 */
function renderExpandedOptions(
	q: Question,
	answer: AnswerValue | undefined,
	theme: ThemeLike,
): TruncatedText[] {
	const selectedSet = new Set(answer?.selected ?? []);
	const mark = (opt: Option): string =>
		selectedSet.has(opt.label)
			? theme.fg("success", "●")
			: theme.fg("dim", "○");
	// 只展开真实选项（不含自动追加的 Other）；Other 文本单独显示
	const out: TruncatedText[] = q.options.map(
		(opt: Option) =>
			new TruncatedText(
				theme.fg("dim", "   ") +
					mark(opt) +
					theme.fg("text", ` ${opt.label}`),
				0,
				0,
			),
	);
	return out;
}

/**
 * 把 ask-user 内部 Question[] 映射为协议包 AskUserQuestion[]（RPC 交互声明）。
 *
 * ask-user 的 Question.options 只有 label/description（协议 AskUserOption 也无 value
 * 字段——回传值统一用 label，与 ask-user 语义一致）。
 * allowOther 固定 true：ask-user 无条件自动追加 Other（schema 不暴露此字段）。
 */
function toProtoQuestions(questions: Question[]): AskUserQuestion[] {
	return questions.map((q: Question) => ({
		header: q.header,
		question: q.question,
		context: q.context,
		options: q.options.map((o: Option) => ({
			label: o.label,
			description: o.description,
		})),
		multiSelect: q.multiSelect,
		allowOther: true,
	}));
}

/**
 * 把协议包 AskUserAnswers 转换为 ask-user 内部 Result.answers（结构化 AnswerValue）。
 *
 * 协议格式：key=header/question, 单选=string, 多选=JSON数组, Other=__other
 * ask-user 格式：key=question 全文, value=AnswerValue（selected=label 数组、other=自由文本）
 *
 * 解码走协议包 helper（getAskUserAnswer/getAskUserOther，proto 格式的唯一解码 SSOT）；
 * selected 空 && other 无 → 该问题未答，跳过不写入。
 */
function protoAnswersToResult(
	questions: Question[],
	protoQuestions: AskUserQuestion[],
	answers: AskUserAnswers,
): Record<string, AnswerValue> {
	const out: Record<string, AnswerValue> = {};
	for (let i = 0; i < questions.length; i++) {
		const q = questions[i]!;
		const iq = protoQuestions[i]!;
		const selected = getAskUserAnswer(answers, iq);
		const other = getAskUserOther(answers, iq) ?? null;

		let selectedArr: string[];
		if (Array.isArray(selected)) {
			// 多选按 question.options 中的定义顺序排序（S#3），
			// 与 TUI 版 submit-view.ts 的 selectedIndices.sort() 语义一致，
			// 确保 RPC 和 TUI 产出相同顺序（"A, C" 而非前端回传顺序的 "C, A"）。
			const orderMap = new Map(q.options.map((o: Option, idx: number) => [o.label, idx]));
			const unknownOrder = q.options.length;
			selectedArr = [...selected].sort((a, b) => {
				const ai = orderMap.get(a) ?? unknownOrder;
				const bi = orderMap.get(b) ?? unknownOrder;
				return ai - bi;
			});
		} else if (selected) {
			selectedArr = [selected];
		} else {
			selectedArr = [];
		}

		// selected 空 && other 无 → 该问题未答，跳过不写入（与 TUI buildResult 一致）
		if (selectedArr.length === 0 && other === null) continue;
		out[q.question] = { selected: selectedArr, other };
	}
	return out;
}

/**
 * RPC 模式（xyz-agent GUI）交互入口。
 *
 * 走 askUserInteract（select 通道 + ASK_USER_MARKER），前端 AskUserOverlay 渲染富交互 UI。
 * 返回 Result（正常/取消），或抛错（select 异常 / 非 RPC 模式调用了此函数）。
 *
 * 注意：从 ExtensionContext 构造 GuiContext 子集传入，而非直接传 ctx——
 * ExtensionContext.ui.custom 的泛型签名与 GuiContext.ui.custom 不兼容（前者复杂泛型，后者简化签名），
 * 直接传会导致类型不兼容。GuiContext 只需要 mode/hasUI/ui.select，构造最小子集避免签名冲突。
 */
async function runRpcInteraction(
	questions: Question[],
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<Result> {
	const protoQuestions = toProtoQuestions(questions);
	const guiCtx = {
		mode: ctx.mode,
		hasUI: ctx.hasUI,
		ui: { select: ctx.ui.select.bind(ctx.ui) },
	};
	const answers = await askUserInteract(guiCtx, protoQuestions, { signal, allowCancel: true });

	if (answers === null) {
		return { questions, answers: {}, cancelled: true };
	}
	return {
		questions,
		answers: protoAnswersToResult(questions, protoQuestions, answers),
		cancelled: false,
	};
}

export default function (pi: ExtensionAPI): void {
	// 注册 ask_user channel handler：把 subagent 子进程的 ask_user 请求透传到主进程 UI。
	//
	// 跨扩展握手协议（PR #85 #M4）：通过 globalThis Symbol.for 约定 slot 形状
	//（CHANNEL_HANDSHAKE_KEY，与 packages/subagent-core/src/execution/assembly/channel-registry-access.ts
	// 用同一字符串 key），不依赖 dynamic import npm 包名（两个扩展都通过
	// ~/.pi/agent/extensions/ symlink 加载，互相之间无法用 npm 包名 import）。
	//
	// 握手流程（registerAskUserChannelHandler 内部完成）：
	//   1. 读 slot；不存在或 version 不兼容 → 建 slot（仅 pending，**永不建 registry**）
	//   2. slot.registry 就绪（承载 packages/subagent-core 的 subagent-workflow 扩展先到）→ 直接调 registry.register
	//   3. slot.registry 未就绪 → handler 入 pending，等 subagent-core flush
	// ask-user 永不创建 registry 实例——canonical registry 仅 packages/subagent-core 创建
	//（execution/ui/ui-channels.ts 的 createUiChannelRegistry）。
	pi.on("session_start", (_event, ctx) => {
		registerAskUserChannelHandler(createAskUserChannelHandler(ctx));
	});

	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description: `Ask the user to resolve ambiguity you cannot resolve yourself. Use ONLY when ALL hold: (1) the request has ≥2 reasonable approaches, (2) you have already gathered context (read/grep) and the answer is still genuinely ambiguous, and (3) picking wrong means redoing real work. One question = one decision with mutually exclusive options.

Do NOT use this tool to outsource judgment you should make — if you can form a defensible recommendation from the codebase, proceed and state your choice. Do NOT use for trivia answerable by reading code/docs, or for simple confirmations ("I'll delete X") where plain text suffices. You cannot use this tool to collect free-form requirements, long-form feedback, or multi-paragraph input — it returns short selections only.

If you recommend an option, prefix its label with "(Recommended)" and list it first. For structured multi-option decisions, prefer this tool over plain-text questions; for everything else, reply in plain text.

Examples:
{"questions":[{"question":"Which DB?","context":"Need ACID + JSON columns.","options":[{"label":"(Recommended) Postgres","description":"Mature, strong consistency."},{"label":"SQLite","description":"Zero-ops, embedded."}]}]}

{"questions":[{"header":"DB","question":"Which database?","options":[{"label":"Postgres","description":"..."},{"label":"SQLite","description":"..."}]},{"header":"Region","question":"Which region?","options":[{"label":"us-east-1","description":"..."},{"label":"eu-west-1","description":"..."}]}]}

Don't:
- Passing options as a string array ("options":["A","B"]) — each option must be {"label","description"}.
- Forgetting header in multi-question mode (questions.length > 1).
- Flattening question/header/options to the top level — wrap them in questions:[...].
- Including an "Other" option — it is added automatically.`,
		promptSnippet:
			"Ask the user structured clarifying questions with options — only when you cannot resolve the ambiguity yourself",
		promptGuidelines: [
			"Use ask_user only when the request has ≥2 reasonable approaches you cannot resolve from context. Models over-ask because asking feels safer than deciding — resist this: if context makes the answer clear, proceed without asking.",
			"Gather context first (read/grep) and pass a short summary via the context field — don't ask blind. If the answer becomes clear after gathering context, proceed and state your choice.",
			"Ask focused questions; each question = one decision with mutually exclusive options. Batch related decisions into one call (1-4 questions).",
			"Do NOT use ask_user for trivia answerable by reading code/docs, or to confirm simple actions ('I'll delete X') — plain text suffices there.",
			"Do NOT outsource judgment you can make yourself: if you can form a defensible recommendation from the codebase, proceed and state it instead of asking.",
			"Do NOT include an 'Other' option yourself — it is always available automatically.",
		],
		parameters: InputSchema,

		async execute(
			_toolCallId: string,
			params: Static<typeof InputSchema>,
			signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<AskUserDetails> | undefined,
			ctx: ExtensionContext,
		): Promise<ExecuteResult> {
			const questions = params.questions as Question[];

			// 1. 参数校验（spec FR-2）。validateInput 接收宽松 InputQuestion[]：
			// options 可能含 string 误用（schema 已故意放宽以抵达这里的友好文案），
			// validateInput 会先拦截 string options 再跑其余校验。通过后 questions 已是干净 Question[]。
			const validationError = validateInput(questions);
			if (validationError) {
				// 错误路径 throw（W4）：pi 只对 execute throw 置 isError:true，
				// return {isError:true} 会被 agent-loop 丢弃（错误轮被标成功）。
				throw new Error(`Error: ${validationError}`);
			}

			// 2. Headless 检查（spec FR-8）：mode 非 tui 非 rpc = 无交互通道。
			// 先 disableAskUser 收尾（防 LLM 反复重试），再 throw——pi catch 后文案原样进 toolResult。
			if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
				disableAskUser(pi);
				throw new Error(
					"Error: ask_user requires an interactive session. The tool has been disabled for this session. Do not retry — proceed without user input (make a defensible decision and state it) or wait for the user to reconnect.",
				);
			}

			// 3. Signal abort 入口检查（spec FR-10）。
			// abort 是 agent 被外部终止（goal 取消 / context compact / session 切换），
			// 不是用户意图——文案必须区别于 step 5 的用户取消，避免 LLM 俊等用户。
			if (signal?.aborted) {
				return cancelledResult(
					questions,
					"Agent aborted (goal cancelled, context compacted, or session switched). Do not assume an answer; do not retry ask_user — propagate the abort, or wait for new instructions if the decision is still required.",
				);
			}

			// 4. 交互执行：TUI 走 ctx.ui.custom，RPC（xyz-agent GUI）走 askUserInteract。
			// 注意：hasUI 在 TUI 和 RPC 模式都为 true（dialog-capable），不能用于区分——
			// 用 ctx.mode === 'rpc' 判定 GUI 渲染通道。
			const useRpc = ctx.mode === "rpc";
			let result: Result | null;
			try {
				result = useRpc
					? await runRpcInteraction(questions, signal, ctx)
					: await runTuiInteraction(questions, signal, ctx);
			} catch (err) {
				// RPC 通道不可用（真 headless / select 缺失）→ 禁用工具（spec FR-8）。
				// TUI 分支不禁用——custom 抛错通常是组件临时故障，允许 LLM 重试。
				// 禁用收尾先行，再 throw（W4）：pi catch 后文案原样成为 toolResult content。
				const message = toErrorMessage(err);
				if (useRpc) disableAskUser(pi);
				throw new Error(
					useRpc
						? `ask_user failed: ${message}. The tool has been disabled for this session. Do not retry — proceed without user input (make a defensible decision and state it) or wait for the user to reconnect.`
						: `ask_user failed: ${message}. Treat as cancelled — do not assume an answer; retry the call with corrected parameters, or proceed with a defensible decision if the user cannot be reached.`,
				);
			}

			// 5. 取消（null / cancelled）
			if (result === null || result.cancelled) {
				return cancelledResult(
					questions,
					"User cancelled. Do not assume an answer or continue the task — wait for new instructions or re-ask with refined options if the decision is still required.",
				);
			}

			// 6. 正常返回
			const summary = result.questions.map((q: Question) => {
				const av = result!.answers[q.question];
				return `"${q.question}" = "${av ? answerValueText(av) : "(no answer)"}"`;
			});
			return {
				content: [{ type: "text" as const, text: summary.join("\n") }],
				details: result satisfies Result,
			};
		},

		renderCall(args: Static<typeof InputSchema>, theme: ThemeLike) {
			// args 来自 LLM 原始入参（options 可能是 string），只读 header/question 不碰 options。
			const questions = (args.questions ?? []) as Question[];
			const topics = questions.map((q) => q.header ?? truncateToWidth(q.question, HEADER_MAX_CHARS)).join(", ");
			return new TruncatedText(
				theme.fg("toolTitle", theme.bold("ask_user ")) + theme.fg("muted", topics),
				0,
				0,
			);
		},

		renderResult(
			result: AgentToolResult<AskUserDetails>,
			options: ToolRenderResultOptions,
			theme: ThemeLike,
		) {
			const details = result.details;
			// 错误路径已全部改 throw（W4）：pi 置 isError:true 后 details 为空对象，
			// 不存在 ErrorDetails 形态——这里 details 要么 undefined 要么 Result
			const d = details as Result | undefined;
			if (!d || d.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const box = new Box(0, 0);
			for (const q of d.questions) {
				const header = q.header ?? truncateToWidth(q.question, HEADER_MAX_CHARS);
				const answer = d.answers[q.question];
				const answerText = answer ? answerValueText(answer) : "(no answer)";
				box.addChild(
					new TruncatedText(
						theme.fg("success", "✓ ") +
							theme.fg("accent", `${header}: `) +
							theme.fg("text", answerText),
						0,
						0,
					),
				);
				// options.expanded：展开显示该问题全部选项 + ●/○ 选中标记（spec FR-9）
				if (options?.expanded) {
					for (const child of renderExpandedOptions(q, answer, theme)) box.addChild(child);
				}
			}
			return box;
		},
	});
}
