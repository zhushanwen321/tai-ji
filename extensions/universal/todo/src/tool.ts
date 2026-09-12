/**
 * Todo tool 注册 + execute dispatcher + 4 个 action handler。
 *
 * Schema 设计（OpenAI 兼容）：TodoParams 为扁平 Type.Object（顶层 type:"object"，
 * 满足 OpenAI function calling 规范——顶层 union 会被严格网关 400 拒绝整个会话启动）。
 * action 字段是字面量 union（list/add/update/delete），其余字段全 Optional；必填校验
 * （add 缺 texts、delete 缺 ids、双形陷阱 text/texts、id/ids）由 handler 运行时承担
 * （见 tool-detectors.test.ts）。范式参考 scheduler 的 ScheduleControlParams；设计
 * 文档见 docs/extensions/tool-schema-openai-compat.md。
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

import {
	addTodos,
	formatTodoList,
	type Todo,
	type TodoDetails,
	updateTodos,
	VALID_STATUSES,
} from "./model";
import { renderTodoResult } from "./render";
import type { TodoSessionState } from "./state";

// ── TodoParams schema（扁平 Type.Object，OpenAI 兼容）──────────
// 顶层必须是 type:"object"（OpenAI function calling 规范——顶层 union 会被严格
// 网关 400 拒绝）。action 字段是字面量 union；其余字段全 Optional，必填校验交给
// handler（见 tool-detectors.test.ts）。TodoParamsT 由 schema 派生，handler 签名
// 统一用它——双形陷阱检测在全 optional 类型上语义不变，且能消除 execute 里的 cast。

const StatusSchema = StringEnum(VALID_STATUSES);

export const TodoParams = Type.Object(
	{
		action: Type.Union(
			[Type.Literal("list"), Type.Literal("add"), Type.Literal("update"), Type.Literal("delete")],
			{ description: "list | add | update | delete" },
		),
		text: Type.Optional(Type.String({ description: "新文本（trim 后不可为空）" })),
		texts: Type.Optional(Type.Array(Type.String(), { description: "待添加的 todo 文本数组" })),
		id: Type.Optional(Type.Number({ description: "要更新的 todo id" })),
		ids: Type.Optional(Type.Array(Type.Number(), { description: "要删除的 todo id 数组" })),
		status: Type.Optional(StatusSchema),
		updates: Type.Optional(
			Type.Array(
				Type.Object(
					{
						id: Type.Number({ description: "要更新的 todo id" }),
						status: Type.Optional(StatusSchema),
						text: Type.Optional(Type.String({ description: "新文本（trim 后不可为空）" })),
					},
					{ additionalProperties: false },
				),
				{ description: "批量更新数组（优先于单条 id/status/text）" },
			),
		),
	},
	{ additionalProperties: false },
);

export type TodoParamsT = Static<typeof TodoParams>;

// ── 4 个 action handler ──────────────────────────────
// 错误处理约定（见 CLAUDE.md「Tool 设计」）：handler 失败直接 throw，
// 不返回「错误成功模式」。model 层纯函数（updateTodos）返回 Result 对象（合法），
// 由 dispatcher 在拿到 error 时 throw，把友好文案交给 Pi 框架展示。
// addTodos 的校验失败直接 throw（C1：不再静默 filter）。

/** list action — 返回完整格式化列表 */
function handleList(state: TodoSessionState): string {
	return state.todos.length ? formatTodoList(state.todos) : "No todos";
}

/** add action — 失败抛错。export 供 behavioral 测试（text/texts 双形陷阱检测）。 */
export function handleAdd(state: TodoSessionState, params: TodoParamsT): string {
	// 双形陷阱：同时传 text 和 texts → throw（TC7）
	if (params.text !== undefined && params.texts !== undefined) {
		throw new Error('add only accepts texts array; do not also pass singular "text"');
	}
	if (!params.texts || params.texts.length === 0) {
		// 双形陷阱：弱模型 add 时误用单数 text（那是 update 的字段）
		if (params.text !== undefined) {
			throw new Error(
				'add needs texts (array). You passed singular "text" — that field is for update. Correct: {"action":"add","texts":["<your text>"]}',
			);
		}
		throw new Error(
			'add requires texts parameter (non-empty array). Correct: {"action":"add","texts":["..."]}',
		);
	}
	// addTodos 内部对空项 trim+throw（C1）；旧列表全部 completed 时自动清理（auto-GC）
	const r = addTodos(state.todos, state.nextId, params.texts);
	state.todos = r.newTodos;
	state.nextId = r.newNextId;
	if (r.autoCleared) {
		// 新任务周期：重置完成跟踪，否则上一任务的 completionSteered=true
		// 会屏蔽本轮全部完成时的质量检查 steer
		state.allCompletedAtCount = null;
		state.completionSteered = false;
	}
	return r.resultText;
}

