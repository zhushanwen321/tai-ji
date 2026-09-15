/**
 * goal_control schema — successCriteria 结构化约束测试
 *
 * W1：successCriteria 从 string 变为 string[]（1~8 条、每条单行短条件）。
 * schema 层验证：接受 string[]、拒绝空数组/超限/含换行项。
 */
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";

import { GoalControlParams } from "../adapters/goal-control-adapter";

describe("goal_control schema — successCriteria string[]", () => {
	it("valid: successCriteria 为 string[] → 通过", () => {
		expect(
			Value.Check(GoalControlParams, {
				action: "create",
				objective: "x",
				successCriteria: ["criterion 1", "criterion 2"],
			}),
		).toBe(true);
	});

	it("valid: successCriteria 单项 → 通过", () => {
		expect(
			Value.Check(GoalControlParams, {
				action: "create",
				objective: "x",
				successCriteria: ["single criterion"],
			}),
		).toBe(true);
	});

	it("valid: successCriteria 8 项（上限）→ 通过", () => {
		const criteria = Array.from({ length: 8 }, (_, i) => `criterion ${i + 1}`);
		expect(
			Value.Check(GoalControlParams, {
				action: "create",
				objective: "x",
				successCriteria: criteria,
			}),
		).toBe(true);
	});

	it("invalid: successCriteria 空数组 → 拒绝", () => {
		expect(
			Value.Check(GoalControlParams, {
				action: "create",
				objective: "x",
				successCriteria: [],
			}),
		).toBe(false);
	});

	it("invalid: successCriteria 超过 8 项 → 拒绝", () => {
		const criteria = Array.from({ length: 9 }, (_, i) => `criterion ${i + 1}`);
		expect(
			Value.Check(GoalControlParams, {
				action: "create",
				objective: "x",
				successCriteria: criteria,
			}),
		).toBe(false);
	});

	it("invalid: successCriteria 项含换行符 → 拒绝", () => {
		expect(
			Value.Check(GoalControlParams, {
				action: "create",
				objective: "x",
				successCriteria: ["line1\nline2"],
			}),
		).toBe(false);
	});

	it("invalid: successCriteria 项含孤立 \\r（CR）→ 拒绝（pattern ^[^\\r\\n]+$ 拦截）", () => {
		expect(
			Value.Check(GoalControlParams, {
				action: "create",
				objective: "x",
				successCriteria: ["a\rb"],
			}),
		).toBe(false);
	});

	it("invalid: successCriteria 为空 string（旧格式）→ 拒绝", () => {
		expect(
			Value.Check(GoalControlParams, {
				action: "create",
				objective: "x",
				successCriteria: "single string",
			}),
		).toBe(false);
	});

	it("invalid: successCriteria 项为空 string → 拒绝（schema minLength:1）", () => {
		// schema minLength:1 拒绝空字符串项
		expect(
			Value.Check(GoalControlParams, {
				action: "create",
				objective: "x",
				successCriteria: [""],
			}),
		).toBe(false);
	});
});
