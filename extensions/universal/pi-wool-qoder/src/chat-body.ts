// chat-body.ts — pi 标准请求 → Qoder agent_chat_generation 上游请求体。
//
// 翻译自参考实现 build_qoder_body（shuishuipingan/qoder2api-hub v1.6.4）+ 官方
// baseprompt 骨架的顶层字段集：骨架字段全部保留（服务端按字段族校验），内容面
// （system prompt / 会话 / 工具）全部用 pi 回放结果——不抄官方 baseprompt 的提示词
// 与工具内容（pi 自己管理提示词，抄入反而双源）。
//
// 工具历史两形态（hub flatten_messages）：结构化直传（role:"tool" + tool_call_id，
// CN + 白名单模型 + id 齐备）与文本化降级（tool 结果降为 user 文本）。content 恒为
// 字符串而非 null（hub task-31：null 让上游转换层丢掉配对的 assistant 消息）。

import { randomUUID } from "node:crypto";

import type { Message, Tool } from "@earendil-works/pi-ai";

import { DEFAULT_CONTEXT_WINDOW, STRUCTURED_TOOL_HISTORY_PREFIXES } from "./constants.ts";
import { compactJson } from "./encode.ts";

const TOOL_RESULT_MARKER = "[工具结果";
const TOOL_RESULT_CLOSE = "[工具结果结束]";
/** business.name 会话名取 prompt 前 30 字符（hub build_qoder_body 同款截断）。 */
const BUSINESS_NAME_PROMPT_CHARS = 30;

/** 模型目录元数据（model/list 条目子集；model_config 与结构化判定用）。 */
export type QoderModelMeta = {
	key: string;
	displayName: string;
	isVl: boolean;
	isReasoning: boolean;
	maxInputTokens: number;
};

/** 文本内容提取：string 直取；块数组拼 text 块（image/thinking 块不进文本通道）。 */
function messageText(content: string | { type: string; text?: string }[]): string {
	if (typeof content === "string") {
		return content;
	}
	return content
		.map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
		.join("");
}

/** 结构化工具历史判定（hub structured_tool_history_enabled auto 模式同口径）：
 * 目录 key **或** 模型显示名命中白名单前缀（hub 对 model_key/model 两候选任一匹配——
 * 目录 key 形如 qfmodel 不带厂牌前缀，显示名 Qwen3.8-Flash 才是命中面），
 * 且全部 tool 结果与 assistant.tool_calls 的 id 齐备。 */
export function useStructuredToolHistory(modelKey: string, modelDisplayName: string, messages: Message[]): boolean {
	const candidates = [modelKey.trim().toLowerCase(), modelDisplayName.trim().toLowerCase()];
	const whitelisted = candidates.some(
		(candidate) => candidate.length > 0 && STRUCTURED_TOOL_HISTORY_PREFIXES.some((prefix) => candidate.startsWith(prefix)),
	);
	if (!whitelisted) {
		return false;
	}
	for (const message of messages) {
		if (message.role === "toolResult" && message.toolCallId.trim().length === 0) {
			return false;
		}
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall" && block.id.trim().length === 0) {
					return false;
				}
			}
		}
	}
	return true;
}

/** 上游 messages 序列（pi transcript → {role, content} 扁平会话）。 */
export function flattenMessages(messages: Message[], structured: boolean): { role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }[] {
	const flat: { role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }[] = [];
	for (const message of messages) {
		if (message.role === "system") {
			continue; // 系统提示词由 request.systemPrompt 统一承载（含增量回放），不逐条透传
		}
		if (message.role === "user") {
			flat.push({ role: "user", content: messageText(message.content) });
			continue;
		}
		if (message.role === "toolResult") {
			const body = messageText(message.content);
			if (structured) {
				// content 恒为字符串（空串而非 null/省略——hub task-31 实测 null 丢配对消息）。
				flat.push({ role: "tool", content: body, tool_call_id: message.toolCallId });
			} else {
				flat.push({ role: "user", content: `${TOOL_RESULT_MARKER}: ${message.toolName}]\n${body}\n${TOOL_RESULT_CLOSE}` });
			}
			continue;
		}
		if (message.role === "assistant") {
			let text = "";
			const toolCalls: { id: string; type: "function"; function: { name: string; arguments: string } }[] = [];
			for (const block of message.content) {
				if (block.type === "text") {
					text += block.text;
				} else if (block.type === "toolCall") {
					// arguments 统一为 JSON 字符串（OpenAI 规范形态；hub flatten 同口径）。
					toolCalls.push({
						id: block.id,
						type: "function",
						function: { name: block.name, arguments: compactJson(block.arguments) },
					});
				}
				// thinking 块不回传：上游仅 DeepSeek 族多轮一致性依赖该字段
				//（hub keep_reasoning=is_deepseek_model；Qwen 族带未知字段有拒答风险）。
			}
			flat.push({
				role: "assistant",
				content: text,
				...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
			});
		}
	}
	return flat;
}

