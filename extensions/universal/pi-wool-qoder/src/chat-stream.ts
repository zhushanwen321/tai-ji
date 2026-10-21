// chat-stream.ts — streamSimple 协议翻译（Qoder SSE 信封 → pi 标准事件流）。
//
// 链路：组装请求体（chat-body）→ qoderEncode → COSY 签名头 → globalThis.fetch（D1
// 约束：统一走包装层）→ SSE 信封解包（参考实现 iter_inner_sse 同规则）→ 内层 OpenAI
// chunk 事件翻译（driver 发射；事件流纪律由 wool-shared createAssistantStream 骨架
// 承担）。start 事件在响应建立成功后发出（请求建立失败发生在 start 之前，骨架直接
// 以 error 终态）。

import type { WoolStreamDriverContext, WoolStreamOutcome } from "@zhushanwen/pi-wool-shared";
import { parseSseStream, WoolStreamAdapterError } from "@zhushanwen/pi-wool-shared";
import type { JsonObject, Message, Tool } from "@earendil-works/pi-ai";

import { buildQoderBody, lastUserPrompt, type QoderModelMeta } from "./chat-body.ts";
import { CHAT_PATH, GATEWAY_BASE_URL } from "./constants.ts";
import { qoderEncode } from "./encode.ts";
import type { QoderAuthStore } from "./credentials.ts";

/** 信封/HTTP 层语义常量（错误分类与截断口径）。 */
const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
/** 错误消息内上游响应摘录的最大长度（防长错误文本刷屏）。 */
const ERROR_DETAIL_LENGTH = 300;

/** 内层 OpenAI chunk 的工具调用增量形态。 */
type UpstreamToolCallDelta = {
	index?: number;
	id?: string;
	type?: string;
	function?: { name?: string; arguments?: string };
};

type UpstreamDelta = {
	content?: string | { type?: string; text?: string }[];
	reasoning_content?: string;
	tool_calls?: UpstreamToolCallDelta[];
};

type UpstreamChunk = {
	id?: string;
	choices?: { delta?: UpstreamDelta; finish_reason?: string }[];
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
		prompt_cache_hit_tokens?: number;
		prompt_tokens_details?: { cached_tokens?: number };
		completion_tokens_details?: { reasoning_tokens?: number };
	};
};

/** 信封形态（上游 SSE data 行：{headers, body, statusCodeValue}；body 为内层 chunk
 * JSON 字符串或 "[DONE]"）。 */
type OuterEnvelope = {
	statusCodeValue?: number | string;
	body?: unknown;
};

function parseJsonObject(line: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(line);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// 非 JSON 行（计时元数据等）按忽略处理——上游 event:finish 行不带 data 载荷。
		return undefined;
	}
	return undefined;
}

