// src/index.ts — @zhushanwen/pi-session-manager
// 8 个 session 管理工具，通过 ctx.ui.select(SESSION_MANAGER_MARKER) 通道与 runtime handler 通信。

import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionToolContext,
	SessionStartEvent,
	Theme,
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

import { renderSessionManagerResult } from "./render.ts";
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
	sessionId: Type.String({ description: "From list_my_sessions output. Unknown/stale ids error — re-list instead of retrying." }),
	prompt: Type.String({ description: "Message to send to the session" }),
});

const ReadSessionHistoryParams = Type.Object({
	sessionId: Type.String({ description: "From list_my_sessions output. Unknown/stale ids error — re-list instead of retrying." }),
	tailTurns: Type.Optional(Type.Number({ description: "Number of recent turns to return (default: all)" })),
});

const ListMySessionsParams = Type.Object({});

const GetSessionStatusParams = Type.Object({
	sessionId: Type.String({ description: "From list_my_sessions output. Unknown/stale ids error — re-list instead of retrying." }),
});

const AbortSessionParams = Type.Object({
	sessionId: Type.String({ description: "From list_my_sessions output. Unknown/stale ids error — re-list instead of retrying." }),
});

// 两终局操作的 sessionId 字段 description 走全族统一句式（填参层：id 唯一来源 + 错误恢复指引）
const DeleteSessionParams = Type.Object({
	sessionId: Type.String({ description: "From list_my_sessions output. Unknown/stale ids error — re-list instead of retrying." }),
});

const ArchiveSessionParams = Type.Object({
	sessionId: Type.String({ description: "From list_my_sessions output. Unknown/stale ids error — re-list instead of retrying." }),
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
 * 不传 timeout（ADR-0122：无包内挂死兜底，handler 不回包时工具调用长挂、失败直报；
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
		// 全 action 不传 timeout（ADR-0122：无包内挂死兜底；无 timer 长挂，任意晚的 respond 按 id 精确 resolve）
		log: (msg, detail) => logger.error(`[session-manager] ${msg}`, detail),
	});
}

/** notifyId 生成（notify-once D2）：`sm-` + UUID4——与协议 isSessionManagerNotifyId
 *  同形态（runtime 受理点按该形态判 arm）。 */
function newNotifyId(): string {
	return `sm-${crypto.randomUUID()}`;
}

/** 运行时检查（读侧不信任外部格式）：结果是否 JSON object——形状断言前的类型 guard。 */
function asResultRecord(v: unknown): Record<string, unknown> | undefined {
	return typeof v === "object" && v !== null && !Array.isArray(v)
			? (v as Record<string, unknown>)
			: undefined;
}

/** toSummary 的字段守卫：非空 string 才采信（缺字段 = 摘要省略对应段，不抛错——
 * 摘要只是展示辅助，不得反过来影响工具成功路径）。 */
function stringField(rec: Record<string, unknown> | undefined, key: string): string | undefined {
	const v = rec?.[key];
	return typeof v === "string" && v !== "" ? v : undefined;
}

function arrayField(rec: Record<string, unknown> | undefined, key: string): unknown[] | undefined {
	const v = rec?.[key];
	return Array.isArray(v) ? v : undefined;
}

/**
 * 统一的 execute 包装：调用 select 通道并解析结果。
 * 返回标准 AgentToolResult 形状；select 取消/超时/异常/非 JSON 回包是错误路径，
 * 必须 throw（extension-conventions「禁止错误成功模式」——execute throw → pi
 * agent-loop catch 置 isError:true（pi-agent-core dist/agent-loop.js
 * executePreparedToolCall，1.0.0 实读 catch :581-588）；1.0.0 起返回值 isError:true
 * 也被尊重（同文件 :579 `isError: result.isError === true`，0.84.4 时返回值会被
 * 丢弃）——本工具失败恒走 throw，两版语义等价（语义登记 PS-56）；
 * ask-user/scheduler/session-reader 的 W4 throw 范式同款，调用方 agent 需能区分
 * 成功与失败以决定重试/放弃）。
 */
