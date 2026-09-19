// src/channel-handler.ts
//
// ask_user channel handler：把 subagent 子进程的 ask_user 请求透传到主进程 UI 渲染。
//
// 设计（关键决策）：uiFormInteract（@zhushanwen/extension-protocol）只在 RPC 模式可用
// （内部 isGuiCapable 检查 mode==='rpc'，TUI 下抛错）。所以 handler 按 ctx.mode 分流：
//   - RPC：转发器——调 uiFormInteract(guiCtx, formQuestions)，复用 select 通道 +
//     UI_FORM_MARKER 契约，主进程 ctx.ui.select 经 GUI sidecar 渲染（不进 parseSpawnLine，
//     不循环）。返回 {value: JSON.stringify(answers)} 让子进程 JSON.parse(value) decode。
//   - TUI：走 ctx.ui.custom + AskUserComponent。三步：(1) formQuestions → 内部 Question[]，
//     (2) ctx.ui.custom 渲染拿内部 Result，(3) 内部 Result.answers（key=question 全文，
//     value=结构化 AnswerValue）→ 用 encodeAnswer 重新编码为 proto FormAnswers
//     （key=header/question，单选=string，多选=JSON 数组，Other→__other），让子进程 decode 一致。
//
// D9 双名双读（subagent 间接链双维兼容）：subagent 孙进程跑 npm 版 ask-user，版本不可控——
//   - channel 名由 marker 派生（subagent-engine-sdk ui-channels.ts normalizeChannelName：
//     剥 \x00TAIJI_ 前缀 + 小写化）——新孙进程发 ui_form、旧孙进程发 ask_user，
//     channel-registry-register 双名注册两代通道，本 handler 同一实现服务两名；
//   - 入口 payload 双读 `formQuestions ?? questions`：新 payload {formQuestions: FormQuestion[]}
//     （逐项 isFormQuestion 守卫过滤），旧 payload {questions: AskUserQuestion[]} 经包内
//     归一 adapter 转 FormQuestion。旧读与旧名随 D7 窗口退役。
//
// handler 收到的 req.channelPayload 由 packages/subagent-core 的 parseChannel
// （execution/ui/ui-channels.ts）解析 select options[0] JSON 得到。

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type AskUserQuestion,
	type FormAnswers,
	type FormQuestion,
	isFormQuestion,
	uiFormInteract,
} from "@zhushanwen/extension-protocol";
import { getLogger } from "@zhushanwen/pi-extension-logger";

import { AskUserComponent } from "./component";
import { encodeAnswer } from "./answer-codec";
import {
	askUserToFormQuestions,
	formToAskUserQuestions,
	formToInternalQuestions,
} from "./form-adapter";
import { type AnswerValue, type Result, type ThemeLike } from "./types";

const logger = getLogger("ask-user");

/**
 * channel handler 签名——与 packages/subagent-core 的 UiChannelRegistry.ChannelHandler 一致
 *（execution/ui/ui-channels.ts 定义，(req: unknown) => Promise<unknown>）。本文件不静态 import
 * packages/subagent-core（host 侧包，非本包依赖——两侧扩展经 globalThis slot 握手协作，
 * 见 index.ts 工厂注释）；handler 签名用本地等价类型，运行时结构兼容。
 */
export type ChannelHandler = (req: unknown) => Promise<unknown>;

/** handler 返回给 packages/subagent-core 的 UiResponse 形状（execution/ui/dialog-queue.ts 定义）。
 *  - {value}: select 的回传值（子进程 JSON.parse(value) 得 answers）
 *  - {cancelled}: 用户取消 / 子进程 close / handler 抛错 */
type ChannelResponse = { value: string } | { cancelled: true };

/** handler 收到的 req 形状收窄（ChannelHandler 签名是 unknown，按形状 as 收窄）。
 *  channelPayload 由 packages/subagent-core 的 parseChannel 填充（D9 双 payload）：
 *  新形态 {formQuestions, allowCancel} / 旧形态 {questions, allowCancel}。 */
interface ChannelRequest {
	channelPayload?: {
		formQuestions?: FormQuestion[];
		questions?: AskUserQuestion[];
		allowCancel?: boolean;
	};
}

/**
 * D9 双读：channelPayload 归一为 FormQuestion[]。
 *  - 新 payload formQuestions 逐项 isFormQuestion 守卫过滤（不合法项跳过——与
 *    event-adapter / renderer 的逐项过滤失败策略一致，D2）
 *  - 旧 payload questions 经包内归一 adapter 转 FormQuestion（legacy 子进程产出，
 *    其自身 schema 已保证形状，不做二次守卫——与迁移前行为一致）
 * 返回 undefined = 无可用问题（payload 缺失/空/全不合法），调用方折 {cancelled: true}。
 */
function payloadToFormQuestions(payload: ChannelRequest["channelPayload"]): FormQuestion[] | undefined {
	if (payload === undefined) return undefined;
	if (Array.isArray(payload.formQuestions)) {
		const filtered = payload.formQuestions.filter((q: unknown) => isFormQuestion(q));
		return filtered.length > 0 ? filtered : undefined;
	}
	if (Array.isArray(payload.questions) && payload.questions.length > 0) {
		return askUserToFormQuestions(payload.questions);
	}
	return undefined;
}

/**
 * 把 TUI 路径产出的内部 Result.answers 重新编码为 proto FormAnswers。
 *
 * 内部 Result.answers：key = question 全文，value = 结构化 AnswerValue
 * （selected = option label 数组，other = Other 自由文本）。
 *
 * proto FormAnswers 契约（@zhushanwen/extension-protocol，choice/text 部分与旧
 * AskUserAnswers 逐字兼容）：
 *   - key = question.header ?? question 全文
 *   - 单选：value = 选中项 label string
 *   - 多选：value = JSON.stringify(选中项 label 数组)
 *   - Other 自由文本：单独 key `${header}__other`
 *
 * 序列化走 encodeAnswer（answer-codec.ts 是本扩展内的唯一 encode 实现，与协议包解码
 * helper 对齐；renderer 前端组件无法 import extension 包，独立实现对齐同一解码契约）。
 */
