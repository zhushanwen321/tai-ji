import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
	addTodos,
	formatTodoLine,
	formatTodoList,
	migrateTodo,
	type Todo,
	updateTodos,
	VALID_STATUSES,
} from "../model";
import { renderWidgetLines } from "../render";
import { createTodoSessionState } from "../state";
import { handleAdd, handleSingleUpdate } from "../tool";

// ── 数据模型 + 向后兼容 ──────────────────────────────

describe("Todo data model", () => {
	it("should load old data without verifyText/verifyAttempts", () => {
		const oldTodo = { id: 1, text: "test", status: "completed" } as unknown as Todo;
		const migrated = migrateTodo(oldTodo);

		expect(migrated.status).toBe("completed");
		expect(migrated.text).toBe("test");
		expect(migrated.id).toBe(1);
	});

	it("VALID_STATUSES 仅三态（pending/in_progress/completed）", () => {
		expect(VALID_STATUSES).toEqual(["pending", "in_progress", "completed"]);
	});

	it("should migrate verifying → in_progress", () => {
		const oldTodo = { id: 1, text: "test", status: "verifying" } as unknown as Todo;
		const migrated = migrateTodo(oldTodo);
		expect(migrated.status).toBe("in_progress");
	});

	it("should migrate failed → pending", () => {
		const oldTodo = { id: 1, text: "test", status: "failed" } as unknown as Todo;
		const migrated = migrateTodo(oldTodo);
		expect(migrated.status).toBe("pending");
	});

	it("should migrate done:true to completed", () => {
		const veryOldTodo = { id: 3, text: "ancient", done: true } as unknown as Todo;
		const migrated = migrateTodo(veryOldTodo);
		expect(migrated.status).toBe("completed");
	});

	it("should migrate done:false to pending", () => {
		const veryOldTodo = { id: 4, text: "ancient2", done: false } as unknown as Todo;
		const migrated = migrateTodo(veryOldTodo);
		expect(migrated.status).toBe("pending");
	});

	it("TC1: 历史 cancelled → completed（三态化降级，不丢数据）", () => {
		const todo = { id: 1, text: "dropped", status: "cancelled" } as unknown as Todo;
		const migrated = migrateTodo(todo);
		expect(migrated.status).toBe("completed");
		expect(migrated.text).toBe("dropped");
		expect(migrated.id).toBe(1);
	});

	it("should throw on null/primitive input (dirty data guard)", () => {
		expect(() => migrateTodo(null)).toThrow(TypeError);
		expect(() => migrateTodo(undefined)).toThrow(TypeError);
		expect(() => migrateTodo("garbage")).toThrow(TypeError);
	});
});

// ── todo add ────────────────────────────────────────

describe("todo add", () => {
	it("should add todos with sequential IDs", () => {
		const result = addTodos([], 1, ["A", "B"]);
		expect(result.newTodos).toHaveLength(2);
		expect(result.newTodos[0].id).toBe(1);
		expect(result.newTodos[1].id).toBe(2);
		expect(result.newTodos[0].status).toBe("pending");
	});

	it("should append to existing todos", () => {
		const existing: Todo[] = [{ id: 1, text: "existing", status: "pending" }];
		const result = addTodos(existing, 2, ["new task"]);
		expect(result.newTodos).toHaveLength(2);
		expect(result.newTodos[1].id).toBe(2);
		expect(result.newTodos[1].text).toBe("new task");
		expect(result.newNextId).toBe(3);
	});

	it("TC6: should throw when texts is empty array", () => {
		expect(() => addTodos([], 1, [])).toThrow(/requires texts/);
	});

	it("TC6: should throw when any text is empty after trim (不再静默 filter)", () => {
		// C1 决策：任一项 trim 后空串 → throw，不再 filter 静默丢弃
		expect(() => addTodos([], 1, ["  ", "valid"])).toThrow(/empty or whitespace-only/);
		expect(() => addTodos([], 1, ["  ", " "])).toThrow(/empty or whitespace-only/);
	});

	it("should trim texts", () => {
		const result = addTodos([], 1, ["  new task  "]);
		expect(result.newTodos[0].text).toBe("new task");
	});
});

// ── todo add — auto-GC（全部 completed 后 add 自动清理旧列表）──

