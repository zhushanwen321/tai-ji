/**
 * /todos 命令注册 — notify + widget 双通道反馈（D10①，Q1 裁决）。
 *
 * 反馈通道从 ctx.ui.custom 的 TUI 组件视图改为双通道：
 * - notify：formatTodoList 清单摘要（toast 在 taiji RPC 模式可达）；
 * - widget：refreshDisplay 强推 todo 面板（与 tool/handlers 反馈同一通道）。
 * ctx.ui.custom 在 RPC 模式恒 undefined（评估组 B 实测），原 TodoListComponent
 * 组件视图整体退役（component.ts 已删除）。
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { formatTodoList } from "./model";
import type { TodoSessionState } from "./state";
import type { RefreshDisplayFn } from "./handlers";

/** 注册 /todos 命令到 pi */
export function registerTodosCommand(pi: ExtensionAPI, state: TodoSessionState, refreshDisplay: RefreshDisplayFn): void {
	pi.registerCommand("todos", {
		description: "View all todos for the current session",
		handler: async (_args: string | undefined, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}

			// widget 通道：强推清单面板（含 setStatus 状态行，空清单时清面板）
			refreshDisplay(ctx);
			// notify 通道：清单摘要 toast（空清单给显式空态文案，不弹空串）
			const summary = formatTodoList(state.todos);
			ctx.ui.notify(summary === "" ? "No todos for the current session" : summary, "info");
		},
	});
}