function encodeTuiResultToProto(
	protoQuestions: AskUserQuestion[],
	result: Result,
): FormAnswers {
	const answers: FormAnswers = {};
	for (const pq of protoQuestions) {
		const av: AnswerValue | undefined = result.answers[pq.question];
		if (av === undefined) continue; // 该问题未答（buildResult 跳过未答）
		Object.assign(
			answers,
			encodeAnswer(av, {
				key: pq.header ?? pq.question,
				multiSelect: pq.multiSelect === true,
			}),
		);
	}
	return answers;
}

/** TUI 路径：ctx.ui.custom + AskUserComponent 渲染，返回 proto answers 或 null（取消）。
 *
 *  allowCancel 透传预留（PR #85 #12）：AskUserComponent 构造函数暂未接收 allowCancel，
 *  Esc 取消始终可用（component.ts 的 escBackOrConfirm / cancel 无条件生效）。待组件升级
 *  支持禁用 Esc 后，应把 allowCancel 下传给 AskUserComponent 构造函数。当前 allowCancel=false
 *  时 TUI 与 RPC 路径仍有分裂，但 handler 层已不再吞掉 allowCancel（修复分裂的第一步）。 */
async function runTuiProtoInteraction(
	formQuestions: FormQuestion[],
	ctx: ExtensionContext,
	allowCancel: boolean,
): Promise<FormAnswers | null> {
	const questions = formToInternalQuestions(formQuestions);
	// 预留：组件升级后此处改为 new AskUserComponent(questions, tui, theme, done, allowCancel)
	void allowCancel;
	const result = await ctx.ui.custom<Result | null>(
		(tui: unknown, theme: unknown, _kb: unknown, done: (r: Result | null) => void) => {
			const comp = new AskUserComponent(
				questions,
				tui as { requestRender(): void },
				theme as ThemeLike,
				done,
			);
			return comp;
		},
	);
	// json/print 模式 ctx.ui 是 noOpUIContext，custom 返回 undefined（TUI 返回 Result | null）。
	// 显式 undefined 守卫：裸 result.cancelled 对 undefined 会抛 TypeError（W4 修复前
	// 靠 dialog-queue 兜底为 {cancelled:true}，现源头短路，语义等价且不再依赖兜底）。
	if (result === null || result === undefined || result.cancelled) return null;
	return encodeTuiResultToProto(formToAskUserQuestions(formQuestions), result);
}

/**
 * 创建 ask_user channel handler。
 *
 * @param ctx 主进程 ExtensionContext（session_start 时注入）
 * @returns ChannelHandler——req.channelPayload = {formQuestions} 或 {questions}（D9 双读），
 *          返回 {value: JSON.stringify(answers)} 或 {cancelled: true}
 */
export function createAskUserChannelHandler(ctx: ExtensionContext): ChannelHandler {
	return async (req: unknown): Promise<unknown> => {
		// req 正常是 packages/subagent-core 构造的 UiRequest 对象；防御性收窄 null/undefined/
		// 非 object（handler 抛错会被 dialog-queue 兜底为 {cancelled:true}，但这里直接返回更干净）
		if (req === null || typeof req !== "object") {
			return { cancelled: true } satisfies ChannelResponse;
		}
		const r = req as ChannelRequest;
		const formQuestions = payloadToFormQuestions(r.channelPayload);
		if (formQuestions === undefined) {
			return { cancelled: true } satisfies ChannelResponse;
		}
		const allowCancel = r.channelPayload?.allowCancel ?? true;

		// 按 ctx.mode 分流（PR #85 #13 / #M6）：rpc 走 uiFormInteract（select 通道+sidecar），
		// 其余（tui/json/print/undefined）走 ctx.ui.custom+AskUserComponent。
		// 用 ctx.mode === "rpc" 二值判定（与 index.ts execute 的 useRpc 判定一致）；
		// 三值分类不需要——handler 只关心「rpc 转发」vs「TUI 内部渲染」两条路径。
		const answers =
			ctx.mode === "rpc"
				? await runRpcForward(formQuestions, ctx, allowCancel)
				: await runTuiProtoInteraction(formQuestions, ctx, allowCancel);

		if (answers === null) return { cancelled: true } satisfies ChannelResponse;
		return { value: JSON.stringify(answers) } satisfies ChannelResponse;
	};
}

/** RPC 转发器：主进程 ctx.ui.select 经 GUI sidecar 渲染（不进 parseSpawnLine，不循环）。
 *  完整复用 uiFormInteract 的 encode/decode 契约（FormAnswers ≡ 旧 AskUserAnswers）。
 *  间接链的通道失败（含 echo 命中的旧宿主组合）折叠 cancelled + 留痕——回包形状只有
 *  {value}|{cancelled} 两态，throw 会被 dialog-queue 兜底成同一结果，日志是唯一留痕面。 */
async function runRpcForward(
	formQuestions: FormQuestion[],
	ctx: ExtensionContext,
	allowCancel: boolean,
): Promise<FormAnswers | null> {
	const guiCtx = {
		mode: ctx.mode,
		hasUI: ctx.hasUI,
		ui: { select: ctx.ui.select.bind(ctx.ui) },
	};
	const result = await uiFormInteract(guiCtx, formQuestions, {
		allowCancel,
		log: (msg, detail) => logger.warn(msg, detail),
	});
	return result.ok ? result.answers : null;
}
