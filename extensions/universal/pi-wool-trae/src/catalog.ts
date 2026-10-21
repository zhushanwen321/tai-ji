// catalog.ts — get_detail_param → pi 模型目录（D4；consumption_rate 透传）。
//
// 上游形态（2026-10-21 实测）：config_info_list 条目关键字段：
// - config_name（pi 模型 id）、display_config.display_name（显示名）、
//   display_config.multimodal / model_capability、context_window_tokens.dev、
//   model_detail_list[0]（max_tokens / prompt_max_tokens / model_name 内部名 / max_turn）、
//   display_contact_config.consumption_rate = { enable, data: { rate } }（消耗系数，
//   设计增量项：仅透传展示）、display_contact_config.activity_discount（折扣费率）。
// - 条目里混有非对话模型（*_subagent / summary / file_search_agent / custom_model_*）
//   与对用户不可见条目（is_invisible_to_user），按可见性 + usage=chat_completion 过滤。

import type { Api, Model } from "@earendil-works/pi-ai";

import { CATALOG_ENDPOINT, SOLO_FUNCTION, TRAE_GATEWAY_CN, buildCommonHeaders, type TraeAuthInputs } from "./protocol.ts";

/** Trae 模型目录条目（pi Model 结构超集：+ consumptionRate 透传字段）。
 * pi 装载目录只按 type 过滤不剥额外字段（pi-ai models.js withKnownModelTypes 实装
 * 核实），额外字段经 persist（models-store.json JSON 往返）与包内快照全程保留。 */
export type TraeModel = Model<Api> & {
	/** 消耗系数（上游 display_contact_config.consumption_rate，仅透传展示——设计 D4 增量项）。 */
	consumptionRate?: { enable: boolean; rate: number };
};

/** fetchModels 的请求执行通道（测试注入用；生产 = globalThis.fetch，D1 出站约束）。 */
export type TraeFetch = typeof globalThis.fetch;

/** get_detail_param 请求体（7 字段齐备，空 body = 上游 500——实测）。 */
function catalogRequestBody(): Record<string, unknown> {
	return {
		function: SOLO_FUNCTION,
		config_names: null,
		need_prompt: false,
		current_config_info: null,
		poly_prompt: true,
		mode_type: null,
		agent_type: null,
	};
}

/** 目录条目读取所需的上游字段形态（读侧不信任外部格式，逐字段守卫）。 */
type RawCatalogEntry = {
	config_name: string;
	config_switch?: boolean;
	is_invisible_to_user?: boolean;
	usage?: string;
	context_window_tokens?: { dev?: number };
	display_config?: {
		display_name?: string;
		multimodal?: boolean;
		model_capability?: string;
	};
	display_contact_config?: string | {
		consumption_rate?: { enable?: boolean; data?: { rate?: number } };
	};
	model_detail_list?: Array<{
		max_tokens?: number;
		prompt_max_tokens?: number;
	}>;
};

/** 目录拉取超时（ms）。 */
const CATALOG_TIMEOUT_MS = 30_000;

/** 错误响应体截断长度。 */
const ERROR_BODY_SNIPPET = 200;

/** 条目缺 context_window_tokens 时的回退窗口（保守值）。 */
const DEFAULT_CONTEXT_WINDOW = 128_000;

/** 条目缺 model_detail_list[0].max_tokens 时的回退上限。 */
const DEFAULT_MAX_TOKENS = 8_192;

function parseEntry(raw: unknown): RawCatalogEntry | undefined {
	if (typeof raw !== "object" || raw === null) {
		return undefined;
	}
	const record = raw as Record<string, unknown>;
	if (typeof record.config_name !== "string" || record.config_name.length === 0) {
		return undefined;
	}
	// config_name 已运行时校验；其余字段经 RawCatalogEntry 的可选形态逐字段守卫读取
	return raw as RawCatalogEntry;
}

/** display_contact_config 可能是 JSON 字符串或内联对象（实测为对象；字符串形态容错）。 */
function readContactConfig(entry: RawCatalogEntry): Record<string, unknown> {
	const raw = entry.display_contact_config;
	if (typeof raw === "string") {
		try {
			const parsed: unknown = JSON.parse(raw);
			return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
		} catch {
			return {};
		}
	}
	if (typeof raw === "object" && raw !== null) {
		return raw as Record<string, unknown>;
	}
	return {};
}

