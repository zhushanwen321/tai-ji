/**
 * MRT 系列：model-resolver.ts 单元测试（picker 相关 API）。
 *
 * E2（CL-picker-scope 收口）后 listAvailableModels 改走 ctx.modelRegistry.getAll() +
 * hasConfiguredAuth() 过滤（不再读 models.json），loadModelsJson / flattenModels 已删除。
 * E1：ResolvedModelEntry.apiKey / hasApiKey 已删。
 *
 * 本测试覆盖：
 *  - MRT1: listAvailableModels 走 modelRegistry（TC8：OAuth provider 可见 + hasConfiguredAuth 负向剔除）
 *  - MRT2: 排序 provider+id 字典序（TC9，不再按 cost.input）
 *  - MRT3: E1 零残留断言（TC7：源码无 apiKey 定义/填充）
 *
 * mock 策略：mock ctx.modelRegistry（getAll + hasConfiguredAuth），不触达真实 registry。
 */
import { readFileSync } from "node:fs";

import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { listAvailableModels } from "../model-resolver.js";

// ──────────────────────── fixtures ────────────────────────

function makeModel(provider: string, id: string, over: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions" as Api,
		provider,
		baseUrl: "",
		reasoning: false,
		...over,
	} as Model<Api>;
}

/** 构造 mock ctx：getAll 返回给定模型，hasConfiguredAuth 按 provider 白名单判定。 */
function makeMockCtx(
	models: Model<Api>[],
	authProviders: string[],
): { modelRegistry: { getAll(): Model<Api>[]; hasConfiguredAuth(m: Model<Api>): boolean } } {
	return {
		modelRegistry: {
			getAll: vi.fn(() => models),
			hasConfiguredAuth: vi.fn((m: Model<Api>) => authProviders.includes(m.provider)),
		},
	};
}

/** 两条同 provider 模型：cost 逆序（旧排序会倒过来），验证字典序不受 cost 影响 */
const TWO_COST_MODELS = [
	makeModel("co", "expensive", { cost: { input: 1.0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
	makeModel("co", "cheap", { cost: { input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0 } }),
];

// ──────────────────────── MRT1: modelRegistry 数据源（TC8） ────────────────────────

describe("MRT1: listAvailableModels 走 modelRegistry（TC8）", () => {
	it("OAuth provider 模型可见：hasConfiguredAuth 通过 → 进 Map（不再读 models.json）", () => {
		// 用户只经 pi auth login 配了官方 provider（模型来自 registry 内置 catalog）
		const ctx = makeMockCtx(
			[makeModel("anthropic", "claude-sonnet-4"), makeModel("anthropic", "claude-haiku")],
			["anthropic"],
		);
		const map = listAvailableModels(ctx);
		const models = map.get("anthropic") ?? [];
		expect(models.map((m) => m.id)).toEqual(["claude-haiku", "claude-sonnet-4"]);
		// hasConfiguredAuth 被调用（过滤依赖它）
		expect(ctx.modelRegistry.hasConfiguredAuth).toHaveBeenCalled();
	});

	it("hasConfiguredAuth 负向：无 auth 的 provider 被剔除（不进 Map）", () => {
		const ctx = makeMockCtx(
			[makeModel("auth-co", "m1"), makeModel("noauth-co", "m2")],
			["auth-co"], // 只有 auth-co 配了 auth
		);
		const map = listAvailableModels(ctx);
		expect(map.has("auth-co")).toBe(true);
		expect(map.has("noauth-co")).toBe(false); // 无 auth 剔除
	});

	it("registry 空 → 空 Map（不 throw，调用方降级「无可选模型」）", () => {
		const ctx = makeMockCtx([], []);
		const map = listAvailableModels(ctx);
		expect(map.size).toBe(0);
	});

	it("entry 不含 apiKey/hasApiKey 字段（E1 死字段已删）", () => {
		const ctx = makeMockCtx([makeModel("co", "m1")], ["co"]);
		const map = listAvailableModels(ctx);
		const entry = map.get("co")?.[0];
		expect(entry).toBeDefined();
		expect("apiKey" in (entry as object)).toBe(false);
		expect("hasApiKey" in (entry as object)).toBe(false);
		// 基础字段齐全
		expect(entry?.provider).toBe("co");
		expect(entry?.id).toBe("m1");
		expect(entry?.api).toBe("openai-completions");
	});
});

// ──────────────────────── MRT2: 排序（TC9） ────────────────────────

describe("MRT2: 排序 provider+id 字典序（TC9，不再按 cost.input）", () => {
	it("provider 内 model 按 id 字典序（cost 逆序也不影响）", () => {
		const ctx = makeMockCtx(TWO_COST_MODELS, ["co"]);
		const map = listAvailableModels(ctx);
		const models = map.get("co") ?? [];
		// 旧实现按 cost.input 升序 → expensive(1.0) 在 cheap(0.1) 后；
		// 新实现按 id 字典序 → cheap < expensive（字母序），与 cost 无关
		expect(models.map((m) => m.id)).toEqual(["cheap", "expensive"]);
	});

	it("provider 间按字母序（Map 插入序）", () => {
		const ctx = makeMockCtx(
			[makeModel("zebra-co", "m1"), makeModel("alpha-co", "m2")],
			["zebra-co", "alpha-co"],
		);
		const map = listAvailableModels(ctx);
		expect([...map.keys()]).toEqual(["alpha-co", "zebra-co"]);
	});

	it("全量排序：多 provider 多 model 整体 provider+id 字典序", () => {
		const ctx = makeMockCtx(
			[
				makeModel("zebra-co", "b-model"),
				makeModel("alpha-co", "z-model"),
				makeModel("alpha-co", "a-model"),
			],
			["zebra-co", "alpha-co"],
		);
		const map = listAvailableModels(ctx);
		expect([...map.keys()]).toEqual(["alpha-co", "zebra-co"]);
		expect(map.get("alpha-co")?.map((m) => m.id)).toEqual(["a-model", "z-model"]);
		expect(map.get("zebra-co")?.map((m) => m.id)).toEqual(["b-model"]);
	});
});

// ──────────────────────── MRT3: E1 零残留（TC7） ────────────────────────

describe("MRT3: E1 apiKey 死字段零残留（TC7）", () => {
	it("model-resolver.ts 源码无 apiKey / hasApiKey 字段定义与填充", () => {
		const source = readFileSync(new URL("../model-resolver.ts", import.meta.url), "utf-8");
		// 匹配字段定义/填充形式（注释里的历史描述不算残留）
		expect(source).not.toMatch(/apiKey\??\s*:/);
		expect(source).not.toMatch(/hasApiKey\s*:/);
		expect(source).not.toMatch(/loadModelsJson\s*\(/);
		expect(source).not.toMatch(/flattenModels\s*\(/);
	});
});
