/**
 * 校验语义镜像测试（复制体 SSOT = packages/shared/src/retry-rules.ts；字面文案与
 * shared validateRetryRuleFields 一致）+ loadConfig 热重载读取 + 坏文件回落空集安全态。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearConfigCache } from "@zhushanwen/pi-llm-shared";

import { RETRY_RULES_DOMAIN, RETRY_RULE_KINDS_BY_CLASS } from "@taiji/shared";

import {
	DEFAULT_RETRY_RULES_EXT_CONFIG,
	HTTP_STATUS_CLASS_MAX,
	HTTP_STATUS_CLASS_MIN,
	ID_MAX_LEN,
	isDangerousRetryPattern,
	isRetryRulesExtConfig,
	JSON_PATH_MAX_LEN,
	KINDS_BY_CLASS,
	loadRetryRulesConfig,
	MATCH_COUNT_MAX,
	MATCH_VALUE_MAX_LEN,
	NAME_MAX_LEN,
	normalizeRetryRulesConfig,
	PATTERN_MAX_LEN,
	RULES_MAX,
	validateRetryRuleFields,
	WAIT_HINT_MAX_LEN,
} from "../config.ts";
import { TEXT_MAX_LEN } from "../rules.ts";

const { loggerMock } = vi.hoisted(() => ({
	loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({
	getLogger: () => loggerMock,
	createLogger: () => loggerMock,
	setPiHandle: vi.fn(),
}));

let agentDir: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "retry-rules-cfg-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	clearConfigCache();
});

afterEach(() => {
	vi.unstubAllEnvs();
});

function writeConfigFile(content: unknown): void {
	mkdirSync(join(agentDir, "config"), { recursive: true });
	writeFileSync(join(agentDir, "config", "retry-rules-ext-config.json"), JSON.stringify(content, null, 2), "utf-8");
}

const VALID_RULE = {
	id: "zhipu-1302",
	name: "智谱 1302",
	verdict: "retryable",
	match: [{ kind: "jsonPath", path: "error.code", operator: "equals", value: "1302" }],
	class: "provider",
	source: "custom",
};

describe("validateRetryRuleFields（镜像 shared 域）", () => {
	it("合法规则通过", () => {
		expect(validateRetryRuleFields(VALID_RULE)).toEqual({ ok: true });
	});

	it("非对象 / verdict 词表外 / 危险正则 / jsonPath 缺值分别拒绝", () => {
		expect(validateRetryRuleFields(null).ok).toBe(false);
		const badVerdict = validateRetryRuleFields({ ...VALID_RULE, verdict: "non-retryable" });
		expect(badVerdict.ok).toBe(false);
		if (!badVerdict.ok) expect(badVerdict.errors.join(";")).toContain("non_retryable");
		const dangerous = validateRetryRuleFields({ ...VALID_RULE, match: [{ kind: "pattern", pattern: "(.+)*x" }] });
		expect(dangerous.ok).toBe(false);
		if (!dangerous.ok) expect(dangerous.errors.join(";")).toContain("嵌套量词");
		const noValue = validateRetryRuleFields({ ...VALID_RULE, match: [{ kind: "jsonPath", path: "error.code", operator: "equals" }] });
		expect(noValue.ok).toBe(false);
	});

	it("source 域校验（复制体扩展面：bundle 侧 source 必填）", () => {
		const { source: _s, ...noSource } = VALID_RULE;
		expect(validateRetryRuleFields(noSource).ok).toBe(false);
	});

	it("isDangerousRetryPattern 与 shared 同判定", () => {
		expect(isDangerousRetryPattern("(.+)*")).toBe(true);
		expect(isDangerousRetryPattern("(?:a|b+)+")).toBe(true);
		expect(isDangerousRetryPattern('"code"\\s*:\\s*"?(?:1308|1310)"?')).toBe(false);
	});

	it("kind 字段校验（镜像 shared collectKindErrors：per-class 闭合值域 + engine 前缀开放面）", () => {
		expect(validateRetryRuleFields({ ...VALID_RULE, kind: "rate_limited" }).ok).toBe(true);
		expect(validateRetryRuleFields({ ...VALID_RULE, class: "engine", kind: "engine_aborted" }).ok).toBe(true);
		const wrongKind = validateRetryRuleFields({ ...VALID_RULE, kind: "turn_budget_exhausted" });
		expect(wrongKind.ok).toBe(false);
		if (!wrongKind.ok) expect(wrongKind.errors.join(";")).toContain("rate_limited / protocol_unsupported");
		const badEngine = validateRetryRuleFields({ ...VALID_RULE, class: "engine", kind: "aborted" });
		expect(badEngine.ok).toBe(false);
		if (!badEngine.ok) expect(badEngine.errors.join(";")).toContain("engine_");
		expect(validateRetryRuleFields({ ...VALID_RULE, kind: undefined }).ok).toBe(true);
	});

	it("kind 词表值级对账 = shared RETRY_RULE_KINDS_BY_CLASS（SSOT 镜像防线）", () => {
		expect(KINDS_BY_CLASS).toEqual(RETRY_RULE_KINDS_BY_CLASS);
	});

	it("域常量值级对账 = shared RETRY_RULES_DOMAIN（SSOT 镜像防线：shared 侧调值本测试即红，强制同步复制体）", () => {
		expect({
			patternMaxLen: PATTERN_MAX_LEN,
			idMaxLen: ID_MAX_LEN,
			nameMaxLen: NAME_MAX_LEN,
			jsonPathMaxLen: JSON_PATH_MAX_LEN,
			matchValueMaxLen: MATCH_VALUE_MAX_LEN,
			waitHintMaxLen: WAIT_HINT_MAX_LEN,
			matchCountMax: MATCH_COUNT_MAX,
			customRulesMax: RULES_MAX,
			textMaxLen: TEXT_MAX_LEN,
			httpStatusClassMin: HTTP_STATUS_CLASS_MIN,
			httpStatusClassMax: HTTP_STATUS_CLASS_MAX,
		}).toEqual(RETRY_RULES_DOMAIN);
	});
});

describe("loadRetryRulesConfig（热重载读取）", () => {
	it("文件缺失回落默认空集（安全态：判定不生效 = pi 原生词表兜底）", () => {
		expect(loadRetryRulesConfig()).toEqual(DEFAULT_RETRY_RULES_EXT_CONFIG);
	});

	it("合法文件读出生效规则", () => {
		writeConfigFile({ version: 1, customRules: [VALID_RULE], effectiveRules: [VALID_RULE] });
		expect(loadRetryRulesConfig().effectiveRules).toHaveLength(1);
	});

	it("非法条目文件回落默认空集 + onWarning 收到错误清单（不静默修正）", () => {
		writeConfigFile({ version: 1, customRules: [], effectiveRules: [{ ...VALID_RULE, verdict: "bogus" }] });
		const warnings: string[] = [];
		const config = loadRetryRulesConfig((msg) => warnings.push(msg));
		expect(config).toEqual(DEFAULT_RETRY_RULES_EXT_CONFIG);
		expect(warnings.join(";")).toContain("裁决");
	});
});

describe("normalize / guard（复制体）", () => {
	it("isRetryRulesExtConfig：默认与合法形态通过；段缺失拒绝", () => {
		expect(isRetryRulesExtConfig(DEFAULT_RETRY_RULES_EXT_CONFIG)).toBe(true);
		expect(isRetryRulesExtConfig({ version: 1, customRules: [VALID_RULE], effectiveRules: [] })).toBe(true);
		expect(isRetryRulesExtConfig({ version: 1, customRules: [] })).toBe(false);
	});

	it("normalizeRetryRulesConfig：非法输入 throw 且消息含逐项错误", () => {
		expect(() => normalizeRetryRulesConfig({ version: 1, customRules: "x", effectiveRules: [] })).toThrow();
	});
});
