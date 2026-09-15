// 测试框架：vitest（从 vitest 导入 describe/it/expect/vi）
// 运行命令：npx vitest run tests/schema-guards.test.ts
//
// schema-guards 纯函数单测（M4-TC-1 探针 + M4-T9）：
// hasSchemaKeyword / assertJsonSchemaRoot / tryParseJson / echo /
// swap 判定组合（isPlainObject + hasSchemaKeyword）。

import { describe, expect, it } from "vitest";

import {
	assertJsonSchemaRoot,
	echo,
	hasSchemaKeyword,
	isPlainObject,
	tryParseJson,
} from "../src/schema-guards.js";

describe("hasSchemaKeyword — keyword 识别抽查", () => {
	it("命中核心 keyword：type/properties/items/enum/$ref 等", () => {
		expect(hasSchemaKeyword({ type: "object" })).toBe(true);
		expect(hasSchemaKeyword({ properties: {} })).toBe(true);
		expect(hasSchemaKeyword({ items: {} })).toBe(true);
		expect(hasSchemaKeyword({ enum: [1, 2] })).toBe(true);
		expect(hasSchemaKeyword({ $ref: "#/defs/x" })).toBe(true);
		expect(hasSchemaKeyword({ required: ["a"] })).toBe(true);
		expect(hasSchemaKeyword({ anyOf: [] })).toBe(true);
		expect(hasSchemaKeyword({ minimum: 0 })).toBe(true);
	});

	it("keyword-less 对象 → false（{} 与 {a:1}）", () => {
		expect(hasSchemaKeyword({})).toBe(false);
		expect(hasSchemaKeyword({ a: 1 })).toBe(false);
		expect(hasSchemaKeyword({ name: "Alice", age: 30 })).toBe(false);
	});
});

describe("assertJsonSchemaRoot — 权威根类型收窄", () => {
	it("object 与 boolean 通过（draft-07 合法根）", () => {
		expect(() => assertJsonSchemaRoot({ type: "object" })).not.toThrow();
		expect(() => assertJsonSchemaRoot(true)).not.toThrow();
		expect(() => assertJsonSchemaRoot(false)).not.toThrow();
	});

	it("string/number/array/null → 抛带 typeof 的错误", () => {
		for (const bad of ["invalid", 42, [], null] as unknown[]) {
			expect(() => assertJsonSchemaRoot(bad)).toThrow(/got /);
		}
		// 精确消息抽查（null 的 typeof 是 "object"，消息如实反映）
		expect(() => assertJsonSchemaRoot("invalid")).toThrow(/got string/);
		expect(() => assertJsonSchemaRoot(42)).toThrow(/got number/);
	});
});

describe("tryParseJson — JSON 字符串归一", () => {
	it("合法 JSON 字符串 → parse 为值", () => {
		expect(tryParseJson('{"ok":true}')).toEqual({ ok: true });
		expect(tryParseJson("42")).toBe(42);
	});

	it("malformed JSON 字符串 → 保留原值（让 Ajv 拒绝）", () => {
		expect(tryParseJson("{invalid")).toBe("{invalid");
	});

	it("非字符串 → 原样返回（引用不变）", () => {
		const obj = { a: 1 };
		expect(tryParseJson(obj)).toBe(obj);
		expect(tryParseJson(42)).toBe(42);
		expect(tryParseJson(null)).toBeNull();
		expect(tryParseJson(undefined)).toBeUndefined();
	});
});

describe("echo — 错误回显", () => {
	it("长值截断到 200 字符 + 尾缀 ...", () => {
		const out = echo("x".repeat(300));
		expect(out).toHaveLength(203);
		expect(out.endsWith("...")).toBe(true);
		expect(out.slice(0, 200)).toBe("x".repeat(200));
	});

	it("string 直通不截断", () => {
		expect(echo("short")).toBe("short");
	});

	it("对象 JSON 序列化", () => {
		expect(echo({ a: 1 })).toBe('{"a":1}');
	});

	it("undefined 兜底（JSON.stringify(undefined) 返回 undefined，?? String 兜底）", () => {
		expect(echo(undefined)).toBe("undefined");
	});
});

describe("swap 判定组合（isPlainObject + hasSchemaKeyword）", () => {
	it("schema 无 keyword + data 有 keyword → 互换形态", () => {
		const schema = { name: "Alice", age: 30 }; // 像数据（无 keyword）
		const data = { type: "object", properties: { name: { type: "string" } } }; // 像 schema
		const swapped =
			isPlainObject(schema) && !hasSchemaKeyword(schema)
			&& isPlainObject(data) && hasSchemaKeyword(data);
		expect(swapped).toBe(true);
	});

	it("schema 有 keyword + data 无 keyword → 正常形态（不判互换）", () => {
		const schema = { type: "object", properties: { name: { type: "string" } } };
		const data = { name: "Alice" };
		const swapped =
			isPlainObject(schema) && !hasSchemaKeyword(schema)
			&& isPlainObject(data) && hasSchemaKeyword(data);
		expect(swapped).toBe(false);
	});

	it("双 keyword-less 不判互换（无形状信息，走 keyword-less 拒绝分支）", () => {
		const schema = { a: 1 };
		const data = { b: 2 };
		const swapped =
			isPlainObject(schema) && !hasSchemaKeyword(schema)
			&& isPlainObject(data) && hasSchemaKeyword(data);
		expect(swapped).toBe(false);
	});
});
