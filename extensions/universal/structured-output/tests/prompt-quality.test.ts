// 提示词质量回归（U1 重写：D1 双变体后口径锁定）：
//   - workflow 变体 description：单参数口径（"Your arguments ARE the data"）+ 静态失败
//     重试指引（§5.2 形态 a：参数层错误文案无扩展改写通道，指引前置携带）；
//     禁止 "pass ONLY `data`" 类双参数口径的矛盾文案（G3——矛盾在结构上不可能存在）
//   - 日常变体 description：envelope 结构一等公民教学保留（G4），workflow 语句已移除（D5）
//   - 运行时防御锁定：日常分支互换检测 + keyword-less 拒绝 + 错误回显不被重构删掉；
//     workflow 注册期防御（keyword-less / boolean true fail-fast）在 tool-definition 落位
//
// 读源码文本断言（参考 subagent-workflow 的 subagent-tool-prompt.test.ts），
// 避免 mock 链（index.ts 依赖 ajv/typebox/PiAPI 值导入）。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 文本断言横跨 6 个源文件（index+ajv-validator+schema-guards+execute+
// tool-definition+workflow-hook），按序拼接保证所有断言仍能命中——SCHEMA_KEYWORDS/
// recognized keyword 在 schema-guards.ts，两个变体 description 在 tool-definition.ts，
// Received schema=/echo(data) 在 execute.ts。
const SRC = [
  "src/index.ts",
  "src/ajv-validator.ts",
  "src/schema-guards.ts",
  "src/execute.ts",
  "src/tool-definition.ts",
  "src/workflow-hook.ts",
]
  .map((f) => readFileSync(join(__dirname, "../", f), "utf-8"))
  .join("\n");

/**
 * 提取指定工厂函数内 description 赋值的源码片段。
 *
 * description 在源码里是字符串拼接表达式（"..." + "..." + ...）。两个变体各自
 * 内联在 return 对象里：workflow 变体后随 parameters（简写或键值皆命中），
 * 日常变体后随 promptSnippet:。保留拼接字面量原文供子串断言——拼接表达式里的
 * 字面量文本会原样出现在捕获片段中。
 */
function extractDescription(src: string, factory: string, nextField: string): string {
	const m = src.match(
		new RegExp(`${factory}[\\s\\S]*?description:\\s*([\\s\\S]*?),\\s*${nextField}\\b`),
	);
	if (!m) throw new Error(`description assignment not found for ${factory} in src/tool-definition.ts`);
	return m[1]!;
}

const WORKFLOW_DESCRIPTION = extractDescription(SRC, "createWorkflowToolDefinition", "parameters");
const DAILY_DESCRIPTION = extractDescription(SRC, "createDailyToolDefinition", "promptSnippet");

// ── workflow 变体：单参数口径（G1/G3）──────────────────────

describe("workflow 变体 description — 单参数口径（G1/G3）", () => {
	it("核心句逐字锁定：arguments ARE the data + validated against this schema", () => {
		// D1 形态的自描述：模型读完即知参数就是 data，无需任何 envelope 教学。
		expect(WORKFLOW_DESCRIPTION).toContain("Return the structured result for this task");
		expect(WORKFLOW_DESCRIPTION).toContain("Your arguments ARE the data");
		expect(WORKFLOW_DESCRIPTION).toContain("they are validated against this schema");
	});

	it("指向工具 parameters 即 schema（模型只需看参数 schema）", () => {
		expect(WORKFLOW_DESCRIPTION).toMatch(/parameter schema/i);
	});

	it("含静态失败重试指引（§5.2 形态 a：指引前置携带，参数层错误无改写通道）", () => {
		expect(WORKFLOW_DESCRIPTION).toMatch(/validation fails/i);
		expect(WORKFLOW_DESCRIPTION).toMatch(/call the tool again|retry/i);
	});

	it("不含双参数口径矛盾文案（pass ONLY data / schema parameter is ignored / do NOT pass）", () => {
		// G3：新形态下矛盾在结构上不可能存在——描述里再出现旧口径本身就是回归。
		expect(WORKFLOW_DESCRIPTION).not.toMatch(/pass ONLY/i);
		expect(WORKFLOW_DESCRIPTION).not.toContain("parameter is ignored");
		expect(WORKFLOW_DESCRIPTION).not.toMatch(/do NOT pass/i);
	});

	it("不含 envelope 包装教学（单参数形态无 envelope 可教）", () => {
		expect(WORKFLOW_DESCRIPTION).not.toMatch(/envelope/i);
		expect(WORKFLOW_DESCRIPTION).not.toMatch(/swap/i);
	});

	it("要求调用工具而非文本输出", () => {
		expect(WORKFLOW_DESCRIPTION).toMatch(/Do not output the result as text/i);
	});

	it("steer reminder 同口径：workflow-hook 旧双参数文案不得回流", () => {
		// §7.4：steer reminder 也是模型可见提示词——旧口径（ONLY the `data` parameter /
		// do NOT pass your own `schema`）回流会与单参数工具形态矛盾，在 SRC（含
		// workflow-hook.ts）层面封死；单参数语汇与工具 description 同源。
		expect(SRC).not.toMatch(/ONLY the `data` parameter/);
		expect(SRC).not.toMatch(/do NOT pass/i);
		expect(SRC).not.toContain("`schema` parameter");
		expect(SRC).toContain("The required schema for your result is:");
		expect(SRC).toContain("Your arguments ARE the data");
	});
});

