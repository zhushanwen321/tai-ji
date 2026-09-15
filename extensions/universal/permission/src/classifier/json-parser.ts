/**
 * AI Classifier 输出解析（三层容错 → ClassifierResult）
 *
 * 对应 I4 classifyRisk 的「LLM 响应 → 结构化结果」环节。
 *
 * 三层容错：
 *   1. 正则提取首个 JSON 对象（贪婪匹配）
 *   2. JSON.parse（try/catch）
 *   3. 字段验证（枚举 + 数值）
 *
 * 任意一层失败 → 返回 fail-closed fallback（outcome=ask, risk_level=medium, confidence=0）。
 */

import type { ClassifierResult, PermissionAction, RiskLevel } from "../types.js";

/** 解析失败时的 fail-closed fallback（统一 medium/ask，绝不静默放行） */
export const PARSE_FALLBACK_RESULT: ClassifierResult = {
	outcome: "ask",
	risk_level: "medium",
	reasoning: "classifier output parse failed",
	confidence: 0,
};

const VALID_ACTIONS: readonly PermissionAction[] = ["allow", "deny", "ask"];
const VALID_RISKS: readonly RiskLevel[] = ["low", "medium", "high"];

/**
 * 提取首个 JSON 对象子串。
 *
 * 用贪婪正则 `/\{[\s\S]*\}/` 取最后一个 `}` 为止的子串。
 *
 * 已知 limitation（G5）：当 LLM 输出多个独立 JSON 对象（如 `{"a":1} {"b":2}`）时，
 * 贪婪匹配会吞掉中间空格得到 `{...}{...}`，JSON.parse 失败 → fallback。
 * 实际分类器场景下 LLM 只应返回单个对象，此权衡换取「单对象 + 尾随文本」的鲁棒性。
 */
function extractJsonObject(text: string): string | null {
	const match = text.match(/\{[\s\S]*\}/);
	return match ? match[0] : null;
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 验证并提取 outcome（容忍大小写） */
function readAction(raw: unknown): PermissionAction | null {
	if (typeof raw !== "string") return null;
	const lower = raw.toLowerCase();
	return VALID_ACTIONS.includes(lower as PermissionAction) ? (lower as PermissionAction) : null;
}

/** 验证并提取 risk_level（容忍大小写） */
function readRiskLevel(raw: unknown): RiskLevel | null {
	if (typeof raw !== "string") return null;
	const lower = raw.toLowerCase();
	return VALID_RISKS.includes(lower as RiskLevel) ? (lower as RiskLevel) : null;
}

/**
 * 验证并提取 confidence：必须是有限数字，clamp 到 [0,1]。
 *
 * 接受字符串数字（LLM 偶发返回 `"0.8"`），拒绝 NaN/Infinity/非数字。
 */
function readConfidence(raw: unknown): number | null {
	let num: number;
	if (typeof raw === "number") {
		num = raw;
	} else if (typeof raw === "string" && raw.trim().length > 0) {
		num = Number(raw);
	} else {
		return null;
	}
	if (!Number.isFinite(num)) return null;
	if (num < 0) num = 0;
	if (num > 1) num = 1;
	return num;
}

/** 兼容 LLM 偶发把 reasoning 写成 reason（取先存在者） */
function readReasoning(raw: unknown): string {
	if (typeof raw === "string" && raw.length > 0) return raw;
	return PARSE_FALLBACK_RESULT.reasoning;
}

/**
 * 解析 classifier LLM 输出文本 → ClassifierResult。
 *
 * @param text LLM 返回的原始文本（可能含 markdown code fence / 前后 prose）
 * @returns 始终返回 ClassifierResult；解析失败返回 PARSE_FALLBACK_RESULT（fail-closed ask）
 */
export function parseClassifierResponse(text: string): ClassifierResult {
	if (typeof text !== "string" || text.length === 0) {
		return { ...PARSE_FALLBACK_RESULT };
	}

	const jsonStr = extractJsonObject(text);
	if (jsonStr === null) {
		return { ...PARSE_FALLBACK_RESULT };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonStr);
	} catch {
		return { ...PARSE_FALLBACK_RESULT };
	}

	if (!isStringRecord(parsed)) {
		return { ...PARSE_FALLBACK_RESULT };
	}

	const outcome = readAction(parsed.outcome);
	const risk_level = readRiskLevel(parsed.risk_level);
	const confidence = readConfidence(parsed.confidence ?? parsed.score);

	// 三个核心字段必须全部有效；缺任一即 fail-closed
	if (outcome === null || risk_level === null || confidence === null) {
		return { ...PARSE_FALLBACK_RESULT };
	}

	return {
		outcome,
		risk_level,
		reasoning: readReasoning(parsed.reasoning ?? parsed.reason),
		confidence,
	};
}
