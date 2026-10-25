// bash_output / bash_kill 收起态摘要测试：summary 纯函数文案 + details 形态 +
// renderResult 折叠/展开。summary 从自产 JSON 文本防御性取数。

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import {
	buildBashKillSummary,
	buildBashOutputSummary,
	renderBashToolResult,
} from "../render-result";
import { createBashKillToolDefinition } from "../bash-kill-tool";
import { createBashOutputToolDefinition } from "../bash-output-tool";
import { clearTaskStoreForTest, registerSpawnedTask } from "../background/task-store";
import type { BackgroundTask } from "../background/types";

function resultOf(text: string): { content: Array<{ type: string; text?: string }>; details?: unknown } {
	return { content: [{ type: "text", text }] };
}

// ── buildBashOutputSummary ───────────────────────────

describe("buildBashOutputSummary", () => {
	it("指定 task_id → Output of task <id> · N lines", () => {
		const text = JSON.stringify({ task_id: "t1", state: "exited", output: "line1\nline2\nline3", truncated: false });
		expect(buildBashOutputSummary({ task_id: "t1" }, resultOf(text))).toBe("Output of task t1 · 3 lines");
	});

	it("output 丢失（<lost>）→ 省略行数后缀", () => {
		const text = JSON.stringify({ task_id: "t1", state: "running", output: "<lost>" });
		expect(buildBashOutputSummary({ task_id: "t1" }, resultOf(text))).toBe("Output of task t1");
	});

	it("output 空串 → 省略行数后缀", () => {
		const text = JSON.stringify({ task_id: "t1", state: "running", output: "" });
		expect(buildBashOutputSummary({ task_id: "t1" }, resultOf(text))).toBe("Output of task t1");
	});

	it("省略 task_id（列表视图）→ N background tasks / No background tasks", () => {
		const text = JSON.stringify({ tasks: [{ task_id: "a" }, { task_id: "b" }] });
		expect(buildBashOutputSummary({}, resultOf(text))).toBe("2 background tasks");
		const empty = JSON.stringify({ tasks: [] });
		expect(buildBashOutputSummary({}, resultOf(empty))).toBe("No background tasks");
	});

	it("content 非 JSON（防御）→ 兜底 Done", () => {
		expect(buildBashOutputSummary({ task_id: "t1" }, resultOf("not json"))).toBe("Done");
	});
});

// ── buildBashKillSummary ─────────────────────────────

describe("buildBashKillSummary", () => {
	it("killed=true → Killed task <id>", () => {
		const text = JSON.stringify({ killed: true, reason: "kill signal sent; poll bash_output for the final state" });
		expect(buildBashKillSummary({ task_id: "t1" }, resultOf(text))).toBe("Killed task t1");
	});

	it("killed=false → Kill failed: <reason>", () => {
		const text = JSON.stringify({ killed: false, reason: "no such task", hint: "use bash_output to list" });
		expect(buildBashKillSummary({ task_id: "t1" }, resultOf(text))).toBe("Kill failed: no such task");
	});

	it("reason 超长截 80 加省略号", () => {
		const text = JSON.stringify({ killed: false, reason: "x".repeat(100) });
		expect(buildBashKillSummary({ task_id: "t1" }, resultOf(text))).toBe(`Kill failed: ${"x".repeat(80)}…`);
	});

	it("reason 含换行 → 摘要归一单行（details.summary 单行契约）", () => {
		const text = JSON.stringify({ killed: false, reason: "no such task\ntry bash_output" });
		expect(buildBashKillSummary({ task_id: "t1" }, resultOf(text))).toBe(
			"Kill failed: no such task try bash_output",
		);
	});

	it("reason 含 emoji 超长 → 码点安全截断不劈代理对（S-3）", () => {
		// "x🎉" = 3 个 UTF-16 码元；UTF-16 slice(0,80) 会在第 80 码元处劈开 🎉 的代理对。
		// 码点口径：60 码点 ≤ 80 → 原样保留（全为完整代理对）
		const text = JSON.stringify({ killed: false, reason: "x🎉".repeat(30) });
		const summary = buildBashKillSummary({ task_id: "t1" }, resultOf(text));
		expect(summary).not.toContain("\n");
		const loneSurrogates = Array.from(summary).filter(
			(ch) => ch.length === 1 && /[\uD800-\uDFFF]/.test(ch),
		);
		expect(loneSurrogates).toHaveLength(0);

		// 超过 80 码点的 emoji 输入同样不产生孤立代理项（截 80 码点 + 省略号）
		const long = JSON.stringify({ killed: false, reason: "🎉".repeat(100) });
		const clipped = buildBashKillSummary({ task_id: "t1" }, resultOf(long));
		const loneInClipped = Array.from(clipped).filter(
			(ch) => ch.length === 1 && /[\uD800-\uDFFF]/.test(ch),
		);
		expect(loneInClipped).toHaveLength(0);
		expect(clipped).toBe(`Kill failed: ${"🎉".repeat(80)}…`);
	});

	it("content 非 JSON（防御）→ 兜底 Done", () => {
		expect(buildBashKillSummary({ task_id: "t1" }, resultOf(""))).toBe("Done");
	});
});

