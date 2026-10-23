/**
 * rename_session 工具渲染层（收起态一行摘要）。
 *
 * summary 是「做了什么」的一行英文摘要：GUI 侧读 tool result 的 details.summary 展示，
 * TUI renderResult 折叠态渲染同一份文本（dim 染色），展开态回退 content 纯文本。
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { readDetailsSummary, resultContentText } from "@zhushanwen/extension-protocol";

/** rename_session 工具 result 的 details 形状（summary 由 buildRenameSessionSummary 产出）。 */
export interface RenameSessionDetails { // oe-exempt:20261017:framework:details 数据形状窄 view（单实现消费，非抽象接口）
	summary: string;
}

/** 收起态一行摘要：动作 + 新标题。title 用清洗后落库值（execute 传入），与 content 文案同源。 */
export function buildRenameSessionSummary(params: { title: string }): string {
	return `Renamed session to "${params.title}"`;
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
	const collapsed = summary ?? (resultContentText(result) || "Renamed");
	const text = options.expanded ? resultContentText(result) : collapsed;
	return new Text(theme.fg("dim", text), 0, 0);
}
