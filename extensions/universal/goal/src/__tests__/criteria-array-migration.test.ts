/**
 * successCriteria 结构化迁移测试 — string → string[]
 *
 * W1：successCriteria 从单条自由文本 string 结构化为条件数组 string[]
 *（1~8 条、每条单行短条件）。旧持久化数据兼容迁移：按行拆分（/\r\n|\r|\n/）、
 * 逐条 trim、去空行，空态归一 undefined，脏数据防御性丢弃（plan 决策①②③⑤）。
 */
import { describe, expect, it } from "vitest";

import { deserializeState, makeHistoryEntry, serializeState } from "../persistence";
import { createGoalState } from "../engine/goal";
import type { GoalRuntimeState } from "../engine/types";

// ── 旧数据 fixture 工厂 ───────────────────────────────

/** 构造含指定 successCriteria 的旧持久化数据（其余必填字段齐全）。 */
function makeLegacyData(successCriteria: unknown): Record<string, unknown> {
	return {
		goalId: "g1",
		objective: "test",
		status: "active",
		successCriteria,
		tokensUsed: 0,
		timeStartedAt: 1000,
		timeUsedSeconds: 0,
		budget: {},
		budgetLimitSteeringSent: false,
		lastBlockerReason: null,
		tokenWarning70Sent: false,
		tokenWarning90Sent: false,
		lastTurnTokensUsed: 0,
		currentTurnIndex: 0,
	};
}

// ── 类型断言辅助 ─────────────────────────────────────

describe("GoalRuntimeState.successCriteria — string[] 类型", () => {
	it("createGoalState 返回 string[] 类型的 successCriteria", () => {
		const state = createGoalState("obj", undefined, undefined, ["criterion 1", "criterion 2"]);
		expect(Array.isArray(state.successCriteria)).toBe(true);
		expect(state.successCriteria).toEqual(["criterion 1", "criterion 2"]);
	});

	it("createGoalState 无 successCriteria → undefined", () => {
		const state = createGoalState("obj");
		expect(state.successCriteria).toBeUndefined();
	});
});

// ── 持久化 round-trip（新格式 string[]）───────────────

describe("serializeState / deserializeState — string[] round-trip", () => {
	it("successCriteria string[] 正确 round-trip", () => {
		const state = createGoalState("obj", undefined, "slug", ["a", "b", "c"]);
		const serialized = serializeState(state);
		const deserialized = deserializeState(serialized as unknown as Record<string, unknown>);
		expect(deserialized.successCriteria).toEqual(["a", "b", "c"]);
	});

	it("successCriteria undefined 正确 round-trip", () => {
		const state = createGoalState("obj");
		const serialized = serializeState(state);
		const deserialized = deserializeState(serialized as unknown as Record<string, unknown>);
		expect(deserialized.successCriteria).toBeUndefined();
	});

	it("makeHistoryEntry 数组 round-trip 深相等（U15b：history 数据数组形态不丢）", () => {
		const state = createGoalState("obj", undefined, "slug", ["a", "b"]);
		const entry = makeHistoryEntry(state);
		// history entry 经 JSON 序列化（appendHistory 落盘）→ 反序列化后仍为同形态数组
		const restored = JSON.parse(JSON.stringify(entry)) as { successCriteria?: string[] };
		expect(restored.successCriteria).toEqual(["a", "b"]);
	});
});

// ── 旧持久化数据迁移（string → string[]，按行拆分）────

describe("deserializeState — 旧数据迁移 string → string[]（按行拆分）", () => {
	it("U10: 单行 string → 单元素数组", () => {
		const state = deserializeState(makeLegacyData("tests pass"));
		expect(state.successCriteria).toEqual(["tests pass"]);
	});

	it("U11: 多行 string（含空白与空行）→ 逐条 trim、去空行", () => {
		const state = deserializeState(makeLegacyData("a\n b \n\nc"));
		expect(state.successCriteria).toEqual(["a", "b", "c"]);
	});

	it("U11b: CRLF 与混合换行均正确拆分（无 \\r 残留）", () => {
		expect(deserializeState(makeLegacyData("cond-1\r\ncond-2\r\ncond-3")).successCriteria).toEqual([
			"cond-1",
			"cond-2",
			"cond-3",
		]);
		expect(deserializeState(makeLegacyData("a\nb\r\nc\rd")).successCriteria).toEqual(["a", "b", "c", "d"]);
	});

	it("U11c: 纯分隔符（\\r\\n / \\r / \\n）→ undefined（空态归一）", () => {
		expect(deserializeState(makeLegacyData("\r\n")).successCriteria).toBeUndefined();
		expect(deserializeState(makeLegacyData("\r")).successCriteria).toBeUndefined();
		expect(deserializeState(makeLegacyData("\n")).successCriteria).toBeUndefined();
	});

	it("U12: 新格式 string[] → 原样保留（不二次拆分、不 trim）", () => {
		const state = deserializeState(makeLegacyData(["item a", "item b"]));
		expect(state.successCriteria).toEqual(["item a", "item b"]);
	});

	it("U12: 缺 successCriteria 字段 → undefined", () => {
		const data = makeLegacyData(undefined);
		delete data.successCriteria;
		expect(deserializeState(data).successCriteria).toBeUndefined();
	});

	it("U13: 旧 string 拆分后 10 条 → 全部保留不截断（迁移不丢数据）", () => {
		const tenLines = Array.from({ length: 10 }, (_, i) => `cond ${i + 1}`).join("\n");
		const state = deserializeState(makeLegacyData(tenLines));
		expect(state.successCriteria).toHaveLength(10);
		expect(state.successCriteria).toEqual(Array.from({ length: 10 }, (_, i) => `cond ${i + 1}`));
	});

	it("U14: 全空白 string（含空串）→ undefined（空态归一）", () => {
		expect(deserializeState(makeLegacyData(" \n ")).successCriteria).toBeUndefined();
		expect(deserializeState(makeLegacyData("   ")).successCriteria).toBeUndefined();
		expect(deserializeState(makeLegacyData("")).successCriteria).toBeUndefined();
	});

	it("U14b: 脏数据类型 → 防御性丢弃为 undefined（不 throw）", () => {
		for (const dirty of [42, null, true, ["a", ["b", "c"]], ["a", null]]) {
			const state = deserializeState(makeLegacyData(dirty));
			expect(state.successCriteria).toBeUndefined();
		}
	});
});

// ── makeHistoryEntry 类型链 ──────────────────────────

describe("makeHistoryEntry — 数组形态透传", () => {
	it("state.successCriteria 数组透传到 entry（类型链不变形）", () => {
		const state = createGoalState("obj", undefined, "slug", ["x", "y"]) as GoalRuntimeState;
		expect(makeHistoryEntry(state).successCriteria).toEqual(["x", "y"]);
	});
});
