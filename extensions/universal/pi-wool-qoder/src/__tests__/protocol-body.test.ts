// protocol-body.test.ts — 请求体组装与模型目录解析的单测（chat-body + models-fetch）。
//
// 断言面向 hub 参考实现的协议约定：工具历史两形态（结构化直传 / 文本化降级）、
// tools 嵌套 function 形态、model_config 字段族、目录 chat 条目过滤。

import type { Api, Message, Tool } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { buildQoderBody, flattenMessages, lastUserPrompt, toUpstreamTools, useStructuredToolHistory, type QoderModelMeta } from "../chat-body.ts";
import { fetchModelCatalog, isChatModelKey, toPiModel, type UpstreamCatalogEntry } from "../models-fetch.ts";
import { QoderAuthStore } from "../credentials.ts";

const META: QoderModelMeta = { key: "qfmodel", displayName: "Qwen3.8-Flash", isVl: false, isReasoning: true, maxInputTokens: 180000 };

function userMessage(text: string): Message {
	return { role: "user", content: text };
}

function toolResult(toolCallId: string, body: string): Message {
	return { role: "toolResult", content: [{ type: "text", text: body }], toolCallId, toolName: "probe", isError: false };
}

function assistantWithToolCall(id: string): Message {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "查一下" },
			{ type: "toolCall", id, name: "probe", arguments: { q: "x" } },
		],
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: 0,
	};
}

const TOOL: Tool = {
	name: "probe",
	description: "probe tool",
	parameters: { type: "object", properties: { q: { type: "string" } } },
};

describe("useStructuredToolHistory（hub model_key/model 双候选白名单 + id 齐备判定）", () => {
	it("显示名 qwen 前缀（目录 key qfmodel 不匹配）+ id 齐备 → 结构化直传", () => {
		expect(useStructuredToolHistory("qfmodel", "Qwen3.8-Flash", [assistantWithToolCall("call_1"), toolResult("call_1", "结果")])).toBe(true);
	});

	it("白名单外（kmodel/Kimi-K3）→ 文本化降级", () => {
		expect(useStructuredToolHistory("kmodel", "Kimi-K3", [assistantWithToolCall("call_1"), toolResult("call_1", "结果")])).toBe(false);
	});

	it("白名单内但 toolCallId 缺失 → 降级（上游无法配对）", () => {
		expect(useStructuredToolHistory("qfmodel", "Qwen3.8-Flash", [assistantWithToolCall(""), toolResult("call_1", "结果")])).toBe(false);
	});

	it("目录 key 直接命中前缀（hub model_key 候选）也放行", () => {
		expect(useStructuredToolHistory("qwen3.8-flash", "Whatever", [assistantWithToolCall("c1"), toolResult("c1", "r")])).toBe(true);
	});
});

describe("flattenMessages（工具历史两形态）", () => {
	const transcript: Message[] = [userMessage("查天气"), assistantWithToolCall("call_1"), toolResult("call_1", '{"temp":25}')];

	it("结构化形态：role:tool + tool_call_id + content 恒为字符串", () => {
		const flat = flattenMessages(transcript, true);
		const toolEntry = flat.find((entry) => entry.role === "tool");
		expect(toolEntry).toBeDefined();
		expect(toolEntry?.tool_call_id).toBe("call_1");
		expect(toolEntry?.content).toBe('{"temp":25}');
	});

	it("文本化形态：tool 结果降为 user 文本（带边界标记）", () => {
		const flat = flattenMessages(transcript, false);
		expect(flat.some((entry) => entry.role === "tool")).toBe(false);
		const textual = flat.find((entry) => entry.role === "user" && entry.content.includes("[工具结果"));
		expect(textual?.content).toContain('"temp":25');
		expect(textual?.content).toContain("[工具结果结束]");
	});

	it("assistant 工具调用 → OpenAI tool_calls 形态（arguments 序列化为字符串）", () => {
		const flat = flattenMessages(transcript, true);
		const assistant = flat.find((entry) => entry.role === "assistant");
		expect(assistant?.tool_calls).toEqual([{ id: "call_1", type: "function", function: { name: "probe", arguments: '{"q":"x"}' } }]);
	});

	it("system 消息不透传（由 systemPrompt 统一承载）", () => {
		const flat = flattenMessages([{ role: "system", content: "sys" } as Message, userMessage("hi")], false);
		expect(flat.some((entry) => entry.role === "system")).toBe(false);
	});
});

describe("toUpstreamTools（嵌套 function 形态）", () => {
	it("pi 平铺 → 上游嵌套（平铺形态上游 400）", () => {
		expect(toUpstreamTools([TOOL])).toEqual([
			{ type: "function", function: { name: "probe", description: "probe tool", parameters: { type: "object", properties: { q: { type: "string" } } } } },
		]);
	});
});

