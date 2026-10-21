// chat-stream.test.ts — streamSimple 协议翻译的 pi 事件流对照测试（验收条款①的
// fixture 驱动部分；真机对照在 P5 探针）。
//
// 输入 = 合成的上游 SSE 信封序列（形态对照 hub iter_inner_sse 注释的上游帧格式：
// data:{"headers":...,"body":"<内层 OpenAI chunk JSON>","statusCodeValue":200} /
// data:{"body":"[DONE]"} / event:finish 计时元数据）；被测 = createQoderDrive 经
// wool-shared createAssistantStream 骨架（与生产 streamSimple 同一执行路径）；
// 断言 = wool-shared harness 的 pi 官方 provider 行为基准（结构纪律 + 文本/工具/
// usage/错误/abort 语义）。全部 mock fetch，零真实上游调用。

import type { Api, Model, Tool } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { sseDataChunk } from "@zhushanwen/pi-wool-shared";
import {
	assertConformantSequence,
	expectAbortOutcome,
	expectErrorOutcome,
	expectTextOutcome,
	expectToolCallOutcome,
	expectUsageOutcome,
	mockSseFetch,
	runStreamCase,
} from "@zhushanwen/pi-wool-shared/testing";

import { QoderAuthStore } from "../credentials.ts";
import { createQoderDrive } from "../chat-stream.ts";
import type { QoderModelMeta } from "../chat-body.ts";

/** 测试模型（与包内快照 qfmodel 同形）。 */
const TEST_MODEL: Model<Api> = {
	id: "qfmodel",
	name: "Qwen3.8-Flash",
	api: "wool-qoder",
	provider: "wool-qoder",
	baseUrl: "https://gateway.qoder.com.cn",
	type: "chat",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 180000,
	maxTokens: 32768,
};

const TEST_META: QoderModelMeta = { key: "qfmodel", displayName: "Qwen3.8-Flash", isVl: false, isReasoning: true, maxInputTokens: 180000 };

/** 造已登录 authStore（凭据 = 全合成 fixture 值）。 */
function loggedInStore(): QoderAuthStore {
	const store = new QoderAuthStore();
	store.learn({
		type: "oauth",
		access: "dt-fixture-access-token",
		refresh: "drt-fixture-refresh-token",
		expires: 0,
		uid: "fixture-uid-0001",
		nickname: "fixture-user",
		userType: "personal_professional_trial",
		organizationId: "",
		organizationName: "",
		source: "ide-extract",
	});
	return store;
}

/** 信封帧（statusCodeValue 可传字符串形态——上游实测过 str/int 两态）。 */
function envelope(chunk: unknown, status: number | string = 200): string {
	return sseDataChunk({ body: JSON.stringify(chunk), statusCodeValue: status });
}

const DONE_FRAME = sseDataChunk({ body: "[DONE]" });
/** 计时元数据行（上游 event:finish，无 data 载荷——解析层忽略）。 */
const FINISH_META = "event:finish\n\n";

function driveWith(options: { authStore: QoderAuthStore; fetchImpl: typeof globalThis.fetch }) {
	return createQoderDrive({ authStore: options.authStore, fetchImpl: options.fetchImpl, lookupModelMeta: () => TEST_META });
}

async function runQoderCase(options: {
	fetchImpl: typeof globalThis.fetch;
	chunks?: never;
	signal?: AbortSignal;
	authStore?: QoderAuthStore;
}) {
	const authStore = options.authStore ?? loggedInStore();
	const drive = driveWith({ authStore, fetchImpl: options.fetchImpl });
	const events = await runStreamCase({
		model: TEST_MODEL,
		signal: options.signal,
		drive: (driver) =>
			drive({
				model: TEST_MODEL,
				systemPrompt: "You are a test.",
				messages: [{ role: "user", content: "北京今天天气" }],
				tools: [],
				driver,
			}),
	});
	return events;
}

