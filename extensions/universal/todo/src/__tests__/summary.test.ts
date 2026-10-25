/**
 * buildTodoSummary（收起态一行摘要）纯函数单测。
 *
 * details.summary 约定见 docs/extensions/extension-conventions.md「Tool result details.summary
 * 约定」：execute 恒写入，TUI renderResult 折叠分支与 taiji GUI ToolRow 读链消费同源文本。
 * 运行：cd extensions/universal/todo && npx vitest run src/__tests__/summary.test.ts
 */
import { describe, expect, it } from "vitest";

import { buildTodoSummary, type Todo } from "../model";

const todos: Todo[] = [
	{ id: 1, text: "Write docs", status: "completed" },
	{ id: 2, text: "Ship it", status: "in_progress" },
	{ id: 3, text: "Review", status: "pending" },
	{ id: 4, text: "Deploy", status: "pending" },
];

describe("buildTodoSummary — list", () => {
	it("非空列表 → 数量 + 三态计数", () => {
		expect(buildTodoSummary({ action: "list" }, todos)).toBe(
			"4 todos: 1 completed, 1 in_progress, 2 pending",
		);
	});

	it("空列表 → No todos", () => {
		expect(buildTodoSummary({ action: "list" }, [])).toBe("No todos");
	});
});

describe("buildTodoSummary — add", () => {
	it("多条 → Added N todos (#first-#last)（突变后列表尾插区间）", () => {
		const added = [
			...todos,
			{ id: 5, text: "a", status: "pending" },
			{ id: 6, text: "b", status: "pending" },
			{ id: 7, text: "c", status: "pending" },
			{ id: 8, text: "d", status: "pending" },
		];
		expect(buildTodoSummary({ action: "add", texts: ["a", "b", "c", "d"] }, added)).toBe(
			"Added 4 todos (#5-#8)",
		);
	});

	it("单条 → 单数名词 + 单 id（无 -#last 后缀）", () => {
		const added = [...todos, { id: 5, text: "a", status: "pending" }];
		expect(buildTodoSummary({ action: "add", texts: ["a"] }, added)).toBe("Added 1 todo (#5)");
	});

	it("texts 缺失（不可达防御）→ 空串（不虚构数量）", () => {
		expect(buildTodoSummary({ action: "add" }, todos)).toBe("");
	});
});

describe("buildTodoSummary — update", () => {
	it("单条 status → Updated #id → status", () => {
		expect(buildTodoSummary({ action: "update", id: 1, status: "completed" }, todos)).toBe(
			"Updated #1 → completed",
		);
	});

	it("单条纯 text → 截断后的新文本（40 字上限 + 省略号）", () => {
		expect(
			buildTodoSummary({ action: "update", id: 2, text: "  rewrite the docs  " }, todos),
		).toBe('Updated #2 → "rewrite the docs"');
		const long = "x".repeat(45);
		expect(buildTodoSummary({ action: "update", id: 2, text: long }, todos)).toBe(
			`Updated #2 → "${"x".repeat(40)}…"`,
		);
	});

	it("批量 → 分号连接各条", () => {
		expect(
			buildTodoSummary(
				{
					action: "update",
					updates: [
						{ id: 1, status: "completed" },
						{ id: 2, status: "pending" },
					],
				},
				todos,
			),
		).toBe("Updated #1 → completed; #2 → pending");
	});

	it("text 含换行 → 摘要归一单行（S-1）", () => {
		expect(buildTodoSummary({ action: "update", id: 2, text: "第一行\n第二段\n\n尾行" }, todos)).toBe(
			'Updated #2 → "第一行 第二段 尾行"',
		);
	});
});

describe("buildTodoSummary — delete", () => {
	it("单 id → Deleted #id", () => {
		expect(buildTodoSummary({ action: "delete", ids: [3] }, todos)).toBe("Deleted #3");
	});

	it("多 id → 逗号连接", () => {
		expect(buildTodoSummary({ action: "delete", ids: [3, 5] }, todos)).toBe("Deleted #3, #5");
	});

	it("重复 id → 去重后列出（S-2）", () => {
		expect(buildTodoSummary({ action: "delete", ids: [3, 5, 3] }, todos)).toBe("Deleted #3, #5");
	});

	it("重复 id 去重后只剩一个 → 单 id 形态（S-2）", () => {
		expect(buildTodoSummary({ action: "delete", ids: [3, 3] }, todos)).toBe("Deleted #3");
	});

	it("ids 缺失（不可达防御）→ 空串", () => {
		expect(buildTodoSummary({ action: "delete" }, todos)).toBe("");
	});
});

describe("buildTodoSummary — 未知 action", () => {
	it("→ 空串（不虚构摘要）", () => {
		expect(buildTodoSummary({ action: "archive" } as never, todos)).toBe("");
	});
});