// ── 日常变体：envelope 教学保留（G4）+ workflow 语句移除（D5）──────────────

describe("日常变体 description — envelope 结构为一等公民（G4）", () => {
	it("含完整 envelope 正例（schema + data 配对，含真实 data 值）", () => {
		// 弱模型首次调用常把答案塞进 schema 或漏掉外层 envelope。
		// 一个带真实 data 值的完整调用正例是最强信号。
		expect(DAILY_DESCRIPTION).toMatch(/Correct \(full call\)/i);
		expect(DAILY_DESCRIPTION).toMatch(/data:\{name:'Alice'/);
	});

	it("声明 schema/data 必须配对匹配", () => {
		expect(DAILY_DESCRIPTION.toLowerCase()).toContain("must match");
	});

	it("覆盖 number 与 boolean 根类型正例", () => {
		// 现有覆盖 object/array/string-enum，补 number/boolean 防止模型
		// 误以为只能返回对象。
		expect(DAILY_DESCRIPTION).toMatch(/type:'number'/);
		expect(DAILY_DESCRIPTION).toMatch(/type:'boolean'/);
	});

	it("含结构层反例：漏 envelope（含 'envelope' 与 'Wrap'）", () => {
		expect(DAILY_DESCRIPTION.toLowerCase()).toContain("envelope");
		expect(DAILY_DESCRIPTION).toMatch(/wrap/i);
	});

	it("含结构层反例：schema/data 互换（含 'swap'）", () => {
		expect(DAILY_DESCRIPTION).toMatch(/swap/i);
	});

	it("含结构层反例：合并 schema 与 data", () => {
		expect(DAILY_DESCRIPTION.toLowerCase()).toContain("merging");
	});

	it("workflow 语句已移除（D5：workflow 语义只属于 workflow 变体）", () => {
		expect(DAILY_DESCRIPTION).not.toContain("workflow mode");
		expect(DAILY_DESCRIPTION).not.toMatch(/pass ONLY/i);
		expect(DAILY_DESCRIPTION).not.toMatch(/authoritative schema/i);
	});
});

// ── execute()/注册期 — 运行时防御锁定（防静默腐败）──────────────

describe("execute()/注册期 — 运行时防御锁定（防静默腐败）", () => {
	it("含互换检测（'swapped' 或 'recognized keyword'）", () => {
		// 互换检测是治静默腐败的最高优先守卫，不能被重构删掉。
		expect(SRC).toMatch(/swap|recognized keyword/i);
	});

	it("含 keyword-less schema 拒绝（validateSchema 加固）", () => {
		// ajv strict:false 会把 {} 编译成"接受一切"，必须显式拒绝。
		expect(SRC).toContain("recognized keyword");
	});

	it("含 schema keyword 识别清单（draft-07 keyword 检测）", () => {
		// 识别 keyword 的字符串数组是 keyword-less 拒绝的基础。
		// 至少要覆盖需求列出的核心 keyword。
		expect(SRC).toMatch(/SCHEMA_KEYWORDS/);
		for (const kw of ["type", "properties", "items", "enum", "required", "$ref", "anyOf", "oneOf", "allOf"]) {
			expect(SRC).toContain(`"${kw}"`);
		}
	});

	it("错误回显 schema/data（让模型看到自己传了什么）", () => {
		// 校验失败 + 编译失败 + 互换 + keyword-less 四类错误都应回显收到的 schema/data
		expect(SRC).toContain("Received schema=");
		expect(SRC).toContain("echo(data)");
	});

	it("workflow 注册期防御落位：keyword-less 拒绝 + boolean true 拦截在 createWorkflowToolDefinition fail-fast", () => {
		// U1 上移验证：两项防御必须在工厂函数内（加载期），不再散落在 execute 运行时路径。
		const factoryBody = SRC.match(
			/export function createWorkflowToolDefinition[\s\S]*?\n}\n/,
		);
		expect(factoryBody).not.toBeNull();
		expect(factoryBody![0]).toContain("hasSchemaKeyword");
		expect(factoryBody![0]).toContain("boolean true");
	});
});