describe("文本流（含 usage 记账与信封字符串状态形态）", () => {
	it("多帧 delta 拼接 + usage + stop 终态，序列结构合规", async () => {
		const chunks = [
			envelope({ id: "chatcmpl-f1", choices: [{ index: 0, delta: { content: "今天" } }] }),
			envelope({ id: "chatcmpl-f1", choices: [{ index: 0, delta: { content: "北京" } }] }),
			envelope({ id: "chatcmpl-f1", choices: [{ index: 0, delta: { content: "晴。" } }] }),
			// 信封状态字符串 "200" 形态（hub：int 或 str 两态都实测过）。
			envelope({ id: "chatcmpl-f1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, "200"),
			envelope({ id: "chatcmpl-f1", choices: [], usage: { prompt_tokens: 2600, completion_tokens: 12, total_tokens: 2612, prompt_cache_hit_tokens: 100 } }),
			FINISH_META,
			DONE_FRAME,
		];
		const events = await runQoderCase({ fetchImpl: mockSseFetch(chunks) });
		assertConformantSequence(events);
		expectTextOutcome(events, "今天北京晴。");
		expectUsageOutcome(events, { input: 2600, output: 12 });
		const done = events.find((event) => event.type === "done");
		expect(done?.type === "done" && done.reason).toBe("stop");
		expect(done?.type === "done" && done.message.responseId).toBe("chatcmpl-f1");
	});

	it("reasoning_content → thinking 事件（reasoning 模型的双通道内容）", async () => {
		const chunks = [
			envelope({ choices: [{ index: 0, delta: { reasoning_content: "先想一下" } }] }),
			envelope({ choices: [{ index: 0, delta: { content: "答案是 42。" } }] }),
			envelope({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
			DONE_FRAME,
		];
		const events = await runQoderCase({ fetchImpl: mockSseFetch(chunks) });
		assertConformantSequence(events);
		expectTextOutcome(events, "答案是 42。");
		const thinking = events
			.filter((event) => event.type === "thinking_delta")
			.map((event) => (event.type === "thinking_delta" ? event.delta : ""))
			.join("");
		expect(thinking).toBe("先想一下");
	});
});

describe("工具调用流（增量聚合 → 完整 toolcall_end）", () => {
	it("id/name 首帧 + arguments 分片聚合 + toolUse 终态", async () => {
		const chunks = [
			envelope({
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [{ index: 0, id: "call_weather_1", type: "function", function: { name: "get_weather", arguments: "" } }],
						},
					},
				],
			}),
			envelope({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }] }),
			envelope({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"北京"}' } }] } }] }),
			envelope({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
			DONE_FRAME,
		];
		const events = await runQoderCase({ fetchImpl: mockSseFetch(chunks) });
		assertConformantSequence(events);
		expectToolCallOutcome(events, { name: "get_weather", arguments: { city: "北京" } });
		const done = events.find((event) => event.type === "done");
		expect(done?.type === "done" && done.reason).toBe("toolUse");
	});

	it("arguments 不可解析 → error 终态（不静默产出残缺调用）", async () => {
		const chunks = [
			envelope({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "t", arguments: "{bad json" } }] } }] }),
			envelope({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
			DONE_FRAME,
		];
		const events = await runQoderCase({ fetchImpl: mockSseFetch(chunks) });
		expectErrorOutcome(events, "unparseable arguments");
	});
});

