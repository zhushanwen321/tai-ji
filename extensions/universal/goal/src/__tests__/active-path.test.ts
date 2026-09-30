/**
 * U6c：reconstructGoalState 重建接活跃路径裁剪 + session_tree handler 即时重建。
 *
 * 从 leafId 沿 parentId 回溯得活跃路径，被撤子树的 goal-state entry 不进重建态
 * （不得经 before_agent_start 逐轮注入模型上下文——A14）。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { createGoalState } from "../engine/goal";
import { ENTRY_TYPE, serializeState } from "../persistence";
import type { SessionEntryLike } from "../ports";
import goalExtension from "../index";
import {
	createGoalSession,
	reconstructGoalState,
	type ActivePathSessionView,
} from "../session";

// ── fixture ─────────────────────────────────────────

interface BranchEntry {
	id: string;
	parentId: string | null;
	type: string;
	customType?: string;
	data?: unknown;
}

/** goal-state 快照 entry（append-only 全量快照，reconstruct 只读活跃路径内最新一条） */
function goalStateEntry(id: string, parentId: string | null, objective: string): BranchEntry {
	return {
		type: "custom",
		id,
		parentId,
		customType: ENTRY_TYPE,
		data: serializeState(createGoalState(objective)),
	};
}

/** 撤回后真实形态：label entry 落文件尾（parentId = 回退后叶子），leafId 指向它 */
function labelEntry(id: string, parentId: string | null): BranchEntry {
	return { type: "label", id, parentId, targetId: "u-x", label: "taiji:revoked" };
}

function makeView(entries: SessionEntryLike[], leafId: string | null): ActivePathSessionView {
	return {
		// 模拟 Pi SDK filter-copy 语义：返回新数组
		getEntries: () => entries.slice(),
		getLeafId: () => leafId,
	};
}

// ── reconstructGoalState 活跃路径裁剪（U6c）──────────

describe("reconstructGoalState 活跃路径裁剪（U6c）", () => {
	it("有分支 fixture：被撤子树的 goal-state 不进重建态——取活跃路径内最新一条", () => {
		// 树：e1(goal base) → e2(goal active-branch)；e1 → e3(goal revoked-branch，
		// 物理后写 = 被撤子树)；撤回落 label 锚 L（parentId = 回退后叶子 e2），
		// leafId = L → 活跃路径 {L, e2, e1}
		const entries = [
			goalStateEntry("e1", null, "base"),
			goalStateEntry("e2", "e1", "active-branch"),
			goalStateEntry("e3", "e1", "revoked-branch"),
			labelEntry("L", "e2"),
		];

		const session = createGoalSession();
		reconstructGoalState(session, makeView(entries, "L"));

		expect(session.state).not.toBeNull();
		expect(session.state!.objective).toBe("active-branch");
		// 反向断言：被撤子树快照不进重建态（物理位置在 e2 之后，无裁剪时会命中）
		expect(session.state!.objective).not.toBe("revoked-branch");
	});

	it("活跃路径内无 goal-state（撤回点早于 goal 创建）→ state=null，不回退到旧分支快照", () => {
		const entries: BranchEntry[] = [
			{ type: "custom", id: "e1", parentId: null, customType: "other-ext", data: {} },
			goalStateEntry("e2", "e1", "only-on-revoked-branch"),
			labelEntry("L", "e1"),
		];

		const session = createGoalSession();
		reconstructGoalState(session, makeView(entries, "L"));

		expect(session.state).toBeNull();
	});

	it("无分支回归：leafId = 文件尾 → 恢复最新一条（现行为不变）", () => {
		const entries = [goalStateEntry("e1", null, "old"), goalStateEntry("e2", "e1", "new")];

		const session = createGoalSession();
		reconstructGoalState(session, makeView(entries, "e2"));

		expect(session.state!.objective).toBe("new");
	});

	it("legacy fixture 回归：entry 无 id/parentId（duck-typed 最小形状）→ 线性全量，行为与裁剪前一致", () => {
		const entries: SessionEntryLike[] = [
			{ type: "custom", customType: ENTRY_TYPE, data: serializeState(createGoalState("legacy-old")) },
			{ type: "custom", customType: ENTRY_TYPE, data: serializeState(createGoalState("legacy-new")) },
		];

		const session = createGoalSession();
		reconstructGoalState(session, { getEntries: () => entries.slice() });

		expect(session.state!.objective).toBe("legacy-new");
	});

	it("leafId 防御：null / 指向不存在 entry → 回退文件尾（不静默清空重建态）", () => {
		const entries = [goalStateEntry("e1", null, "first"), goalStateEntry("e2", "e1", "tail-snapshot")];

		for (const leafId of [null, "missing-id"]) {
			const session = createGoalSession();
			reconstructGoalState(session, makeView(entries, leafId));
			expect(session.state!.objective).toBe("tail-snapshot");
		}
	});
});