describe("todo add auto-GC", () => {
	it("旧列表全部 completed → 清空旧列表，新 id 从 1 开始，nextId 重置", () => {
		const existing: Todo[] = [
			{ id: 1, text: "old A", status: "completed" },
			{ id: 2, text: "old B", status: "completed" },
		];
		const result = addTodos(existing, 3, ["new task"]);

		expect(result.autoCleared).toBe(true);
		expect(result.newTodos).toHaveLength(1);
		expect(result.newTodos[0]).toEqual({ id: 1, text: "new task", status: "pending" });
		expect(result.newNextId).toBe(2);
	});

	it("存在未完成项（pending/in_progress）→ 不清理，正常追加", () => {
		const existing: Todo[] = [
			{ id: 1, text: "done", status: "completed" },
			{ id: 2, text: "wip", status: "in_progress" },
			{ id: 3, text: "waiting", status: "pending" },
		];
		const result = addTodos(existing, 4, ["more"]);

		expect(result.autoCleared).toBe(false);
		expect(result.newTodos).toHaveLength(4);
		expect(result.newTodos[3].id).toBe(4);
	});

	it("空列表 → 不触发 auto-GC（autoCleared=false）", () => {
		const result = addTodos([], 1, ["first"]);
		expect(result.autoCleared).toBe(false);
		expect(result.newTodos[0].id).toBe(1);
	});

	it("resultText 说明自动清理了旧列表", () => {
		const existing: Todo[] = [{ id: 1, text: "old", status: "completed" }];
		const result = addTodos(existing, 2, ["new task"]);
		expect(result.resultText).toContain("Auto-cleared 1 completed todo(s)");
	});
});

// ── todo add — 超限软提醒（> RECOMMENDED_MAX_TODOS）──

describe("todo add over-limit reminder", () => {
	function makeTodos(n: number): Todo[] {
		return Array.from({ length: n }, (_, i) => ({
			id: i + 1,
			text: `task ${i + 1}`,
			status: "pending" as const,
		}));
	}

	it("总数超过 10 → resultText 附加提醒（含建议上限值）", () => {
		const result = addTodos(makeTodos(9), 10, ["x", "y"]);
		expect(result.newTodos).toHaveLength(11);
		expect(result.resultText).toContain("recommended max of 10");
	});

	it("总数恰为 10 → 不提醒", () => {
		const result = addTodos(makeTodos(9), 10, ["x"]);
		expect(result.newTodos).toHaveLength(10);
		expect(result.resultText).not.toContain("recommended max");
	});

	it("旧列表全部 completed 的 auto-GC 场景，新列表 ≤10 → 不误报提醒", () => {
		const completed = Array.from({ length: 12 }, (_, i) => ({
			id: i + 1,
			text: `old ${i + 1}`,
			status: "completed" as const,
		}));
		const result = addTodos(completed, 13, ["fresh task"]);
		expect(result.autoCleared).toBe(true);
		expect(result.newTodos).toHaveLength(1);
		expect(result.resultText).not.toContain("recommended max");
	});
});

// ── todo update batch ───────────────────────────────

describe("todo update batch", () => {
	it("should update multiple todos with updates[]", () => {
		const todos: Todo[] = [
			{ id: 1, text: "A", status: "pending" },
			{ id: 2, text: "B", status: "in_progress" },
			{ id: 3, text: "C", status: "pending" },
		];
		const result = updateTodos(todos, [
			{ id: 1, status: "completed" },
			{ id: 2, text: "B updated" },
			{ id: 3, status: "completed", text: "C done" },
		]);

		expect(result.error).toBeUndefined();
		expect(result.updatedTodos).toHaveLength(3);
		expect(result.updatedTodos[0].status).toBe("completed");
		expect(result.updatedTodos[0].text).toBe("A");
		expect(result.updatedTodos[1].text).toBe("B updated");
		expect(result.updatedTodos[1].status).toBe("in_progress");
		expect(result.updatedTodos[2].status).toBe("completed");
		expect(result.updatedTodos[2].text).toBe("C done");
	});

	it("TC6: trims text on apply（批量路径）", () => {
		const todos: Todo[] = [{ id: 1, text: "A", status: "pending" }];
		const result = updateTodos(todos, [{ id: 1, text: "  B updated  " }]);
		expect(result.error).toBeUndefined();
		expect(result.updatedTodos[0].text).toBe("B updated");
	});

	it("TC6: should throw when any batch text is empty after trim (不再静默跳过)", () => {
		const todos: Todo[] = [{ id: 1, text: "A", status: "pending" }];
		expect(() => updateTodos(todos, [{ id: 1, text: "   " }])).toThrow(/empty or whitespace-only/);
	});

	it("should reject duplicate ids in updates[]", () => {
		const todos: Todo[] = [{ id: 1, text: "A", status: "pending" }];
		const result = updateTodos(todos, [
			{ id: 1, status: "completed" },
			{ id: 1, status: "pending" },
		]);
		expect(result.error).toBe("duplicate ids in updates");
		expect(result.updatedTodos).toEqual(todos);
	});

	it("should reject non-existent ids", () => {
		const todos: Todo[] = [{ id: 1, text: "A", status: "pending" }];
		const result = updateTodos(todos, [{ id: 999, status: "pending" }]);
		expect(result.error).toBe("id 999 not found");
	});

	it("should reject updates[] item missing both status and text", () => {
		const todos: Todo[] = [{ id: 1, text: "A", status: "pending" }];
		const result = updateTodos(todos, [{ id: 1 }]);
		expect(result.error).toContain("neither status nor text");
	});

	it("should reject invalid status values", () => {
		const todos: Todo[] = [{ id: 1, text: "A", status: "pending" }];
		const result = updateTodos(todos, [{ id: 1, status: "banana" }]);
		expect(result.error).toContain("invalid status");
	});
});

