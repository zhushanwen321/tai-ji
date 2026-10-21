// SSE 事件流转换对照测试：真实协议 fixture（脱敏入库）经 wool-shared harness，
// 与生产 streamSimple 同一执行路径（driveTraeStream → createAssistantStream 骨架）。
// 断言 = pi 事件序列语义（harness assertConformantSequence 对照 pi 官方 provider 行为基准）。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	expectAbortOutcome,
	expectErrorOutcome,
	expectTextOutcome,
	expectToolCallOutcome,
	expectUsageOutcome,
	mockSseFetch,
	runStreamCase,
	assertConformantSequence,
} from "@zhushanwen/pi-wool-shared/testing";
import type { AssistantMessageEvent, Model, Api } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { driveTraeStream } from "../stream.ts";

const FIXTURE_DIR = join(import.meta.dirname, "fixtures");

/** 测试模型（api 必须与 stream 翻译层一致）。 */
function traeTestModel(): Model<Api> {
	return {
		id: "deepseek-v4.1-flash",
		name: "DeepSeek-V4.1-Flash",
		api: "wool-trae",
		provider: "wool-trae",
		baseUrl: "https://trae-api-cn.mchost.guru",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	};
}

const TEST_AUTH = { token: "test-jwt", userId: "u1", machineId: "m1", soloDeviceId: "d1" };

function driveWithFixture(chunks: readonly string[]) {
	return (driver: Parameters<typeof driveTraeStream>[0]["driver"]) =>
		driveTraeStream({
			auth: TEST_AUTH,
			systemPrompt: "you are a test assistant",
			tools: [],
			messages: [],
			driver,
			fetchImpl: mockSseFetch(chunks),
		});
}

/** 事件类型序列（断言可读性辅助）。 */
function eventTypes(events: readonly AssistantMessageEvent[]): string[] {
	return events.map((event) => event.type);
}

