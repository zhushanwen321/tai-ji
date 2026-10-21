// protocol.ts — Trae SOLO 通道协议常量表（端点 / 固定头族 / 版本门禁 / 错误码）。
//
// 事实来源（2026-10-21 探针实测 + 开源参照，实测结论落 runlog）：
// - 网关 = https://trae-api-cn.mchost.guru（CN 区；userRegion 非 CN 时上游域不同，
//   首版只交付 CN 区——设计 §1 非目标声明不覆盖跨区交付）。
// - 对话端点 = POST /api/agent/v3/llm_utils_chat（实测 200 text/event-stream；
//   /api/ide/... 路径族实测 4011 限流形态，不用）。
// - 模型目录端点 = POST /api/ide/v1/get_detail_param（实测 200；请求体必须带
//   function/config_names 等 7 字段，空 body = 500）。
// - 令牌刷新端点 = POST /cloudide/api/v3/trae/oauth/ExchangeToken（开源参照
//   Ttungx/trae-solo-local-api auth.js exchangeToken 实装路径）。
// - 固定头族 = SOLO 真实流量头形态（对照同上 auth.js buildCommonHeaders；
//   IDE 桌面 bundle 无 SOLO 通道头族——该通道由云端 Web 客户端发出）。
// - 版本门禁：x-ide-version / x-ide-version-code 参与模型可用性判定（版本过期
//   模型成批 4001），随 IDE 演进更新这两个常量即可跟随。

import crypto from "node:crypto";

/** 上游网关根（CN 区）。 */
export const TRAE_GATEWAY_CN = "https://trae-api-cn.mchost.guru";

/** 对话端点（自定义 SSE）。 */
export const CHAT_ENDPOINT = "/api/agent/v3/llm_utils_chat";

/** 模型目录端点。 */
export const CATALOG_ENDPOINT = "/api/ide/v1/get_detail_param";

/** 令牌刷新端点（ExchangeToken：RefreshToken → 新 JWT）。 */
export const REFRESH_ENDPOINT = "/cloudide/api/v3/trae/oauth/ExchangeToken";

/**
 * 版本门禁头值（包内常量，随 IDE 版本演进手动更新——版本过期模型成批 4001）。
 * 0.1.52 / 20260811 = 2026-10-21 实测可用值。
 */
export const X_IDE_VERSION = "0.1.52";
export const X_IDE_VERSION_CODE = "20260811";

/** SOLO 客户端应用 id（开源参照实测可用值；上游按此识别客户端形态）。 */
export const X_APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8";

/** SOLO 免费对话通道（function 字段）。TRAE Work 编程通道锁在 IDE 本地加密库，非目标。 */
export const SOLO_FUNCTION = "solo_work_lite";

/** 首发测试模型（任务书指定；对话探针与 P5 实测模型）。 */
export const TRAE_TEST_MODEL_ID = "deepseek-v4.1-flash"; // oe-exempt:20261022:wip:任务书指定的 P5 实测模型常量——实测/探针接线提交后消费，暂零引用（30 天复检）

/** 请求鉴权与设备要素（凭据解析 + storage.json 明文键推导）。 */
export type TraeAuthInputs = {
	/** Cloud-IDE-JWT（storage.json 容器解密所得 token）。 */
	token: string;
	/** 账号 userId（容器 payload.userId）。 */
	userId: string;
	/** IDE telemetry.machineId（storage.json 明文键）。 */
	machineId: string;
	/** SOLO 设备 id（storage.json 键名 `iCubeAuthInfo://icube-dc:<digits>` 的数字段）。 */
	soloDeviceId: string;
};

/** trace id 的 hex 字符数（开源参照形态：32 hex = 128 bit）。 */
const TRACE_ID_HEX_LEN = 32;

/** span id 的 hex 字符数（trace id 前 16 位——W3C traceparent 派生形态）。 */
const SPAN_ID_HEX_LEN = 16;

/** 十六进制基数（randomHex 内部）。 */
const HEX_RADIX = 16;

/** 错误响应体截断长度（错误消息可读性）。 */
const ERROR_BODY_SNIPPET = 200;

