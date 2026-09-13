// src/index.ts — @zhushanwen/pi-session-manager
// 6 个 session 管理工具，通过 ctx.ui.select(SESSION_MANAGER_MARKER) 通道与 runtime handler 通信。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	SESSION_MANAGER_MARKER,
	type SessionManagerAction,
	type SessionManagerErrorResult,
} from "@xyz-agent/extension-protocol";
import { getLogger, setPiHandle } from "@zhushanwen/pi-extension-logger";
import { Type, type Static, type TObject } from "typebox";

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

/** select 超时（ms）：工具等待 runtime handler respond 的最大时间（create/history 走长链路放宽） */
const SELECT_TIMEOUT_MS: Record<SessionManagerAction, number> = {
	create: 60_000,
	send: 30_000,
	history: 60_000,
	status: 30_000,
	list: 30_000,
	abort: 30_000,
};

/** runtime handler respond 的错误 JSON 形状（错误闭环：{ error, hint?, sessionId? }），SSOT 在协议包 */

/**
 * 通过 select 通道向 runtime handler 发送 session 管理请求。
 * 返回 handler respond 的 JSON 字符串，用户取消/超时返回 null。
 */
async function callSessionManager(
	ctx: ExtensionContext,
	action: SessionManagerAction,
	params: Record<string, unknown>,
): Promise<string | null> {
	// 契约 SSOT：请求体 = 嵌套 { action, params } 形状（协议包 @xyz-agent/extension-protocol
	// 的 session-manager 模块）。runtime event-adapter 的 marker
	// 分支按 data.params 提取——若扁平化展开（{action, ...params}）params 会丢失变 {}。
	const payload = JSON.stringify({ action, params });
	try {
		const value = await ctx.ui.select(
			SESSION_MANAGER_MARKER,
			[payload],
			{ timeout: SELECT_TIMEOUT_MS[action] },
		);
		return value ?? null;
	} catch (err) {
		// select 通道异常（非用户取消/超时——那两类是 resolve null）：折叠为 null 供
		// executeTool 统一转 isError，但必须留痕（静默吞 = runtime handler 故障不可排查）
		logger.error(`[session-manager] select channel threw for action="${action}"`, {
			reason: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

/**
 * 统一的 execute 包装：调用 select 通道并解析结果。
 * 返回标准 AgentToolResult 形状；select 取消/超时/异常是错误路径，
 * 必须带 isError: true（extension-conventions「禁止错误成功模式」——
 * 调用方 agent 需能区分成功与失败以决定重试/放弃）。
 */
async function executeTool(
	ctx: ExtensionContext,
	action: SessionManagerAction,
	params: Record<string, unknown>,
): Promise<{ isError?: boolean; content: Array<{ type: "text"; text: string }>; details: undefined }> {
	const raw = await callSessionManager(ctx, action, params);
	if (raw === null) {
		return {
			isError: true,
			content: [{ type: "text" as const, text: `Session manager ${action}: cancelled or timed out.` }],
			details: undefined,
		};
	}
	// runtime 错误闭环（respond({error}) 走同一 select 通道）——解析后检测 error 字段，
	// 命中即 isError: true（extension-conventions「禁止错误成功模式」：agent 需能区分
	// 成功与同步失败以决定重试/放弃，不能靠读 content 文本自行判错）。
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		parsed = undefined;
	}
	if (parsed !== null && typeof parsed === "object" && typeof (parsed as SessionManagerErrorResult).error === "string") {
		const err = parsed as SessionManagerErrorResult;
		const text = err.hint ? `${err.error}\nhint: ${err.hint}` : err.error;
		return {
			isError: true,
			content: [{ type: "text" as const, text }],
			details: undefined,
		};
	}
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
			ctx: ExtensionContext,
		) {
			return executeTool(ctx, cfg.action, cfg.toParams(params));
		},
	});
}

export default function sessionManagerExtension(pi: ExtensionAPI): void {
	// logger 持久化通道接入（appendEntry custom entry，不进 LLM 上下文）
	setPiHandle(pi);

	registerSessionTool(pi, {
		name: "create_managed_session",
		label: "Create Managed Session",
		description: "Create a new agent-managed session in the specified working directory. Optionally provide an initial prompt, which is sent immediately (new sessions are always idle, so it is delivered directly). Returns a session ID and initial status. Requires the xyz-agent desktop runtime; standalone pi CLI will time out.",
		parameters: CreateManagedSessionParams,
		action: "create",
		toParams: (p) => ({ cwd: p.cwd, label: p.label, prompt: p.prompt }),
	});

	registerSessionTool(pi, {
		name: "send_to_session",
		label: "Send to Session",
		description: "Send a prompt/message to an existing managed session. The message is asynchronously queued: if the target session is busy (generating/compacting/running bash) it is delivered at its next turn boundary, and {queued: true} is returned immediately. On synchronous failure the tool returns an error result (isError) with a hint (check get_session_status, then retry). Requires the xyz-agent desktop runtime; standalone pi CLI will time out.",
		parameters: SendToSessionParams,
		action: "send",
		toParams: (p) => ({ sessionId: p.sessionId, prompt: p.prompt }),
	});

	registerSessionTool(pi, {
		name: "read_session_history",
		label: "Read Session History",
		description: "Read the conversation history of a managed session. Optionally limit to the last N turns. Requires the xyz-agent desktop runtime; standalone pi CLI will time out.",
		parameters: ReadSessionHistoryParams,
		action: "history",
		toParams: (p) => ({ sessionId: p.sessionId, tailTurns: p.tailTurns }),
	});

	registerSessionTool(pi, {
		name: "list_my_sessions",
		label: "List My Sessions",
		description: "List all sessions managed by the current agent. Returns session IDs, labels, and statuses. Requires the xyz-agent desktop runtime; standalone pi CLI will time out.",
		parameters: ListMySessionsParams,
		action: "list",
		toParams: () => ({}),
	});

	registerSessionTool(pi, {
		name: "get_session_status",
		label: "Get Session Status",
		description: "Get the current status of a managed session (active, idle, error, etc.) and its model info. Requires the xyz-agent desktop runtime; standalone pi CLI will time out.",
		parameters: GetSessionStatusParams,
		action: "status",
		toParams: (p) => ({ sessionId: p.sessionId }),
	});

	registerSessionTool(pi, {
		name: "abort_session",
		label: "Abort Session",
		description: "Abort a running managed session. The session stops processing; its final status will be 'stopped'. Requires the xyz-agent desktop runtime; standalone pi CLI will time out.",
		parameters: AbortSessionParams,
		action: "abort",
		toParams: (p) => ({ sessionId: p.sessionId }),
	});
}
