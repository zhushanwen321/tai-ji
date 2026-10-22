// src/index.ts — @zhushanwen/pi-wool-qoder：Qoder 家族羊毛 provider 扩展。
//
// 组装形态（wool-shared scaffold 承担 pi 契约接线）：
// - streamSimple = createQoderDrive（COSY 签名 + qoderEncode 载荷加密的协议翻译，D1）；
// - refreshModels = fetchModelCatalog（D4：缓存/persist/快照兜底由 scaffold 承担，
//   本包只供带网拉取）；快照 = 包内 snapshots/qoder.json（上游从未可达时的首装兜底）；
// - oauth 三钩子（D3）：login = 钥匙串提取链（提取即登录），失败转官方 PAT 次级
//   入口（onPrompt 交互通道）；refreshToken = drt- 换新 dt-；getApiKey = access
//   token 返回 + 进程内 credential 学习。
//
// 凭据通道（D2 双通道）：主通道 = 请求时 options.apiKey（taiji 向导 extract 回传、
// 宿主写 models.json 羊毛 provider 条目，pi 请求管线解析传入——scaffold 优先采信），
// 经 adoptRequestApiKey 采纳进 authStore（新 token userinfo 一次补全 uid/昵称）；
// 次通道 = oauth 钩子（独立 pi 用户 TUI /login 形态，getApiKey 每请求学习 credential
// 全量，含重启后恢复）。管理专用会话（无 LLM 请求，getApiKey 不被调）经
// ModelRegistry.getApiKeyForProvider 补习——同样走 pi 凭据解析链（过期先自动刷新）。

import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { join } from "node:path";

import {
	defineWoolExtension,
	type WoolStreamImplementation,
	woolLoggedOutStatus,
} from "@zhushanwen/pi-wool-shared";

import { adoptRequestApiKey, extractToAcquireData, login, makeGetApiKey, refreshToken } from "./auth.ts";
import { QoderAuthStore } from "./credentials.ts";
import { createQoderDrive } from "./chat-stream.ts";
import { fetchModelCatalog, lookupModelMeta, QODER_API_ID } from "./models-fetch.ts";
import { fetchQuotaUsage, fetchUserinfo } from "./openapi.ts";
import { detectCredentialFile } from "./keychain-extract.ts";
import { GATEWAY_BASE_URL } from "./constants.ts";

/** 家族 id（wool 词表 qoder）。 */
export const FAMILY_ID = "qoder" as const;

/** provider 注册名（woolProviderId("qoder")，与 models-fetch 的 PROVIDER_ID 一致）。 */
export const PROVIDER_ID = "wool-qoder";

/**
 * 扩展入口（extension-conventions：default export 即 ExtensionFactory）。
 * 用户可见恢复路径：login 抛错（pi 呈现）与管理命令 envelope 回写（消息内嵌指引）。
 */
