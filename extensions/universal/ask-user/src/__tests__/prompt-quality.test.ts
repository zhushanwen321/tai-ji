// src/__tests__/prompt-quality.test.ts
//
// 提示词质量回归：ask_user tool 的 description 与 validate.ts 文案必须能让弱模型
// 首次调用就用对参数形状，用错了也能拿到带 Correct 正例的纠正。
//
// 背景（系统性债务）：
//  - description 缺 JSON 正例：弱模型最高频错误是把 options 当字符串数组传
//    （"options":["A","B"] 而非 [{"label","description"}]）。
//  - 条件必填（header）用 Type.Optional 表达，弱模型批量时漏 header。
//  - schema 层 ajv 干报错先于 validate.ts 友好文案——故 InputSchema 故意放宽 options
//    元素到 string，让误用能抵达 validateInput 的带正例纠正。
//
// 本测试用源码断言（读 .ts 文件文本）锁定这些约束，防止后续重构把正例/反例/调用信号
// 删掉或弱化。读源码而非 import，避免 mock 链（index.ts 依赖 pi-tui/ExtensionAPI 等）。

import { readFileSync } from "node:fs";
import { dirname,join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));

const INDEX_SRC = readFileSync(join(__dirname, "../index.ts"), "utf-8");
const VALIDATE_SRC = readFileSync(join(__dirname, "../validate.ts"), "utf-8");

/** 提取 description: `...` 模板字符串的原始内容（模板内无反引号，匹配到闭合 `,）。 */
function extractDescription(src: string): string {
	const m = src.match(/description:\s*`([\s\S]*?)`,/);
	if (!m) throw new Error("description template literal not found in index.ts");
	return m[1];
}

const DESCRIPTION = extractDescription(INDEX_SRC);

describe("ask_user description — 参数形状正例（B. 补正例）", () => {
	it("含单问题 JSON 正例，options 为 {label, description} 对象数组", () => {
		// 弱模型最高频错误是把 options 当字符串数组传；正例必须显式给出对象形态。
		expect(DESCRIPTION).toContain('"options":[{"label"');
		expect(DESCRIPTION).toContain('"question"');
	});

	it("含批量 JSON 正例，每个 question 带 header", () => {
		// 批量模式下 header 是条件必填，正例必须展示 header 字段。
		expect(DESCRIPTION).toContain('"header"');
		// 批量正例含多个 question（questions 数组里至少两个 header）
		const headerMatches = DESCRIPTION.match(/"header"/g) || [];
		expect(headerMatches.length).toBeGreaterThanOrEqual(2);
	});

	it("正例里的 label 可带 (Recommended) 前缀（调用信号未被破坏）", () => {
		expect(DESCRIPTION).toContain("(Recommended)");
	});
});

describe("ask_user description — 参数结构反例（B. 补反例）", () => {
	it("含 ≥2 条参数结构反例（string array / flatten / Other 等）", () => {
		// 锁定关键反例措辞，防止后续精简掉。
		const antiPatterns = [
			"string array", // options 不能当字符串数组传
			"Flatten", // 不能把字段铺到顶层（匹配 Flattening/Flatten）
			"Other", // 不能手动加 Other
		];
		const hits = antiPatterns.filter((p) => DESCRIPTION.includes(p));
		expect(hits.length).toBeGreaterThanOrEqual(2);
	});
});

describe("ask_user description — 调用信号保留（不要破坏亮点）", () => {
	it("保留 'Use ONLY when ALL hold' 调用门槛", () => {
		// 这是 ask_user 写得比 subagent 原版好的调用信号引导，必须保留。
		expect(DESCRIPTION).toContain("Use ONLY when");
	});

	it("保留 'Do NOT use' 边界段", () => {
		expect(DESCRIPTION).toContain("Do NOT use");
	});
});

describe("validate.ts — runtime 友好纠错（A. 带正例）", () => {
	it("含 options 字符串元素检测（'objects, not strings'）", () => {
		// schema 层已放宽让 string options 进到这里；validate 必须友好拦截。
		expect(VALIDATE_SRC).toContain("objects, not strings");
	});

	it("options 字符串错误带 Correct 正例", () => {
		// 友好文案必须给出最小可用形状，让弱模型直接抄。
		expect(VALIDATE_SRC).toContain('Correct: "options":[{"label"');
	});

	it("header 缺失错误带 Correct 正例", () => {
		// 多问题模式漏 header 是弱模型批量时的常见错误，纠正文案要带正例。
		expect(VALIDATE_SRC).toContain("Correct: {\"header\"");
	});
});
