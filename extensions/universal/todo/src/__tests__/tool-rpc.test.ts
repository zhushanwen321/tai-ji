/**
 * executeTodoAction handler 级测试 —— M17 后的两条路径：
 * 1. tool result 无 __gui__（全模式统一——状态展示不再进 details）
 * 2. refreshDisplay GUI widget 推送（rpc 推 marker 编码 / tui 推纯文本行）
 *
 * 策略：executeTodoAction 未导出，通过 registerTodoTool + mock pi 捕获
 * 已注册 tool，再以不同 ctx.mode 调 execute。setup 第三参传真实
 * makeRefreshDisplay(state)（与 index.ts 工厂共用同一实现，不测复制品）。
 * 每个用例新建 state（隔离），无模块级状态需重置。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { GUI_WIDGET_MARKER } from "@xyz-agent/extension-protocol";
import { describe, expect, it, vi, type Mock } from "vitest";

import { makeRefreshDisplay } from "../index";
import { createTodoSessionState, type TodoSessionState } from "../state";
import { registerTodoTool } from "../tool";

// ── Types for the registered tool ───────────────────────
type TestMode = "tui" | "rpc" | "json" | "print";

type SetWidgetFn = (name: string, content: string[] | undefined) => void;

interface ExecuteResult {
	content: Array<{ type: "text"; text: string }>;
	details: {
		action: string;
		todos: Array<{ id: number; text: string; status: string }>;
		nextId: number;
	};
}

interface RegisteredTool {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: { mode: TestMode },
	) => Promise<ExecuteResult>;
}

// pi-coding-agent 的 ExtensionContext 类型声明里没有 mode 字段（运行时实际有），
// 与 extension-protocol 的 GuiContext 结构化兼容。这里做最小 mock 并断言。
interface MockPi {
	tool?: RegisteredTool;
	registerTool(tool: RegisteredTool): void;
}

/** 捕获注册的 tool，返回 + 暴露 state 供断言。refreshDisplay 传真实实现（makeRefreshDisplay）。 */
function setup(): { tool: RegisteredTool; state: TodoSessionState } {
	const state = createTodoSessionState();
	const pi: MockPi = {
		registerTool(tool) {
			this.tool = tool;
		},
	};
	registerTodoTool(pi as unknown as ExtensionAPI, state, makeRefreshDisplay(state));
	if (!pi.tool) throw new Error("registerTodoTool did not register a tool");
	return { tool: pi.tool, state };
}

// ── Theme passthrough（与 todo.test.ts mockTheme 一致） ──
const stubTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	inverse: (text: string) => text,
	strikethrough: (text: string) => text,
	getFgAnsi: (_color: string) => "",
	getBgAnsi: (_color: string) => "",
	getColorMode: () => "truecolor" as const,
	getThinkingBorderColor: () => (text: string) => text,
	getBashModeBorderColor: () => (text: string) => text,
} as unknown as Theme;

/** 构造指定 mode 的 ctx，setWidget 为 vi.fn 供断言（refreshDisplay 推送出口）。 */
function makeCtx(mode: TestMode, hasUI: boolean): {
	ctx: { mode: TestMode; hasUI: boolean; ui: { theme: Theme; setStatus: Mock; setWidget: Mock<SetWidgetFn> } };
	setWidget: Mock<SetWidgetFn>;
} {
	const setWidget = vi.fn<SetWidgetFn>();
	return {
		ctx: {
			mode,
			hasUI,
			ui: { theme: stubTheme, setStatus: vi.fn(), setWidget },
		},
		setWidget,
	};
}

/** RPC 模式 ctx：hasUI=false。 */
const makeRpcCtx = () => makeCtx("rpc", false);

/** TUI 模式 ctx：hasUI=true。 */
const makeTuiCtx = () => makeCtx("tui", true);

// ── tool result：无 __gui__（M17 后全模式统一）─────────

describe("executeTodoAction — tool result 无 __gui__（全模式）", () => {
	const MODES: TestMode[] = ["rpc", "tui", "json", "print"];

	it.each(MODES)("%s + add → details 无 __gui__ 字段，仍含 action/todos/nextId", async (mode) => {
		const { tool } = setup();
		const result = await tool.execute(
			"id",
			{ action: "add", texts: ["task A"] },
			undefined,
			undefined,
			makeCtx(mode, mode === "tui").ctx,
		);
		expect("__gui__" in result.details).toBe(false);
		// details 仍带原生文本路径数据（todos / nextId）
		expect(result.details.action).toBe("add");
		expect(result.details.todos).toHaveLength(1);
		expect(result.content[0].text).toContain("Added");
	});

	it.each(MODES)("%s + list → details 无 __gui__ 字段，文本内容可读", async (mode) => {
		const { tool, state } = setup();
		state.todos = [{ id: 1, text: "x", status: "pending" }];
		state.nextId = 2;
		const result = await tool.execute(
			"id",
			{ action: "list" },
			undefined,
			undefined,
			makeCtx(mode, mode === "tui").ctx,
		);
		expect("__gui__" in result.details).toBe(false);
		expect(result.content[0].text).toContain("#1");
	});

	it("rpc + update → details 无 __gui__ 字段，状态变更仍生效", async () => {
		const { tool, state } = setup();
		state.todos = [{ id: 1, text: "item", status: "pending" }];
		state.nextId = 2;
		const result = await tool.execute(
			"id",
			{ action: "update", updates: [{ id: 1, status: "in_progress" }] },
			undefined,
			undefined,
			makeRpcCtx().ctx,
		);
		expect("__gui__" in result.details).toBe(false);
		expect(result.details.todos[0]!.status).toBe("in_progress");
	});
});

