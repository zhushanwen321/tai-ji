import { describe, expect, it } from "vitest";

import {
	buildBeforeAgentStartMessage,
	handleAutoClear,
	handleCompletionSteer,
	reconstructState,
} from "../handlers";
import type { Todo } from "../model";
import { createTodoSessionState, type TodoSessionState } from "../state";

// ── helpers ─────────────────────────────────────────

function makeState(todos: Todo[], overrides: Partial<TodoSessionState> = {}): TodoSessionState {
	const s = createTodoSessionState();
	s.todos = todos;
	Object.assign(s, overrides);
	return s;
}

function todoEntry(todos: Todo[], nextId: number) {
	return {
		type: "message",
		message: { role: "toolResult", toolName: "todo", details: { todos, nextId } },
	};
}

function makeCtx(entries: unknown[]) {
	return {
		sessionManager: { getEntries: () => entries },
	} as unknown as Parameters<typeof reconstructState>[1];
}

// ── completion steer ────────────────────────────────

describe("handleCompletionSteer", () => {
	it("sets one-shot steer when all completed", () => {
		const s = makeState([{ id: 1, text: "a", status: "completed" }]);
		expect(handleCompletionSteer(s)).toBe(true);
		expect(s.completionSteered).toBe(true);
		expect(s.pendingSteerMessage).toContain("交付质量");
		expect(s.pendingSteerMessage).toContain("检查实际产出");
		expect(s.pendingSteerMessage).toContain("不要凭印象");
	});

	it("does not steer twice (single-shot lock)", () => {
		const s = makeState([{ id: 1, text: "a", status: "completed" }], { completionSteered: true });
		expect(handleCompletionSteer(s)).toBe(false);
		expect(s.pendingSteerMessage).toBeNull();
	});

	it("does not steer when not all completed", () => {
		const s = makeState([
			{ id: 1, text: "a", status: "completed" },
			{ id: 2, text: "b", status: "pending" },
		]);
		expect(handleCompletionSteer(s)).toBe(false);
		expect(s.completionSteered).toBe(false);
	});

	it("does not steer on empty list", () => {
		expect(handleCompletionSteer(makeState([]))).toBe(false);
	});
});

// ── auto-clear ──────────────────────────────────────

describe("handleAutoClear", () => {
	it("does not handle when not all completed, and resets anchor", () => {
		const s = makeState([{ id: 1, text: "a", status: "pending" }], { allCompletedAtCount: 3 });
		expect(handleAutoClear(s)).toBe(false);
		expect(s.allCompletedAtCount).toBeNull();
	});

	it("anchors on first all-completed round without clearing", () => {
		const s = makeState([{ id: 1, text: "a", status: "completed" }], { userMessageCount: 5 });
		expect(handleAutoClear(s)).toBe(false);
		expect(s.allCompletedAtCount).toBe(5);
		expect(s.todos).toHaveLength(1);
	});

	it("does not clear before AUTO_CLEAR_DELAY_ROUNDS (2) elapse", () => {
		const s = makeState([{ id: 1, text: "a", status: "completed" }], {
			userMessageCount: 5, allCompletedAtCount: 4,
		});
		expect(handleAutoClear(s)).toBe(false);
	});

	it("clears and resets flags after delay elapses", () => {
		const s = makeState([{ id: 1, text: "a", status: "completed" }], {
			userMessageCount: 6, allCompletedAtCount: 4, completionSteered: true,
		});
		expect(handleAutoClear(s)).toBe(true);
		expect(s.todos).toEqual([]);
		expect(s.nextId).toBe(1);
		expect(s.allCompletedAtCount).toBeNull();
		expect(s.completionSteered).toBe(false);
	});
});

// ── before_agent_start context injection ────────────

describe("buildBeforeAgentStartMessage", () => {
	it("injects hidden context for pending tasks only", () => {
		const s = makeState([
			{ id: 1, text: "a", status: "pending" },
			{ id: 2, text: "b", status: "completed" },
		]);
		const m = buildBeforeAgentStartMessage(s);
		expect(m).toBeDefined();
		expect(m!.message.display).toBe(false);
		expect(m!.message.customType).toBe("todo-context");
		expect(m!.message.content).toContain("#1: a");
		expect(m!.message.content).not.toContain("#2");
	});

	it("injects action directives (process first / mark completed / stalled != done)", () => {
		const s = makeState([{ id: 1, text: "a", status: "in_progress" }]);
		const m = buildBeforeAgentStartMessage(s);
		expect(m!.message.content).toContain("开始工作前先推进 pending 任务");
		expect(m!.message.content).toContain("todo update 标记 completed");
		expect(m!.message.content).toContain("搁置不等于完成");
	});

	it("includes in_progress todos as pending", () => {
		const s = makeState([
			{ id: 1, text: "working", status: "in_progress" },
			{ id: 2, text: "next", status: "pending" },
		]);
		expect(buildBeforeAgentStartMessage(s)!.message.content).toContain("#1: working");
	});

	it("returns undefined when list empty", () => {
		expect(buildBeforeAgentStartMessage(makeState([]))).toBeUndefined();
	});

	it("returns undefined when all completed", () => {
		const s = makeState([{ id: 1, text: "a", status: "completed" }]);
		expect(buildBeforeAgentStartMessage(s)).toBeUndefined();
	});
});

