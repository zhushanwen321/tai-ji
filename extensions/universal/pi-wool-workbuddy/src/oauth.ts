// oauth.ts — WorkBuddy OAuth 流（pi oauth 钩子族实装：login / refreshToken / getApiKey）。
//
// 上游协议 = state 轮询（非授权码回调；hub wb_accounts start_login / poll_login 实读）：
// ① POST /v2/plugin/auth/state?platform=CLI → {state, authUrl}
// ② 用户浏览器开 authUrl 登录
// ③ GET /v2/plugin/auth/token?state= → code 11217 = pending / code 0 → 凭据四元组
// ④ GET /v2/plugin/login/account?state=（Bearer）→ 昵称
// 刷新 = POST /v2/plugin/auth/token/refresh（refreshToken 轮换）。
//
// login 编排（设计 D3）：扩展起本机回调监听 → onAuth 把授权页 URL + 回调端点通知
// taiji（浮层加载授权页）→ 浮层在用户完成授权后发 done 信号 → 扩展执行令牌交换 →
// 回调送达即完成。全程事件驱动（授权期临时监听，完成/取消/失败/abort 即回收）。

import type { Credential, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { WoolCredentialAcquireData } from "@zhushanwen/pi-wool-shared";

import { startWoolAuthCallbackServer } from "./callback-server.ts";
import {
	AUTH_STATE_PATH,
	AUTH_TOKEN_PATH,
	DEFAULT_TOKEN_TTL_MS,
	ERROR_DETAIL_MAX_CHARS,
	LOGIN_ACCOUNT_PATH,
	LOGIN_PENDING_CODE,
	MS_PER_SECOND,
	OAUTH_PLATFORM,
	REFRESH_PATH,
	type WorkbuddyRealm,
	isWorkbuddyRealm,
} from "./constants.ts";
import { isRecord } from "./guards.ts";
import { buildOAuthStateHeaders, buildRefreshHeaders, realmConfig } from "./headers.ts";
import { decodeJwtClaims } from "./jwt.ts";

/** WorkBuddy 凭据的扩展字段（OAuthCredentials 开放索引签名，auth.json 原样持久化）。 */
export type WorkbuddyCredentials = OAuthCredentials & {
	/** 账号 uid（JWT sub；X-User-Id / 设备指纹派生源）。 */
	uid: string;
	/** 登录拉取的昵称（拉取失败缺省）。 */
	nickname?: string;
	/** 登录时上游返回的 domain（X-Domain 优先值）。 */
	domain?: string;
	/** 双区配置键。 */
	realm: WorkbuddyRealm;
};

/** credentials 扩展字段收窄（读侧不信任外部格式）。 */
export function asWorkbuddyCredentials(credentials: OAuthCredentials): WorkbuddyCredentials {
	return credentials as WorkbuddyCredentials;
}

/** Credential 判别收窄：WorkBuddy 只走 OAuth（apiKey 形态凭据不适用本家族）。
 * 构造式收窄（不整体断言）：扩展字段按存在性读取，缺省回 CN/空 uid。 */
export function asWorkbuddyCredential(
	credential: Credential | undefined,
): WorkbuddyCredentials | undefined {
	if (credential === undefined || credential.type !== "oauth") {
		return undefined;
	}
	return {
		...credential,
		uid: typeof credential.uid === "string" ? credential.uid : "",
		realm: isWorkbuddyRealm(credential.realm) ? credential.realm : "cn",
		...(typeof credential.nickname === "string" ? { nickname: credential.nickname } : {}),
		...(typeof credential.domain === "string" ? { domain: credential.domain } : {}),
	};
}

/** JSON envelope 业务形态。 */
type Envelope = {
	code?: number;
	msg?: string;
	data?: Record<string, unknown>;
};

async function fetchJson(
	url: string,
	init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
): Promise<Envelope> {
	const response = await fetch(url, init);
	const text = await response.text();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`WorkBuddy endpoint returned non-JSON (HTTP ${response.status}): ${text.slice(0, ERROR_DETAIL_MAX_CHARS)}`);
	}
	if (!response.ok) {
		const envelope = isRecord(parsed) ? parsed : undefined;
		const detail =
			(typeof envelope?.msg === "string" ? envelope.msg : undefined) ??
			(typeof envelope?.message === "string" ? envelope.message : undefined) ??
			text.slice(0, ERROR_DETAIL_MAX_CHARS);
		throw new Error(`WorkBuddy endpoint HTTP ${response.status}: ${detail}`);
	}
	if (!isRecord(parsed)) {
		throw new Error("WorkBuddy endpoint returned a non-object envelope");
	}
	return parsed as Envelope;
}

