// auth.ts — pi oauth 钩子族（D3：ide-extract 家族把提取包装为 login 等效流程）。
//
// login = 一次本机提取（钥匙串 → auth.v1.dat → dt-/drt-）；提取失败（IDE 升级改加密
// 等）走同屏「改用官方 PAT」次级入口（pi login 交互通道 onPrompt，最小实装：PAT 作
// Bearer 直调 openapi——探针实证 dt- 令牌直调可行，PAT 同域）。refreshToken = drt- 换
// 新 dt-（POST /api/v1/deviceToken/refresh，hub 实测口径）；getApiKey 返回 access
// token（同时是进程内 credential 学习通道，见 credentials.ts）。

import type { OAuthCredentials } from "@earendil-works/pi-ai";

import { fetchUserinfo, refreshDeviceToken } from "./openapi.ts";
import { extractCredentials, type KeychainReader } from "./keychain-extract.ts";
import { toOAuthCredential, type QoderAuthStore, type QoderCredentialState } from "./credentials.ts";

/** PAT 形态有效期 = 10 年（10 × 365d = 315_360_000_000 ms）：官方个人访问令牌为
 * 长效凭据（hub 侧兜底 24h 是 jobToken 交换产物的有效期，PAT 本体不设短效）；
 * pi 只在过期时才调 refreshToken，PAT 无刷新链，长有效期避免无意义的刷新失败。 */
const PAT_VALIDITY_MS = 315_360_000_000;

/** login 交互回调面（pi OAuthLoginCallbacks 的结构子集；测试注入 mock）。 */
export type LoginInteraction = {
	onPrompt(prompt: { message: string; placeholder?: string; allowEmpty?: boolean }): Promise<string>;
	onProgress?(message: string): void;
};

/** 从本机提取链构造凭据状态（login 第 1 步；D3 提取即登录）。 */
export function extractToCredentialState(deps?: { keychainRead?: KeychainReader; authFilePath?: string }): QoderCredentialState {
	const payload = extractCredentials(deps);
	return {
		accessToken: payload.token,
		refreshToken: payload.refreshToken,
		expiresAt: payload.expiresAt,
		uid: payload.user.id,
		nickname: payload.user.name,
		userType: "personal_professional_trial",
		organizationId: "",
		organizationName: "",
		source: "ide-extract",
	};
}

/** PAT 次级入口（login 第 2 步）：PAT 作 Bearer 调 userinfo 拿 uid（同域直调，
 * 无效 PAT 在此显式失败，不入库半残凭据）。 */
export async function patToCredentialState(pat: string): Promise<QoderCredentialState> {
	const trimmed = pat.trim();
	if (trimmed.length === 0) {
		throw new Error("qoder login: PAT entry cancelled");
	}
	const userinfo = await fetchUserinfo(trimmed, "");
	return {
		accessToken: trimmed,
		refreshToken: "",
		expiresAt: Date.now() + PAT_VALIDITY_MS,
		uid: userinfo.id,
		nickname: userinfo.name,
		userType: userinfo.userType ?? "personal_professional_trial",
		organizationId: userinfo.organizationId ?? "",
		organizationName: userinfo.organizationName ?? "",
		source: "pat",
	};
}

/** oauth.login 实装：先提取，失败则转 PAT 输入（同屏次级入口）。 */
export async function login(interaction: LoginInteraction, deps?: { keychainRead?: KeychainReader; authFilePath?: string }): Promise<OAuthCredentials> {
	try {
		const state = extractToCredentialState(deps);
		interaction.onProgress?.("Qoder 凭据提取成功");
		return toOAuthCredential(state) as OAuthCredentials;
	} catch (extractError) {
		const reason = extractError instanceof Error ? extractError.message : String(extractError);
		interaction.onProgress?.(`自动提取失败：${reason}`);
		const pat = await interaction.onPrompt({
			message: `自动提取失败（${reason}）。可粘贴 Qoder 官方个人访问令牌（PAT，pt- 前缀，官方设置页生成）继续；留空取消`,
			placeholder: "pt-...",
			allowEmpty: true,
		});
		const state = await patToCredentialState(pat);
		interaction.onProgress?.("PAT 验证通过");
		return toOAuthCredential(state) as OAuthCredentials;
	}
}

/** oauth.refreshToken 实装：drt- 换新 dt-；PAT 形态无刷新链，原样续期。 */
export async function refreshToken(credentials: OAuthCredentials, signal?: AbortSignal): Promise<OAuthCredentials> {
	if (typeof credentials.refresh !== "string" || credentials.refresh.length === 0) {
		// PAT 形态（无 drt-）：原样返回并顺延 expires（PAT 长效，无网络动作）。
		return { ...credentials, expires: Date.now() + PAT_VALIDITY_MS };
	}
	const next = await refreshDeviceToken(credentials.refresh, signal);
	return {
		...credentials,
		access: next.token,
		refresh: next.refreshToken,
		expires: next.expiresAt,
	};
}

/** oauth.getApiKey 实装：返回 access token 并学习 credential（进程内状态恢复通道）。 */
export function makeGetApiKey(store: QoderAuthStore): (credentials: OAuthCredentials) => string {
	return (credentials: OAuthCredentials): string => {
		store.learn(credentials);
		return credentials.access;
	};
}
