import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { normalizeModelSelector, normalizeThinkingLevel, parseModelRef, resolveModel } from "../resolve.ts";

/** 构造最小 Model（cast 绕过必填字段，单测只关心 provider/id）。 */
function makeModel(provider: string, id: string): Model<Api> {
	return { id, provider, name: id, api: "anthropic" as Api, baseUrl: "", reasoning: false } as unknown as Model<Api>;
}

/** 构造 mock ExtensionContext（只填 modelRegistry 的 resolveModel 依赖的方法）。 */
function makeCtx(registry: {
	find?: (provider: string, modelId: string) => Model<Api> | undefined;
	hasConfiguredAuth?: (model: Model<Api>) => boolean;
}): ExtensionContext {
	return {
		modelRegistry: {
			find: vi.fn(registry.find ?? (() => undefined)),
			hasConfiguredAuth: vi.fn(registry.hasConfiguredAuth ?? (() => false)),
			getApiKeyAndHeaders: vi.fn(),
		},
	} as unknown as ExtensionContext;
}

describe("resolveModel（仅 ref 精确指定）", () => {
	it("find 命中 + hasConfiguredAuth → 返回 model", () => {
		const m = makeModel("deepseek-router", "deepseek-chat");
		const ctx = makeCtx({ find: () => m, hasConfiguredAuth: () => true });
		expect(resolveModel(ctx, { type: "ref", ref: "deepseek-router/deepseek-chat" })).toBe(m);
	});

	it("find 命中但 hasConfiguredAuth=false → null", () => {
		const m = makeModel("a", "1");
		const ctx = makeCtx({ find: () => m, hasConfiguredAuth: () => false });
		expect(resolveModel(ctx, { type: "ref", ref: "a/1" })).toBeNull();
	});

	it("find 未命中（undefined）→ null（静默降级不抛错）", () => {
		const ctx = makeCtx({ find: () => undefined, hasConfiguredAuth: () => true });
		expect(resolveModel(ctx, { type: "ref", ref: "x/9" })).toBeNull();
	});

	it("ref 无 '/'（如 'abc'）→ null，不调 find", () => {
		const find = vi.fn((_provider: string, _modelId: string): Model<Api> | undefined => undefined);
		const ctx = makeCtx({ find, hasConfiguredAuth: () => true });
		expect(resolveModel(ctx, { type: "ref", ref: "abc" })).toBeNull();
		expect(find).not.toHaveBeenCalled();
	});

	it("ref 以 '/' 开头（如 '/model'）→ null，不调 find", () => {
		const find = vi.fn((_provider: string, _modelId: string): Model<Api> | undefined => undefined);
		const ctx = makeCtx({ find, hasConfiguredAuth: () => true });
		expect(resolveModel(ctx, { type: "ref", ref: "/model" })).toBeNull();
		expect(find).not.toHaveBeenCalled();
	});

	it("ref 以 '/' 结尾（如 'provider/'）→ null，不调 find", () => {
		const find = vi.fn((_provider: string, _modelId: string): Model<Api> | undefined => undefined);
		const ctx = makeCtx({ find, hasConfiguredAuth: () => true });
		expect(resolveModel(ctx, { type: "ref", ref: "provider/" })).toBeNull();
		expect(find).not.toHaveBeenCalled();
	});
});

describe("normalizeThinkingLevel（配置值归一：不自持词表）", () => {
	it("非空字符串原样返回（含词表外值——合法性归写入侧 UI 与 pi）", () => {
		for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]) {
			expect(normalizeThinkingLevel(level)).toBe(level);
		}
	});

	it.each([
		["空串", ""],
		["undefined", undefined],
		["null", null],
		["数字", 1],
		["对象", {}],
		["数组", ["high"]],
	])("%s → undefined（调用方落自己的缺省）", (_label, raw) => {
		expect(normalizeThinkingLevel(raw)).toBeUndefined();
	});
});

describe("parseModelRef（V2 五形态钉值，ext-simplify-18 D4）", () => {
	it("合法 ref → {provider, modelId}", () => {
		expect(parseModelRef("anthropic/claude-5.3")).toEqual({ provider: "anthropic", modelId: "claude-5.3" });
	});

	it("缺斜杠（'foo'）→ null", () => {
		expect(parseModelRef("foo")).toBeNull();
	});

	it("尾空 modelId（'provider/'）→ null", () => {
		expect(parseModelRef("provider/")).toBeNull();
	});

	it("首空 provider（'/model'）→ null", () => {
		expect(parseModelRef("/model")).toBeNull();
	});

	it("modelId 含斜杠（'a/b/c'）→ 取首个 / 分隔 → {provider:'a', modelId:'b/c'}", () => {
		expect(parseModelRef("a/b/c")).toEqual({ provider: "a", modelId: "b/c" });
	});
});

describe("normalizeModelSelector", () => {
	it("合法 ref selector → 通过（仅取 type/ref 两字段）", () => {
		expect(normalizeModelSelector({ type: "ref", ref: "deepseek-router/deepseek-chat" })).toEqual({
			type: "ref",
			ref: "deepseek-router/deepseek-chat",
		});
	});

	it("多余字段不透传（构造干净对象）", () => {
		expect(normalizeModelSelector({ type: "ref", ref: "a/b", extra: 1 })).toEqual({
			type: "ref",
			ref: "a/b",
		});
	});

	it.each([
		["字符串", "ref"],
		["数字", 42],
		["null", null],
		["undefined", undefined],
		["数组", [{ type: "ref", ref: "a/b" }]],
		["type 非 ref", { type: "available" }],
		["ref 非字符串", { type: "ref", ref: 123 }],
		["缺 ref", { type: "ref" }],
		["空对象", {}],
	])("%s → null", (_label, raw) => {
		expect(normalizeModelSelector(raw)).toBeNull();
	});
});