/** ① 起 state：返回 {state, authUrl}。 */
export async function startAuthState(realm: WorkbuddyRealm, signal?: AbortSignal): Promise<{ state: string; authUrl: string }> {
	const config = realmConfig(realm);
	const payload = await fetchJson(`${config.chatUpstream}${AUTH_STATE_PATH}?platform=${encodeURIComponent(OAUTH_PLATFORM)}`, {
		method: "POST",
		headers: buildOAuthStateHeaders(realm),
		body: "{}",
		signal,
	});
	const data = payload.data ?? {};
	const state = typeof data.state === "string" ? data.state : "";
	const authUrl = typeof data.authUrl === "string" ? data.authUrl : "";
	if (state.length === 0 || authUrl.length === 0) {
		throw new Error(`WorkBuddy auth/state returned no state/authUrl (code ${String(payload.code)} ${payload.msg ?? ""})`);
	}
	return { state, authUrl };
}

/** token 端点返回的业务形态。 */
export type TokenExchangeResult = {
	status: "pending" | "ok";
	credentials?: { accessToken: string; refreshToken: string; expiresAt?: number; domain?: string };
};

/** ③ 令牌交换（一次尝试；pending = 用户尚未在浏览器完成授权）。 */
export async function exchangeToken(realm: WorkbuddyRealm, state: string, signal?: AbortSignal): Promise<TokenExchangeResult> {
	const config = realmConfig(realm);
	const payload = await fetchJson(`${config.chatUpstream}${AUTH_TOKEN_PATH}?state=${encodeURIComponent(state)}`, {
		method: "GET",
		headers: buildOAuthStateHeaders(realm),
		signal,
	});
	if (payload.code === LOGIN_PENDING_CODE) {
		return { status: "pending" };
	}
	if (payload.code !== 0) {
		throw new Error(`WorkBuddy auth/token failed: code ${String(payload.code)} ${payload.msg ?? ""}`);
	}
	const data = payload.data ?? {};
	const accessToken = typeof data.accessToken === "string" ? data.accessToken : "";
	if (accessToken.length === 0) {
		return { status: "pending" }; // code 0 但 token 未就绪：按等待处理
	}
	return {
		status: "ok",
		credentials: {
			accessToken,
			refreshToken: typeof data.refreshToken === "string" ? data.refreshToken : "",
			...(typeof data.expiresAt === "number" ? { expiresAt: data.expiresAt } : {}),
			...(typeof data.domain === "string" ? { domain: data.domain } : {}),
		},
	};
}

/** ④ 登录昵称拉取（失败静默——昵称是展示增值字段）。 */
async function fetchNickname(realm: WorkbuddyRealm, state: string, accessToken: string): Promise<string | undefined> {
	const config = realmConfig(realm);
	try {
		const payload = await fetchJson(`${config.chatUpstream}${LOGIN_ACCOUNT_PATH}?state=${encodeURIComponent(state)}`, {
			method: "GET",
			headers: { ...buildOAuthStateHeaders(realm), Authorization: `Bearer ${accessToken}` },
		});
		const nickname = payload.data?.nickname;
		return typeof nickname === "string" && nickname.length > 0 ? nickname : undefined;
	} catch {
		return undefined;
	}
}