/** update action: batch — 失败抛错 */
function handleBatchUpdate(state: TodoSessionState, params: TodoParamsT): string {
	const r = updateTodos(state.todos, params.updates ?? []);
	if (r.error) throw new Error(r.resultText);
	state.todos = r.updatedTodos;
	return r.resultText!;
}

/** update action: single — 失败抛错 */
export function handleSingleUpdate(state: TodoSessionState, params: TodoParamsT): string {
	if (params.id === undefined)
		throw new Error(
			'update requires id parameter. Correct: {"action":"update","id":<n>,"status":"in_progress"}',
		);
	if (params.status === undefined && params.text === undefined)
		throw new Error(
			'update requires at least status or text parameter. Correct: {"action":"update","id":<n>,"status":"in_progress"}',
		);
	// text 校验统一（CT5）：trim 后空串 throw（不只判 ===）
	if (params.text !== undefined && params.text.trim().length === 0)
		throw new Error("text cannot be empty or whitespace-only");
	if (
		params.status !== undefined &&
		!VALID_STATUSES.includes(params.status as (typeof VALID_STATUSES)[number])
	) {
		throw new Error(`status only accepts ${VALID_STATUSES.join(" / ")}`);
	}

	const todo = state.todos.find((t) => t.id === params.id);
	if (!todo) throw new Error(`Todo #${params.id} not found`);

	if (params.status !== undefined) todo.status = params.status as Todo["status"];
	if (params.text !== undefined) todo.text = params.text.trim();

	const parts: string[] = [`Updated todo #${todo.id}`];
	if (params.status !== undefined) parts.push(`status → ${params.status}`);
	if (params.text !== undefined) parts.push(`text → "${todo.text}"`);
	return parts.join(", ");
}

/** update action: dispatcher — batch 优先于 single */
function handleUpdate(state: TodoSessionState, params: TodoParamsT): string {
	if (params.updates && params.updates.length > 0) return handleBatchUpdate(state, params);
	return handleSingleUpdate(state, params);
}

/** delete action — 失败抛错；部分 id 缺失则整体拒绝（原子性）。
 * export 供 behavioral 测试（id/ids 双形陷阱检测）。 */
export function handleDelete(state: TodoSessionState, params: TodoParamsT): string {
	if (!params.ids || params.ids.length === 0) {
		// 双形陷阱：弱模型 delete 时误用单数 id（那是 update 的字段）
		if (params.id !== undefined) {
			throw new Error(
				'delete needs ids (array). You passed singular "id" — that field is for update. Correct: {"action":"delete","ids":[<your id>]}',
			);
		}
		throw new Error(
			'delete requires ids parameter (non-empty array). Correct: {"action":"delete","ids":[<n>]}',
		);
	}
	const uniqueIds = [...new Set(params.ids)];
	const missing = uniqueIds.filter((id) => !state.todos.some((t) => t.id === id));
	if (missing.length > 0) {
		throw new Error(`Todo #${missing.join(", #")} not found`);
	}
	const removedIds: number[] = [];
	for (const id of uniqueIds) {
		const idx = state.todos.findIndex((t) => t.id === id);
		if (idx !== -1) {
			state.todos.splice(idx, 1);
			removedIds.push(id);
		}
	}
	return `Deleted ${removedIds.length} items (#${removedIds.join(", #")}), ${state.todos.length} remaining`;
}

// ── Dispatcher ───────────────────────────────────────

