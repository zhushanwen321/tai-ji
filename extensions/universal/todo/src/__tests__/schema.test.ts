// Schema 顶层合规回归（OpenAI function calling：parameters 顶层必须是 type:"object"，
// 顶层 union 会被严格网关 400 拒绝整个会话启动）。
//
// 扁平化后 TodoParams 是单一 Type.Object + action 字段级 union（参考 scheduler 的
// ScheduleControlParams）。语义变更：所有非 action 字段都是 Optional，缺失必填
// （如 {action:'add'} 缺 texts、delete 缺 ids）不再被 schema 拒绝——改由 handler 运行时
// 校验（见 tool-detectors.test.ts）。schema 仍强约束：action 枚举、status 枚举、
// additionalProperties:false（拒绝未知字段）。
//
// 选 Value.Check 而非 ajv：typebox 自带 Value 校验器与其 schema 语义一致。

import { describe, expect, it } from "vitest";

import { Value } from "typebox/value";

import { TodoParams } from "../tool";

describe("TodoParams 扁平 schema（顶层 type:object 合规）", () => {
	describe("顶层合规（OpenAI function calling）", () => {
		it("type === object（非顶层 union）", () => {
			expect(TodoParams.type).toBe("object");
		});
		it("无顶层 anyOf（discriminated union 已消除）", () => {
			expect(TodoParams.anyOf).toBeUndefined();
		});
		it("additionalProperties: false", () => {
			expect(TodoParams.additionalProperties).toBe(false);
		});
	});

	describe("合法 payload 通过", () => {
		it("list", () => {
			expect(Value.Check(TodoParams, { action: "list" })).toBe(true);
		});
		it("add + texts", () => {
			expect(Value.Check(TodoParams, { action: "add", texts: ["write spec"] })).toBe(true);
		});
		it("update 单条 + id + status", () => {
			expect(Value.Check(TodoParams, { action: "update", id: 1, status: "in_progress" })).toBe(true);
		});
		it("update 批量 + updates", () => {
			expect(Value.Check(TodoParams, { action: "update", updates: [{ id: 1, status: "completed" }] })).toBe(true);
		});
		it("delete + ids", () => {
			expect(Value.Check(TodoParams, { action: "delete", ids: [1, 2] })).toBe(true);
		});
	});

	describe("action 枚举强约束", () => {
		it("缺 action 被拒绝", () => {
			expect(Value.Check(TodoParams, {})).toBe(false);
		});
		it("未知 action（clear 不在 union 内）被拒绝", () => {
			expect(Value.Check(TodoParams, { action: "clear" })).toBe(false);
		});
	});

	describe("额外字段被拒绝（additionalProperties:false）", () => {
		it("list 携带未知字段 foo → 拒绝", () => {
			expect(Value.Check(TodoParams, { action: "list", foo: 1 })).toBe(false);
		});
	});

	describe("status 枚举强约束", () => {
		it("合法三态 status 通过", () => {
			expect(Value.Check(TodoParams, { action: "update", id: 1, status: "completed" })).toBe(true);
		});
		it("cancelled 不在 VALID_STATUSES → 拒绝", () => {
			expect(Value.Check(TodoParams, { action: "update", id: 1, status: "cancelled" })).toBe(false);
		});
		it("非法 status → 拒绝", () => {
			expect(Value.Check(TodoParams, { action: "update", id: 1, status: "banana" })).toBe(false);
		});
	});

	describe("缺失必填 / 双形陷阱降级为 handler 运行时校验", () => {
		// 扁平化后 {action:"add"} 缺 texts 不再被 schema 拒绝（texts 是 Optional）。
		// 必填报错改由 handler 运行时校验，见 tool-detectors.test.ts。
		it("{action:'add'} 缺 texts → schema 放行（handler 校验）", () => {
			expect(Value.Check(TodoParams, { action: "add" })).toBe(true);
		});
		// 双形陷阱（add 同时传 text+texts）从 schema 层降级为运行时 handler 检测，
		// 见 tool-detectors.test.ts。
		it("{action:'add', texts:['y'], text:'x'} 双形 → schema 放行（handler 检测）", () => {
			expect(Value.Check(TodoParams, { action: "add", texts: ["y"], text: "x" })).toBe(true);
		});
	});
});