describe("Trae SSE → pi 事件流对照（真实 fixture）", () => {
	it("真实响应样本（metadata/output/timing_cost/extra_info/token_usage/done）→ 文本流 + usage 记账", async () => {
		const raw = readFileSync(join(FIXTURE_DIR, "trae-sse-sample.txt"), "utf8");
		// 上游样本是一个连续 body；mock fetch 单块下发即保序
		const events = await runStreamCase({ model: traeTestModel(), drive: driveWithFixture([raw]) });
		assertConformantSequence(events);
		// 全部 reasoning + 文本增量按序拼接（reasoning_content 与 response 双通道）
		const thinking = events
			.filter((event): event is Extract<AssistantMessageEvent, { type: "thinking_delta" }> => event.type === "thinking_delta")
			.map((event) => event.delta)
			.join("");
		expect(thinking).toContain("The user just wants a two-character reply");
		expectTextOutcome(events, "收到");
		expectUsageOutcome(events, { input: 34, output: 14 });
		const done = events.find((event): event is Extract<AssistantMessageEvent, { type: "done" }> => event.type === "done");
		expect(done?.reason).toBe("stop");
		// start 恰一个且在内容之前；观测事件（metadata/timing_cost/extra_info）只经
		// onProviderStreamEvent 透传，不产生内容块（文本块只有「收到」一个）
		expect(eventTypes(events)[0]).toBe("start");
		const textBlocks = events.filter((event) => event.type === "text_start");
		expect(textBlocks.length).toBe(1);
	});

	it("纯文本多增量流式（无 reasoning）→ text_delta 保序拼接 + done(stop)", async () => {
		const chunks = [
			'id:1\nevent:metadata\ndata:{"model":"","session_id":"s1"}\n\n',
			'id:2\nevent:output\ndata:{"response":"你好","reasoning_content":null,"tool_calls":null}\n\n',
			'id:3\nevent:output\ndata:{"response":"，世界","reasoning_content":null,"tool_calls":null}\n\n',
			'id:4\nevent:token_usage\ndata:{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}\n\n',
			'id:5\nevent:done\ndata:{"finish_reason":"stop"}\n\n',
		];
		const events = await runStreamCase({ model: traeTestModel(), drive: driveWithFixture(chunks) });
		assertConformantSequence(events);
		expectTextOutcome(events, "你好，世界");
		expectUsageOutcome(events, { input: 10, output: 5 });
	});

	it("文本协议工具调用（<toolcall> 标签跨增量分块）→ toolcall_end + stopReason(toolUse)", async () => {
		// 开标记与闭合标记都故意跨块（跨增量缓冲状态机的存在理由）；
		// data 用 JSON.stringify 构造，避免手写嵌套转义
		const sseChunk = (id: number, event: string, payload: unknown): string =>
			`id:${id}\nevent:${event}\ndata:${JSON.stringify(payload)}\n\n`;
		const chunks = [
			sseChunk(1, "output", { response: "<tool", reasoning_content: null, tool_calls: null }),
			sseChunk(2, "output", { response: 'call>{"name":"read","params":{"path":"/tmp/a.txt"}}</tool', reasoning_content: null, tool_calls: null }),
			sseChunk(3, "output", { response: "call>", reasoning_content: null, tool_calls: null }),
			sseChunk(4, "done", { finish_reason: "tool_calls" }),
		];
		const events = await runStreamCase({ model: traeTestModel(), drive: driveWithFixture(chunks) });
		assertConformantSequence(events);
		expectToolCallOutcome(events, { name: "read", arguments: { path: "/tmp/a.txt" } });
		const done = events.find((event): event is Extract<AssistantMessageEvent, { type: "done" }> => event.type === "done");
		expect(done?.reason).toBe("toolUse");
		// 工具调用轮次不应把 <toolcall> 标记原文当文本漏出
		expectTextOutcome(events, "");
	});

	it("原生 tool_calls 形态（output.tool_calls 数组）→ toolcall_end", async () => {
		const chunks = [
			'id:1\nevent:output\ndata:{"response":"","reasoning_content":null,"tool_calls":[{"id":"call_1","name":"bash","params":{"command":"ls"}}]}\n\n',
			'id:2\nevent:done\ndata:{"finish_reason":"tool_calls"}\n\n',
		];
		const events = await runStreamCase({ model: traeTestModel(), drive: driveWithFixture(chunks) });
		assertConformantSequence(events);
		expectToolCallOutcome(events, { name: "bash", arguments: { command: "ls" } });
	});

	it("上游流中断（无 done 事件）→ error 终态（不静默当成功）", async () => {
		const chunks = ['id:1\nevent:output\ndata:{"response":"partial","reasoning_content":null,"tool_calls":null}\n\n'];
		const events = await runStreamCase({ model: traeTestModel(), drive: driveWithFixture(chunks) });
		assertConformantSequence(events);
		expectErrorOutcome(events, "without a done event");
	});

	it("HTTP 200 但流中途 abort → aborted 终态（abort 前已下发的增量可见）", async () => {
		const controller = new AbortController();
		const encoder = new TextEncoder();
		const firstEvent =
			'id:1\nevent:output\ndata:{"response":"before abort","reasoning_content":null,"tool_calls":null}\n\n';
		// 流保持开放模拟持续下发；abort 时以 AbortError 打断挂起的读取（真实 fetch 的中断语义）
		const hangUntilAbort = async (): Promise<Response> =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(streamController) {
						streamController.enqueue(encoder.encode(firstEvent));
						controller.signal.addEventListener("abort", () => {
							streamController.error(new DOMException("aborted", "AbortError"));
						});
					},
				}),
				{ status: 200 },
			);
		const timer = setTimeout(() => controller.abort(), 50);
		try {
			const events = await runStreamCase({
				model: traeTestModel(),
				signal: controller.signal,
				drive: (driver) =>
					driveTraeStream({
						auth: TEST_AUTH,
						systemPrompt: "",
						tools: [],
						messages: [],
						driver,
						fetchImpl: hangUntilAbort,
					}),
			});
			assertConformantSequence(events);
			expectAbortOutcome(events);
			expect(events.some((event) => event.type === "text_delta")).toBe(true);
		} finally {
			clearTimeout(timer);
		}
	});
});