async function executeTool(
	ctx: ExtensionContext,
	action: SessionManagerAction,
	params: Record<string, unknown>,
	onResult?: (ctx: ExtensionContext, params: Record<string, unknown>, result: unknown) => void,
	toSummary?: (params: Record<string, unknown>, result: unknown) => string,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: { summary: string } | undefined }> {
	const result = await callSessionManager(ctx, action, params);
	if (!result.ok) {
		// 行为微变①（D8，有意）：非 JSON 回包从「catch 后
		// parsed=undefined 静默当成功文本返回」改为 throw + 提示文本（留痕由原语
		// 经注入的 logger.error 承担）；不传 timeout 后剩余 cancelled/channel-error 两态折叠。
		const text =
			result.reason === "non-json"
				? `Session manager ${action}: non-JSON response from runtime (protocol mismatch — redeploy same-version runtime + extension; see extension logs).`
				: `Session manager ${action}: cancelled or channel error — check the taiji runtime connection first; if it is up, retrying the call is safe. Exception: if a call fails with a duplicate-notifyId conflict, do not retry it as-is — issue a new call instead (a new call carries a fresh notifyId).`;
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
	// details.summary 一行摘要（工具收起态展示）：八工具共用本骨架统一组装，
	// 文案由各工具 cfg.toSummary 从协议 params + 回包产出（未配置 = details 缺省）。
	return {
		content: [{ type: "text" as const, text: raw }],
		details: toSummary ? { summary: toSummary(params, parsed) } : undefined,
	};
}

// ── Extension 入口 ──

/** 单个 session 工具的声明式配置（registerSessionTool 的输入）。 */
interface SessionToolConfig<S extends TObject> {
	name: string
	label: string
	description: string
	/**
	 * 识别层（session-manager-archive-delete 四层信息协议）：系统提示词 Available tools
	 * 清单的一行片段。deferred 工具激活前不在活跃集、带不带都不进清单；激活后带
	 * snippet 者进清单（pi SDK 1.0.0 system-prompt 工具清单机制：visibleTools =
	 * selectedTools ∩ 有 promptSnippet）——deferred 工具配 promptSnippet 的原因。
	 * 不配置 = 激活后也不进清单（pi SDK 原生语义）。
	 */
	promptSnippet?: string
	parameters: S
	action: SessionManagerAction
	/** schema params → 协议 params 的映射（undefined 字段由 JSON.stringify 丢弃） */
	toParams: (params: Static<S>) => Record<string, unknown>
	/** 成功结果钩子（仅非错误通道结果触发）——notify-once 的 arm/label 缓存编排 */
	onResult?: (ctx: ExtensionContext, params: Record<string, unknown>, result: unknown) => void
	/**
	 * 一行收起态摘要（details.summary 的产出函数，六工具共用 executeTool 骨架统一
	 * 组装）：输入 = 协议 params（toParams 产物）+ 成功回包；纯函数、缺数据省略
	 * 对应段不抛错。消费方 = taiji GUI 对话流（details.summary）与本包 renderResult
	 * 折叠态（pi TUI）。
	 */
	toSummary?: (params: Record<string, unknown>, result: unknown) => string
}

/**
 * 注册一个 session 管理工具。8 个工具共用同一 execute 骨架——
 * 统一忽略 signal/onUpdate（session 管理是单次请求-响应，无流式更新），
 * 不 ctx.ui 交互（走 marker select 通道，不弹用户 UI）。
 */
function registerSessionTool<S extends TObject>(pi: ExtensionAPI, cfg: SessionToolConfig<S>): void {
	pi.registerTool({
		name: cfg.name,
		label: cfg.label,
		// deferred（tool-declaration-slimming D4）：六件套整体不常驻声明，tool_search
		// 命中即激活；迁移写入的 +tool_search 条目（runtime pi-codemode-settings）承载检索入口
		exposure: "deferred",
		promptSnippet: cfg.promptSnippet,
		description: cfg.description,
		parameters: cfg.parameters,
		renderResult(result: unknown, options: { expanded: boolean }, theme: Theme) {
			return renderSessionManagerResult(result, options, theme);
		},
		async execute(
			_toolCallId: string,
			params: Static<S>,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			// pi 1.0.0：ToolDefinition.execute 第 5 参 ctx 收窄为 ExtensionToolContext
			ctx: ExtensionToolContext,
		) {
			return executeTool(ctx, cfg.action, cfg.toParams(params), cfg.onResult, cfg.toSummary);
		},
	});
}

export default function sessionManagerExtension(pi: ExtensionAPI): void {
	// logger 持久化通道接入（appendEntry custom entry，不进 LLM 上下文）
	setPiHandle(pi);

	// watch 桥编排（notify-once U4）：工具结果 arm / watch 应答两层攒批 record /
	// session_start 重启收尾路径共用同一闭包状态（label 缓存 + 死亡新闻槽 + 攒批队列）。
	const coordinator = createWatchCoordinator({
		pi,
		callWatch: (ctx, notifyId) => callSessionManager(ctx, "watch", { notifyId }),
	});

	// 重启收尾路径（D7③）：父 pi 死亡后永无 unregister 的活跃 type 'session' register
	// 逐条重开 watch（入参 = entry id 即 notifyId），应答经 watch 处理链静默注销，
	// 活跃集回归基线；每 entry 独立 handler（禁串行 await）在 coordinator 内保证。
	pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
		coordinator.recoverStaleRegisters(ctx);
	});

	registerSessionTool(pi, {
		name: "create_managed_session",
		label: "Create Managed Session",
		description: `Create a new managed child session in a working directory, optionally with an initial prompt.

Returns the new session's id and its initial status. With a prompt it is delivered immediately (new sessions are always idle) and exactly one completion notification is delivered to this session when that first run finishes (see pending_notifications, type 'session'); without a prompt, no completion notification. If the session dies later, its terminal death is notified once regardless — independent of completion notifications.

Different from send_to_session (delivers messages to an already-created session): this tool creates the session and can send its first message atomically in one call.

## Example
{"cwd":"/absolute/path/to/project","label":"research","prompt":"Analyze the auth module"}

The returned sessionId is the value all other session tools take — keep it; list_my_sessions recovers it later. Requires the taiji desktop runtime (in standalone pi this tool hangs forever — no runtime answers the channel).`,
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
				// kind:"lifetime"（result-collect 设计 §3.4）：lifetime 死亡债权注册在
				// emit 侧申报类别标记（collect 缺省等待集据此排除）；send 债权注册
				// 不带 kind（缺省 = send）。
				coordinator.armSessionNotify(ctx, r.lifetimeNotifyId, name, "lifetime");
			}
		},
		toSummary: (params, result) => {
			const label = stringField(params, "label");
			if (label) return `Created session "${label}"`;
			const sessionId = stringField(asResultRecord(result), "sessionId");
			return sessionId ? `Created session ${sessionId}` : "Created session";
		},
	});

	registerSessionTool(pi, {
		name: "send_to_session",
		label: "Send to Session",
		description: `Send a message to an existing managed session.

The message is queued asynchronously: if the target session is busy (generating/compacting/running bash) it is delivered at its next turn boundary and {queued: true} returns immediately. willNotify: exactly one completion notification is delivered to this session when the queued message is consumed and that run finishes; several queued messages merge into a single notification with a count. On synchronous failure the tool call errors (check get_session_status, then retry).

Different from create_managed_session (creates a session, optionally with a first message): this tool talks to a session that already exists.

## Example
{"sessionId":"<id from list_my_sessions>","prompt":"How did the analysis go?"}

Ids come from list_my_sessions — never guess; on unknown-id error re-list, don't retry the same id. Requires the taiji desktop runtime (in standalone pi this tool hangs forever — no runtime answers the channel).`,
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
		toSummary: (params) => {
			const sessionId = stringField(params, "sessionId");
			return sessionId ? `Sent message to ${sessionId}` : "Sent message";
		},
	});

	registerSessionTool(pi, {
		name: "read_session_history",
		label: "Read Session History",
		description: `Read the conversation history of a managed session.

Returns the session's messages. Pass tailTurns to limit the result to the most recent turns (default: all).

Different from get_session_status (lightweight state and counters): this tool returns the actual conversation content.

## Example
{"sessionId":"<id from list_my_sessions>","tailTurns":20}

Ids come from list_my_sessions — never guess; on unknown-id error re-list, don't retry the same id. Requires the taiji desktop runtime (in standalone pi this tool hangs forever — no runtime answers the channel).`,
		parameters: ReadSessionHistoryParams,
		action: "history",
		toParams: (p) => ({ sessionId: p.sessionId, tailTurns: p.tailTurns }),
		toSummary: (params, result) => {
			const sessionId = stringField(params, "sessionId");
			const messages = arrayField(asResultRecord(result), "messages");
			if (sessionId && messages) return `Read history of ${sessionId} · ${messages.length} entries`;
			if (sessionId) return `Read history of ${sessionId}`;
			return "Read history";
		},
	});

	registerSessionTool(pi, {
		name: "list_my_sessions",
		label: "List My Sessions",
		description: `List all sessions managed by you, with id, label, cwd, and status.

This listing is the single source of sessionId values for every other session tool. The response also carries undeliveredResults: the total count of completion notifications not yet delivered to you across your sessions.

## Example
{}

Ids come from this listing — never guess; on unknown-id error re-list, don't retry the same id. Requires the taiji desktop runtime (in standalone pi this tool hangs forever — no runtime answers the channel).`,
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
		toSummary: (_params, result) => {
			const sessions = arrayField(asResultRecord(result), "sessions");
			return sessions ? `Listed ${sessions.length} managed sessions` : "Listed managed sessions";
		},
	});

	registerSessionTool(pi, {
		name: "get_session_status",
		label: "Get Session Status",
		description: `Get the current status of a managed session without reading its history.

Returns the session's status (active, idle, error, etc.), its model info, and undeliveredResults — the count of that session's finished runs whose completion notifications have not been delivered to you yet. An unknown or non-owned id does not error: it returns status 'not_found'.

Different from read_session_history (conversation content): this tool is a lightweight state check.

## Example
{"sessionId":"<id from list_my_sessions>"}

Ids come from list_my_sessions — never guess; on unknown-id error re-list, don't retry the same id. Requires the taiji desktop runtime (in standalone pi this tool hangs forever — no runtime answers the channel).`,
		parameters: GetSessionStatusParams,
		action: "status",
		toParams: (p) => ({ sessionId: p.sessionId }),
		toSummary: (params, result) => {
			const sessionId = stringField(params, "sessionId");
			const status = stringField(asResultRecord(result), "status");
			if (sessionId && status) return `${sessionId} · ${status}`;
			if (sessionId) return `Status of ${sessionId}`;
			return "Session status";
		},
	});

	registerSessionTool(pi, {
		name: "abort_session",
		label: "Abort Session",
		description: `Stop a managed session's current run, keeping the session and its history.

The session stops processing; its final status will be 'stopped'. Pending completion notifications for the aborted run are cancelled, not delivered.

Different from archive_session (tidies a finished session away, reversible by the user) and delete_session (permanently removes it): abort only stops the current run — the session stays in the sidebar for later use.

## Example
{"sessionId":"<id from list_my_sessions>"}

Ids come from list_my_sessions — never guess; on unknown-id error re-list, don't retry the same id. Requires the taiji desktop runtime (in standalone pi this tool hangs forever — no runtime answers the channel).`,
		parameters: AbortSessionParams,
		action: "abort",
		toParams: (p) => ({ sessionId: p.sessionId }),
		toSummary: (params) => {
			const sessionId = stringField(params, "sessionId");
			return sessionId ? `Aborted ${sessionId}` : "Aborted";
		},
	});

	// delete_session（session-manager-archive-delete U4）：人身约束（USER-INITIATED ONLY）
	// 仅存于文案层——description 与 promptSnippet 双锚词在册（契约测试锁）；description
	// 逐字来自设计 §3.1 内嵌样例。不配 onResult：forgetLabel 已裁决不做（T2 D-1-9，
	// label 缓存为进程级无回写形态，死 id 无读取方、残留无害）。
	registerSessionTool(pi, {
		name: "delete_session",
		label: "Delete Session",
		promptSnippet:
			"Permanently delete one of your managed sessions. USER-INITIATED ONLY — never call unless the user explicitly asks to delete.",
		description: `Permanently delete one of your managed sessions — kills its process if running, moves the conversation file and ALL derived data (artifacts, attachments, canvases, logs) to the trash. UNRECOVERABLE. On success any open completion-watch for it resolves as 'deleted' and it disappears from the user's sidebar immediately.

USER-INITIATED ONLY: call this tool ONLY when the user's message unmistakably asks for irreversible deletion. NEVER call it on your own initiative — not for cleanup, not to free resources, not after a task finishes, not because a session looks stale or unused. If you think a session is no longer needed, suggest archive_session instead and let the user decide. Ambiguous wording ("clean up", "get it out of the sidebar", "tidy up") means archive_session, NOT this tool — the desktop sidebar's delete button archives, so users often say "delete" when they mean archive. Reserve this tool for explicit irreversible intent ("permanently delete", "delete and don't keep it"); before calling, restate to the user that this is unrecoverable.

Different from abort_session (stops the current run, session kept) and archive_session (reversible, user can restore): deletion is the only irreversible action.

## Example
{"sessionId":"<id from list_my_sessions>"}

Ids come from list_my_sessions — never guess; on unknown-id error re-list, don't retry the same id. Archived sessions are NOT deletable via this tool (the call errors) — they are managed by the user in the archive list. Requires the taiji desktop runtime (in standalone pi this tool hangs forever — no runtime answers the channel).`,
		parameters: DeleteSessionParams,
		action: "delete",
		toParams: (p) => ({ sessionId: p.sessionId }),
		toSummary: (params) => {
			const sessionId = stringField(params, "sessionId");
			return sessionId ? `Deleted ${sessionId}` : "Deleted";
		},
	});

	// archive_session（session-manager-archive-delete U4）：AI 主动可调的收尾整理动作，
	// 纪律写为正向指引（与 delete 的人身禁令相反）；archive_io_error 两态善后文案
	// 按设计 §3.1 R1 修正（T2 D-1-7）：搬移前失败重试安全 / 搬移中途失败同进程重试
	// 改报 not found——该形态 = 搬移部分完成，提示重启由启动自愈归位，不是已归档完成。
	registerSessionTool(pi, {
		name: "archive_session",
		label: "Archive Session",
		promptSnippet:
			"Archive one of your managed sessions to tidy the sidebar — reversible by the user; appropriate to call on your own initiative when a session's work is finished.",
		description: `Archive one of your managed sessions — it leaves the active sidebar and moves to the archive area (compressed); the user can view its summary and restore it anytime. Reversible by the user.

Appropriate to call on your own initiative when a child session's work is finished and you want to keep its history but tidy the sidebar. The session must not be generating — abort first or wait for completion, otherwise the call errors with archive_generating. On success any open completion-watch for it resolves as 'exited'.

Different from abort_session (stops the current run, session kept) and delete_session (irreversible): archiving keeps the full history and the user can restore the session anytime. If the session is already archived the call errors with archive_already_archived — no need to call again.

On archive_io_error the outcome depends on when the failure happened: if the session file had not been moved yet, retrying the call is safe; if the failure happened mid-move, a same-process retry reports 'target session not found' — that means the archive is partially done (NOT completed): tell the user to restart the app so the startup self-heal moves the session back to its original place, and do not treat it as already archived.

## Example
{"sessionId":"<id from list_my_sessions>"}

Ids come from list_my_sessions — never guess; on unknown-id error re-list, don't retry the same id. Requires the taiji desktop runtime (in standalone pi this tool hangs forever — no runtime answers the channel).`,
		parameters: ArchiveSessionParams,
		action: "archive",
		toParams: (p) => ({ sessionId: p.sessionId }),
		toSummary: (params) => {
			const sessionId = stringField(params, "sessionId");
			return sessionId ? `Archived ${sessionId}` : "Archived";
		},
	});
}
