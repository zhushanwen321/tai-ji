// 提示词质量回归：goal_control tool 声明按 D1 三层分工单源化后（设计
// tool-declaration-slimming.md §3.3 D1），本测试锁定单源分布——
// - description：功能定位 + action 枚举 + 控制权归属（不再复述各 action 触发纪律
//   与预算策略——纪律单源在 promptGuidelines，字段语义单源在 schema 字段说明）
// - promptGuidelines：使用纪律唯一承载位（create/complete/report_blocked 何时调用、
//   budget 何时可设）
// - runtime 错误文案：'Correct:' 纠正正例（schema 为扁平 Type.Object + action 字段级
//   union，字段全部 Optional——缺失必填由 handler 运行时校验兜底）
//
// 本测试用源码断言（读 .ts 文件文本）锁定这些约束，防止后续重构把单源分布改回
// 多层复述、或把纠错文案删掉。读源码而非 import，避免 mock 链（goal-control-adapter.ts
// 依赖 pi-ai/typebox/pi-tui/ExtensionAPI 等值导入）。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTER_SRC = readFileSync(
	join(__dirname, "../adapters/goal-control-adapter.ts"),
	"utf-8",
);

/** 提取 description: `...` 模板字符串的原始内容。 */
function extractDescription(src: string): string {
	const m = src.match(/description:\s*`([\s\S]*?)`/);
	if (!m) throw new Error("description template literal not found");
	return m[1];
}

const DESCRIPTION = extractDescription(ADAPTER_SRC);

describe("goal_control description — 功能定位 + action 枚举 + 控制权归属", () => {
	it("含管理目标总述 + 三动作枚举（create/complete/report_blocked）", () => {
		expect(DESCRIPTION).toContain("管理当前会话的目标");
		expect(DESCRIPTION).toContain("create（创建）| complete（完成）| report_blocked（阻塞报告）");
	});

	it("含 pause-resume-budget 归用户 + 报告最终 token 用量", () => {
		expect(DESCRIPTION).toContain("pause/resume 和 budget 变更由用户经 /goal 命令控制");
		expect(DESCRIPTION).toContain("报告最终 token 用量");
	});

	it("不含 Examples JSON 正例段 + 不含 Don't 段", () => {
		// Examples 段已删，description 不再含裸 JSON 正例
		expect(DESCRIPTION).not.toContain('{"action":"create"');
		expect(DESCRIPTION).not.toMatch(/Don't/);
	});
});

describe("goal_control description — D1 单源化（不复述纪律与字段语义）", () => {
	it("不再复述各 action 触发纪律（纪律单源在 promptGuidelines）", () => {
		// create/complete/report_blocked 的触发条件只在 guidelines；
		// 完成门槛（successCriteria 逐条满足）只在 schema successCriteria 说明
		expect(DESCRIPTION).not.toContain("琐碎的单步任务");
		expect(DESCRIPTION).not.toContain("仅在穷尽替代方案后使用");
		expect(DESCRIPTION).not.toContain("满足每条 successCriteria 条件");
	});

	it("不再复述预算策略段（budget 纪律单源在 promptGuidelines）", () => {
		expect(DESCRIPTION).not.toContain("默认不设 tokenBudget");
		expect(DESCRIPTION).not.toContain("切勿自行决定");
	});
});

describe("goal_control promptGuidelines — 使用纪律唯一承载位（锚词保留清单）", () => {
	it("含 promptGuidelines 字段 + create 主动触发纪律（复杂多步骤才建 + 已有目标不建）", () => {
		expect(ADAPTER_SRC).toMatch(/promptGuidelines:\s*\[/);
		expect(ADAPTER_SRC).toMatch(
			/create: proactively start a goal for complex, multi-step work/s,
		);
		expect(ADAPTER_SRC).toContain("/goal resume or /goal clear");
	});

	it("含 complete 主动触发纪律（objective 实际达成 + evidence 对照每条 successCriteria）", () => {
		expect(ADAPTER_SRC).toMatch(/complete:.*proactively call.*objective is actually achieved/s);
		expect(ADAPTER_SRC).toContain("Evidence must meet every successCriteria condition");
	});

	it("含 report_blocked 主动触发纪律（穷尽方案 + 不反复报告）", () => {
		expect(ADAPTER_SRC).toMatch(/report_blocked:.*proactively call.*≥3 distinct alternative approaches/s);
		expect(ADAPTER_SRC).toContain("do not repeatedly report the same blocker");
	});
});

describe("goal_control schema — 扁平 Type.Object（OpenAI 兼容）+ handler 运行时校验", () => {
	it("字段级 Type.Union + additionalProperties:false + 无 timeBudgetMinutes", () => {
		expect(ADAPTER_SRC).toMatch(/Type\.Union\(/);
		expect(ADAPTER_SRC).toContain("additionalProperties: false");
		expect(ADAPTER_SRC).not.toMatch(/timeBudgetMinutes/);
	});
});

describe("goal_control runtime 错误文案 — 含 'Correct:' 纠正正例", () => {
	it("≥4 处 'Correct:'（4 条空串 throw 各一带正例）+ objective/evidence 报错带正例", () => {
		// objective/successCriteria/evidence/reason 四条空串 throw 各应带完整 JSON 正例，
		// 让弱模型在报错后无需猜测即可纠正。读整份源码统计出现次数。
		const matches = ADAPTER_SRC.match(/Correct:/g) || [];
		expect(matches.length).toBeGreaterThanOrEqual(4);
		expect(ADAPTER_SRC).toMatch(/'objective' must not be empty[\s\S]*?Correct:/);
		expect(ADAPTER_SRC).toMatch(/'evidence' must not be empty[\s\S]*?Correct:/);
	});
});

describe("goal_control 描述修正（A1/slug optional）", () => {
	it("无 'at least 3 approaches' + reason throw 含 'what you tried' + slug 真 optional", () => {
		// A1: reason schema desc/throw 已删强制 ≥3 声明
		expect(ADAPTER_SRC).not.toMatch(/at least 3 approaches/);
		expect(ADAPTER_SRC).toMatch(/'reason' must not be empty[\s\S]*?what you tried/);
		expect(ADAPTER_SRC).toContain("可选。");
		expect(ADAPTER_SRC).not.toMatch(/'slug' is required/);
	});
});

describe("goal_control budget 纪律单源化（S-8 替换：三层冗余锁 → 单源分布锁）", () => {
	// D1 单源化后预算策略纪律只在 promptGuidelines 一处；description 与 tokenBudget
	// 参数说明不再复述纪律（schema 只留字段语义「默认不设」+ 指引）。
	// 任一层回填复述 = 违反单源化，本组负断言红灯。
	it("promptGuidelines budget 条含纪律锚词（never set on own initiative + 先问用户）", () => {
		expect(ADAPTER_SRC).toContain("never set tokenBudget on your own initiative");
		expect(ADAPTER_SRC).toContain("ask the user before creating the goal");
	});

	it("description 不含预算策略段（不复述）", () => {
		expect(DESCRIPTION).not.toContain("仅在用户明确要求");
		expect(DESCRIPTION).not.toContain("获得明确同意");
	});

	it("tokenBudget 参数 description 只留字段语义（默认不设 + 指引，不含纪律复述）", () => {
		expect(ADAPTER_SRC).toMatch(/tokenBudget:[\s\S]*?默认不设/);
		expect(ADAPTER_SRC).not.toMatch(/tokenBudget:[\s\S]*?切勿自行决定设置预算/);
	});
});
