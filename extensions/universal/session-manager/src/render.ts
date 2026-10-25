// render.ts — session-manager 八工具共用 renderResult（pi TUI 侧；taiji GUI 对话流
// 不走本文件——GUI 直读 details.summary）。形态对齐 todo / canvas 扩展 render 先例：
// 折叠态一行摘要（dim 染色），展开态 / 无摘要（异常形态）回退原始 content 文本。

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { readDetailsSummary, resultContentText } from "@zhushanwen/extension-protocol";

export function renderSessionManagerResult(result: unknown, options: { expanded: boolean }, theme: Theme): Text {
	const summary = readDetailsSummary(result);
	if (options.expanded === false && summary !== undefined) {
		return new Text(theme.fg("dim", summary), 0, 0);
	}
	return new Text(resultContentText(result), 0, 0);
}
