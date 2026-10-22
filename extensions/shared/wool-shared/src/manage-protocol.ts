// manage-protocol.ts — taiji↔羊毛扩展的管理指令协议（请求/响应/错误 envelope）。
//
// 通道形态（P6 探针定夺，实装事实链）：宿主 → 扩展方向走 pi 原生的「prompt 命令分发」——
// AgentSession.prompt 对 "/" 开头输入优先尝试扩展命令（pi 1.0.0 实装
// dist/core/agent-session.js:1494-1501 `_tryExecuteExtensionCommand`，命中即执行、
// 不进 LLM、preflight 返回 "handled"）。扩展经 pi.registerCommand 注册管理命令，
// taiji 管理专用会话（D6：hidden RPC 会话，即起即收）对 pi 发
// `{type:"prompt", message:"/wool-<family> <json envelope>"}` 直达 handler。
// 执行结果经 pi.appendEntry 落 custom entry（管理会话回收前宿主经 get_entries 拉取；
// 会话文件即结果载体，无第二通道）。
//
// 反方向（扩展 → 宿主的交互请求：提取确认框、授权浮层）不经本模块——走 pi RPC
// 扩展 UI 子协议（extension_ui_request/response，session-manager marker 先例），
// 由各家族扩展按需使用。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 管理命令名前缀：每家族注册 `wool-<family>` 一个命令（family 为自由文本——echo
 * 参考扩展同样走本协议，三家词表强类型由 types.ts 的 WoolFamilyId 承担）。 */
export function woolManageCommandName(family: string): string {
	return `wool-${family}`;
}

/** 管理动作词表。extract/authorize = 凭据获取动作（D2 改道后的向导触发点：
 * taiji 向导经管理会话让扩展执行一次提取/授权，凭据随响应回传宿主写入
 * models.json 羊毛 provider 条目 apiKey）。 */
export const WOOL_MANAGE_ACTIONS = ["status", "detect", "checkin", "clear", "extract", "authorize"] as const;

export type WoolManageAction = (typeof WOOL_MANAGE_ACTIONS)[number];

/**
 * 错误码词表（机器可读，taiji 侧按码分流呈现）：
 * - invalid_request：envelope 非法/动作不支持（宿主侧 bug，重试无意义）
 * - not_logged_in：无凭据，宿主应引导接入流程
 * - upstream_error：上游服务调用失败（可重试）
 * - internal：扩展内部异常（看扩展日志）
 */
export const WOOL_MANAGE_ERROR_CODES = [
	"invalid_request",
	"not_logged_in",
	"upstream_error",
	"internal",
] as const;

export type WoolManageErrorCode = (typeof WOOL_MANAGE_ERROR_CODES)[number];

/** 请求 envelope：命令参数就是一个 JSON 对象文本。 */
export interface WoolManageRequest { // oe-exempt:20261022:framework:taiji↔扩展管理协议请求 envelope——宿主管理会话构造 /wool-<family> 参数文本、parseWoolManageRequest 唯一解析入口（宿主侧对齐形状见 packages/shared/src/wool.ts 管理协议注释）
	v: 1;
	action: WoolManageAction;
	/** 动作参数（status 无参；checkin 可带 { day?: string } 等）。 */
	params?: Record<string, unknown>;
}

/**
 * extract/authorize 成功响应 data 契约（两组共享同形，宿主侧按此消费——apiKey 回写
 * models.json 羊毛 provider 条目，其余字段为展示/到期提示增值）：
 * - extract：apiKey = 本机提取的访问令牌（Qoder dt- / Trae Cloud-IDE-JWT），refreshToken 随提取链带出时给出；
 * - authorize：apiKey = OAuth access token，refreshToken = 轮换刷新令牌。
 */
export interface WoolCredentialAcquireData { // oe-exempt:20261022:framework:凭据获取动作响应契约——qoder/trae(workbuddy) 家族 index.ts handler 构造 + taiji 宿主侧（packages/ wool-manager）形状对齐消费
	credentials: {
		apiKey: string;
		refreshToken?: string;
	};
	account?: {
		displayName?: string;
	};
	/** 访问令牌到期时点（Unix ms；未知缺省）。 */
	expiresAt?: number;
}

