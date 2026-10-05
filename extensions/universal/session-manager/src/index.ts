// src/index.ts — @zhushanwen/pi-session-manager
// 6 个 session 管理工具，通过 ctx.ui.select(SESSION_MANAGER_MARKER) 通道与 runtime handler 通信。

import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionToolContext,
	SessionCompactEvent,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
	SESSION_MANAGER_MARKER,
	callMarkerRpc,
	formatChannelErrorText,
	isChannelErrorResult,
	type MarkerRpcResult,
	type SessionManagerAction,
} from "@zhushanwen/extension-protocol";
import { getLogger, setPiHandle } from "@zhushanwen/pi-extension-logger";
import { Type, type Static, type TObject } from "typebox";

import { ensureLedgerBound, runLedgerCompactionCheck } from "./notify-ledger.ts";
import { createWatchCoordinator } from "./watch-coordinator.ts";

// 模块级 logger（default export 首行 setPiHandle 注入后自动走 appendEntry 持久化，
// 注入前/失败降级文件日志——见 extension-logger 三层通道设计）
const logger = getLogger("session-manager");

// ── 参数 Schema ──

const CreateManagedSessionParams = Type.Object({
	cwd: Type.String({ description: "Working directory for the new session" }),
	label: Type.Optional(Type.String({ description: "Human-readable label for the session" })),
	prompt: Type.Optional(Type.String({ description: "Initial prompt injected right after creation (atomic create+send)" })),
});

const SendToSessionParams = Type.Object({
	sessionId: Type.String({ description: "Target session ID" }),
	prompt: Type.String({ description: "Message to send to the session" }),
});

const ReadSessionHistoryParams = Type.Object({
	sessionId: Type.String({ description: "Target session ID" }),
	tailTurns: Type.Optional(Type.Number({ description: "Number of recent turns to return (default: all)" })),
});

const ListMySessionsParams = Type.Object({});

const GetSessionStatusParams = Type.Object({
	sessionId: Type.String({ description: "Target session ID" }),
});

const AbortSessionParams = Type.Object({
	sessionId: Type.String({ description: "Target session ID to abort" }),
});

// ── select 通道辅助 ──

/**
 * 通过 select 通道向 runtime handler 发送 session 管理请求（传输核走 protocol 的
 * callMarkerRpc 原语，D8）。回包为 handler respond 的 JSON 字符串（value 恒 raw）；
 * 失败态（cancelled/channel-error/non-json）由 executeTool 统一 throw——
 * execute throw → pi agent-loop catch 置 isError:true（pi-agent-core dist/agent-loop.js
 * executePreparedToolCall，1.0.0 实读 catch :581-588）；1.0.0 起返回值 isError:true 也被
 * 尊重（同文件 :579 `isError: result.isError === true`，0.84.4 时返回值会被丢弃）——
 * 本工具失败恒走 throw，两版语义等价（语义登记 PS-56）。
 * 通道异常与非 JSON 回包的留痕由原语经注入的 log 承担。
 *
 * 不传 timeout（ADR-0112：无包内挂死兜底，handler 不回包时工具调用长挂、失败直报；
 * 原 SELECT_TIMEOUT_MS per-action 表已删——原 watch 通道 D2/P1 的无 timer 长挂形态
 * 现为全部 action 统一形态：任意晚的 respond 按 id 精确 resolve）。
 */