// ── details 形态（definition.execute 层）────────────

function makeTask(taskId: string, outputFile: string): BackgroundTask {
	return {
		taskId,
		pid: 1,
		command: "echo hi",
		outputFile,
		registryPath: "/tmp/registry.json",
		startedAt: 0,
		state: "running",
		ownerPiPid: 1,
		sessionId: "s",
	} as BackgroundTask;
}

describe("bash tools details.summary wiring", () => {
	afterEach(() => {
		clearTaskStoreForTest();
	});

	it("bash_output 列表视图 details = { summary }", async () => {
		const def = createBashOutputToolDefinition() as {
			execute: (id: string, args: { task_id?: string }, s: undefined, u: unknown, ctx: { sessionManager: { getSessionId: () => string } }) => Promise<{ details: unknown }>;
		};
		const res = await def.execute("id", {}, undefined, undefined, { sessionManager: { getSessionId: () => "s" } });
		expect(res.details).toMatchObject({ summary: "No background tasks" });
	});

	it("bash_output 详情视图 → summary 带行数（单例表注册任务）", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bte-output-"));
		try {
			const outputFile = join(dir, "out.log");
			writeFileSync(outputFile, "line1\nline2\nline3", "utf8");
			registerSpawnedTask(makeTask("t-detail", outputFile));
			const def = createBashOutputToolDefinition() as {
				execute: (id: string, args: { task_id?: string }, s: undefined, u: unknown, ctx: { sessionManager: { getSessionId: () => string } }) => Promise<{ details: unknown }>;
			};
			const res = await def.execute("id", { task_id: "t-detail" }, undefined, undefined, {
				sessionManager: { getSessionId: () => "s" },
			});
			expect(res.details).toMatchObject({ summary: "Output of task t-detail · 3 lines" });
		} finally {
			rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		}
	});

	it("bash_kill definition 挂 renderResult", () => {
		const def = createBashKillToolDefinition() as { renderResult?: unknown };
		expect(typeof def.renderResult).toBe("function");
	});

	it("bash_output definition 挂 renderResult", () => {
		const def = createBashOutputToolDefinition() as { renderResult?: unknown };
		expect(typeof def.renderResult).toBe("function");
	});
});

// ── renderBashToolResult（TUI renderResult）──────────

const mockTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	inverse: (text: string) => text,
	strikethrough: (text: string) => text,
	getFgAnsi: (_color: string) => "",
	getBgAnsi: (_color: string) => "",
	getColorMode: () => "truecolor" as const,
	getThinkingBorderColor: () => (text: string) => text,
	getBashModeBorderColor: () => (text: string) => text,
} as unknown as Theme;

function renderedText(result: unknown, expanded: boolean): string {
	return renderBashToolResult(result, { expanded }, mockTheme)
		.render(400)
		.map((line) => line.trimEnd())
		.join("\n");
}

describe("renderBashToolResult", () => {
	it("折叠态 → details.summary 一行", () => {
		const r = { content: [{ type: "text", text: '{"killed":true}' }], details: { summary: "Killed task t1" } };
		expect(renderedText(r, false)).toBe("Killed task t1");
	});

	it("展开态 → content 纯文本（JSON 原文）", () => {
		const json = JSON.stringify({ killed: true }, null, 2);
		const r = { content: [{ type: "text", text: json }], details: { summary: "Killed task t1" } };
		expect(renderedText(r, true)).toBe(json);
	});

	it("无 summary（旧 entry）→ 折叠态回退 content 首行", () => {
		const r = { content: [{ type: "text", text: '{"killed":true}' }], details: undefined };
		expect(renderedText(r, false)).toBe('{"killed":true}');
	});
});
