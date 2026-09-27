/**
 * LLM 调用封装：completeSimple + 凭证注入 + 文本提取 + 错误归一化。
 *
 * import 方式：顶层【静态】import completeSimple。
 * 探针①（2026-08-12，pi 0.84.0）实测：pi extension loader 加载含顶层
 * `import { completeSimple } from "@earendil-works/pi-ai/compat"` 的 extension 不 throw，
 * typeof completeSimple === "function"。compat.js 本身是真实模块（非 throwing stub），
 * rename-session/llm.ts 旧注释「加载阶段 compat 是 throwing stub」已过时（其代码用 import type +
 * 动态 import，从未真正测过顶层静态运行时 import）。故本库用静态 import，更简单且 tree-shake 友好。
 *
 * 凭证：getApiKeyAndHeaders 返回判别联合 ResolvedRequestAuth，必须 `if(!auth.ok) return` narrow
 * 后才能取 apiKey/headers/env（否则 TS 报错、运行时 auth.error 不存在）。
 */

// 顶层静态 import —— 探针①已验证加载阶段不 throw（见模块注释）
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type {
	Context as LlmContext,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import type { Api, Message, Model, ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord, toErrorMessage } from "@zhushanwen/pi-ext-guards";

// ──────────────────────── 类型 ────────────────────────

/** callLLM 入参。tools 不在此 —— callLLM 内部显式传 tools:[] 给 Context（不塞工具，best-effort 语义）。 */
export interface CallLLMOptions {
	/** resolveModel 返回的 Model 对象（不是字符串）。 */
	model: Model<Api>;
	/** 独立 system prompt，调用方负责构造（不复用 ctx.getSystemPrompt）。 */
	systemPrompt: string;
	/** pi-ai Message[]（对话历史 + 当前指令）。 */
	messages: Message[];
	maxTokens?: number;
	signal?: AbortSignal;
	timeoutMs?: number;
	/** 透传给 SimpleStreamOptions.sessionId（provider 用于 session 缓存 / 路由）。review TF1 新增。 */
	sessionId?: string;
	/**
	 * thinking/reasoning 级别，透传给 SimpleStreamOptions.reasoning。值域源自 pi 的
	 * ThinkingLevel 类型（pi-ai：ThinkingLevel = minimal/low/medium/high/xhigh/max，
	 * ModelThinkingLevel = "off" | ThinkingLevel；pi 无 THINKING_ORDER 符号——该常量的
	 * SSOT 在本仓 subagent-core src/shared/model-ref.ts，值集与本类型一致）。"off" 表示
	 * 关闭 thinking，由本库映射为「不传 reasoning 字段」（provider 默认行为）；不传 = 同样
	 * provider 默认。
	 */
	reasoning?: ModelThinkingLevel;
}

/**
 * callLLM 出参。
 * - ok:true → content 为提取并 trim 的文本；usage 为 completeSimple 响应的 resp.usage 透传
 *   （可选，存在才带——usage 整体缺失时不带字段，「跳过落账」语义由调用方处理，如
 *   rename-session 的 appendEntry 存在性守卫；permission classifier 等既有调用方不消费，零影响）。
 * - ok:false → stopReason 是独立透传字段（失败原因维度），供调用方保留
 *   error/aborted 的日志区分（如 permission classifier 的 G3 语义）。
 */
export type CallLLMResult =
	| { ok: true; content: string; usage?: Usage }
	| { ok: false; error: string; stopReason?: "error" | "aborted" };

// ──────────────────────── 文本提取 ────────────────────────

/** 类型谓词：content 数组元素是否为 text block（text 字段可缺失，拼接时按 "" 处理）。 */
function isTextBlock(block: unknown): block is { type: string; text?: string } {
	return isRecord(block) && block.type === "text";
}

/**
 * unknown 安全的 text block 拼接内核：过滤 `type==="text"` 的 block 并 `join(" ")`（不 trim）。
 *
 * 非数组输入（含 undefined / 非法 block 元素）安全返回 ""，供消费方对任意 LLM 响应/会话
 * entry 形状直接调用（ext-simplify-17 D7——rename-session 等包的本地 joinTextBlocks 副本收敛于此）。
 * trim 是调用方策略（extractText trim，其余调用方自定），内核不含。
 */
export function joinTextBlocks(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter(isTextBlock)
		.map((block) => block.text ?? "")
		.join(" ");
}

/**
 * 从 AssistantMessage.content 提取所有 text block 拼接并 trim。
 *
 * 参数用结构类型（不直接依赖 AssistantMessage），便于测试 mock —— 调用方传 completeSimple 返回值即可。
 * 无 text block（如纯 ThinkingContent / ToolCall）→ 返回 ""。
 * trim 契约不变：内部委托 joinTextBlocks 内核再 trim（ext-simplify-17 D7，行为等价由等价探针验证）。
 */
export function extractText(resp: {
	content: ReadonlyArray<{ type: string; text?: string }>;
}): string {
	return joinTextBlocks(resp.content).trim();
}

// ──────────────────────── 调用 ────────────────────────

/**
 * 发起一次 LLM 调用（completeSimple），返回归一化结果。
 *
 * 流程：
 * 1. 凭证：getApiKeyAndHeaders(model) → narrow（auth.ok 判别联合）→ 返回 {ok:false} 提前返回；
 *    reject（抛异常，非返回 {ok:false}）也落入步骤 5（B5：凭证注入与 completeSimple 同处 try，
 *    保证 reject 归一为 {ok:false}，调用方日志前缀一致）
 * 2. 调用：completeSimple(model, {systemPrompt, messages, tools:[]}, {apiKey, headers?, env?, signal?, maxTokens?, timeoutMs?, sessionId?})
 * 3. 检查 resp.stopReason：error/aborted（completeSimple 对错误/中止也 resolve 带 stopReason，G3）
 *    → {ok:false, error: 提取错误文本, stopReason}（不再当正常内容提取）
 * 4. 提取 text → {ok:true, content}；resp.usage 存在则一并透传（条件 spread，缺失时不带字段——
 *    AssistantMessage.usage 类型必填但运行时 provider 可能不回，P-usage-shape 的降级分支）
 * 5. throw（getApiKeyAndHeaders reject / 网络 / 超时 / 解析）→ catch → {ok:false, error:String(e)}
 *    （stopReason 不设——错误原因不可知）
 *
 * tools 显式传 []（不塞工具）—— 本库用于标题生成等 best-effort 场景，不需要工具调用。
 */
export async function callLLM(
	ctx: ExtensionContext,
	opts: CallLLMOptions,
): Promise<CallLLMResult> {
	// 整个流程纳入 try：getApiKeyAndHeaders / completeSimple 任一 reject/throw 都归一为
	// {ok:false}，保证调用方日志前缀一致（B5：凭证注入原在 try 外，reject 时
	// callLLM 直接 reject，上游走外层 .catch 输出不一致前缀，如 [pi-rename-session] 而非 [rename-session]）。
	try {
		// 1. 凭证（判别联合必须 narrow）：返回 {ok:false} → 提前返回；reject（抛异常）→ 进 catch
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(opts.model);
		if (!auth.ok) {
			return { ok: false, error: auth.error };
		}

		// 2. 调用 completeSimple（字段名经探针⑤对齐：Context{systemPrompt?,messages,tools?},
		//    SimpleStreamOptions extends StreamOptions{apiKey?,headers?,env?,signal?,maxTokens?,timeoutMs?,sessionId?}）
		const context: LlmContext = {
			systemPrompt: opts.systemPrompt,
			messages: opts.messages,
			tools: [],
		};
		// apiKey/headers/env 来自 auth（即使 undefined 也传，让 completeSimple 用默认）；
		// signal/maxTokens/timeoutMs/sessionId 条件 spread（不设置则不传，保留 completeSimple 默认）。
		const options: SimpleStreamOptions = {
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			...(opts.signal ? { signal: opts.signal } : {}),
			...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
			...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
			...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
			...(opts.reasoning && opts.reasoning !== "off" ? { reasoning: opts.reasoning } : {}),
		};
		const resp = await completeSimple(opts.model, context, options);
		// G3/C1a：completeSimple 对 error/aborted 也 resolve（带 stopReason，不 reject）。
		// 归一为 ok:false + stopReason 独立透传。
		if (resp.stopReason === "error" || resp.stopReason === "aborted") {
			const errorText = extractText(resp) || "unknown error";
			return { ok: false, error: errorText, stopReason: resp.stopReason };
		}
		return {
			ok: true,
			content: extractText(resp),
			// additive（设计 §3.3 ②）：透传 resp.usage，存在才带；缺失时整体不带字段
			...(resp.usage ? { usage: resp.usage } : {}),
		};
	} catch (error) {
		return { ok: false, error: toErrorMessage(error) };
	}
}
