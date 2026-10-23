/**
 * session_read 工具的 TUI renderResult（折叠态一行摘要 / 展开态 content 纯文本）。
 *
 * summary 来源 = details.summary（index.ts execute 经 withResultSummary 追加）；
 * 历史持久化 entry 无 summary 时折叠态回退 content 文本首行（旧形态可用性兜底）。
 */

import type { Theme } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import { firstLine, readDetailsSummary, resultContentText } from '@zhushanwen/extension-protocol'

/**
 * 折叠态（expanded=false）= details.summary 一行（dim）；展开态 = content 纯文本。
 */
export function renderSessionReadResult(
	result: unknown,
	options: { expanded: boolean },
	theme: Theme,
): Text {
	if (options.expanded) return new Text(resultContentText(result), 0, 0)
	const summary = readDetailsSummary(result) ?? firstLine(resultContentText(result))
	return new Text(theme.fg('dim', summary), 0, 0)
}
