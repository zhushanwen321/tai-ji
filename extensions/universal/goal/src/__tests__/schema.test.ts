/**
 * goal_control schema — 扁平 Object 校验测试（OpenAI 兼容）
 *
 * schema 为扁平 Type.Object + action 字段级 Type.Union（等价 enum）+ 各字段 Optional +
 * additionalProperties:false。OpenAI function calling 要求 parameters 顶层 type:"object"，
 * 顶层 Type.Union 序列化后只有 anyOf 无 type 字段，会被严格 OpenAI 兼容网关 400 拒绝
 * 整个会话——故采用扁平结构（范式对齐 scheduler ScheduleControlParams）。
 *
 * typebox schema 对象即序列化形态：GoalControlParams.type 就是发往 provider 的 JSON 顶层 type。
 * pi 生产校验器为 typebox/compile 的 Compile(schema).Check(args)，与此处 Value.Check 同源，
 * 故用 Value.Check 验证。
 *
 * 分支隔离从 schema 层降级为运行时 handler 字段存在性校验（见 goal-control-adapter.test.ts）。
 */
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";

import { GoalControlParams } from "../adapters/goal-control-adapter";
import { createGoalState } from "../engine/goal";
import { serializeState } from "../persistence";

describe("GoalControlParams — 扁平 Object（OpenAI 兼容）", () => {
	// 顶层合规：序列化形态顶层必须有 type:"object"，不得有 anyOf（否则被严格网关 400 拒绝）
	it("顶层 type === 'object' 且无 anyOf（OpenAI function calling 合规）", () => {
		expect(GoalControlParams.type).toBe("object");
		expect(GoalControlParams.anyOf).toBeUndefined();
	});

	// valid：各 action 完整 + optional 字段 → 通过
	it.each([
		["create 完整", { action: "create", objective: "x", successCriteria: ["y"] }],
		["create + slug", { action: "create", slug: "refactor-auth", objective: "x", successCriteria: ["y"] }],
		["create + tokenBudget", { action: "create", objective: "x", successCriteria: ["y"], tokenBudget: 8000 }],
		["complete 完整", { action: "complete", evidence: "tests green" }],
		["report_blocked 完整", { action: "report_blocked", reason: "stuck" }],
	])("valid: %s → 通过", (_name, params) => {
		expect(Value.Check(GoalControlParams, params)).toBe(true);
	});

	// 关键语义变更：扁平化后所有声明的字段（含跨 action 的）均为 Optional，
	// schema 不再做分支隔离。{action:"complete", evidence, objective} 放行
	// （objective 是声明的 Optional 字段，schema 层无法区分它属于哪个 action）。
	// 分支隔离降级为运行时 handler 字段存在性校验，见 goal-control-adapter.test.ts。
	it("跨 action 字段（complete + objective）现在通过（分支隔离降级为运行时校验）", () => {
		expect(Value.Check(GoalControlParams, { action: "complete", evidence: "x", objective: "leak" })).toBe(true);
	});

	// invalid：缺 action / 未知 action / 额外字段（additionalProperties:false）
	it.each([
		["缺 action", { objective: "x", successCriteria: ["y"] }],
		["未知 action（不在 union 内）", { action: "unknown" }],
		["create 含额外字段（additionalProperties:false）", { action: "create", objective: "x", successCriteria: ["y"], foo: 1 }],
	])("invalid: %s → 拒绝", (_name, params) => {
		expect(Value.Check(GoalControlParams, params)).toBe(false);
	});
});

// ── 持久化 schema：serializeState 输出（P-m14-2，ext-simplify-03 D2）──

describe("persisted goal-state schema — serializeState 输出（P-m14-2）", () => {
	// D2 一步删除 lastProgressTurn/objectiveUpdatedAt 后，新写入的 goal-state entry
	// 不得再携带这两个 write-only 字段。serializeState 是浅拷贝透传（{ ...state, budget: {...} }），
	// 字段从 GoalRuntimeState 删除后输出自动少两键——此处断言删除完整（fixture 残留即红）。
	it("新写入 entry（serializeState(createGoalState)）不含已删两字段", () => {
		const serialized = serializeState(createGoalState("obj"));
		expect(serialized).not.toHaveProperty("lastProgressTurn");
		expect(serialized).not.toHaveProperty("objectiveUpdatedAt");
	});
});
