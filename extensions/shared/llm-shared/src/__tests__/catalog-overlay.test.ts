/**
 * 目录缓存判据单测（provider-catalog-sync U1，设计 §3.3 D2/D3/D4 + §3.1 R3）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect，禁 node:test）。
 * 运行命令：pnpm -C extensions/shared/llm-shared test
 *
 * 覆盖（对应任务书 §4 验收条款）：
 * - 三态判定：fresh / expired（缺字段、不晚于、含 0 否定信号）/ never-seen
 * - 新者胜：单边存在、同 id 对决双向、缺失视为最旧
 * - 保守档过滤（R3）：缺 api/baseUrl 有内置继承（注入）/ 无内置继承（跳过进 skipped）
 * - 并集计算（D2）：基线保全 + 同 id 缓存版本整对象覆盖 + 新 id 追加 + 非 fresh 退化为纯基线
 * - env 缺失 fail-safe：不抛错、落 never-seen、上层零注册
 * - D2 反向断裂防线：两份缓存各自独有的 provider 条目都进并集
 *
 * fixture 形态取自 runtime 既有测试（`packages/runtime/src/services/__tests__/
 * merged-catalog-three-state.test.ts` 的 `{ models, checkedAt, lastModified }` 条目形状）
 * 与 pi-ai 内置 catalog 实装形状，不手编与实装不符的假形态。
 *
 * 本模块零 IO，故全部用例纯内存驱动（无临时目录、无 fs 写入）；env 经 vi.stubEnv 切换。
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

import {
	computeInjectionSet,
	getCatalogGeneratedAt,
	getCatalogOverlayState,
	getPiStorePath,
	getTaijiOverlayCachePath,
	mergeEntriesNewerWins,
	parseOverlayCache,
	type OverlayEntry,
	type OverlayModel,
} from "../catalog-overlay.ts";

afterEach(() => {
	vi.unstubAllEnvs();
});

// ──────────────────────── fixture ────────────────────────

/** staleness 基准（用例内显式传入，判定与真实 manifest 时刻解耦）。 */
const GENERATED_AT = 1_000_000;
/** 晚于基准的时刻戳（fresh）。 */
const FRESH_AT = GENERATED_AT + 1;
/** 远端 404/501 落盘的否定信号时刻戳（expired）。 */
const NEGATIVE_SIGNAL_AT = 0;

const PROVIDER = "zai-coding-cn";

/** 内置基线夹具（形状对齐 pi-ai 内置 catalog 实装：id/name/api/baseUrl/type 齐备）。 */
const BASELINE: OverlayModel[] = [
	{
		id: "glm-baseline-a",
		name: "GLM Baseline A",
		api: "openai-completions",
		baseUrl: "https://open.bigmodel.cn/api/paas/v4",
		type: "chat",
		reasoning: true,
		input: ["text"],
		contextWindow: 200000,
		maxTokens: 128000,
	},
	{
		id: "glm-baseline-b",
		name: "GLM Baseline B",
		api: "openai-completions",
		baseUrl: "https://open.bigmodel.cn/api/paas/v4",
		type: "chat",
		reasoning: false,
		input: ["text"],
		contextWindow: 128000,
		maxTokens: 8192,
	},
];

/** overlay-only 新模型（自带端点声明，可注入）。 */
const OVERLAY_ONLY: OverlayModel = {
	id: "glm-overlay-only",
	name: "GLM Overlay Only",
	api: "openai-completions",
	baseUrl: "https://open.bigmodel.cn/api/paas/v4",
	type: "chat",
	reasoning: true,
	input: ["text"],
	contextWindow: 200000,
	maxTokens: 128000,
};

/** 缺端点声明的条目（R3 过滤对象）。 */
const ENDPOINT_LESS: OverlayModel = { id: "glm-endpoint-less", name: "GLM Endpoint Less", type: "chat" };

function entry(models: OverlayModel[], lastModified?: number): OverlayEntry {
	return { models, checkedAt: 1, lastModified };
}