export default function piWoolQoder(pi: ExtensionAPI): void {
	const authStore = new QoderAuthStore();
	// 管理会话凭据通道：session_start 捕获 registry（scaffold 亦各自捕获一份用于
	// streamSimple；两 listener 独立注册，互不干扰）。
	let registry: ModelRegistry | undefined;
	pi.on("session_start", (_event, ctx) => {
		registry = ctx.modelRegistry;
	});

	// drive 参数形态是 WoolStreamRequest 的结构子集（凭据从 authStore 取）。请求时
	// 凭据双通道（D2）经 adoptRequestApiKey 采纳进 authStore：options.apiKey
	// （models.json 羊毛条目）在场即学习（新 token 经 userinfo 一次补全，同 token 缓存
	// 命中零网络）；oauth 钩子通道的 token 由 getApiKey 学习——同 token 直接过。
	const drive = createQoderDrive({ authStore, lookupModelMeta });
	const stream: WoolStreamImplementation = async (request) => {
		if (!request.resolvedAuth.ok) {
			throw new Error(request.resolvedAuth.error);
		}
		await adoptRequestApiKey(authStore, request.resolvedAuth.apiKey);
		return drive({
			model: request.model,
			systemPrompt: request.systemPrompt,
			tools: request.tools,
			messages: request.messages,
			driver: request.driver,
		});
	};

	defineWoolExtension({
		familyId: FAMILY_ID,
		displayName: "Qoder (Wool)",
		api: QODER_API_ID,
		// baseUrl 为 pi composer 硬校验项（P6 发现：带 models 注册时必填）。
		baseUrl: GATEWAY_BASE_URL,
		stream,
		fetchModels: async (ctx) => {
			// pi 在带网阶段前完成凭据刷新并经 ctx.credential 传入——先学习再拉目录。
			if (ctx.credential !== undefined) {
				authStore.learn(ctx.credential);
			}
			return fetchModelCatalog({ authStore, signal: ctx.signal });
		},
		snapshotPath: join(import.meta.dirname, "..", "snapshots", "qoder.json"),
		oauth: {
			name: "Qoder (Alibaba)",
			login: (callbacks) =>
				login({
					onPrompt: (prompt) => callbacks.onPrompt(prompt),
					...(callbacks.onProgress !== undefined
						? { onProgress: (message) => callbacks.onProgress?.(message) }
						: {}),
				}),
			refreshToken: (credentials: OAuthCredentials, signal: AbortSignal) => refreshToken(credentials, signal),
			getApiKey: makeGetApiKey(authStore),
		},
		manageHandlers: {
			// 登录态检测语义（D3）：凭据文件存在性一次 stat，不读内容、不解密、不轮询。
			// 回包字段 = 宿主守卫 isWoolDetectData 契约的 detected（wool-manage 协议 data 形状）。
			detect: async () => ({ detected: detectCredentialFile() }),
			// 凭据提取（D2 改道主通道）：钥匙串提取链一次执行 → dt-/drt- + displayName 按
			// wool-shared WoolCredentialAcquireData 契约回传（宿主写 models.json apiKey 条目）。
			// 提取失败 throw → envelope internal（消息内嵌恢复动作：确认桌面端已登录/改用 PAT）。
			extract: async () => extractToAcquireData(),
			// 账号状态拉取（D6 ③：taiji 主动问，无后台推送）。凭据解析失败/无凭据
			// = 未登录态；上游拉取失败 throw → envelope upstream_error（宿主可重试）。
			status: async () => {
				if (authStore.current() === undefined) {
					// 管理专用会话：经 registry 走一次凭据解析（getApiKey 钩子副作用学习）。
					const key = await registry?.getApiKeyForProvider(PROVIDER_ID);
					if (key === undefined && authStore.current() === undefined) {
						return woolLoggedOutStatus(FAMILY_ID, Date.now());
					}
				}
				const state = authStore.current();
				if (state === undefined) {
					return woolLoggedOutStatus(FAMILY_ID, Date.now());
				}
				// userinfo / quota 独立数据源：userinfo 失败 = 无法确认身份（整体
				// upstream_error）；quota 失败 = 部分降级（loggedIn 仍可报，quota 缺席）。
				const [userinfoResult, quotaResult] = await Promise.allSettled([
					fetchUserinfo(state.accessToken, state.uid),
					fetchQuotaUsage(state.accessToken, state.uid),
				]);
				if (userinfoResult.status === "rejected") {
					throw userinfoResult.reason instanceof Error ? userinfoResult.reason : new Error(String(userinfoResult.reason));
				}
				const userinfo = userinfoResult.value;
				return {
					family: FAMILY_ID,
					loggedIn: true,
					nickname: state.nickname || userinfo.name,
					...(quotaResult.status === "fulfilled"
						? { quota: { used: quotaResult.value.used, total: quotaResult.value.total, remaining: quotaResult.value.remaining, unit: "credits" } }
						: {}),
					...(state.expiresAt > 0 ? { tokenExpiresAt: state.expiresAt } : {}),
					fetchedAt: Date.now(),
				};
			},
			// Qoder 签到不在本包首版范围（hub 侧为可选任务模块运行时探测；设计 D5
			// 签到交付物在 WorkBuddy 域）——显式报不支持，不静默假成功。
			checkin: async () => ({ supported: false, reason: "Qoder check-in is not implemented in this extension version" }),
			// 凭据权威在 pi auth.json；pi 扩展 API 无凭据删除通道（宿主同样无 Models.logout
			// 通路）——这里只清进程内副本，auth.json 凭据由宿主卸载编排按 D3 降级条款呈现
			// 残留提示（指引 pi 侧 /logout）。pi persist 的模型目录删除由 scaffold clear
			// 编排统一承担（D3 卸载编排②，响应并入 persistCleared 字段）。
			clear: async () => {
				authStore.clear();
				return {
					cleared: true,
					note: "in-process credential cache cleared; stored credentials remain in pi auth.json — remove via pi /logout (host has no credential deletion channel)",
				};
			},
		},
	})(pi);
}
