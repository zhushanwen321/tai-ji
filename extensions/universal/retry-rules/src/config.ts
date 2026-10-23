/**
 * retry-rules ext-config 读取与校验（bundle 自包含复制体）。
 *
 * 类型与校验语义 SSOT = packages/shared/src/retry-rules.ts（subagent-observability
 * §3.3.12）——extension bundle 自包含不 import shared 运行时代码（network-proxy 同款
 * 惯例：结构类型本地声明 + 行为镜像锁定测试），本文件是复制体；漂移时以 shared 为准，
 * __tests__/config.test.ts 锁两侧行为一致。
 *
 * 配置文件 = <agentDir>/config/retry-rules-ext-config.json（llm-shared getConfigPath
 * 推导；写入侧 = taiji runtime RMW——内置基线 ⊕ 远程覆盖 ⊕ 用户自定义的合并权威在
 * runtime，extension 是纯消费方，单一数据源）。热重载 = loadConfig 读时刷新（mtime+size），
 * 判定点每次直接调 loadRetryRulesConfig，禁止上层闭包缓存（llm-shared 头注热重载契约；
 * 改动下一轮判定即生效，在途退避不中断——重试状态机由 pi 持有）。
 *
 * 停用通道（控制旋钮，§3.3.12 用户停用通道登记）：本配置无独立 enabled 开关——停用
 * 复用既有「LLM 调用重试」卡的 pi 原生 retry 配置（enabled=false / maxRetries=0）。
 * pi 重试决策点先检查 `!settings.enabled || _retryAttempt >= settings.maxRetries` 即直接
 * 不重试（node_modules pi-coding-agent dist/core/agent-session.js:787 实装核实——该门
 * 位于读 errorMessage 词表的 _isRetryableError 之前），本扩展的 message_end 改写只影响
 * 后续可重试性判定，前置门关闭后改写不触发任何重试——停用即自然回落失败如实分类。
 */

import { loadConfig } from "@zhushanwen/pi-llm-shared";

import type { RetryableErrorRule, RetryRuleMatch, RetryRuleSource, RetryRuleVerdict } from "./rules.js";

/** llm-shared loadConfig 的包名（决定文件名 retry-rules-ext-config.json）。 */
const CONFIG_PKG = "retry-rules";

const VERDICTS: readonly string[] = ["retryable", "non_retryable", "conditional"];
const OPERATORS: readonly string[] = ["equals", "contains", "exists"];
const SOURCES: readonly string[] = ["custom", "remote", "builtin"];

const ID_MAX_LEN = 64;
const NAME_MAX_LEN = 120;
const PATTERN_MAX_LEN = 200;
const JSON_PATH_MAX_LEN = 128;
const MATCH_VALUE_MAX_LEN = 256;
const WAIT_HINT_MAX_LEN = 200;
const MATCH_COUNT_MAX = 8;
const RULES_MAX = 200;
/** HTTP 状态大类合法区间（4xx/5xx 语义码段；镜像 shared RetryRuleHttpStatusClass 校验域）。 */
const HTTP_STATUS_CLASS_MIN = 400;
const HTTP_STATUS_CLASS_MAX = 599;

/** 校验结果信封：ok 或面向用户的错误清单（每条含修复动作，逐项收集不短路）。 */
export type RetryRulesValidationResult = { ok: true } | { ok: false; errors: string[] };

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strWithin(v: unknown, max: number): v is string {
	return typeof v === "string" && v.length > 0 && v.length <= max;
}

