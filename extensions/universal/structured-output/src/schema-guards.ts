/**
 * Schema 形态守卫 — 纯逻辑叶节点（零业务依赖，全导出）。
 *
 * 从 index.ts 拆出：swap 检测 + silent-corruption prevention 的一组纯函数。
 *
 * 核心问题：schema 和 data 参数都用 Type.Unknown()，结构无差别。弱模型常把答案
 * 塞进 schema、把形状塞进 data。因 ajv strict:false 把无 keyword 的对象编译成
 * "接受一切" 的 validator，互换后会校验通过、存垃圾、无报错（静默腐败）。
 * 这组守卫在编译前拦截两类形态：互换（schema 像数据 + data 像 schema）和
 * keyword-less schema（{} / {a:1} 这种会被 ajv 静默放行）。
 */

import { isRecord } from "@zhushanwen/pi-ext-guards";

/** JSON Schema draft-07 识别 keyword。只要 schema 含其一就认为是"真 schema"。 */
export const SCHEMA_KEYWORDS = [
	// 核心类型
	"type",
	// object
	"properties", "required", "additionalProperties", "patternProperties",
	"minProperties", "maxProperties",
	// array
	"items", "additionalItems", "minItems", "maxItems", "uniqueItems",
	// enum / const
	"enum", "const",
	// 组合
	"allOf", "anyOf", "oneOf", "not",
	// 条件验证（draft-07）
	"if", "then", "else",
	// 依赖与约束
	"dependencies", "propertyNames", "contains",
	// 引用与定义
	"$ref", "$id", "$defs", "definitions",
	// 数值
	"minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
	// 字符串
	"minLength", "maxLength", "pattern", "format",
] as const;

/**
 * @deprecated 深路径公开名兼容别名（ext-simplify-18 D2）；新代码直接用 ext-guards isRecord。
 * 本包独立发布、无 exports 字段且 files 含 src/（深路径对外可达），公开名直接删除是
 * breaking——保留一个发布周期的 re-export，删除时点登记在 ext-simplify index 18 号行。
 */
export const isPlainObject = isRecord;

export function hasSchemaKeyword(obj: Record<string, unknown>): boolean {
	return SCHEMA_KEYWORDS.some((keyword) => keyword in obj);
}

/** 错误回显长度上限（截断长 schema/data，避免错误消息爆炸）。 */
const ECHO_MAX_CHARS = 200;

export function echo(value: unknown): string {
	let str: string;
	try {
		// JSON.stringify(undefined) 返回 undefined（不是 throw），需 ?? 兜底，
		// 否则后续 str.length 会 "Cannot read properties of undefined"。
		str = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
	} catch {
		str = String(value);
	}
	return str.length <= ECHO_MAX_CHARS ? str : `${str.slice(0, ECHO_MAX_CHARS)}...`;
}

/**
 * 尝试 JSON.parse；失败（malformed JSON）时保留原值，让 Ajv 拒绝。
 * 模型有时把 schema/data 当 JSON 字符串传；parse 失败不是错误，保持原样让下游校验拒绝。
 * catch 里有实质处理（决定返回原值），满足 taste/no-silent-catch。
 */
export function tryParseJson(raw: unknown): unknown {
	if (typeof raw !== "string") return raw;
	try {
		return JSON.parse(raw);
	} catch {
		return raw; // malformed JSON → 保留原字符串，Ajv 会拒绝
	}
}

/**
 * 把 authoritative schema 的 unknown 收窄为合法 JSON Schema 根类型（object | boolean）。
 * draft-07 允许 boolean 根 schema（true=接受一切，false=拒绝一切）。
 * 独立守卫使后续 getOrCompileValidator(authoritative) 在类型层面也成立，
 * 避免在守卫块外直接用 unknown。非合法形态抛清晰错误。
 */
export function assertJsonSchemaRoot(value: unknown): asserts value is Record<string, unknown> | boolean {
	if (!(isRecord(value) || typeof value === "boolean")) {
		throw new Error(`authoritative schema must be a JSON Schema object or boolean, got ${typeof value}`);
	}
}

/** turn_end event 是否可安全访问 message.stopReason（用于判断模型是否还在调工具链）。 */
export function isTurnEndEvent(e: unknown): e is { message?: { stopReason?: string } } {
	return typeof e === "object" && e !== null;
}

/** tool_execution_end event 结构守卫（替代直接 cast，配合 taste/no-unsafe-cast）。 */
export function isToolExecutionEndEvent(
	e: unknown,
): e is { toolName: unknown; isError: unknown; result?: unknown } {
	return typeof e === "object" && e !== null && "toolName" in e && "isError" in e;
}

/**
 * swap 检测 + keyword-less schema 拒绝的纠错文案前缀，所有相关错误共用。
 * 工具名逐字拼写（非 ${TOOL_NAME} 引用）：本模块是纯逻辑叶节点（零业务依赖），
 * 反向 import tool-definition 会成环。
 */
export const CORRECT_USAGE_HINT =
	"Correct: structured-output({schema:{type:'object',properties:{...}}, data:{...actual values}}). ";
