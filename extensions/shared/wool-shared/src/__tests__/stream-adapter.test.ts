// stream-adapter.test.ts — 事件流骨架纪律（对照 pi 官方 provider 行为基准）。

import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
	assertConformantSequence,
	collectAssistantEvents,
	expectAbortOutcome,
	expectErrorOutcome,
	expectTextOutcome,
	expectToolCallOutcome,
	expectUsageOutcome,
} from "../testing/harness.ts";
import { createAssistantStream, type WoolStreamOutcome } from "../stream-adapter.ts";

function testModel(): Model {
	return {
		id: "test-model",
		name: "Test Model",
		api: "wool-test",
		provider: "wool-test",
		baseUrl: "https://upstream.test",
		type: "chat",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	} as unknown as Model;
}

async function run(
	drive: Parameters<typeof createAssistantStream>[0]["drive"],
	options?: { signal?: AbortSignal },
) {
	const stream = createAssistantStream({ model: testModel(), signal: options?.signal ?? new AbortController().signal, drive });
	return collectAssistantEvents(stream);
}

describe("createAssistantStream 事件流纪律", () => {
	it("文本路径：start → text_start/delta → done，usage 固化 + cost 计算", async () => {
		const events = await run(async (driver) => {
			driver.open();
			driver.text("你");
			driver.text("好");
			const outcome: WoolStreamOutcome = { usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0 } };
			return outcome;
		});
		assertConformantSequence(events);
		expectTextOutcome(events, "你好");
		expectUsageOutcome(events, { input: 3, output: 2 });
		const done = events.find((event) => event.type === "done");
		expect(done?.type === "done" && done.message.usage.cost.total).toBeGreaterThan(0);
		expect(done?.type === "done" && done.message.stopReason).toBe("stop");
	});

	it("同块连续 text 增量不重复发 text_start；跨块（thinking 后 text）重新开块", async () => {
		const events = await run(async (driver) => {
			driver.open();
			driver.thinking("思考");
			driver.text("答");
			driver.text("案");
			return { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
		});
		assertConformantSequence(events);
		const starts = events.filter((event) => event.type === "text_start");
		expect(starts).toHaveLength(1);
		const thinkingStarts = events.filter((event) => event.type === "thinking_start");
		expect(thinkingStarts).toHaveLength(1);
		expectTextOutcome(events, "答案");
	});

	it("工具调用路径：三段完整事件 + done reason=toolUse + 参数为解析后对象", async () => {
		const events = await run(async (driver) => {
			driver.open();
			driver.toolCall({ id: "call_1", name: "read_file", arguments: { path: "/tmp/a.txt", limit: 10 } });
			return { usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, stopReason: "toolUse" as const };
		});
		assertConformantSequence(events);
		expectToolCallOutcome(events, { name: "read_file", arguments: { path: "/tmp/a.txt", limit: 10 } });
		const done = events.find((event) => event.type === "done");
		expect(done?.type === "done" && done.reason).toBe("toolUse");
	});

	it("请求建立失败（open 前 throw）→ 直接 error 终态，无 start", async () => {
		const events = await run(async () => {
			throw new Error("missing credential");
		});
		expect(events[0].type).not.toBe("start");
		expectErrorOutcome(events, "missing credential");
	});

	it("open 后 throw → error 终态（start 已发，协议允许）", async () => {
		const events = await run(async (driver) => {
			driver.open();
			throw new Error("upstream 500");
		});
		assertConformantSequence(events);
		expectErrorOutcome(events, "upstream 500");
	});

	it("abort 信号 → reason=aborted 终态", async () => {
		const controller = new AbortController();
		const events = await run(async (driver) => {
			driver.open();
			controller.abort();
			throw new DOMException("cancelled", "AbortError");
		}, { signal: controller.signal });
		assertConformantSequence(events);
		expectAbortOutcome(events);
	});

	it("仪表钩子透传：onPayload 替换、onResponse/onProviderStreamEvent 调用", async () => {
		const seen: string[] = [];
		const stream = createAssistantStream({
			model: testModel(),
			signal: new AbortController().signal,
			options: {
				onPayload: (payload) => {
					seen.push("payload");
					return { ...(payload as object), replaced: true };
				},
				onResponse: (response) => {
					seen.push(`response:${response.status}`);
				},
				onProviderStreamEvent: (data) => {
					seen.push(`event:${String(data)}`);
				},
			},
			drive: async (driver) => {
				const payload = await driver.onPayload({ body: 1 });
				expect(payload).toEqual({ body: 1, replaced: true });
				await driver.onResponse({ status: 200, headers: {} });
				await driver.onProviderStreamEvent("meta");
				driver.open();
				driver.text("ok");
				return { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
			},
		});
		const events = await collectAssistantEvents(stream);
		assertConformantSequence(events);
		expect(seen).toEqual(["payload", "response:200", "event:meta"]);
	});

	it("骨架误用 fail-fast：未 open 即返回 → error（start 缺失是协议硬约束）", async () => {
		const events = await run(async () => {
			return { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
		});
		expectErrorOutcome(events, "without open()");
	});

	it("骨架误用 fail-fast：open 后未终态再 open → driver 侧抛 WoolStreamAdapterError", async () => {
		const stream = createAssistantStream({
			model: testModel(),
			signal: new AbortController().signal,
			drive: async (driver) => {
				driver.open();
				expect(() => driver.open()).toThrow(/open\(\) called twice/);
				return { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
			},
		});
		const events = await collectAssistantEvents(stream);
		assertConformantSequence(events);
	});

	it("终态唯一：drive 返回后流已 done，骨架不再发第二终态", async () => {
		const events = await run(async (driver) => {
			driver.open();
			driver.text("x");
			return { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
		});
		const terminals = events.filter((event) => event.type === "done" || event.type === "error");
		expect(terminals).toHaveLength(1);
	});
});
