/**
 * /todos 命令双通道反馈单测（D10①，Q1 裁决）。
 *
 * 断言面：notify 通道（清单摘要 / 空态文案 / no-UI 提示）+ widget 通道
 * （refreshDisplay 强推）；双通道在同一次命令触发中都可达。
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { registerTodosCommand } from "../commands";
import type { RefreshDisplayFn } from "../handlers";
import { addTodos } from "../model";
import { createTodoSessionState } from "../state";

type TodosCommandDef = {
	handler: (args: string | undefined, ctx: ExtensionCommandContext) => Promise<void>;
};

function mockPi(): ExtensionAPI {
	return { registerCommand: vi.fn() } as unknown as ExtensionAPI;
}

/** 注册命令并取回 handler 定义（registerCommand spy 的首次调用参数）。 */
function registerTodos(def: { state?: ReturnType<typeof createTodoSessionState>; refreshDisplay?: RefreshDisplayFn }): TodosCommandDef {
	const pi = mockPi();
	const refreshDisplay = def.refreshDisplay ?? (vi.fn() as unknown as RefreshDisplayFn);
	const state = def.state ?? createTodoSessionState();
	registerTodosCommand(pi, state, refreshDisplay);
	const calls = (pi.registerCommand as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[string, TodosCommandDef]>;
	expect(calls[0]?.[0]).toBe("todos");
	return calls[0][1];
}

function uiCtx(hasUI: boolean, notify: ReturnType<typeof vi.fn>): ExtensionCommandContext {
	return { hasUI, ui: { notify }, sessionManager: { getSessionId: () => "s1" } } as unknown as ExtensionCommandContext;
}

describe("/todos command（D10① notify + widget 双通道）", () => {
	it("有清单：notify 收到清单摘要（formatTodoList 形态）+ refreshDisplay 被推（widget 通道）", async () => {
		const state = createTodoSessionState();
		const added = addTodos(state.todos, state.nextId, ["first"]);
		state.todos = added.newTodos;
		state.nextId = added.newNextId;
		const refreshDisplay = vi.fn() as unknown as RefreshDisplayFn;
		const def = registerTodos({ state, refreshDisplay });
		const notify = vi.fn();
		await def.handler(undefined, uiCtx(true, notify));

		expect(notify).toHaveBeenCalledTimes(1);
		expect(String(notify.mock.calls[0][0])).toContain("[ ] #1: first");
		expect(refreshDisplay).toHaveBeenCalledTimes(1);
	});

	it("空清单：notify 收到显式空态文案（不弹空串）", async () => {
		const refreshDisplay = vi.fn() as unknown as RefreshDisplayFn;
		const def = registerTodos({ refreshDisplay });
		const notify = vi.fn();
		await def.handler(undefined, uiCtx(true, notify));

		expect(notify).toHaveBeenCalledWith("No todos for the current session", "info");
		expect(refreshDisplay).toHaveBeenCalledTimes(1);
	});

	it("无 UI（hasUI=false）：仅 notify error 提示，widget 不推", async () => {
		const refreshDisplay = vi.fn() as unknown as RefreshDisplayFn;
		const def = registerTodos({ refreshDisplay });
		const notify = vi.fn();
		await def.handler(undefined, uiCtx(false, notify));

		expect(notify).toHaveBeenCalledWith("/todos requires interactive mode", "error");
		expect(refreshDisplay).not.toHaveBeenCalled();
	});
});