/** realm 推断：登录返回的 domain 优先，缺省 cn（任务书协议锚）。 */
function realmOf(domain: string | undefined, fallback: WorkbuddyRealm): WorkbuddyRealm {
	if (domain === realmConfig("intl").domain) {
		return "intl";
	}
	if (domain === realmConfig("cn").domain) {
		return "cn";
	}
	return fallback;
}

/** credentials 组装（expiresAt 缺省从 JWT exp 解；仍缺省按 30 分钟窗口由 pi 刷新链兜住）。 */
export function toWorkbuddyCredentials(
	realm: WorkbuddyRealm,
	exchanged: NonNullable<TokenExchangeResult["credentials"]>,
	nickname: string | undefined,
): WorkbuddyCredentials {
	const claims = decodeJwtClaims(exchanged.accessToken);
	const expiresAt = exchanged.expiresAt ?? (typeof claims?.exp === "number" ? claims.exp * MS_PER_SECOND : Date.now() + DEFAULT_TOKEN_TTL_MS);
	const resolvedRealm = realmOf(exchanged.domain, realm);
	return {
		access: exchanged.accessToken,
		refresh: exchanged.refreshToken,
		expires: expiresAt,
		uid: typeof claims?.sub === "string" ? claims.sub : "",
		...(nickname !== undefined ? { nickname } : {}),
		...(exchanged.domain !== undefined ? { domain: exchanged.domain } : {}),
		realm: resolvedRealm,
	};
}

/**
 * OAuth 授权编排（login 钩子与 authorize 管理动作共用骨架）：
 * state 起始 → 本机回调监听 → deliverAuthInfo 把授权页 URL + 回调端点交给调用方
 * （login = pi onAuth 通道；authorize = 扩展 UI 通知 taiji 浮层）→ 回调 done 驱动
 * 令牌交换 → 昵称拉取（失败降级）→ 凭据组装。全程事件驱动，无轮询无定时器
 * （时间平抑红线）；回调监听在完成/取消/失败/投递异常时即回收。
 */
export async function runWorkbuddyAuthorization(options: {
	realm?: WorkbuddyRealm;
	signal?: AbortSignal;
	/** 授权页投递（调用方决定通道：pi onAuth / 扩展 UI notify）。 */
	deliverAuthInfo: (info: { authUrl: string; callbackUrl: string; state: string }) => void;
}): Promise<WorkbuddyCredentials> {
	const realm = options.realm ?? "cn";
	const signal = options.signal;
	if (signal?.aborted) {
		throw new DOMException("Login cancelled", "AbortError");
	}
	const { state, authUrl } = await startAuthState(realm, signal);

	let exchanged: NonNullable<TokenExchangeResult["credentials"]> | undefined;
	const callbackServer = await startWoolAuthCallbackServer({
		state,
		signal,
		onDone: async () => {
			const result = await exchangeToken(realm, state, signal);
			if (result.status === "pending") {
				return {
					completed: false,
					pageMessage: "Authorization is not finished in the browser yet. Finish signing in, then press the confirm button again.",
				};
			}
			exchanged = result.credentials;
			return { completed: true, pageMessage: "WorkBuddy is connected. You may close this page." };
		},
	});

	try {
		options.deliverAuthInfo({ authUrl, callbackUrl: callbackServer.callbackUrl, state });
	} catch (error) {
		callbackServer.close();
		throw error;
	}

	const outcome = await callbackServer.wait();
	if (outcome.type === "cancelled" || exchanged === undefined) {
		throw new DOMException(`WorkBuddy login cancelled: ${outcome.type === "cancelled" ? outcome.reason : "no token exchanged"}`, "AbortError");
	}
	const nickname = await fetchNickname(realm, state, exchanged.accessToken);
	return toWorkbuddyCredentials(realm, exchanged, nickname);
}

