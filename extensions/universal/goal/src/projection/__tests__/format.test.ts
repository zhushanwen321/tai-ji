/**
 * 纯格式化函数测试 — formatTokens / formatMinutes / formatDuration /
 * formatHistoryEntry / escapeXmlText 边界覆盖（TC-format）。
 *
 * 这些函数原本内联在 widget/command-adapter/prompts，只能通过渲染输出间接测；
 * 抽为 export 后此处直接断言边界行为，构成独立回归网。
 *
 * 注意 formatMinutes（widget，secs=0 省略秒）与 formatDuration（history/status，
 * 始终带秒）是两种语义不同的格式化，不可混用。
 */
import { describe, expect, it } from "vitest";

import { formatDuration, formatHistoryEntry } from "../../adapters/command-adapter";
import { OBJECTIVE_DISPLAY_LIMIT, OBJECTIVE_TRUNCATE_KEEP } from "../../constants";
import type { GoalHistoryEntry } from "../../ports";
import { escapeXmlText } from "../prompts";
import { formatMinutes, formatTokens } from "../widget";

// ── formatTokens（token 缩写，≥1000 用 k）──────────────

describe("formatTokens", () => {
	it.each([
		["0 → 原样", 0, "0"],
		["999 → 原样（阈值下）", 999, "999"],
		["1000 → 整数 k（不带小数）", 1000, "1k"],
		["1500 → 一位小数 k", 1500, "1.5k"],
		["12000 → 整数 k", 12000, "12k"],
		["12500 → 一位小数 k", 12500, "12.5k"],
	])("%s", (_name, input, expected) => {
		expect(formatTokens(input)).toBe(expected);
	});
});

// ── formatMinutes（widget 用，secs=0 省略秒）──────────

describe("formatMinutes", () => {
	it.each([
		["0 → 0m（省略秒）", 0, "0m"],
		["59 → 0m59s", 59, "0m59s"],
		["60 → 1m（省略秒）", 60, "1m"],
		["61 → 1m1s", 61, "1m1s"],
		["90 → 1m30s", 90, "1m30s"],
		["120 → 2m（省略秒）", 120, "2m"],
	])("%s", (_name, input, expected) => {
		expect(formatMinutes(input)).toBe(expected);
	});
});

// ── formatDuration（history/status 用，始终带秒）──────

describe("formatDuration", () => {
	it.each([
		["0 → 0m0s", 0, "0m0s"],
		["59 → 0m59s", 59, "0m59s"],
		["60 → 1m0s", 60, "1m0s"],
		["61 → 1m1s", 61, "1m1s"],
		["3599 → 59m59s", 3599, "59m59s"],
		["3600 → 60m0s（超过 1 小时仍按分计）", 3600, "60m0s"],
	])("%s", (_name, input, expected) => {
		expect(formatDuration(input)).toBe(expected);
	});
});

// ── formatHistoryEntry（history 单条渲染）────────────

function makeHistoryEntry(overrides?: Partial<GoalHistoryEntry>): GoalHistoryEntry {
	return {
		goalId: "g1",
		objective: "build the feature",
		status: "complete",
		elapsedSeconds: 90,
		timestamp: 1000,
		...overrides,
	};
}

describe("formatHistoryEntry", () => {
	it.each([
		["complete → ✓", "complete", "✓"],
		["cancelled → ✗", "cancelled", "✗"],
		["budget_limited → ⊗", "budget_limited", "⊗"],
		["time_limited → ⏱（旧数据兼容）", "time_limited", "⏱"],
		["未知 status → ?", "active", "?"],
	])("%s", (_name, status, icon) => {
		const lines = formatHistoryEntry(makeHistoryEntry({ status, elapsedSeconds: 0 }), 0);
		expect(lines[0]).toContain(icon);
		expect(lines[1]).toContain(`| ${status}`);
	});

	it("index 从 0 起，输出序号 = index+1", () => {
		expect(formatHistoryEntry(makeHistoryEntry(), 0)[0]).toMatch(/^1\. /);
		expect(formatHistoryEntry(makeHistoryEntry(), 2)[0]).toMatch(/^3\. /);
	});

	it("有 slug → 标题用 slug（优先于 objective，不截断）", () => {
		const lines = formatHistoryEntry(
			makeHistoryEntry({ slug: "refactor-auth", objective: "long objective ignored" }),
			0,
		);
		expect(lines[0]).toContain("refactor-auth");
		expect(lines[0]).not.toContain("long objective ignored");
	});

	it("无 slug 短 objective → 标题用原 objective", () => {
		const lines = formatHistoryEntry(
			makeHistoryEntry({ objective: "short obj", slug: undefined }),
			0,
		);
		expect(lines[0]).toContain("short obj");
		expect(lines[0]).not.toContain("...");
	});

	it("无 slug 长 objective → 截断到 OBJECTIVE_TRUNCATE_KEEP + ...", () => {
		const long = "x".repeat(OBJECTIVE_DISPLAY_LIMIT + 10);
		const lines = formatHistoryEntry(
			makeHistoryEntry({ objective: long, slug: undefined }),
			0,
		);
		expect(lines[0]).toContain(`${"x".repeat(OBJECTIVE_TRUNCATE_KEEP)}...`);
		expect(lines[0]).not.toContain(`${"x".repeat(OBJECTIVE_DISPLAY_LIMIT + 10)}`);
	});

	it("详情行格式：3 空格缩进 + duration + status", () => {
		const lines = formatHistoryEntry(
			makeHistoryEntry({ status: "complete", elapsedSeconds: 90 }),
			0,
		);
		// formatDuration(90) = "1m30s"
		expect(lines[1]).toBe("   1m30s | complete");
	});

	it("输出固定 2 行（标题行 + 详情行）", () => {
		expect(formatHistoryEntry(makeHistoryEntry(), 0)).toHaveLength(2);
	});
});

// ── escapeXmlText（XML text 转义，不转义引号）────────

describe("escapeXmlText", () => {
	it.each([
		["& → &amp;", "&", "&amp;"],
		["< → &lt;", "<", "&lt;"],
		["> → &gt;", ">", "&gt;"],
		["空串 → 空串", "", ""],
		["正常文本不变", "hello world", "hello world"],
		['双引号不转义（XML text 语义，非 attribute）', '"', '"'],
		["单引号不转义", "'", "'"],
	])("%s", (_name, input, expected) => {
		expect(escapeXmlText(input)).toBe(expected);
	});

	it("混合字符全部转义", () => {
		expect(escapeXmlText("a&b<c>")).toBe("a&amp;b&lt;c&gt;");
	});

	it("& 先于 < 转义（顺序保护，避免 &lt; 的 & 被二次转义）", () => {
		// 输入 "&<"：& 先转 → "&amp;<"，再 < 转 → "&amp;&lt;"
		// 若顺序反（先 < 后 &）会得到 "&amp;&amp;lt;"（错误双重转义）
		expect(escapeXmlText("&<")).toBe("&amp;&lt;");
	});
});
