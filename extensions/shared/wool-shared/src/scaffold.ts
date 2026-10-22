// scaffold.ts — 羊毛扩展脚手架：registerProvider 封装 + 生命周期接线。
//
// 家族扩展包只提供差异件（协议翻译 stream / 凭据 oauth 钩子 / 模型目录拉取 fetchModels /
// 管理动作 handlers），pi 契约的全部接线（ProviderConfig 组装、refreshModels 的 D4 缓存
// 语义与 persist、streamSimple 事件流纪律、管理命令注册）由本脚手架统一承担。
//
// 生命周期形态：defineWoolExtension 返回 pi ExtensionFactory（extension-conventions
// 「扩展入口：export default function xxxExtension(pi)」）。模型目录 store 与凭据解析器
// 挂 factory 闭包（每次 factory 调用重建）——满足 extensions 的 session 隔离约定（状态
// 存 session_start 重建的闭包变量），同时 provider 注册与 refreshModels 本就是进程级
// 资源（ModelRegistry 单例），闭包生命周期与之一致。
//
// 凭据通道：streamSimple 签名不带 ctx，pi 也不向其传 resolved api key（provider-composer
// 原样透传 options）。公开解析通道 = ExtensionContext.modelRegistry.getApiKeyAndHeaders
// （ModelRegistry 公开方法，请求时鉴权语义）——脚手架经首个 session_start 捕获 ctx 后，
// 家族 stream 在请求时拿到 { apiKey, headers, baseUrl }。

// pi 宿主注入清单只支持 pi-ai 根/compat/oauth/providers/all 四入口（virtual-modules.js），
// utils/transcript 深路径在真机 pi 加载下不可解析（单测环境被 repo node_modules 掩盖）——
// getCurrentSystemPrompt/getCurrentTools 根入口有等价导出，改根 import
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionFactory,
	ProviderConfig,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type {
	Api,
	Credential,
	Message,
	Model,
	ModelsStoreEntry,
	RefreshModelsContext,
	SimpleStreamOptions,
	Tool,
	TranscriptContext,
} from "@earendil-works/pi-ai";

import type { WoolManageHandlers } from "./manage-protocol.ts";
import { registerWoolManageCommand } from "./manage-protocol.ts";
import {
	createModelCatalogStore,
	readSnapshotFile,
	toPersistEntry,
	type WoolCatalogSnapshot,
} from "./model-catalog.ts";
import type { WoolStreamDriverContext, WoolStreamOutcome } from "./stream-adapter.ts";
import { createAssistantStream } from "./stream-adapter.ts";
import type { WoolFamilyId } from "./types.ts";
import { woolProviderId } from "./types.ts";

/** 凭据解析失败（getApiKeyAndHeaders ok:false）时家族 stream 收到的形态。 */
export type WoolResolvedAuth =
	| { ok: true; apiKey?: string; headers?: Record<string, string | null>; baseUrl?: string }
	| { ok: false; error: string };

/** 凭据双通道（D2 改道：请求时 options.apiKey + oauth 钩子）皆缺时的统一错误
 * （错误 → 权威源 → 重试闭环：taiji 向导接入，或独立 pi 用户在 pi 内 /login）。 */
export const WOOL_CREDENTIALS_MISSING_MESSAGE = "凭据未配置：经 taiji 向导接入或在 pi 内 /login";

/**
 * 请求时凭据解析（D2 双通道优先级，请求管线事实锚：pi model-runtime prepareRequest
 * 把 models.json 羊毛 provider 条目 apiKey 经 `providerOptions.apiKey ?? resolution.auth.apiKey`
 * 合并进 streamSimple options）：
 * ① options.apiKey —— taiji 向导写入 models.json 的主通道，在场即采信（跳过 registry
 *    解析，不做 oauth 刷新尝试）；
 * ② registry oauth 钩子凭据 —— 独立 pi 用户 TUI /login 形态（D8 承诺），过期自动刷新。
 * ② 解析 ok:false（刷新链失败等）保留原错误（比统一消息更可诊断）；ok 但无 apiKey
 * （wool 家族 authHeader 缺省下 pi 对未配置 provider 的回包形态）→ 统一「凭据未配置」。
 */
