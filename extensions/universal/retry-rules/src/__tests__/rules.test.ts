/**
 * 判定管线镜像锁定测试（复制体行为 SSOT = packages/shared/src/retry-rules.ts）。
 *
 * 用例与 shared src/__tests__/retry-rules.test.ts 同款对拍（两层序 / 双匹配通道 /
 * ReDoS 运行时防护 / 改写标记追加式幂等）——两侧断言同时漂移时以 shared 侧红为先，
 * 本文件锁复制体未跟随漂移。
 */
import { describe, expect, it } from "vitest";

import {
	appendRetryMarker,
	evaluateRetryRules,
	extractJsonSegment,
	matchRetryRule,
	RETRY_REWRITE_MARKER,
	RETRY_REWRITE_MARKER_PREFIX,
	type RetryableErrorRule,
} from "../rules.ts";

function rule(overrides: Partial<RetryableErrorRule>): RetryableErrorRule {
	return {
		id: "test-rule",
		name: "测试规则",
		verdict: "retryable",
		match: [{ kind: "pattern", pattern: "rate limit" }],
		class: "provider",
		source: "builtin",
		...overrides,
	};
}

describe("两层序判定管线", () => {
	const zhipu1302 = rule({
		id: "zhipu-1302",
		verdict: "retryable",
		match: [{ kind: "jsonPath", path: "error.code", operator: "equals", value: "1302" }],
	});
	const zhipuAccount = rule({
		id: "zhipu-account",
		verdict: "non_retryable",
		match: [{ kind: "pattern", pattern: '"code"\\s*:\\s*"?(?:1113|1309)"?' }],
	});
	const windowLimit = rule({
		id: "zhipu-window",
		verdict: "conditional",
		match: [{ kind: "pattern", pattern: '"code"\\s*:\\s*"?(?:1310)"?' }],
	});
	const customRetryable = rule({ id: "custom-a", verdict: "retryable", source: "custom", match: [{ kind: "pattern", pattern: "custom-marker" }] });

	it("命中 retryable 规则 → rewrite（探针实测限流文本形态）", () => {
		expect(evaluateRetryRules("membership rpm limit exceeded: 101/100 resets 2026-10-23T12:00:00.000Z", [
			rule({ id: "rpm", match: [{ kind: "pattern", pattern: "rpm limit exceeded" }] }),
		])).toEqual({ action: "rewrite" });
		expect(evaluateRetryRules('429: {"error":{"code":"1302"}}', [zhipu1302])).toEqual({ action: "rewrite" });
	});

	it("第一层排除：non_retryable 命中优先于 source 更靠前的 retryable", () => {
		const userRetryAll = rule({ id: "user-all", verdict: "retryable", source: "custom", match: [{ kind: "pattern", pattern: "429" }] });
		expect(evaluateRetryRules('429: {"error":{"code":"1113"}}', [userRetryAll, zhipuAccount])).toEqual({
			action: "keep",
			reason: "non_retryable_hit",
		});
	});

	it("conditional 命中不改写", () => {
		expect(evaluateRetryRules('429: {"error":{"code":"1310"}}', [zhipu1302, windowLimit])).toEqual({
			action: "keep",
			reason: "conditional_hit",
		});
	});

	it("第二层 source 序 custom > remote > builtin，命中即断", () => {
		const message = "error: custom-marker";
		const remote = rule({ id: "remote-a", verdict: "retryable", source: "remote", match: [{ kind: "pattern", pattern: "custom-marker" }] });
		const builtin = rule({ id: "builtin-a", verdict: "conditional", source: "builtin", match: [{ kind: "pattern", pattern: "custom-marker" }] });
		expect(evaluateRetryRules(message, [builtin, remote, customRetryable])).toEqual({ action: "rewrite" });
		expect(evaluateRetryRules(message, [builtin, remote])).toEqual({ action: "rewrite" });
		expect(evaluateRetryRules(message, [builtin])).toEqual({ action: "keep", reason: "conditional_hit" });
	});

	it("无命中不改写（pi 原生词表兜底）；空文本不判定", () => {
		expect(evaluateRetryRules("some unknown error", [zhipu1302])).toEqual({ action: "keep", reason: "no_rule_match" });
		expect(evaluateRetryRules("  ", [customRetryable])).toEqual({ action: "keep", reason: "empty_message" });
	});

	it("jsonPath exists 通道：body 缺键不命中、有键命中", () => {
		const existsRule = rule({ match: [{ kind: "jsonPath", path: "error.code", operator: "exists" }] });
		expect(evaluateRetryRules('400: {"error":{"code":"x"}}', [existsRule]).action).toBe("rewrite");
		expect(evaluateRetryRules('400: {"error":{"message":"no code"}}', [existsRule])).toEqual({
			action: "keep",
			reason: "no_rule_match",
		});
	});

	it("AND 语义：多条件全命中才命中", () => {
		const multi = rule({
			match: [
				{ kind: "pattern", pattern: "rate" },
				{ kind: "pattern", pattern: "absent-marker" },
			],
		});
		expect(matchRetryRule("rate limit hit", multi)).toBe(false);
		expect(matchRetryRule("rate limit + absent-marker", multi)).toBe(true);
	});
});

describe("JSON 片段平衡提取（复制体）", () => {
	it("status 前缀 + body JSON 提取 body 段；字符串内括号不参与计数", () => {
		expect(extractJsonSegment('429: {"error":{"code":"1302"}}')).toBe('{"error":{"code":"1302"}}');
		expect(extractJsonSegment('400: {"m":"bad {brace}"} tail')).toBe('{"m":"bad {brace}"}');
		expect(extractJsonSegment("no json here")).toBeNull();
		expect(extractJsonSegment('400: {"unclosed":')).toBeNull();
	});
});

describe("改写标记（追加式 + 幂等 + 原文保留）", () => {
	it("追加标记保留原文", () => {
		const original = "membership rpm limit exceeded: 101/100 resets 2026-10-23T12:00:00.000Z";
		const rewritten = appendRetryMarker(original);
		expect(rewritten.startsWith(original)).toBe(true);
		expect(rewritten).toBe(`${original}${RETRY_REWRITE_MARKER}`);
	});

	it("已带标记原样返回（幂等）", () => {
		const once = appendRetryMarker("boom");
		expect(appendRetryMarker(once)).toBe(once);
		expect(once).toContain(RETRY_REWRITE_MARKER_PREFIX);
	});

	it("锚文本命中 pi-ai RETRYABLE 词表且不触 NON_RETRYABLE 词表（node_modules 1.0.0 实装词表字面核对）", () => {
		// pi-ai dist/utils/retry.js 1.0.0：RETRYABLE = /overloaded|currently experiencing high
		// demand|rate.?limit|too many requests|429|500|502|.../i；NON_RETRYABLE = /GoUsageLimitError|
		// FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|
		// out of budget|quota exceeded|billing|subscription_sharing_usage_limit_exceeded/i
		const marker = RETRY_REWRITE_MARKER;
		expect(/rate.?limit|too many requests|429/i.test(marker)).toBe(true);
		const nonRetryable = /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing|subscription_sharing_usage_limit_exceeded/i;
		expect(nonRetryable.test(marker)).toBe(false);
	});
});
