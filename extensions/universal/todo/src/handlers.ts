/**
 * Todo 事件处理器 — session_start / session_tree / agent_start /
 * before_agent_start / agent_end。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getLogger } from "@zhushanwen/pi-extension-logger";

import {
	migrateTodo,
	type TodoDetails,
} from "./model";
import { renderStatusText } from "./render";
import type { TodoSessionState } from "./state";

const logger = getLogger("todo");

// ── 常量 ────────────────────────────────────────────

/** 全部完成后保留的轮数，之后再自动 clear */
const AUTO_CLEAR_DELAY_ROUNDS = 2;

// ── 辅助函数 ────────────────────────────────────────

export type RefreshDisplayFn = (ctx: ExtensionContext) => void;

/** 未完成任务判定：pending / in_progress */
function isPending(t: TodoDetails["todos"][number]): boolean {
	return t.status === "pending" || t.status === "in_progress";
}

export function buildBeforeAgentStartMessage(state: TodoSessionState): { message: { customType: string; content: string; display: boolean } } | undefined {
	if (state.todos.length === 0) return undefined;

	const pendingTodos = state.todos.filter(isPending);
	if (pendingTodos.length === 0) return undefined;

	const lines = pendingTodos.map((t) => `#${t.id}: ${t.text}`);
	const contextStr =
		`<todo_context>\n[TODO] ${pendingTodos.length} 个未完成任务待处理：\n${lines.join("\n")}\n处理规则：开始工作前先推进 pending 任务；任务做完后立即用 todo update 标记 completed，不要搁置 pending 状态（搁置不等于完成）。\n</todo_context>`;

	return {
		message: {
			customType: "todo-context",
			content: contextStr,
			display: false,
		},
	};
}

// ── 状态重建 ────────────────────────────────────────

/**
 * 回放最后一条 todo toolResult 重建 state（纯读，不修改 entries）。
 *
 * H1（C2 决策）：pi 的 SessionManager.getEntries() 返回的是 filter-copy，原先的
 * splice GC 段对副本操作无效，且修改传入 entries 是反模式。删除整段 splice，只保留
 * 回放逻辑——找到最后一条有效 todo 快照，迁移脏数据后载入 state。
 */
export function reconstructState(state: TodoSessionState, ctx: ExtensionContext): void {
	state.todos = [];
	state.nextId = 1;
	state.userMessageCount = 0;
	state.allCompletedAtCount = null;
	state.completionSteered = false;
	state.pendingSteerMessage = null;

	const entries = ctx.sessionManager.getEntries();

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;

		const details = msg.details as TodoDetails | undefined;
		if (details?.todos && Array.isArray(details.todos)) {
			// 脏数据降级：单条迁移失败（null/primitive）跳过该条，全部失败则忽略整个快照，不中断回放
			const migrated: TodoDetails["todos"] = [];
			for (const t of details.todos) {
				try {
					migrated.push(migrateTodo(t));
				} catch (e) {
					// best-effort 降级：脏数据（null/primitive）跳过该条，不中断会话回放
					logger.debug("reconstructState: skipping dirty todo entry", { error: String(e) });
				}
			}
			if (migrated.length > 0) {
				state.todos = migrated;
				state.nextId = details.nextId ?? Math.max(...migrated.map((t) => t.id)) + 1;
			}
		}
	}
}

// ── agent_end 子函数 ────────────────────────────────

/** 返回是否已清空（false 含三种形态：未全完成 / 本轮刚锚定 / 延迟未到——调用方均无需刷新） */
export function handleAutoClear(state: TodoSessionState): boolean {
	const allCompleted = state.todos.every((t) => t.status === "completed");
	if (!allCompleted) {
		state.allCompletedAtCount = null;
		return false;
	}
	if (state.allCompletedAtCount === null) {
		state.allCompletedAtCount = state.userMessageCount;
	}
	if (state.userMessageCount - state.allCompletedAtCount >= AUTO_CLEAR_DELAY_ROUNDS) {
		state.todos = [];
		state.nextId = 1;
		state.allCompletedAtCount = null;
		state.completionSteered = false;
		return true;
	}
	return false;
}

export function handleCompletionSteer(state: TodoSessionState): boolean {
	if (state.completionSteered) return false;
	const allCompleted = state.todos.length > 0 && state.todos.every((t) => t.status === "completed");
	if (!allCompleted) return false;

	state.completionSteered = true;
	state.pendingSteerMessage = `<todo_context>\n[TODO] 所有任务已标记完成。请逐项核对交付质量（不要凭印象，检查实际产出），确认无误后向用户汇报结果。\n</todo_context>`;
	return true;
}

// ── Event handler 注册入口 ──────────────────────────

export function registerTodoEventHandlers(
	pi: ExtensionAPI,
	state: TodoSessionState,
	refreshDisplay: RefreshDisplayFn,
): void {
	pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
		reconstructState(state, ctx);
		refreshDisplay(ctx);
	});
	pi.on("session_tree", async (_event: unknown, ctx: ExtensionContext) => {
		reconstructState(state, ctx);
		refreshDisplay(ctx);
	});

	pi.on("agent_start", async (_event: unknown, _ctx: ExtensionContext) => {
		state.userMessageCount++;
	});

	pi.on("before_agent_start", async (_event: unknown, ctx: ExtensionContext) => {
		try {
			const pendingTodos = state.todos.filter(isPending);
			if (pendingTodos.length > 0) {
				// 文案与 refreshDisplay 共用 renderStatusText（N/M 口径），避免同一 status 槽两种格式交替
				ctx.ui.setStatus("todo", renderStatusText(state.todos, ctx.ui.theme));
			}
			// 优先级 1: agent_end 设置的延迟 steer
			if (state.pendingSteerMessage) {
				const msg = state.pendingSteerMessage;
				state.pendingSteerMessage = null;
				return { message: { customType: "todo-context", content: msg, display: false } };
			}

			return buildBeforeAgentStartMessage(state);
		} catch (e) {
			logger.debug("before_agent_start error", { error: String(e) });
			return undefined;
		}
	});

	pi.on("agent_end", async (_event: unknown, ctx: ExtensionContext) => {
		try {
			if (state.todos.length === 0) return;

			// 全部 completed → 总检查 steer（仅一次）
			handleCompletionSteer(state);

			// auto-clear（全部完成后延迟清理；已清空才需要刷新显示）
			if (handleAutoClear(state)) refreshDisplay(ctx);
		} catch (e) {
			// best-effort：agent_end 事件处理器出错不阻断会话主流程，仅记录调试日志
			logger.debug("agent_end error", { error: String(e) });
		}
	});
}
