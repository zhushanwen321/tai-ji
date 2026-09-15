// model-list-injector 单测
//
// 覆盖（与 workflow-list-injector.test.ts 对称，但本 injector 无文件发现/模块级
// 缓存，纯函数比重更大）：
// 1. formatModelList：排序稳定性（registry 返回顺序不保证，输出必须字节稳定）、
//    caps 推导（reasoning/vision）、空 caps 省略、XML 转义、空列表不注入
// 2. setupModelListInjector handler：注入 append、空列表返回 undefined、
//    registry 异常不阻断（fail-safe）

import { describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// C5①：formatModelList + ModelEntry 口径下沉 core barrel——测试改从 barrel 取实现，
// guide 用 pi 宿主注入文案
import { formatModelList, type ModelEntry } from "@zhushanwen/subagent-core";
import { MODEL_LIST_GUIDE } from "../model-list-injector";

// ── 测试数据工厂 ────────────────────────────────────────

function entry(overrides: Partial<ModelEntry> = {}): ModelEntry {
	return {
		provider: "zai-coding-cn",
		id: "glm-5.2",
		name: "GLM 5.2",
		reasoning: true,
		input: ["text"],
		contextWindow: 200_000,
		...overrides,
	};
}

// ── 纯函数：formatModelList ─────────────────────────────

describe("formatModelList", () => {
	it("空列表返回空串（不注入）", () => {
		expect(formatModelList([], { guide: MODEL_LIST_GUIDE })).toBe("");
	});

	it("渲染 provider/modelId + name + caps + contextWindow", () => {
		const out = formatModelList([
			entry({ provider: "p1", id: "m1", name: "Model One" }),
		], { guide: MODEL_LIST_GUIDE });
		expect(out).toContain("<available_provider_models>");
		expect(out).toContain("<model><id>p1/m1</id><name>Model One</name><caps>reasoning</caps><contextWindow>200000</contextWindow></model>");
		expect(out).toContain("</available_provider_models>");
	});

	it("input 含 image 时 caps 加 vision；无能力时省略 caps 段", () => {
		const out = formatModelList([
			entry({ id: "vision-m", input: ["text", "image"] }),
			entry({ id: "plain-m", reasoning: false }),
		], { guide: MODEL_LIST_GUIDE });
		expect(out).toContain("<id>zai-coding-cn/vision-m</id>");
		expect(out).toContain("<caps>reasoning,vision</caps>");
		// plain-m：reasoning=false 且无 image → 无 caps 段
		expect(out).toMatch(/<id>zai-coding-cn\/plain-m<\/id><name>[^<]*<\/name><contextWindow>/);
	});

	it("按 (provider, id) 排序——输入乱序输出仍字节稳定（KV cache 前提）", () => {
		const models = [
			entry({ provider: "b-prov", id: "z-model" }),
			entry({ provider: "a-prov", id: "y-model" }),
			entry({ provider: "a-prov", id: "x-model" }),
		];
		const out1 = formatModelList([...models], { guide: MODEL_LIST_GUIDE });
		const out2 = formatModelList([...models].reverse(), { guide: MODEL_LIST_GUIDE });
		expect(out1).toBe(out2);
		// 排序断言：a-prov/x-model 在最前，b-prov 在最后
		const ids = [...out1.matchAll(/<id>([^<]+)<\/id>/g)].map((m) => m[1]);
		expect(ids).toEqual(["a-prov/x-model", "a-prov/y-model", "b-prov/z-model"]);
	});

	it("排序为码点序而非 locale 序（跨环境字节一致契约，禁 localeCompare）", () => {
		// 判别样本：码点序 "B"(0x42) < "a"(0x61)，而多数 locale 的 localeCompare
		// 会把 "a-model" 排在 "B-model" 前——本断言在 localeCompare 实现下必挂
		const out = formatModelList([
			entry({ provider: "p", id: "a-model" }),
			entry({ provider: "p", id: "B-model" }),
		], { guide: MODEL_LIST_GUIDE });
		const ids = [...out.matchAll(/<id>([^<]+)<\/id>/g)].map((m) => m[1]);
		expect(ids).toEqual(["p/B-model", "p/a-model"]);
	});

	it("name 含 XML 特殊字符时转义（防注入段结构破坏）", () => {
		const out = formatModelList([
			entry({ provider: "p", id: "m", name: `A<&>"'B` }),
		], { guide: MODEL_LIST_GUIDE });
		expect(out).toContain("<name>A&lt;&amp;&gt;&quot;&apos;B</name>");
	});
});

// ── handler 行为：setupModelListInjector ────────────────

describe("setupModelListInjector", () => {
	type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

	async function setupWithRegistry(models: ModelEntry[], fail = false): Promise<Handler> {
		const mod = await import("../model-list-injector"); // handler 注册面（含 MODEL_LIST_GUIDE 注入）
		const handlers: Record<string, Handler> = {};
		const pi = {
			on: (name: string, fn: Handler) => {
				handlers[name] = fn;
			},
		} as unknown as ExtensionAPI;
		mod.setupModelListInjector(pi);
		const registry = fail
			? { getAvailable: vi.fn(() => { throw new Error("registry boom"); }) }
			: { getAvailable: vi.fn(() => models) };
		const handler = handlers["before_agent_start"];
		if (!handler) throw new Error("before_agent_start handler not registered");
		return (event: unknown) => handler(event, { modelRegistry: registry });
	}

	it("注册 before_agent_start handler，注入 append 到 systemPrompt 尾部", async () => {
		const handler = await setupWithRegistry([entry()]);
		const result = (await handler({ systemPrompt: "BASE" }, {})) as {
			systemPrompt: string;
		};
		expect(result.systemPrompt.startsWith("BASE")).toBe(true);
		expect(result.systemPrompt).toContain("<available_provider_models>");
		expect(result.systemPrompt).toContain("zai-coding-cn/glm-5.2");
	});

	it("空模型列表返回 undefined（不返回 systemPrompt，不干预链）", async () => {
		const handler = await setupWithRegistry([]);
		const result = await handler({ systemPrompt: "BASE" }, {});
		expect(result).toBeUndefined();
	});

	it("registry 异常被吞掉（fail-safe，不阻断 agent turn）", async () => {
		const handler = await setupWithRegistry([], true);
		const result = await handler({ systemPrompt: "BASE" }, {});
		expect(result).toBeUndefined();
	});
});