/** 上游错误码（对话端点 JSON body 的 code 字段；实测语义表）。 */
const CODE_RELOGIN_REQUIRED = 1001;
const CODE_UPSTREAM_COOLDOWN = 1005;
const CODE_VERSION_OR_MODEL_INVALID = 4001;
const CODE_QUOTA_EXHAUSTED = 4008;
const CODE_RATE_LIMITED = 4011;
const CODE_CHECKIN_RETRY = 9074;

/**
 * 组装 SOLO 通道请求头族（19 固定头；流式请求另加 3 头，见 buildStreamHeaders）。
 * 任务书「14 固定头」为调研期口径，实测有效集以本表为准（多出的头不报错，
 * 缺头被上游风控拦截——按超集实装）。
 */
export function buildCommonHeaders(auth: TraeAuthInputs): Record<string, string> {
	const traceId = randomHex(TRACE_ID_HEX_LEN);
	const spanId = traceId.slice(0, SPAN_ID_HEX_LEN);
	return {
		"Content-Type": "application/json",
		Authorization: `Cloud-IDE-JWT ${auth.token}`,
		"X-Cloudide-Token": auth.token,
		"x-app-id": X_APP_ID,
		"x-app-version": "default",
		"x-ide-version-code": X_IDE_VERSION_CODE,
		"x-app-version-code": X_IDE_VERSION_CODE,
		"x-custom-trace-id": traceId,
		"x-flow-traceparent": `04-${traceId}-${spanId}-01`,
		"x-device-brand": "Mac",
		"x-device-cpu": process.arch,
		"x-device-id": auth.soloDeviceId || auth.userId,
		"x-machine-id": auth.machineId,
		"x-os-version": `${process.platform} ${process.version}`,
		"x-device-type": process.platform === "darwin" ? "macOS" : process.platform,
		"x-ide-version": X_IDE_VERSION,
		"x-ide-version-type": "stable",
		"request-traffic-type": "prod",
		"x-uid": auth.userId,
	};
}

/** 流式请求头族：固定头族 + Accept/SSE 请求追踪三件。 */
export function buildStreamHeaders(auth: TraeAuthInputs): Record<string, string> {
	const requestId = crypto.randomUUID();
	return {
		...buildCommonHeaders(auth),
		Accept: "text/event-stream",
		"X-Request-ID": requestId,
		"X-Trae-Request-ID": requestId,
	};
}

function randomHex(length: number): string {
	let out = "";
	while (out.length < length) {
		out += Math.floor(Math.random() * HEX_RADIX).toString(HEX_RADIX);
	}
	return out.slice(0, length);
}

export const TRAE_ERROR_SEMANTICS: ReadonlyMap<number, string> = new Map([
	[CODE_RELOGIN_REQUIRED, "登录态失效：打开 Trae IDE 重新登录后重试"],
	[CODE_UPSTREAM_COOLDOWN, "上游冷却中（约 12 小时）：稍后再试"],
	[CODE_VERSION_OR_MODEL_INVALID, "版本或模型名失效：更新扩展包的版本门禁常量或刷新模型列表"],
	[CODE_QUOTA_EXHAUSTED, "额度已用尽"],
	[CODE_RATE_LIMITED, "请求过快（上游限流）：稍后重试"],
	[CODE_CHECKIN_RETRY, "签到重试中：稍后再试"],
]);

/** 从上游响应体提取业务错误码与语义（读侧不信任外部格式）。 */
export function describeUpstreamError(bodyText: string): string {
	let code: number | undefined;
	try {
		const parsed: unknown = JSON.parse(bodyText);
		if (typeof parsed === "object" && parsed !== null) {
			const record = parsed as Record<string, unknown>;
			if (typeof record.code === "number") {
				code = record.code;
			} else if (typeof record.code === "string" && /^\d+$/.test(record.code)) {
				code = Number(record.code);
			}
		}
	} catch {
		// 非 JSON 错误体（如网关 500 纯文本）：code 保持 undefined，走下方无码分支
		code = undefined;
	}
	if (code !== undefined) {
		const semantic = TRAE_ERROR_SEMANTICS.get(code);
		return semantic !== undefined ? `上游错误 ${code}：${semantic}` : `上游错误 ${code}：${bodyText.slice(0, ERROR_BODY_SNIPPET)}`;
	}
	return `上游错误：${bodyText.slice(0, ERROR_BODY_SNIPPET)}`;
}
