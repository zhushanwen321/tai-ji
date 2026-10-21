// stream.ts — WorkBuddy streamSimple 家族实装：请求组装 → globalThis.fetch →
// SSE 解析 → pi 标准事件流（经 wool-shared stream-adapter 骨架发事件）。
//
// 出站纪律（设计 D1）：统一 globalThis.fetch（network-proxy 包装层语义共享），
// 禁 undici/node:https 绕过。事件流纪律（start 先行/块平衡/单一终态）由骨架承担。

import type { Api, Message, Model, Tool } from "@earendil-works/pi-ai";

import type {
	WoolResolvedAuth,
	WoolStreamDriverContext,
	WoolStreamOutcome,
} from "@zhushanwen/pi-wool-shared";
import { parseSseStream } from "@zhushanwen/pi-wool-shared";

import { buildChatBody, encodeChatBody, parseToolArguments } from "./body.ts";
import { ARGUMENTS_DETAIL_MAX_CHARS, CHAT_PATH, ERROR_DETAIL_MAX_CHARS } from "./constants.ts";
import { buildChatHeaders } from "./headers.ts";
import { decodeJwtClaims } from "./jwt.ts";
import type { WorkbuddyRealm } from "./constants.ts";
import { realmConfig } from "./headers.ts";

/** 上游响应码语义（hub wb_proxy 实读：code==0 正常；非 0 为上游业务错误）。 */
type UpstreamEnvelope = {
	code?: number;
	msg?: string;
	message?: string;
	data?: unknown;
};

/** SSE chunk 的工具调用增量（OpenAI 形态）。 */
type StreamToolCallDelta = {
	index?: number;
	id?: string;
	type?: string;
	function?: { name?: string; arguments?: string };
};

type StreamChunk = {
	id?: string;
	choices?: Array<{
		delta?: {
			content?: string | null;
			reasoning_content?: string | null;
			tool_calls?: StreamToolCallDelta[];
		};
		finish_reason?: string | null;
	}>;
	usage?: Record<string, unknown>;
	error?: { message?: string; code?: unknown };
};

/** usage 字段族别名归一（hub normalize_usage_cache_aliases：多别名取最佳缓存值）。 */
function bestCachedTokens(usage: Record<string, unknown>): number {
	const candidates: unknown[] = [];
	const details = usage.prompt_tokens_details;
	if (typeof details === "object" && details !== null) {
		candidates.push((details as Record<string, unknown>).cached_tokens);
	}
	candidates.push(usage.cache_read_input_tokens, usage.cached_tokens, usage.prompt_cache_hit_tokens);
	let best = 0;
	for (const value of candidates) {
		if (typeof value === "number" && value > best) {
			best = value;
		}
	}
	return best;
}

/** 累计中的工具调用（按 delta.index 聚合）。 */
type AccumulatedToolCall = {
	id: string;
	name: string;
	argumentsRaw: string;
};

/** 从 access token 推 realm：JWT iss/domain 不可靠，默认 cn（任务书协议锚），按 domain 字段判 intl。 */
function realmFromAuth(domain: string | undefined): WorkbuddyRealm {
	return domain === realmConfig("intl").domain ? "intl" : "cn";
}

export type WorkbuddyStreamContext = {
	model: Model<Api>;
	systemPrompt: string;
	tools: Tool[];
	messages: Message[];
	resolvedAuth: WoolResolvedAuth;
	driver: WoolStreamDriverContext;
	/** 会话键（同一 pi 会话多轮复用 X-Conversation-ID；缺省按 uid 单会话）。 */
	conversationKey: string;
	/** 出站 fetch（测试注入；缺省经 globalThis.fetch 延迟解析——network-proxy 包装层生效语义）。 */
	fetchImpl?: typeof globalThis.fetch;
};

/**
 * 家族 stream 实装（defineWoolExtension 的 stream 参数）。
 * 异常全部上抛——骨架按 AbortError/signal 转 aborted/error 终态。
 */
