/**
 * model picker 的模型列表（picker 用，非 classifier）。
 *
 * P3 收口后 classifier 不再自读 models.json（改走 llm-shared resolveModel +
 * ctx.modelRegistry，见 classifier.ts / production.ts）。
 *
 * E2（CL-picker-scope 收口）：listAvailableModels 改走 ctx.modelRegistry.getAll() +
 * hasConfiguredAuth() 过滤——用户只经 `pi auth login` 配的内置/OAuth provider 同样可见，
 * 不再自读 models.json（loadModelsJson / flattenModels 已删除）。
 * E1：ResolvedModelEntry.apiKey 死字段已删（P3 收口后凭证走 modelRegistry，无消费者）。
 * E5：name/baseUrl/cost 死字段已删（picker 只读 id/api）。
 */

import type { Api, Model } from "@earendil-works/pi-ai";

// ──────────────────────── modelRegistry 最小子集 ────────────────────────

/**
 * listAvailableModels 的 ctx 最小子集（duck typing，不依赖完整 SDK 类型）。
 * 结构兼容 ModelPickerContext（model-picker.ts）与 ExtensionContext.modelRegistry。
 */
export interface ListAvailableModelsCtx {
	modelRegistry: {
		getAll(): Model<Api>[];
		hasConfiguredAuth(model: Model<Api>): boolean;
	};
}

// ──────────────────────── 条目类型 ────────────────────────

/**
 * 解析后的「扁平 model 条目」：附带其 provider 名。
 *
 * listAvailableModels 的中间表示，用于 picker 分组展示。
 * 注：hasApiKey 语义已不存在（E2 后用 hasConfiguredAuth 过滤，能进列表即已配 auth）；
 * E5：name/baseUrl/cost 死字段已删（picker 只读 id/api，生产零读者）。
 */
export interface ResolvedModelEntry {
	provider: string;
	id: string;
	api: string;
}

// ──────────────────────── listAvailableModels（W7 model picker 用） ────────────────────────

/**
 * 列出所有「可用」（hasConfiguredAuth 通过）的模型，按 provider 分组成 Map。
 *
 * model picker（/permission model）用：第一级选 provider，第二级选该 provider 下的 model。
 *
 * 排序规则（E2）：整体按 provider + id 字典序（cost 在 xyz-agent 环境普遍缺失，
 * 旧 cost.input 排序无语义；Map 保持插入序，字典序保证 picker 展示稳定）。
 *
 * modelRegistry 无可用模型 / 全部无 auth → 返回空 Map（不 throw，调用方据此降级为
 * 「无可选模型」提示）。
 *
 * @param ctx 含 modelRegistry 的上下文（model 列表 + auth 判定）
 * @returns Map<providerName, ResolvedModelEntry[]>
 */
export function listAvailableModels(
	ctx: ListAvailableModelsCtx,
): Map<string, ResolvedModelEntry[]> {
	const entries: ResolvedModelEntry[] = [];
	for (const m of ctx.modelRegistry.getAll()) {
		if (!ctx.modelRegistry.hasConfiguredAuth(m)) continue;
		entries.push({
			provider: m.provider,
			id: m.id,
			api: m.api,
		});
	}

	// provider + id 字典序（整体排序，Map 按插入序分组自然有序）
	entries.sort((a, b) => {
		if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});

	// 按 provider 分组
	const grouped = new Map<string, ResolvedModelEntry[]>();
	for (const entry of entries) {
		const list = grouped.get(entry.provider);
		if (list === undefined) {
			grouped.set(entry.provider, [entry]);
		} else {
			list.push(entry);
		}
	}
	return grouped;
}
