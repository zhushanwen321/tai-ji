// harness.test.ts — 对照 harness 自身：runStreamCase + 断言函数的行为契约。

import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
	assertConformantSequence,
	expectAbortOutcome,
	expectErrorOutcome,
	expectTextOutcome,
	expectToolCallOutcome,
	expectUsageOutcome,
	mockSseFetch,
	runStreamCase,
	WoolConformanceError,
} from "../testing/harness.ts";
import { readSseEvents } from "../sse.ts";
import type { WoolStreamDriverContext, WoolStreamOutcome } from "../stream-adapter.ts";

function testModel(): Model {
	return {
		id: "m",
		name: "M",
		api: "wool-test",
		provider: "wool-test",
		type: "chat",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 },
		contextWindow: 1024,
		maxTokens: 128,
	} as unknown as Model;
}

type Drive = (driver: WoolStreamDriverContext) => Promise<WoolStreamOutcome>;

function runFixture(drive: Drive, signal?: AbortSignal) {
	return runStreamCase({ model: testModel(), drive, signal });
}

describe("runStreamCase（骨架路径）", () => {
	it("echo 式家族 drive 全链路：收集事件 + 各断言成立", async () => {
		const events = await runFixture(async (driver) => {
			driver.open();
			driver.text("回");
			driver.text("显");
			return { usage: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0 } };
		});
		assertConformantSequence(events);
		expectTextOutcome(events, "回显");
		expectUsageOutcome(events, { input: 2, output: 2 });
	});

	it("错误形态断言：家族 throw → error 终态", async () => {
		const events = await runFixture(async () => {
			throw new Error("bad signature");
		});
		expectErrorOutcome(events, "bad signature");
	});

	it("abort 形态断言", async () => {
		const controller = new AbortController();
		const events = await runFixture(async (driver) => {
			driver.open();
			controller.abort();
			throw new DOMException("cancelled", "AbortError");
		}, controller);
		expectAbortOutcome(events);
	});

	it("工具调用形态断言", async () => {
		const events = await runFixture(async (driver) => {
			driver.open();
			driver.toolCall({ id: "c1", name: "bash", arguments: { cmd: "ls" } });
			return { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, stopReason: "toolUse" as const };
		});
		expectToolCallOutcome(events, { name: "bash", arguments: { cmd: "ls" } });
	});

	it("断言失败给出可读差异（WoolConformanceError）", async () => {
		const events = await runFixture(async (driver) => {
			driver.open();
			driver.text("abc");
			return { usage: { input: 1, output: 3, cacheRead: 0, cacheWrite: 0 } };
		});
		expect(() => expectTextOutcome(events, "xyz")).toThrow(WoolConformanceError);
		expect(() => expectTextOutcome(events, "xyz")).toThrow(/text mismatch/);
	});
});

describe("mockSseFetch", () => {
	it("返回的 fetch 产出与 chunks 一致的 SSE body", async () => {
		const fetchImpl = mockSseFetch(['data: {"i":1}\n\n', 'data: {"i":2}\n\n']);
		const response = await fetchImpl("https://upstream.test/v1/chat");
		expect(response.status).toBe(200);
		const events = await readSseEvents(response.body as ReadableStream<Uint8Array>);
		expect(events.map((event) => JSON.parse(event.data))).toEqual([{ i: 1 }, { i: 2 }]);
	});
});
