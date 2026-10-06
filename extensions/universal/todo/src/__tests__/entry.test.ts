/**
 * 工厂入口装配单测：默认导出一次性注册 event/tool/command 三通道。
 *
 * 断言面：5 个事件 handler（session_start/session_tree/agent_start/
 * before_agent_start/agent_end）+ todo tool + todos 命令各注册一次；
 * 命令名锚定 "todos"（/todos 入口漂移 = 用户命令失效）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import todoExtension from "../index";

describe("todo extension 工厂入口", () => {
	it("注册 5 个事件 handler + todo tool + todos 命令", () => {
		const pi = {
			on: vi.fn(),
			registerTool: vi.fn(),
			registerCommand: vi.fn(),
		} as unknown as ExtensionAPI;

		todoExtension(pi);

		expect(pi.on).toHaveBeenCalledTimes(5);
		expect(pi.registerTool).toHaveBeenCalledTimes(1);
		expect(pi.registerCommand).toHaveBeenCalledTimes(1);
		expect((pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe("todos");
	});
});
