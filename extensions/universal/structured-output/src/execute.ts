/**
 * executeStructuredOutput 编排 + 日常校验函数（IF-6 拆分；U1 权威分支透传化）。
 *
 * 两种模式：
 *   - workflow 模式（`authoritativeSchema` 存在）：透传（D2）。pi-ai 参数层
 *     （validateToolArguments）已按注册进工具的 parameters（= 权威 schema，见
 *     createWorkflowToolDefinition）校验 + 类型矫正过 arguments——execute 再 ajv
 *     不是双保险而是第二校验权威（方案 A [HISTORICAL] 明令禁止的形态），已删除。
 *     注册期 fail-fast 防御（keyword-less 拒绝 / boolean true 拦截）上移至
 *     createWorkflowToolDefinition。非 object 根在注册期被包装为 {value}，此处解包。
 *   - 日常模式（交互式）：无 `authoritativeSchema`，走 validateAgainstSelfReported 防御链。
 *
 * 日常模式防御顺序（编译前拦截，治静默腐败的根）：
 *   1. 互换检测 — schema 像数据（无 keyword）且 data 像 schema（有 keyword）→ 抛纠错
 *   2. keyword-less schema 拒绝 — schema 是对象但无任何识别 keyword（{} / {a:1}）
 *      → 抛 "no recognized keyword"，否则 ajv strict:false 会编译成"接受一切"
 *   3. ajv 编译失败 → 抛 "Invalid JSON Schema"（含回显）
 *   4. 校验失败 → 抛 "Schema validation failed"（含回显）
 */

import type { ValidateFunction } from "ajv";

import { isRecord } from "@zhushanwen/pi-ext-guards";

import { getOrCompileValidator } from "./ajv-validator.js";
import {
	CORRECT_USAGE_HINT,
	echo,
	hasSchemaKeyword,
	tryParseJson,
} from "./schema-guards.js";

/**
 * 判定权威 schema 的根数据形态是否为 object（U1/P6）。
 *
 * tool call arguments 协议上必为 object：object 根 schema 可直接作工具 parameters
 * （arguments 即 data）；否则（array/string/number/boolean/enum/组合根等）需在注册期
 * 包一层 {value}，execute 侧对称解包。判定口径与注册期包装严格同源（同一函数），
 * 避免「注册期包装了但 execute 不解包」或反向的漂移。
 *
 * draft-07 语义：无 type 时类型关键字按值形态适用——properties/required 等
 * object 特有关键字的存在意味着作者在描述 object 输出，arguments（必为 object）
 * 直接被这些约束校验，故算 object 根。组合根（anyOf/oneOf/allOf/$ref/enum）
 * 可能接受非 object 值，保真起见一律包装（{value} 内可容纳任意成员类型）。
 *
 * [同源锚定] packages/subagent-core 的 agent-opts-resolver.ts（src/orchestration/）
 * 持有本函数的本地副本（两包独立 npm 不能直接 import，optional peer 不保证存在），
 * 其 ASP 文案按本判定同源条件化——改动本函数判定逻辑必须同步该副本。
 */
export function isObjectRootSchema(schema: unknown): schema is Record<string, unknown> {
	if (!isRecord(schema)) return false;
	if (schema.type === "object") return true;
	if (Array.isArray(schema.type) && schema.type.includes("object")) return true;
	const OBJECT_ONLY_KEYS = [
		"properties",
		"required",
		"patternProperties",
		"additionalProperties",
		"minProperties",
		"maxProperties",
		"dependencies",
		"dependentRequired",
		"propertyNames",
	];
	return OBJECT_ONLY_KEYS.some((k) => k in schema);
}

/**
 * 非 object 根包装的解包（P6 的对称操作）。
 * 注册期 {value} 包装 + 参数层 required ["value"] 保证到达这里的 arguments
 * 形如 {value: <data>}；防御性 guard：意外形态（缺 value 字段）原样透传，
 * 不在 execute 层制造第二道校验。
 */
function unwrapValueField(data: unknown): unknown {
	if (isRecord(data) && "value" in data) {
		return data.value;
	}
	return data;
}

/**
 * 日常模式防御链（原 4 步原样迁移）：LLM 自报 schema 的校验路径。
 * 编译前拦截两类静默腐败形态：互换（schema 像数据 + data 像 schema）和
 * keyword-less schema（{} / {a:1} 会被 ajv strict:false 编译成"接受一切"）。
 *
 * @returns 校验通过恒为 true；任何失败形态抛错（带 CORRECT_USAGE_HINT + 回显）。
 */
