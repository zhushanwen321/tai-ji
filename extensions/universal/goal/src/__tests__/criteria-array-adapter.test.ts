/**
 * goal_control adapter — successCriteria string[] handler 测试
 *
 * W1：handleCreate 接收 string[] 类型的 successCriteria，验证：
 * - 数组存入 state
 * - 空数组/空串项 → throw
 * - 完整字段后 state.successCriteria 为 string[]
 */
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";

import { GoalControlParams, handleCreate, type GoalControlParamsT } from "../adapters/goal-control-adapter";
import type { GoalRuntimeState } from "../engine/types";
import type { UiPort } from "../ports";
import type { ServicePorts } from "../service";
import { createGoalSession } from "../session";

function makeFakePorts(): ServicePorts & {
	states: GoalRuntimeState[];
	history: unknown[];
	notifications: Array<{ text: string; level: string }>;
} {
	const states: GoalRuntimeState[] = [];
	const history: unknown[] = [];
	const notifications: Array<{ text: string; level: string }> = [];
	return {
		states,
		history,
		notifications,
		persistence: {
			appendState: (s) => { states.push(s); },
			appendHistory: (e) => { history.push(e); },
		},
		ui: {
			setWidget: () => {},
			setStatus: () => {},
			notify: (text, level) => { notifications.push({ text, level }); },
			hasUI: true,
			theme: {
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			},
		} as UiPort,
		messaging: {
			sendContextMessage: () => {},
			sendUserMessage: () => {},
		},
		session: {
			getEntries: () => [],
		},
	};
}

describe("handleCreate — successCriteria string[]", () => {
	it("successCriteria string[] → state.successCriteria 为 string[]", () => {
		const session = createGoalSession();
		const ports = makeFakePorts();

		const details = handleCreate(
			{
				action: "create",
				slug: "test-goal",
				objective: "do something",
				successCriteria: ["criterion 1", "criterion 2", "criterion 3"],
			},
			session,
			ports,
		);

		expect(details.action).toBe("create");
		expect(details.status).toBe("active");
		expect(session.state!.successCriteria).toEqual(["criterion 1", "criterion 2", "criterion 3"]);
	});

	it("successCriteria 空数组 → throw", () => {
		const session = createGoalSession();
		const ports = makeFakePorts();

		expect(() =>
			handleCreate(
				{
					action: "create",
					objective: "do something",
					successCriteria: [],
				},
				session,
				ports,
			),
		).toThrow(/successCriteria/);
	});

	it("successCriteria 含空串项 → throw（U6：文案含 Correct: 恢复正例）", () => {
		const session = createGoalSession();
		const ports = makeFakePorts();

		expect(() =>
			handleCreate(
				{
					action: "create",
					objective: "do something",
					successCriteria: ["valid", "  ", "also valid"],
				},
				session,
				ports,
			),
		).toThrow(/successCriteria[\s\S]*Correct:/);
	});

	it.each([
		["LF", ["line1\nline2"]],
		["CRLF", ["a\r\nb"]],
		["孤立 CR", ["a\rb"]],
	])("U7: 条目含换行（%s）→ throw 且文案含「单行」提示与 Correct: 正例", (_label, criteria) => {
		const session = createGoalSession();
		const ports = makeFakePorts();

		expect(() =>
			handleCreate(
				{
					action: "create",
					objective: "do something",
					successCriteria: criteria,
				},
				session,
				ports,
			),
		).toThrow(/successCriteria[\s\S]*single-line[\s\S]*Correct:/);
	});

	it("U28②: 非 string 元素（绕过 schema 直调 handler）→ 业务 throw 含 Correct:，不产生 TypeError", () => {
		const session = createGoalSession();
		const ports = makeFakePorts();

		// 直调 handler 绕过 schema 校验（测试/异常路径可能传入脏元素），断言运行时 typeof 防御
		const dirtyParams = {
			action: "create",
			objective: "do something",
			successCriteria: [1, null, true],
		} as unknown as GoalControlParamsT;

		expect(() => handleCreate(dirtyParams, session, ports)).toThrow(/successCriteria[\s\S]*Correct:/);
		expect(() => handleCreate(dirtyParams, session, ports)).not.toThrow(TypeError);
	});

	it("U5b: 恰 1 条与恰 8 条（含 emoji/中文）→ schema 与 handleCreate 双层均不 throw，state 长度 1/8", () => {
		// 恰 8 条，含 emoji/中文（pattern ^[^\r\n]+$ 不误杀多字节字符）
		const eight = [
			"通过测试✅",
			"条件二：构建成功",
			"tsc --noEmit clean",
			"文件 X 存在且含内容 Y",
			"docs updated 📄",
			"review done",
			"no regressions",
			"ship it 🚀",
		];

		// schema 层：minItems:1 / maxItems:8 边界正值
		expect(
			Value.Check(GoalControlParams, {
				action: "create",
				objective: "do something",
				successCriteria: ["single"],
			}),
		).toBe(true);
		expect(
			Value.Check(GoalControlParams, {
				action: "create",
				objective: "do something",
				successCriteria: eight,
			}),
		).toBe(true);

		// handleCreate 直调层：均不 throw，state 数组长度 1/8
		const session1 = createGoalSession();
		expect(() =>
			handleCreate(
				{ action: "create", objective: "do something", successCriteria: ["single"] },
				session1,
				makeFakePorts(),
			),
		).not.toThrow();
		expect(session1.state!.successCriteria).toHaveLength(1);

		const session8 = createGoalSession();
		expect(() =>
			handleCreate(
				{ action: "create", objective: "do something", successCriteria: eight },
				session8,
				makeFakePorts(),
			),
		).not.toThrow();
		expect(session8.state!.successCriteria).toHaveLength(8);
	});

	it("successCriteria undefined → throw", () => {
		const session = createGoalSession();
		const ports = makeFakePorts();

		expect(() =>
			handleCreate(
				{
					action: "create",
					objective: "do something",
				},
				session,
				ports,
			),
		).toThrow(/successCriteria.*required/);
	});
});