// ── refreshDisplay：GUI widget 推送（M17，真实实现）────

describe("refreshDisplay — GUI widget 推送（setup 传真实实现）", () => {
	it("G-1: rpc + add → setWidget 收到 ('todo', [GUI_WIDGET_MARKER + JSON])，解析后为 v1.1 信封（list-tree + meta）", async () => {
		const { tool } = setup();
		const { ctx, setWidget } = makeRpcCtx();
		await tool.execute(
			"id",
			{ action: "add", texts: ["task A", "task B"] },
			undefined,
			undefined,
			ctx,
		);
		expect(setWidget).toHaveBeenCalledTimes(1);
		const [key, value] = setWidget.mock.calls[0]!;
		expect(key).toBe("todo");
		expect(value).toHaveLength(1);
		const encoded = value![0]!;
		// marker 前缀用协议常量断言（不手写编码）
		expect(encoded.startsWith(GUI_WIDGET_MARKER)).toBe(true);
		const parsed = JSON.parse(encoded.slice(GUI_WIDGET_MARKER.length)) as {
			v: number;
			component: { type: string; props: { numbered: boolean; items: Array<{ label: string }> } };
			meta: { title: string; progress: { current: number; total: number } };
		};
		// v1.1 wire：GuiRenderResult 信封（component + meta 宿主元数据）
		expect(parsed.v).toBe(1);
		expect(parsed.component.type).toBe("list-tree");
		expect(parsed.component.props.numbered).toBe(true);
		expect(parsed.component.props.items).toHaveLength(2);
		expect(parsed.component.props.items[0]).toMatchObject({ label: "task A" });
		expect(parsed.component.props.items[1]).toMatchObject({ label: "task B" });
		expect(parsed.meta).toMatchObject({ title: "Todo", progress: { current: 0, total: 2 } });
	});

	it("G-2: rpc + delete 清空列表 → setWidget 收到 ('todo', undefined)（清除语义）", async () => {
		const { tool } = setup();
		const { ctx, setWidget } = makeRpcCtx();
		await tool.execute("id", { action: "add", texts: ["only"] }, undefined, undefined, ctx);
		await tool.execute("id", { action: "delete", ids: [1] }, undefined, undefined, ctx);
		expect(setWidget).toHaveBeenLastCalledWith("todo", undefined);
	});

	it("G-3: tui + add → setWidget 收到纯文本行数组（无 marker 前缀）", async () => {
		const { tool } = setup();
		const { ctx, setWidget } = makeTuiCtx();
		await tool.execute("id", { action: "add", texts: ["task A"] }, undefined, undefined, ctx);
		expect(setWidget).toHaveBeenCalledTimes(1);
		const [, value] = setWidget.mock.calls[0]!;
		expect(value!.length).toBeGreaterThan(0);
		for (const line of value!) {
			// setWidgetDual 模式分派生效（守卫单点在 protocol helper）：TUI 行不含 GUI marker 编码
			expect(line.startsWith(GUI_WIDGET_MARKER)).toBe(false);
		}
	});
});

// ── 共享 state：details.todos 是快照副本 ───────────────

describe("executeTodoAction — state isolation & snapshot", () => {
	it("S-1: each setup() yields independent state (no module-level leak)", async () => {
		const { tool: tool1 } = setup();
		await tool1.execute("id", { action: "add", texts: ["first"] }, undefined, undefined, makeRpcCtx().ctx);
		// 第二个 setup 起步，不应看到第一个的 todos
		const { tool: tool2, state: state2 } = setup();
		expect(state2.todos).toHaveLength(0);
		const result = await tool2.execute(
			"id",
			{ action: "list" },
			undefined,
			undefined,
			makeRpcCtx().ctx,
		);
		expect(result.content[0].text).toBe("No todos");
	});

	it("S-2: details.todos is a shallow array copy (splice-safe, element-shared)", async () => {
		// executeTodoAction 用 [...state.todos] 做浅拷贝：数组独立、元素共享。
		// add/delete 改数组长度时旧 details.todos 不受影响；但原地改元素会共享。
		const { tool } = setup();
		await tool.execute("id", { action: "add", texts: ["a", "b"] }, undefined, undefined, makeRpcCtx().ctx);
		const before = (await tool.execute(
			"id",
			{ action: "list" },
			undefined,
			undefined,
			makeRpcCtx().ctx,
		)).details.todos;
		expect(before).toHaveLength(2);
		// delete 改 state.todos 数组，已发出的 before 快照仍为 2 项
		await tool.execute("id", { action: "delete", ids: [1, 2] }, undefined, undefined, makeRpcCtx().ctx);
		expect(before).toHaveLength(2);
	});
});