/** taiji 自刷缓存形态（version 包装）。 */
function taijiCache(entries: Record<string, OverlayEntry>): string {
	return JSON.stringify({ version: 1, entries });
}

/** pi store 形态（顶层 providerId 分桶）。 */
function piStore(entries: Record<string, OverlayEntry>): string {
	return JSON.stringify(entries);
}

/**
 * 复刻 bridge 的判据组合（两份都读 → 新者胜 → 并集），供 D2 反向断裂防线用例驱动。
 * 这是「taiji 侧数据 → pi 注册表」判据链的完整形态，单测锁的是链本身而非单个函数。
 */
function injectAcrossBothCaches(
	providerId: string,
	taijiRaw: string | undefined,
	piRaw: string | undefined,
	baseline: OverlayModel[] = BASELINE,
): ReturnType<typeof computeInjectionSet> {
	const taiji = taijiRaw === undefined ? undefined : parseOverlayCache(taijiRaw);
	const pi = piRaw === undefined ? undefined : parseOverlayCache(piRaw);
	const merged = mergeEntriesNewerWins(
		taiji?.status === "ok" ? taiji.entries[providerId] : undefined,
		pi?.status === "ok" ? pi.entries[providerId] : undefined,
	);
	return computeInjectionSet({ providerId, entry: merged, generatedAt: GENERATED_AT, baseline });
}

// ══════════════════════════════════════════════════════════
// 路径解析（env 驱动）
// ══════════════════════════════════════════════════════════

describe("getTaijiOverlayCachePath（taiji 缓存路径，env 驱动）", () => {
	it("env 注入 → 拼到数据目录下；显式入参优先于 env", () => {
		vi.stubEnv("TAIJI_AGENT_DATA_DIR", "/data/taiji");
		expect(getTaijiOverlayCachePath()).toBe(join("/data/taiji", "provider-catalog-overlay.json"));
		expect(getTaijiOverlayCachePath("/explicit/dir")).toBe(
			join("/explicit/dir", "provider-catalog-overlay.json"),
		);
	});

	it("env 缺失 / 空串 → null（R1 非 taiji 环境：不抛错、不猜家目录）", () => {
		vi.stubEnv("TAIJI_AGENT_DATA_DIR", undefined);
		expect(getTaijiOverlayCachePath()).toBeNull();

		vi.stubEnv("TAIJI_AGENT_DATA_DIR", "");
		expect(getTaijiOverlayCachePath()).toBeNull();
	});
});

describe("getPiStorePath（pi store 路径）", () => {
	it("PI_CODING_AGENT_DIR 优先（taiji 托管形态下 runtime 注入的隔离区）", () => {
		vi.stubEnv("PI_CODING_AGENT_DIR", "/data/taiji/agent");
		expect(getPiStorePath()).toBe(join("/data/taiji/agent", "models-store.json"));
		expect(getPiStorePath("/explicit/agent")).toBe(join("/explicit/agent", "models-store.json"));
	});

	it("env 缺失 → 缺省 ~/.pi/agent（os.homedir() 动态推导，禁硬编码绝对路径）", () => {
		vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
		expect(getPiStorePath()).toBe(join(homedir(), ".pi", "agent", "models-store.json"));
	});

	it("env 空串 → 同样落缺省（空串等同未设）", () => {
		vi.stubEnv("PI_CODING_AGENT_DIR", "");
		expect(getPiStorePath()).toBe(join(homedir(), ".pi", "agent", "models-store.json"));
	});
});

describe("getCatalogGeneratedAt（staleness 基准时刻）", () => {
	it("返回 pi-ai 官方导出的正整数（manifest generatedAt，非 env 注入值）", () => {
		const generatedAt = getCatalogGeneratedAt();
		expect(Number.isInteger(generatedAt)).toBe(true);
		expect(generatedAt).toBeGreaterThan(0);
	});
});

// ══════════════════════════════════════════════════════════
// 三态判定（D3）
// ══════════════════════════════════════════════════════════

