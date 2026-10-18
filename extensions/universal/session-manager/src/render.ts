// render.ts — session-manager 六工具共用 renderResult（pi TUI 侧；taiji GUI 对话流
// 不走本文件——GUI 直读 details.summary）。形态对齐 todo / canvas 扩展 render 先例：
// 折叠态一行摘要（dim 染色），展开态 / 无摘要（异常形态）回退原始 content 文本。

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { firstContentText } from "@zhushanwen/extension-protocol";

/** pi toolResult 通用形状（AgentToolResult 的结构最小面，renderResult 入参收窄用）。 */
interface ToolResultShape { // oe-exempt:20261017:framework:details 数据形状窄 view（单实现消费，非抽象接口）
	content: Array<{ type: string; text?: string }>;
	details?: { summary?: unknown };
}

export function renderSessionManagerResult(result: unknown, options: { expanded: boolean }, theme: Theme): Text {
	const r = result as ToolResultShape;
	const summary = r.details?.summary;
	if (options.expanded === false && typeof summary === "string" && summary !== "") {
		return new Text(theme.fg("dim", summary), 0, 0);
	}
	return new Text(firstContentText(r), 0, 0);
}
