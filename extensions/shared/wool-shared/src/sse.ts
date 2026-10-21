// sse.ts — 通用 SSE（Server-Sent Events）解析器。
//
// 服务对象：三家上游的流式响应。通用 SSE（data:/event:/id: 行协议）与 Trae 的
// 自定义事件（event: metadata / event: output / event: done 等）都经本解析器——
// 解析器只负责「字节流 → 有边界事件」，语义映射（协议事件 → pi 标准事件流）归
// 各家族 streamSimple 实装（stream-adapter.ts 提供骨架）。
//
// 解析规则（SSE 规范子集，覆盖三家实测形态）：按行切（\n / \r\n / \r）；
// 字段 `field: value`（冒号后可选空格）；多行 data 以 \n 拼接；`:` 开头注释行跳过；
// 空行 = 事件分发边界；BOM 剥除。二进制安全：按 UTF-8 解码 + 跨 chunk 缓冲。

/** 单个 SSE 事件（未做语义解释）。event 缺省 = 默认 message 事件。 */
export interface SseEvent { // oe-exempt:20261022:framework:SSE 解析器产出事件契约——三家家族 stream（pi-wool-trae/src/stream.ts、pi-wool-qoder/src/chat-stream.ts、pi-wool-workbuddy/src/stream.ts）的 parseSseStream 消费循环按 event.event/event.data 字段访问
	/** event 字段值（如 Trae 的 metadata/output/done；通用 SSE 常缺省）。 */
	event?: string;
	/** data 载荷（多行已按 \n 拼接；未做 JSON 解析）。 */
	data: string;
	/** id 字段值（Last-Event-ID 语义，三家现役上游未用，保留字段）。 */
	id?: string;
}

/** 行切分器（跨 chunk 缓冲的可变 buffer 对象）。 */
function createLineSplitter(): { buffer: string } {
	return { buffer: "" };
}

/** 喂入文本块，产出完整行（不含行终止符）。 */
function pushChunk(splitter: { buffer: string }, chunk: string): string[] {
	splitter.buffer += chunk;
	const lines: string[] = [];
	// \r\n 与孤立 \r / \n 都按行终止符处理。
	const normalized = splitter.buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	let searchFrom = 0;
	let index = normalized.indexOf("\n", searchFrom);
	while (index !== -1) {
		lines.push(normalized.slice(searchFrom, index));
		searchFrom = index + 1;
		index = normalized.indexOf("\n", searchFrom);
	}
	splitter.buffer = normalized.slice(searchFrom);
	return lines;
}

/** 单字段行解析：`field: value`（value 前至多剥一个空格）；非法/注释行返回 null。 */
function parseFieldLine(line: string): { field: string; value: string } | null {
	if (line.length === 0) {
		return null;
	}
	if (line.startsWith(":")) {
		return null; // 注释行（SSE keep-alive 常见形态）
	}
	const colonIndex = line.indexOf(":");
	if (colonIndex === -1) {
		return { field: line, value: "" };
	}
	let value = line.slice(colonIndex + 1);
	if (value.startsWith(" ")) {
		value = value.slice(1);
	}
	return { field: line.slice(0, colonIndex), value };
}

/**
 * 流式解析 SSE 字节流为事件序列。
 *
 * - 跨 chunk 缓冲 + UTF-8 解码由 ReadableStream 的 TextDecoderStream 承担；
 * - abort 信号贯穿读取循环（signal aborted 即停止，不吞 abort 语义——上游是
 *   pi 传入的取消信号，必须让读取循环随之终止）；
 * - 流结束时若仍有未分发的事件（无结尾空行的最后一条事件），按规范分发。
 */
export async function* parseSseStream(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
	const splitter = createLineSplitter();
	let dataLines: string[] = [];
	let eventName: string | undefined;
	let eventId: string | undefined;

	const flush = (): SseEvent | undefined => {
		if (dataLines.length === 0 && eventName === undefined && eventId === undefined) {
			return undefined; // 纯注释/空行块不分发
		}
		const event: SseEvent = {
			data: dataLines.join("\n"),
			...(eventName !== undefined ? { event: eventName } : {}),
			...(eventId !== undefined ? { id: eventId } : {}),
		};
		dataLines = [];
		eventName = undefined;
		eventId = undefined;
		return event;
	};

	const reader = body.getReader();
	const decoder = new TextDecoder("utf-8");
	try {
		for (;;) {
			if (signal?.aborted) {
				throw new DOMException("SSE stream reading aborted", "AbortError");
			}
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			const text = decoder.decode(value, { stream: true }).replace(/^\uFEFF/, "");
			for (const line of pushChunk(splitter, text)) {
				if (line.length === 0) {
					const event = flush();
					if (event !== undefined) {
						yield event;
					}
					continue;
				}
				const field = parseFieldLine(line);
				if (field === null) {
					continue;
				}
				if (field.field === "data") {
					dataLines.push(field.value);
				} else if (field.field === "event") {
					eventName = field.value;
				} else if (field.field === "id") {
					eventId = field.value;
				}
				// retry 等其余字段：三家现役上游未用，忽略。
			}
		}
		// 流尾残留事件（上游未以空行收尾）按规范分发。
		decoder.decode();
		const tail = flush();
		if (tail !== undefined) {
			yield tail;
		}
	} finally {
		reader.releaseLock();
	}
}

/** 一次性收集全部事件（非流式消费形态；对照测试与草稿期探针用）。 */
export async function readSseEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<SseEvent[]> {
	const events: SseEvent[] = [];
	for await (const event of parseSseStream(body, signal)) {
		events.push(event);
	}
	return events;
}

/**
 * 把文本块序列构造为 SSE ReadableStream（对照测试的 fetch mock 与 echo 参考扩展用）。
 * 每个块按原样写入（块内自带完整 SSE 行文本），调用方负责事件行格式。
 */
export function sseBodyFromChunks(chunks: readonly string[]): ReadableStream<Uint8Array> {
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

/** 单事件 → SSE 文本块辅助（`data: <json>\n\n` 形态；测试 fixture 构造用）。 */
export function sseDataChunk(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}
