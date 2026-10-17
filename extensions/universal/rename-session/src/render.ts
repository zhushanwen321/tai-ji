/**
 * rename_session 工具渲染层（收起态一行摘要）。
 *
 * summary 是「做了什么」的一行英文摘要：GUI 侧读 tool result 的 details.summary 展示，
 * TUI renderResult 折叠态渲染同一份文本（dim 染色），展开态回退 content 纯文本。
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { firstContentText } from "@zhushanwen/extension-protocol";

/** rename_session 工具 result 的 details 形状（summary 由 buildRenameSessionSummary 产出）。 */
export interface RenameSessionDetails { // oe-exempt:20261017:framework:details 数据形状窄 view（单实现消费，非抽象接口）
	summary: string;
}

/** 收起态一行摘要：动作 + 新标题。title 用清洗后落库值（execute 传入），与 content 文案同源。 */
export function buildRenameSessionSummary(params: { title: string }): string {
	return `Renamed session to "${params.title}"`;
}

/** unknown 值按字段名安全取值（index-signature 收窄，替代全可选结构断言）。 */
function fieldValue(v: unknown, key: string): unknown {
	if (typeof v !== "object" || v === null) return undefined;
	return (v as Record<string, unknown>)[key];
}

/** 从 tool result 的 details 安全读取 summary（容错历史 entry 与非对象形态）。 */
function readDetailsSummary(result: unknown): string | undefined {
	const summary = fieldValue(fieldValue(result, "details"), "summary");
	return typeof summary === "string" && summary !== "" ? summary : undefined;
}

/** content[0] 的 text 纯文本（content 缺失或非 text 类型时兜底空串）。 */
function contentText(result: unknown): string {
	const content = fieldValue(result, "content");
	if (!Array.isArray(content)) return "";
	return firstContentText({ content });
}

/**
 * TUI renderResult：折叠态（expanded=false）= details.summary 一行（dim）；展开态 =
 * content 纯文本。summary 缺失（旧版本持久化 entry）时折叠态回退 content 文本。
 */
export function renderRenameSessionResult(
	result: unknown,
	options: { expanded: boolean },
	theme: Theme,
): Text {
	const summary = readDetailsSummary(result);
	const collapsed = summary ?? (contentText(result) || "Renamed");
	const text = options.expanded ? contentText(result) : collapsed;
	return new Text(theme.fg("dim", text), 0, 0);
}