// ── session_tree handler（U6c：即时重建，纯重建体）──

interface HandlerFixture {
	handlers: Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>;
	sendMessage: ReturnType<typeof vi.fn>;
	appendEntry: ReturnType<typeof vi.fn>;
}

/** 实例化 goal 工厂并捕获事件 handler（最小 pi：注册面 vi.fn + 副作用面 vi.fn） */
function makeHandlerFixture(): HandlerFixture {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>();
	const pi = {
		registerCommand: vi.fn(),
		registerTool: vi.fn(),
		on: vi.fn((event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) => {
			// 真实 pi 的 on 是 handler 列表追加；此处每事件单 handler（goal 工厂每事件只注册一次）
			handlers.set(event, handler);
		}),
		registerMessageRenderer: vi.fn(),
		sendMessage: vi.fn(),
		appendEntry: vi.fn(),
	} as unknown as ExtensionAPI;
	goalExtension(pi);
	return { handlers, sendMessage: pi.sendMessage, appendEntry: pi.appendEntry };
}

/** 最小 ctx：sessionManager（分支树）+ ui 记录面 + getContextUsage（before_agent_start 用） */
function makeCtx(entries: SessionEntryLike[], leafId: string | null) {
	const setWidget = vi.fn();
	const setStatus = vi.fn();
	const ctx = {
		hasUI: true,
		getContextUsage: () => null,
		ui: {
			notify: vi.fn(),
			setStatus,
			setWidget,
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
		sessionManager: {
			getEntries: () => entries.slice(),
			getLeafId: () => leafId,
		},
	} as unknown as ExtensionContext;
	return { ctx, setWidget, setStatus };
}

describe("session_tree handler 即时重建（U6c）", () => {
	it("触发 session_tree → 内存态重建为活跃路径态 + widget 刷新；handler 本身零注入零落盘", async () => {
		const { handlers, sendMessage, appendEntry } = makeHandlerFixture();
		const entries = [
			goalStateEntry("e1", null, "base"),
			goalStateEntry("e2", "e1", "active-branch"),
			goalStateEntry("e3", "e1", "revoked-branch"),
			labelEntry("L", "e2"),
		];
		const { ctx, setWidget } = makeCtx(entries, "L");

		expect(handlers.has("session_tree")).toBe(true);
		await handlers.get("session_tree")!({ type: "session_tree" }, ctx);

		// 纯重建断言：handler 不注入消息（撤回编排自己不得发消息）、不落盘（不污染新分支文件尾）
		expect(sendMessage).not.toHaveBeenCalled();
		expect(appendEntry).not.toHaveBeenCalled();
		// widget 反映活跃路径态（mock ctx 无 mode → setWidgetDual 走 TUI 臂，直接推 text 行）
		const lines = setWidget.mock.calls.find(([name]) => name === "goal")?.[1] as string[] | undefined;
		expect(lines?.join(" ")).toContain("active-branch");
		expect(lines?.join(" ")).not.toContain("revoked-branch");
	});

	it("撤回点早于 goal 创建 → 重建态 null，widget 清除（live 态无残影，A14）", async () => {
		const { handlers } = makeHandlerFixture();
		const entries: BranchEntry[] = [
			{ type: "custom", id: "e1", parentId: null, customType: "other-ext", data: {} },
			goalStateEntry("e2", "e1", "only-on-revoked-branch"),
			labelEntry("L", "e1"),
		];
		const { ctx, setWidget } = makeCtx(entries, "L");

		await handlers.get("session_tree")!({ type: "session_tree" }, ctx);

		expect(setWidget).toHaveBeenCalledWith("goal", undefined);
	});

	it("session_tree 重建后的内存态驱动 before_agent_start：下一轮注入不含被撤 goal", async () => {
		const { handlers, appendEntry } = makeHandlerFixture();
		const entries = [
			goalStateEntry("e1", null, "active-branch"),
			goalStateEntry("e2", "e1", "revoked-branch"),
			labelEntry("L", "e1"),
		];
		const { ctx } = makeCtx(entries, "L");

		await handlers.get("session_tree")!({ type: "session_tree" }, ctx);
		// before_agent_start 读内存态不重算（现状契约）——新鲜度由 session_tree 重建保证
		const result = (await handlers.get("before_agent_start")!({}, ctx)) as
			| { message: { content: string } }
			| undefined;

		expect(result?.message?.content).toContain("active-branch");
		expect(result?.message?.content).not.toContain("revoked-branch");
		// before_agent_start 自身的 goal:log 落盘是该事件既有行为，不算 session_tree 副作用
		expect(appendEntry).toHaveBeenCalled();
	});
});
