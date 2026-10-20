/**
 * 目录缓存判据（provider-catalog-sync U1）——taiji 目录缓存与 pi store 两份缓存文件的
 * 解析、条目级新者胜合并、三态判定与注入集并集计算的纯函数实现。
 *
 * 落点依据（设计 §3.3 D4）：判据复刻进 llm-shared，runtime 侧
 * `packages/runtime/src/services/provider-catalog-refresh.ts` 的
 * `getCatalogOverlayState`/`newerEntry`/`getCatalogGeneratedAt` 保持现状不动。两份判据是
 * 真差异（staleness 基准来源不同：runtime = taiji 编译期快照字段；本模块 = pi-ai 运行时
 * 官方导出），不是可合并的重复实现；两侧单测描述同一行为语义。
 *
 * 本模块零 IO、零副作用：路径只做字符串拼接，文件读取与日志由调用方（provider-live-sync
 * 的 catalog-bridge）承担——R2 的「缺失记 debug / 损坏记 warn」分级与 R7 的钩子运行期
 * fail-safe 都在调用方。
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { getBuiltinModelDataGeneratedAt, getBuiltinModels, type BuiltinProvider } from "@earendil-works/pi-ai/providers/all";
import { isRecord } from "@zhushanwen/pi-ext-guards";

// ──────────────────────── 路径解析 ────────────────────────

/** taiji 数据目录 env（runtime spawn pi 时注入；缺失 = 非 taiji 托管环境）。 */
const TAIJI_DATA_DIR_ENV = "TAIJI_AGENT_DATA_DIR";
/** pi agent 目录 env（pi 上游 `ENV_AGENT_DIR` 实装值）。 */
const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
/** taiji 自刷目录缓存文件名（写入方 = runtime `provider-catalog-refresh.ts`）。 */
const OVERLAY_CACHE_FILENAME = "provider-catalog-overlay.json";
/** pi store 文件名（写入方 = pi 进程自身，`FileModelsStore`）。 */
const MODELS_STORE_FILENAME = "models-store.json";
/** pi 配置目录名（pi 上游 `CONFIG_DIR_NAME` = `pkg.piConfig.configDir`，实装值 `.pi`）。 */
const PI_CONFIG_DIR_NAME = ".pi";

/** 取非空字符串 env / 显式入参；空串与缺失一视同仁（env 设成空串等同未设）。 */
function nonEmpty(value: string | undefined): string | undefined {
	return value !== undefined && value !== "" ? value : undefined;
}

/**
 * taiji 目录缓存绝对路径；`TAIJI_AGENT_DATA_DIR` 缺失 → null（调用方按 R1 零注册退出）。
 *
 * fail-safe 口径（设计 §3.1 env 缺失条款）：缺失时不抛错、不回退到家目录猜测——返回 null
 * 让调用方走「非 taiji 环境」分支，该 provider 自然落 never-seen、上层零注册。
 */
export function getTaijiOverlayCachePath(dataDir?: string): string | null {
	const dir = nonEmpty(dataDir ?? process.env[TAIJI_DATA_DIR_ENV]);
	return dir === undefined ? null : join(dir, OVERLAY_CACHE_FILENAME);
}

/**
 * pi store 绝对路径：env `PI_CODING_AGENT_DIR` 优先（taiji 托管形态下 runtime 注入的
 * 隔离区 `<dataDir>/agent`，见 `packages/runtime/src/infra/pi/rpc-client.ts` 的
 * `buildPiOutboundEnv`），缺省 = `~/.pi/agent`（os.homedir() 动态推导，禁硬编码绝对路径）。
 *
 * 与 runtime 侧「只读 `<getPiAgentDir()>` 隔离区、禁止触碰用户全局 `~/.pi/agent`」铁律
 * 一致：托管形态下 env 恒被注入，家目录缺省只在原生 pi 用户场景生效。
 */
export function getPiStorePath(agentDir?: string): string | null {
	const fromEnv = nonEmpty(agentDir ?? process.env[PI_AGENT_DIR_ENV]);
	if (fromEnv !== undefined) return join(fromEnv, MODELS_STORE_FILENAME);
	const home = nonEmpty(homedir());
	return home === undefined ? null : join(home, PI_CONFIG_DIR_NAME, "agent", MODELS_STORE_FILENAME);
}

// ──────────────────────── 三态判定 ────────────────────────

/**
 * 目录缓存条目的三态（设计 §3.1 D5 语义，扩展侧判定）：
 * - fresh：见过且比内置 catalog 数据新 → 条目模型进注入集
 * - expired：见过但过期（含远端 404/501 落盘的 lastModified:0 否定信号）→ 不注入
 * - never-seen：无条目（文件缺失/损坏/该 provider 从未出现）→ 不注入
 */
export type CatalogOverlayState = "fresh" | "expired" | "never-seen";

