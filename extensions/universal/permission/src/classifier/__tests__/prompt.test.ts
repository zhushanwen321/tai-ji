/**
 * PT 系列：prompt.ts 单元测试。
 *
 * 验证 CLASSIFIER_SYSTEM_PROMPT 约束 + buildClassifierUserPrompt 字段拼接。
 */
import { describe, expect, it } from "vitest";

import type { ToolInvocationContext } from "../../types.js";
import { buildClassifierUserPrompt, CLASSIFIER_SYSTEM_PROMPT } from "../prompt.js";

function ctx(over: Partial<ToolInvocationContext> = {}): ToolInvocationContext {
	return {
		toolName: "bash",
		command: "ls",
		cwd: "/tmp",
		...over,
	};
}

describe("PT1: CLASSIFIER_SYSTEM_PROMPT", () => {
	it("包含 JSON 字段约束（outcome/risk_level/reasoning/confidence）", () => {
		expect(CLASSIFIER_SYSTEM_PROMPT).toContain("outcome");
		expect(CLASSIFIER_SYSTEM_PROMPT).toContain("risk_level");
		expect(CLASSIFIER_SYSTEM_PROMPT).toContain("reasoning");
		expect(CLASSIFIER_SYSTEM_PROMPT).toContain("confidence");
	});

	it("包含三态动作说明（allow/deny/ask）", () => {
		expect(CLASSIFIER_SYSTEM_PROMPT).toContain("allow");
		expect(CLASSIFIER_SYSTEM_PROMPT).toContain("deny");
		expect(CLASSIFIER_SYSTEM_PROMPT).toContain("ask");
	});
});

describe("PT2: buildClassifierUserPrompt 字段拼接", () => {
	it("默认拼接 tool/command/path/cwd", () => {
		const p = buildClassifierUserPrompt(ctx({ toolName: "bash", command: "ls -la", cwd: "/home" }));
		expect(p).toContain("tool: bash");
		expect(p).toContain("command: ls -la");
		expect(p).toContain("cwd: /home");
	});

	it("command 缺省时显示 (none)", () => {
		const p = buildClassifierUserPrompt(ctx({ toolName: "read", command: undefined }));
		expect(p).toContain("command: (none)");
	});

	it("path 缺省时显示 (none)", () => {
		const p = buildClassifierUserPrompt(ctx({ toolName: "read", path: undefined }));
		expect(p).toContain("path: (none)");
	});

	it("agentName 存在时附 agent 行；缺省则无", () => {
		const withAgent = buildClassifierUserPrompt(ctx({ agentName: "coder" }));
		expect(withAgent).toContain("agent: coder");
		const noAgent = buildClassifierUserPrompt(ctx({ agentName: undefined }));
		expect(noAgent).not.toContain("agent:");
	});
});
