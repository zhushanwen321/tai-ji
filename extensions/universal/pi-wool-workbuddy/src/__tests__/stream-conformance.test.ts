// SSE 事件流对照测试：OpenAI 形态 fixture 经 wool-shared harness，与生产 streamSimple
// 同一执行路径（workbuddyStream → createAssistantStream 骨架）。
// 断言 = pi 事件序列语义（assertConformantSequence 对照 pi 官方 provider 行为基准）
// + 请求组装快照（头族/请求体经 fetch mock 捕获断言）。

import type { Api, Model } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
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
import { describe, expect, it } from "vitest";

import type { WoolStreamDriverContext } from "@zhushanwen/pi-wool-shared";
import type { WoolStreamOutcome } from "@zhushanwen/pi-wool-shared";
import { workbuddyStream } from "../stream.ts";
import { buildChatBody, encodeChatBody } from "../body.ts";

/** 假 JWT（payload {"sub":"user-123","exp":9999999999}，仅供 uid 解码测试）。 */
const TEST_JWT = `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: "user-123", exp: 9999999999 }))}.sig`;

function workbuddyTestModel(): Model<Api> {
	return {
		id: "hy3",
		name: "Hy3",
		api: "wool-workbuddy",
		provider: "wool-workbuddy",
		baseUrl: "https://copilot.tencent.com",
		type: "chat",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 192_000,
		maxTokens: 64_000,
	};
}

interface CapturedRequest { // oe-exempt:20261022:test:stream 一致性测试的 fetch 捕获记录形状——仅本文件 capturingFetch 消费（无 src 消费），fixture 形状随用例演进
	url: string;
	init: RequestInit;
}

/** 捕获请求 + 返回 fixture body 的 fetch mock。 */
function capturingFetch(chunks: readonly string[]): { impl: typeof globalThis.fetch; captured: () => CapturedRequest } {
	let capturedRequest: CapturedRequest | undefined;
	const bodyFetch = mockSseFetch(chunks);
	const impl = (async (url: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
		capturedRequest = { url: String(url), init: (init ?? {}) as RequestInit };
		return bodyFetch(url, init);
	}) as typeof globalThis.fetch;
	return { impl, captured: () => capturedRequest as CapturedRequest };
}

function driveWith(chunks: readonly string[], transcript = normalizeContext({ messages: [{ role: "user", content: "你好", timestamp: Date.now() }] })) {
	const capture = capturingFetch(chunks);
	return {
		captured: capture.captured,
		drive: (driver: WoolStreamDriverContext): Promise<WoolStreamOutcome> =>
			workbuddyStream({
				model: workbuddyTestModel(),
				systemPrompt: "you are a test assistant",
				tools: [],
				messages: transcript.messages,
				resolvedAuth: { ok: true, apiKey: TEST_JWT },
				driver,
				conversationKey: "test-session",
				fetchImpl: capture.impl,
			}),
	};
}

