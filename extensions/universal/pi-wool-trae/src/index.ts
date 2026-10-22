// src/index.ts — @zhushanwen/pi-wool-trae：Trae 家族羊毛 provider 扩展。
//
// 组装形态（wool-shared scaffold 承担 pi 契约接线）：
// - streamSimple = driveTraeStream（SOLO 通道协议翻译，D1）；
// - refreshModels = fetchTraeCatalog（D4：缓存/persist 由 scaffold 承担，
//   本包只供带网拉取 + 包内快照路径）；
// - oauth 三钩子（D3）：login = storage.json 容器解密提取（用户向导显式触发时
//   由 pi 调用一次）；refreshToken = ExchangeToken 刷新；getApiKey = 复合凭据串。
//
// 凭据通道说明（D2 双通道）：主通道 = models.json 羊毛 provider 条目 apiKey（taiji
// 向导 extract 回传、宿主写入，pi 请求管线在请求时经 options.apiKey 传入）——形态为
// 裸 JWT，设备三要素（userId/machineId/soloDeviceId）请求时从本机 storage.json 现读
//（resolveTraeAuth）。次通道 = pi oauth 钩子（独立 pi 用户 TUI /login 形态）：
// getApiKey 只返回 string（pi-ai OAuthCredentials 契约），三要素与 JWT 一起编码进
// apiKey 复合串（JSON），family stream 请求时解析组装。复合串只存 pi auth.json
//（作为 opaque key），解开只发生在请求时刻。

import {
	defineWoolExtension,
	WOOL_CREDENTIALS_MISSING_MESSAGE,
	type WoolCredentialAcquireData,
	type WoolResolvedAuth,
	type WoolStreamRequest,
} from "@zhushanwen/pi-wool-shared";
import type { Credential, OAuthCredentials } from "@earendil-works/pi-ai";
import { join } from "node:path";

import {
	extractTraeLogin,
	detectTraeLoginState,
	TRAE_EXTRACT_RECOVERY_HINT,
	TraeContainerError,
	type TraeStoredLogin,
} from "./byte-crypto.ts";
import { fetchTraeCatalog, type TraeModel } from "./catalog.ts";
import { REFRESH_ENDPOINT, TRAE_GATEWAY_CN, buildCommonHeaders, type TraeAuthInputs } from "./protocol.ts";
import { TRAE_CODE_RELOGIN, driveTraeStream } from "./stream.ts";

/** 家族 id（wool 词表 trae）。 */
export const FAMILY_ID = "trae" as const;

/** pi provider 注册 api id（streamSimple 仅对 model.api === 此值的模型分发）。 */
const TRAE_API_ID = "wool-trae";

/** OAuth 凭据附加键（pi OAuthCredentials 允许任意附加键）。 */
type TraeCredentialExtras = {
	/** 复合 apiKey（JWT + 设备三要素 JSON 编码）。 */
	traeBundle?: string;
};

/** ExchangeToken 刷新请求超时（ms）。 */
const REFRESH_TIMEOUT_MS = 30_000;

/** 刷新响应缺 expired_at 时的回退有效期（实测 token 寿命约 5 天 = 432_000_000 ms）。 */
const TOKEN_LIFETIME_FALLBACK_MS = 432_000_000;

/** 错误响应体截断长度（错误消息可读性，防超长 body 刷屏）。 */
const ERROR_BODY_SNIPPET = 200;

/** 组装 apiKey 复合串（login/refresh 后入库；请求时刻解析）。 */
function encodeKeyBundle(auth: TraeAuthInputs): string {
	return JSON.stringify(auth);
}

/** 运行时守卫：复合串解析（读侧不信任存储内容）。非复合串形态（如裸 JWT）返回
 * undefined——裸令牌形态由 resolveTraeAuth 走 storage.json 设备要素通道。 */
function parseKeyBundle(raw: string | undefined): TraeAuthInputs | undefined {
	let parsed: unknown;
	try {
		parsed = raw !== undefined && raw.length > 0 ? JSON.parse(raw) : undefined;
	} catch {
		parsed = undefined;
	}
	if (typeof parsed !== "object" || parsed === null) {
		return undefined;
	}
	const record = parsed as Record<string, unknown>;
	if (
		typeof record.token !== "string" ||
		record.token.length === 0 ||
		typeof record.userId !== "string" ||
		typeof record.machineId !== "string" ||
		typeof record.soloDeviceId !== "string"
	) {
		return undefined;
	}
	return {
		token: record.token,
		userId: record.userId,
		machineId: record.machineId,
		soloDeviceId: record.soloDeviceId,
	};
}

/** 复合串缺失/形态不符 → 可操作错误（oauth 钩子凭据通道：auth.json 里的 traeBundle）。 */
function decodeKeyBundle(raw: string | undefined): TraeAuthInputs {
	const parsed = parseKeyBundle(raw);
	if (parsed === undefined) {
		throw new Error(
			"Trae credential bundle is missing or malformed — re-run the extraction (provider entry → 重新提取)",
		);
	}
	return parsed;
}

