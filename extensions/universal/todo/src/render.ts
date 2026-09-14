/**
 * Todo 渲染函数 — 状态栏、widget（双列）、tool result 渲染。
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import {
	todoProgress,
	type Todo,
	type TodoDetails,
} from "./model";

// ── 常量 ────────────────────────────────────────────

const MAX_COLLAPSED_ITEMS = 5;
export const FALLBACK_TERM_WIDTH = 80;

/**
 * Pi 对单个 extension widget 的最大字符串行数为 10（InteractiveMode.MAX_WIDGET_LINES）。
 * 扩展侧保守使用 max - 1 = 9 行作为阈值，超过时切换为双列布局，避免触发截断。
 */
const WIDGET_MAX_LINES = 9;
const SINGLE_COLUMN_BUDGET = WIDGET_MAX_LINES - 1;

/** 垂直分割线视觉宽度（" │ "） */
const DIVIDER_VISUAL_WIDTH = 3;
/** 省略号视觉宽度（"..."） */
const ELLIPSIS_WIDTH = 3;

// ── 状态栏 ────────────────────────────────────────────

export function renderStatusText(todoList: Todo[], th: Theme): string {
	if (todoList.length === 0) return "";

	const { completed, total } = todoProgress(todoList);

	if (completed === total) {
		return th.fg("success", `\u2713 ${completed}/${total}`);
	}
	return th.fg("accent", "\u2611") + th.fg("muted", ` ${completed}/${total}`);
}

// ── Widget 双列渲染 ──────────────────────────────────

/** 渲染单条 todo 的 widget 行（不含缩进），供 component.ts 复用。
 * textColor = 非完成态文本颜色（widget 用 "text"，tool result 列表用 "muted"——历史差异显式保留，未做视觉统一）。 */
function renderWidgetItem(t: Todo, th: Theme, textColor: ThemeColor = "text"): string {
	const mark =
		t.status === "completed"
			? th.fg("success", "\u2713")
			: t.status === "in_progress"
				? th.fg("warning", "\u25cf")
				: th.fg("dim", "\u25cb"); // pending
	const id = th.fg("accent", `#${t.id}`);
	const text = t.status === "completed" ? th.fg("dim", t.text) : th.fg(textColor, t.text);
	return `${mark} ${id} ${text}`;
}

/** 单列布局渲染（widget 少量任务时使用） */
const PI_TEXT_PADDING = 2;

function renderSingleColumn(
	todos: Todo[],
	th: Theme,
	termWidth: number,
	indent: string,
): string[] {
	const maxWidth = Math.max(1, termWidth - PI_TEXT_PADDING);
	return todos.map((t) => truncateToWidth(indent + renderWidgetItem(t, th), maxWidth));
}

/** 双列布局渲染，供 widget 和 component 复用 */
const COLUMN_COUNT = 2;

export function renderDualColumn(
	todos: Todo[],
	th: Theme,
	termWidth: number,
	indent: string,
): string[] {
	const colWidth = Math.floor((termWidth - indent.length - DIVIDER_VISUAL_WIDTH) / COLUMN_COUNT);
	const lines: string[] = [];
	const half = Math.ceil(todos.length / COLUMN_COUNT);
	const divider = " " + th.fg("borderMuted", "\u2502") + " ";
	// 补齐/截断到列宽：可见输出与 D14 替换前的列宽逻辑逐字符一致（裁决零行为变化）——
	// 截断列保持「前缀+6点」旧形态，不可简化为单调用 truncateToWidth(text, colWidth, "...", true)
	// （会改为前缀+3点）；行为由 __tests__/render.test.ts 锁定。colWidth <= ELLIPSIS_WIDTH 走 pi-tui
	// clipped-ellipsis 路径，可见一致（ANSI reset 包裹差异不影响渲染）。负列宽（病态窄终端）pi-tui 对
	// maxWidth<=0 恒空串，无法复现旧 slice 负索引语义，保留原特判。
	const fit = (text: string): string =>
		colWidth < 0
			? "...".slice(0, colWidth)
			: visibleWidth(text) <= colWidth || colWidth <= ELLIPSIS_WIDTH
				? truncateToWidth(text, colWidth, "...", true)
				: truncateToWidth(text, colWidth - ELLIPSIS_WIDTH) + "...";
	for (let row = 0; row < half; row++) {
		const left = fit(indent + renderWidgetItem(todos[row], th));
		const rightIdx = row + half;
		const right = rightIdx < todos.length
			? fit(renderWidgetItem(todos[rightIdx], th))
			: " ".repeat(colWidth);
		lines.push(left + divider + right);
	}
	return lines;
}

