import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { isThinkingLevel, normalizeModelSelector, parseModelRef, resolveModel } from "../resolve.ts";

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

describe("isThinkingLevel（V2 七值钉值，与 pi-ai ModelThinkingLevel 联合一致）", () => {
	it.each(["off", "minimal", "low", "medium", "high", "xhigh", "max"])(
		"合法值 %j → true",
		(level) => {
			expect(isThinkingLevel(level)).toBe(true);
		},
	);

	it.each([
		["未知档位 ultra", "ultra"],
		["空串", ""],
		["大小写不符 OFF", "OFF"],
		["undefined", undefined],
		["null", null],
		["数字", 1],
		["对象", {}],
		["数组（元素为合法值也不接受）", ["high"]],
	])("非法值 %s → false", (_label, raw) => {
		expect(isThinkingLevel(raw)).toBe(false);
	});

	it("类型收窄：合法值通过谓词后可赋给 ModelThinkingLevel", () => {
		const raw: unknown = "xhigh";
		if (isThinkingLevel(raw)) {
			const narrowed: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" = raw;
			expect(narrowed).toBe("xhigh");
		} else {
			throw new Error("xhigh 应通过谓词");
		}
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