async function resolveRequestAuth(
	resolveViaRegistry: (model: Model<Api>) => Promise<WoolResolvedAuth>,
	model: Model<Api>,
	requestApiKey: string | undefined,
): Promise<WoolResolvedAuth> {
	if (typeof requestApiKey === "string" && requestApiKey.length > 0) {
		return { ok: true, apiKey: requestApiKey };
	}
	const resolved = await resolveViaRegistry(model);
	if (!resolved.ok) {
		return resolved;
	}
	if (typeof resolved.apiKey === "string" && resolved.apiKey.length > 0) {
		return resolved;
	}
	return { ok: false, error: WOOL_CREDENTIALS_MISSING_MESSAGE };
}

/** 家族协议翻译的输入：pi 标准请求要素 + 发射上下文。 */
export interface WoolStreamRequest { // oe-exempt:20261022:framework:家族 stream 入参契约——pi-wool-trae / pi-wool-workbuddy index.ts 按名导入，pi-wool-qoder index.ts 结构子集消费
	model: Model<Api>;
	/** 回放后的系统提示词（含后续 system 消息增量）。 */
	systemPrompt: string;
	/** 回放后的工具声明集。 */
	tools: Tool[];
	/** 完整 transcript（家族自行取末条 user 消息等）。 */
	messages: Message[];
	/** 请求时凭据（D2 优先级：options.apiKey（models.json 羊毛条目）> registry oauth 钩子；
	 * 双缺 = ok:false + 统一「凭据未配置」错误——家族直抛给用户）。 */
	resolvedAuth: WoolResolvedAuth;
	/** 事件发射与仪表钩子透传上下文（骨架提供）。 */
	driver: WoolStreamDriverContext;
}

/** 家族 streamSimple 实装：翻译协议、发事件，终态返回 outcome（异常由骨架转 error/abort）。 */
export type WoolStreamImplementation = (request: WoolStreamRequest) => Promise<WoolStreamOutcome>;

/** fetchModels 的调用上下文（RefreshModelsContext 的家族可见子集）。 */
export interface WoolFetchModelsContext { // oe-exempt:20261022:framework:家族 fetchModels 上下文契约——pi-wool-workbuddy index.ts fetchModelsAdapter 按名导入，trae/qoder 家族 fetchModels 结构化消费
	/** 已刷新的 OAuth 凭据（pi 在网络访问前完成刷新）；apiKey 形态也可能出现。 */
	credential?: Credential;
	/** false = 离线阶段（启动/扩展注册），家族不得发网络请求。 */
	allowNetwork: boolean;
	/** true = 显式强制（taiji「刷新模型列表」按钮 / 报错触发的 registry refresh）。 */
	force: boolean;
	signal: AbortSignal;
}

/**
 * fetchModels 契约：返回**完整模型对象**（provider/baseUrl 已补全，模型级字段齐备）——
 * 与 pi createProvider.fetchModels 同契约（pi-ai models.js:592-596：fetched 直接装
 * persist 与内存目录）。pi composer 对 legacy ProviderConfig.refreshModels 返回值另做
 * applyExtension 归一化（补 provider/baseUrl 默认），persist 侧不经归一化直装——
 * 家族返回完整模型使 persist/内存/快照三处同型，无配置形态到运行时形态的转换层。
 */
export type WoolFetchModels = (ctx: WoolFetchModelsContext) => Promise<Model<Api>[]>;