// ── handleSingleUpdate 守卫（tool 单条路径）────

describe("handleSingleUpdate guards (tool single path)", () => {
	it("TC6: text='  ' (纯空格) → throw (trim 后空串拒绝，不只判 ===)", () => {
		const state = createTodoSessionState();
		state.todos = [{ id: 1, text: "x", status: "pending" }];
		expect(() => handleSingleUpdate(state, { action: "update", id: 1, text: "   " }))
			.toThrow(/empty or whitespace-only/);
	});

	it("trims text on apply", () => {
		const state = createTodoSessionState();
		state.todos = [{ id: 1, text: "x", status: "pending" }];
		handleSingleUpdate(state, { action: "update", id: 1, text: "  hello  " });
		expect(state.todos[0].text).toBe("hello");
	});

	it("TC11: 最后一个 completed 时无 'All todos completed' 收尾文案", () => {
		const state = createTodoSessionState();
		state.todos = [{ id: 1, text: "only", status: "in_progress" }];
		const out = handleSingleUpdate(state, { action: "update", id: 1, status: "completed" });
		expect(out).not.toContain("All todos completed");
		expect(out).toContain("Updated todo #1");
	});
});

// ── handleAdd — auto-GC 重置完成周期跟踪 ────────────

describe("handleAdd auto-GC resets completion-cycle tracking", () => {
	it("全部 completed 后 add → completionSteered / allCompletedAtCount 重置，新一轮完成可再次 steer", () => {
		const state = createTodoSessionState();
		state.todos = [{ id: 1, text: "old", status: "completed" }];
		state.completionSteered = true;
		state.allCompletedAtCount = 3;

		handleAdd(state, { action: "add", texts: ["new task"] });

		expect(state.completionSteered).toBe(false);
		expect(state.allCompletedAtCount).toBeNull();
		expect(state.todos).toHaveLength(1);
		expect(state.todos[0].id).toBe(1);
		expect(state.nextId).toBe(2);
	});

	it("存在未完成项时 add → 完成周期跟踪不受影响", () => {
		const state = createTodoSessionState();
		state.todos = [{ id: 1, text: "wip", status: "in_progress" }];
		state.nextId = 2;
		state.completionSteered = false;

		handleAdd(state, { action: "add", texts: ["more"] });

		expect(state.todos).toHaveLength(2);
		expect(state.nextId).toBe(3);
	});
});

// ── completed 无拦截 ────────────────────────────────

describe("completed without interception", () => {
	it("should allow in_progress → completed directly", () => {
		const todos: Todo[] = [{ id: 1, text: "simple", status: "in_progress" }];
		const result = updateTodos(todos, [{ id: 1, status: "completed" }]);
		expect(result.error).toBeUndefined();
		expect(result.updatedTodos[0].status).toBe("completed");
	});

	it("should allow pending → completed directly", () => {
		const todos: Todo[] = [{ id: 1, text: "skip", status: "pending" }];
		const result = updateTodos(todos, [{ id: 1, status: "completed" }]);
		expect(result.error).toBeUndefined();
		expect(result.updatedTodos[0].status).toBe("completed");
	});

	it("should allow batch all completed without evidence", () => {
		const todos: Todo[] = [
			{ id: 1, text: "A", status: "in_progress" },
			{ id: 2, text: "B", status: "in_progress" },
		];
		const result = updateTodos(todos, [
			{ id: 1, status: "completed" },
			{ id: 2, status: "completed" },
		]);
		expect(result.error).toBeUndefined();
		expect(result.updatedTodos[0].status).toBe("completed");
		expect(result.updatedTodos[1].status).toBe("completed");
	});
});

