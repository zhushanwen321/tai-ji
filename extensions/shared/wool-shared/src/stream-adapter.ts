// stream-adapter.ts — 协议无关的 streamSimple 事件流骨架。
//
// 纪律来源：pi 1.0.0 官方 custom-provider 文档 + pi-ai types.d.ts 事件协议注释
// （已读实装核实）。自定义流必须：
// 1. 创建 assistant message（provider/model/timestamp/pending stopReason/content[]/usage 清零）；
// 2. 请求建立成功后发一个 start，且在一切内容事件之前；
// 3. 内容事件与消息内容块更新平衡（partial 暴露同份状态）；
// 4. 终态前固化 usage/cost/content/stopReason；
// 5. 恰好一个终态 done 或 error，然后流结束；
// 6. 取消转换为 aborted 结果。
// 请求建立失败可发生在 start 之前——此时流直接以 error 终态（不发 start）。
//
// 家族差异只写在 drive 函数（协议翻译），事件流纪律全部由骨架承担——
// 三家不再各自搭事件流框架（对照 harness 对骨架统一断言）。

import {
	calculateCost,
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type JsonObject,
	type Model,
	type SimpleStreamOptions,
	type ToolCall,
	type Usage,
} from "@earendil-works/pi-ai";

/** 内容块索引越界等骨架内部不一致：fail-fast（骨架 bug 不许静默产出错序事件流）。 */
export class WoolStreamAdapterError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WoolStreamAdapterError";
	}
}

/** 家族 drive 函数的正常产出：终态语义（usage 必填，stopReason 缺省 "stop"）。 */
export interface WoolStreamOutcome { // oe-exempt:20261022:framework:家族 drive 返回契约——三家 stream 实装（pi-wool-trae/src/stream.ts、pi-wool-qoder/src/chat-stream.ts、pi-wool-workbuddy/src/stream.ts）与 workbuddy index.ts streamAdapter 按名导入，scaffold WoolStreamImplementation 与对照 harness 同型消费
	usage: Omit<Usage, "cost" | "totalTokens"> & { totalTokens?: number };
	stopReason?: "stop" | "length" | "toolUse";
	/** 上游响应 id（透传记录，缺省不写）。 */
	responseId?: string;
}

/** 交给家族 drive 函数的发射上下文。 */
export interface WoolStreamDriverContext { // oe-exempt:20261022:framework:家族 drive 发射上下文契约——三家 stream 实装（trae/qoder/workbuddy，均按名导入）+ scaffold WoolStreamRequest.driver 字段 + 对照 harness drive 签名消费
	model: Model<Api>;
	signal: AbortSignal;
	/**
	 * 请求建立成功后调用一次（发 start）。未调用 open 就返回 outcome 属骨架误用，
	 * fail-fast——「start 在内容事件之前」是协议硬约束，静默补发会掩盖家族实装 bug。
	 */
	open(): void;
	/** 追加文本块并发射增量。 */
	text(delta: string): void;
	/** 追加 thinking 块并发射增量。 */
	thinking(delta: string): void;
	/**
	 * 追加完整工具调用（arguments 必须已是解析后的对象——pi 协议要求 toolcall_end
	 * 时参数为有效已解析输入）。参数含 undefined 字段会被剥除以保 JsonObject 形状。
	 */
	toolCall(call: { id: string; name: string; arguments: JsonObject }): void;
	/**
	 * 发请求前调用：把请求体交给 options.onPayload，返回其替换结果（未配置钩子时
	 * 原样返回）。不调用 = 与 pi 内建 provider 行为分叉（仪表钩子失效），禁止。
	 */
	onPayload(payload: unknown): Promise<unknown>;
	/**
	 * 收到响应后、消费 body 前调用（options.onResponse 透传）。
	 */
	onResponse(response: { status: number; headers: Record<string, string> }): Promise<void>;
	/** 解析出上游流事件后调用（options.onProviderStreamEvent 透传）。 */
	onProviderStreamEvent(data: unknown): Promise<void>;
}

function zeroedUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** JSON 对象剥除 undefined 值（浅层；家族 arguments 正常不含嵌套 undefined）。 */
function toJsonObject(input: JsonObject): JsonObject {
	const output: JsonObject = {};
	for (const [key, value] of Object.entries(input)) {
		if (value !== undefined) {
			output[key] = value;
		}
	}
	return output;
}

/**
 * 组装一个符合 pi 事件流协议的 AssistantMessageEventStream。
 * 家族 streamSimple 的标准实装形态：`return createAssistantStream({ model, signal, options, drive })`。
 */
export function createAssistantStream(skeleton: {
	model: Model<Api>;
	signal: AbortSignal;
	options?: SimpleStreamOptions;
	/** 家族协议翻译驱动。 */
	drive(ctx: WoolStreamDriverContext): Promise<WoolStreamOutcome>;
}): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const { model, signal, options } = skeleton;

	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: zeroedUsage(),
		stopReason: "pending",
		timestamp: Date.now(),
	};

	let opened = false;
	let finalized = false;

	const push = (event: AssistantMessageEvent): void => {
		stream.push(event);
	};

	// 开放内容块跟踪：pi 事件协议要求 text/thinking 块以 authoritative *_end 收尾
	//（pi-ai types.d.ts：「grow only through their corresponding *_delta events until
	// the authoritative *_end」）。内建 provider 的模式（openai-completions.js
	// finishBlock :471-473）：流终态前统一闭合全部块。骨架对全部终态路径
	//（done/error/abort）执行同一闭合，保证事件流平衡。
	type OpenBlockKind = "text" | "thinking";
	let openBlock: { kind: OpenBlockKind; contentIndex: number } | undefined;

	const closeOpenBlock = (): void => {
		if (openBlock === undefined) {
			return;
		}
		const { kind, contentIndex } = openBlock;
		const block = message.content[contentIndex];
		if (block === undefined) {
			throw new WoolStreamAdapterError(`open ${kind} block missing at index ${contentIndex}`);
		}
		if (kind === "text") {
			if (block.type !== "text") {
				throw new WoolStreamAdapterError(`open text block content mismatch at index ${contentIndex}`);
			}
			push({ type: "text_end", contentIndex, content: block.text, partial: message });
		} else {
			if (block.type !== "thinking") {
				throw new WoolStreamAdapterError(`open thinking block content mismatch at index ${contentIndex}`);
			}
			push({ type: "thinking_end", contentIndex, content: block.thinking, partial: message });
		}
		openBlock = undefined;
	};

	const emitFinalError = (reason: "aborted" | "error", errorMessage: string): void => {
		if (finalized) {
			throw new WoolStreamAdapterError("stream already finalized; refusing second terminal event");
		}
		finalized = true;
		closeOpenBlock();
		message.stopReason = reason;
		message.errorMessage = errorMessage;
		push({ type: "error", reason, error: message });
		stream.end(message);
	};

	const ctx: WoolStreamDriverContext = {
		model,
		signal,
		open() {
			if (opened) {
				throw new WoolStreamAdapterError("open() called twice");
			}
			if (finalized) {
				throw new WoolStreamAdapterError("open() after terminal event");
			}
			opened = true;
			push({ type: "start", partial: message });
		},
		text(delta) {
			if (!opened || finalized) {
				throw new WoolStreamAdapterError("text() outside open..final window");
			}
			if (openBlock !== undefined && openBlock.kind !== "text") {
				closeOpenBlock(); // 块切换：thinking 开放中转 text，先闭合 thinking
			}
			const lastIndex = message.content.length - 1;
			const last = lastIndex >= 0 ? message.content[lastIndex] : undefined;
			let contentIndex: number;
			if (last !== undefined && last.type === "text" && openBlock !== undefined) {
				last.text += delta;
				contentIndex = lastIndex;
			} else {
				message.content.push({ type: "text", text: delta });
				contentIndex = message.content.length - 1;
				push({ type: "text_start", contentIndex, partial: message });
				openBlock = { kind: "text", contentIndex };
			}
			push({ type: "text_delta", contentIndex, delta, partial: message });
		},
		thinking(delta) {
			if (!opened || finalized) {
				throw new WoolStreamAdapterError("thinking() outside open..final window");
			}
			if (openBlock !== undefined && openBlock.kind !== "thinking") {
				closeOpenBlock(); // 块切换：text 开放中转 thinking，先闭合 text
			}
			const lastIndex = message.content.length - 1;
			const last = lastIndex >= 0 ? message.content[lastIndex] : undefined;
			let contentIndex: number;
			if (last !== undefined && last.type === "thinking" && openBlock !== undefined) {
				last.thinking += delta;
				contentIndex = lastIndex;
			} else {
				message.content.push({ type: "thinking", thinking: delta });
				contentIndex = message.content.length - 1;
				push({ type: "thinking_start", contentIndex, partial: message });
				openBlock = { kind: "thinking", contentIndex };
			}
			push({ type: "thinking_delta", contentIndex, delta, partial: message });
		},
		toolCall(call) {
			if (!opened || finalized) {
				throw new WoolStreamAdapterError("toolCall() outside open..final window");
			}
			closeOpenBlock(); // 工具调用前闭合开放块（内容 → 工具调用的边界）
			const toolCallContent: ToolCall = {
				type: "toolCall",
				id: call.id,
				name: call.name,
				arguments: toJsonObject(call.arguments),
			};
			const contentIndex = message.content.length;
			message.content.push(toolCallContent);
			// 参数已是解析后完整对象：start/delta 不伪造增量，直接以完整形态走完三段，
			// 满足「toolcall_end 时参数为有效已解析输入」的协议约束。
			push({ type: "toolcall_start", contentIndex, partial: message });
			push({ type: "toolcall_delta", contentIndex, delta: "", partial: message });
			push({ type: "toolcall_end", contentIndex, toolCall: toolCallContent, partial: message });
		},
		async onPayload(payload) {
			if (options?.onPayload === undefined) {
				return payload;
			}
			const replacement = await options.onPayload(payload, model);
			return replacement === undefined ? payload : replacement;
		},
		async onResponse(response) {
			if (options?.onResponse !== undefined) {
				await options.onResponse(response, model);
			}
		},
		async onProviderStreamEvent(data) {
			if (options?.onProviderStreamEvent !== undefined) {
				await options.onProviderStreamEvent(data, model);
			}
		},
	};

	void (async () => {
		try {
			const outcome = await skeleton.drive(ctx);
			if (!opened) {
				throw new WoolStreamAdapterError("family drive finished without open(); start event missing");
			}
			if (finalized) {
				return; // 家族已自行终态（abort 形态）——不许二次终态
			}
			const { input, output, cacheRead, cacheWrite } = outcome.usage;
			const totalTokens = outcome.usage.totalTokens ?? input + output + cacheRead + cacheWrite;
			const usage: Usage = { input, output, cacheRead, cacheWrite, totalTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
			usage.cost = calculateCost(model, usage);
			message.usage = usage;
			message.stopReason = outcome.stopReason ?? "stop";
			if (outcome.responseId !== undefined) {
				message.responseId = outcome.responseId;
			}
			finalized = true;
			closeOpenBlock(); // done 终态前闭合开放块（与 error/abort 同一平衡保证）
			push({ type: "done", reason: message.stopReason, message });
			stream.end(message);
		} catch (error) {
			if (finalized) {
				return;
			}
			const aborted = signal.aborted || (error instanceof Error && error.name === "AbortError");
			const detail = error instanceof Error ? error.message : String(error);
			emitFinalError(aborted ? "aborted" : "error", detail);
		}
	})();

	return stream;
}
