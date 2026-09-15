/**
 * agent-end stale-check 辅助函数测试（TC-3）
 *
 * 直接测试 makeStaleChecker 的快照语义，
 * 非间接覆盖。重点：makeStaleChecker 在 state=null 时 snapshot=undefined，
 * 后续任何新 goal 均视为 stale。
 */
import { describe, expect, it } from "vitest";

import { makeStaleChecker } from "../adapters/event-handlers/agent-end";
import { createGoalState } from "../engine/goal";
import type { GoalRuntimeState } from "../engine/types";
import { createGoalSession } from "../session";

describe("makeStaleChecker", () => {
	it("snapshot 时 state=null → 后续新 goal 视为 stale", () => {
		const session = createGoalSession();
		// state 为 null 时 snapshot goalId = undefined
		const checkStale = makeStaleChecker(session);
		// 后续出现新 goal（goalId 有值）
		session.state = createGoalState("new goal");
		expect(checkStale()).toBe(true); // undefined !== "goal-xxx" → stale
	});

	it("snapshot 时有 goal → 同 goalId 返回 false（未 stale）", () => {
		const session = createGoalSession();
		session.state = createGoalState("current");
		const snapshotId = session.state.goalId;
		const checkStale = makeStaleChecker(session);
		// 后续 mutate 但 goalId 不变
		session.state.currentTurnIndex = 99;
		expect(checkStale()).toBe(false);
		expect(session.state.goalId).toBe(snapshotId); // 确认 goalId 未变
	});

	it.each<[string, () => GoalRuntimeState | null]>([
		["goalId 变更（被新 goal 覆盖）", () => createGoalState("new goal overwrote")],
		["state 清空（clearGoalSession）", () => null],
	])("snapshot 后 state 变化（%s）→ 视为 stale", (_label, nextState) => {
		const session = createGoalSession();
		session.state = createGoalState("snapshot goal");
		const checkStale = makeStaleChecker(session);
		expect(checkStale()).toBe(false);
		session.state = nextState();
		expect(checkStale()).toBe(true);
	});
});
