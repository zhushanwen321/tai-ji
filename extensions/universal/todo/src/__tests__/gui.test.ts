import { describe, expect, it } from "vitest";

import { buildGui, type Todo } from "../model";

describe("buildGui（v1.1 meta head 架构）", () => {
	it("内容根 = numbered list-tree：行首序号由 ListTree 渲染，label 纯文本（无 #N 前缀）", () => {
		const todos: Todo[] = [
			{ id: 1, text: "pending task", status: "pending" },
			{ id: 2, text: "active task", status: "in_progress" },
			{ id: 3, text: "done task", status: "completed" },
		];
		const gui = buildGui(todos);
		expect(gui.v).toBe(1);
		expect(gui.component.type).toBe("list-tree");
		expect(gui.component.props.numbered).toBe(true);
		const items = gui.component.props.items;
		expect(items).toHaveLength(3);
		// pending → 无 status（guiResult 的 stripUndefined 删除 undefined 键），无 icon（状态由圆点单一表达）
		expect(items[0]).toEqual({ label: "pending task", depth: 0 });
		// in_progress → running
		expect(items[1]).toEqual({ label: "active task", status: "running", depth: 0 });
		// completed → done
		expect(items[2]).toEqual({ label: "done task", status: "done", depth: 0 });
	});

	it("meta：title=Todo，progress=current/total 计数（head 渲染，body 不再有 progress-bar）", () => {
		const todos: Todo[] = [
			{ id: 1, text: "a", status: "completed" },
			{ id: 2, text: "b", status: "in_progress" },
			{ id: 3, text: "c", status: "pending" },
		];
		const gui = buildGui(todos);
		expect(gui.meta).toEqual({
			title: "Todo",
			status: "running",
			progress: { current: 1, total: 3 },
		});
	});

	it("全部完成 → meta.status=done", () => {
		const todos: Todo[] = [
			{ id: 1, text: "a", status: "completed" },
			{ id: 2, text: "b", status: "completed" },
		];
		expect(buildGui(todos).meta).toEqual({
			title: "Todo",
			status: "done",
			progress: { current: 2, total: 2 },
		});
	});

	it("有 pending 无 in_progress → status=idle；empty todos → 无 progress", () => {
		const pendingOnly: Todo[] = [{ id: 1, text: "a", status: "pending" }];
		expect(buildGui(pendingOnly).meta).toEqual({
			title: "Todo",
			status: "idle",
			progress: { current: 0, total: 1 },
		});
		expect(buildGui([]).meta).toEqual({ title: "Todo", status: "idle" });
		// 空 list：numbered 仍开（items 空，无行渲染）
		const emptyGui = buildGui([]);
		expect(emptyGui.component.type).toBe("list-tree");
		expect(emptyGui.component.props.items).toEqual([]);
	});
});