/** pi 工具声明 → 上游嵌套 function 形态（上游要求 tools[].function 为对象，
 * 平铺形态 400：「'function' is a required property」，hub normalize_tools 注）。 */
export function toUpstreamTools(tools: Tool[]): { type: "function"; function: { name: string; description: string; parameters: unknown } }[] {
	return tools.map((tool) => ({
		type: "function" as const,
		function: {
			name: tool.name,
			description: tool.description ?? "",
			parameters: tool.parameters ?? { type: "object", properties: {} },
		},
	}));
}

/** 请求体组装（streamSimple 出站体的唯一构造点）。返回对象形态（onPayload 仪表钩子
 * 与测试断言用）+ 编码前文本。 */
export function buildQoderBody(options: {
	systemPrompt: string;
	messages: Message[];
	tools: Tool[];
	modelMeta: QoderModelMeta;
	userIdentity: { userType: string };
	prompt: string;
	maxTokens?: number;
	now?: number;
}): { body: Record<string, unknown>; bodyText: string; modelKey: string } {
	const meta = options.modelMeta;
	const structured = useStructuredToolHistory(meta.key, meta.displayName, options.messages);
	const flat = flattenMessages(options.messages, structured);
	const requestId = randomUUID();
	const now = options.now ?? Date.now();
	const prompt = options.prompt;

	const modelConfig = {
		key: meta.key,
		display_name: meta.displayName,
		model: "",
		format: "openai",
		is_vl: meta.isVl,
		is_reasoning: meta.isReasoning,
		api_key: "",
		url: "",
		source: "system",
		max_input_tokens: meta.maxInputTokens > 0 ? meta.maxInputTokens : DEFAULT_CONTEXT_WINDOW,
	};

	const messages = [
		{
			role: "system",
			content: options.systemPrompt,
			// 官方骨架的 system 占位字段（response_meta/reasoning_content_signature）——
			// 字段族完整性保留，值恒空（hub baseprompt 同形态）。
			response_meta: { id: "", usage: {} },
			reasoning_content_signature: "",
		},
		...flat,
	];

	const body: Record<string, unknown> = {
		request_id: requestId,
		request_set_id: randomUUID(),
		chat_record_id: requestId,
		session_id: randomUUID(),
		stream: true,
		chat_task: "FREE_INPUT",
		chat_context: {
			chatPrompt: "",
			extra: {
				context: [] as unknown[],
				modelConfig,
				originalContent: { type: "text", text: prompt },
			},
			features: [] as unknown[],
			imageUrls: null,
			text: { type: "text", text: prompt },
		},
		image_urls: null,
		is_reply: true,
		is_retry: false,
		code_language: "",
		source: 1,
		version: "3",
		chat_prompt: "",
		parameters: {
			...(options.maxTokens !== undefined && options.maxTokens > 0 ? { max_tokens: options.maxTokens } : {}),
		},
		aliyun_user_type: options.userIdentity.userType || "personal_professional_trial",
		session_type: "qodercli",
		agent_id: "agent_common",
		task_id: "common",
		model_config: modelConfig,
		messages,
		tools: toUpstreamTools(options.tools),
		business: {
			product: "cli",
			version: "0.1.43",
			type: "agent",
			id: randomUUID(),
			name: (prompt.slice(0, BUSINESS_NAME_PROMPT_CHARS) || "chat"),
			begin_at: now,
			stage: "start",
		},
	};
	// body 已注记 Record<string, unknown>（对象字面量宽化赋值，无断言链）。
	return { body, bodyText: compactJson(body), modelKey: meta.key };
}

/** 末条 user 提示词（chat_context 高亮 + business 会话名；hub build_qoder_body 同款）。 */
export function lastUserPrompt(messages: Message[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "user") {
			const text = messageText(message.content);
			if (text.length > 0) {
				return text;
			}
		}
	}
	return "";
}