export async function workbuddyStream(context: WorkbuddyStreamContext): Promise<WoolStreamOutcome> {
	const { resolvedAuth, driver } = context;
	if (!resolvedAuth.ok) {
		throw new Error(`WorkBuddy credentials unavailable: ${resolvedAuth.error}`);
	}
	const accessToken = resolvedAuth.apiKey ?? "";
	const claims = decodeJwtClaims(accessToken);
	const uid = typeof claims?.sub === "string" ? claims.sub : "";
	const domain = typeof claims?.domain === "string" ? claims.domain : undefined;
	const realm = realmFromAuth(domain);

	const headers = buildChatHeaders(realm, { accessToken, uid, domain }, {
		conversationKey: context.conversationKey,
		model: context.model.id,
	});
	const body = buildChatBody({
		model: context.model.id,
		systemPrompt: context.systemPrompt,
		messages: context.messages,
		tools: context.tools,
		temperature: undefined,
	});
	// onPayload 钩子收到对象形态（与 pi 内建 provider 的仪表语义一致），出站序列化紧凑 JSON。
	const outboundBody = await driver.onPayload(body);
	const doFetch = context.fetchImpl ?? ((...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args));

	const url = `${realmConfig(realm).chatUpstream}${CHAT_PATH}`;
	const response = await doFetch(url, {
		method: "POST",
		headers,
		body: encodeChatBody(outboundBody),
		signal: context.driver.signal,
	});
	await driver.onResponse({
		status: response.status,
		headers: Object.fromEntries(response.headers.entries()),
	});
	if (!response.ok || response.body === null) {
		const detail = await response.text().catch(() => "");
		throw new Error(`WorkBuddy chat request failed: HTTP ${response.status} ${detail.slice(0, ERROR_DETAIL_MAX_CHARS)}`);
	}

	driver.open();

	const toolCalls = new Map<number, AccumulatedToolCall>();
	let usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined;
	let stopReason: WoolStreamOutcome["stopReason"];
	let responseId: string | undefined;
	let sawDone = false;

	const flushToolCalls = (): void => {
		const indices = [...toolCalls.keys()].sort((a, b) => a - b);
		for (const index of indices) {
			const call = toolCalls.get(index);
			if (call === undefined) {
				continue;
			}
			const parsed = parseToolArguments(call.argumentsRaw);
			if (parsed === undefined) {
				throw new Error(`WorkBuddy tool call "${call.name}" returned non-object arguments: ${call.argumentsRaw.slice(0, ARGUMENTS_DETAIL_MAX_CHARS)}`);
			}
			driver.toolCall({ id: call.id, name: call.name, arguments: parsed });
		}
		toolCalls.clear();
	};

	for await (const event of parseSseStream(response.body, context.driver.signal)) {
		await driver.onProviderStreamEvent(event.data);
		if (event.data.trim() === "[DONE]") {
			sawDone = true;
			break;
		}
		let chunk: StreamChunk;
		try {
			chunk = JSON.parse(event.data) as StreamChunk;
		} catch {
			continue; // 非法 JSON 行按噪音丢弃（上游夹带的 keep-alive 文本）
		}
		if (chunk.error !== undefined) {
			throw new Error(`WorkBuddy stream error: ${chunk.error.message ?? "unknown"} (code ${String(chunk.error.code)})`);
		}
		if (chunk.id !== undefined) {
			responseId = chunk.id;
		}
		if (chunk.usage !== undefined && typeof chunk.usage === "object") {
			const prompt = chunk.usage.prompt_tokens;
			const completion = chunk.usage.completion_tokens;
			usage = {
				input: typeof prompt === "number" ? prompt : 0,
				output: typeof completion === "number" ? completion : 0,
				cacheRead: bestCachedTokens(chunk.usage),
				cacheWrite: 0,
			};
		}
		const choice = chunk.choices?.[0];
		if (choice === undefined) {
			continue;
		}
		const delta = choice.delta ?? {};
		if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
			driver.thinking(delta.reasoning_content);
		}
		if (typeof delta.content === "string" && delta.content.length > 0) {
			driver.text(delta.content);
		}
		for (const call of delta.tool_calls ?? []) {
			const index = call.index ?? 0;
			const existing = toolCalls.get(index);
			const id = call.id ?? existing?.id ?? `call_${index}`;
			// name 只在首块出现（空串不覆盖）；arguments 为增量拼接（OpenAI 形态）。
			const name = call.function?.name || existing?.name || "";
			const args = (existing?.argumentsRaw ?? "") + (call.function?.arguments ?? "");
			toolCalls.set(index, { id, name, argumentsRaw: args });
		}
		if (choice.finish_reason !== undefined && choice.finish_reason !== null && choice.finish_reason !== "") {
			flushToolCalls();
			stopReason =
				choice.finish_reason === "tool_calls"
					? "toolUse"
					: choice.finish_reason === "length"
						? "length"
						: "stop";
		}
	}
	if (!sawDone) {
		flushToolCalls();
	}
	if (usage === undefined) {
		// usage 尾 chunk 缺席（include_usage 失效或异常截断）：按 0 记账不阻断——
		// 流内容已完整产出，记账缺失是观测缺口而非对话失败。
		usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	}
	return {
		usage,
		...(stopReason !== undefined ? { stopReason } : {}),
		...(responseId !== undefined ? { responseId } : {}),
	};
}

/** 上游 JSON envelope 的业务错误提取（billing/OAuth 共用）。 */
export function upstreamErrorMessage(payload: UpstreamEnvelope, fallback: string): string { // oe-exempt:20261022:wip:billing/OAuth 共用的 envelope 错误提取——共用点接线提交后消费，暂零引用（30 天复检）
	if (typeof payload.msg === "string" && payload.msg.length > 0) {
		return payload.msg;
	}
	if (typeof payload.message === "string" && payload.message.length > 0) {
		return payload.message;
	}
	return fallback;
}