describe("getCatalogOverlayState（三态判定，缺失语义对齐 pi remoteModels）", () => {
	it("fresh：lastModified 晚于基准时刻", () => {
		expect(getCatalogOverlayState(entry([OVERLAY_ONLY], FRESH_AT), GENERATED_AT)).toBe("fresh");
	});

	it("expired：lastModified 字段缺失（对齐 pi：缺失即过期，不注入）", () => {
		expect(getCatalogOverlayState(entry([OVERLAY_ONLY]), GENERATED_AT)).toBe("expired");
	});

	it("expired：lastModified 不晚于基准（等于 / 早于 / 0 否定信号三种）", () => {
		expect(getCatalogOverlayState(entry([OVERLAY_ONLY], GENERATED_AT), GENERATED_AT)).toBe("expired");
		expect(getCatalogOverlayState(entry([OVERLAY_ONLY], GENERATED_AT - 1), GENERATED_AT)).toBe("expired");
		// 远端 404/501 落盘的否定信号（设计 §3.1 R5：不注入）
		expect(getCatalogOverlayState(entry([OVERLAY_ONLY], NEGATIVE_SIGNAL_AT), GENERATED_AT)).toBe("expired");
	});

	it("never-seen：无条目（文件缺失 / 损坏 / 该 provider 从未出现）", () => {
		expect(getCatalogOverlayState(undefined, GENERATED_AT)).toBe("never-seen");
	});
});

// ══════════════════════════════════════════════════════════
// 新者胜合并
// ══════════════════════════════════════════════════════════

describe("mergeEntriesNewerWins（条目级新者胜）", () => {
	it("单边存在 → 直接取有值一边（两份缓存各有领先窗口）", () => {
		const taiji = entry([OVERLAY_ONLY], FRESH_AT);
		const pi = entry([{ id: "glm-pi-only", name: "GLM Pi Only" }], FRESH_AT);
		expect(mergeEntriesNewerWins(taiji, undefined)).toBe(taiji);
		expect(mergeEntriesNewerWins(undefined, pi)).toBe(pi);
		expect(mergeEntriesNewerWins(undefined, undefined)).toBeUndefined();
	});

	it("同 id 对决：后者胜当且仅当更新", () => {
		const older = entry([{ id: "glm-x", name: "older" }], GENERATED_AT);
		const newer = entry([{ id: "glm-x", name: "newer" }], FRESH_AT);
		expect(mergeEntriesNewerWins(older, newer)).toBe(newer);
		expect(mergeEntriesNewerWins(newer, older)).toBe(newer);
	});

	it("lastModified 缺失视为最旧：有值方恒胜；双方都缺失平局取前者", () => {
		const withStamp = entry([{ id: "glm-x", name: "stamped" }], GENERATED_AT);
		const noStamp = entry([{ id: "glm-x", name: "unstamped" }]);
		expect(mergeEntriesNewerWins(withStamp, noStamp)).toBe(withStamp);
		expect(mergeEntriesNewerWins(noStamp, withStamp)).toBe(withStamp);
		// 平局取 a（与 runtime newerEntry 的 `>=` 逐字一致）
		expect(mergeEntriesNewerWins(noStamp, noStamp)).toBe(noStamp);
	});
});

// ══════════════════════════════════════════════════════════
// 缓存文件解析（两种形态兼容）
// ══════════════════════════════════════════════════════════