/** 危险正则静态检测（镜像 shared isDangerousRetryPattern：长度上限 + 嵌套量词 + 相邻区间量词）。 */
export function isDangerousRetryPattern(pattern: string): boolean {
	if (pattern.length > PATTERN_MAX_LEN) return true;
	if (/\((?:[^()\\]|\\.)*[+*]\)[+*{]/.test(pattern)) return true;
	if (/\{(?:\d+),(?:\d+)?\}\s*\{/.test(pattern)) return true;
	return false;
}

/** 匹配条件校验（pattern / jsonPath 双通道逐项收集）。 */
function collectMatchErrors(match: unknown, label: string): string[] {
	if (!Array.isArray(match)) {
		return [`${label} 必须是匹配条件列表，请至少添加一条匹配条件`];
	}
	if (match.length === 0) {
		return [`${label} 不能为空，请至少添加一条匹配条件`];
	}
	if (match.length > MATCH_COUNT_MAX) {
		return [`${label} 条数超过上限 ${MATCH_COUNT_MAX}，请合并条件`];
	}
	const errors: string[] = [];
	for (let i = 0; i < match.length; i++) {
		const item = match[i];
		const at = `${label} 第 ${i + 1} 条`;
		if (!isRecord(item)) {
			errors.push(`${at} 必须是对象，请重新编辑该匹配条件`);
			continue;
		}
		if (item["kind"] === "pattern") {
			const pattern = item["pattern"];
			if (!strWithin(pattern, PATTERN_MAX_LEN)) {
				errors.push(`${at}（正则）为空或超过 ${PATTERN_MAX_LEN} 字符，请缩短正则表达式`);
				continue;
			}
			if (isDangerousRetryPattern(pattern)) {
				errors.push(`${at}（正则）包含嵌套量词等高回溯构造，存在卡死风险，请简化正则`);
				continue;
			}
			try {
				new RegExp(pattern, "i");
			} catch {
				errors.push(`${at}（正则）语法无效，请修正后保存`);
			}
			continue;
		}
		if (item["kind"] === "jsonPath") {
			const path = item["path"];
			const operator = item["operator"];
			const value = item["value"];
			if (!strWithin(path, JSON_PATH_MAX_LEN) || /\s/.test(path)) {
				errors.push(`${at}（JSON 路径）为空、超过 ${JSON_PATH_MAX_LEN} 字符或含空白，请填写如 error.code 的点路径`);
				continue;
			}
			if (typeof operator !== "string" || !OPERATORS.includes(operator)) {
				errors.push(`${at}（JSON 路径）比较方式必须是 equals / contains / exists 之一`);
				continue;
			}
			if (operator !== "exists" && !strWithin(value, MATCH_VALUE_MAX_LEN)) {
				errors.push(`${at}（JSON 路径）比较值不能为空且不超过 ${MATCH_VALUE_MAX_LEN} 字符`);
			}
			continue;
		}
		errors.push(`${at} 匹配通道必须是 pattern 或 jsonPath，请重新选择匹配方式`);
	}
	return errors;
}

/** 单条规则校验（镜像 shared validateRetryRuleFields；source 字段同时域校验）。 */
export function validateRetryRuleFields(rule: unknown): RetryRulesValidationResult {
	if (!isRecord(rule)) {
		return { ok: false, errors: [`重试规则必须是对象: ${JSON.stringify(rule) ?? String(rule)}`] };
	}
	const errors: string[] = [];
	const { id, name, verdict, match, class: failureClass, source } = rule;
	if (!strWithin(id, ID_MAX_LEN) || /\s/.test(id)) {
		errors.push(`规则 ID 为空、超过 ${ID_MAX_LEN} 字符或含空白，请填写如 zhipu-1302 的短标识`);
	}
	if (!strWithin(name, NAME_MAX_LEN)) {
		errors.push(`规则名称为空或超过 ${NAME_MAX_LEN} 字符，请填写简短名称`);
	}
	if (typeof verdict !== "string" || !VERDICTS.includes(verdict)) {
		errors.push(`裁决必须是 retryable / non_retryable / conditional 之一: ${JSON.stringify(verdict) ?? String(verdict)}`);
	}
	if (typeof failureClass !== "string") {
		errors.push("失败分类（class）不能为空，请选择该错误所属的分类");
	}
	if (typeof source !== "string" || !SOURCES.includes(source)) {
		errors.push(`规则出处（source）必须是 custom / remote / builtin 之一: ${JSON.stringify(source) ?? String(source)}`);
	}
	errors.push(...collectMatchErrors(match, "匹配条件"));
	if (rule["httpStatusClass"] !== undefined) {
		const c = rule["httpStatusClass"];
		if (typeof c !== "number" || !Number.isInteger(c) || c < HTTP_STATUS_CLASS_MIN || c > HTTP_STATUS_CLASS_MAX) {
			errors.push(`HTTP 状态大类必须是 ${HTTP_STATUS_CLASS_MIN}-${HTTP_STATUS_CLASS_MAX} 的整数: ${JSON.stringify(c) ?? String(c)}`);
		}
	}
	if (rule["waitHint"] !== undefined && !strWithin(rule["waitHint"], WAIT_HINT_MAX_LEN)) {
		errors.push(`等待提示为空或超过 ${WAIT_HINT_MAX_LEN} 字符，请留空或填写简短提示`);
	}
	return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

function validateRuleList(rules: unknown, label: string): string[] {
	if (!Array.isArray(rules)) return [`${label} 必须是规则列表`];
	if (rules.length > RULES_MAX) return [`${label} 条数超过上限 ${RULES_MAX}`];
	const errors: string[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < rules.length; i++) {
		const result = validateRetryRuleFields(rules[i]);
		if (!result.ok) errors.push(...result.errors.map((e) => `${label} 第 ${i + 1} 条：${e}`));
		const id = isRecord(rules[i]) ? rules[i]["id"] : undefined;
		if (typeof id === "string" && id !== "") {
			if (seen.has(id)) errors.push(`${label} 第 ${i + 1} 条：规则 ID「${id}」重复，请修改 ID`);
			seen.add(id);
		}
	}
	return errors;
}

/** 默认配置：空规则集（判定不生效 = pi 原生词表兜底；与 package.json startupConfig 声明深相等）。 */
export const DEFAULT_RETRY_RULES_EXT_CONFIG = {
	version: 1 as const,
	customRules: [],
	effectiveRules: [],
};

/** ext-config 文件形状 guard（读侧 normalize 前置）。 */
export function isRetryRulesExtConfig(v: unknown): v is {
	version: 1;
	customRules: RetryableErrorRule[];
	effectiveRules: RetryableErrorRule[];
} {
	if (!isRecord(v) || v["version"] !== 1) return false;
	if (!Array.isArray(v["customRules"]) || !Array.isArray(v["effectiveRules"])) return false;
	return validateRuleList(v["customRules"], "customRules").length === 0 && validateRuleList(v["effectiveRules"], "effectiveRules").length === 0;
}

/**
 * loadConfig 的 normalize：校验通过的 raw 即合法配置（校验 = 运行时 guard，断言有兜底）。
 * 非法配置 throw（含逐项错误清单）→ loadConfig 回落 defaults 并把消息交给 onWarning——
 * 非法配置不静默修正（network-proxy 域同款语义），回落空集 = 判定不生效的安全态。
 */
export function normalizeRetryRulesConfig(raw: unknown): {
	version: 1;
	customRules: RetryableErrorRule[];
	effectiveRules: RetryableErrorRule[];
} {
	if (!isRetryRulesExtConfig(raw)) {
		const errors = [
			...validateRuleList(isRecord(raw) ? raw["customRules"] : undefined, "customRules"),
			...validateRuleList(isRecord(raw) ? raw["effectiveRules"] : undefined, "effectiveRules"),
		];
		throw new Error((errors.length > 0 ? errors : ["配置形状必须是 { version: 1, customRules, effectiveRules }"]).join("；"));
	}
	return raw;
}

/** 读取配置（llm-shared mtime+size 读时刷新热重载；调用方每次判定直取，禁闭包缓存）。 */
export function loadRetryRulesConfig(onWarning?: (msg: string) => void): {
	version: 1;
	customRules: RetryableErrorRule[];
	effectiveRules: RetryableErrorRule[];
} {
	return loadConfig(CONFIG_PKG, DEFAULT_RETRY_RULES_EXT_CONFIG, normalizeRetryRulesConfig, onWarning);
}

export type { RetryableErrorRule, RetryRuleMatch, RetryRuleSource, RetryRuleVerdict };
