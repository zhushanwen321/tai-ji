// models.ts — refreshModels 实装：账号级动态模型目录拉取 + 快照元数据匹配。
//
// 上游形态（hub wb_proxy.fetch_endpoint_models 实读）：GET /v2/enterprises/personal/models
// 只返回 id 清单（data.agents[].models[] 字符串数组去重），不含元数据——元数据表
// 由包内快照承载（snapshots/workbuddy.json，17 模型账号级清单），动态 id 不在快照
// 中时按保守缺省构造。快照兜底与持久化由 wool-shared scaffold 承担（D4）。

import type { AnyModel, Api, Model } from "@earendil-works/pi-ai";

import { ERROR_DETAIL_MAX_CHARS, MODELS_PATH, type WorkbuddyRealm } from "./constants.ts";
import { isRecord } from "./guards.ts";
import { buildChatHeaders, realmConfig } from "./headers.ts";
import type { WorkbuddyCredentials } from "./oauth.ts";

/** 动态清单中未知 id 的保守缺省（无元数据时按不可推理纯文本模型构造）。 */
const UNKNOWN_MODEL_DEFAULTS = {
	contextWindow: 176000,
	maxTokens: 32000,
};

/** 快照条目（完整 Model 对象；id 命中时直接使用）。 */
export type WorkbuddySnapshotModels = ReadonlyMap<string, AnyModel>;

/** 快照 JSON（WoolCatalogSnapshot.models 数组）→ id 索引。 */
export function indexSnapshot(models: readonly AnyModel[]): WorkbuddySnapshotModels {
	return new Map(models.map((model) => [model.id, model]));
}

function buildModel(
	realm: WorkbuddyRealm,
	id: string,
	metadata: AnyModel | undefined,
): Model<Api> {
	if (metadata !== undefined) {
		// 快照条目已带 provider/baseUrl（构造时固化）；realm 端点差异只改 baseUrl。
		return { ...metadata, baseUrl: realmConfig(realm).chatUpstream } as Model<Api>;
	}
	return {
		id,
		name: id,
		api: "wool-workbuddy",
		provider: "wool-workbuddy",
		baseUrl: realmConfig(realm).chatUpstream,
		type: "chat",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: UNKNOWN_MODEL_DEFAULTS.contextWindow,
		maxTokens: UNKNOWN_MODEL_DEFAULTS.maxTokens,
	};
}

/** personal/models 响应解析（agents[].models[] 字符串数组去重，保序）。 */
export function parseModelIds(payload: unknown): string[] {
	if (!isRecord(payload)) {
		throw new Error("WorkBuddy models endpoint returned a non-object envelope");
	}
	const data = payload.data;
	if (!isRecord(data)) {
		throw new Error("WorkBuddy models endpoint returned no data");
	}
	const agents = data.agents;
	if (!Array.isArray(agents)) {
		throw new Error("WorkBuddy models endpoint returned no agents array");
	}
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const agent of agents) {
		if (!isRecord(agent)) {
			continue;
		}
		const models = agent.models;
		if (!Array.isArray(models)) {
			continue;
		}
		for (const id of models) {
			if (typeof id === "string" && id.length > 0 && !seen.has(id)) {
				seen.add(id);
				ids.push(id);
			}
		}
	}
	return ids;
}

export type FetchModelsOptions = {
	/** WorkBuddy 凭据（OAuth 形态；apiKey 形态不适用本家族）。 */
	credential?: WorkbuddyCredentials;
	signal: AbortSignal;
	snapshot: WorkbuddySnapshotModels;
	realm: WorkbuddyRealm;
};

/**
 * 带网拉模型目录（fetchModels 契约：返回完整 Model 对象）。
 * 上游 401/网络失败直接 throw——scaffold 侧无缓存命中语义由 store 承担。
 */
export async function fetchWorkbuddyModels(options: FetchModelsOptions): Promise<Model<Api>[]> {
	const { credential, signal, snapshot, realm } = options;
	const accessToken = credential?.access ?? "";
	if (accessToken.length === 0) {
		throw new Error("WorkBuddy models fetch requires OAuth credentials");
	}
	const uid = credential?.uid ?? "";
	const domain = credential?.domain;
	const config = realmConfig(realm);
	const response = await fetch(`${config.chatUpstream}${MODELS_PATH}`, {
		method: "GET",
		headers: buildChatHeaders(realm, { accessToken, uid, domain }, {
			conversationKey: "model-catalog",
			model: "catalog",
		}),
		signal,
	});
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new Error(`WorkBuddy models endpoint HTTP ${response.status}: ${detail.slice(0, ERROR_DETAIL_MAX_CHARS)}`);
	}
	const payload: unknown = JSON.parse(await response.text());
	const ids = parseModelIds(payload);
	return ids.map((id) => buildModel(realm, id, snapshot.get(id)));
}
