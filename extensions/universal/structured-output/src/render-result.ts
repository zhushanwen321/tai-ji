/**
 * structured-output 工具的 TUI renderResult（折叠态一行摘要 / 展开态 content 纯文本）。
 *
 * 摘要不进 details：本工具的 result.details 是模型的结构化产出本体（workflow 引擎
 * output-collector 的 extractParsedOutput 原样取走作 agent parsedOutput），混入 summary
 * 键会污染产出契约（object 形态多出合同外字段、primitive 形态无处挂载）。因此成功路径
 * 折叠态摘要 = 固定文案，不依赖数据。
 *
 * 错误路径（context.isError）不能用成功文案——pi 对失败轮同样调用 renderResult
 *（tool-execution.js 传 {content, details} 给 renderResult，isError 只在第 4 参 context），
 * 而 runResult 的 content 是校验失败文案。此时折叠态回退 content 首行，避免把失败显示成
 *「schema validated」的假成功。判定靠 context.isError 事实，不做 content 文案匹配。
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { firstLine, resultContentText } from "@zhushanwen/extension-protocol";

/** 成功轮折叠态一行摘要（两种注册变体统一；错误轮走 firstLine(resultContentText)）。 */
export const STRUCTURED_OUTPUT_SUMMARY = "Final result reported (schema validated)";

/**
 * renderResult 的 context（SDK ToolRenderContext 的有意子集——结构兼容只声明本组件
 * 需要的字段）。SDK 实际传入更完整的 { args, toolCallId, cwd, ..., isError }。
 */
export interface StructuredOutputRenderContext {
	isError?: boolean;
}

/**
 * 折叠态（expanded=false）：成功 = 固定一行摘要；错误 = content 首行（dim）。
 * 展开态 = content 纯文本。context 可选——旧的三参调用（测试 / 历史 caller）按成功处理。
 */
export function renderStructuredOutputResult(
	result: unknown,
	options: { expanded: boolean },
	theme: Theme,
	context?: StructuredOutputRenderContext,
): Text {
	if (options.expanded) return new Text(resultContentText(result), 0, 0);
	const summary = context?.isError === true
		? firstLine(resultContentText(result))
		: STRUCTURED_OUTPUT_SUMMARY;
	return new Text(theme.fg("dim", summary), 0, 0);
}