/** consumption_rate 透传读取：{enable, data:{rate}} → {enable, rate}；缺失/禁用不写字段。 */
function readConsumptionRate(contact: Record<string, unknown>): TraeModel["consumptionRate"] {
	const raw = contact.consumption_rate;
	if (typeof raw !== "object" || raw === null) {
		return undefined;
	}
	const record = raw as Record<string, unknown>;
	if (record.enable !== true) {
		return undefined;
	}
	const data = record.data;
	if (typeof data !== "object" || data === null) {
		return undefined;
	}
	const rate = (data as Record<string, unknown>).rate;
	if (typeof rate !== "number" || !Number.isFinite(rate)) {
		return undefined;
	}
	return { enable: true, rate };
}

/** 非对话条目过滤：对用户不可见 / 上游开关关 / 非对话用途（subagent/summary 等）不入目录。 */
function isUserVisibleChatEntry(entry: RawCatalogEntry): boolean {
	if (entry.is_invisible_to_user === true || entry.config_switch === false) {
		return false;
	}
	if (entry.usage !== undefined && entry.usage !== "chat_completion") {
		return false;
	}
	if (/(_subagent|^summary$|^file_search_agent$|^custom_model_)/.test(entry.config_name)) {
		return false;
	}
	return true;
}

/** 上游条目 → pi 完整模型对象（provider/baseUrl 已补全——与 scaffold persist 契约同型）。 */
function toTraeModel(entry: RawCatalogEntry): TraeModel {
	const detail = entry.model_detail_list?.[0];
	const contextWindow = entry.context_window_tokens?.dev ?? DEFAULT_CONTEXT_WINDOW;
	const name = entry.display_config?.display_name ?? entry.config_name;
	const reasoning = entry.display_config?.model_capability === "reasoning_model";
	const input: ("text" | "image")[] = entry.display_config?.multimodal === true ? ["text", "image"] : ["text"];
	const maxTokens = detail?.max_tokens ?? DEFAULT_MAX_TOKENS;
	const model: TraeModel = {
		id: entry.config_name,
		name,
		api: "wool-trae",
		provider: "wool-trae",
		baseUrl: TRAE_GATEWAY_CN,
		reasoning,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
	};
	const consumptionRate = readConsumptionRate(readContactConfig(entry));
	if (consumptionRate !== undefined) {
		model.consumptionRate = consumptionRate;
	}
	return model;
}

/** 目录拉取失败（网络 / 非 200 / 形状不符——D4 快照兜底由调用方承接）。 */
export class TraeCatalogError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TraeCatalogError";
	}
}

/** 拉取上游模型目录（带网阶段；出站统一经 globalThis.fetch——D1 约束）。 */
export async function fetchTraeCatalog(auth: TraeAuthInputs, fetchImpl: TraeFetch = globalThis.fetch): Promise<TraeModel[]> {
	const response = await fetchImpl(`${TRAE_GATEWAY_CN}${CATALOG_ENDPOINT}`, {
		method: "POST",
		headers: buildCommonHeaders(auth),
		body: JSON.stringify(catalogRequestBody()),
		signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
	});
	if (!response.ok) {
		const bodyText = await response.text().catch(() => "");
		throw new TraeCatalogError(`get_detail_param failed: ${response.status} ${bodyText.slice(0, ERROR_BODY_SNIPPET)}`);
	}
	let parsed: unknown;
	try {
		parsed = await response.json();
	} catch (error) {
		throw new TraeCatalogError(`get_detail_param returned non-JSON body: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as Record<string, unknown>).config_info_list)) {
		throw new TraeCatalogError("get_detail_param response missing config_info_list");
	}
	const models: TraeModel[] = [];
	for (const raw of (parsed as Record<string, unknown>).config_info_list as unknown[]) {
		const entry = parseEntry(raw);
		if (entry !== undefined && isUserVisibleChatEntry(entry)) {
			models.push(toTraeModel(entry));
		}
	}
	return models;
}
