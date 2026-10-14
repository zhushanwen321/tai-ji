// 提示词质量回归：todo tool 的 description 与 runtime 纠错文案必须是
// "弱模型友好"的——条件必填字段（add 缺 texts、delete 缺 ids）在 handler 运行时校验
// （schema 扁平化后字段全 Optional，见 tool.ts 头注释），双形陷阱
// （text/texts、id/ids）的 throw 要带 Correct 纠错正例让模型自我纠正。
//
// D1 单源化（tool-declaration-slimming.md §3.3）后 description 只承载功能定位与
// 动作清单；原「规则：」段的五条使用纪律已迁入 promptGuidelines（唯一纪律承载位），
// 本测试同步把纪律断言锚到 guidelines 区。
//
// 本测试用源码文本断言锁定这些约束，防止后续重构把纠错文案删掉或弱化、或把纪律
// 回填进 description 造成双源。读源码而非 import，避免 mock 链（tool.ts 依赖
// typebox/ExtensionAPI/Theme 等值导入）。参考 subagent-workflow 的 prompt 回归范式。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOL_SRC = readFileSync(join(__dirname, "../tool.ts"), "utf-8");

/**
 * 提取 description 拼接区（从 `description:` 到下一个 `promptSnippet:`）。
 * tool.ts 的 description 用字符串拼接（非模板字面量），故整段截取后做子串断言。
 */
function extractDescriptionRegion(src: string): string {
	// 锚定到 registerTodoTool 内的 tool description，而非 schema 字段的 description:
	const regIdx = src.indexOf("registerTodoTool");
	if (regIdx === -1) throw new Error("registerTodoTool not found in tool.ts");
	const start = src.indexOf("description:", regIdx);
	if (start === -1) throw new Error("tool description: not found in registerTodoTool");
	const end = src.indexOf("promptSnippet:", start);
	if (end === -1) throw new Error("promptSnippet: not found in tool.ts");
	return src.slice(start, end);
}

const DESCRIPTION_REGION = extractDescriptionRegion(TOOL_SRC);

// ── description 中文版（T7/TC9；D1 单源化：定位 + 动作清单）──────────────

describe("todo description — 中文版（功能定位 + 动作清单）", () => {
	it("开篇是中文定位语", () => {
		expect(DESCRIPTION_REGION).toContain("管理当前会话的 todo 列表");
	});

	it("含「动作：」清单（list/add/update/delete 四动作）", () => {
		expect(DESCRIPTION_REGION).toContain("动作：");
		expect(DESCRIPTION_REGION).toContain("list: 查看全部 todo");
		expect(DESCRIPTION_REGION).toContain("add: 批量添加 todo");
		expect(DESCRIPTION_REGION).toContain("update: 按 id 更新 todo");
		expect(DESCRIPTION_REGION).toContain("delete: 按 id 删除 todo");
	});

	it("不含已删除的 clear 动作", () => {
		expect(DESCRIPTION_REGION).not.toMatch(/clear/i);
	});

	it("已删除旧英文 Examples 段与 Don't 段", () => {
		expect(DESCRIPTION_REGION).not.toContain("Available actions");
		expect(DESCRIPTION_REGION).not.toContain("Don't");
		expect(DESCRIPTION_REGION).not.toContain("Examples");
	});

	it("D1 单源化：description 不复述使用纪律（纪律单源在 promptGuidelines）", () => {
		expect(DESCRIPTION_REGION).not.toContain("规则：");
		expect(DESCRIPTION_REGION).not.toContain("同一时间只有一个 todo 处于 in_progress");
		expect(DESCRIPTION_REGION).not.toContain("立即标记 completed");
		expect(DESCRIPTION_REGION).not.toContain("不超过 10 个");
	});
});

// ── runtime throw 必须带 Correct 纠错正例 ───────────

describe("todo runtime — throw 含 Correct 纠错正例", () => {
	it("源码含 ≥4 处 Correct: 纠错文案（覆盖 add/delete/update 路径）", () => {
		// 每个 required throw 必须追加完整 JSON 正例，弱模型失败后能自我纠正。
		const matches = TOOL_SRC.match(/Correct:/g) || [];
		expect(matches.length).toBeGreaterThanOrEqual(4);
	});

	it('add 双形检测：含 singular "text" 纠错文案', () => {
		expect(TOOL_SRC).toContain('singular "text"');
		expect(TOOL_SRC).toContain('"text" — that field is for update');
	});

	it('delete 双形检测：含 singular "id" 纠错文案', () => {
		expect(TOOL_SRC).toContain('singular "id"');
		expect(TOOL_SRC).toContain('"id" — that field is for update');
	});
});

// ── promptSnippet / promptGuidelines（D1 单源化后的纪律承载位）──
// DESCRIPTION_REGION 截取止于 promptSnippet:，不含这两个字段，故对完整 TOOL_SRC 断言。

describe("todo tool prompt — snippet & guidelines（使用纪律唯一承载位）", () => {
	it("promptSnippet 为中文精简版（验证步骤引导）", () => {
		expect(TOOL_SRC).toContain("用 todo 跟踪多步骤工作");
		expect(TOOL_SRC).toContain("验证步骤");
	});

	it("promptGuidelines 含 [验证任务] 条目（完成前确保验证通过）", () => {
		expect(TOOL_SRC).toContain("[验证任务] 为测试 / 类型检查等验证步骤单独建 todo，完成前确保验证通过");
	});

	it("promptGuidelines 含 [自动闭合] / [批量优先] 核心条目", () => {
		expect(TOOL_SRC).toContain("[自动闭合] 旧任务全部 completed 后再 add 会自动清理旧列表");
		expect(TOOL_SRC).toContain("[批量优先] 完成多项任务时使用 updates[] 批量更新");
	});

	it("promptGuidelines 含 [规模控制] 条目（不超过 10 个）", () => {
		expect(TOOL_SRC).toContain("[规模控制] todo 总数建议不超过 10 个");
	});

	it("promptGuidelines 承接原 description 规则段的三条核心行为准则（迁移锚）", () => {
		expect(TOOL_SRC).toContain("同一时间只有一个 todo 处于 in_progress");
		expect(TOOL_SRC).toContain("立即标记 completed，不要攒到最后批量标记");
		expect(TOOL_SRC).toContain("未真正完成（被阻塞或测试失败）不得标记 completed");
	});
});
