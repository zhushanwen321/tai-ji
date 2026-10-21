// account.ts — 管理动作「status」的账号状态聚合（WoolAccountStatus 协议形态）。
//
// 凭据通道 = streamSimple 同源：modelRegistry.getApiKeyAndHeaders 解析出 access token，
// uid / realm / domain / 过期时刻从 JWT 解码（凭据扩展字段不经过该通道，管理会话
// 与对话会话同一解析路径，无双轨）。D3：登录态检测不适用——家族卡片一律显示
// 「需授权」，status 的 loggedIn 只反映凭据在位事实。

import type { WoolAccountStatus } from "@zhushanwen/pi-wool-shared";
import { woolLoggedOutStatus } from "@zhushanwen/pi-wool-shared";

import { fetchCheckinStatus, fetchQuota } from "./checkin.ts";
import type { WorkbuddyRealm } from "./constants.ts";
import { realmConfig } from "./headers.ts";
import { decodeJwtClaims, expiresFromToken } from "./jwt.ts";
import type { WorkbuddyAuthContext } from "./headers.ts";

export const WORKBUDDY_FAMILY_ID = "workbuddy";

/** access token → 管理侧鉴权上下文（uid/realm/domain 全部 JWT 解码）。 */
export function authContextFromToken(accessToken: string): WorkbuddyAuthContext & { realm: WorkbuddyRealm } {
	const claims = decodeJwtClaims(accessToken);
	const uid = typeof claims?.sub === "string" ? claims.sub : "";
	const domain = typeof claims?.domain === "string" ? claims.domain : undefined;
	const realm: WorkbuddyRealm = domain === realmConfig("intl").domain ? "intl" : "cn";
	return { accessToken, uid, domain, realm };
}

/**
 * 聚合账号状态（checkin/quota 增值字段拉取失败不阻断——按缺省呈现，
 * fetchedAt 即采集时点）。
 */
export async function workbuddyAccountStatus(
	loggedIn: boolean,
	accessToken: string | undefined,
	nickname: string | undefined,
): Promise<WoolAccountStatus> {
	if (!loggedIn || accessToken === undefined || accessToken.length === 0) {
		return woolLoggedOutStatus(WORKBUDDY_FAMILY_ID, Date.now());
	}
	const auth = authContextFromToken(accessToken);
	// 独立增值字段源：部分失败按缺省呈现（allSettled 允许部分降级）。
	const [checkinSettled, quotaSettled] = await Promise.allSettled([
		fetchCheckinStatus(auth.realm, auth),
		fetchQuota(auth.realm, auth),
	]);
	const checkin = checkinSettled.status === "fulfilled" ? checkinSettled.value : undefined;
	const quota = quotaSettled.status === "fulfilled" ? quotaSettled.value : undefined;
	const expires = expiresFromToken(accessToken);
	return {
		family: WORKBUDDY_FAMILY_ID,
		loggedIn: true,
		...(nickname !== undefined && nickname.length > 0 ? { nickname } : {}),
		...(quota !== undefined
			? { quota: { used: quota.used, remaining: quota.remaining, unit: quota.unit } }
			: {}),
		...(checkin !== undefined
			? {
					checkin: {
						doneToday: checkin.doneToday,
						...(checkin.streak !== undefined ? { streak: checkin.streak } : {}),
					},
				}
			: {}),
		...(expires !== undefined ? { tokenExpiresAt: expires } : {}),
		fetchedAt: Date.now(),
	};
}