/** 响应 envelope：成功带 data，失败带错误码与消息。 */
export type WoolManageResponse =
	| { v: 1; ok: true; data: unknown }
	| { v: 1; ok: false; error: { code: WoolManageErrorCode; message: string } };

/** envelope 协议版本（结构演进时升版本，宿主按版本分流）。 */
export const WOOL_MANAGE_PROTOCOL_VERSION = 1;

/** 解析失败错误：消息内嵌正确调用形态（错误 → 权威源 → 重试闭环）。 */
export class WoolManageRequestError extends Error {
	readonly code: WoolManageErrorCode;

	constructor(message: string, code: WoolManageErrorCode = "invalid_request") {
		super(message);
		this.name = "WoolManageRequestError";
		this.code = code;
	}
}

/**
 * 解码命令参数为请求 envelope。任何非法形态 throw WoolManageRequestError
 * （错误码 invalid_request），消息指向正确的命令用法。
 */
export function parseWoolManageRequest(rawArgs: string, family: string): WoolManageRequest {
	const text = rawArgs.trim();
	const usageHint = `Expected: /${woolManageCommandName(family)} {"action":"<${WOOL_MANAGE_ACTIONS.join("|")}>","params":{...}}`;
	if (text.length === 0) {
		throw new WoolManageRequestError(`Empty arguments. ${usageHint}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new WoolManageRequestError(
			`Arguments are not valid JSON (${error instanceof Error ? error.message : String(error)}). ${usageHint}`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new WoolManageRequestError(`Request envelope must be a JSON object. ${usageHint}`);
	}
	const record = parsed as Record<string, unknown>;
	if (record.v !== WOOL_MANAGE_PROTOCOL_VERSION) {
		throw new WoolManageRequestError(
			`Unsupported envelope version ${String(record.v)}; expected v${WOOL_MANAGE_PROTOCOL_VERSION}. ${usageHint}`,
		);
	}
	if (typeof record.action !== "string" || !(WOOL_MANAGE_ACTIONS as readonly string[]).includes(record.action)) {
		throw new WoolManageRequestError(
			`Unknown action ${JSON.stringify(record.action)}; expected one of ${WOOL_MANAGE_ACTIONS.join(", ")}. ${usageHint}`,
		);
	}
	const params = record.params;
	if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) {
		throw new WoolManageRequestError(`"params" must be a JSON object when present. ${usageHint}`);
	}
	return {
		v: WOOL_MANAGE_PROTOCOL_VERSION,
		action: record.action as WoolManageAction,
		...(params !== undefined ? { params: params as Record<string, unknown> } : {}),
	};
}

/** 构造成功响应 envelope。 */
export function woolManageOk(data: unknown): WoolManageResponse {
	return { v: WOOL_MANAGE_PROTOCOL_VERSION, ok: true, data };
}

/** 构造失败响应 envelope。 */
export function woolManageFail(code: WoolManageErrorCode, message: string): WoolManageResponse {
	return { v: WOOL_MANAGE_PROTOCOL_VERSION, ok: false, error: { code, message } };
}

/** 运行时守卫：宿主拉取 entries 后按此识别管理响应 entry 数据（读侧不信任外部格式）。 */
export function isWoolManageResponse(value: unknown): value is WoolManageResponse {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	if (record.v !== WOOL_MANAGE_PROTOCOL_VERSION) {
		return false;
	}
	if (record.ok === true) {
		return true;
	}
	if (record.ok !== false) {
		return false;
	}
	const error = record.error;
	return (
		typeof error === "object" &&
		error !== null &&
		typeof (error as Record<string, unknown>).code === "string" &&
		typeof (error as Record<string, unknown>).message === "string"
	);
}

/** 管理响应落盘的 custom entry 类型（appendEntry customType）。 */
export const WOOL_MANAGE_ENTRY_TYPE = "wool-manage-response";

/** 家族侧管理动作 handler 的执行上下文：动作执行期需要主动触达宿主/用户的通道
 * （ authorize 的授权页 URL 投递等）。窄面投影而非透传完整 ctx——家族只见协议内能力。 */
export interface WoolManageActionContext { // oe-exempt:20261022:framework:管理动作执行上下文契约——wool-shared registerWoolManageCommand 构造（ctx.ui.notify 投影）+ 三家族 handler 消费（workbuddy authorize 投递授权页 URL）
	/** 扩展 UI 通知通道（pi ctx.ui.notify 形态；P6 验证的扩展→宿主投递面）。 */
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

/** 家族侧管理动作 handler：执行一个管理动作，返回响应 envelope 的 data 部分。
 * 第二参数为执行上下文（仅 authorize 等需宿主交互的动作消费；单参 handler 兼容）。 */
export type WoolManageActionHandler = (
	params: Record<string, unknown> | undefined,
	ctx: WoolManageActionContext,
) => Promise<unknown>;

export interface WoolManageHandlers { // oe-exempt:20261022:framework:管理动作 handler 族契约——qoder/trae/workbuddy 三家 index.ts 的 manageHandlers 定义项构造 + registerWoolManageCommand 动作分发消费
	status: WoolManageActionHandler;
	detect: WoolManageActionHandler;
	checkin: WoolManageActionHandler;
	clear: WoolManageActionHandler;
	/** 本机凭据提取（ide-extract 家族：qoder/trae）；oauth 家族不实现 → 动作分发回 invalid_request。 */
	extract?: WoolManageActionHandler;
	/** OAuth 浏览器授权（oauth 家族：workbuddy）；ide-extract 家族不实现 → 动作分发回 invalid_request。 */
	authorize?: WoolManageActionHandler;
}

/**
 * 注册管理命令（`wool-<family>`）：解析 envelope → 分发动作 → appendEntry 回写响应。
 * handler throw 时回写 ok:false envelope（错误码按异常类型映射：WoolManageRequestError
 * 带码，其余 internal），不向会话抛未捕获异常——管理会话的失败也是结果，宿主按
 * envelope 消费，命令通道本身不承载错误语义。
 *
 * onAction = 动作执行痕回调（可选）：命令-only 的管理专用会话（无 user/assistant 消息）
 * pi 文件不 flush，entry 仅内存态——宿主跨进程实证「指令已到达扩展」时经此打宿主可见
 * 痕（stderr 诊断等），不承载结果语义（结果仍以 entry 为准）。
 */
export function registerWoolManageCommand(
	pi: ExtensionAPI,
	options: { family: string; handlers: WoolManageHandlers; onAction?: (action: WoolManageAction) => void },
): void {
	const commandName = woolManageCommandName(options.family);
	pi.registerCommand(commandName, {
		description: `Wool provider management for ${options.family} (taiji manage-session channel)`,
		handler: async (args, ctx) => {
			let response: WoolManageResponse;
			try {
				const request = parseWoolManageRequest(args, options.family);
				const handler = options.handlers[request.action];
				if (handler === undefined) {
					// 家族未实现该动作（如 oauth 家族的 extract）：明确报不支持，不静默假成功。
					response = woolManageFail(
						"invalid_request",
						`Action "${request.action}" is not supported by the wool-${options.family} extension`,
					);
				} else {
					const data = await handler(request.params, {
						notify: (message, type) => ctx.ui.notify(message, type),
					});
					response = woolManageOk(data);
					options.onAction?.(request.action);
				}
			} catch (error) {
				if (error instanceof WoolManageRequestError) {
					response = woolManageFail(error.code, error.message);
				} else {
					response = woolManageFail(
						"internal",
						error instanceof Error ? error.message : String(error),
					);
				}
			}
			pi.appendEntry(WOOL_MANAGE_ENTRY_TYPE, { family: options.family, response });
		},
	});
}
