// headers.ts — 出站请求头族构造（纯函数；fixture 对照测试的断言对象）。
//
// 两套头族（hub wb_identity.build_identity_headers / wb_accounts.Account.headers 实读）：
// - chat 头族（桌面端身份）：缺会话头族上游 400 code 11-128；桌面端身份不带 gzip。
// - billing 头族（签到/额度/OAuth state/刷新共用）：按账号派生 machineId/sessionId。
// 全部头名原样发出（官方 wire 形态）。

import {
	type WorkbuddyRealm,
	type WorkbuddyRealmConfig,
	WORKBUDDY_REALMS,
} from "./constants.ts";
import {
	conversationIdFor,
	machineIdFor,
	newRequestId,
	sessionIdFor,
	traceHeaders,
} from "./fingerprint.ts";

export function realmConfig(realm: WorkbuddyRealm): WorkbuddyRealmConfig {
	return WORKBUDDY_REALMS[realm];
}

/** 头族构造的公共输入。 */
export type WorkbuddyAuthContext = {
	accessToken: string;
	uid: string;
	/** 登录时记下的 domain（优先于 realm 兜底值）。 */
	domain?: string;
};

/**
 * 对话请求头族（桌面端身份，hub wb_identity.build_identity_headers product=workbuddy 分支）。
 * 一轮请求 = 一次 user send：conversationRequestId 在请求开始生成一次并复用于
 * X-Conversation-Request-ID 与 X-Root-Request-ID；messageId 每请求新生成。
 */
export function buildChatHeaders(
	realm: WorkbuddyRealm,
	auth: WorkbuddyAuthContext,
	options: { conversationKey: string; model: string },
): Record<string, string> {
	const config = realmConfig(realm);
	const conversationId = conversationIdFor(auth.uid, options.conversationKey);
	const conversationRequestId = newRequestId();
	const messageId = newRequestId();
	return {
		"Content-Type": "application/json",
		Accept: "application/json, text/plain, */*",
		"X-Requested-With": "XMLHttpRequest",
		"User-Agent": config.chatUa,
		Origin: config.origin,
		Referer: `${config.origin}/`,
		"X-CodeBuddy-Request": "1",
		"Accept-Language": config.acceptLanguage,
		"X-Agent-Intent": "craft",
		"X-Agent-Purpose": "conversation",
		"X-Agent-Type": "main",
		"X-IDE-Name": "WorkBuddy",
		"X-IDE-Type": "WorkBuddy",
		"X-IDE-Version": config.desktopVersion,
		"X-Private-Data": "true",
		"X-Product": "SaaS",
		"X-Domain": auth.domain || config.domain,
		"X-User-Id": auth.uid,
		Authorization: `Bearer ${auth.accessToken}`,
		"X-Conversation-ID": conversationId,
		"X-Conversation-Request-ID": conversationRequestId,
		"X-Root-Request-ID": conversationRequestId,
		"X-Conversation-Message-ID": messageId,
		"X-Request-ID": messageId,
		...traceHeaders(),
	};
}

/**
 * billing 头族（签到/额度/签到状态共用；hub Account.headers purpose != "chat" 分支）。
 * X-Machine-ID / X-Session-ID 按账号派生（每账号一台设备的隔离口径）。
 */
export function buildBillingHeaders(
	realm: WorkbuddyRealm,
	auth: WorkbuddyAuthContext,
): Record<string, string> {
	const config = realmConfig(realm);
	return {
		"Content-Type": "application/json",
		Accept: "application/json, text/plain, */*",
		"X-Requested-With": "XMLHttpRequest",
		"User-Agent": config.billingUa,
		Origin: config.origin,
		Referer: `${config.origin}/`,
		Authorization: `Bearer ${auth.accessToken}`,
		"X-User-Id": auth.uid,
		"X-Domain": auth.domain || config.domain,
		"X-CodeBuddy-Request": "1",
		"Accept-Language": config.acceptLanguage,
		"X-Request-ID": newRequestId(),
		"X-Machine-ID": machineIdFor(auth.uid),
		"X-Session-ID": sessionIdFor(auth.uid),
		"X-No-Enterprise-Id": "1",
		...(realm === "cn" ? { "X-Product": "SaaS" } : {}),
	};
}

/** OAuth state 端点头族（未登录：billing 基础头族去掉鉴权与设备字段；hub start_login 实测）。 */
export function buildOAuthStateHeaders(realm: WorkbuddyRealm): Record<string, string> {
	const config = realmConfig(realm);
	return {
		"Content-Type": "application/json",
		Accept: "application/json, text/plain, */*",
		"X-Requested-With": "XMLHttpRequest",
		"User-Agent": config.billingUa,
		Origin: config.origin,
		Referer: `${config.origin}/`,
	};
}

/** 令牌刷新头族（hub Account._refresh_locked：X-Refresh-Token 族 + 基础 billing 头）。 */
export function buildRefreshHeaders(
	realm: WorkbuddyRealm,
	auth: WorkbuddyAuthContext,
	refreshToken: string,
): Record<string, string> {
	const config = realmConfig(realm);
	return {
		"Content-Type": "application/json",
		Accept: "application/json, text/plain, */*",
		"X-Requested-With": "XMLHttpRequest",
		"User-Agent": config.billingUa,
		Origin: config.origin,
		Referer: `${config.origin}/`,
		"X-Refresh-Token": refreshToken,
		"X-Auth-Refresh-Source": config.refreshSource,
		"X-User-Id": auth.uid,
		"X-Domain": auth.domain || config.domain,
		"X-CodeBuddy-Request": "1",
		"Accept-Language": config.acceptLanguage,
	};
}