/** OpenAI 形态 SSE chunk 构造。 */
function sse(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

describe("WorkBuddy OpenAI 形态 SSE → pi 事件流对照", () => {
	it("纯文本多增量 → text_delta 保序 + usage 尾 chunk 记账 + done(stop)", async () => {
		const chunks = [
			sse({ id: "cmpl-1", choices: [{ delta: { content: "你好" } }] }),
			sse({ id: "cmpl-1", choices: [{ delta: { content: "，世界" } }] }),
			sse({ id: "cmpl-1", choices: [{ delta: {}, finish_reason: "stop" }] }),
			sse({ id: "cmpl-1", choices: [], usage: { prompt_tokens: 12, completion_tokens: 6 } }),
			"data: [DONE]\n\n",
		];
		const { captured, drive } = driveWith(chunks);
		const events = await runStreamCase({ model: workbuddyTestModel(), drive });
		assertConformantSequence(events);
		expectTextOutcome(events, "你好，世界");
		expectUsageOutcome(events, { input: 12, output: 6 });
		const done = events.find((event) => event.type === "done");
		expect(done && done.type === "done" ? done.reason : undefined).toBe("stop");
		// 请求组装快照：端点 + 紧凑 JSON + stream_options
		const request = captured();
		expect(request.url).toBe("https://copilot.tencent.com/v2/chat/completions");
		const body = JSON.parse(String(request.init.body)) as Record<string, unknown>;
		expect(body.stream).toBe(true);
		expect(body.stream_options).toEqual({ include_usage: true });
		expect(body.model).toBe("hy3");
		expect(String(request.init.body)).not.toContain(", "); // 紧凑序列化无空白
	});

	it("reasoning_content 增量 → thinking 块", async () => {
		const chunks = [
			sse({ id: "c1", choices: [{ delta: { reasoning_content: "先想一想" } }] }),
			sse({ id: "c1", choices: [{ delta: { reasoning_content: "再想一想" } }] }),
			sse({ id: "c1", choices: [{ delta: { content: "答案" }, finish_reason: "stop" }] }),
			"data: [DONE]\n\n",
		];
		const { drive } = driveWith(chunks);
		const events = await runStreamCase({ model: workbuddyTestModel(), drive });
		assertConformantSequence(events);
		const thinking = events
			.filter((event) => event.type === "thinking_delta")
			.map((event) => (event.type === "thinking_delta" ? event.delta : ""))
			.join("");
		expect(thinking).toBe("先想一想再想一想");
		expectTextOutcome(events, "答案");
	});

	it("tool_calls 增量聚合（name 首块 + arguments 分片拼接）→ toolcall_end + toolUse", async () => {
		const chunks = [
			sse({ id: "c1", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "bash", arguments: "" } }] } }] }),
			sse({ id: "c1", choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":"ls"' } }] } }] }),
			sse({ id: "c1", choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] } }] }),
			sse({ id: "c1", choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
			"data: [DONE]\n\n",
		];
		const { drive } = driveWith(chunks);
		const events = await runStreamCase({ model: workbuddyTestModel(), drive });
		assertConformantSequence(events);
		expectToolCallOutcome(events, { name: "bash", arguments: { command: "ls" } });
		const done = events.find((event) => event.type === "done");
		expect(done && done.type === "done" ? done.reason : undefined).toBe("toolUse");
	});

	it("多工具并行（两个 index）→ 两个 toolcall_end", async () => {
		const chunks = [
			sse({ id: "c1", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "read", arguments: '{"path":"/a"}' } }] } }] }),
			sse({ id: "c1", choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b", function: { name: "grep", arguments: '{"pattern":"x"}' } }] } }] }),
			sse({ id: "c1", choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
			"data: [DONE]\n\n",
		];
		const { drive } = driveWith(chunks);
		const events = await runStreamCase({ model: workbuddyTestModel(), drive });
		assertConformantSequence(events);
		const ends = events.filter((event) => event.type === "toolcall_end");
		expect(ends.length).toBe(2);
	});

	it("上游流内 error 对象 → error 终态", async () => {
		const chunks = [
			sse({ error: { message: "rate limited", code: 11140 } }),
		];
		const { drive } = driveWith(chunks);
		const events = await runStreamCase({ model: workbuddyTestModel(), drive });
		assertConformantSequence(events);
		expectErrorOutcome(events, "rate limited");
	});

	it("HTTP 401（请求建立失败）→ 直接 error 终态（协议允许 start 前失败，无内容事件）", async () => {
		const impl = (async () => new Response("unauthorized", { status: 401 })) as typeof globalThis.fetch;
		const drive = (driver: WoolStreamDriverContext): Promise<WoolStreamOutcome> =>
			workbuddyStream({
				model: workbuddyTestModel(),
				systemPrompt: "s",
				tools: [],
				messages: [],
				resolvedAuth: { ok: true, apiKey: TEST_JWT },
				driver,
				conversationKey: "k",
				fetchImpl: impl,
			});
		const events = await runStreamCase({ model: workbuddyTestModel(), drive });
		// 请求建立失败 = 合法的「仅 error」流（pi 协议：start 前失败不发 start），
		// 不适用 assertConformantSequence 的「首事件必 start」口径（该口径针对正常流）。
		expect(events.length).toBe(1);
		expectErrorOutcome(events, "HTTP 401");
	});

	it("凭据缺失（resolvedAuth ok:false）→ error 终态", async () => {
		const drive = (driver: WoolStreamDriverContext): Promise<WoolStreamOutcome> =>
			workbuddyStream({
				model: workbuddyTestModel(),
				systemPrompt: "s",
				tools: [],
				messages: [],
				resolvedAuth: { ok: false, error: "no credentials" },
				driver,
				conversationKey: "k",
			});
		const events = await runStreamCase({ model: workbuddyTestModel(), drive });
		expectErrorOutcome(events, "credentials unavailable");
	});

	it("abort 信号 → aborted 终态", async () => {
		const controller = new AbortController();
		const chunks = [
			sse({ id: "c1", choices: [{ delta: { content: "部分" } }] }),
		];
		const { impl } = (() => {
			const bodyFetch = mockSseFetch(chunks);
			return { impl: bodyFetch };
		})();
		const drive = (driver: WoolStreamDriverContext): Promise<WoolStreamOutcome> =>
			workbuddyStream({
				model: workbuddyTestModel(),
				systemPrompt: "s",
				tools: [],
				messages: [],
				resolvedAuth: { ok: true, apiKey: TEST_JWT },
				driver,
				conversationKey: "k",
				fetchImpl: impl,
			});
		const eventsPromise = runStreamCase({ model: workbuddyTestModel(), drive, signal: controller.signal });
		controller.abort();
		const events = await eventsPromise;
		assertConformantSequence(events);
		expectAbortOutcome(events);
	});

	it("usage 多别名（prompt_tokens_details.cached_tokens）→ cacheRead 归一", async () => {
		const chunks = [
			sse({ id: "c1", choices: [{ delta: { content: "x" }, finish_reason: "stop" }] }),
			sse({
				id: "c1",
				choices: [],
				usage: { prompt_tokens: 100, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 40 }, cached_tokens: 0 },
			}),
			"data: [DONE]\n\n",
		];
		const { drive } = driveWith(chunks);
		const events = await runStreamCase({ model: workbuddyTestModel(), drive });
		assertConformantSequence(events);
		const done = events.find((event): event is Extract<(typeof events)[number], { type: "done" }> => event.type === "done");
		expect(done?.message.usage.cacheRead).toBe(40);
	});
});