describe("parseOverlayCache（version 包装 / 顶层分桶双形态）", () => {
	it("version 包装形态（taiji 自刷缓存）", () => {
		const result = parseOverlayCache(taijiCache({ [PROVIDER]: entry([OVERLAY_ONLY], FRESH_AT) }));
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(Object.keys(result.entries)).toEqual([PROVIDER]);
		expect(result.entries[PROVIDER]?.models.map(m => m.id)).toEqual([OVERLAY_ONLY.id]);
		expect(result.entries[PROVIDER]?.lastModified).toBe(FRESH_AT);
	});

	it("顶层分桶形态（pi store）", () => {
		const result = parseOverlayCache(piStore({ [PROVIDER]: entry([OVERLAY_ONLY], FRESH_AT) }));
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.entries[PROVIDER]?.models.map(m => m.id)).toEqual([OVERLAY_ONLY.id]);
	});

	it("非法 JSON / 顶层非对象 / entries 非对象 → corrupt（调用方按 R2 记 warn）", () => {
		expect(parseOverlayCache("not-json{{").status).toBe("corrupt");
		expect(parseOverlayCache("[1,2,3]").status).toBe("corrupt");
		expect(parseOverlayCache("42").status).toBe("corrupt");
		expect(parseOverlayCache(JSON.stringify({ version: 1, entries: 7 })).status).toBe("corrupt");
	});

	it("空内容 → ok 且空 entries（对齐 pi parse 的 `content ? ... : {}`）", () => {
		expect(parseOverlayCache("")).toEqual({ status: "ok", entries: {} });
		expect(parseOverlayCache("   \n ")).toEqual({ status: "ok", entries: {} });
	});

	it("无 models 数组的条目整体剔除；models 内无字符串 id 的元素剔除", () => {
		const result = parseOverlayCache(
			piStore({
				[PROVIDER]: entry([OVERLAY_ONLY], FRESH_AT),
				"broken-provider": { checkedAt: 1, lastModified: FRESH_AT },
				"mixed-provider": { models: [OVERLAY_ONLY, { name: "no-id" }, null, 7], lastModified: FRESH_AT },
			}),
		);
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(Object.keys(result.entries).sort()).toEqual(["mixed-provider", PROVIDER].sort());
		expect(result.entries["mixed-provider"]?.models.map(m => m.id)).toEqual([OVERLAY_ONLY.id]);
	});

	it("lastModified 非数字 → undefined（该条目随后按缺失判 expired）", () => {
		const result = parseOverlayCache(piStore({ [PROVIDER]: { models: [OVERLAY_ONLY], lastModified: "999" } }));
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.entries[PROVIDER]?.lastModified).toBeUndefined();
		expect(getCatalogOverlayState(result.entries[PROVIDER], GENERATED_AT)).toBe("expired");
	});
});

// ══════════════════════════════════════════════════════════
// 并集计算（D2 注入集 + R3 保守档过滤）
// ══════════════════════════════════════════════════════════

