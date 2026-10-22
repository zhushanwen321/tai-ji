// src/index.ts — @zhushanwen/pi-wool-workbuddy 扩展入口（WorkBuddy·腾讯 家族）。
//
// 组装件：streamSimple 协议翻译（stream.ts）/ OAuth 钩子族（oauth.ts + callback-server.ts）/
// 签到与账号状态（checkin.ts + account.ts）/ 模型目录（models.ts + snapshots 兜底）。
// pi 契约接线（ProviderConfig 组装、D4 缓存与 persist、事件流纪律、管理命令注册）
// 由 @zhushanwen/pi-wool-shared 的 defineWoolExtension 统一承担。

import type { ExtensionAPI, ExtensionFactory, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { fileURLToPath } from "node:url";

import {
	defineWoolExtension,
	readSnapshotFile,
	WoolManageRequestError,
	type WoolFetchModelsContext,
	type WoolStreamOutcome,
	type WoolStreamRequest,
} from "@zhushanwen/pi-wool-shared";

import { workbuddyAccountStatus, authContextFromToken } from "./account.ts";
import { executeCheckin } from "./checkin.ts";
import { isWorkbuddyRealm } from "./constants.ts";
import { fetchWorkbuddyModels, indexSnapshot } from "./models.ts";
import {
	asWorkbuddyCredential,
	buildWoolAuthorizeNotice,
	runWorkbuddyAuthorization,
	toWoolAcquireData,
	workbuddyApiKey,
	workbuddyLogin,
	workbuddyRefresh,
} from "./oauth.ts";
import { workbuddyStream } from "./stream.ts";

export const FAMILY_ID = "workbuddy" as const;
export const PROVIDER_ID = "wool-workbuddy" as const;
export const PROVIDER_API = "wool-workbuddy" as const;

/** 会话键：同一 pi 会话多轮复用 X-Conversation-ID（首条 user 消息时间戳 = 会话稳定特征）。 */
function conversationKeyOf(messages: WoolStreamRequest["messages"]): string {
	for (const message of messages) {
		if (message.role === "user") {
			return String(message.timestamp);
		}
	}
	return "empty-session";
}

function streamAdapter(request: WoolStreamRequest): Promise<WoolStreamOutcome> {
	return workbuddyStream({
		model: request.model,
		systemPrompt: request.systemPrompt,
		tools: request.tools,
		messages: request.messages,
		resolvedAuth: request.resolvedAuth,
		driver: request.driver,
		conversationKey: conversationKeyOf(request.messages),
	});
}

const SNAPSHOT_PATH = fileURLToPath(new URL("../snapshots/workbuddy.json", import.meta.url));

/** 快照索引（模块级缓存：包内只读资源，文件读一次）。 */
let snapshotIndex: ReturnType<typeof indexSnapshot> | undefined;

function snapshotModels(): ReturnType<typeof indexSnapshot> {
	if (snapshotIndex === undefined) {
		snapshotIndex = indexSnapshot(readSnapshotFile(SNAPSHOT_PATH)?.models ?? []);
	}
	return snapshotIndex;
}

function fetchModelsAdapter(ctx: WoolFetchModelsContext): Promise<Model<Api>[]> {
	const credential = asWorkbuddyCredential(ctx.credential);
	const realm =
		credential !== undefined && isWorkbuddyRealm(credential.realm) ? credential.realm : "cn";
	return fetchWorkbuddyModels({
		credential,
		signal: ctx.signal,
		snapshot: snapshotModels(),
		realm,
	});
}

// ---------------------------------------------------------------------------
// 管理动作凭据通道：session_start 捕获 modelRegistry 后可解析（管理专用会话同样
// 跑 session_start）。ModelAuth 只有 apiKey（access token）——uid/realm/domain 从
// JWT 解码；credential 扩展字段（nickname）无公开读取通道，status 昵称缺省。
// registry 是进程级单例、读取无状态，模块级 holder 与其生命周期一致。
// ---------------------------------------------------------------------------

let apiKeyResolver: (() => Promise<string | undefined>) | undefined;

async function resolveAccessToken(): Promise<string | undefined> {
	if (apiKeyResolver === undefined) {
		return undefined;
	}
	return apiKeyResolver();
}

const definitionFactory: ExtensionFactory = defineWoolExtension({
	familyId: FAMILY_ID,
	displayName: "WorkBuddy",
	api: PROVIDER_API,
	// baseUrl 为 pi composer 硬校验项（带 models 注册时必填）；对话端点 CN 基址。
	baseUrl: "https://copilot.tencent.com",
	stream: streamAdapter,
	oauth: {
		name: "WorkBuddy (Tencent)",
		login: (callbacks) => workbuddyLogin(callbacks),
		refreshToken: (credentials, signal) => workbuddyRefresh(credentials, signal),
		getApiKey: (credentials) => workbuddyApiKey(credentials),
	},
	fetchModels: fetchModelsAdapter,
	snapshotPath: SNAPSHOT_PATH,
	manageHandlers: {
		status: async () => {
			const accessToken = await resolveAccessToken();
			return workbuddyAccountStatus(accessToken !== undefined, accessToken, undefined);
		},
		detect: async () => {
			// D3：OAuth 家族登录态检测不适用——「需授权」由 credentialsSource 静态推导，
			// 不经 detect 回传；detected 仅反映凭据在位（回包字段 = 宿主守卫
			// isWoolDetectData 契约的 detected，wool-manage 协议 data 形状）。
			const accessToken = await resolveAccessToken();
			return { detected: accessToken !== undefined };
		},
		// OAuth 家族不走本机提取（凭据来自浏览器授权）——明确报不支持，不静默假成功。
		extract: async () => {
			throw new WoolManageRequestError(
				'WorkBuddy is an OAuth family: run the authorize action (browser sign-in), not local extraction',
				"invalid_request",
			);
		},
		// 凭据授权（D2 改道主通道）：state 起始 + 本机回调监听（现成模块）→ 授权页 URL
		// 经扩展 UI 通知（ctx.ui.notify，P6 验证通道）以单行 JSON 投递 taiji 浮层（加载
		// authUrl、完成后向 callbackUrl 发 done/cancel）→ 回调驱动令牌交换 → 按
		// WoolCredentialAcquireData 契约回传（宿主写 models.json apiKey 条目）。全程事件
		// 驱动（时间平抑红线：无轮询无定时器），仅在用户向导显式触发时执行一次（D3）。
		authorize: async (_params, ctx) => {
			const credentials = await runWorkbuddyAuthorization({
				deliverAuthInfo: (info) => {
					ctx.notify(buildWoolAuthorizeNotice(info));
				},
			});
			return toWoolAcquireData(credentials);
		},
		checkin: async () => {
			const accessToken = await resolveAccessToken();
			if (accessToken === undefined) {
				throw new Error("WorkBuddy check-in requires authorization (run /login wool-workbuddy first)");
			}
			const auth = authContextFromToken(accessToken);
			return executeCheckin(auth.realm, auth);
		},
		clear: async () => {
			// pi 扩展 API 无凭据删除通道（ModelRegistry 只读 auth）——按设计 D3 风险表
			// 预案降级为显式残留提示 + 手动清除指引（pi 内建 /logout 按 provider 清）。
			return {
				cleared: false,
				manual: "Run /logout wool-workbuddy in a pi session to remove stored WorkBuddy credentials.",
			};
		},
	},
});

export default function piWoolWorkbuddyExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		const registry: ModelRegistry = ctx.modelRegistry;
		apiKeyResolver = () => registry.getApiKeyForProvider(PROVIDER_ID);
	});
	definitionFactory(pi);
}