function callSessionManager(
	ctx: ExtensionContext,
	action: SessionManagerAction,
	params: Record<string, unknown>,
): Promise<MarkerRpcResult> {
	// 契约 SSOT：请求体 = 嵌套 { action, params } 形状（协议包 @zhushanwen/extension-protocol
	// 的 session-manager 模块）。runtime event-adapter 的 marker
	// 分支按 data.params 提取——若扁平化展开（{action, ...params}）params 会丢失变 {}。
	const payload = JSON.stringify({ action, params });
	// 从 ExtensionContext 构造 GuiContext 最小子集（ask-user runRpcInteraction 同款先例）：
	// ExtensionContext.ui.custom 泛型签名与 GuiContext.ui.custom 静态不兼容，直接传 ctx
	// 过不了 tsc；callMarkerRpc 只读 ui.select。
	const guiCtx = {
		mode: ctx.mode,
		hasUI: ctx.hasUI,
		ui: { select: ctx.ui.select.bind(ctx.ui) },
	};
	return callMarkerRpc(guiCtx, SESSION_MANAGER_MARKER, payload, {
		// 全 action 不传 timeout（ADR-0112：无包内挂死兜底；无 timer 长挂，任意晚的 respond 按 id 精确 resolve）
		log: (msg, detail) => logger.error(`[session-manager] ${msg}`, detail),
	});
}

/** notifyId 生成（notify-once D2）：`sm-` + UUID4——与协议 isSessionManagerNotifyId
 *  同形态（runtime 受理点按该形态判 arm）。 */
function newNotifyId(): string {
	return `sm-${crypto.randomUUID()}`;
}

/** 运行时守卫（读侧不信任外部格式）：结果是否 JSON object——形状断言前的类型 guard。 */
function asResultRecord(v: unknown): Record<string, unknown> | undefined {
	return typeof v === "object" && v !== null && !Array.isArray(v)
			? (v as Record<string, unknown>)
			: undefined;
}

/**
 * 统一的 execute 包装：调用 select 通道并解析结果。
 * 返回标准 AgentToolResult 形状；select 取消/超时/异常/非 JSON 回包是错误路径，
 * 必须 throw（extension-conventions「禁止错误成功模式」——pi 契约里 execute 只有
 * throw 才被置 isError:true，返回值携带 isError 字段会被 agent-loop 丢弃
 * （agent-loop.js:453-483，PS-56），ask-user/scheduler/session-reader 的 W4 throw
 * 范式同款；调用方 agent 需能区分成功与失败以决定重试/放弃）。
 */
async function executeTool(
	ctx: ExtensionContext,
	action: SessionManagerAction,
	params: Record<string, unknown>,
	onResult?: (ctx: ExtensionContext, params: Record<string, unknown>, result: unknown) => void,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: undefined }> {
	const result = await callSessionManager(ctx, action, params);
	if (!result.ok) {
		// 行为微变①（D8，有意）：非 JSON 回包从「catch 后
		// parsed=undefined 静默当成功文本返回」改为 throw + 提示文本（留痕由原语
		// 经注入的 logger.error 承担）；不传 timeout 后剩余 cancelled/channel-error 两态折叠。
		const text =
			result.reason === "non-json"
				? `Session manager ${action}: non-JSON response from runtime (protocol mismatch — redeploy same-version runtime + extension; see extension logs).`
				: `Session manager ${action}: cancelled or channel error.`;
		throw new Error(text);
	}
	const raw = result.value;
	// 合法性已由原语检测（ok:true ⇒ 同一字符串 JSON.parse 必成功），parse 只为字段检测。
	// runtime 错误闭环（respond({error}) 走同一 select 通道）——检测与文本拼接单源于
	// protocol 的 isChannelErrorResult / formatChannelErrorText（D8）：命中即 throw
	//（extension-conventions「禁止错误成功模式」：agent 需能区分成功与同步失败以决定
	// 重试/放弃，不能靠读 content 文本自行判错）。
	const parsed: unknown = JSON.parse(raw);
	if (isChannelErrorResult(parsed)) {
		throw new Error(formatChannelErrorText(parsed));
	}
	// 成功路径副作用编排（notify-once U4）：send/create 的 willNotify arm（register + 开表）、
	// label 缓存回填（list）——错误路径已 throw，天然不触发。
	onResult?.(ctx, params, parsed);
	return {
		content: [{ type: "text" as const, text: raw }],
		details: undefined,
	};
}

// ── Extension 入口 ──

