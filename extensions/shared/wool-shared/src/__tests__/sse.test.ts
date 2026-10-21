// sse.test.ts — SSE 解析器：跨 chunk、多行 data、注释、BOM、流尾残留、abort 语义。

import { describe, expect, it } from "vitest";

import { parseSseStream, readSseEvents, sseBodyFromChunks, sseDataChunk } from "../sse.ts";

describe("parseSseStream", () => {
	it("标准 data 事件（含尾空行分发）", async () => {
		const events = await readSseEvents(sseBodyFromChunks([sseDataChunk({ a: 1 }), sseDataChunk({ a: 2 })]));
		expect(events.map((event) => JSON.parse(event.data))).toEqual([{ a: 1 }, { a: 2 }]);
	});

	it("跨 chunk 缓冲：一个事件被切成两块仍正确解析", async () => {
		const full = 'event: output\ndata: {"t":"he"}\n\ndata: {"t":"re"}\n\n';
		const events = await readSseEvents(sseBodyFromChunks([full.slice(0, 17), full.slice(17)]));
		expect(events).toHaveLength(2);
		expect(events[0].event).toBe("output");
		expect(events[0].data).toBe('{"t":"he"}');
		expect(events[1].data).toBe('{"t":"re"}');
	});

	it("Trae 式自定义事件（metadata/output/done）event 字段透传", async () => {
		const chunks = [
			'event: metadata\ndata: {"model":"deepseek-v4"}\n\n',
			'event: output\ndata: "hello"\n\n',
			'event: done\ndata: {"usage":{"input":3,"output":5}}\n\n',
		];
		const events = await readSseEvents(sseBodyFromChunks(chunks));
		expect(events.map((event) => event.event)).toEqual(["metadata", "output", "done"]);
	});

	it("多行 data 以 \\n 拼接；注释行与无 data 块不分发", async () => {
		const chunks = [": keep-alive\n\n", "data: line1\ndata: line2\n\n", "event: ping\n\n"];
		const events = await readSseEvents(sseBodyFromChunks(chunks));
		expect(events).toHaveLength(2);
		expect(events[0].data).toBe("line1\nline2");
		expect(events[1]).toEqual({ data: "", event: "ping" });
	});

	it("BOM 剥除与 \\r\\n 行终止", async () => {
		const events = await readSseEvents(sseBodyFromChunks(["﻿data: after-bom\r\n\r\n"]));
		expect(events.map((event) => event.data)).toEqual(["after-bom"]);
	});

	it("流尾残留（无结尾空行）按规范分发", async () => {
		const events = await readSseEvents(sseBodyFromChunks(["data: tail-event\n"]));
		expect(events.map((event) => event.data)).toEqual(["tail-event"]);
	});

	it("abort 信号使读取循环以 AbortError 终止", async () => {
		const controller = new AbortController();
		controller.abort();
		// 已 abort 的信号：解析器立即抛 AbortError（不吞取消语义）。
		const body = new ReadableStream<Uint8Array>({
			start() {
				// 永不 close：若解析器无视 abort 会挂死（测试经 timeout 暴露）。
			},
		});
		await expect(async () => {
			for await (const _event of parseSseStream(body, controller.signal)) {
				// 不应有事件产出
			}
		}).rejects.toMatchObject({ name: "AbortError" });
	});
});