/**
 * 三态判定。缺失语义逐字对齐 pi `remoteModels`（`dist/core/remote-catalog-provider.js`：
 * `localGeneratedAt !== undefined && (entry.lastModified === undefined ||
 * entry.lastModified <= localGeneratedAt)` → 返回空）：`lastModified` 缺失**或不晚于**基准
 * 时刻 → expired；晚于 → fresh；无条目 → never-seen。
 *
 * 与 runtime 侧 `getCatalogOverlayState` 的差异是有意的（设计 §3.3 D3）：runtime 对缺失
 * 跳过检查（视为 fresh），本判据的裁决对象是「执行可见性」，执行侧权威是 pi 的判定。
 */
export function getCatalogOverlayState(
	entry: { lastModified?: number } | undefined,
	generatedAt: number,
): CatalogOverlayState {
	if (entry === undefined) return "never-seen";
	if (entry.lastModified === undefined || entry.lastModified <= generatedAt) return "expired";
	return "fresh";
}

/**
 * staleness 基准时刻 = pi-ai 官方导出 `getBuiltinModelDataGeneratedAt()`（设计 §3.3 D3：
 * 不经 env 注入 taiji 侧值，与 pi 执行侧 `withRemoteCatalog` 的时刻锚同源）。
 *
 * 官方导出签名是 `number | undefined`（manifest 无 generatedAt 或值非法时）。契约冻结返回
 * `number`，故 undefined 回落 0：该分支下 lastModified:0（远端 404/501 的否定信号）判
 * expired，其余真实时刻戳判 fresh。与 pi 的 undefined 锚行为有差异——pi 在锚为 undefined
 * 时完全不做 staleness 过滤（否定信号条目也放行）；取保守档的理由是 R5「否定信号不注入」。
 */
export function getCatalogGeneratedAt(): number {
	return getBuiltinModelDataGeneratedAt() ?? 0;
}

// ──────────────────────── 新者胜合并 ────────────────────────

/** `lastModified` 缺失时的哨兵值（与 runtime `newerEntry` 同值：缺失视为最旧）。 */
const OLDEST_LASTMODIFIED = -1;

/**
 * 两份缓存条目级新者胜合并（`lastModified` 缺失视为最旧；同 id 后者胜当且仅当更新）。
 *
 * 语义与 runtime `newerEntry` 逐字一致（含 `>=` 的平局取 a）：两份缓存各有领先窗口，
 * 任一份独有模型若不在注入集内会被挤出视图（设计 §3.3 D2），故两份都读、缺一不可。
 */
export function mergeEntriesNewerWins<T extends { lastModified?: number }>(
	a: T | undefined,
	b: T | undefined,
): T | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return (a.lastModified ?? OLDEST_LASTMODIFIED) >= (b.lastModified ?? OLDEST_LASTMODIFIED) ? a : b;
}

// ──────────────────────── 缓存文件解析 ────────────────────────

/**
 * 注入集元素的结构上界：内置基线（pi-ai `Model`）与缓存条目（JSON 解析出的宽松形状）的
 * 共同可读面。元素按引用透传（不重建对象），上游多余字段运行时保留、只是不在本类型声明。
 */
export type OverlayModel = {
	id: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	type?: string;
	reasoning?: boolean;
	input?: string[];
	cost?: unknown;
	compat?: unknown;
	contextWindow?: number;
	maxTokens?: number | null;
	thinkingLevelMap?: unknown;
};

/** 目录缓存条目（pi.dev 返回形状的宽松子集）。 */
export type OverlayEntry = {
	models: OverlayModel[];
	checkedAt?: number;
	lastModified?: number;
	etag?: string;
};

/**
 * 缓存文件解析结果。`corrupt` = 文件存在但内容非法（调用方按 R2 记 warn 并跳过注入）；
 * `ok` 的 entries 已剔除无 `models` 数组的条目（该 provider 自然落 never-seen）。
 */
export type ParseResult =
	| { status: "ok"; entries: Record<string, OverlayEntry> }
	| { status: "corrupt" };

/**
 * 解析单份缓存文件内容（version 包装 / 顶层 providerId 分桶两种形态兼容）。
 *
 * 形态依据（禁凭猜测，均读实装后照写）：
 * - taiji 自刷缓存 = `{ version, entries }`（`packages/runtime/src/services/provider-catalog-refresh.ts`
 *   的 `persistOwnCache`）
 * - pi store = 顶层 providerId 分桶（`node_modules/@earendil-works/pi-coding-agent/dist/core/models-store.js`
 *   的 `parse` = `JSON.parse(stripBom(content))`，空内容 → `{}`）
 *
 * 兼容取法 = runtime `parseCacheFile` 的 `parsed.entries ?? parsed`：带 `entries` 键取内层，
 * 否则整个对象即分桶表。无 `models` 数组的条目直接剔除——该 provider 自然落 never-seen，
 * 与 runtime 同口径（`if (Array.isArray(e?.models)) out[id] = ...`）。
 */