function executeTodoAction(
	params: TodoParamsT,
	state: TodoSessionState,
	ctx: ExtensionContext,
	refreshDisplay: (ctx: ExtensionContext) => void,
): {
	content: Array<{ type: "text"; text: string }>;
	details: TodoDetails;
} {
	const isMutation = params.action !== "list";

	let resultText: string;
	switch (params.action) {
		case "list":
			resultText = handleList(state);
			break;
		case "add":
			resultText = handleAdd(state, params);
			break;
		case "update":
			resultText = handleUpdate(state, params);
			break;
		case "delete":
			resultText = handleDelete(state, params);
			break;
		default:
			throw new Error(`Unknown action: ${params.action}`);
	}

	refreshDisplay(ctx);

	// content 组装（T3）：突变附带完整列表；list 已含列表
	let contentText: string;
	if (isMutation) {
		const listText = state.todos.length > 0 ? formatTodoList(state.todos) : "No todos";
		contentText = `${resultText}\n${listText}`;
	} else {
		contentText = resultText;
	}

	const details: TodoDetails = {
		action: params.action as TodoDetails["action"],
		todos: [...state.todos],
		nextId: state.nextId,
	};
	// 状态展示不再进 tool result（GUI 渲染字段已移除）：GUI 走 refreshDisplay 的
	// guiSetWidget 推送（M17 widget 面板），TUI 走原生文本渲染（contentText 已在 content 中）。
	return {
		content: [{ type: "text" as const, text: contentText }],
		details,
	};
}

// ── Tool 注册入口 ─────────────────────────────────────

export function registerTodoTool(
	pi: ExtensionAPI,
	state: TodoSessionState,
	refreshDisplay: (ctx: ExtensionContext) => void,
): void {
	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"管理当前会话的 todo 列表。" +
			"\n\n动作：" +
			"\n- list: 查看全部 todo" +
			"\n- add: 批量添加 todo（texts 数组）" +
			"\n- update: 按 id 更新 todo——status 和/或 text；批量用 updates[]" +
			"\n- delete: 按 id 删除 todo（ids 数组）" +
			"\n\n规则：" +
			"\n- 同一时间只有一个 todo 处于 in_progress" +
			"\n- 完成一个 todo 立即标记 completed，不要攒到最后批量标记" +
			"\n- 未真正完成不得标记 completed：被阻塞或测试失败时保持 in_progress" +
			"\n- 列表保持聚焦：建议 todo 总数不超过 10 个，细粒度步骤优先合并" +
			"\n- 旧任务全部 completed 后再 add 会自动清理旧列表，直接添加新任务即可",
		promptSnippet: "用 todo 跟踪多步骤工作；记得为验证步骤（测试、类型检查）单独建 todo。",
		promptGuidelines: [
			"[Usage] 多步骤工作（3+步）时使用，AI 自发创建，无需用户触发",
			"[验证任务] 为测试 / 类型检查等验证步骤单独建 todo，完成前确保验证通过",
			"[批量优先] 完成多项任务时使用 updates[] 批量更新，减少工具调用次数",
			"[自动闭合] 全部完成后自动清理，无需手动 delete",
			"[规模控制] todo 总数建议不超过 10 个；超过时合并细粒度步骤或 delete 掉不再需要的项",
			"[Not for] 单步操作、简单对话",
		],
		executionMode: "sequential",
		parameters: TodoParams,

		async execute(_toolCallId: string, params: TodoParamsT, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			if (signal?.aborted) throw new Error("Todo call aborted by signal.");
			return executeTodoAction(params, state, ctx, refreshDisplay);
		},

		renderCall(args: Record<string, unknown>, theme: Theme, _context?: unknown) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action as string);
			const texts = args.texts as string[] | undefined;
			const ids = args.ids as number[] | undefined;
			if (texts && texts.length > 0) text += ` ${theme.fg("dim", `(${texts.length} items)`)}`;
			if (ids && ids.length > 0) text += ` ${theme.fg("accent", `#${ids.join(", #")}`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.status) text += ` ${theme.fg("warning", args.status as string)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result: unknown, options: { expanded: boolean }, theme: Theme, _context?: unknown) {
			return renderTodoResult(result, options, theme);
		},
	});
}
