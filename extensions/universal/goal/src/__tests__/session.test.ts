/**
 * session.ts 测试 — reconstructGoalState
 *
 * 覆盖：
 * - MF-7: reconstructGoalState 3 条 FR（G-006 append-only 不 splice / G-015 崩溃后非 active 保持原状 / G-024 throw→null）
 *
 * [REMOVED W4] isStaleContextError + STALE_CONTEXT_PATTERNS 测试随实现删除——
 * 双重废（无生产调用方 + patterns 与 pi 0.84.1 真实 stale 文案零匹配），见
 * session.ts 的 [REMOVED W4] 注释。
 *
 * 用 fake SessionPort（内存 entries 数组）。
 */
import { describe, expect, it } from "vitest";

import { createGoalState } from "../engine/goal";
import type { GoalRuntimeState, GoalStatus } from "../engine/types";
import {
	ENTRY_TYPE,
	makeHistoryEntry,
	serializeState,
} from "../persistence";
import type { SessionEntryLike, SessionPort } from "../ports";
import {
	createGoalSession,
	reconstructGoalState,
} from "../session";

// ── Fake SessionPort ─────────────────────────────────

function makeFakeSessionPort(entries: SessionEntryLike[]): SessionPort {
	return {
		// 模拟 Pi SDK filter-copy 语义：返回新数组，避免测试掩盖 splice GC 失效
		getEntries: () => entries.slice(),
	};
}

function makeGoalStateEntry(state: GoalRuntimeState): SessionEntryLike {
	return { type: "custom", customType: ENTRY_TYPE, data: serializeState(state) };
}

// ── reconstructGoalState（MF-7）──────────────────────

describe("reconstructGoalState", () => {
	it("无 goal-state entry → state=null", () => {
		const session = createGoalSession();
		const port = makeFakeSessionPort([]);
		reconstructGoalState(session, port);
		expect(session.state).toBeNull();
	});

	it("有 goal-state entry → 恢复 state", () => {
		const session = createGoalSession();
		const state = createGoalState("my objective");
		const port = makeFakeSessionPort([makeGoalStateEntry(state)]);
		reconstructGoalState(session, port);
		expect(session.state).not.toBeNull();
		expect(session.state!.objective).toBe("my objective");
	});

	it("G-006: 多个 goal-state entry → 恢复最新（append-only，不 splice）", () => {
		const session = createGoalSession();
		const oldState = createGoalState("old");
		const newState = createGoalState("new");
		const entries: SessionEntryLike[] = [
			makeGoalStateEntry(oldState),
			makeGoalStateEntry(newState), // 最新（在后面）
		];
		const port = makeFakeSessionPort(entries);
		reconstructGoalState(session, port);
		// 恢复的是最新的
		expect(session.state!.objective).toBe("new");
		// append-only：旧 entry 不被删除（splice GC 在生产不生效）
		const remaining = entries.filter((e) => e.customType === ENTRY_TYPE);
		expect(remaining).toHaveLength(2);
	});

	it.each([
		["blocked", 1000],
		["paused", 2000],
		["complete", 3000],
	])("FR-3/G-015: 非 active 状态 %s → 保持原状（status + timeStartedAt 不变）", (status, oldTime) => {
		const session = createGoalSession();
		const state = createGoalState(`${status} goal`);
		state.status = status as GoalStatus;
		state.timeStartedAt = oldTime;
		const port = makeFakeSessionPort([makeGoalStateEntry(state)]);
		reconstructGoalState(session, port);
		expect(session.state!.status).toBe(status);
		expect(session.state!.timeStartedAt).toBe(oldTime);
	});

	it("FR-3: active → 保持 active + 重启计时（timeStartedAt = now）", () => {
		const session = createGoalSession();
		const state = createGoalState("active goal");
		state.timeStartedAt = 1000; // 旧值
		const port = makeFakeSessionPort([makeGoalStateEntry(state)]);
		const before = Date.now();
		reconstructGoalState(session, port);
		const after = Date.now();
		expect(session.state!.status).toBe("active");
		expect(session.state!.timeStartedAt).toBeGreaterThanOrEqual(before);
		expect(session.state!.timeStartedAt).toBeLessThanOrEqual(after);
	});

	it("G-024: deserialize throw（损坏 data）→ state=null", () => {
		const session = createGoalSession();
		// 缺少必填字段 → deserializeState throw
		const brokenEntry: SessionEntryLike = {
			type: "custom",
			customType: ENTRY_TYPE,
			data: { goalId: "x" }, // 缺大量必填字段
		};
		const port = makeFakeSessionPort([brokenEntry]);
		reconstructGoalState(session, port);
		expect(session.state).toBeNull();
	});

	it("data=undefined 的 entry → 跳过（state=null）", () => {
		const session = createGoalSession();
		const entry: SessionEntryLike = {
			type: "custom",
			customType: ENTRY_TYPE,
			data: undefined,
		};
		const port = makeFakeSessionPort([entry]);
		reconstructGoalState(session, port);
		expect(session.state).toBeNull();
	});

	it("makeHistoryEntry + serializeState 往返一致性", () => {
		// 验证辅助函数本身正确（makeHistoryEntry 用于 history entry 构造）
		const state = createGoalState("roundtrip");
		state.status = "complete";
		const before = Date.now();
		const hist = makeHistoryEntry(state);
		const after = Date.now();
		expect(hist.goalId).toBe(state.goalId);
		expect(hist.objective).toBe("roundtrip");
		expect(hist.status).toBe("complete");
		expect(hist.elapsedSeconds).toBe(Math.floor(state.timeUsedSeconds)); // = Math.floor(0) = 0
		expect(hist.timestamp).toBeGreaterThanOrEqual(before);
		expect(hist.timestamp).toBeLessThanOrEqual(after);
		// serializeState 返回深拷贝（修改返回值不影响原 state）
		const serialized = serializeState(state);
		expect(serialized.objective).toBe("roundtrip");
		serialized.status = "cancelled";
		expect(state.status).toBe("complete"); // 原状态未被修改
	});
});
