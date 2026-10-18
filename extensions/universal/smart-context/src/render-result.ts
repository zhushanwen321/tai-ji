/**
 * compact_context 工具的 TUI renderResult（折叠态一行摘要 / 展开态 content 纯文本）。
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { firstContentText } from "@zhushanwen/extension-protocol";

/** content[0] 的 text 纯文本（content 缺失或非 text 类型时兜底空串）。 */
function contentText(result: unknown): string {
	const content = fieldValue(result, "content");
	if (!Array.isArray(content)) return "";
	return firstContentText({ content });
}

/** unknown 值按字段名安全取值（index-signature 收窄，替代全可选结构断言）。 */
function fieldValue(v: unknown, key: string): unknown {
	if (typeof v !== "object" || v === null) return undefined;
	return (v as Record<string, unknown>)[key];
}

/** 从 details 安全读取 summary（容错非对象形态与旧版本 entry）。 */
function readDetailsSummary(result: unknown): string | undefined {
	const summary = fieldValue(fieldValue(result, "details"), "summary");
	return typeof summary === "string" && summary !== "" ? summary : undefined;
}

/** 折叠态回退：content 文本首行（保持一行摘要形态）。 */
function firstLine(text: string): string {
	const idx = text.indexOf("\n");
	return idx === -1 ? text : text.slice(0, idx);
}

/** 折叠态（expanded=false）= details.summary 一行（dim）；展开态 = content 纯文本。 */
export function renderCompactContextResult(
	result: unknown,
	options: { expanded: boolean },
	theme: Theme,
): Text {
	if (options.expanded) return new Text(contentText(result), 0, 0);
	const summary = readDetailsSummary(result) ?? firstLine(contentText(result));
	return new Text(theme.fg("dim", summary), 0, 0);
}
