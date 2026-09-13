/**
 * Todo Extension — 轻量三态任务清单（pending / in_progress / completed）。
 *
 * 设计定位：刻意不做状态机约束（与 goal 扩展的 6 态状态机对立），状态自由流转；
 * 状态持久化复用 Pi 自动记录的 toolResult entry（非 appendEntry）；
 * 通过 agent_end → before_agent_start 的延迟 steer 驱动任务推进。
 *
 * 文件职责：
 * - state.ts:    TodoSessionState 会话状态接口 + 工厂（闭包内创建，session 隔离）
 * - model.ts:    纯函数数据层（Todo 类型、migrateTodo 兼容迁移、addTodos/updateTodos、format/buildGui）
 * - tool.ts:     todo tool 注册 — 4 个 action（list/add/update/delete）+ execute dispatcher
 * - handlers.ts: 5 个事件处理器（session_start/session_tree/agent_start/before_agent_start/agent_end）
 *                + reconstructState（回放最后一条 todo toolResult）+ steer 双机制（autoClear/completion）
 * - render.ts:   状态栏（status line）/ widget（单双列自适应）/ tool result 三层渲染
 * - component.ts: /todos 命令的 TodoListComponent TUI 视图（只读双列）
 * - commands.ts: /todos 命令注册
 * - index.ts（本文件）: 工厂入口（创建 state + 注册 tool/command/event + makeRefreshDisplay）
 *
 * 错误处理：包内单一 throw 协议——handler 与 model 层纯函数（addTodos / updateTodos）
 * 校验失败均直接 throw（见 docs/extensions/extension-conventions.md「Tool 设计」），
 * 不返回错误成功模式。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setWidgetDual, type GuiContext } from "@xyz-agent/extension-protocol";

import { registerTodosCommand } from "./commands";
import { registerTodoEventHandlers } from "./handlers";
import { buildGui } from "./model";
import { renderStatusText, renderWidgetLines } from "./render";
import { createTodoSessionState, type TodoSessionState } from "./state";
import { registerTodoTool } from "./tool";

// ── 刷新显示（导出供测试，生产路径与测试共用同一实现）──────

/**
 * 构造依赖 TodoSessionState 的 refreshDisplay（M17 widget 面板推送）。
 *
 * 类型断言根因：pi 的 ExtensionContext.ui.custom 是泛型方法（返回 Promise<T>），
 * 与 GuiContext.ui.custom 的具体返回类型静态不兼容，传参需断言收窄；
 * mode/hasUI/ui.setWidget 形状一致（ExtensionMode 与 GuiContext.mode union 完全
 * 相同），单层直接断言可过 tsc（setWidgetDual 只读 mode 与 ui.setWidget，
 * 不读 custom）。
 *
 * 推送/清屏 × GUI/TUI 模式分派由 protocol setWidgetDual 单点内化
 * （守卫单点化说明见 extension-protocol helpers.ts，本文件不再自持 isGui 判定）。
 */
export function makeRefreshDisplay(state: TodoSessionState): (ctx: ExtensionContext) => void {
	return function refreshDisplay(ctx: ExtensionContext): void {
		const statusText = renderStatusText(state.todos, ctx.ui.theme);
		ctx.ui.setStatus("todo", statusText || undefined);
		if (state.todos.length === 0) {
			setWidgetDual(ctx as GuiContext, "todo", undefined);
		} else {
			setWidgetDual(ctx as GuiContext, "todo", {
				gui: buildGui(state.todos),
				text: renderWidgetLines(state.todos, ctx.ui.theme),
			});
		}
	};
}

// ── 扩展入口 ─────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── 闭包内状态（session 隔离） ─────────────────────
	const state = createTodoSessionState();

	// 全解耦：不再暴露 pi.__todoGetList 跨扩展 API（goal 不再读 todo 状态）。
	// todo 进度由 AI 自行管理，goal 不做强制检查。

	const refreshDisplay = makeRefreshDisplay(state);

	// ── 注册所有 handler / tool / command ──────────────
	registerTodoEventHandlers(pi, state, refreshDisplay);
	registerTodoTool(pi, state, refreshDisplay);
	registerTodosCommand(pi, state);
}