/** 单个 session 工具的声明式配置（registerSessionTool 的输入）。 */
interface SessionToolConfig<S extends TObject> {
	name: string
	label: string
	description: string
	parameters: S
	action: SessionManagerAction
	/** schema params → 协议 params 的映射（undefined 字段由 JSON.stringify 丢弃） */
	toParams: (params: Static<S>) => Record<string, unknown>
	/** 成功结果钩子（仅非错误通道结果触发）——notify-once 的 arm/label 缓存编排 */
	onResult?: (ctx: ExtensionContext, params: Record<string, unknown>, result: unknown) => void
}

/**
 * 注册一个 session 管理工具。6 个工具共用同一 execute 骨架——
 * 统一忽略 signal/onUpdate（session 管理是单次请求-响应，无流式更新），
 * 不 ctx.ui 交互（走 marker select 通道，不弹用户 UI）。
 */
function registerSessionTool<S extends TObject>(pi: ExtensionAPI, cfg: SessionToolConfig<S>): void {
	pi.registerTool({
		name: cfg.name,
		label: cfg.label,
		description: cfg.description,
		parameters: cfg.parameters,
		async execute(
			_toolCallId: string,
			params: Static<S>,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			// pi 1.0.0：ToolDefinition.execute 第 5 参 ctx 收窄为 ExtensionToolContext
			ctx: ExtensionToolContext,
		) {
			return executeTool(ctx, cfg.action, cfg.toParams(params), cfg.onResult);
		},
	});
}

