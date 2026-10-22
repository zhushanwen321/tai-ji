// testing/harness.ts — 三家 streamSimple 对照测试 harness（fixture 驱动）。
//
// 用途：家族扩展包（u-qoder/u-trae/u-workbuddy）的协议翻译测试统一基建——
// 输入 = 协议原始事件 fixture（上游 SSE 文本块序列），被测 = 家族协议翻译函数
// （经 createAssistantStream 骨架，与生产 streamSimple 同一执行路径），断言 =
// pi 事件序列语义（对照 pi 官方 provider 行为基准：pi-ai types.d.ts 事件协议
// 注释 + custom-provider.md「Test the integration」清单）。
//
// 家族测试用法：
//   const events = await runStreamCase({
//     model: echoTestModel(),
//     fetchImpl: mockSseFetch(fixture.chunks),   // 家族 stream 内 fetch 指向 mock
//     drive: (driver, ctx) => familyTranslate({ ...ctx, driver }),
//   });
//   assertConformantSequence(events);
//   expectTextOutcome(events, "回显全文");
//
// 骨架自身的结构纪律由本包 __tests__ 直接覆盖；家族 fixture 只需断言协议翻译
// 语义（文本拼接/工具调用/错误映射/usage）。

import type {
	Api,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";

import { createAssistantStream, type WoolStreamDriverContext, type WoolStreamOutcome } from "../stream-adapter.ts";

/** 消费事件流，收集全部事件（终态事件含在内）。 */
export async function collectAssistantEvents(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

/** 事件序列语义断言失败（消息带差异明细，测试可读）。 */
export class WoolConformanceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WoolConformanceError";
	}
}

function eventSummary(event: AssistantMessageEvent): string {
	if (event.type === "text_delta") {
		return `text_delta(${JSON.stringify(event.delta)})`;
	}
	if (event.type === "done") {
		return `done(${event.reason})`;
	}
	if (event.type === "error") {
		return `error(${event.reason}, ${JSON.stringify(event.error.errorMessage)})`;
	}
	return event.type;
}

/**
 * pi 事件流协议的结构纪律断言（对照 pi 官方 provider 行为基准）：
 * - start 恰一个且是第一个事件；
 * - 终态恰一个（done 或 error）且是最后一个事件；
 * - text/thinking/toolcall 的 start..<end> 成对、不嵌套、终态前全部闭合；
 * - done 的 message usage.totalTokens = input+output+cacheRead+cacheWrite；
 * - error/abort 终态必须带 errorMessage。
 */
export function assertConformantSequence(events: readonly AssistantMessageEvent[]): void {
	if (events.length === 0) {
		throw new WoolConformanceError("empty event sequence: expected start..(content)..done/error");
	}
	if (events[0].type !== "start") {
		throw new WoolConformanceError(`first event must be start, got ${events[0].type}`);
	}
	const starts = events.filter((event) => event.type === "start");
	if (starts.length !== 1) {
		throw new WoolConformanceError(`expected exactly one start, got ${starts.length}`);
	}
	const terminals = events.filter((event) => event.type === "done" || event.type === "error");
	if (terminals.length !== 1) {
		throw new WoolConformanceError(
			`expected exactly one terminal (done|error), got ${terminals.length}: ${terminals.map(eventSummary).join(", ")}`,
		);
	}
	const terminal = terminals[0];
	if (events[events.length - 1] !== terminal) {
		throw new WoolConformanceError(`terminal event must be last, got ${eventSummary(events[events.length - 1])}`);
	}

	const openBlocks = new Set<string>();
	for (const [index, event] of events.entries()) {
		const checkBlock = (kind: "text" | "thinking" | "toolcall", phase: "start" | "end"): void => {
			if (phase === "start") {
				if (openBlocks.has(kind)) {
					throw new WoolConformanceError(`${kind}_start at #${index} while a ${kind} block is already open`);
				}
				openBlocks.add(kind);
			} else {
				if (!openBlocks.has(kind)) {
					throw new WoolConformanceError(`${kind}_end at #${index} without a preceding ${kind}_start`);
				}
				openBlocks.delete(kind);
			}
		};
		switch (event.type) {
			case "text_start":
				checkBlock("text", "start");
				break;
			case "text_end":
				checkBlock("text", "end");
				break;
			case "thinking_start":
				checkBlock("thinking", "start");
				break;
			case "thinking_end":
				checkBlock("thinking", "end");
				break;
			case "toolcall_start":
				checkBlock("toolcall", "start");
				break;
			case "toolcall_end":
				checkBlock("toolcall", "end");
				break;
			case "done": {
				const { usage } = event.message;
				const sum = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
				if (usage.totalTokens !== sum) {
					throw new WoolConformanceError(
						`done usage.totalTokens (${usage.totalTokens}) != input+output+cacheRead+cacheWrite (${sum})`,
					);
				}
				break;
			}
			case "error":
				if (!event.error.errorMessage) {
					throw new WoolConformanceError("error terminal without errorMessage");
				}
				break;
			default:
				break;
		}
	}
	if (openBlocks.size > 0) {
		throw new WoolConformanceError(`block(s) left open at terminal: ${[...openBlocks].join(", ")}`);
	}
}

/** 文本产出断言：全部 text_delta 拼接 === expected（增量语义对照）。 */
export function expectTextOutcome(events: readonly AssistantMessageEvent[], expected: string): void {
	const text = events
		.filter((event): event is Extract<AssistantMessageEvent, { type: "text_delta" }> => event.type === "text_delta")
		.map((event) => event.delta)
		.join("");
	if (text !== expected) {
		throw new WoolConformanceError(
			`text mismatch:\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(text)}`,
		);
	}
}

