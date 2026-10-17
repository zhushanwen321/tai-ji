/**
 * structured-output 工具的 TUI renderResult（折叠态一行摘要 / 展开态 content 纯文本）。
 *
 * 摘要不进 details：本工具的 result.details 是模型的结构化产出本体（workflow 引擎
 * output-collector 的 extractParsedOutput 原样取走作 agent parsedOutput），混入 summary
 * 键会污染产出契约（object 形态多出合同外字段、primitive 形态无处挂载）。因此折叠态
 * 摘要 = 固定文案，不依赖数据。
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { firstContentText } from "@zhushanwen/extension-protocol";

/** 折叠态一行摘要（两种注册变体统一；校验失败走 throw 不产出 result）。 */
export const STRUCTURED_OUTPUT_SUMMARY = "Final result reported (schema validated)";

/** content[0] 的 text 纯文本（content 缺失或非 text 类型时兜底空串）。 */
/** unknown 值按字段名安全取值（index-signature 收窄，替代全可选结构断言）。 */
function fieldValue(v: unknown, key: string): unknown {
	if (typeof v !== "object" || v === null) return undefined;
	return (v as Record<string, unknown>)[key];
}

function contentText(result: unknown): string {
	const content = fieldValue(result, "content");
	if (!Array.isArray(content)) return "";
	return firstContentText({ content });
}

/** 折叠态（expanded=false）= 固定一行摘要（dim）；展开态 = content 纯文本。 */
export function renderStructuredOutputResult(
	result: unknown,
	options: { expanded: boolean },
	theme: Theme,
): Text {
	if (options.expanded) return new Text(contentText(result), 0, 0);
	return new Text(theme.fg("dim", STRUCTURED_OUTPUT_SUMMARY), 0, 0);
}
