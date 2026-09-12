/**
 * Todo 数据模型 — 纯函数，不依赖 Pi 运行时。
 * 三态: pending → in_progress → completed
 */

import {
	type GuiRenderResult,
	guiComponent,
	guiResult,
	type TreeItem,
	type WidgetMeta,
} from "@xyz-agent/extension-protocol";

// ── 数据模型 ─────────────────────────────────────────

export interface Todo {
	id: number;
	text: string;
	status: "pending" | "in_progress" | "completed";
}

export interface TodoDetails {
	action: "list" | "add" | "update" | "delete";
	todos: Todo[];
	nextId: number;
}

export const VALID_STATUSES = ["pending", "in_progress", "completed"] as const;

export type ValidStatus = (typeof VALID_STATUSES)[number];

// ── 迁移/兼容 ───────────────────────────────────────

/** 旧格式迁移：verifying → in_progress，failed → pending，cancelled → completed（历史三态化降级），done:boolean → status */
export function migrateTodo(raw: unknown): Todo {
	// raw 是任意旧格式数据（兼容 done:boolean 等历史结构），以 Record 方式安全访问字段
	// 守卫：null/原始类型（typeof null === 'object'，必须显式排除 null）→ 明确报错而非混淆的 TypeError
	if (raw === null || typeof raw !== "object") {
		throw new TypeError(
			`migrateTodo: expected object, got ${raw === null ? "null" : typeof raw}`,
		);
	}
	const record = raw as Record<string, unknown>;
	const hasValidStatus =
		typeof record.status === "string" &&
		VALID_STATUSES.includes(record.status as ValidStatus);

	let status: ValidStatus;
	if (hasValidStatus) {
		status = record.status as ValidStatus;
	} else {
		// 极旧格式 done: boolean
		const done = typeof record.done === "boolean" ? record.done : undefined;
		status = done === true ? "completed" : "pending";
	}

	// 历史状态映射（先转 string 避免类型收窄后无法比较）
	const rawStatus = record.status as string | undefined;
	if (rawStatus === "verifying") status = "in_progress";
	if (rawStatus === "failed") status = "pending";
	// 三态化降级：历史 cancelled 项映射为 completed（不丢数据，且解除 every(completed) 死锁）
	if (rawStatus === "cancelled") status = "completed";

	return {
		id: record.id as number,
		text: record.text as string,
		status,
	};
}

// ── GUI 渲染辅助 ─────────────────────────────────────

/**
 * 把 todos 组装为 GuiRenderResult（v1.1 meta head 架构，对齐 extension-protocol@0.3.0）。
 *
 * - meta（标题/状态/进度）由宿主壳层渲染成唯一 head：进度计数 "N/M" + mini bar
 *   替代 body 内 progress-bar（精简 body），全完成 status=done（head 绿点 + bar 变绿）。
 * - 内容根 = numbered list-tree：行首弱化序号（编辑器行号范式，ListTree 渲染），
 *   id 不再烧进 label——update/delete 锚点由模型经 list action 获取，用户引用
 *   「第 N 项」即可；状态由行尾圆点单一表达（无 icon，v6 单一信息源裁决）。
 *
 * status → 圆点映射：
 *   pending      → 无圆点（常态归零）
 *   in_progress  → running（accent）
 *   completed    → done（success + label 弱化）
 */
export function buildGui(todos: Todo[]): GuiRenderResult {
	const total = todos.length;
	const completed = todos.filter((t) => t.status === "completed").length;
	const inProgress = todos.filter((t) => t.status === "in_progress").length;

	const status: WidgetMeta["status"] =
		total > 0 && completed === total ? "done" : inProgress > 0 ? "running" : "idle";

	const items: TreeItem[] = todos.map((t) => ({
		label: t.text,
		status:
			t.status === "in_progress"
				? "running"
				: t.status === "completed"
					? "done"
					: undefined, // pending 无 status
		depth: 0,
	}));

	return guiResult(
		guiComponent("list-tree", { numbered: true, items }),
		{
			title: "Todo",
			status,
			progress: total > 0 ? { current: completed, total } : undefined,
		},
	);
}

// ── Add 逻辑 ─────────────────────────────────────────

/** 建议的单 session todo 数上限（软约束：超限提醒，不硬拒绝） */
export const RECOMMENDED_MAX_TODOS = 10;

export interface AddResult {
	newTodos: Todo[];
	newNextId: number;
	resultText: string;
	/** 旧列表全部 completed 被自动清理时为 true（handleAdd 据此重置完成周期跟踪） */
	autoCleared: boolean;
}

