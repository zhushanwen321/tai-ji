// body.ts — pi transcript → WorkBuddy OpenAI 形态对话请求体。
//
// 上游形态（hub wb_proxy.build_upstream_body 实读）：OpenAI chat completions 兼容 +
// stream:true + stream_options.include_usage；官方客户端 JSON.stringify 紧凑序列化。
// assistant 思考块回传为 reasoning_content 扩展字段（上游 DeepSeek 族要求带此字段）。

import type { ImageContent, Message, TextContent, ThinkingContent, Tool, ToolCall } from "@earendil-works/pi-ai";

import type { JsonObject } from "@earendil-works/pi-ai";

/** OpenAI 形态消息（出站侧中间形态）。 */
export type OpenAiMessage =
	| { role: "system"; content: string }
	| { role: "user"; content: string | OpenAiContentPart[] }
	| { role: "assistant"; content: string | null; tool_calls?: OpenAiToolCall[]; reasoning_content?: string }
	| { role: "tool"; tool_call_id: string; content: string };

export type OpenAiContentPart =
	| { type: "text"; text: string }
	| { type: "image_url"; image_url: { url: string } };

export type OpenAiToolCall = {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
};

export type OpenAiToolSpec = {
	type: "function";
	function: { name: string; description: string; parameters: unknown };
};

/** 出站请求体形状（stream/stream_options 由组装层统一附加）。 */
export type WorkbuddyChatBody = {
	model: string;
	messages: OpenAiMessage[];
	tools?: OpenAiToolSpec[];
	tool_choice?: string | { type: "function"; function: { name: string } };
	temperature?: number;
	[k: string]: unknown;
};

function textOf(block: TextContent | ThinkingContent): string {
	return block.type === "text" ? block.text : block.thinking;
}

function userContent(
	content: string | (TextContent | ImageContent)[],
): string | OpenAiContentPart[] {
	if (typeof content === "string") {
		return content;
	}
	const parts: OpenAiContentPart[] = [];
	for (const block of content) {
		if (block.type === "text") {
			parts.push({ type: "text", text: block.text });
		} else {
			parts.push({
				type: "image_url",
				image_url: { url: `data:${block.mimeType};base64,${block.data}` },
			});
		}
	}
	return parts;
}

function assistantToolCalls(calls: ToolCall[]): OpenAiToolCall[] {
	return calls.map((call) => ({
		id: call.id,
		type: "function",
		function: { name: call.name, arguments: JSON.stringify(call.arguments) },
	}));
}

/** pi Message[] → OpenAI 消息数组（system 首条 = 折叠后的系统提示词）。 */
export function toOpenAiMessages(messages: Message[], systemPrompt: string): OpenAiMessage[] {
	const out: OpenAiMessage[] = [{ role: "system", content: systemPrompt }];
	let pendingToolResults: OpenAiMessage[] = [];
	const flushTools = (): void => {
		out.push(...pendingToolResults);
		pendingToolResults = [];
	};
	for (const message of messages) {
		switch (message.role) {
			case "system":
				continue; // 系统提示词已折叠进首条（normalizeContext 契约）
			case "user": {
				flushTools();
				out.push({ role: "user", content: userContent(message.content) });
				continue;
			}
			case "assistant": {
				flushTools();
				const textBlocks: string[] = [];
				const thinkingBlocks: string[] = [];
				const calls: ToolCall[] = [];
				for (const block of message.content) {
					if (block.type === "text" || block.type === "thinking") {
						(block.type === "text" ? textBlocks : thinkingBlocks).push(textOf(block));
					} else {
						calls.push(block);
					}
				}
				const content = textBlocks.join("");
				const entry: OpenAiMessage = {
					role: "assistant",
					content: content.length > 0 ? content : null,
				};
				if (calls.length > 0) {
					entry.tool_calls = assistantToolCalls(calls);
				}
				if (thinkingBlocks.length > 0) {
					entry.reasoning_content = thinkingBlocks.join("");
				}
				out.push(entry);
				continue;
			}
			case "toolResult": {
				// 工具结果紧跟其归属的 assistant 消息（顺序契约：normalizeContext 已保证）。
				const textParts: string[] = [];
				for (const block of message.content) {
					if (block.type === "text") {
						textParts.push(block.text);
					}
					// 图片结果以 data URL 形态进 tool content（上游 tool content 仅接受文本主形态）
					//——现役上游对 tool 消息图片支持未核实，带图结果降级为占位说明（保守路径）。
					else {
						textParts.push("[image tool result omitted]");
					}
				}
				pendingToolResults.push({
					role: "tool",
					tool_call_id: message.toolCallId,
					content: textParts.join("\n"),
				});
				continue;
			}
		}
	}
	flushTools();
	return out;
}

/** pi Tool[] → OpenAI function 声明。 */
export function toOpenAiTools(tools: readonly Tool[]): OpenAiToolSpec[] {
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		},
	}));
}

export type BuildChatBodyOptions = {
	model: string;
	systemPrompt: string;
	messages: Message[];
	tools: readonly Tool[];
	toolChoice?: string | { type: "function"; function: { name: string } };
	temperature?: number;
};

/** 组装完整请求体（含 stream/stream_options/紧凑 JSON 序列化入口）。 */
export function buildChatBody(options: BuildChatBodyOptions): WorkbuddyChatBody {
	const body: WorkbuddyChatBody = {
		model: options.model,
		messages: toOpenAiMessages(options.messages, options.systemPrompt),
	};
	const toolSpecs = toOpenAiTools(options.tools);
	if (toolSpecs.length > 0) {
		body.tools = toolSpecs;
		if (options.toolChoice !== undefined) {
			body.tool_choice = options.toolChoice;
		}
	}
	if (options.temperature !== undefined) {
		body.temperature = options.temperature;
	}
	body.stream = true;
	body.stream_options = { include_usage: true };
	return body;
}

/** 紧凑 JSON 序列化（官方 JSON.stringify 形态：无空白分隔）。入参 unknown：onPayload
 * 钩子可替换 payload 对象，序列化不限定出站前的具体形态。 */
export function encodeChatBody(body: unknown): string {
	return JSON.stringify(body);
}

/** 工具调用参数 JSON 解析（SSE 增量聚合完成后用；非法 JSON 返回 undefined 并保留原文）。 */
export function parseToolArguments(raw: string): JsonObject | undefined {
	if (raw.length === 0) {
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return undefined;
		}
		return parsed as JsonObject;
	} catch {
		return undefined;
	}
}
