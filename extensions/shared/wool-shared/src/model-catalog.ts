// model-catalog.ts — 模型目录缓存/快照兜底（设计 D4；时机语义经 P7 探针核实）。
//
// P7 实装结论（pi 1.0.0 dist）：
// - refresh 两阶段：先 allowNetwork=false（离线恢复，context.stored 传回持久化目录），
//   凭据就绪后再 allowNetwork=true（带网）。扩展注册/进程启动阶段全部只走离线恢复；
//   带网刷新只发生在「登录后 / TUI 模型选择器 / 公共 ModelRegistry.refresh」。
// - legacy ProviderConfig.refreshModels 的 composer 包装只 publish {update}（内存），
//   不带 persist——跨会话持久化必须扩展自己在 refreshModels 内调
//   context.publish({ persist: entry })（落 <agentDir>/models-store.json）。
//
// 本模块承载 D4 的缓存语义：无 TTL、无后台定时轮询——清单只在事件边界
// （restore / replace）被替换；缓存命中 = 进程内已有清单且非 force 时 refreshModels
// 直接返回、不发上游请求。fetchedAt 是记录性字段，不参与任何过期判定。

import type { AnyModel, ModelsStoreEntry } from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";

/** 包内快照文件形状（家族包 snapshots/<family>.json）。models 装完整模型对象
 * （provider/baseUrl 已补全——与 pi createProvider.fetchModels 契约一致，
 * persist/快照/内存三处同型，读侧 restore 经 pi 的 withKnownModelTypes 归一化兜底）。 */
export interface WoolCatalogSnapshot { // oe-exempt:20261022:framework:包内快照文件 schema 形状——三家家族包 snapshots/<family>.json 数据文件按此落盘，读侧 readSnapshotFile/isValidSnapshot 守卫与 scaffold loadSnapshot 通道消费（workbuddy index.ts 亦经 readSnapshotFile 消费）
	family: string;
	fetchedAt: number;
	models: AnyModel[];
}

/** 目录变更来源（观测字段，不参与逻辑）。 */
export type WoolCatalogSource = "restored" | "upstream" | "snapshot" | "empty";

/** 持久化 entry 构造：persist 只装目录本体 + 采集时点（无过期语义字段）。 */
export function toPersistEntry(models: readonly AnyModel[]): ModelsStoreEntry {
	return { models: [...models], checkedAt: Date.now() };
}

export type WoolModelCatalogStore = {
	/** 进程内当前清单；undefined = 尚无任何来源提供过清单。 */
	current(): readonly AnyModel[] | undefined;
	/** refresh 阶段 1：把 pi persist 的目录恢复为当前清单（stored undefined 时保持现状并回落快照）。 */
	restore(stored: Readonly<ModelsStoreEntry> | undefined): void;
	/** 事件边界替换（带网拉取成功 / 快照回落）。 */
	replace(models: readonly AnyModel[], source: Exclude<WoolCatalogSource, "restored">): void;
	/** D4 缓存命中判定：false = 进程内已有清单且非强制，refreshModels 应直接返回。 */
	shouldFetchUpstream(force: boolean | undefined): boolean;
	/** 包内快照读入（构造时注入的 loader），无快照返回 undefined。 */
	snapshotFallback(): readonly AnyModel[] | undefined;
	/** 最近一次变更来源（观测用）。 */
	lastSource(): WoolCatalogSource;
};

/** 快照形状校验（读侧不信任外部格式）：models 必须是对象数组且条目带 id/name/api。 */
function isValidSnapshot(snapshot: unknown): snapshot is WoolCatalogSnapshot {
	if (typeof snapshot !== "object" || snapshot === null) {
		return false;
	}
	const record = snapshot as Record<string, unknown>;
	if (!Array.isArray(record.models)) {
		return false;
	}
	return record.models.every((model) => {
		if (typeof model !== "object" || model === null) {
			return false;
		}
		const entry = model as Record<string, unknown>;
		return typeof entry.id === "string" && typeof entry.name === "string" && typeof entry.api === "string";
	});
}

export function createModelCatalogStore(
	options: {
		/** 包内快照 loader（家族包提供：读 snapshots/<family>.json）。不传 = 无快照兜底。 */
		loadSnapshot?: () => WoolCatalogSnapshot | undefined;
		/** 快照形状拒绝时的上抛通道；缺省静默跳过（快照是兜底路径，坏快照不该炸正常刷新）。 */
		onSnapshotInvalid?: (reason: string) => void;
	} = {},
): WoolModelCatalogStore {
	let currentModels: readonly AnyModel[] | undefined;
	let source: WoolCatalogSource = "empty";

	const store: WoolModelCatalogStore = {
		current: () => currentModels,
		restore(stored) {
			if (stored && Array.isArray(stored.models) && stored.models.length > 0) {
				currentModels = stored.models;
				source = "restored";
				return;
			}
			// persist 无内容（首装/离线首启）：回落包内快照兜底（D4 三层承载位之第三层）。
			if (currentModels === undefined) {
				const snapshot = options.loadSnapshot?.();
				if (snapshot !== undefined) {
					if (!isValidSnapshot(snapshot)) {
						options.onSnapshotInvalid?.("snapshot file failed shape check");
						currentModels = [];
					} else {
						currentModels = snapshot.models;
					}
					source = "snapshot";
					return;
				}
				currentModels = [];
			}
			source = currentModels.length > 0 ? source : "empty";
		},
		replace(models, nextSource) {
			currentModels = [...models];
			source = nextSource;
		},
		shouldFetchUpstream(force) {
			if (force === true) {
				return true;
			}
			const existing = currentModels;
			return existing === undefined || existing.length === 0;
		},
		snapshotFallback() {
			const snapshot = options.loadSnapshot?.();
			if (snapshot === undefined) {
				return undefined;
			}
			if (!isValidSnapshot(snapshot)) {
				options.onSnapshotInvalid?.("snapshot file failed shape check");
				return undefined;
			}
			return snapshot.models;
		},
		lastSource: () => source,
	};
	return store;
}

/**
 * 读包内快照文件（家族包在自身资源目录内放置 snapshots/<family>.json 后，
 * 以 import.meta.dirname 拼接绝对路径传入——资源自包含约定，禁止外部绝对路径）。
 * 文件缺失/损坏返回 undefined（兜底路径静默降级，不炸正常链路）。
 */
export function readSnapshotFile(filePath: string): WoolCatalogSnapshot | undefined {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		return isValidSnapshot(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}