/** 工具调用产出断言：恰一个 toolcall_end 且 name/arguments 逐项匹配。 */
export function expectToolCallOutcome(
	events: readonly AssistantMessageEvent[],
	expected: { name: string; arguments: Record<string, unknown> },
): void {
	const ends = events.filter(
		(event): event is Extract<AssistantMessageEvent, { type: "toolcall_end" }> => event.type === "toolcall_end",
	);
	if (ends.length !== 1) {
		throw new WoolConformanceError(`expected exactly one toolcall_end, got ${ends.length}`);
	}
	const call = ends[0].toolCall;
	if (call.name !== expected.name) {
		throw new WoolConformanceError(`toolcall name mismatch: expected ${expected.name}, got ${call.name}`);
	}
	for (const [key, value] of Object.entries(expected.arguments)) {
		if (JSON.stringify(call.arguments[key]) !== JSON.stringify(value)) {
			throw new WoolConformanceError(
				`toolcall argument "${key}" mismatch: expected ${JSON.stringify(value)}, got ${JSON.stringify(call.arguments[key])}`,
			);
		}
	}
}

/** 错误终态断言：reason=error 且 errorMessage 含期望片段。 */
export function expectErrorOutcome(events: readonly AssistantMessageEvent[], messageIncludes: string): void {
	const terminal = events[events.length - 1];
	if (terminal === undefined || terminal.type !== "error") {
		throw new WoolConformanceError(`expected error terminal, got ${terminal === undefined ? "empty" : terminal.type}`);
	}
	if (terminal.reason !== "error") {
		throw new WoolConformanceError(`expected reason "error", got "${terminal.reason}"`);
	}
	if (!terminal.error.errorMessage?.includes(messageIncludes)) {
		throw new WoolConformanceError(
			`errorMessage ${JSON.stringify(terminal.error.errorMessage)} does not include ${JSON.stringify(messageIncludes)}`,
		);
	}
}

/** abort 断言：reason=aborted 且带 errorMessage。 */
export function expectAbortOutcome(events: readonly AssistantMessageEvent[]): void {
	const terminal = events[events.length - 1];
	if (terminal === undefined || terminal.type !== "error") {
		throw new WoolConformanceError(`expected abort terminal, got ${terminal === undefined ? "empty" : terminal.type}`);
	}
	if (terminal.reason !== "aborted") {
		throw new WoolConformanceError(`expected reason "aborted", got "${terminal.reason}"`);
	}
	if (!terminal.error.errorMessage) {
		throw new WoolConformanceError("abort terminal without errorMessage");
	}
}

/** usage 断言：done 终态的 message.usage 与期望一致。 */
export function expectUsageOutcome(
	events: readonly AssistantMessageEvent[],
	expected: { input: number; output: number },
): void {
	const done = events.find((event): event is Extract<AssistantMessageEvent, { type: "done" }> => event.type === "done");
	if (done === undefined) {
		throw new WoolConformanceError("expected a done event for usage assertion");
	}
	const { usage } = done.message;
	if (usage.input !== expected.input || usage.output !== expected.output) {
		throw new WoolConformanceError(
			`usage mismatch: expected input=${expected.input} output=${expected.output}, got input=${usage.input} output=${usage.output}`,
		);
	}
}

/** runStreamCase 的输入：骨架执行环境 + 家族协议翻译函数。 */
export interface WoolStreamCaseInput { // oe-exempt:20261022:framework:对照 harness 用例输入形状——三家家族 conformance 测试（trae/workbuddy stream-conformance.test.ts、qoder chat-stream.test.ts）的 runStreamCase 入口契约
	model: Model<Api>;
	/**
	 * 家族协议翻译函数：driver 即骨架发射上下文。家族内经 ctx.driver 拿发射辅助、
	 * 经注入的 fetchImpl 发请求（生产代码经 globalThis.fetch，测试替换该入口）。
	 */
	drive: (driver: WoolStreamDriverContext) => Promise<WoolStreamOutcome>;
	prompt?: string;
	signal?: AbortSignal;
	options?: SimpleStreamOptions;
}

/**
 * 运行一个家族对照用例：createAssistantStream 骨架 + 家族 drive → 收集事件序列。
 * 与生产 streamSimple 同一执行路径（scaffold.streamSimple 内部就是 createAssistantStream）。
 */
export async function runStreamCase(input: WoolStreamCaseInput): Promise<AssistantMessageEvent[]> {
	const created = createAssistantStream({
		model: input.model,
		signal: input.signal ?? new AbortController().signal,
		options: input.options,
		drive: input.drive,
	});
	return collectAssistantEvents(created);
}

/** transcript 构造入口（家族测试需要多轮消息时用，normalizeContext 是唯一合法入口）。 */
export { normalizeContext as buildTranscriptContext } from "@earendil-works/pi-ai";

/** HTTP 200（mockSseFetch 缺省状态码）。 */
const HTTP_OK = 200;

/** fetch mock：返回以给定文本块为 body 的 Response（家族 fetch 替换注入用）。 */
export function mockSseFetch(chunks: readonly string[], init?: { status?: number }): typeof globalThis.fetch {
	const body = sseChunksToBody(chunks);
	const status = init?.status ?? HTTP_OK;
	const fetchImpl = async (
		_input: Parameters<typeof globalThis.fetch>[0],
		_init?: Parameters<typeof globalThis.fetch>[1],
	): Promise<Response> =>
		new Response(body, { status });
	return fetchImpl;
}

function sseChunksToBody(chunks: readonly string[]): ReadableStream<Uint8Array> {
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