// ── reconstructState ────────────────────────────────

describe("reconstructState", () => {
	it("leaves state empty when no todo entry", () => {
		const entries = [{ type: "message", message: { role: "user", content: "hi" } }];
		const s = createTodoSessionState();
		reconstructState(s, makeCtx(entries));
		expect(s.todos).toEqual([]);
		expect(s.nextId).toBe(1);
	});

	it("replays the latest todo entry snapshot", () => {
		const entries = [todoEntry([{ id: 1, text: "a", status: "pending" }], 2)];
		const s = createTodoSessionState();
		reconstructState(s, makeCtx(entries));
		expect(s.todos).toHaveLength(1);
		expect(s.todos[0].text).toBe("a");
		expect(s.nextId).toBe(2);
	});

	it("uses the last todo entry (不再 splice GC 旧条目)", () => {
		const entries = [
			todoEntry([{ id: 1, text: "old", status: "pending" }], 2),
			todoEntry([{ id: 5, text: "new", status: "completed" }], 6),
		];
		const s = createTodoSessionState();
		reconstructState(s, makeCtx(entries));
		expect(s.todos[0].id).toBe(5);
		expect(s.nextId).toBe(6);
	});

	it("TC10: 不修改传入的 entries（纯读，不再 splice）", () => {
		const entries = [
			todoEntry([{ id: 1, text: "old", status: "pending" }], 2),
			todoEntry([{ id: 5, text: "new", status: "completed" }], 6),
		];
		const ctx = makeCtx(entries);
		const seen = ctx.sessionManager.getEntries();
		const lenBefore = seen.length;
		const s = createTodoSessionState();
		reconstructState(s, ctx);
		expect(seen).toHaveLength(lenBefore); // reconstructState 未 splice 任何条目
	});

	it("migrates legacy status on replay", () => {
		const legacy = [{ id: 1, text: "a", status: "failed" }] as unknown as Todo[];
		const entries = [todoEntry(legacy, 2)];
		const s = createTodoSessionState();
		reconstructState(s, makeCtx(entries));
		expect(s.todos[0].status).toBe("pending");
	});

	it("migrates legacy cancelled → completed on replay (TC1)", () => {
		const legacy = [{ id: 1, text: "a", status: "cancelled" }] as unknown as Todo[];
		const entries = [todoEntry(legacy, 2)];
		const s = createTodoSessionState();
		reconstructState(s, makeCtx(entries));
		expect(s.todos[0].status).toBe("completed");
	});

	it("skips dirty (null/primitive) elements without throwing", () => {
		const entries = [
			todoEntry([null, { id: 1, text: "ok", status: "pending" }] as unknown as Todo[], 3),
		];
		const s = createTodoSessionState();
		expect(() => reconstructState(s, makeCtx(entries))).not.toThrow();
		expect(s.todos).toHaveLength(1);
		expect(s.todos[0].id).toBe(1);
		expect(s.nextId).toBe(3);
	});

	it("ignores snapshot when all elements are dirty (replay continues)", () => {
		const entries = [
			todoEntry([null, "garbage"] as unknown as Todo[], 5),
			todoEntry([{ id: 9, text: "valid", status: "pending" }], 10),
		];
		const s = createTodoSessionState();
		expect(() => reconstructState(s, makeCtx(entries))).not.toThrow();
		expect(s.todos).toHaveLength(1);
		expect(s.todos[0].id).toBe(9);
		expect(s.nextId).toBe(10);
	});
});

// ── agent_end integration (短路顺序) ────────────────

describe("agent_end short-circuit order", () => {
	it("completion steer fires before auto-clear (completion does not short-circuit)", () => {
		const s = makeState([{ id: 1, text: "a", status: "completed" }], { userMessageCount: 5 });
		// 模拟 agent_end: handleCompletionSteer(不短路) → handleAutoClear
		expect(handleCompletionSteer(s)).toBe(true);
		expect(s.pendingSteerMessage).toContain("交付质量");
		expect(handleAutoClear(s)).toBe(false);
		expect(s.allCompletedAtCount).toBe(5);
	});

	it("after delay, auto-clear clears but the one-shot steer stays queued", () => {
		// 竞态点：completion steer 早已置位，auto-clear 现在清空 todos
		const s = makeState([{ id: 1, text: "a", status: "completed" }], {
			userMessageCount: 7, allCompletedAtCount: 5,
			completionSteered: true, pendingSteerMessage: "<queued>",
		});
		expect(handleCompletionSteer(s)).toBe(false); // 已 steered，不重复
		expect(handleAutoClear(s)).toBe(true);
		expect(s.todos).toEqual([]);
		// pendingSteerMessage 仍保留，由下一 turn before_agent_start 消费（此时 todos 已空）
		expect(s.pendingSteerMessage).toBe("<queued>");
	});
});