describe("错误分类与请求体编码", () => {
	it("HTTP 401 → start 前 error 终态（凭据被拒消息带重登指引）", async () => {
		const events = await runQoderCase({
			fetchImpl: mockSseFetch([], { status: 401 }) as typeof globalThis.fetch,
		});
		expectErrorOutcome(events, "credential rejected; re-login");
		// 请求建立失败发生在 start 之前——序列无 start 事件。
		expect(events.some((event) => event.type === "start")).toBe(false);
	});

	it("信封 statusCodeValue 非 200 → error 终态（上游以 SSE 信封投递故障）", async () => {
		const chunks = [
			envelope({ error: { code: "INPUT_SENSITIVE", message: "content filtered" } }, 418),
		];
		const events = await runQoderCase({ fetchImpl: mockSseFetch(chunks) });
		expectErrorOutcome(events, "envelope status 418");
	});

	it("出站请求体 = qoderEncode(紧凑 JSON) + COSY 签名头族 + POST", async () => {
		const captured: { url: string; init: RequestInit }[] = [];
		const fetchImpl = (async (url: unknown, init?: RequestInit) => {
			captured.push({ url: String(url), init: init ?? {} });
			return new Response(sseBodyOf([envelope({ choices: [{ index: 0, delta: { content: "ok" } }] }), envelope({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }), DONE_FRAME]), { status: 200 });
		}) as typeof globalThis.fetch;
		const events = await runQoderCase({ fetchImpl });
		assertConformantSequence(events);
		expect(captured.length).toBe(1);
		const { url, init } = captured[0]!;
		expect(url).toContain("gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation");
		expect(init.method).toBe("POST");
		const headers = init.headers as Record<string, string>;
		expect(headers.authorization).toMatch(/^Bearer COSY\./);
		expect(headers["cosy-user"]).toBe("fixture-uid-0001");
		expect(headers["x-model-key"]).toBe("qfmodel");
		// 请求体经自定义 base64 编码（出站载荷形态——字母表内字符）。
		const body = String(init.body);
		expect(body).not.toContain("{");
		expect(body).toMatch(/^[_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!$]+$/);
	});
});

describe("abort（P5 四项之四的 fixture 等价路径）", () => {
	it("请求建立期 abort → aborted 终态（fetch 信号语义）", async () => {
		const controller = new AbortController();
		const fetchImpl = ((_url: unknown, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				const fail = (): void => reject(new DOMException("Aborted", "AbortError"));
				// abort 可能先于监听器注册发生（drive 前同步 abort）——两态都接住。
				if (init?.signal?.aborted) {
					fail();
					return;
				}
				init?.signal?.addEventListener("abort", fail, { once: true });
			})) as typeof globalThis.fetch;
		const eventsPromise = runQoderCase({ fetchImpl, signal: controller.signal });
		controller.abort();
		const events = await eventsPromise;
		expectAbortOutcome(events);
	});

	it("流中途 abort → aborted 终态（已发出的内容保留）", async () => {
		const controller = new AbortController();
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			async pull(streamController) {
				await new Promise((resolve) => setTimeout(resolve, 5));
				if (controller.signal.aborted) {
					// abort 后再投一帧再 close——让解析循环回到顶部时看到 aborted
					// （直接 close 会走正常 done 终态，abort 语义被吞）。
					streamController.enqueue(encoder.encode(envelope({ choices: [{ index: 0, delta: { content: "" } }] })));
					streamController.close();
					return;
				}
				streamController.enqueue(encoder.encode(envelope({ choices: [{ index: 0, delta: { content: "片段" } }] })));
			},
		});
		const fetchImpl = (async () => new Response(body, { status: 200 })) as typeof globalThis.fetch;
		const eventsPromise = runQoderCase({ fetchImpl, signal: controller.signal });
		setTimeout(() => controller.abort(), 25);
		const events = await eventsPromise;
		expectAbortOutcome(events);
	});
});

describe("无凭据 fail-fast", () => {
	it("未登录时发请求前显式报错（不静默发无效请求）", async () => {
		const emptyStore = new QoderAuthStore();
		const drive = driveWith({ authStore: emptyStore, fetchImpl: mockSseFetch([DONE_FRAME]) });
		const events = await runStreamCase({
			model: TEST_MODEL,
			drive: (driver) =>
				drive({
					model: TEST_MODEL,
					systemPrompt: "",
					messages: [{ role: "user", content: "hi" }],
					tools: [] as Tool[],
					driver,
				}),
		});
		expectErrorOutcome(events, "no credentials");
	});
});

/** 文本块序列 → ReadableStream（错误路径 mock 自建 body 用）。 */
function sseBodyOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
}