describe("computeInjectionSet（内置基线 ⊕ 有效条目）", () => {
	it("基线保全 + 同 id 缓存版本整对象覆盖 + 新 id 追加", () => {
		const overridden: OverlayModel = { ...BASELINE[0]!, name: "GLM Baseline A (remote)", contextWindow: 999999 };
		const result = computeInjectionSet({
			providerId: PROVIDER,
			entry: entry([overridden, OVERLAY_ONLY], FRESH_AT),
			generatedAt: GENERATED_AT,
			baseline: BASELINE,
		});
		expect(result.state).toBe("fresh");
		expect(result.skipped).toEqual([]);
		// 基线两个模型都在（只注 diff 会把它们挤出视图——D2 明确不采用）
		expect(result.models.map(m => m.id)).toEqual([overridden.id, BASELINE[1]!.id, OVERLAY_ONLY.id]);
		// 同 id 取缓存版本整对象（不是字段级合并）
		expect(result.models[0]).toBe(overridden);
		expect(result.models[0]?.name).toBe("GLM Baseline A (remote)");
		expect(result.models[0]?.contextWindow).toBe(999999);
	});

	it("R3 有内置继承：缺 api/baseUrl 但同 id 有内置定义 → 照常注入，不进 skipped", () => {
		const inheritable: OverlayModel = { id: BASELINE[0]!.id, name: "GLM Baseline A (endpoint-less)" };
		const result = computeInjectionSet({
			providerId: PROVIDER,
			entry: entry([inheritable], FRESH_AT),
			generatedAt: GENERATED_AT,
			baseline: BASELINE,
		});
		expect(result.state).toBe("fresh");
		expect(result.skipped).toEqual([]);
		expect(result.models.map(m => m.id)).toEqual([inheritable.id, BASELINE[1]!.id]);
		expect(result.models[0]).toBe(inheritable);
	});

	it("R3 无内置继承：缺 api/baseUrl 且同 id 无内置定义 → 跳过进 skipped，其余照常", () => {
		const result = computeInjectionSet({
			providerId: PROVIDER,
			entry: entry([ENDPOINT_LESS, OVERLAY_ONLY], FRESH_AT),
			generatedAt: GENERATED_AT,
			baseline: BASELINE,
		});
		expect(result.state).toBe("fresh");
		expect(result.skipped).toEqual([{ modelId: ENDPOINT_LESS.id, reason: "missing-api-and-baseUrl" }]);
		expect(result.models.map(m => m.id)).toEqual([BASELINE[0]!.id, BASELINE[1]!.id, OVERLAY_ONLY.id]);
	});

	it("只认 baseUrl 也视为自带端点（api 与 baseUrl 任一即可）", () => {
		const baseUrlOnly: OverlayModel = { id: "glm-baseurl-only", name: "GLM BaseUrl Only", baseUrl: "https://x.dev/v1" };
		const result = computeInjectionSet({
			providerId: PROVIDER,
			entry: entry([baseUrlOnly], FRESH_AT),
			generatedAt: GENERATED_AT,
			baseline: BASELINE,
		});
		expect(result.skipped).toEqual([]);
		expect(result.models.map(m => m.id)).toContain(baseUrlOnly.id);
	});

	it("expired / never-seen → 纯内置基线（R5 否定信号不注入、R6 撤销注入）", () => {
		const expired = computeInjectionSet({
			providerId: PROVIDER,
			entry: entry([OVERLAY_ONLY], NEGATIVE_SIGNAL_AT),
			generatedAt: GENERATED_AT,
			baseline: BASELINE,
		});
		expect(expired.state).toBe("expired");
		expect(expired.skipped).toEqual([]);
		expect(expired.models).toEqual(BASELINE);

		const neverSeen = computeInjectionSet({
			providerId: PROVIDER,
			generatedAt: GENERATED_AT,
			baseline: BASELINE,
		});
		expect(neverSeen.state).toBe("never-seen");
		expect(neverSeen.models).toEqual(BASELINE);
	});

	it("缺省 generatedAt = getCatalogGeneratedAt()（官方导出接线）", () => {
		const generatedAt = getCatalogGeneratedAt();
		const stale = computeInjectionSet({
			providerId: PROVIDER,
			entry: entry([OVERLAY_ONLY], generatedAt),
			baseline: BASELINE,
		});
		expect(stale.state).toBe("expired");
		const fresh = computeInjectionSet({
			providerId: PROVIDER,
			entry: entry([OVERLAY_ONLY], generatedAt + 1),
			baseline: BASELINE,
		});
		expect(fresh.state).toBe("fresh");
	});

	it("缺省 baseline = getBuiltinModels(providerId)（真实 catalog 接线，非夹具）", () => {
		const builtin = getBuiltinModels("minimax-cn");
		expect(builtin.length).toBeGreaterThan(0);
		const result = computeInjectionSet({ providerId: "minimax-cn" });
		expect(result.state).toBe("never-seen");
		expect(result.models).toHaveLength(builtin.length);
		expect(result.models.every(m => typeof m.id === "string")).toBe(true);
	});

	it("未知 provider id → 空基线（getBuiltinModels 实装语义），不抛错", () => {
		const result = computeInjectionSet({ providerId: "no-such-provider", generatedAt: GENERATED_AT });
		expect(result.state).toBe("never-seen");
		expect(result.models).toEqual([]);
	});
});

// ══════════════════════════════════════════════════════════
// D2 反向断裂防线：两份缓存都读
// ══════════════════════════════════════════════════════════

