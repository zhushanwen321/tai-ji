// openapi.ts — openapi 域客户端（纯 Bearer dt-/PAT 直调，无 COSY 签名）。
//
// 参照 shuishuipingan/qoder2api-hub v1.6.4 qoder_accounts.py 的 headers()/refresh()/
// fetch_credits()：userinfo / quota/usage / deviceToken/refresh 三个端点均为纯 Bearer
// （探针 200 实测，任务书协议事实锚）。全部出站请求统一经 globalThis.fetch（设计 D1
// 约束——network-proxy 包装层覆盖，禁止 undici 实例 / node:https 绕过）。

import { randomUUID } from "node:crypto";

import { OPENAPI_BASE_URL, OPENAPI_USER_AGENT, PATH_DEVICE_TOKEN_REFRESH, PATH_QUOTA_USAGE, PATH_USERINFO } from "./constants.ts";
import { deriveId } from "./cosy.ts";

/** 错误消息内响应摘录的最大长度（防长响应刷屏日志/错误消息）。 */
const ERROR_EXCERPT_LENGTH = 200;
/** 设备令牌缺省有效期兜底（30 天 = 2_592_000_000 ms；上游 expiresAt 缺失时估）。 */
const DEVICE_TOKEN_DEFAULT_TTL_MS = 2_592_000_000;

/** openapi 域请求头（hub Account.headers 同款：官方客户端 UA + 稳定机器头；
 * 通用 UA 等于自报脚本）。uid 用于派生稳定机器头（同一账号恒同值）。 */
export function openapiHeaders(accessToken: string, uid: string): Record<string, string> {
	return {
		"Content-Type": "application/json",
		Accept: "application/json, text/plain, */*",
		"User-Agent": OPENAPI_USER_AGENT,
		Authorization: `Bearer ${accessToken}`,
		"X-Request-ID": randomUUID(),
		"X-Machine-ID": deriveId(uid, "machine"),
		"X-Session-ID": deriveId(uid, "session"),
		Origin: "https://qoder.com.cn",
		Referer: "https://qoder.com.cn/",
	};
}

/** openapi 域 JSON GET（fetch 统一出口；非 2xx 抛带状态码与响应摘录的 Error）。 */
async function openapiGet(path: string, accessToken: string, uid: string, signal?: AbortSignal): Promise<unknown> {
	const response = await fetch(`${OPENAPI_BASE_URL}${path}`, {
		method: "GET",
		headers: openapiHeaders(accessToken, uid),
		signal,
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`openapi ${path} failed: HTTP ${response.status} ${text.slice(0, ERROR_EXCERPT_LENGTH)}`);
	}
	return JSON.parse(text) as unknown;
}

/** GET /api/v1/userinfo → {id, name, user_type, organization_id, organization_name}。 */
export async function fetchUserinfo(accessToken: string, uid: string, signal?: AbortSignal): Promise<QoderUserinfo> {
	const payload = await openapiGet(PATH_USERINFO, accessToken, uid, signal);
	if (typeof payload !== "object" || payload === null || typeof (payload as Record<string, unknown>).id !== "string") {
		throw new Error("openapi userinfo: unexpected response shape (missing id)");
	}
	const record = payload as Record<string, unknown>;
	return {
		id: record.id as string,
		name: typeof record.name === "string" ? record.name : "",
		...(typeof record.user_type === "string" ? { userType: record.user_type } : {}),
		...(typeof record.organization_id === "string" ? { organizationId: record.organization_id } : {}),
		...(typeof record.organization_name === "string" ? { organizationName: record.organization_name } : {}),
	};
}

export type QoderUserinfo = {
	id: string;
	name: string;
	userType?: string;
	organizationId?: string;
	organizationName?: string;
};

/** quota 响应中的单个额度对象（上游字段 used/remaining/total，hub fetch_credits 口径）。 */
type RawQuotaBucket = {
	used?: unknown;
	remaining?: unknown;
	total?: unknown;
};

export type QoderQuotaSummary = {
	used: number;
	remaining: number;
	total: number;
};

function bucketNumber(bucket: RawQuotaBucket | undefined, key: "used" | "remaining" | "total"): number {
	const value = bucket?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** GET /api/v2/quota/usage → 基础额度 + 赠送/签到额度合计（hub fetch_credits 聚合口径：
 * used/remaining/total 分别为 userQuota 与 addOnQuota 两桶之和）。 */
export async function fetchQuotaUsage(accessToken: string, uid: string, signal?: AbortSignal): Promise<QoderQuotaSummary> {
	const payload = await openapiGet(PATH_QUOTA_USAGE, accessToken, uid, signal);
	if (typeof payload !== "object" || payload === null) {
		throw new Error("openapi quota/usage: unexpected response shape");
	}
	const record = payload as Record<string, unknown>;
	const userQuota = (record.userQuota ?? undefined) as RawQuotaBucket | undefined;
	const addOnQuota = (record.addOnQuota ?? undefined) as RawQuotaBucket | undefined;
	return {
		used: bucketNumber(userQuota, "used") + bucketNumber(addOnQuota, "used"),
		remaining: bucketNumber(userQuota, "remaining") + bucketNumber(addOnQuota, "remaining"),
		total: bucketNumber(userQuota, "total") + bucketNumber(addOnQuota, "total"),
	};
}

/** deviceToken 刷新响应（上游形态：token/refresh_token/expiresAt 字段族，
 * hub _post_token kind="device" 分支 + _device_expiry 口径）。 */
export type QoderDeviceTokenRefresh = {
	token: string;
	refreshToken: string;
	expiresAt: number;
};

/** POST /api/v1/deviceToken/refresh：drt- 换新 dt-（hub Account.refresh kind="device"）。
 * 失败（401/403 = 会话死，重登）抛 Error；pi 侧 refreshToken 钩子失败即触发重新 login。 */
export async function refreshDeviceToken(refreshToken: string, signal?: AbortSignal): Promise<QoderDeviceTokenRefresh> {
	const response = await fetch(`${OPENAPI_BASE_URL}${PATH_DEVICE_TOKEN_REFRESH}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
			// 刷新同样发官方客户端 UA（hub _post_token 注：与 headers() 同口径）。
			"User-Agent": OPENAPI_USER_AGENT,
		},
		body: JSON.stringify({ refresh_token: refreshToken }),
		signal,
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`deviceToken refresh failed: HTTP ${response.status} ${text.slice(0, ERROR_EXCERPT_LENGTH)}`);
	}
	let payload: unknown;
	try {
		payload = JSON.parse(text) as unknown;
	} catch {
		throw new Error("deviceToken refresh: response is not JSON");
	}
	if (typeof payload !== "object" || payload === null) {
		throw new Error("deviceToken refresh: unexpected response shape");
	}
	const record = payload as Record<string, unknown>;
	const token = record.token ?? record.device_token;
	if (typeof token !== "string" || token.length === 0) {
		throw new Error("deviceToken refresh: response returned no token (session may be dead; re-login required)");
	}
	const nextRefresh = typeof record.refresh_token === "string" && record.refresh_token.length > 0 ? record.refresh_token : refreshToken;
	return {
		token,
		refreshToken: nextRefresh,
		// 上游 expiresAt 为 epoch ms（本机 auth.v1.dat 实测同单位）；缺省按 30 天
		// 设备令牌有效期估（hub _device_expiry 同兜底方向），仅为 pi 刷新时机提示。
		expiresAt:
			typeof record.expiresAt === "number"
				? record.expiresAt
				: Date.now() + DEVICE_TOKEN_DEFAULT_TTL_MS,
	};
}