// ── formatTodoLine / formatTodoList ──────────────────

describe("formatTodoLine", () => {
	it("should format pending todo", () => {
		const todo: Todo = { id: 1, text: "task A", status: "pending" };
		expect(formatTodoLine(todo)).toBe("[ ] #1: task A");
	});

	it("should format in_progress todo", () => {
		const todo: Todo = { id: 2, text: "task B", status: "in_progress" };
		expect(formatTodoLine(todo)).toBe("[~] #2: task B");
	});

	it("should format completed todo", () => {
		const todo: Todo = { id: 3, text: "task C", status: "completed" };
		expect(formatTodoLine(todo)).toBe("[x] #3: task C");
	});
});

describe("formatTodoList (TC3/TC5)", () => {
	it("TC5: formats the full list by reusing formatTodoLine, joined by newline", () => {
		const todos: Todo[] = [
			{ id: 1, text: "A", status: "pending" },
			{ id: 2, text: "B", status: "in_progress" },
			{ id: 3, text: "C", status: "completed" },
		];
		expect(formatTodoList(todos)).toBe("[ ] #1: A\n[~] #2: B\n[x] #3: C");
	});

	it("empty list → empty string", () => {
		expect(formatTodoList([])).toBe("");
	});
});

// ── widget 渲染布局 ────────────────────────────────

const mockTheme = {
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

describe("widget rendering", () => {
	it("should render empty list as empty widget", () => {
		expect(renderWidgetLines([], mockTheme, 80)).toEqual([]);
	});

	it("should use single column for 3 tasks", () => {
		const todos: Todo[] = [
			{ id: 1, text: "A", status: "pending" },
			{ id: 2, text: "B", status: "in_progress" },
			{ id: 3, text: "C", status: "completed" },
		];
		const lines = renderWidgetLines(todos, mockTheme, 80);
		expect(lines.length).toBe(4); // 1 header + 3 items
		expect(lines[0]).toContain("1/3");
		expect(lines[1]).toContain("#1");
		expect(lines[2]).toContain("#2");
		expect(lines[3]).toContain("#3");
	});

	it("should use single column up to 8 tasks", () => {
		const todos: Todo[] = Array.from({ length: 8 }, (_, i) => ({
			id: i + 1,
			text: `Task ${i + 1}`,
			status: "pending" as const,
		}));
		const lines = renderWidgetLines(todos, mockTheme, 80);
		expect(lines.length).toBe(9); // 1 header + 8 items
		for (let i = 1; i < lines.length; i++) {
			expect(lines[i]).toContain(`#${i}`);
		}
	});

	it("should switch to dual column for 9 tasks", () => {
		const todos: Todo[] = Array.from({ length: 9 }, (_, i) => ({
			id: i + 1,
			text: `Task ${i + 1}`,
			status: "pending" as const,
		}));
		const lines = renderWidgetLines(todos, mockTheme, 80);
		expect(lines.length).toBe(6); // 1 header + ceil(9/2)=5 rows
		expect(lines[0]).toContain("0/9");
	});

	it("should keep dual column within Pi widget max lines for 18 tasks", () => {
		const todos: Todo[] = Array.from({ length: 18 }, (_, i) => ({
			id: i + 1,
			text: `Task ${i + 1}`,
			status: "pending" as const,
		}));
		const lines = renderWidgetLines(todos, mockTheme, 80);
		expect(lines.length).toBe(10); // 1 header + 9 rows
	});

	it("should keep widget lines within Pi max for 19 tasks", () => {
		const todos: Todo[] = Array.from({ length: 19 }, (_, i) => ({
			id: i + 1,
			text: `Task ${i + 1}`,
			status: "pending" as const,
		}));
		const lines = renderWidgetLines(todos, mockTheme, 80);
		expect(lines.length).toBe(11); // 1 header + ceil(19/2)=10 rows; Pi truncates at 10
	});
});