function envelopeStatus(envelope: OuterEnvelope): number | undefined {
	const status = envelope.statusCodeValue;
	if (typeof status === "number") {
		return status;
	}
	if (typeof status === "string" && status.length > 0) {
		const parsed = Number(status);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

/** 工具调用增量聚合器（hub aggregate_stream 口径：按 index 分组，id/name/arguments
 * 增量拼接）。流终态产出完整调用列表。 */
class ToolCallAggregator {
	private readonly calls = new Map<number, { id: string; name: string; arguments: string }>();

	absorb(deltas: UpstreamToolCallDelta[] | undefined): void {
		if (deltas === undefined) {
			return;
		}
		for (const delta of deltas) {
			const index = typeof delta.index === "number" ? delta.index : this.calls.size;
			const entry = this.calls.get(index) ?? { id: "", name: "", arguments: "" };
			if (typeof delta.id === "string" && delta.id.length > 0) {
				entry.id = delta.id;
			}
			if (typeof delta.function?.name === "string" && delta.function.name.length > 0) {
				entry.name += delta.function.name;
			}
			if (typeof delta.function?.arguments === "string") {
				entry.arguments += delta.function.arguments;
			}
			this.calls.set(index, entry);
		}
	}

	/** 终态产出：arguments 必须解析为对象（pi 协议要求 toolcall_end 时参数为有效
	 * 已解析输入）；解析失败抛错转 error 终态，不静默产出残缺调用。
	 * JSON.parse 的产物在值层面必然是合法 JSON 值——对象形态经 guard 后断言为
	 * JsonObject（运行时已排除 null/数组/原始值）。 */
	settle(): { id: string; name: string; arguments: JsonObject }[] {
		return [...this.calls.entries()]
			.sort(([a], [b]) => a - b)
			.filter(([, call]) => call.name.length > 0)
			.map(([, call]) => {
				let parsed: unknown;
				try {
					parsed = call.arguments.trim().length === 0 ? {} : JSON.parse(call.arguments);
				} catch (error) {
					throw new WoolStreamAdapterError(
						`qoder: tool call "${call.name}" has unparseable arguments: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
					throw new WoolStreamAdapterError(`qoder: tool call "${call.name}" arguments are not a JSON object`);
				}
				return { id: call.id, name: call.name, arguments: parsed as JsonObject };
			});
	}
}

function contentText(content: UpstreamDelta["content"]): string {
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
	}
	return "";
}

/** streamSimple drive 实装（scaffold WoolStreamImplementation 签名）。 */
export function createQoderDrive(options: {
	authStore: QoderAuthStore;
	/** fetch 注入点（测试 mock；生产 = globalThis.fetch）。 */
	fetchImpl?: typeof globalThis.fetch;
	/** 模型元数据反查（id → 目录 meta；缺省 = 快照内置）。 */
	lookupModelMeta?: (modelId: string) => QoderModelMeta | undefined;
}) {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	return async function drive(input: {
		model: { id: string };
		systemPrompt: string;
		messages: Message[];
		tools: Tool[];
		driver: WoolStreamDriverContext;
		maxTokens?: number;
	}): Promise<WoolStreamOutcome> {
		const { driver } = input;
		const state = options.authStore.current();
		if (state === undefined) {
			throw new Error("qoder: no credentials; run the provider login (extract) first");
		}
		const session = options.authStore.session();
		if (session === undefined) {
			throw new Error("qoder: credential has no user id; re-run the provider login");
		}
		const meta = options.lookupModelMeta?.(input.model.id) ?? {
			key: input.model.id,
			displayName: input.model.id,
			isVl: false,
			isReasoning: false,
			maxInputTokens: 0,
		};

		const { body, bodyText, modelKey } = buildQoderBody({
			systemPrompt: input.systemPrompt,
			messages: input.messages,
			tools: input.tools,
			modelMeta: meta,
			userIdentity: { userType: state.userType },
			prompt: lastUserPrompt(input.messages),
			maxTokens: input.maxTokens,
		});
		// 仪表钩子：pi 内建 provider 同款——请求发出前交给 onPayload（可替换）。
		const finalBody = (await driver.onPayload(body)) as Record<string, unknown> | undefined;
		const payloadText = finalBody === undefined ? bodyText : JSON.stringify(finalBody);
		const encodedBody = qoderEncode(new Uint8Array(Buffer.from(payloadText, "utf8")));

		const url = `${GATEWAY_BASE_URL}${CHAT_PATH}`;
		const response = await fetchImpl(url, {
			method: "POST",
			headers: session.headers(encodedBody, url, modelKey, true),
			body: encodedBody,
			signal: driver.signal,
		});
		await driver.onResponse({ status: response.status, headers: Object.fromEntries(response.headers.entries()) });
		if (!response.ok) {
			const detail = (await response.text()).slice(0, ERROR_DETAIL_LENGTH);
			// 401/403 = 凭据被拒（token 失效/风控），消息指向重新登录恢复动作。
			const rejected = response.status === HTTP_UNAUTHORIZED || response.status === HTTP_FORBIDDEN;
			const hint = rejected ? " (credential rejected; re-login the provider)" : "";
			throw new Error(`qoder chat upstream HTTP ${response.status}${hint}: ${detail}`);
		}
		if (response.body === null) {
			throw new Error("qoder chat upstream returned an empty body");
		}

		driver.open();

		const aggregator = new ToolCallAggregator();
		const usage: WoolStreamOutcome["usage"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		let stopReason: WoolStreamOutcome["stopReason"] = "stop";
		let responseId: string | undefined;
		let sawFinish = false;

		for await (const event of parseSseStream(response.body, driver.signal)) {
			if (driver.signal.aborted) {
				throw new Error("aborted");
			}
			const envelope = parseJsonObject(event.data);
			if (envelope === undefined) {
				continue;
			}
			await driver.onProviderStreamEvent(envelope);
			const status = envelopeStatus(envelope);
				if (status !== undefined && status !== HTTP_OK) {
					const detail = typeof envelope.body === "string" ? envelope.body : JSON.stringify(envelope);
					throw new Error(`qoder chat upstream envelope status ${status}: ${detail.slice(0, ERROR_DETAIL_LENGTH)}`);
				}
			if (envelope.body === "[DONE]") {
				break;
			}
			if (typeof envelope.body !== "string") {
				continue;
			}
			const chunk = parseJsonObject(envelope.body) as UpstreamChunk | undefined;
			if (chunk === undefined) {
				continue;
			}
			if (typeof chunk.id === "string" && chunk.id.length > 0) {
				responseId = chunk.id;
			}
			if (chunk.usage !== undefined) {
				usage.input = chunk.usage.prompt_tokens ?? usage.input;
				usage.output = chunk.usage.completion_tokens ?? usage.output;
				usage.cacheRead =
					chunk.usage.prompt_cache_hit_tokens ?? chunk.usage.prompt_tokens_details?.cached_tokens ?? usage.cacheRead;
			}
			for (const choice of chunk.choices ?? []) {
				const delta = choice.delta ?? {};
				const text = contentText(delta.content);
				if (text.length > 0) {
					driver.text(text);
				}
				if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
					driver.thinking(delta.reasoning_content);
				}
				aggregator.absorb(delta.tool_calls);
				if (choice.finish_reason === "length") {
					stopReason = "length";
					sawFinish = true;
				} else if (choice.finish_reason === "tool_calls") {
					stopReason = "toolUse";
					sawFinish = true;
				} else if (choice.finish_reason === "stop") {
					stopReason = "stop";
					sawFinish = true;
				}
			}
		}

		for (const call of aggregator.settle()) {
			driver.toolCall({ id: call.id, name: call.name, arguments: call.arguments });
		}
		if (!sawFinish) {
			// 上游断流未给 finish_reason：按 stop 终态收尾（内容已完整透传；
			// 显式留痕避免静默吞掉异常断流形态——usage 为零即是观测信号）。
			stopReason = "stop";
		}
		return { usage, stopReason, ...(responseId !== undefined ? { responseId } : {}) };
	};
}