describe("请求体组装（pi transcript → OpenAI 形态）", () => {
	it("多轮 transcript（system/user/assistant 工具调用/toolResult）→ OpenAI 消息序列", () => {
		const body = buildChatBody({
			model: "hy3",
			systemPrompt: "sys",
			messages: [
				{ role: "user", content: "列文件", timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } }],
					api: "wool-workbuddy",
					provider: "wool-workbuddy",
					model: "hy3",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "toolUse",
					timestamp: 2,
				},
				{ role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [{ type: "text", text: "a.txt" }], isError: false, timestamp: 3 },
			],
			tools: [{ name: "bash", description: "run", parameters: { type: "object", properties: {} } as never }],
		});
		expect(body.messages).toEqual([
			{ role: "system", content: "sys" },
			{ role: "user", content: "列文件" },
			{
				role: "assistant",
				content: null,
				tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }],
			},
			{ role: "tool", tool_call_id: "call_1", content: "a.txt" },
		]);
		expect(body.tools).toEqual([
			{ type: "function", function: { name: "bash", description: "run", parameters: { type: "object", properties: {} } } },
		]);
	});

	it("紧凑序列化（无空白分隔）", () => {
		expect(encodeChatBody({ model: "hy3", messages: [{ role: "system", content: "s" }] })).toBe(
			'{"model":"hy3","messages":[{"role":"system","content":"s"}]}',
		);
	});
});
