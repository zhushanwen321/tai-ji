// src/channel-handler.ts
//
// ask_user channel handler：把 subagent 子进程的 ask_user 请求透传到主进程 UI 渲染。
//
// 设计（关键决策）：askUserInteract（@xyz-agent/extension-protocol）只在 RPC 模式可用
// （内部 isGuiCapable 检查 mode==='rpc'，TUI 下抛错）。所以 handler 按 ctx.mode 分流：
//   - RPC：转发器——调 askUserInteract(guiCtx, protoQuestions)，复用 select 通道 +
//     ASK_USER_MARKER 契约，主进程 ctx.ui.select 经 GUI sidecar 渲染（不进 parseSpawnLine，
//     不循环）。返回 {value: JSON.stringify(answers)} 让子进程 JSON.parse(value) decode。
//   - TUI：走 ctx.ui.custom + AskUserComponent。三步：(1) protoQuestions → 内部 Question[]，
//     (2) ctx.ui.custom 渲染拿内部 Result，(3) 内部 Result.answers（key=question 全文，
//     value=结构化 AnswerValue）→ 用 encodeAnswer 重新编码为 proto AskUserAnswers
//     （key=header/question，单选=string，多选=JSON 数组，Other→__other），让子进程 decode 一致。
//
// handler 收到的 req.channelPayload = {questions: AskUserQuestion[], allowCancel}（proto 格式，
// 由子进程 askUserInteract 编码、packages/subagent-core 的 parseChannel（execution/ui/ui-channels.ts）
// 解析 options[0] JSON 得到）。

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type AskUserAnswers,
	askUserInteract,
	type AskUserQuestion,
} from "@xyz-agent/extension-protocol";

import { AskUserComponent } from "./component";
import { encodeAnswer } from "./answer-codec";
import { type AnswerValue, type Option, type Question, type Result, type ThemeLike } from "./types";

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
 *  channelPayload 由 packages/subagent-core 的 parseChannel 填充。 */
interface ChannelRequest {
	channelPayload?: { questions?: AskUserQuestion[]; allowCancel?: boolean };
}

/** proto AskUserQuestion → 内部 Question（AskUserComponent 接受内部格式）。
 *  proto options 可选（无 options=纯自由文本），内部 options 必填——无 options 的 protoQuestion
 *  这里仍映射出 options（从子进程 ask-user 调用方保证 protoQuestions 总带 options；若缺则返 [] 由调用方判）。 */
function protoToInternalQuestions(protoQuestions: AskUserQuestion[]): Question[] {
	return protoQuestions.map((pq: AskUserQuestion): Question => {
		const opts: Option[] = (pq.options ?? []).map((o: { label: string; description?: string }): Option => ({
			label: o.label,
			...(o.description !== undefined ? { description: o.description } : {}),
		}));
		return {
			question: pq.question,
			...(pq.header !== undefined ? { header: pq.header } : {}),
			...(pq.context !== undefined ? { context: pq.context } : {}),
			options: opts,
			...(pq.multiSelect !== undefined ? { multiSelect: pq.multiSelect } : {}),
		};
	});
}

/**
 * 把 TUI 路径产出的内部 Result.answers 重新编码为 proto AskUserAnswers。
 *
 * 内部 Result.answers：key = question 全文，value = 结构化 AnswerValue
 * （selected = option label 数组，other = Other 自由文本）。
 *
 * proto AskUserAnswers 契约（@xyz-agent/extension-protocol）：
 *   - key = question.header ?? question 全文
 *   - 单选：value = 选中项 label string
 *   - 多选：value = JSON.stringify(选中项 label 数组)
 *   - Other 自由文本：单独 key `${header}__other`
 *
 * 序列化走 encodeAnswer（answer-codec.ts 是唯一 encode 实现，与协议包解码 helper 对齐）。
 */
function encodeTuiResultToProto(
	protoQuestions: AskUserQuestion[],
	result: Result,
): AskUserAnswers {
	const answers: AskUserAnswers = {};
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
	protoQuestions: AskUserQuestion[],
	ctx: ExtensionContext,
	allowCancel: boolean,
): Promise<AskUserAnswers | null> {
	const questions = protoToInternalQuestions(protoQuestions);
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
	return encodeTuiResultToProto(protoQuestions, result);
}

/**
 * 创建 ask_user channel handler。
 *
 * @param ctx 主进程 ExtensionContext（session_start 时注入）
 * @returns ChannelHandler——req.channelPayload = {questions, allowCancel}（proto 格式），
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
		const payload = r.channelPayload;
		if (!payload || !Array.isArray(payload.questions) || payload.questions.length === 0) {
			return { cancelled: true } satisfies ChannelResponse;
		}
		const { questions, allowCancel } = payload;

		// 按 ctx.mode 分流（PR #85 #13 / #M6）：rpc 走 askUserInteract（select 通道+sidecar），
		// 其余（tui/json/print/undefined）走 ctx.ui.custom+AskUserComponent。
		// 用 ctx.mode === "rpc" 二值判定（与 index.ts execute 的 useRpc 判定一致）；
		// 三值分类不需要——handler 只关心「rpc 转发」vs「TUI 内部渲染」两条路径。
		const answers =
			ctx.mode === "rpc"
				? await runRpcForward(questions, ctx, allowCancel ?? true)
				: await runTuiProtoInteraction(questions, ctx, allowCancel ?? true);

		if (answers === null) return { cancelled: true } satisfies ChannelResponse;
		return { value: JSON.stringify(answers) } satisfies ChannelResponse;
	};
}

/** RPC 转发器：主进程 ctx.ui.select 经 GUI sidecar 渲染（不进 parseSpawnLine，不循环）。
 *  完整复用 askUserInteract 的 encode/decode 契约。 */
async function runRpcForward(
	questions: AskUserQuestion[],
	ctx: ExtensionContext,
	allowCancel: boolean,
): Promise<AskUserAnswers | null> {
	const guiCtx = {
		mode: ctx.mode,
		hasUI: ctx.hasUI,
		ui: { select: ctx.ui.select.bind(ctx.ui) },
	};
	return askUserInteract(guiCtx, questions, { allowCancel });
}