describe("D2 两份缓存都读（反向断裂防线）", () => {
	it("只在 taiji 缓存出现的 provider → 进并集", () => {
		const result = injectAcrossBothCaches(
			PROVIDER,
			taijiCache({ [PROVIDER]: entry([OVERLAY_ONLY], FRESH_AT) }),
			undefined,
		);
		expect(result.state).toBe("fresh");
		expect(result.models.map(m => m.id)).toContain(OVERLAY_ONLY.id);
	});

	it("只在 pi store 出现的 provider → 进并集（链 B 领先时不得被挤出视图）", () => {
		const result = injectAcrossBothCaches(
			PROVIDER,
			undefined,
			piStore({ [PROVIDER]: entry([OVERLAY_ONLY], FRESH_AT) }),
		);
		expect(result.state).toBe("fresh");
		expect(result.models.map(m => m.id)).toContain(OVERLAY_ONLY.id);
	});

	it("两份都有 → 新者胜（pi store 更新时取 pi store 的模型集）", () => {
		const taijiOnly: OverlayModel = { id: "glm-taiji-only", name: "GLM Taiji Only", api: "openai-completions" };
		const piOnly: OverlayModel = { id: "glm-pi-only", name: "GLM Pi Only", api: "openai-completions" };
		const piNewer = injectAcrossBothCaches(
			PROVIDER,
			taijiCache({ [PROVIDER]: entry([taijiOnly], GENERATED_AT) }),
			piStore({ [PROVIDER]: entry([piOnly], FRESH_AT) }),
		);
		expect(piNewer.state).toBe("fresh");
		expect(piNewer.models.map(m => m.id)).toContain(piOnly.id);
		expect(piNewer.models.map(m => m.id)).not.toContain(taijiOnly.id);

		const taijiNewer = injectAcrossBothCaches(
			PROVIDER,
			taijiCache({ [PROVIDER]: entry([taijiOnly], FRESH_AT) }),
			piStore({ [PROVIDER]: entry([piOnly], GENERATED_AT) }),
		);
		expect(taijiNewer.models.map(m => m.id)).toContain(taijiOnly.id);
		expect(taijiNewer.models.map(m => m.id)).not.toContain(piOnly.id);
	});

	it("两份都损坏 → never-seen + 纯基线（R2：不抛错、跳过注入）", () => {
		const result = injectAcrossBothCaches(PROVIDER, "not-json{{", "also-not-json{{");
		expect(result.state).toBe("never-seen");
		expect(result.models).toEqual(BASELINE);
	});
});

// ══════════════════════════════════════════════════════════
// env 缺失 fail-safe
// ══════════════════════════════════════════════════════════

describe("env 缺失 fail-safe（R1 非 taiji 环境）", () => {
	it("TAIJI_AGENT_DATA_DIR 缺失 → 路径为 null，判据链不抛错且落 never-seen + 纯基线", () => {
		vi.stubEnv("TAIJI_AGENT_DATA_DIR", undefined);
		const cachePath = getTaijiOverlayCachePath();
		expect(cachePath).toBeNull();

		// 调用方按 R1 零注册退出：无路径 → 无条目 → never-seen → 纯基线（上层零注册）
		const entryFromMissingFile = cachePath === null ? undefined : entry([OVERLAY_ONLY], FRESH_AT);
		const result = computeInjectionSet({
			providerId: PROVIDER,
			entry: entryFromMissingFile,
			generatedAt: GENERATED_AT,
			baseline: BASELINE,
		});
		expect(result.state).toBe("never-seen");
		expect(result.models).toEqual(BASELINE);
		expect(result.skipped).toEqual([]);
	});
});

// ══════════════════════════════════════════════════════════
// 包 index 导出（验收条款 ②）
// ══════════════════════════════════════════════════════════

describe("经包 index 导出可被消费", () => {
	it("catalog-overlay 的全部导出面从 @zhushanwen/pi-llm-shared 入口可达", async () => {
		const api = await import("../index.ts");
		for (const name of [
			"getTaijiOverlayCachePath",
			"getPiStorePath",
			"getCatalogOverlayState",
			"getCatalogGeneratedAt",
			"mergeEntriesNewerWins",
			"parseOverlayCache",
			"computeInjectionSet",
		] as const) {
			expect(typeof api[name]).toBe("function");
		}
	});
});
