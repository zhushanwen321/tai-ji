/**
 * buildGui 测试 — meta head + tab-bar 双段架构。
 *
 * 覆盖：
 * - 内容根 = tab-bar 双段：tabs 与 sections 等长（2 段，容器化前提），待办段 =
 *   未完成项 numbered list-tree（行首序号语义不变），已完成段 = 已完成项 list-tree
 * - 两段互斥且覆盖全量（tab 标签计数与段内容同源）；空段 = 空 items（既有空态语义）
 * - meta：title=Todo、progress=current/total 计数、status 语义、托盘 icon（显式
 *   'list-checks'）+ badge（未完成条数）
 */
import type { GuiComponent, GuiComponentProps } from "@zhushanwen/extension-protocol";
import { describe, expect, it } from "vitest";

import { buildGui, type Todo } from "../model";

/** tab-bar props（根形状断言收口在此：非 tab-bar 根直接失败，段结构断言才有意义） */
function tabBarProps(gui: ReturnType<typeof buildGui>): GuiComponentProps["tab-bar"] {
	if (gui.component.type !== "tab-bar") {
		throw new Error(`内容根应为 tab-bar，实际 ${gui.component.type}`);
	}
	return gui.component.props as GuiComponentProps["tab-bar"];
}

/** 段必须是 list-tree：返回其 props（段形状先验，供 items 断言） */
function listTreeProps(section: GuiComponent | undefined): GuiComponentProps["list-tree"] {
	if (!section || section.type !== "list-tree") {
		throw new Error(`段应为 list-tree，实际 ${section?.type ?? "undefined"}`);
	}
	return section.props as GuiComponentProps["list-tree"];
}

describe("buildGui（meta head + tab-bar 双段架构）", () => {
	it("内容根 = tab-bar：sections 与 tabs 等长（2 段），待办段 = 未完成项 numbered list-tree", () => {
		const todos: Todo[] = [
			{ id: 1, text: "pending task", status: "pending" },
			{ id: 2, text: "active task", status: "in_progress" },
			{ id: 3, text: "done task", status: "completed" },
		];
		const gui = buildGui(todos);
		expect(gui.v).toBe(1);
		const { tabs, sections } = tabBarProps(gui);
		// 标签计数与段内容同源（待办 = 未完成数，已完成 = completed 数）
		expect(tabs.map((t) => t.label)).toEqual(["待办 2", "已完成 1"]);
		// 首段带 active：容器化宿主据此建立初始 tab（此后本地切换不被推送重置）
		expect(tabs[0]!.active).toBe(true);
		expect(tabs[1]!.active).toBeUndefined();
		// 与 tabs 等长（长度不等时宿主忽略 sections 退化为纯展示，段内容即丢失）
		expect(sections).toHaveLength(tabs.length);

		const openProps = listTreeProps(sections![0]![0]);
		// 行首序号语义不变：numbered 开，label 纯文本（无 #N 前缀，序号由 ListTree 渲染）
		expect(openProps.numbered).toBe(true);
		expect(openProps.items).toEqual([
			// pending → 无 status（guiResult 的 stripUndefined 删除 undefined 键），无 icon
			{ label: "pending task", depth: 0 },
			// in_progress → running
			{ label: "active task", status: "running", depth: 0 },
		]);
	});

	it("已完成段 = 已完成项 list-tree（两段互斥且覆盖全量，行内 status 映射不变）", () => {
		const todos: Todo[] = [
			{ id: 1, text: "pending task", status: "pending" },
			{ id: 2, text: "done task", status: "completed" },
			{ id: 3, text: "another done", status: "completed" },
		];
		const { tabs, sections } = tabBarProps(buildGui(todos));
		expect(tabs.map((t) => t.label)).toEqual(["待办 1", "已完成 2"]);
		expect(sections).toHaveLength(2);

		const doneProps = listTreeProps(sections![1]![0]);
		expect(doneProps.numbered).toBe(true);
		expect(doneProps.items).toEqual([
			{ label: "done task", status: "done", depth: 0 },
			{ label: "another done", status: "done", depth: 0 },
		]);

		// 互斥且覆盖全量：两段 label 并集 = 原清单，无漏行（重复行由 items 精确断言承担）
		const openLabels = listTreeProps(sections![0]![0]).items.map((i) => i.label);
		const doneLabels = doneProps.items.map((i) => i.label);
		expect([...openLabels, ...doneLabels].sort()).toEqual([
			"another done",
			"done task",
			"pending task",
		]);
	});

	it("空段（无已完成项 / 无未完成项）= 空 items 的 list-tree：既有空态语义，无装饰性占位", () => {
		const noDone = tabBarProps(buildGui([{ id: 1, text: "a", status: "pending" }]));
		expect(noDone.tabs.map((t) => t.label)).toEqual(["待办 1", "已完成 0"]);
		expect(noDone.sections![1]![0]).toEqual({
			type: "list-tree",
			props: { numbered: true, items: [] },
		});

		const allDone = tabBarProps(buildGui([{ id: 1, text: "a", status: "completed" }]));
		expect(allDone.tabs.map((t) => t.label)).toEqual(["待办 0", "已完成 1"]);
		expect(allDone.sections![0]![0]).toEqual({
			type: "list-tree",
			props: { numbered: true, items: [] },
		});
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
			icon: "list-checks",
			badge: "2",
		});
	});

	it("meta.icon 推显式 'list-checks' key；badge = 未完成条数（与待办段计数同源）", () => {
		const gui = buildGui([
			{ id: 1, text: "a", status: "completed" },
			{ id: 2, text: "b", status: "pending" },
		]);
		// 协议形状：string（宿主按 lucide 名解析）或 { paths }（自定义形状）。
		// todo 只用 key 形态——与宿主内置 widgetKey 映射（'todo'→ListChecks）同款，
		// 宿主改自己的映射表也不会换掉 todo 图标。
		expect(gui.meta!.icon).toBe("list-checks");
		expect(gui.meta!.badge).toBe("1");
		// badge 与首段标签计数同源（同一 open 计数，无双口径）
		expect(tabBarProps(gui).tabs[0]!.label).toContain(gui.meta!.badge!);
	});

	it("全部完成 → meta.status=done（badge 归零）", () => {
		const todos: Todo[] = [
			{ id: 1, text: "a", status: "completed" },
			{ id: 2, text: "b", status: "completed" },
		];
		expect(buildGui(todos).meta).toEqual({
			title: "Todo",
			status: "done",
			progress: { current: 2, total: 2 },
			icon: "list-checks",
			badge: "0",
		});
	});

	it("有 pending 无 in_progress → status=idle；empty todos → 无 progress + 双空段", () => {
		const pendingOnly: Todo[] = [{ id: 1, text: "a", status: "pending" }];
		expect(buildGui(pendingOnly).meta).toEqual({
			title: "Todo",
			status: "idle",
			progress: { current: 0, total: 1 },
			icon: "list-checks",
			badge: "1",
		});
		expect(buildGui([]).meta).toEqual({
			title: "Todo",
			status: "idle",
			icon: "list-checks",
			badge: "0",
		});
		// 空清单：两段皆空 list-tree（numbered 仍开，items 空，无行渲染）
		const empty = tabBarProps(buildGui([]));
		expect(empty.tabs.map((t) => t.label)).toEqual(["待办 0", "已完成 0"]);
		expect(empty.sections!.map((s) => s[0])).toEqual([
			{ type: "list-tree", props: { numbered: true, items: [] } },
			{ type: "list-tree", props: { numbered: true, items: [] } },
		]);
	});
});
