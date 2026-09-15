/**
 * goal_control prompt guidance — successCriteria 三层引导文本独立 prompt-lock
 *
 * W1（plan U24）：粒度约束分布在三层，每层独立锁死，删掉任一层约束本文件对应 describe 必红：
 * 1. 参数层：GoalControlParams.successCriteria 的 schema description（导出对象直读）
 * 2. 工具层：registerGoalControlTool 工具 description 的 create 段（源码文本切片）
 * 3. guidelines 层：promptGuidelines 的 create 条目（源码文本按赋值块切片）
 *
 * 为什么源码文本断言：description / promptGuidelines 内联在 registerGoalControlTool、
 * 未导出常量；按变量边界切片（marker 定位 + 范围内断言），禁止跨块 [\s\S]*? 全文穿越——
 * 否则删掉某层约束后其余层文本仍能命中，测试假绿（review 发现的历史缺陷）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { GoalControlParams } from "../adapters/goal-control-adapter";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTER_SRC = readFileSync(
	join(__dirname, "../adapters/goal-control-adapter.ts"),
	"utf-8",
);

/** 按 marker 切片（含 start，不含 end）。marker 缺失时抛可定位错误，防切片静默错位。 */
function sliceBetween(src: string, startMarker: string, endMarker: string): string {
	const start = src.indexOf(startMarker);
	if (start === -1) {
		throw new Error(`start marker not found in goal-control-adapter.ts: ${startMarker}`);
	}
	const end = src.indexOf(endMarker, start + startMarker.length);
	if (end === -1) {
		throw new Error(`end marker "${endMarker}" not found after "${startMarker}" in goal-control-adapter.ts`);
	}
	return src.slice(start, end);
}

// ── 第 1 层切片：参数 schema（从模块导出直读，非文本匹配）──────

const successCriteriaSchema = GoalControlParams.properties.successCriteria;
const PARAM_DESCRIPTION =
	typeof successCriteriaSchema.description === "string" ? successCriteriaSchema.description : "";

// ── 第 2 层切片：工具 description 模板字面量（"description: `" 到闭合反引号）──

const TOOL_DESCRIPTION = sliceBetween(ADAPTER_SRC, "description: `", "`");
// create 段：从 "- create：" 行首到 "- complete：" 行首（同在 description 块内）
const TOOL_DESCRIPTION_CREATE_SEGMENT = sliceBetween(TOOL_DESCRIPTION, "- create：", "- complete：");

// ── 第 3 层切片：promptGuidelines 赋值块 ─────────────────────
// 闭合 "]" 不能用 indexOf 找——块内 guideline 文本自身含 "string[]" 的 "]"，
// 故按行扫描 trim() === "]," 的行作块尾（缩进无关）。

function extractPromptGuidelinesBlock(src: string): string {
	const startMarker = "promptGuidelines: [";
	const start = src.indexOf(startMarker);
	if (start === -1) {
		throw new Error(`start marker not found in goal-control-adapter.ts: ${startMarker}`);
	}
	const blockLines: string[] = [];
	for (const line of src.slice(start).split("\n")) {
		blockLines.push(line);
		if (line.trim() === "],") return blockLines.join("\n");
	}
	throw new Error('promptGuidelines block closing "]," line not found in goal-control-adapter.ts');
}

const PROMPT_GUIDELINES_BLOCK = extractPromptGuidelinesBlock(ADAPTER_SRC);
// create 条目：块内以 `"create:` 开头的单行 guideline（源码中每条 guideline 独占一行）
const CREATE_GUIDELINE_LINE = PROMPT_GUIDELINES_BLOCK.split("\n").find((line) =>
	line.trim().startsWith('"create:'),
);
if (CREATE_GUIDELINE_LINE === undefined) {
	throw new Error('create guideline line not found in promptGuidelines block of goal-control-adapter.ts');
}

// ── 第 1 层：successCriteria 参数 schema description ─────────

describe("第 1 层：successCriteria 参数 schema description（粒度约束）", () => {
	it("schema 结构为 string[]（type: array + items type: string）", () => {
		expect(successCriteriaSchema.type).toBe("array");
		expect(successCriteriaSchema.items.type).toBe("string");
	});

	it("description 含条数区间语义（1~8 条，与 minItems/maxItems 对齐）", () => {
		expect(PARAM_DESCRIPTION).toMatch(/1~8\s*条/);
	});

	it("description 含每条单行短条件语义", () => {
		expect(PARAM_DESCRIPTION).toContain("单行");
	});

	it("description 含数组语义（完成条件数组）", () => {
		expect(PARAM_DESCRIPTION).toContain("完成条件数组");
	});

	it("description 含高层终态条件语义（非愿景、非细粒度清单）", () => {
		expect(PARAM_DESCRIPTION).toContain("高层终态条件");
		expect(PARAM_DESCRIPTION).toContain("不是愿景");
	});

	it("description 含只引用不复制 + 禁止倾倒完整规格语义", () => {
		expect(PARAM_DESCRIPTION).toContain("细粒度检查清单放 todo/plan");
		expect(PARAM_DESCRIPTION).toContain("只引用不复制");
		expect(PARAM_DESCRIPTION).toContain("禁止倾倒完整规格");
	});
});

// ── 第 2 层：工具 description create 段 ─────────────────────

describe("第 2 层：工具 description create 段（粒度约束）", () => {
	it("create 段含 successCriteria 条数约束（3~8 条高层终态条件）", () => {
		expect(TOOL_DESCRIPTION_CREATE_SEGMENT).toContain("successCriteria");
		expect(TOOL_DESCRIPTION_CREATE_SEGMENT).toMatch(/3~8\s*条/);
		expect(TOOL_DESCRIPTION_CREATE_SEGMENT).toContain("高层终态条件");
	});

	it("create 段含细粒度清单只引用不复制语义", () => {
		expect(TOOL_DESCRIPTION_CREATE_SEGMENT).toContain("细粒度检查清单放 todo/plan");
		expect(TOOL_DESCRIPTION_CREATE_SEGMENT).toContain("只引用不复制");
	});

	it("create 段含禁止倾倒完整规格语义", () => {
		expect(TOOL_DESCRIPTION_CREATE_SEGMENT).toContain("禁止倾倒完整规格");
	});
});

// ── 第 3 层：promptGuidelines create 条目 ────────────────────

describe("第 3 层：promptGuidelines create 条目（粒度约束）", () => {
	it("create 条目含 3~8 条高层终态条件 + string[] 语义", () => {
		expect(CREATE_GUIDELINE_LINE).toMatch(/3~8 high-level terminal conditions as string\[\]/);
	});

	it("create 条目含细粒度清单只引用不复制语义（reference, do not copy）", () => {
		expect(CREATE_GUIDELINE_LINE).toContain("Fine-grained checklists belong in todo/plan");
		expect(CREATE_GUIDELINE_LINE).toContain("reference them, do not copy");
	});

	it("create 条目含禁止倾倒完整规格语义（Do NOT dump full specs）", () => {
		expect(CREATE_GUIDELINE_LINE).toContain("Do NOT dump full specs into successCriteria");
	});
});
