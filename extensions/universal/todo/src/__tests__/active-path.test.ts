import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { reconstructState, registerTodoEventHandlers, type RefreshDisplayFn } from "../handlers";
import { createTodoSessionState } from "../state";

/**
 * U6b：reconstructState 回放接活跃路径裁剪——从 leafId 沿 parentId 回溯得活跃路径，
 * 被撤子树的 todo 快照不得进入重建态（不得经 `<todo_context>` 注入模型上下文）。
 */

interface BranchFixtureEntry {
	id: string;
	parentId: string | null;
	todos?: { id: number; text: string; status: string }[];
	nextId?: number;
}

/** todo toolResult 快照 entry（合法 TodoDetails，避免触发脏数据降级路径） */
function todoEntry(id: string, parentId: string | null, todos: { id: number; text: string; status: string }[], nextId?: number) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-09-24T00:00:00.000Z",
		message: { role: "toolResult", toolName: "todo", details: { todos, nextId } },
	};
}

/** 撤回后真实形态：label entry 落文件尾（parentId = 回退后叶子），leafId 指向它 */
function labelEntry(id: string, parentId: string | null) {
	return { type: "label", id, parentId, timestamp: "2026-09-24T00:00:01.000Z", targetId: "u-x", label: "taiji:revoked" };
}

function makeCtx(entries: BranchFixtureEntry[], leafId: string | null): ExtensionContext {
	return {
		sessionManager: {
			getEntries: () => entries,
			getLeafId: () => leafId,
		},
	} as unknown as ExtensionContext;
}

describe("reconstructState 活跃路径裁剪（U6b）", () => {
	it("有分支 fixture：被撤子树的 todo 快照不进重建态——取活跃路径内最后一条", () => {
		// 树：e1(base) → e2(active-branch)；e1 → e3(revoked-branch，物理后写=被撤子树)；
		// 撤回落 label 锚 L（parentId = 回退后叶子 e2），leafId = L → 活跃路径 {L, e2, e1}
		const entries = [
			todoEntry("e1", null, [{ id: 1, text: "base", status: "pending" }], 2),
			todoEntry("e2", "e1", [{ id: 1, text: "active-branch", status: "in_progress" }], 2),
			todoEntry("e3", "e1", [{ id: 1, text: "revoked-branch", status: "completed" }], 2),
			labelEntry("L", "e2"),
		];

		const state = createTodoSessionState();
		reconstructState(state, makeCtx(entries, "L"));

		expect(state.todos).toHaveLength(1);
		expect(state.todos[0]?.text).toBe("active-branch");
		// 反向断言：被撤子树快照不进重建态
		expect(state.todos.map((t) => t.text)).not.toContain("revoked-branch");
		expect(state.nextId).toBe(2);
	});

	it("活跃路径内无 todo 快照（撤回点早于全部 todo 操作）→ 重建态为空，不回退到旧分支快照", () => {
		// 树：e1(普通 message entry) → e2(todo 快照，被撤子树)；撤回后 leafId 指回 e1
		const entries = [
			{ type: "message", id: "e1", parentId: null, timestamp: "t", message: { role: "user", content: "hi" } },
			todoEntry("e2", "e1", [{ id: 1, text: "only-on-revoked-branch", status: "pending" }], 2),
			labelEntry("L", "e1"),
		];

		const state = createTodoSessionState();
		reconstructState(state, makeCtx(entries, "L"));

		expect(state.todos).toHaveLength(0);
		expect(state.nextId).toBe(1);
	});

	it("无分支回归：leafId = 文件尾 → 全量回放最后一条（现行为不变）", () => {
		const entries = [
			todoEntry("e1", null, [{ id: 1, text: "first", status: "pending" }], 2),
			todoEntry("e2", "e1", [{ id: 1, text: "first", status: "completed" }, { id: 2, text: "second", status: "in_progress" }], 3),
		];

		const state = createTodoSessionState();
		reconstructState(state, makeCtx(entries, "e2"));

		expect(state.todos).toHaveLength(2);
		expect(state.todos[1]?.text).toBe("second");
		expect(state.nextId).toBe(3);
	});

	it("leafId 防御：null / 指向不存在 entry → 回退文件尾全量回放（不静默清空重建态）", () => {
		const entries = [
			todoEntry("e1", null, [{ id: 1, text: "first", status: "pending" }], 2),
			todoEntry("e2", "e1", [{ id: 1, text: "tail-snapshot", status: "pending" }], 2),
		];

		for (const leafId of [null, "missing-id"]) {
			const state = createTodoSessionState();
			reconstructState(state, makeCtx(entries, leafId));
			expect(state.todos).toHaveLength(1);
			expect(state.todos[0]?.text).toBe("tail-snapshot");
		}
	});
});

describe("session_tree handler 回归（重建态与裁剪后一致）", () => {
	it("触发 session_tree → state 重建为活跃路径态 + refreshDisplay 调用", async () => {
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>();
		const pi = {
			on: vi.fn((event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) => {
				handlers.set(event, handler);
			}),
		} as unknown as ExtensionAPI;
		const refreshDisplay = vi.fn() as unknown as RefreshDisplayFn;

		const state = createTodoSessionState();
		// 预填 stale：撤回前的旧分支态（模拟运行中撤回后缓存未失效的窗口）
		state.todos = [{ id: 1, text: "revoked-branch", status: "completed" }];
		state.nextId = 2;

		registerTodoEventHandlers(pi, state, refreshDisplay);

		const entries = [
			todoEntry("e1", null, [{ id: 1, text: "base", status: "pending" }], 2),
			todoEntry("e2", "e1", [{ id: 1, text: "active-branch", status: "in_progress" }], 2),
			todoEntry("e3", "e1", [{ id: 1, text: "revoked-branch", status: "completed" }], 2),
			labelEntry("L", "e2"),
		];
		await handlers.get("session_tree")!({ type: "session_tree" }, makeCtx(entries, "L"));

		// 与直接调 reconstructState（裁剪语义）一致：活跃路径内最后一条
		expect(state.todos).toHaveLength(1);
		expect(state.todos[0]?.text).toBe("active-branch");
		expect(refreshDisplay).toHaveBeenCalledTimes(1);
		// 纯重建体：不注入消息（session_start 块无此副作用，todo handler 本就不 steer——回归锚）
		expect(handlers.has("session_tree")).toBe(true);
	});
});
