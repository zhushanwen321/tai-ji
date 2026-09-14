// src/__tests__/predicates.test.ts
//
// isRecord / isEnoentError / isSubagentProcess 单测（ext-simplify-17 D3/D2/D4 新导出）：
//   - isRecord 排数组严版：数组必须 false（钉值，防回退到允数组宽版）
//   - isEnoentError scheduler 严版：仅 Error 子类 + code === "ENOENT" 才 true，
//     非 Error 对象带 code 是宽版才接受的形态，严版必须 false
//   - isSubagentProcess 三态 + env 注入隔离 + 旧键宁缺勿污钉值（D4 重锚定）

import { describe, expect, it } from "vitest";

import { isEnoentError, isRecord, isSubagentProcess } from "../index.ts";

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

describe("isSubagentProcess", () => {
	it("XYZ_AGENT_SUBAGENT=1 命中（引擎 spawn 链恒注入的现行标记）", () => {
		expect(isSubagentProcess({ XYZ_AGENT_SUBAGENT: "1" })).toBe(true);
	});

	it("值非 \"1\" 不命中（标记必须是引擎注入的字面 \"1\"）", () => {
		expect(isSubagentProcess({ XYZ_AGENT_SUBAGENT: "0" })).toBe(false);
		expect(isSubagentProcess({ XYZ_AGENT_SUBAGENT: "" })).toBe(false);
		expect(isSubagentProcess({ XYZ_AGENT_SUBAGENT: "true" })).toBe(false);
	});

	it("缺失不命中（顶层会话 → 消费方不降级）", () => {
		expect(isSubagentProcess({})).toBe(false);
	});

	it("env 参数注入隔离：传入的 env 与宿主 process.env 无关（宿主即使带标记，空 env 也不命中）", () => {
		const saved = process.env.XYZ_AGENT_SUBAGENT;
		try {
			process.env.XYZ_AGENT_SUBAGENT = "1";
			// 显式传 env：宿主的标记不渗透，判据只看参数
			expect(isSubagentProcess({})).toBe(false);
			expect(isSubagentProcess({ XYZ_AGENT_SUBAGENT: "1" })).toBe(true);
		} finally {
			if (saved === undefined) delete process.env.XYZ_AGENT_SUBAGENT;
			else process.env.XYZ_AGENT_SUBAGENT = saved;
		}
	});

	it("缺省参数读 process.env（不传 env 时以宿主环境为判据）", () => {
		const saved = process.env.XYZ_AGENT_SUBAGENT;
		try {
			process.env.XYZ_AGENT_SUBAGENT = "1";
			expect(isSubagentProcess()).toBe(true);
			delete process.env.XYZ_AGENT_SUBAGENT;
			expect(isSubagentProcess()).toBe(false);
		} finally {
			if (saved === undefined) delete process.env.XYZ_AGENT_SUBAGENT;
			else process.env.XYZ_AGENT_SUBAGENT = saved;
		}
	});

	it("旧 PI_SUBAGENT_* 身份键不再命中（[HISTORICAL] D4 重锚前两键任一存在即命中；引擎协议化后无写入方，宁缺勿污）", () => {
		expect(isSubagentProcess({ PI_SUBAGENT_ROOT_SESSION_ID: "s1" })).toBe(false);
		expect(isSubagentProcess({ PI_SUBAGENT_SELF_RECORD_ID: "r1" })).toBe(false);
		expect(isSubagentProcess({ PI_SUBAGENT_ROOT_SESSION_ID: "s1", PI_SUBAGENT_SELF_RECORD_ID: "r1" })).toBe(
			false,
		);
	});
});
