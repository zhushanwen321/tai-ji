/**
 * Todo 数据模型 — 纯函数，不依赖 Pi 运行时。
 * 三态: pending → in_progress → completed
 */

import {
	type GuiComponent,
	type GuiRenderResult,
	guiComponent,
	guiResult,
	type TreeItem,
	type WidgetMeta,
} from "@zhushanwen/extension-protocol";

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

/** 合法状态三态的推导类型（导出供包内其余模块命名收窄后的类型）。 */
export type ValidStatus = (typeof VALID_STATUSES)[number];

/**
 * status 合法性判据（type guard）：migrate 迁移映射 / tool 单条 update / model 批量
 * update 三处共享的同一校验原语——判定规则单点，错误文案由各调用方按面向对象
 * （迁移降级 / LLM 单条引导 / 批量 id 定位）自行编排，展示层差异不属规则差异。
 */
export function isValidTodoStatus(status: string): status is ValidStatus {
	return (VALID_STATUSES as readonly string[]).includes(status);
}

/**
 * update text 有效性判据（CT5）：trim 后空串 = 非法（不只判 ===），tool 单条与
 * model 批量两条 update 路径共享。
 */
export function isBlankUpdateText(text: string): boolean {
	return text.trim().length === 0;
}

// ── 迁移/兼容 ───────────────────────────────────────

/**
 * 历史状态 → 现态映射（旧格式一次性降级）。
 *
 * 三态化：cancelled → completed 不丢数据，且解除 every(completed) 死锁。
 */
const LEGACY_STATUS: Record<string, ValidStatus> = {
	verifying: "in_progress",
	failed: "pending",
	cancelled: "completed",
};

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
	const rawStatusField = record.status;
	const hasValidStatus = typeof rawStatusField === "string" && isValidTodoStatus(rawStatusField);

	let status: ValidStatus;
	if (hasValidStatus) {
		status = rawStatusField;
	} else {
		// 极旧格式 done: boolean
		const done = typeof record.done === "boolean" ? record.done : undefined;
		status = done === true ? "completed" : "pending";
	}

	// 历史状态映射（查表单点：三条互斥 if → 一张表，不再裸 cast）
	const rawStatus = typeof record.status === "string" ? record.status : undefined;
	const legacyStatus = rawStatus ? LEGACY_STATUS[rawStatus] : undefined;
	if (legacyStatus) status = legacyStatus;

	// id/text 契约校验：脏 id（非 number / NaN）会在 reconstructState 的 Math.max 推导
	// nextId 时产出 NaN 毒化后续 add/update/delete 锚点，脏 text 破坏渲染与 add 的 trim
	// 契约——按「脏数据明确报错 → 调用方单条跳过」契约，与上方 null/primitive 守卫同型
	// throw TypeError（调用方 reconstructState 收集降级）。
	const id = record.id;
	if (typeof id !== "number" || Number.isNaN(id)) {
		throw new TypeError(
			`migrateTodo: invalid id (expected number, got ${typeof id}${Number.isNaN(id) ? " NaN" : ""})`,
		);
	}
	if (typeof record.text !== "string") {
		throw new TypeError(`migrateTodo: invalid text (expected string, got ${typeof record.text})`);
	}

	return {
		id,
		text: record.text,
		status,
	};
}

// ── GUI 渲染辅助 ─────────────────────────────────────

/** completed 计数单一来源：renderStatusText / renderWidgetLines / component 三个消费点共用口径
 * （buildGui 的 tab 计数与段内容改由 openTodos/doneTodos 同源复用，不再经本函数）。 */
export function todoProgress(todos: Todo[]): { completed: number; total: number } {
	return {
		completed: todos.filter((t) => t.status === "completed").length,
		total: todos.length,
	};
}

/** 单段清单：两段共用同一构造（仅过滤条件不同），保住行首序号范式与 status 映射的单一口径。 */
function todoListTree(todos: Todo[]): GuiComponent {
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
	return guiComponent("list-tree", { numbered: true, items });
}

