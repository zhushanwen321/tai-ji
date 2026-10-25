// src/__tests__/retry-rules-validation-parity.test.ts
//
// [subagent-observability §3.3.12] retry-rules 校验通道跨包对拍：
// 判定语义 SSOT = @taiji/shared validateRetryRuleFields（runtime 写侧落盘校验 +
// settings 表单校验 + 远程域 guard 共用），本扩展 config.ts 持自包含复制体
// （bundle 不 import shared 运行时代码），供 ext-config 读侧 guard / normalize 使用。
// 镜像实现跨包不可 import、漂移无编译红——本测试用同一规则输入矩阵断言两侧
// validateRetryRuleFields ok 与错误同判（含错误文案逐字一致）。漂移后果链真实：
// 远程通道热更新经 shared 校验放行的规则若与扩展复制体分叉，扩展读侧
// isRetryRulesExtConfig 整份回落空集 = 全部重试规则失效。
//
// 登记的有意差异面（非漂移，但分叉形态变化即红）：source 校验边界——shared 侧
// validateRetryRuleFields 是组装前校验（settings 固定写 custom / 远程读侧归一
// remote，source 由组装方填，shared retry-rules.ts 头注同款注释），不校验 source；
// 扩展侧校验组装后落盘形态，source 必填且 ∈ custom/remote/builtin。
//
// RETRY_RULES_BASELINE 是 ext-config effectiveRules 的恒在场成分（runtime 合并权威
// 以基线为 ⊕ 底座），任一条过不了扩展读侧 guard = 整份回落空集、默认面全失效，
// 故基线全量两侧同判 + 整体过扩展 guard 一并锁定。
//
// @taiji/shared 仅测试面消费（devDependencies + workspace 源直引，bundle 自包含不受影响）。

import { describe, expect, it } from "vitest";

import {
	RETRY_RULES_BASELINE,
	validateRetryRuleFields as sharedValidateRetryRuleFields,
} from "@taiji/shared";

import {
	HTTP_STATUS_CLASS_MAX,
	HTTP_STATUS_CLASS_MIN,
	ID_MAX_LEN,
	isRetryRulesExtConfig,
	JSON_PATH_MAX_LEN,
	MATCH_COUNT_MAX,
	NAME_MAX_LEN,
	PATTERN_MAX_LEN,
	validateRetryRuleFields,
	WAIT_HINT_MAX_LEN,
} from "../config.ts";

/** 组装后合法形态基座（source 在场——扩展读侧与 shared 两侧同判的形态）。 */
const VALID_BASE: Record<string, unknown> = {
	id: "parity-valid",
	name: "对拍合法基线规则",
	verdict: "retryable",
	match: [{ kind: "pattern", pattern: "parity hit" }],
	class: "provider",
	source: "custom",
};

/** 合法基座 + 覆盖字段（每次新对象，矩阵条目间无共享可变状态）。 */
function assembled(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { ...VALID_BASE, ...overrides };
}

/**
 * 单输入双侧对拍：同一规则喂两侧 validateRetryRuleFields，断言
 * ① ok 同判；② 都拒绝时错误清单逐字一致（文案镜像：错误 → 修复动作闭环两侧同源）。
 */
function expectSameValidation(rule: unknown): void {
	const sharedResult = sharedValidateRetryRuleFields(rule);
	const extResult = validateRetryRuleFields(rule);
	expect(extResult.ok).toBe(sharedResult.ok);
	if (!sharedResult.ok && !extResult.ok) {
		expect(extResult.errors).toEqual(sharedResult.errors);
	}
}

// ============================================================
// 组装后形态矩阵：字段边界 / 词表外 / 危险正则 / 双通道 / 非对象
// ============================================================