describe("Trae SSE → 错误分类", () => {
	// 请求建立失败发生在 start 之前（骨架协议：error 直接终态，事件序列无 start）——
	// 不跑 assertConformantSequence，断言单 error 终态 + 错误语义。

	it("HTTP 401（code 1001 登录态失效）→ error 终态含重登恢复指引", async () => {
		const events = await runStreamCase({
			model: traeTestModel(),
			drive: (driver) =>
				driveTraeStream({
					auth: TEST_AUTH,
					systemPrompt: "",
					tools: [],
					messages: [],
					driver,
					fetchImpl: async () =>
						new Response(JSON.stringify({ code: 1001, message: "auth expired" }), {
							status: 401,
							headers: { "content-type": "application/json" },
						}),
				}),
		});
		expect(events.length).toBe(1);
		expectErrorOutcome(events, "1001");
		expectErrorOutcome(events, "重新登录");
	});

	it("HTTP 429（code 4011 限流）→ error 终态含限流语义", async () => {
		const events = await runStreamCase({
			model: traeTestModel(),
			drive: (driver) =>
				driveTraeStream({
					auth: TEST_AUTH,
					systemPrompt: "",
					tools: [],
					messages: [],
					driver,
					fetchImpl: async () => new Response(JSON.stringify({ code: 4011 }), { status: 429 }),
				}),
		});
		expect(events.length).toBe(1);
		expectErrorOutcome(events, "4011");
		expectErrorOutcome(events, "限流");
	});

	// 真机实测形态（2026-10-21）：限流/登录态失效等业务错误以 HTTP 200 + SSE error 事件
	// 到达（随后可能仍有 done）——错误必须分类呈现，不得静默吞成空回复。
	it("HTTP 200 + SSE error 事件（4011 限流形态）→ error 终态含限流语义（不静默吞）", async () => {
		const chunks = [
			'id:1\nevent:metadata\ndata:{"model":"","session_id":"s1"}\n\n',
			'id:2\nevent:error\ndata:{"code":4011,"message":"rate limited"}\n\n',
			'id:3\nevent:done\ndata:{"finish_reason":"stop"}\n\n',
		];
		const events = await runStreamCase({ model: traeTestModel(), drive: driveWithFixture(chunks) });
		expectErrorOutcome(events, "4011");
		expectErrorOutcome(events, "限流");
		// 空回复不可见：不得以正常 stop 终态收尾
		expect(events.some((event) => event.type === "done")).toBe(false);
	});

	it("HTTP 200 + SSE error 事件（1001 登录态失效形态）→ error 终态含重登恢复指引", async () => {
		const chunks = [
			'id:1\nevent:error\ndata:{"code":1001,"message":"auth expired"}\n\n',
			'id:2\nevent:done\ndata:{"finish_reason":"stop"}\n\n',
		];
		const events = await runStreamCase({ model: traeTestModel(), drive: driveWithFixture(chunks) });
		expectErrorOutcome(events, "1001");
		expectErrorOutcome(events, "重新登录");
	});
});

describe("请求组装对照", () => {
	it("请求体带 config_name/model（目录 id 直通）与 system+工具协议注入", async () => {
		let capturedBody: unknown;
		const chunks = ['id:1\nevent:done\ndata:{"finish_reason":"stop"}\n\n'];
		await runStreamCase({
			model: traeTestModel(),
			drive: (driver) =>
				driveTraeStream({
					auth: TEST_AUTH,
					systemPrompt: "base prompt",
					tools: [
						{
							name: "read",
							description: "read a file",
							parameters: { type: "object", properties: { path: { type: "string" } } },
						} as never,
					],
					messages: [],
					driver,
					fetchImpl: async (url, init) => {
						capturedBody = JSON.parse(String(init?.body));
						expect(String(url)).toContain("/api/agent/v3/llm_utils_chat");
						expect(String(url)).toContain("trae-api-cn.mchost.guru");
						const headers = (init?.headers ?? {}) as Record<string, string>;
						expect(headers.Authorization).toBe("Cloud-IDE-JWT test-jwt");
						expect(headers["x-ide-version"]).toBe("0.1.52");
						return mockSseFetch(chunks)(url, init);
					},
				}),
		});
		const body = capturedBody as Record<string, unknown>;
		expect(body.config_name).toBe("deepseek-v4.1-flash");
		expect(body.model).toBe("deepseek-v4.1-flash");
		expect(body.function).toBe("solo_work_lite");
		expect(body.stream).toBe(true);
		const messages = body.messages as Array<{ role: string; content: Array<{ text: string }> }>;
		expect(messages[0]?.role).toBe("system");
		expect(messages[0]?.content[0]?.text).toContain("base prompt");
		expect(messages[0]?.content[0]?.text).toContain("<toolcall_protocol>");
		expect(messages[0]?.content[0]?.text).toContain("read(path)");
	});
});
