/**
 * 重试规则判定管线（bundle 自包含复制体）。
 *
 * 语义 SSOT = packages/shared/src/retry-rules.ts（subagent-observability §3.3.12）——
 * extension bundle 自包含不 import shared 运行时代码（extensions 对 shared 的既有惯例：
 * 结构类型本地声明 + 行为镜像锁定测试），本文件是复制体；漂移时以 shared 为准，
 * __tests__/rules.test.ts 锁两侧行为一致（用例与 shared 同款对拍）。
 *
 * 判定管线两层序（设计定稿）：
 *   第一层按 verdict 排除——non_retryable 规则优先于 retryable/conditional（先排除再放行，
 *   账户类错误永不误重试，不区分 source）；第二层同 verdict 内按 source 序
 *   custom > remote > builtin，命中即断；全未命中 = 不改写（pi 原生词表兜底）。
 */

// ───────────────────────── 词表 ─────────────────────────

/** 规则裁决三态（verdict 字面统一下划线形态）。 */
export type RetryRuleVerdict = "retryable" | "non_retryable" | "conditional";

/** 规则出处（两层序第二层排序键：custom > remote > builtin）。 */
export type RetryRuleSource = "custom" | "remote" | "builtin";

/** 单条匹配条件（对 errorMessage 文本；match[] 全部命中才算命中，AND 语义）。 */
export type RetryRuleMatch =
	| { kind: "pattern"; pattern: string }
	| { kind: "jsonPath"; path: string; operator: "equals" | "contains" | "exists"; value?: string };

/** 单条重试判定规则（class/kind 字段为分类码表共用 schema 位——判定管线不消费，§3.3.12 条目 schema）。 */
export interface RetryableErrorRule { // oe-exempt:20261026:framework:ext-config 契约的 bundle 自包含复制体声明（SSOT=shared，镜像锁定测试锚定）

	id: string;
	name: string;
	verdict: RetryRuleVerdict;
	match: RetryRuleMatch[];
	class: string;
	/** FailureCause kind 细分（可选，值域校验镜像 shared validateRetryRuleFields——判定管线不消费）。 */
	kind?: string;
	httpStatusClass?: number;
	waitHint?: string;
	source: RetryRuleSource;
}

/** ext-config 判定消费段（effectiveRules）所在文件 schema。 */
export interface RetryRulesExtConfig { // oe-exempt:20261026:framework:ext-config 契约的 bundle 自包含复制体声明（SSOT=shared，镜像锁定测试锚定）

	version: 1;
	customRules: RetryableErrorRule[];
	effectiveRules: RetryableErrorRule[];
}

/** 域常量（镜像 shared RETRY_RULES_DOMAIN.textMaxLen；导出仅供镜像锁定测试值级对账）。 */
export const TEXT_MAX_LEN = 8192;

/** SOURCE 判定序（两层序第二层）：custom > remote > builtin。 */
const SOURCE_ORDER: readonly RetryRuleSource[] = ["custom", "remote", "builtin"];

// ───────────────────────── 匹配（双通道 + ReDoS 运行时防护） ─────────────────────────

/** JSON 片段提取：首个 `{` 起的括号平衡段（字符串字面量感知）；无平衡段返回 null。 */
export function extractJsonSegment(text: string): string | null {
	const start = text.indexOf("{");
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}

/** 点路径取值（`error.code` / `errors.0.type`）；任一层缺失返回 undefined。 */
function readJsonPath(root: unknown, path: string): unknown {
	let current: unknown = root;
	for (const segment of path.split(".")) {
		if (current === null || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

/** 单条匹配条件判定（message 已截断）。 */
function matchesCondition(message: string, condition: RetryRuleMatch): boolean {
	if (condition.kind === "pattern") {
		try {
			return new RegExp(condition.pattern, "i").test(message);
		} catch {
			// 运行时兜底（写侧校验已拒非法源；本侧防线覆盖绕过 runtime 直改文件的第三方便携形态）：无效源恒不命中
			return false;
		}
	}
	const segment = extractJsonSegment(message);
	if (segment === null) return false;
	let parsed: unknown;
	try {
		parsed = JSON.parse(segment);
	} catch {
		return false;
	}
	const actual = readJsonPath(parsed, condition.path);
	if (condition.operator === "exists") return actual !== undefined;
	if (actual === undefined || actual === null) return false;
	const actualText = typeof actual === "string" ? actual : JSON.stringify(actual);
	if (condition.operator === "equals") return actualText === condition.value;
	return actualText.includes(condition.value ?? "");
}

/** 单条规则判定：match[] 全部命中才算命中（AND）。 */
export function matchRetryRule(message: string, rule: RetryableErrorRule): boolean {
	return rule.match.every((condition) => matchesCondition(message, condition));
}

// ───────────────────────── 判定管线（两层序，命中即断） ─────────────────────────

/** 判定结论：rewrite = 追加标记触发 pi 原生重试；keep = 不改写（reason 说明不动因）。 */
export type RetryRuleDecision =
	| { action: "rewrite" }
	| { action: "keep"; reason: "empty_message" | "non_retryable_hit" | "conditional_hit" | "no_rule_match" };

export function evaluateRetryRules(message: string, rules: readonly RetryableErrorRule[]): RetryRuleDecision {
	if (message.trim() === "") return { action: "keep", reason: "empty_message" };
	const truncated = message.length > TEXT_MAX_LEN ? message.slice(0, TEXT_MAX_LEN) : message;
	// 第一层：verdict 排除（先排除再放行——用户可重试规则击穿账户类硬约束的方向被结构封死）
	for (const rule of rules) {
		if (rule.verdict === "non_retryable" && matchRetryRule(truncated, rule)) {
			return { action: "keep", reason: "non_retryable_hit" };
		}
	}
	// 第二层：同 verdict 内按 source 序，首个命中规则裁决（命中即断）
	for (const source of SOURCE_ORDER) {
		for (const rule of rules) {
			if (rule.source !== source) continue;
			if (!matchRetryRule(truncated, rule)) continue;
			if (rule.verdict === "retryable") return { action: "rewrite" };
			return { action: "keep", reason: "conditional_hit" };
		}
	}
	return { action: "keep", reason: "no_rule_match" };
}

// ───────────────────────── 改写标记（探针实证锚文本） ─────────────────────────

/**
 * 追加式改写标记（§3.3.12 改写落盘约束 + 探针实证）：
 * - 前缀 `[taiji-retry:` 是本机制触发重试的识别约定（观测侧按标记对账；pi 原生词表
 *   命中的重试无标记）；
 * - 锚文本 `rate limit 429 too many requests` 实测命中 pi-ai RETRYABLE 词表的
 *   `rate.?limit` / `429` / `too many requests` 三条，且不含 NON_RETRYABLE 词表任何成员
 *   （node_modules @earendil-works/pi-ai dist/utils/retry.js 1.0.0 实装核对）；
 * - 追加式非替换式：原 errorMessage 完整保留在前段（pi 会话记录持久化改写形态，无信息丢失）。
 */
export const RETRY_REWRITE_MARKER = " [taiji-retry: rate limit 429 too many requests]";

/** 改写标记前缀（幂等判定用）。 */
export const RETRY_REWRITE_MARKER_PREFIX = "[taiji-retry:";

/** 追加式改写：原文保留 + 标记追加；已带标记时原样返回（幂等）。 */
export function appendRetryMarker(errorMessage: string): string {
	if (errorMessage.includes(RETRY_REWRITE_MARKER_PREFIX)) return errorMessage;
	return `${errorMessage}${RETRY_REWRITE_MARKER}`;
}