export function validateAgainstSelfReported(schema: unknown, data: unknown): boolean {
	// 1. 互换检测：schema 像数据（对象无 keyword）且 data 像 schema（对象有 keyword）。
	// 这是最严重的静默腐败路径——若放行，ajv 会把"数据形态的 schema"编译成接受一切，
	// 真正的 schema（此时在 data 里）被丢弃，校验通过并存入垃圾。
	if (isRecord(schema) && !hasSchemaKeyword(schema) && isRecord(data) && hasSchemaKeyword(data)) {
		throw new Error(
			"Likely swapped: schema looks like data and data looks like a schema. "
			+ CORRECT_USAGE_HINT
			+ `Received schema=${echo(schema)}, data=${echo(data)}`,
		);
	}

	// 2. keyword-less schema 拒绝：治静默腐败的根。{} / {a:1} 这类对象会被
	// ajv strict:false 编译成"接受一切"的 validator，模型把答案塞进 schema 时会静默通过。
	if (isRecord(schema) && !hasSchemaKeyword(schema)) {
		throw new Error(
			"Invalid JSON Schema: schema has no recognized keyword "
			+ "(type/properties/items/enum/...). If you passed the answer value as schema, "
			+ "you likely swapped schema and data. "
			+ CORRECT_USAGE_HINT
			+ `Received schema=${echo(schema)}`,
		);
	}

	// 3. ajv 编译。schema 此时可能是 object（过 keyword 检查）、boolean（合法 draft-07 根）、
	// 或 string/number/array/null（非法 → 显式抛错给清晰提示）。getOrCompileValidator 只接受
	// object|boolean，消除原先的 `as Record<string,unknown>` 不安全 cast。
	let validate: ValidateFunction;
	try {
		if (isRecord(schema) || typeof schema === "boolean") {
			validate = getOrCompileValidator(schema);
		} else {
			throw new Error(`schema must be a JSON Schema object or boolean, got ${typeof schema}`);
		}
	} catch (e) {
		throw new Error(
			`Invalid JSON Schema: ${(e as Error).message}. `
			+ `Received schema=${echo(schema)}, data=${echo(data)}`,
		);
	}

	// 4. 校验
	const valid = validate(data);
	if (!valid) {
		const errors = validate.errors
			?.map((err) => `${err.instancePath} ${err.message}`)
			.join("; ");
		throw new Error(
			`Schema validation failed: ${errors}. `
			+ `Received schema=${echo(schema)}, data=${echo(data)}`,
		);
	}
	return true;
}

/**
 * 执行 schema 编排。从工具 execute 抽出以便单元测试直接调用。
 *
 * 编排：workflow 透传分支（authoritativeSchema 存在；非 object 根解包 value）
 * → 日常分支 validateAgainstSelfReported。
 */
export async function executeStructuredOutput(params: {
	/** LLM 自报 schema（仅日常分支消费；workflow 分支忽略）。 */
	schema?: unknown;
	/** workflow 分支 = 模型 arguments（object 根即 data 本身 / 非 object 根为 {value} 包装）；日常分支 = 自报 data。 */
	data?: unknown;
	/** 权威 schema（workflow 模式由 PI_WORKFLOW_SCHEMA env 派生）。存在时走透传分支（D2）。 */
	authoritativeSchema?: unknown;
}): Promise<{
	content: Array<{ type: "text"; text: string }>;
	// data 可能是 primitive/array/object（根 schema 决定），故 details 为 unknown。
	// 测试断言 toEqual(42)/toEqual(true)/toEqual(["a","b","c"])，不可窄化为 Record。
	details: unknown;
}> {
	// ── workflow 模式：透传（D2）──
	// tryParseJson 兼容 string（env 原值）与 object（注册期已解析）两种传入形态。
	// 非 object 根（注册期包装 {value}）→ 解包还原；object 根 → arguments 即 data。
	// 解包判定与注册期包装判定同源（isObjectRootSchema）。
	const authoritative =
		params.authoritativeSchema !== undefined ? tryParseJson(params.authoritativeSchema) : undefined;
	if (authoritative !== undefined) {
		const data = isObjectRootSchema(authoritative) ? params.data : unwrapValueField(params.data);
		return {
			content: [
				{ type: "text" as const, text: "Structured output recorded successfully." },
			],
			details: data,
		};
	}

	// ── 日常模式防御链（validateAgainstSelfReported：互换/keyword-less/编译/校验）──
	// Normalize: some models pass schema/data as JSON strings instead of objects
	const schema = tryParseJson(params.schema);
	const data = tryParseJson(params.data);
	validateAgainstSelfReported(schema, data);

	return {
		content: [
			{ type: "text" as const, text: "Structured output recorded successfully." },
		],
		details: data,
	};
}
