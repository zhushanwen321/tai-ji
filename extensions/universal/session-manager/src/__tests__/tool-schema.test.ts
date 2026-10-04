// tool-schema.test.ts — U5-A3: verify parameter schemas match spec requirements

import { describe, it, expect } from "vitest";
import registerExtension from "../index.ts";

function getRegisteredSchemas() {
	const registered: Array<{ name: string; parameters: Record<string, unknown> }> = [];
	const pi = {
		registerTool: (tool: { name: string; parameters: Record<string, unknown> }) => registered.push(tool),
		on: () => {},
		getAllTools: () => [],
		setActiveTools: () => {},
	};
	registerExtension(pi as never);
	return Object.fromEntries(registered.map((t) => [t.name, t.parameters]));
}

describe("U5-A3 tool-schema", () => {
	const schemas = getRegisteredSchemas();

	describe("create_managed_session", () => {
		it("requires cwd (string)", () => {
			const s = schemas.create_managed_session;
			expect(s.type).toBe("object");
			const props = s.properties as Record<string, unknown>;
			expect(props.cwd).toBeDefined();
			expect((props.cwd as Record<string, unknown>).type).toBe("string");
			const required = s.required as string[];
			expect(required).toContain("cwd");
		});

		it("has optional label (string)", () => {
			const props = schemas.create_managed_session.properties as Record<string, unknown>;
			expect(props.label).toBeDefined();
			expect((props.label as Record<string, unknown>).type).toBe("string");
			const required = schemas.create_managed_session.required as string[];
			expect(required).not.toContain("label");
		});

		it("has optional prompt (string) — sd-u5: create 带 prompt 的工具 schema 暴露", () => {
			const props = schemas.create_managed_session.properties as Record<string, unknown>;
			expect(props.prompt).toBeDefined();
			expect((props.prompt as Record<string, unknown>).type).toBe("string");
			const required = schemas.create_managed_session.required as string[];
			expect(required).not.toContain("prompt");
		});
	});

	describe("send_to_session", () => {
		it("requires sessionId (string) and prompt (string)", () => {
			const s = schemas.send_to_session;
			const props = s.properties as Record<string, unknown>;
			expect(props.sessionId).toBeDefined();
			expect((props.sessionId as Record<string, unknown>).type).toBe("string");
			expect(props.prompt).toBeDefined();
			expect((props.prompt as Record<string, unknown>).type).toBe("string");
			const required = s.required as string[];
			expect(required).toContain("sessionId");
			expect(required).toContain("prompt");
		});
	});

	describe("read_session_history", () => {
		it("requires sessionId (string)", () => {
			const s = schemas.read_session_history;
			const props = s.properties as Record<string, unknown>;
			expect(props.sessionId).toBeDefined();
			expect((props.sessionId as Record<string, unknown>).type).toBe("string");
			const required = s.required as string[];
			expect(required).toContain("sessionId");
		});

		it("has optional tailTurns (number)", () => {
			const props = schemas.read_session_history.properties as Record<string, unknown>;
			expect(props.tailTurns).toBeDefined();
			expect((props.tailTurns as Record<string, unknown>).type).toBe("number");
			const required = schemas.read_session_history.required as string[];
			expect(required).not.toContain("tailTurns");
		});
	});

	describe("list_my_sessions", () => {
	it("has no required parameters", () => {
		const s = schemas.list_my_sessions;
		expect(s.type).toBe("object");
		// TypeBox 对空 Object 省略 required 键（探针核实：Type.Object({}) →
		// { type:"object", properties:{} }，无 required 字段）——「无必填参数」语义 =
		// required 缺省或空数组，二者都必须被断言覆盖（原 if 条件断言在缺省形态下
		// 零断言执行，永不失败）
		const required = s.required as string[] | undefined;
		expect(required ?? []).toHaveLength(0);
	});
	});

	describe("get_session_status", () => {
		it("requires sessionId (string)", () => {
			const s = schemas.get_session_status;
			const props = s.properties as Record<string, unknown>;
			expect(props.sessionId).toBeDefined();
			expect((props.sessionId as Record<string, unknown>).type).toBe("string");
			const required = s.required as string[];
			expect(required).toContain("sessionId");
		});
	});

	describe("abort_session", () => {
		it("requires sessionId (string)", () => {
			const s = schemas.abort_session;
			const props = s.properties as Record<string, unknown>;
			expect(props.sessionId).toBeDefined();
			expect((props.sessionId as Record<string, unknown>).type).toBe("string");
			const required = s.required as string[];
			expect(required).toContain("sessionId");
		});
	});
});
