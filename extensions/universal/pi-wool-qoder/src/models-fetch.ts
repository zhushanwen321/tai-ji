// models-fetch.ts — model/list 拉取 → pi 模型目录（设计 D4；带网阶段实装）。
//
// 上游请求形态（P5 实测裁决，2026-10-21）：**GET 无 body，签名按空 body 计算**
// （服务端按 body="" 校验 GET 签名）——hub 的 Python 形态是 GET+body（urllib 专属
// 能力），Node fetch spec 禁止 GET 带 body；实测三候选：POST 400（method not
// supported）、GET 无 body 按 "{}" 签名 403（Signature invalid）、GET 无 body 按
// 空串签名 200（真实目录返回）。签名 method 无关（hub：签名只覆盖 path 与 body）。
//
// 目录条目过滤（hub is_chat_model）：补全/图像类 key 不进对话模型目录。快照兜底 =
// 包内 snapshots/qoder.json（scaffold 的 restore 回落链），本模块只管带网拉取与
// pi Model 构造。

import type { Api, Model } from "@earendil-works/pi-ai";

import type { QoderAuthStore } from "./credentials.ts";
import { DEFAULT_CONTEXT_WINDOW, GATEWAY_BASE_URL, MODELS_PATH, NON_CHAT_MODEL_KEYS, NON_CHAT_MODEL_PREFIXES, NON_CHAT_MODEL_SUFFIXES, SNAPSHOT_FALLBACK_MODELS } from "./constants.ts";
import type { QoderModelMeta } from "./chat-body.ts";

/** model/list 的 chat 条目（官方原始字段族，只取实装消费的子集）。 */
export type UpstreamCatalogEntry = {
	key: string;
	display_name?: string;
	is_vl?: boolean;
	is_reasoning?: boolean;
	max_input_tokens?: number;
};

/** 补全/图像类 key 过滤（hub NON_CHAT_MODELS/PREFIXES/SUFFIXES 同词表）。 */
export function isChatModelKey(key: string): boolean {
	if (key.length === 0) {
		return false;
	}
	if ((NON_CHAT_MODEL_KEYS as readonly string[]).includes(key)) {
		return false;
	}
	if (NON_CHAT_MODEL_PREFIXES.some((prefix) => key.startsWith(prefix))) {
		return false;
	}
	if (NON_CHAT_MODEL_SUFFIXES.some((suffix) => key.endsWith(suffix))) {
		return false;
	}
	return true;
}

/** provider 注册名（pi Model.provider；与 scaffold 的 woolProviderId("qoder") 一致）。 */
const PROVIDER_ID = "wool-qoder";
/** 上游 chat 模型的 api id（scaffold 注册 streamSimple 的 api 一致性键）。 */
export const QODER_API_ID = "wool-qoder";
/** 单轮生成上限提示（baseprompt parameters.max_tokens 官方骨架缺省 32768）。 */
const DEFAULT_MAX_TOKENS = 32768;
/** 错误消息内上游响应摘录的最大长度（与 chat-stream 同口径）。 */
const ERROR_DETAIL_LENGTH = 300;

/** 上游条目 → pi chat 模型（persist/内存/快照三处同型；scaffold fetchModels 契约）。 */
export function toPiModel(entry: UpstreamCatalogEntry): Model<Api> {
	const maxInput = typeof entry.max_input_tokens === "number" && entry.max_input_tokens > 0 ? entry.max_input_tokens : DEFAULT_CONTEXT_WINDOW;
	const displayName = entry.display_name ?? entry.key;
	return {
		id: entry.key,
		name: displayName,
		api: QODER_API_ID,
		provider: PROVIDER_ID,
		baseUrl: GATEWAY_BASE_URL,
		type: "chat" as const,
		reasoning: entry.is_reasoning === true,
		input: entry.is_vl === true ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: maxInput,
		maxTokens: DEFAULT_MAX_TOKENS,
	};
}

/** 上游条目 → model_config 元数据（chat-body 反查用）。 */
export function toModelMeta(entry: UpstreamCatalogEntry): QoderModelMeta {
	return {
		key: entry.key,
		displayName: entry.display_name ?? entry.key,
		isVl: entry.is_vl === true,
		isReasoning: entry.is_reasoning === true,
		maxInputTokens: typeof entry.max_input_tokens === "number" && entry.max_input_tokens > 0 ? entry.max_input_tokens : DEFAULT_CONTEXT_WINDOW,
	};
}

// 进程内目录元数据缓存：fetch 成功后填充；chat-stream 按 model.id 反查 model_config。
// 生命周期与 ModelRegistry 一致（进程级资源）。
const metaCache = new Map<string, QoderModelMeta>();

/** 模型元数据反查：先查最近一次拉取目录，再回落内置快照（模型 key 稳定，
 * 显示名/参数档位即快照值——只影响请求体元数据面，不影响路由正确性）。 */
export function lookupModelMeta(modelId: string): QoderModelMeta | undefined {
	const cached = metaCache.get(modelId);
	if (cached !== undefined) {
		return cached;
	}
	const fallback = SNAPSHOT_FALLBACK_MODELS.find((model) => model.id === modelId);
	if (fallback === undefined) {
		return undefined;
	}
	return { key: fallback.id, displayName: fallback.name, isVl: false, isReasoning: fallback.reasoning, maxInputTokens: DEFAULT_CONTEXT_WINDOW };
}

/** 拉取并解析 model/list 响应（COSY 会话由 authStore 提供；fetch 可注入测试）。 */
export async function fetchModelCatalog(options: {
	authStore: QoderAuthStore;
	fetchImpl?: typeof globalThis.fetch;
	signal?: AbortSignal;
}): Promise<Model<Api>[]> {
	const session = options.authStore.session();
	if (session === undefined) {
		throw new Error("qoder model catalog: no credentials; run the provider login (extract) first");
	}
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const url = `${GATEWAY_BASE_URL}${MODELS_PATH}`;
	const response = await fetchImpl(url, {
		// GET 无 body + 签名按空 body（文件头注：P5 实测三候选中唯一 200 的形态）。
		method: "GET",
		headers: session.headers("", url, "", false),
		signal: options.signal,
	});
	if (!response.ok) {
		const detail = (await response.text()).slice(0, ERROR_DETAIL_LENGTH);
		throw new Error(`qoder model catalog upstream HTTP ${response.status}: ${detail}`);
	}
	const payload: unknown = await response.json();
	if (typeof payload !== "object" || payload === null || !Array.isArray((payload as Record<string, unknown>).chat)) {
		throw new Error("qoder model catalog: unexpected response shape (missing chat array)");
	}
	const entries: UpstreamCatalogEntry[] = ((payload as Record<string, unknown>).chat as unknown[]).flatMap((item) => {
		if (typeof item !== "object" || item === null) {
			return [];
		}
		const record = item as Record<string, unknown>;
		if (typeof record.key !== "string" || !isChatModelKey(record.key)) {
			return [];
		}
		return [
			{
				key: record.key,
				...(typeof record.display_name === "string" ? { display_name: record.display_name } : {}),
				...(typeof record.is_vl === "boolean" ? { is_vl: record.is_vl } : {}),
				...(typeof record.is_reasoning === "boolean" ? { is_reasoning: record.is_reasoning } : {}),
				...(typeof record.max_input_tokens === "number" ? { max_input_tokens: record.max_input_tokens } : {}),
			} satisfies UpstreamCatalogEntry,
		];
	});
	for (const entry of entries) {
		metaCache.set(entry.key, toModelMeta(entry));
	}
	return entries.map(toPiModel);
}