/**
 * 请求时凭据解析（D2 双通道）：
 * ① 复合串（oauth 钩子通道：getApiKey 返回 traeBundle，JWT + 设备三要素齐备）；
 * ② 裸 JWT（models.json 羊毛条目 apiKey 通道：宿主经向导 extract 写入，只有令牌本体）
 *    ——userId/machineId/soloDeviceId 从本机 storage.json 现读（同机假设：设备要素与
 *    账号 id 对同一安装稳定；IDE 换号/卸载后读取失败或上游拒绝，恢复 = 重跑向导提取）。
 * 每请求一次文件读 + AES 解密（微秒级，无缓存无状态）。
 */
export function resolveTraeAuth(apiKey: string | undefined, deps?: { storagePath?: string }): TraeAuthInputs {
	const bundle = parseKeyBundle(apiKey);
	if (bundle !== undefined) {
		return bundle;
	}
	if (apiKey === undefined || apiKey.length === 0) {
		throw new Error(
			`Trae credentials unavailable: ${WOOL_CREDENTIALS_MISSING_MESSAGE}`,
		);
	}
	try {
		const { login, device } = extractTraeLogin(deps?.storagePath ?? undefined);
		return {
			token: apiKey,
			userId: login.userId,
			machineId: device.machineId,
			soloDeviceId: device.soloDeviceId,
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Trae request token has no device facts available (${reason}). Re-run the taiji wizard extraction or pi /login. ${TRAE_EXTRACT_RECOVERY_HINT}`,
		);
	}
}

/** 从凭据读复合串附加键（Credential union 与 OAuthCredentials 都允许附加键）。 */
function readTraeBundle(credential: Credential | OAuthCredentials | undefined): string | undefined {
	if (credential === undefined) {
		return undefined;
	}
	const bundle = (credential as Readonly<TraeCredentialExtras>).traeBundle;
	return typeof bundle === "string" && bundle.length > 0 ? bundle : undefined;
}

/** 从已刷新凭据取请求要素（refreshModels 带网阶段；scaffold 经 ctx.credential 传入）。 */
function authFromCredential(credential: Credential | OAuthCredentials | undefined): TraeAuthInputs {
	return decodeKeyBundle(readTraeBundle(credential));
}

/** family stream 的凭据入口：resolvedAuth.apiKey = 复合串（oauth 钩子）或裸 JWT（models.json 条目）。 */
function authFromResolved(resolved: Extract<WoolResolvedAuth, { ok: true }>): TraeAuthInputs {
	return resolveTraeAuth(resolved.apiKey);
}

/** expiredAt（ISO）→ epoch ms；不可解析时回退 0（= 立即触发 pi 的刷新链）。 */
function expiresEpochMs(iso: string): number {
	const parsed = Date.parse(iso);
	return Number.isNaN(parsed) ? 0 : parsed;
}

/** 提取链包装为 oauth.login 等效流程（D3：pi 拿到返回值即入 auth.json）。 */
async function loginByExtraction(): Promise<OAuthCredentials> {
	const { login, device } = extractTraeLogin();
	const auth: TraeAuthInputs = {
		token: login.token,
		userId: login.userId,
		machineId: device.machineId,
		soloDeviceId: device.soloDeviceId,
	};
	return {
		refresh: login.refreshToken,
		access: login.token,
		expires: expiresEpochMs(login.expiredAt),
		traeBundle: encodeKeyBundle(auth),
	};
}

/**
 * extract 管理动作的响应组装（wool-shared WoolCredentialAcquireData 契约）：
 * apiKey = 容器解密所得 JWT（裸令牌——设备要素不进契约，请求时从本机 storage.json
 * 现读）；容器无展示名字段，account 缺席；expiredAt（ISO）转 Unix ms，不可解析缺省。
 */
export function traeExtractToAcquireData(login: TraeStoredLogin): WoolCredentialAcquireData {
	const expiresAt = expiresEpochMs(login.expiredAt);
	return {
		credentials: {
			apiKey: login.token,
			...(login.refreshToken.length > 0 ? { refreshToken: login.refreshToken } : {}),
		},
		...(expiresAt > 0 ? { expiresAt } : {}),
	};
}

/** ExchangeToken 刷新（探针实测机制：payload 自带 refreshToken + 半年刷新窗口）。 */
async function refreshViaExchangeToken(credentials: OAuthCredentials, signal?: AbortSignal): Promise<OAuthCredentials> {
	const current = authFromCredential(credentials);
	const response = await globalThis.fetch(`${TRAE_GATEWAY_CN}${REFRESH_ENDPOINT}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			ClientID: "ono9krqynydwx5",
			RefreshToken: credentials.refresh,
			ClientSecret: "-",
			UserID: current.userId,
		}),
		signal: signal ?? AbortSignal.timeout(REFRESH_TIMEOUT_MS),
	});
	const bodyText = await response.text().catch(() => "");
	if (!response.ok) {
		throw new Error(`ExchangeToken failed: ${response.status} ${bodyText.slice(0, ERROR_BODY_SNIPPET)}. ${TRAE_EXTRACT_RECOVERY_HINT}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(bodyText);
	} catch {
		throw new Error(`ExchangeToken returned non-JSON body. ${TRAE_EXTRACT_RECOVERY_HINT}`);
	}
	const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
	const data = typeof record.data === "object" && record.data !== null ? (record.data as Record<string, unknown>) : record;
	const token = typeof data.token === "string" ? data.token : typeof data.access_token === "string" ? data.access_token : undefined;
	const refreshToken =
		typeof data.refresh_token === "string" ? data.refresh_token : typeof data.refreshToken === "string" ? data.refreshToken : credentials.refresh;
	if (token === undefined) {
		throw new Error(`ExchangeToken response missing token. ${TRAE_EXTRACT_RECOVERY_HINT}`);
	}
	return {
		...credentials,
		access: token,
		refresh: refreshToken,
		expires: typeof data.expired_at === "number" ? data.expired_at : Date.now() + TOKEN_LIFETIME_FALLBACK_MS,
		traeBundle: encodeKeyBundle({ ...current, token }),
	};
}

/** family streamSimple：SOLO 协议翻译（D1）。 */
async function stream(request: WoolStreamRequest) {
	if (!request.resolvedAuth.ok) {
		throw new Error(`Trae credentials unavailable: ${request.resolvedAuth.error}`);
	}
	return driveTraeStream({
		auth: authFromResolved(request.resolvedAuth),
		systemPrompt: request.systemPrompt,
		tools: request.tools,
		messages: request.messages,
		driver: request.driver,
	});
}

/** 带网拉模型目录（D4 三层之带网层；缓存/persist/快照兜底由 scaffold 与包内快照承担）。 */
async function fetchModels(ctx: { credential?: Credential }): Promise<TraeModel[]> {
	return fetchTraeCatalog(authFromCredential(ctx.credential));
}

/**
 * 扩展入口（extension-conventions：default export 即 ExtensionFactory）。
 * 提取失败的用户可见路径：oauth.login 抛错（pi 呈现）与管理命令回写（恢复指引内嵌）。
 */
export default defineWoolExtension({
	familyId: "trae",
	displayName: "Trae (Wool)",
	api: TRAE_API_ID,
	baseUrl: TRAE_GATEWAY_CN,
	stream,
	fetchModels,
	snapshotPath: join(import.meta.dirname, "..", "snapshots", "trae.json"),
	oauth: {
		name: "Trae (local extraction)",
		login: () => loginByExtraction(),
		refreshToken: (credentials, signal) => refreshViaExchangeToken(credentials, signal),
		getApiKey: (credentials) => {
			const extras = credentials as Readonly<TraeCredentialExtras>;
			return extras.traeBundle ?? credentials.access;
		},
	},
	manageHandlers: {
		// 登录态检测语义 = storage.json 存在性 stat，不读内容（D3）。
		status: async () => ({
			providerId: "wool-trae",
			loginDetected: detectTraeLoginState(),
			tokenExpiresHint: "token lifetime ~5 days; pi refreshes via ExchangeToken before expiry",
		}),
		// 回包字段 = 宿主守卫 isWoolDetectData 契约的 detected（wool-manage 协议 data 形状）。
		detect: async () => ({ detected: detectTraeLoginState() }),
		// 凭据提取（D2 改道主通道）：storage.json 容器解密一次执行 → JWT 作 apiKey 按
		// WoolCredentialAcquireData 契约回传（宿主写 models.json apiKey 条目）。提取失败
		// throw → envelope internal（消息内嵌 IDE 重登恢复指引）。
		extract: async () => traeExtractToAcquireData(extractTraeLogin().login),
		// 签到不属于 Trae 首版范围（设计 D5 自动签到是 WorkBuddy 域；Trae 无独立签到端点实装）。
		checkin: async () => ({ supported: false }),
		// 扩展无自治存储：凭据权威在 pi auth.json；pi 扩展 API 无凭据删除通道（宿主同样
		// 无 Models.logout 通路）——本包无可清的进程内副本，auth.json 凭据由宿主卸载编排
		// 按 D3 降级条款呈现残留提示（指引 pi 侧 /logout）。模型目录持久化在 pi
		// models-store.json——persist 目录由 scaffold clear 编排统一经
		// publish({persist:null}) 删除（D3 卸载编排②）。
		clear: async () => ({ cleared: false, note: "credentials remain in pi auth.json — remove via pi /logout (host has no credential deletion channel)" }),
	},
});

// 供宿主/测试消费的内部工具导出（包内自用 + 对照测试）。
export { buildCommonHeaders, extractTraeLogin, detectTraeLoginState, TraeContainerError, TRAE_CODE_RELOGIN };
export type { TraeModel };