/**
 * login 钩子实装（pi /login 调起）。onAuth 的 url = 上游授权页；instructions 携带
 * 回调端点约定（JSON：{ callbackUrl, state }）——taiji 浮层侧接口契约，加载授权页、
 * 完成后向 callbackUrl 发 done/cancel 信号。
 */
export async function workbuddyLogin(callbacks: OAuthLoginCallbacks, realm: WorkbuddyRealm = "cn"): Promise<OAuthCredentials> {
	return runWorkbuddyAuthorization({
		realm,
		signal: callbacks.signal,
		deliverAuthInfo: (info) => {
			callbacks.onAuth({
				url: info.authUrl,
				instructions: JSON.stringify({ callbackUrl: info.callbackUrl, state: info.state }),
			});
		},
	});
}

/** authorize 管理动作的宿主通知消息（单行 JSON——taiji 浮层按 type 识别并加载 authUrl，
 * 完成后向 callbackUrl 发 done/cancel 信号；经扩展 UI 通知通道（ctx.ui.notify 形态，
 * P6 验证）投递）。 */
export function buildWoolAuthorizeNotice(info: { authUrl: string; callbackUrl: string; state: string }): string {
	return JSON.stringify({ type: "wool-authorize", family: "workbuddy", ...info });
}

/** authorize 管理动作成功响应 data 组装（wool-shared WoolCredentialAcquireData 契约）：
 * apiKey = access token（宿主写 models.json 羊毛条目）；refreshToken 轮换令牌随行；
 * 昵称/expires 为展示与到期提示增值。 */
export function toWoolAcquireData(credentials: WorkbuddyCredentials): WoolCredentialAcquireData {
	return {
		credentials: {
			apiKey: credentials.access,
			...(credentials.refresh.length > 0 ? { refreshToken: credentials.refresh } : {}),
		},
		...(credentials.nickname !== undefined && credentials.nickname.length > 0
			? { account: { displayName: credentials.nickname } }
			: {}),
		expiresAt: credentials.expires,
	};
}

/** refreshToken 钩子实装（上游 refreshToken 轮换；expires 从新 JWT exp 解）。 */
export async function workbuddyRefresh(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials> {
	const current = asWorkbuddyCredentials(credentials);
	const realm: WorkbuddyRealm = isWorkbuddyRealm(current.realm) ? current.realm : "cn";
	const config = realmConfig(realm);
	const payload = await fetchJson(`${config.chatUpstream}${REFRESH_PATH}`, {
		method: "POST",
		headers: buildRefreshHeaders(realm, { accessToken: current.access, uid: current.uid, domain: current.domain }, current.refresh),
		body: "{}",
		signal,
	});
	// hub 实测：data 可能再包一层 data（{data:{data:{accessToken}}}）。
	const data = (isRecord(payload.data?.data) ? payload.data.data : undefined) ?? payload.data ?? {};
	const accessToken = typeof data.accessToken === "string" ? data.accessToken : "";
	if (accessToken.length === 0) {
		throw new Error(`WorkBuddy token refresh returned no token (code ${String(payload.code)} ${payload.msg ?? ""})`);
	}
	const refreshToken = typeof data.refreshToken === "string" && data.refreshToken.length > 0 ? data.refreshToken : current.refresh;
	const claims = decodeJwtClaims(accessToken);
	const expiresAt = typeof claims?.exp === "number" ? claims.exp * MS_PER_SECOND : Date.now() + DEFAULT_TOKEN_TTL_MS;
	return {
		...current,
		access: accessToken,
		refresh: refreshToken,
		expires: expiresAt,
	};
}

/** getApiKey 钩子实装：access token 即鉴权串（streamSimple 侧再进 Bearer 头）。 */
export function workbuddyApiKey(credentials: OAuthCredentials): string {
	return credentials.access;
}