export default function sessionManagerExtension(pi: ExtensionAPI): void {
	// logger 持久化通道接入（appendEntry custom entry，不进 LLM 上下文）
	setPiHandle(pi);

	// watch 桥编排（notify-once U4）：工具结果 arm / watch 应答两层攒批 record /
	// session_start 重启收口腿共用同一闭包状态（label 缓存 + 死亡新闻槽 + 攒批队列）。
	const coordinator = createWatchCoordinator({
		pi,
		callWatch: (ctx, notifyId) => callSessionManager(ctx, "watch", { notifyId }),
	});

	// 重启收口腿（D7③）：父 pi 死亡后永无 unregister 的活跃 type 'session' register
	// 逐条重开 watch（入参 = entry id 即 notifyId），应答经 watch 处理链静默注销，
	// 活跃集回归基线；每 entry 独立 handler（禁串行 await）在 coordinator 内保证。
	// ledger 装配纪律①②（D3）：session_start 无条件 bind + recoverFromSession 成对
	//（唯一装配方形态，与 subagent-workflow bindLedgerHostAndRecover 同款——先装配，
	// 收口腿/watch 应答到达时消费面已就绪）。
	pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
		ensureLedgerBound(pi, ctx);
		coordinator.recoverStaleRegisters(ctx);
	});
	// compactionCheck 接线（D3 装配纪律④，P-B4 降级——subagent-workflow 同款先例）
	pi.on("session_compact", (_event: SessionCompactEvent, _ctx: ExtensionContext) => {
		runLedgerCompactionCheck();
	});

	registerSessionTool(pi, {
		name: "create_managed_session",
		label: "Create Managed Session",
		description:
			"Create a new agent-managed session in the specified working directory. Optionally provide an initial prompt, which is sent immediately (new sessions are always idle, so it is delivered directly). Returns a session ID, initial status and willNotify: when a prompt is provided, exactly one completion notification is delivered to this session after that run finishes (see pending_notifications, type 'session'); without a prompt willNotify is false and no completion notification is sent. Terminal session death is notified once regardless. Requires the taiji desktop runtime; standalone pi CLI will time out.",
		parameters: CreateManagedSessionParams,
		action: "create",
		toParams: (p) => ({
			cwd: p.cwd,
			label: p.label,
			prompt: p.prompt,
			// 债权只可能在带 prompt 时产生（G1）——无 prompt 不携带 notifyId（缺省即不 arm）
			notifyId: p.prompt !== undefined ? newNotifyId() : undefined,
		}),
		onResult: (ctx, params, result) => {
			const r = asResultRecord(result);
			if (!r || typeof r.sessionId !== "string") return;
			const rawLabel =
				typeof params.label === "string" && params.label !== "" ? params.label : undefined;
			const name = rawLabel ?? r.sessionId;
			coordinator.noteLabel(r.sessionId, name);
			const notifyId = params.notifyId;
			if (r.willNotify === true && typeof notifyId === "string") {
				coordinator.armSessionNotify(ctx, notifyId, name);
			}
			if (typeof r.lifetimeNotifyId === "string") {
				coordinator.armSessionNotify(ctx, r.lifetimeNotifyId, name);
			}
		},
	});

	registerSessionTool(pi, {
		name: "send_to_session",
		label: "Send to Session",
		description:
			"Send a prompt/message to an existing managed session. The message is asynchronously queued: if the target session is busy (generating/compacting/running bash) it is delivered at its next turn boundary, and {queued: true} is returned immediately. Returns willNotify: exactly one completion notification is delivered to this session when the queued message is consumed and that run finishes (several queued messages merge into a single notification with a count). On synchronous failure the tool call fails with an error (check get_session_status, then retry). Requires the taiji desktop runtime; standalone pi CLI will time out.",
		parameters: SendToSessionParams,
		action: "send",
		toParams: (p) => ({ sessionId: p.sessionId, prompt: p.prompt, notifyId: newNotifyId() }),
		onResult: (ctx, params, result) => {
			const r = asResultRecord(result);
			if (!r || r.willNotify !== true) return;
			const notifyId = params.notifyId;
			const sessionId = params.sessionId;
			if (typeof notifyId !== "string" || typeof sessionId !== "string") return;
			coordinator.armSessionNotify(ctx, notifyId, coordinator.labelFor(sessionId));
		},
	});

	registerSessionTool(pi, {
		name: "read_session_history",
		label: "Read Session History",
		description: "Read the conversation history of a managed session. Optionally limit to the last N turns. Requires the taiji desktop runtime; standalone pi CLI will time out.",
		parameters: ReadSessionHistoryParams,
		action: "history",
		toParams: (p) => ({ sessionId: p.sessionId, tailTurns: p.tailTurns }),
	});

	registerSessionTool(pi, {
		name: "list_my_sessions",
		label: "List My Sessions",
		description: "List all sessions managed by the current agent. Returns session IDs, labels, and statuses. Requires the taiji desktop runtime; standalone pi CLI will time out.",
		parameters: ListMySessionsParams,
		action: "list",
		toParams: () => ({}),
		// label 缓存回填（D9 正常路径 label 源的兜底——进程重启后 create 缓存丢失，
		// send 的文案/register name 退化为 sessionId 前先经 list 恢复真 label）
		onResult: (_ctx, _params, result) => {
			const r = asResultRecord(result);
			if (!r || !Array.isArray(r.sessions)) return;
			for (const item of r.sessions) {
				const s = asResultRecord(item);
				if (!s || typeof s.id !== "string") continue;
				coordinator.noteLabel(
					s.id,
					typeof s.label === "string" && s.label !== "" ? s.label : s.id,
				);
			}
		},
	});

	registerSessionTool(pi, {
		name: "get_session_status",
		label: "Get Session Status",
		description: "Get the current status of a managed session (active, idle, error, etc.) and its model info. Requires the taiji desktop runtime; standalone pi CLI will time out.",
		parameters: GetSessionStatusParams,
		action: "status",
		toParams: (p) => ({ sessionId: p.sessionId }),
	});

	registerSessionTool(pi, {
		name: "abort_session",
		label: "Abort Session",
		description: "Abort a running managed session. The session stops processing; its final status will be 'stopped'. Requires the taiji desktop runtime; standalone pi CLI will time out.",
		parameters: AbortSessionParams,
		action: "abort",
		toParams: (p) => ({ sessionId: p.sessionId }),
	});
}
