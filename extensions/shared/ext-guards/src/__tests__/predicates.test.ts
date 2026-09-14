// src/__tests__/predicates.test.ts
//
// isRecord / isEnoentError 单测（ext-simplify-17 D3/D2 新导出）：
//   - isRecord 排数组严版：数组必须 false（钉值，防回退到允数组宽版）
//   - isEnoentError scheduler 严版：仅 Error 子类 + code === "ENOENT" 才 true，
//     非 Error 对象带 code 是宽版才接受的形态，严版必须 false

import { describe, expect, it } from "vitest";

import { isEnoentError, isRecord } from "../index.ts";

describe("isRecord", () => {
	it("对象 true", () => {
		expect(isRecord({})).toBe(true);
		expect(isRecord({ key: "value" })).toBe(true);
	});

	it("null false", () => {
		expect(isRecord(null)).toBe(false);
	});

	it("undefined false", () => {
		expect(isRecord(undefined)).toBe(false);
	});

	it("数组 false（排数组钉值——Record 语义不含数组）", () => {
		expect(isRecord([])).toBe(false);
		expect(isRecord([{ a: 1 }])).toBe(false);
	});

	it("字符串 false", () => {
		expect(isRecord("text")).toBe(false);
	});
});

describe("isEnoentError", () => {
	it("Error 带 code=ENOENT true（Node fs 错误的构造形态）", () => {
		expect(isEnoentError(Object.assign(new Error("no such file"), { code: "ENOENT" }))).toBe(
			true,
		);
	});

	it("普通 Error false（无 code 属性）", () => {
		expect(isEnoentError(new Error("x"))).toBe(false);
	});

	it("code 为其他值 false", () => {
		expect(isEnoentError(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe(false);
	});

	it("非 Error 对象带 code=ENOENT false（严版：宽版才接受的形态）", () => {
		expect(isEnoentError({ code: "ENOENT" })).toBe(false);
	});

	it("undefined false", () => {
		expect(isEnoentError(undefined)).toBe(false);
	});
});