const PARITY_MATRIX: { label: string; rule: unknown }[] = [
	// ── 合法形态 ──
	{ label: "合法最简字段", rule: assembled() },
	{
		label: "合法全字段（kind / httpStatusClass / waitHint 在场）",
		rule: assembled({ kind: "rate_limited", httpStatusClass: 429, waitHint: "窗口重置后可重试" }),
	},
	{ label: "id 恰好上限（边界内）", rule: assembled({ id: "a".repeat(ID_MAX_LEN) }) },
	{ label: "name 恰好上限（边界内）", rule: assembled({ name: "名".repeat(NAME_MAX_LEN) }) },
	{ label: "pattern 恰好上限（边界内）", rule: assembled({ match: [{ kind: "pattern", pattern: "a".repeat(PATTERN_MAX_LEN) }] }) },
	{
		label: "jsonPath path 恰好上限 + exists 无 value（边界内）",
		rule: assembled({ match: [{ kind: "jsonPath", path: "a".repeat(JSON_PATH_MAX_LEN), operator: "exists" }] }),
	},
	{ label: "httpStatusClass 下边界（边界内）", rule: assembled({ httpStatusClass: HTTP_STATUS_CLASS_MIN }) },
	{ label: "httpStatusClass 上边界（边界内）", rule: assembled({ httpStatusClass: HTTP_STATUS_CLASS_MAX }) },
	{
		label: "match 条数恰好上限（边界内）",
		rule: assembled({ match: Array.from({ length: MATCH_COUNT_MAX }, (_, i) => ({ kind: "pattern", pattern: `m${i}` })) }),
	},
	{ label: "kind engine_ 前缀开放面（合法）", rule: assembled({ class: "engine", kind: "engine_aborted" }) },
	{ label: "kind 显式 undefined（可选字段缺席）", rule: assembled({ kind: undefined }) },
	// ── 非对象输入 ──
	{ label: "非对象：null", rule: null },
	{ label: "非对象：数组", rule: [VALID_BASE] },
	{ label: "非对象：字符串", rule: "parity" },
	// ── 头字段边界与词表 ──
	{ label: "id 超上限", rule: assembled({ id: "a".repeat(ID_MAX_LEN + 1) }) },
	{ label: "id 含空白", rule: assembled({ id: "parity valid" }) },
	{ label: "name 超上限", rule: assembled({ name: "名".repeat(NAME_MAX_LEN + 1) }) },
	{ label: "verdict 词表外", rule: assembled({ verdict: "non-retryable" }) },
	{ label: "class 缺失", rule: assembled({ class: undefined }) },
	{ label: "kind 词表外（provider 类装 harness 值）", rule: assembled({ kind: "turn_budget_exhausted" }) },
	{ label: "kind 非字符串", rule: assembled({ kind: 42 }) },
	{ label: "engine 类 kind 缺前缀", rule: assembled({ class: "engine", kind: "aborted" }) },
	// ── pattern 通道 ──
	{ label: "危险正则：嵌套量词", rule: assembled({ match: [{ kind: "pattern", pattern: "(.+)*x" }] }) },
	{ label: "危险正则：相邻区间量词", rule: assembled({ match: [{ kind: "pattern", pattern: "a{2,3}{4}" }] }) },
	{ label: "正则语法无效", rule: assembled({ match: [{ kind: "pattern", pattern: "([unclosed" }] }) },
	{ label: "pattern 超上限", rule: assembled({ match: [{ kind: "pattern", pattern: "a".repeat(PATTERN_MAX_LEN + 1) }] }) },
	// ── jsonPath 通道 ──
	{ label: "jsonPath path 含空白", rule: assembled({ match: [{ kind: "jsonPath", path: "error code", operator: "equals", value: "1" }] }) },
	{ label: "jsonPath operator 词表外", rule: assembled({ match: [{ kind: "jsonPath", path: "error.code", operator: "matches", value: "1" }] }) },
	{ label: "jsonPath equals 缺比较值", rule: assembled({ match: [{ kind: "jsonPath", path: "error.code", operator: "equals" }] }) },
	{ label: "jsonPath match 条目非对象", rule: assembled({ match: [{ kind: "pattern" }, "not-an-object"] }) },
	// ── match 清单形状 ──
	{ label: "match 非列表", rule: assembled({ match: "parity" }) },
	{ label: "match 空列表", rule: assembled({ match: [] }) },
	{ label: "match 超条数上限", rule: assembled({ match: Array.from({ length: MATCH_COUNT_MAX + 1 }, (_, i) => ({ kind: "pattern", pattern: `m${i}` })) }) },
	// ── 可选字段边界 ──
	{ label: "httpStatusClass 低于区间", rule: assembled({ httpStatusClass: HTTP_STATUS_CLASS_MIN - 1 }) },
	{ label: "httpStatusClass 高于区间", rule: assembled({ httpStatusClass: HTTP_STATUS_CLASS_MAX + 1 }) },
	{ label: "httpStatusClass 非整数", rule: assembled({ httpStatusClass: 42.5 }) },
	{ label: "waitHint 超上限", rule: assembled({ waitHint: "等".repeat(WAIT_HINT_MAX_LEN + 1) }) },
];

