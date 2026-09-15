/**
 * same-model 模式的 LLM 调用（D12 + D13-5 cache-key 一致性）。
 *
 * 不走 llm-shared callLLM：其 tools:[] 硬编码会破坏前缀缓存对齐（llm-shared call.ts）。
 * 此处直接用 completeSimple + getApiKeyAndHeaders，并把 tools schema 与主会话对齐
 * （deepseek-harness summarizer 同款做法：system + tools + messages 全部复用做缓存对齐）。
 *
 * cache-key 一致性约束（D13-5）：除末尾追加的压缩指令 user message 外，
 * systemPrompt / tools / messages 前缀与主会话完全一致；不设 maxTokens / reasoning 覆盖
 * （Claude Code 教训：单独设置 maxOutputTokens/thinking 会造成 cache-key mismatch 前缀全 miss）。
 */

import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { Context as LlmContext, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import type { Tool as LlmTool, Message, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";

/**
 * ToolInfo → pi-ai Tool 投影：三字段直取。parameters 是 typebox schema（主会话同源对象，
 * 序列化后与主请求一致——缓存对齐的关键是不改造、原样透传）。
 */
export function projectTools(toolInfos: readonly ToolInfo[]): LlmTool[] {
	return toolInfos.map((t) => ({
		name: t.name,
		description: t.description,
		parameters: t.parameters,
	}));
}

/** completeSimple 返回的宽松形状（消费 stopReason / usage / content text）。 */
interface SimpleResponseLike {
	stopReason?: string;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
	};
	content: ReadonlyArray<{ type: string; text?: string }>;
}

/**
 * same-model 调用结果（判别联合）：成功携带摘要文本与 usage；失败仅携带 error
 * （调用方走 D7 回退），stopReason 两态均可携带（length 截断 fail-closed / 排查用）。
 */
export type SameModelCallResult =
	| {
		ok: true;
		/** 摘要文本（content 内全部 text block 拼接，D13-10 只取 text）。 */
		text: string;
		/** provider usage（cacheRead 供 R8 探针验证缓存命中）。 */
		usage?: SimpleResponseLike["usage"];
		/** stopReason（length = max-tokens 截断，D13-2 fail-closed 判据）。 */
		stopReason?: string;
	}
	| {
		ok: false;
		error: string;
		stopReason?: string;
	};

export interface SameModelCallOptions {
	model: Model<never> | Model<string> | undefined;
	/** 会话原 system prompt（ctx.getSystemPrompt()——缓存对齐必要条件）。 */
	systemPrompt: string;
	/** 完整上下文 messages + 末尾已追加的压缩指令 message。 */
	messages: Message[];
	/** 主会话工具投影（缓存对齐）。 */
	tools: LlmTool[];
	signal?: AbortSignal;
	sessionId?: string;
	/** 工具投影与 LLM 调用的依赖注入（单测 mock 点）。 */
	deps?: {
		getApiKeyAndHeaders?: (model: Model<never> | Model<string>) => Promise<{ ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> } | { ok: false; error: string }>;
		call?: (model: Model<never> | Model<string>, context: LlmContext, options: SimpleStreamOptions) => Promise<SimpleResponseLike>;
	};
}

/**
 * content block 的 text 提取（in-guard：联合中 ThinkingContent/ToolCall 无 text 字段）。
 * 与 llm-shared extractText 刻意不同：不过滤 block type、join 用 "\n"——摘要需保留
 * 多段换行结构（extractText 过滤 type==="text" 且 join 空格，语义是单段纯文本）。
 */
function blockText(block: { type: string; text?: unknown }): string {
	return typeof block.text === "string" ? block.text : "";
}

/**
 * 发起 same-model 压缩调用。失败归一为 {ok:false, error}（调用方走 D7 回退），不抛错。
 * max-tokens 截断（stopReason === "length"）返回 ok:true + stopReason 由调用方 fail-closed。
 */
export async function callSameModelCompaction(
	ctx: ExtensionContext,
	opts: SameModelCallOptions,
): Promise<SameModelCallResult> {
	const deps = opts.deps ?? {};
	const getAuth = deps.getApiKeyAndHeaders ?? ((m: Model<never> | Model<string>) => ctx.modelRegistry.getApiKeyAndHeaders(m));
	const call = deps.call ?? ((m: Model<never> | Model<string>, c: LlmContext, o: SimpleStreamOptions) => completeSimple(m, c, o));
	try {
		if (!opts.model) {
			return { ok: false, error: "no current model" };
		}
		const auth = await getAuth(opts.model);
		if (!auth.ok) {
			return { ok: false, error: auth.error };
		}
		const context: LlmContext = {
			systemPrompt: opts.systemPrompt,
			messages: opts.messages,
			tools: opts.tools,
		};
		// cache-key 一致性（D13-5）：不设 maxTokens / reasoning / timeoutMs 覆盖——
		// 任何 cache-key 参数差异都使前缀缓存整体失效
		const options: SimpleStreamOptions = {
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			...(opts.signal ? { signal: opts.signal } : {}),
			...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
		};
		const resp = await call(opts.model, context, options);
		if (resp.stopReason === "error" || resp.stopReason === "aborted") {
			const errorText = resp.content.map(blockText).join(" ").trim();
			return { ok: false, error: errorText || `stopReason=${resp.stopReason}`, stopReason: resp.stopReason };
		}
		const text = resp.content.map(blockText).join("\n").trim();
		return { ok: true, text, usage: resp.usage, stopReason: resp.stopReason };
	} catch (error) {
		return { ok: false, error: toErrorMessage(error) };
	}
}