export interface WoolFamilyExtensionDefinition { // oe-exempt:20261022:framework:defineWoolExtension SDK 定义项契约——qoder/trae/workbuddy 三家 index.ts 构造消费 + scaffold.test.ts 按名引用
	familyId: WoolFamilyId;
	/** UI 显示名（provider 注册名固定为 wool-<familyId>）。 */
	displayName: string;
	/**
	 * 自定义 api id。pi composer 硬校验：注册 streamSimple 必须带 api
	 * （provider-composer.js validateExtensionProvider：「"api" is required when
	 * registering streamSimple」），且 streamSimple 仅对 model.api === 此值的模型分发。
	 */
	api: string;
	/** 上游 API 基址（家族上游根 URL）。 */
	baseUrl?: string;
	/** true = pi 自动加 Authorization: Bearer 头。默认 false（三家令牌走自定义头/签名）。 */
	authHeader?: boolean;
	/** 家族协议翻译实装（必填）。 */
	stream: WoolStreamImplementation;
	/** pi oauth 钩子族（login/refreshToken/getApiKey）；ide-extract 家族把提取包装为 login（D3）。 */
	oauth?: ProviderConfig["oauth"];
	/** 带网拉模型目录（缺省 = 静态清单 provider：用 staticModels）。 */
	fetchModels?: WoolFetchModels;
	/** 静态清单（echo 参考扩展形态；与 fetchModels 互斥）。 */
	staticModels?: Model<Api>[];
	/** 包内快照文件绝对路径（import.meta.dirname 拼接；缺省 = 无快照兜底）。 */
	snapshotPath?: string;
	/** 包内快照预载（测试注入用；设置后 snapshotPath 被忽略）。 */
	loadSnapshot?: () => WoolCatalogSnapshot | undefined;
	/** 管理动作 handlers（缺省 = 不注册管理命令）。 */
	manageHandlers?: WoolManageHandlers;
}

function snapshotLoaderFor(definition: WoolFamilyExtensionDefinition): (() => WoolCatalogSnapshot | undefined) | undefined {
	if (definition.loadSnapshot !== undefined) {
		return definition.loadSnapshot;
	}
	if (definition.snapshotPath === undefined) {
		return undefined;
	}
	const snapshotPath = definition.snapshotPath;
	// 延迟到首次调用才读文件（factory 路径零 IO；文件缺失静默 = 无快照兜底）。
	return () => readSnapshotFile(snapshotPath);
}

/**
 * 组装家族扩展 factory。用法：
 * `export default defineWoolExtension({ familyId: "echo", ... })`。
 */