describe("校验通道对拍：同一规则输入矩阵两侧 validateRetryRuleFields 同判", () => {
	it("矩阵逐条：ok 同判，拒绝时错误清单逐字一致", () => {
		for (const entry of PARITY_MATRIX) {
			expectSameValidation(entry.rule);
		}
	});

	it("矩阵覆盖面自检（合法/非法齐备 + 错误关键域各至少一条——防矩阵退化为单结论空转）", () => {
		const results = PARITY_MATRIX.map((entry) => sharedValidateRetryRuleFields(entry.rule));
		expect(results.some((r) => r.ok)).toBe(true);
		expect(results.some((r) => !r.ok)).toBe(true);
		const allErrors = results.flatMap((r) => (r.ok ? [] : r.errors)).join("\n");
		for (const keyword of [
			"规则 ID",
			"规则名称",
			"裁决",
			"失败分类",
			"kind",
			"嵌套量词",
			"（正则）",
			"匹配条件",
			"JSON 路径",
			"HTTP 状态大类",
			"等待提示",
		]) {
			expect(allErrors).toContain(keyword);
		}
	});
});

// ============================================================
// 登记的有意差异面：source 校验边界（组装前 vs 组装后）
// ============================================================

describe("source 校验边界（登记的有意差异面，分叉形态变化即红）", () => {
	it("source 缺失（组装前形态）：shared 放行 / 扩展拒绝且错误指向 source", () => {
		const { source: _source, ...beforeAssembly } = assembled();
		const sharedResult = sharedValidateRetryRuleFields(beforeAssembly);
		const extResult = validateRetryRuleFields(beforeAssembly);
		expect(sharedResult.ok).toBe(true);
		expect(extResult.ok).toBe(false);
		if (!extResult.ok) {
			expect(extResult.errors).toHaveLength(1);
			expect(extResult.errors[0]).toContain("source");
		}
	});

	it("source 词表外：shared 不校验 source / 扩展拒绝且错误含词表清单", () => {
		const sharedResult = sharedValidateRetryRuleFields(assembled({ source: "bogus" }));
		const extResult = validateRetryRuleFields(assembled({ source: "bogus" }));
		expect(sharedResult.ok).toBe(true);
		expect(extResult.ok).toBe(false);
		if (!extResult.ok) {
			expect(extResult.errors[0]).toContain("custom / remote / builtin");
		}
	});
});

// ============================================================
// 基线对拍：RETRY_RULES_BASELINE 全量两侧同判 + 整体过扩展读侧 guard
// ============================================================

describe("RETRY_RULES_BASELINE 基线对拍（effectiveRules 恒在场成分，guard 失败 = 默认面全失效）", () => {
	it("全量基线逐条两侧同判合法（shared 组装前语义下基线本就带 source，两侧同 ok）", () => {
		expect(RETRY_RULES_BASELINE.length).toBeGreaterThan(0);
		for (const rule of RETRY_RULES_BASELINE) {
			expectSameValidation(rule);
		}
	});

	it("全量基线整体通过扩展读侧 guard isRetryRulesExtConfig（customRules 空 + effectiveRules = 基线）", () => {
		expect(
			isRetryRulesExtConfig({ version: 1, customRules: [], effectiveRules: [...RETRY_RULES_BASELINE] }),
		).toBe(true);
	});
});