export function parseOverlayCache(raw: string): ParseResult {
	// 空内容对齐 pi `parse` 的 `content ? ... : {}`：空 store 是合法形态，不是损坏
	if (raw.trim() === "") return { status: "ok", entries: {} };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { status: "corrupt" };
	}
	if (!isRecord(parsed)) return { status: "corrupt" };
	const buckets: unknown = parsed.entries ?? parsed;
	if (!isRecord(buckets)) return { status: "corrupt" };
	const entries: Record<string, OverlayEntry> = {};
	for (const [providerId, value] of Object.entries(buckets)) {
		if (!isRecord(value)) continue;
		const models = toModelArray(value.models);
		if (models === undefined) continue;
		entries[providerId] = {
			models,
			checkedAt: numberOrUndefined(value.checkedAt),
			lastModified: numberOrUndefined(value.lastModified),
			etag: typeof value.etag === "string" ? value.etag : undefined,
		};
	}
	return { status: "ok", entries };
}

/** 取数字字段；非数字（含字符串型时间戳）→ undefined，该条目随后按「缺失」判 expired。 */
function numberOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

/**
 * 缓存条目的 models 数组归一：非数组 → undefined（条目整体剔除）；数组内剔除非对象与
 * 无字符串 `id` 的元素（与 runtime `parseCacheFile` 同口径）。元素按引用透传，上游多余
 * 字段运行时保留。
 */
function toModelArray(value: unknown): OverlayModel[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items: unknown[] = value;
	const models: OverlayModel[] = [];
	for (const item of items) {
		// guard 已核 `id` 为字符串；OverlayModel 其余字段全可选，故断言不引入未校验假设
		if (isRecord(item) && typeof item.id === "string") models.push(item as OverlayModel);
	}
	return models;
}

// ──────────────────────── 并集计算 ────────────────────────

/** R3 保守档过滤跳过的条目（调用方据此记 warn 级日志）。 */
export type SkippedModel = { modelId: string; reason: "missing-api-and-baseUrl" };

export type ComputeInjectionSetInput = {
	providerId: string;
	/** 两份缓存新者胜合并后的有效条目；undefined = never-seen。 */
	entry?: OverlayEntry;
	/** staleness 基准时刻（缺省 = `getCatalogGeneratedAt()`）。 */
	generatedAt?: number;
	/** 内置基线覆盖（测试注入点；生产缺省 = `getBuiltinModels(providerId)`）。 */
	baseline?: OverlayModel[];
};

export type ComputeInjectionSetResult = {
	/** 注入集（内置基线 ⊕ 有效条目，同 id 覆盖、数组内去重）。 */
	models: OverlayModel[];
	/** 本次判定的三态（调用方按 R5 记 debug / 按 R6 撤销注入）。 */
	state: CatalogOverlayState;
	/** R3 跳过的条目（缺 `api`/`baseUrl` 且同 id 无内置定义可继承）。 */
	skipped: SkippedModel[];
};

/**
 * 并集计算（设计 §3.3 D2）：内置快照基线 ⊕ 有效条目。同 id 缓存版本整对象替换基线版本，
 * 数组内去重；fresh 条目中缺 `api`/`baseUrl` 且同 id 无内置模型可继承 → 跳过并进 skipped
 * （R3 保守档：只认同 id 继承，不从任意同 provider 模型继承）。
 *
 * 非 fresh 态（expired / never-seen）返回纯内置基线——R5「否定信号不注入」与 R6「运行中
 * 撤销注入」由此构造性成立。
 *
 * 去重键取 `model.id`（D2/D0 契约措辞「同 id 覆盖」）。pi `mergeModels` 的键是
 * `type\0id`，此处未复刻复合键：同一 provider 目录内 id 即条目身份，且复合键需对宽松
 * JSON 条目调 `getModelType(model: AnyModel)`（类型不兼容，要加断言）。
 */
export function computeInjectionSet(input: ComputeInjectionSetInput): ComputeInjectionSetResult {
	const { providerId, entry } = input;
	const generatedAt = input.generatedAt ?? getCatalogGeneratedAt();
	const state = getCatalogOverlayState(entry, generatedAt);
	const baseline = input.baseline ?? loadBuiltinBaseline(providerId);
	const skipped: SkippedModel[] = [];
	if (state !== "fresh" || entry === undefined) {
		return { models: [...baseline], state, skipped };
	}
	const byId = new Map<string, OverlayModel>(baseline.map(model => [model.id, model]));
	for (const model of entry.models) {
		// R3：缺 api/baseUrl 且同 id 无内置定义可继承 → 跳过（pi 实为四级兜底，本设计取最保守档）
		if (!hasEndpoint(model) && !byId.has(model.id)) {
			skipped.push({ modelId: model.id, reason: "missing-api-and-baseUrl" });
			continue;
		}
		byId.set(model.id, model);
	}
	return { models: [...byId.values()], state, skipped };
}

/** 内置基线（pi-ai 官方 catalog）。未知 provider id → 空数组（`getBuiltinModels` 实装语义）。 */
function loadBuiltinBaseline(providerId: string): OverlayModel[] {
	// providerId 来自缓存文件键（运行时字符串），泛型形参只能靠断言收窄；实装对未知键返回 []
	return getBuiltinModels(providerId as BuiltinProvider);
}

/** 条目是否自带端点声明（`api` 与 `baseUrl` 至少其一）。 */
function hasEndpoint(model: OverlayModel): boolean {
	return model.api !== undefined || model.baseUrl !== undefined;
}
