// 提示词质量回归：goal_control tool description + runtime 错误文案必须是
// "可纠正的行为约束器"，而非干巴巴的错误。
//
// agent（LLM）唯一能看到的 tool 元信息就是 description + 报错文案。description 用中文
// 重写（动作 create/complete/report_blocked + 规则 + §2.5 终态语义），删除英文 Examples/Don't
// 段；runtime throw 保留 .trim() 空串校验 + 'Correct:' 纠正正例（schema 为扁平 Type.Object
// + action 字段级 union，字段全部 Optional——缺失必填由 handler 运行时校验兜底）。
//
// 本测试用源码断言（读 .ts 文件文本）锁定这些约束，防止后续重构把中文语义/纠错文案/
// union 结构删掉。读源码而非 import，避免 mock 链（goal-control-adapter.ts 依赖
// pi-ai/typebox/pi-tui/ExtensionAPI 等值导入）。

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

describe("goal_control description — 中文化 + 动作覆盖", () => {
	it("含管理目标总述 + complete 须满足每条 successCriteria 条件", () => {
		expect(DESCRIPTION).toContain("管理当前会话的目标");
		expect(DESCRIPTION).toContain("满足每条 successCriteria 条件");
	});
});

describe("goal_control description — §2.5 终态语义", () => {
	it("create 失败提示 / complete 报告 token / pause-resume-budget 归用户 / 不反复报告阻塞", () => {
		expect(DESCRIPTION).toContain("请让用户运行 /goal resume 或 /goal clear");
		expect(DESCRIPTION).toContain("报告最终 token 用量");
		expect(DESCRIPTION).toContain("pause/resume 和 budget 变更由用户经 /goal 命令控制");
		expect(DESCRIPTION).toContain("不要反复报告同一阻塞");
	});
});

describe("goal_control description — 删除 Examples/Don't 英文段", () => {
	it("不含 Examples JSON 正例段 + 不含 Don't 段", () => {
		// Examples 段已删，description 不再含裸 JSON 正例
		expect(DESCRIPTION).not.toContain('{"action":"create"');
		expect(DESCRIPTION).not.toMatch(/Don't/);
	});
});

describe("goal_control schema — 扁平 Type.Object（OpenAI 兼容）+ handler 运行时校验", () => {
	it("字段级 Type.Union + additionalProperties:false + 无 timeBudgetMinutes", () => {
		expect(ADAPTER_SRC).toMatch(/Type\.Union\(/);
		expect(ADAPTER_SRC).toContain("additionalProperties: false");
		expect(ADAPTER_SRC).not.toMatch(/timeBudgetMinutes/);
	});
});

describe("goal_control promptGuidelines — complete/report_blocked 主动触发引导", () => {
	it("含 promptGuidelines 字段 + complete/report_blocked 主动触发信号", () => {
		expect(ADAPTER_SRC).toMatch(/promptGuidelines:\s*\[/);
		expect(ADAPTER_SRC).toMatch(/complete:.*proactively call.*objective is actually achieved/s);
		expect(ADAPTER_SRC).toMatch(/report_blocked:.*proactively call.*≥3 distinct alternative approaches/s);
		expect(ADAPTER_SRC).toContain("do not repeatedly report the same blocker");
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

describe("goal_control budget 默认策略锁定（S-8：三层信号冗余，防回滚无声）", () => {
	// 新增的 budget-policy prompt 文本散落在三处（description 段 / promptGuidelines 项 /
	// tokenBudget 参数 description），任一处被回滚都应触发测试失败——这是 prompt-lock 的核心诉求。
	it("description 模板含中文 '默认不设 tokenBudget' 预算策略段", () => {
		expect(DESCRIPTION).toContain("默认不设 tokenBudget");
	});

	it("promptGuidelines budget 项含英文 'never set tokenBudget on your own initiative'", () => {
		expect(ADAPTER_SRC).toContain("never set tokenBudget on your own initiative");
	});

	it("tokenBudget 参数 description 含 '默认不设' + '切勿自行决定设置预算'", () => {
		// 参数 schema description 是第三层信号（与上面两层对齐，三层冗余，见 adapter 源码注释）
		expect(ADAPTER_SRC).toMatch(/tokenBudget:[\s\S]*?默认不设[\s\S]*?切勿自行决定设置预算/);
	});
});