/**
 * 把 todos 组装为 GuiRenderResult（meta head + tab-bar 双段架构）。
 *
 * - meta（标题/状态/进度/icon/badge）由宿主壳层（widget 面板 head + 托盘）唯一渲染：
 *   进度计数 "N/M" + mini bar 替代 body 内 progress-bar（精简 body），全完成 status=done
 *   （head 绿点 + bar 变绿）；icon 点名 lucide key 'list-checks'（与宿主内置 widgetKey
 *   映射 'todo'→ListChecks 同图标）——宿主映射只是兜底，显式声明后宿主调整自己的映射表
 *   也不会换掉 todo 的图标；badge = 未完成条数（托盘 `[☑ 2]`，宿主超长 truncate）。
 * - 内容根 = tab-bar 双段（tabs/sections 等长 2 段，宿主本地切换、不回传 extension）：
 *   待办段 = 未完成项（pending + in_progress），已完成段 = completed 项——两段互斥且覆盖
 *   全量，tab 标签计数与段内容同源（否则「待办 N」与实际行数成双口径）；分段而非堆叠，
 *   使已完成项不占待办首屏（面板形态裁决，设计 D5）。
 * - 两段同构 numbered list-tree：行首弱化序号（编辑器行号范式，ListTree 渲染），
 *   id 不再烧进 label——update/delete 锚点由模型经 list action 获取，用户引用
 *   「第 N 项」即可；状态由行尾圆点单一表达（无 icon，v6 单一信息源裁决）。
 *   空段 = items 为空的 list-tree（沿用既有空态语义，不加装饰性占位）。
 *
 * status → 圆点映射：
 *   pending      → 无圆点（常态归零）
 *   in_progress  → running（accent）
 *   completed    → done（success + label 弱化）
 */
export function buildGui(todos: Todo[]): GuiRenderResult {
	// 先划分段数组，再复用同一批数组产出标签/内容/badge/inProgress——避免
	// 「total - completed」与「两次 filter」两个口径各自推导同一事实。
	const openTodos = todos.filter((t) => t.status !== "completed");
	const doneTodos = todos.filter((t) => t.status === "completed");
	const total = todos.length;
	const completed = doneTodos.length;
	const open = openTodos.length;
	const inProgress = openTodos.filter((t) => t.status === "in_progress").length;

	const status: WidgetMeta["status"] =
		total > 0 && completed === total ? "done" : inProgress > 0 ? "running" : "idle";

	return guiResult(
		guiComponent("tab-bar", {
			tabs: [
				// 首段带 active：容器化宿主据此建立初始 tab（此后本地切换不被推送重置）
				{ label: `待办 ${open}`, active: true },
				{ label: `已完成 ${completed}` },
			],
			// 段 = 子树（组件数组，与 tabs 等长一一对应；宿主渲染 active 段的全部子组件）
			sections: [
				[todoListTree(openTodos)],
				[todoListTree(doneTodos)],
			],
		}),
		{
			title: "Todo",
			status,
			progress: total > 0 ? { current: completed, total } : undefined,
			icon: "list-checks",
			badge: String(open),
		},
	);
}

// ── Add 逻辑 ─────────────────────────────────────────

/** 建议的单 session todo 数上限（软约束：超限提醒，不硬拒绝） */
export const RECOMMENDED_MAX_TODOS = 10;

interface AddResult {
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

/** updateTodos 成功返回形状；校验失败直接 throw（包内单一错误协议）。 */
interface UpdateResult {
	updatedTodos: Todo[];
	resultText: string;
}

/**
 * 批量更新 todo。校验失败（重复 id / id 不存在 / 无 status 无 text / 非法 status）
 * 直接 throw——与 addTodos / handler 同一 throw 协议，文案不带 "Error: " 前缀
 * （错误形态由 pi 工具错误通道表达）；throw 发生在任何突变之前，state 保持不变。
 */
export function updateTodos(
	currentTodos: Todo[],
	updates: Array<{ id: number; status?: string; text?: string }>,
): UpdateResult {
	// text 校验统一（CT5）：text 存在则 trim，空串 throw（不静默跳过）
	for (const u of updates) {
		if (u.text !== undefined && isBlankUpdateText(u.text)) {
			throw new Error(`update item id ${u.id}: text cannot be empty or whitespace-only`);
		}
	}

	const ids = updates.map((u) => u.id);
	if (new Set(ids).size !== ids.length) {
		throw new Error("duplicate ids in updates");
	}
	// 校验遍同时产出 patch（非法输入在任何突变前 throw，文案不变）；突变遍直接消
	// patch，不再重复判定同一条件（旧实现第二遍 isValidTodoStatus 恒真）
	const patches = new Map<number, { status?: Todo["status"]; text?: string }>();
	for (const u of updates) {
		if (!currentTodos.some((t) => t.id === u.id)) {
			throw new Error(`Todo #${u.id} not found`);
		}
		if (!u.status && !u.text) {
			throw new Error(`update item for id ${u.id} has neither status nor text`);
		}
		const patch: { status?: Todo["status"]; text?: string } = {};
		if (u.status) {
			if (!isValidTodoStatus(u.status)) {
				throw new Error(`invalid status '${u.status}' for update item id ${u.id}`);
			}
			patch.status = u.status;
		}
		if (u.text !== undefined) patch.text = u.text.trim();
		patches.set(u.id, patch);
	}

	const updated = currentTodos.map((t) => {
		const patch = patches.get(t.id);
		return patch ? { ...t, ...patch } : t;
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
