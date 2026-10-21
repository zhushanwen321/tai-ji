// credentials.ts — 扩展进程内的凭据状态与 COSY 会话缓存。
//
// pi oauth 凭据模型（auth.json）每 provider 存一个 OAuthCredential；扩展进程通过
// getApiKey(credentials) 钩子在每个请求鉴权时拿到 credential 全量（含 login 时塞入的
// 扩展字段 uid/nickname/...）——本模块以「学习」方式维护进程内副本，并按 access
// token 缓存 COSY 会话（access 轮换即整体重建，旧 info 内嵌旧 token 不再被服务端
// 接受，参考实现 SESSIONS 缓存同语义）。

import { CosySession, DEFAULT_USER_TYPE, type CosyIdentity } from "./cosy.ts";

/** 进程内凭据副本形态（credential 扩展字段 ↔ 强类型视图）。 */
export type QoderCredentialState = {
	accessToken: string;
	refreshToken: string;
	/** Unix ms；0 = 未知（不参与过期判定，pi 侧以 credentials.expires 为准）。 */
	expiresAt: number;
	uid: string;
	nickname: string;
	userType: string;
	organizationId: string;
	organizationName: string;
	/** PAT 形态标记（pt- 前缀直调 openapi；无 drt- 刷新链）。 */
	source: "ide-extract" | "pat";
};

/** pi OAuthCredentials 的运行时收窄（读侧不信任外部格式）：access 必须非空字符串。 */
export function readCredentialState(value: unknown): QoderCredentialState | undefined {
	if (typeof value !== "object" || value === null) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	if (typeof record.access !== "string" || record.access.length === 0) {
		return undefined;
	}
	const str = (key: string): string => (typeof record[key] === "string" ? (record[key] as string) : "");
	const source = record.source === "pat" ? "pat" : "ide-extract";
	return {
		accessToken: record.access,
		refreshToken: str("refresh"),
		expiresAt: typeof record.expires === "number" ? record.expires : 0,
		uid: str("uid"),
		nickname: str("nickname"),
		userType: str("userType") || DEFAULT_USER_TYPE,
		organizationId: str("organizationId"),
		organizationName: str("organizationName"),
		source,
	};
}

/** 构造 pi auth.json 入库的 credential（login/refreshToken 钩子的返回值）。
 * uid/nickname 等身份字段随 credential 持久化——重启后的进程经 getApiKey 学习恢复。 */
export function toOAuthCredential(state: QoderCredentialState): {
	type: "oauth";
	access: string;
	refresh: string;
	expires: number;
	uid: string;
	nickname: string;
	userType: string;
	organizationId: string;
	organizationName: string;
	source: QoderCredentialState["source"];
} {
	return {
		type: "oauth",
		access: state.accessToken,
		refresh: state.refreshToken,
		expires: state.expiresAt,
		uid: state.uid,
		nickname: state.nickname,
		userType: state.userType,
		organizationId: state.organizationId,
		organizationName: state.organizationName,
		source: state.source,
	};
}

/** COSY 身份体构造（hub CosySession identity 9 键）。 */
export function toCosyIdentity(state: QoderCredentialState): CosyIdentity {
	return {
		name: state.nickname,
		aid: state.uid,
		uid: state.uid,
		yx_uid: "",
		organization_id: state.organizationId,
		organization_name: state.organizationName,
		user_type: state.userType,
		security_oauth_token: state.accessToken,
		refresh_token: state.refreshToken,
	};
}

/** 凭据状态 + COSY 会话缓存（factory 闭包持有，进程级生命周期与 ModelRegistry 一致）。 */
export class QoderAuthStore {
	private credential: QoderCredentialState | undefined;
	// 字段名避开同名方法（class field 初始化会覆盖原型方法——同名 = session() 丢失）。
	private cachedSession: { accessToken: string; cosy: CosySession } | undefined;

	/** getApiKey 钩子通道：每个请求鉴权时学习 credential 全量（含重启后恢复）。 */
	learn(value: unknown): QoderCredentialState | undefined {
		const next = readCredentialState(value);
		if (next !== undefined) {
			this.credential = next;
		}
		return next;
	}

	current(): QoderCredentialState | undefined {
		return this.credential;
	}

	/** access token 对应的 COSY 会话（缓存命中直接返回；token 轮换即重建）。
	 * 无凭据/uid 缺失返回 undefined（调用方转为明确错误，不静默发请求）。 */
	session(): CosySession | undefined {
		const state = this.credential;
		if (state === undefined || state.uid.trim().length === 0) {
			return undefined;
		}
		if (this.cachedSession === undefined || this.cachedSession.accessToken !== state.accessToken) {
			this.cachedSession = { accessToken: state.accessToken, cosy: CosySession.create(toCosyIdentity(state)) };
		}
		return this.cachedSession.cosy;
	}

	/** 清除凭据与缓存（管理动作 clear：本类只管进程内副本；pi auth.json 条目 pi 扩展
	 * API 无删除通道——宿主卸载编排按 D3 降级条款呈现残留提示，各管自己的权威存储）。 */
	clear(): void {
		this.credential = undefined;
		this.cachedSession = undefined;
	}
}