/** 渲染 widget 行（根据任务数自动选择单列或双列布局） */
export function renderWidgetLines(
	todoList: Todo[],
	th: Theme,
	termWidth?: number,
): string[] {
	if (todoList.length === 0) return [];

	const width = termWidth ?? (process.stdout.columns || FALLBACK_TERM_WIDTH);
	const lines: string[] = [];
	const { completed, total } = todoProgress(todoList);

	lines.push(th.fg("accent", "\u2611") + th.fg("muted", ` ${completed}/${total}`));

	// 标题占 1 行；任务部分超过 WIDGET_MAX_LINES - 1 时启用双列
	const indent = "  ";
	if (todoList.length <= SINGLE_COLUMN_BUDGET) {
		for (const line of renderSingleColumn(todoList, th, width, indent)) {
			lines.push(line);
		}
	} else {
		for (const line of renderDualColumn(todoList, th, width, indent)) {
			lines.push(line);
		}
	}

	return lines;
}

// ── 列表渲染辅助函数 ─────────────────────────────────

function buildTodoListText(todoList: Todo[], options: { expanded: boolean }, theme: Theme): string {
	if (todoList.length === 0) {
		return theme.fg("dim", "No todos");
	}
	let listText = theme.fg("muted", `${todoList.length} todos:`);
	const display = options.expanded ? todoList : todoList.slice(0, MAX_COLLAPSED_ITEMS);
	for (const t of display) {
		listText += `\n${renderWidgetItem(t, theme, "muted")}`;
	}
	if (!options.expanded && todoList.length > MAX_COLLAPSED_ITEMS) {
		listText += `\n${theme.fg("dim", `... ${todoList.length - MAX_COLLAPSED_ITEMS} more`)}`;
	}
	return listText;
}

// ── Tool renderResult handler ────────────────────────

import { Text } from "@earendil-works/pi-tui";
import { firstContentText } from "@xyz-agent/extension-protocol";

export function renderTodoResult(result: unknown, options: { expanded: boolean }, theme: Theme): Text {
	const r = result as { content: Array<{ type: string; text?: string }>; details?: unknown };
	const details = r.details as TodoDetails | undefined;
	if (!details) {
		return new Text(firstContentText(r), 0, 0);
	}
	return renderDetailedTodoResult(r, options, theme, details);
}

/** 有 details 时按 action 分发渲染（switch 每个 case 体独立成函数） */
function renderDetailedTodoResult(
	r: { content: Array<{ type: string; text?: string }> },
	options: { expanded: boolean },
	theme: Theme,
	details: TodoDetails,
): Text {
	const todoList = details.todos;

	switch (details.action) {
		case "list": {
			return new Text(buildTodoListText(todoList, options, theme), 0, 0);
		}

		case "add":
		case "update":
		case "delete": {
			return renderMutationTodoResult(r, options, theme, todoList);
		}

		default: {
			return renderFallbackTodoResult(r, theme);
		}
	}
}

/** add/update/delete：确认消息 + 空行 + 全量列表 */
function renderMutationTodoResult(
	r: { content: Array<{ type: string; text?: string }> },
	options: { expanded: boolean },
	theme: Theme,
	todoList: Todo[],
): Text {
	const msg = firstContentText(r);
	const listText = buildTodoListText(todoList, options, theme);
	return new Text(
		theme.fg("success", "\u2713 ") + theme.fg("muted", msg) + "\n\n" + listText,
		0,
		0,
	);
}

/** 其余/未知 action：dim 文案，空文案兜底 "Done" */
function renderFallbackTodoResult(
	r: { content: Array<{ type: string; text?: string }> },
	theme: Theme,
): Text {
	const msg = firstContentText(r);
	return new Text(theme.fg("dim", msg || "Done"), 0, 0);
}
