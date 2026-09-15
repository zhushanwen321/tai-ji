// src/__tests__/sdk-contract.test.ts
//
// SDK 契约测试：验证 ask-user 扩展的工厂函数和注册接口与 SDK 类型兼容。
// 核心断言：
//   1. default export 是接受 ExtensionAPI 的工厂函数
//   2. registerTool 注册名为 "ask_user" 的 tool，含 description/execute/renderCall/renderResult
//   3. renderCall 参数数量 >= 1（args）
//   4. renderResult 参数数量 >= 2（result, options）
//   5. validateInput 校验逻辑正确

import { describe, expect, it } from "vitest";

import askUserExtension from "../index";
import { validateInput } from "../validate";

describe("ask-user SDK contract", () => {
	it("default export is a function accepting ExtensionAPI", () => {
		expect(typeof askUserExtension).toBe("function");
		// 工厂函数应接受 1 个参数 (pi: ExtensionAPI)
		expect(askUserExtension.length).toBe(1);
	});

	it("registerTool receives a valid ToolDefinition named 'ask_user'", () => {
		let toolDef: Record<string, unknown> | undefined;
		const mockPi = {
			registerTool(def: Record<string, unknown>) {
				toolDef = def;
			},
			on() {},
			registerCommand() {},
			getAllTools() { return []; },
			setActiveTools() {},
		} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;

		askUserExtension(mockPi);

		expect(toolDef).toBeDefined();
		expect(toolDef!.name).toBe("ask_user");
		expect(typeof toolDef!.description).toBe("string");
		expect(typeof toolDef!.execute).toBe("function");
		expect(typeof toolDef!.renderCall).toBe("function");
		expect(typeof toolDef!.renderResult).toBe("function");
		// parameters schema 应存在
		expect(toolDef!.parameters).toBeDefined();
	});

	it("renderCall accepts >= 1 args (args, [theme])", () => {
		let toolDef: Record<string, unknown> | undefined;
		const mockPi = {
			registerTool(def: Record<string, unknown>) { toolDef = def; },
			on() {},
			registerCommand() {},
			getAllTools() { return []; },
			setActiveTools() {},
		} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
		askUserExtension(mockPi);
		expect(toolDef!.renderCall!.length).toBeGreaterThanOrEqual(1);
	});

	it("renderResult accepts >= 2 args (result, options, [theme])", () => {
		let toolDef: Record<string, unknown> | undefined;
		const mockPi = {
			registerTool(def: Record<string, unknown>) { toolDef = def; },
			on() {},
			registerCommand() {},
			getAllTools() { return []; },
			setActiveTools() {},
		} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
		askUserExtension(mockPi);
		expect(toolDef!.renderResult!.length).toBeGreaterThanOrEqual(2);
	});

	it("validateInput accepts empty questions array (schema-level, not runtime)", () => {
		// validateInput 是运行时校验，不检查数组长度（minItems 由 typebox schema 层强制）
		expect(validateInput([])).toBeNull();
	});

	it("validateInput accepts empty options array (schema-level, not runtime)", () => {
		// 同上：options 长度由 schema 层校验
		expect(
			validateInput([
				{ question: "Q?", options: [] },
			] as unknown as import("../types").Question[]),
		).toBeNull();
	});

	it("validateInput rejects duplicate question text", () => {
		expect(
			validateInput([
				{ question: "Same?", options: [{ label: "A" }, { label: "B" }] },
				{ question: "Same?", header: "Dup", options: [{ label: "X" }, { label: "Y" }] },
			] as import("../types").Question[]),
		).toBeTruthy();
	});

	it("validateInput rejects empty option label", () => {
		expect(
			validateInput([
				{ question: "Q?", options: [{ label: "" }, { label: "B" }] },
			] as import("../types").Question[]),
		).toBeTruthy();
	});

	it("validateInput accepts a valid single question", () => {
		expect(
			validateInput([
				{ question: "Q1?", options: [{ label: "A" }, { label: "B" }] },
			] as import("../types").Question[]),
		).toBeNull();
	});
});
