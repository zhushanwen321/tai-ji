/**
 * 工具报错审计 hook —— 自 unified-hooks tool-error-handler 等价迁移（设计文档 D11 落点）。
 *
 * 迁移约定（与原实现逐字段一致，M1 验收点）：
 *  - 事件名 = "tool_execution_end"（pi 0.84.1 实装无 "tool_error" 事件，工具报错以
 *    ToolExecutionEndEvent.isError=true 表达——以 dist types.d.ts 为准）
 *  - customType = "unified-hooks:tool-error"（保持原值：无代码消费方；保持旧名是
 *    历史 entry 可查询性承诺（01 号设计 P-protocol / README 承接表），废弃包名残留
 *    为已接受代价——ext-simplify-13 D4）
 *  - entry 形态 = { timestamp, toolName, toolCallId, errorText }，errorText 取不到时 null
 *
 * 原实现的设计决策一并继承：不调 ctx.ui.notify——tool error 已在对话流里
 * （pi 原生 tool result isError → error content 回灌 LLM），notify 会重复显示
 * 且措辞误导；仅 appendEntry 留审计痕迹。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Subset of `ToolExecutionEndEvent` fields used by this hook.
 * 局部最小接口沿自 unified-hooks 原实现：SDK 的完整事件类型经 CI ambient stub
 * 不一定可达，宽松声明避免类型环境差异。
 */
interface ToolExecutionEndLikeEvent {
	isError: boolean;
	toolName: string;
	toolCallId: string;
	result?: unknown;
}

/**
 * 从 tool 执行结果里提取错误文本。
 *
 * pi 在 tool execute 抛错时构造 `{ content: [{ type: "text", text }] }` 塞进
 * result.content[0].text；事件结构无独立 errorMessage 字段。防御性取多种结构，
 * 取不到返回 undefined（调用方降级为 null，不阻断）。
 */
function extractErrorText(result: unknown): string | undefined {
	const contentArr = getContentArray(result);
	if (contentArr) {
		for (const item of contentArr) {
			const text = getStringProperty(item, "text");
			if (text) return text;
		}
	}
	// 兜底：某些工具直接塞 { error: "..." }
	return getStringProperty(result, "error");
}

/** 若 result.content 是数组则返回它，否则 undefined。 */
function getContentArray(result: unknown): unknown[] | undefined {
	if (typeof result !== "object" || result === null) return undefined;
	const content = (result as Record<string, unknown>).content;
	return Array.isArray(content) ? content : undefined;
}

/** 类型守卫：返回 obj[key] 当它是非空 string，否则 undefined。 */
function getStringProperty(obj: unknown, key: string): string | undefined {
	if (typeof obj !== "object" || obj === null) return undefined;
	const val = (obj as Record<string, unknown>)[key];
	return typeof val === "string" && val.length > 0 ? val : undefined;
}

export function setupToolErrorAudit(pi: ExtensionAPI): void {
	pi.on("tool_execution_end", async (event: unknown) => {
		const e = event as ToolExecutionEndLikeEvent;
		if (!e.isError) return;

		const errorText = extractErrorText(e.result);

		const entry = {
			timestamp: Date.now(),
			toolName: e.toolName,
			toolCallId: e.toolCallId,
			errorText: errorText ?? null,
		};
		pi.appendEntry("unified-hooks:tool-error", entry);
	});
}