export function defineWoolExtension(definition: WoolFamilyExtensionDefinition): ExtensionFactory {
	const providerId = woolProviderId(definition.familyId);

	return (pi: ExtensionAPI): void => {
		const store = createModelCatalogStore({
			loadSnapshot: snapshotLoaderFor(definition),
		});

		// D3 卸载编排② 的持久化目录删除通道：保存最近一次 refreshModels 的 publish
		// 引用（clear 编排消费）。publish 是世代校验的（pi-ai models.js
		// publishProviderModels：同 provider 新 refresh 开始后旧引用返回 false 不生效）；
		// 管理专用会话即起即收、clear 后无新 refresh，通道稳定。静态清单 provider 无
		// refreshModels → 通道恒缺位（本来从未写过 persist，无可清）。
		let publishPersistClear: (() => Promise<boolean>) | undefined;

		// streamSimple 执行期的凭据解析器：经 session_start 捕获 ctx.modelRegistry
		//（ExtensionContext 上的公开 registry facade）。turn 执行时 session_start
		// 必已跑过；未捕获即执行 streamSimple 属生命周期 bug，fail-fast 拒绝发请求。
		let authResolver: ((model: Model<Api>) => Promise<WoolResolvedAuth>) | undefined;
		pi.on("session_start", (_event, ctx) => {
			const registry: ModelRegistry = ctx.modelRegistry;
			authResolver = async (model) => {
				const resolved = await registry.getApiKeyAndHeaders(model);
				if (resolved.ok) {
					return { ok: true, apiKey: resolved.apiKey, headers: resolved.headers, baseUrl: resolved.baseUrl };
				}
				return { ok: false, error: resolved.error };
			};
		});

		// 静态清单 provider：factory 阶段即装入清单（echo 形态——无 refreshModels）。
		if (definition.fetchModels === undefined) {
			store.replace(definition.staticModels ?? [], "upstream");
		}

		pi.registerProvider(providerId, {
			name: definition.displayName,
			baseUrl: definition.baseUrl,
			authHeader: definition.authHeader,
			api: definition.api,
			// 初始 models = factory 时点目录。动态 provider 空表：registry 读侧在
			// refresh 阶段 1（restore + composer publish update）后即见恢复的目录。
			models: definition.fetchModels === undefined ? (definition.staticModels ?? []) : [],
			...(definition.oauth !== undefined ? { oauth: definition.oauth } : {}),
			...(definition.fetchModels !== undefined
				? {
						// 返回类型 = pi legacy 契约的宽类型（ProviderModelConfig 联合）；
						// 家族 fetchModels 产出的完整 chat 模型是其结构子集，直通赋值。
						refreshModels: async (context: RefreshModelsContext): Promise<ProviderModelConfig[]> => {
							publishPersistClear = () => context.publish({ persist: null });
							// 阶段 1（allowNetwork=false）：恢复 persist 目录；persist 为空时回落包内快照。
							store.restore(context.stored as ModelsStoreEntry | undefined);
							if (!context.allowNetwork) {
								return [...(store.current() ?? [])];
							}
							// 阶段 2（带网）：D4 缓存命中语义——进程内已有清单且非 force，直接返回不发请求。
							if (!store.shouldFetchUpstream(context.force)) {
								return [...(store.current() ?? [])];
							}
							const fetched = await definition.fetchModels?.({
								credential: context.credential,
								allowNetwork: context.allowNetwork,
								force: context.force === true,
								signal: context.signal,
							});
							const models = fetched ?? [];
							store.replace(models, "upstream");
							// P7 结论：legacy 形态 composer 只 publish {update} 不带 persist，
							// 跨会话持久化必须扩展自己 publish（落 <agentDir>/models-store.json）。
							await context.publish({ persist: toPersistEntry(models) });
							return models;
						},
					}
				: {}),
			streamSimple: (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => {
				if (authResolver === undefined) {
					throw new Error(`Wool provider ${providerId}: streamSimple ran before session_start captured the model registry.`);
				}
				const resolveAuth = authResolver;
				// 流取消信号：SimpleStreamOptions 继承 ProviderRequestOptions.signal（pi 传入）。
				const signal = options?.signal ?? new AbortController().signal;
				return createAssistantStream({
					model,
					signal,
					options,
					drive: (driver) =>
						resolveRequestAuth(resolveAuth, model, options?.apiKey).then((resolvedAuth) =>
							definition.stream({
								model,
								systemPrompt: getCurrentSystemPrompt(context.messages),
								tools: getCurrentTools(context.messages),
								messages: context.messages,
								resolvedAuth,
								driver,
							}),
						),
				});
			},
		});

		if (definition.manageHandlers !== undefined) {
			const familyHandlers = definition.manageHandlers;
			registerWoolManageCommand(pi, {
				family: definition.familyId,
				handlers: {
					...familyHandlers,
					// clear 编排 = 家族 clear（进程内凭据面）+ D3 卸载编排②：publish({persist:null})
					// 删除 pi persist 的持久化模型目录 + 进程内清单清空。persistCleared 如实
					// 报告删除结果（false = 无通道〔静态清单/refreshModels 未跑〕或世代过期未生效）。
					clear: async (params, ctx) => {
						const familyResult = await familyHandlers.clear(params, ctx);
						const persistCleared = publishPersistClear !== undefined && (await publishPersistClear());
						store.replace([], "empty");
						const base =
							typeof familyResult === "object" && familyResult !== null && !Array.isArray(familyResult)
								? (familyResult as Record<string, unknown>)
								: {};
						return { ...base, persistCleared };
					},
				},
			});
		}
	};
}