describe("buildQoderBody（官方骨架字段族 + pi 内容面）", () => {
	it("骨架字段齐备 + system 占位 + 内容面来自 pi 回放", () => {
		const { body, bodyText } = buildQoderBody({
			systemPrompt: "SYS",
			messages: [userMessage("你好")],
			tools: [],
			modelMeta: META,
			userIdentity: { userType: "personal_professional_trial" },
			prompt: "你好",
			now: 1700000000000,
		});
		const record = body as Record<string, unknown>;
		expect(record.stream).toBe(true);
		expect(record.chat_task).toBe("FREE_INPUT");
		expect(record.session_type).toBe("qodercli");
		expect(record.agent_id).toBe("agent_common");
		expect(record.aliyun_user_type).toBe("personal_professional_trial");
		// model_config 与 chat_context.extra.modelConfig 同源。
		expect(record.model_config).toEqual((record.chat_context as Record<string, unknown>).extra && ((record.chat_context as Record<string, unknown>).extra as Record<string, unknown>).modelConfig);
		// messages[0] = system 占位（官方骨架字段族完整性保留，值恒空）。
		const messages = record.messages as { role: string; content: string }[];
		expect(messages[0]?.role).toBe("system");
		expect(messages[0]?.content).toBe("SYS");
		expect(messages[1]).toEqual({ role: "user", content: "你好" });
		// 出站 bodyText 是合法紧凑 JSON（encode 前提；qoderEncode/Decode 往返由 crypto-family 测试覆盖）。
		expect(JSON.parse(bodyText)).toEqual(body);
	});

	it("maxTokens 透传（parameters.max_tokens）", () => {
		const withMax = buildQoderBody({ systemPrompt: "", messages: [userMessage("x")], tools: [], modelMeta: META, userIdentity: { userType: "" }, prompt: "x", maxTokens: 512 });
		const parameters = (withMax.body as Record<string, unknown>).parameters;
		expect(parameters).toEqual({ max_tokens: 512 });
		const withoutMax = buildQoderBody({ systemPrompt: "", messages: [userMessage("x")], tools: [], modelMeta: META, userIdentity: { userType: "" }, prompt: "x" });
		expect((withoutMax.body as Record<string, unknown>).parameters).toEqual({});
	});
});

/** lastUserPrompt 构造的 assistant 消息（完整 usage/cost 形态）。 */
describe("lastUserPrompt", () => {
	it("取末条非空 user 消息", () => {
		expect(lastUserPrompt([userMessage("第一"), userMessage("第二")])).toBe("第二");
		expect(lastUserPrompt([userMessage("第一"), { role: "assistant", content: [{ type: "text", text: "回复" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 }])).toBe("第一");
	});
});

describe("isChatModelKey（目录过滤词表）", () => {
	it("补全/图像类 key 排除，对话 key 保留", () => {
		expect(isChatModelKey("qfmodel")).toBe(true);
		expect(isChatModelKey("")).toBe(false);
		expect(isChatModelKey("lite")).toBe(false);
		expect(isChatModelKey("codewise-x")).toBe(false);
		expect(isChatModelKey("completion-y")).toBe(false);
		expect(isChatModelKey("m-image-alpha")).toBe(false);
		expect(isChatModelKey("x-taco-completion")).toBe(false);
	});
});

describe("toPiModel（上游条目 → pi 完整模型）", () => {
	it("persist/内存/快照三处同型（provider/baseUrl/type 齐备）", () => {
		const model = toPiModel({ key: "qfmodel", display_name: "Qwen3.8-Flash", is_reasoning: true, is_vl: true, max_input_tokens: 250000 });
		expect(model.provider).toBe("wool-qoder");
		expect(model.api).toBe("wool-qoder");
		expect(model.baseUrl).toContain("gateway.qoder.com.cn");
		expect(model.type).toBe("chat");
		expect(model.input).toEqual(["text", "image"]);
		expect(model.contextWindow).toBe(250000);
		// max_input_tokens 缺省回落 DEFAULT_CONTEXT_WINDOW。
		expect(toPiModel({ key: "x" }).contextWindow).toBe(180000);
	});
});

describe("fetchModelCatalog（带网拉取）", () => {
	function loggedInStore(): QoderAuthStore {
		const store = new QoderAuthStore();
		store.learn({ type: "oauth", access: "dt-x", refresh: "drt-x", expires: 0, uid: "fixture-uid-0001", nickname: "u", userType: "", organizationId: "", organizationName: "", source: "ide-extract" });
		return store;
	}

	it("GET 无 body（P5 实测裁决形态）+ chat 数组过滤 + 元数据缓存填充", async () => {
		const captured: { url: string; method?: string; body?: unknown }[] = [];
		const catalog: Record<string, unknown> = {
			chat: [
				{ key: "qfmodel", display_name: "Qwen3.8-Flash", is_reasoning: true },
				{ key: "completion-internal", display_name: "补全模型" },
				{ key: 123 },
			],
		};
		const fetchImpl = (async (url: unknown, init?: RequestInit) => {
			captured.push({ url: String(url), method: init?.method, body: init?.body });
			return new Response(JSON.stringify(catalog), { status: 200, headers: { "content-type": "application/json" } });
		}) as typeof globalThis.fetch;
		const models = await fetchModelCatalog({ authStore: loggedInStore(), fetchImpl });
		expect(models.map((model: Model<Api>) => model.id)).toEqual(["qfmodel"]);
		// GET 无 body（Node fetch spec 禁 GET 带 body；服务端按空 body 校验签名——P5 实测）。
		expect(captured[0]?.method).toBe("GET");
		expect(captured[0]?.body).toBeUndefined();
		// 元数据缓存填充（chat-stream 反查通道）。
		const { lookupModelMeta } = await import("../models-fetch.ts");
		expect(lookupModelMeta("qfmodel")?.displayName).toBe("Qwen3.8-Flash");
	});

	it("响应非 {chat:[...]} 形态 → 显式报错", async () => {
		const fetchImpl = (async () => new Response(JSON.stringify({ unexpected: true }), { status: 200 })) as typeof globalThis.fetch;
		await expect(fetchModelCatalog({ authStore: loggedInStore(), fetchImpl })).rejects.toThrow(/missing chat array/);
	});

	it("无凭据 → fail-fast", async () => {
		await expect(fetchModelCatalog({ authStore: new QoderAuthStore(), fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof globalThis.fetch })).rejects.toThrow(/no credentials/);
	});
});
