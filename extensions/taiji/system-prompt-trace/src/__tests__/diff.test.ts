/**
 * diff.ts summarizePromptDiff 分支矩阵（Gate-1.6 覆盖缺口：lcsLineDiff 回溯分支 + multiset 降级路径）。
 *
 * 覆盖目标（对照 diff.ts）：
 * - 全等 → header-only（samples 为空的 return 分支）
 * - 纯尾部增/删 → LCS 回溯的两个尾部循环（while i<m / while j<n）
 * - 中段替换 → 回溯 removed 分支；头部插入 → 回溯 added 分支（dp 上移 < 右移）
 * - 采样交替（added 优先）+ 8 条上限；removed 提前耗尽后 added 补满（采样循环 removed 条件的 false 分支）
 * - 单行 >80 字符截断（truncate）
 * - LCS 面积超限（2001×2001 > 4M cells）→ multisetLineDiff 降级：共享行计数抵消、
 *   added 按新文本序、removed 按旧行插入序
 * - 空字符串输入（split 产生单空行的边界）
 */
import { describe, expect, it } from "vitest";

import { summarizePromptDiff } from "../diff.js";

describe("summarizePromptDiff", () => {
	it("全等 → 仅 header，无采样行", () => {
		expect(summarizePromptDiff("a\nb\nc", "a\nb\nc")).toBe("+0 -0 lines");
	});

	it("纯尾部新增 → LCS 回溯走尾部 added 循环", () => {
		expect(summarizePromptDiff("keep", "keep\na1\na2")).toBe("+2 -0 lines\n+ a1\n+ a2");
	});

	it("纯尾部删除 → LCS 回溯走尾部 removed 循环", () => {
		expect(summarizePromptDiff("keep\nr1\nr2", "keep")).toBe("+0 -2 lines\n- r1\n- r2");
	});

	it("中段单行替换 → removed/added 各一，采样 added 在前", () => {
		expect(summarizePromptDiff("x\n1\ny", "x\nA\ny")).toBe("+1 -1 lines\n+ A\n- 1");
	});

	it("头部插入 → LCS 回溯走 added 分支（dp 取右移更优）", () => {
		expect(summarizePromptDiff("b\nc", "a\nb\nc")).toBe("+1 -0 lines\n+ a");
	});

	it("交错增删 → 采样 added/removed 交替且与文本顺序一致", () => {
		expect(summarizePromptDiff("x\n1\ny\n2", "x\nA\ny\nB")).toBe("+2 -2 lines\n+ A\n- 1\n+ B\n- 2");
	});

	it("采样上限 8 条：added/removed 交错时各取前 4，余量丢弃", () => {
		const old = ["keep", "r1", "r2", "r3", "r4", "r5", "r6"].join("\n");
		const next = ["keep", "a1", "a2", "a3", "a4", "a5", "a6"].join("\n");
		const lines = summarizePromptDiff(old, next).split("\n");
		expect(lines).toEqual([
			"+6 -6 lines",
			"+ a1",
			"- r1",
			"+ a2",
			"- r2",
			"+ a3",
			"- r3",
			"+ a4",
			"- r4",
		]);
	});

	it("removed 提前耗尽后 added 补满 8 条（采样循环 removed 条件的 false 分支）", () => {
		const old = ["keep", "r1", "r2", "r3"].join("\n");
		const next = ["keep", "a1", "a2", "a3", "a4", "a5"].join("\n");
		const lines = summarizePromptDiff(old, next).split("\n");
		expect(lines).toEqual([
			"+5 -3 lines",
			"+ a1",
			"- r1",
			"+ a2",
			"- r2",
			"+ a3",
			"- r3",
			"+ a4",
			"+ a5",
		]);
	});

	it("单行超 80 字符 → 截断为 79 字符 + 省略号", () => {
		const long = "L".repeat(120);
		const lines = summarizePromptDiff("keep", `keep\n${long}`).split("\n");
		expect(lines[0]).toBe("+1 -0 lines");
		expect(lines[1]).toBe(`+ ${"L".repeat(79)}…`);
	});

	it("空字符串输入 → 空行计入 removed（split 单空行边界）", () => {
		expect(summarizePromptDiff("", "a")).toBe("+1 -1 lines\n+ a\n- ");
	});

	it("LCS 面积超限（2001×2001 > 4M cells）→ multiset 降级：共享行抵消，added 按新文本序", () => {
		const oldLines = ["shared", ...Array.from({ length: 2000 }, (_, i) => `old-${i}`)];
		const newLines = ["shared", ...Array.from({ length: 2000 }, (_, i) => `new-${i}`)];
		const summary = summarizePromptDiff(oldLines.join("\n"), newLines.join("\n"));
		const lines = summary.split("\n");
		expect(lines[0]).toBe("+2000 -2000 lines");
		expect(lines.slice(1)).toEqual([
			"+ new-0",
			"- old-0",
			"+ new-1",
			"- old-1",
			"+ new-2",
			"- old-2",
			"+ new-3",
			"- old-3",
		]);
		// shared 两边各出现一次 → multiset 计数抵消，不进 added/removed
		expect(summary).not.toContain("shared");
	});
});