/**
 * 批量新增 todo。
 * texts 整体 trim；任一项 trim 后为空串则 throw（不再静默 filter 丢弃——
 * 模型应学到传有效项，C1 决策）。
 *
 * auto-GC：旧列表非空且全部 completed 时视为「上一任务已结束、开启新任务」，
 * 先清空旧列表再新增（nextId 重置为 1，与 handlers.handleAutoClear 的清理
 * 语义一致），避免已完结任务长期堆积在列表里。
 */
export function addTodos(
	currentTodos: Todo[],
	currentNextId: number,
	texts: string[],
): AddResult {
	if (!texts || texts.length === 0) {
		throw new Error("add requires texts parameter (non-empty array)");
	}

	const trimmed = texts.map((t) => t.trim());
	// 任一项 trim 后空串 → throw（不静默 filter）
	if (trimmed.some((t) => t.length === 0)) {
		throw new Error("texts must not contain empty or whitespace-only items");
	}

	const autoCleared =
		currentTodos.length > 0 && currentTodos.every((t) => t.status === "completed");
	const baseTodos = autoCleared ? [] : currentTodos;
	const startId = autoCleared ? 1 : currentNextId;

	const newTodos = [...baseTodos];
	let nextId = startId;
	for (let i = 0; i < trimmed.length; i++) {
		newTodos.push({
			id: nextId++,
			text: trimmed[i],
			status: "pending" as const,
		});
	}
	const endId = nextId - 1;

	let resultText = `Added ${trimmed.length} todos (#${startId}-#${endId})`;
	if (autoCleared) {
		resultText += `\nAuto-cleared ${currentTodos.length} completed todo(s) from the previous task`;
	}

	// 软上限提醒：总数超过建议值时附加提醒（不拒绝，把决策留给模型）
	if (newTodos.length > RECOMMENDED_MAX_TODOS) {
		resultText += `\nNote: ${newTodos.length} todos exceeds the recommended max of ${RECOMMENDED_MAX_TODOS}. Prefer consolidating fine-grained steps or deleting items no longer needed.`;
	}

	return {
		newTodos,
		newNextId: nextId,
		resultText,
		autoCleared,
	};
}

// ── Update 逻辑 ──────────────────────────────────────

export interface UpdateResult {
	updatedTodos: Todo[];
	error?: string;
	resultText?: string;
}

export function updateTodos(
	currentTodos: Todo[],
	updates: Array<{ id: number; status?: string; text?: string }>,
): UpdateResult {
	// text 校验统一（CT5）：text 存在则 trim，空串 throw（不静默跳过）
	for (const u of updates) {
		if (u.text !== undefined && u.text.trim().length === 0) {
			throw new Error(`update item id ${u.id}: text cannot be empty or whitespace-only`);
		}
	}

	const ids = updates.map((u) => u.id);
	if (new Set(ids).size !== ids.length) {
		return {
			updatedTodos: currentTodos,
			error: "duplicate ids in updates",
			resultText: "Error: duplicate ids in updates",
		};
	}
	for (const u of updates) {
		const todo = currentTodos.find((t) => t.id === u.id);
		if (!todo) {
			return {
				updatedTodos: currentTodos,
				error: `id ${u.id} not found`,
				resultText: `Error: Todo #${u.id} not found`,
			};
		}
		if (!u.status && !u.text) {
			return {
				updatedTodos: currentTodos,
				error: `update item for id ${u.id} has neither status nor text`,
				resultText: `Error: update item for id ${u.id} has neither status nor text`,
			};
		}
		if (u.status && !VALID_STATUSES.includes(u.status as (typeof VALID_STATUSES)[number])) {
			return {
				updatedTodos: currentTodos,
				error: `invalid status: ${u.status}`,
				resultText: `Error: invalid status '${u.status}' for update item id ${u.id}`,
			};
		}
	}

	const updated = currentTodos.map((t) => {
		const u = updates.find((u) => u.id === t.id);
		if (!u) return t;
		const patch: Partial<Todo> = {};
		if (u.status) patch.status = u.status as Todo["status"];
		if (u.text !== undefined) patch.text = u.text.trim();
		return { ...t, ...patch };
	});
	return {
		updatedTodos: updated,
		resultText: `Updated ${updates.length} todo(s)`,
	};
}

// ── 格式化辅助 ───────────────────────────────────────

export function formatTodoLine(t: Todo): string {
	const mark =
		t.status === "completed"
			? "x"
			: t.status === "in_progress"
				? "~"
				: " "; // pending
	return `[${mark}] #${t.id}: ${t.text}`;
}

/** 把整张列表格式化为多行文本，每行复用 formatTodoLine（T3）。 */
export function formatTodoList(todos: Todo[]): string {
	return todos.map((t) => formatTodoLine(t)).join("\n");
}
