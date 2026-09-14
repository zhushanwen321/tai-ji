/**
 * structured-output tool 定义（D1 双变体分岔）。
 *
 * - createWorkflowToolDefinition(envSchema)：PI_WORKFLOW_SCHEMA 存在时注册。
 *   parameters 即权威 schema 本身（object 根直接用 + 根级 additionalProperties
 *   未声明时注入 false（D4）；非 object 根包装 {value}（P6：tool call arguments
 *   必须是 object，execute 侧对称解包））。「模型不携带 schema」从文案约束升级为
 *   结构约束——pi-ai 参数层直接按权威 schema 校验，不存在可以传错的地方（G1/G3）。
 *   description 按注册期已知的根类型条件化：object 根口径「arguments ARE the
 *   data」；非 object 根参数层实际是 {value} 包装（模型直传裸值必首调失败），
 *   文案明确告知包装契约与 value. 错误路径前缀。裸 object（D4 后只接受空对象）
 *   追加显式警示。文案判定与包装判定同源（isObjectRootSchema），无漂移。
 *   注册期 fail-fast 防御：keyword-less 拒绝（原 ERR-3）与 boolean true 拦截
 *   （原 ERR-7）从 execute 权威分支上移，非法 schema 在子进程加载期终止。
 * - createDailyToolDefinition()：无 env 时注册。双参数自报形态逐字节保留（G4），
 *   仅移除描述文本中的 workflow 语句（D5：workflow 语义只属于 workflow 变体）。
 *
 * 两变体的描述文本均被 prompt-quality.test.ts 文本断言锁定。
 */

import { isRecord } from "@zhushanwen/pi-ext-guards";
import { Type } from "typebox";

import { executeStructuredOutput, isObjectRootSchema } from "./execute.js";
import {
	assertJsonSchemaRoot,
	echo,
	hasSchemaKeyword,
	tryParseJson,
} from "./schema-guards.js";

export const TOOL_NAME = "structured-output";
export const ENV_SCHEMA = "PI_WORKFLOW_SCHEMA";

/**
 * schema env 值的可见性提示阈值（256 KiB，SO-DATA-4）。
 *
 * 背景：PI_WORKFLOW_SCHEMA 经 spawn childEnv 注入子进程，env 块受 ARG_MAX 约束
 *（Linux E2BIG）——超大 schema 会在 spawn 调用点报难归因的失败。硬拒绝在
 * pi 引擎侧（packages/pi-subagent-cli 的 applySchemaEnvToChildEnv，同值上限
 * SCHEMA_ENV_MAX_BYTES = 256 * 1024，见其 src/constants.ts）；本包独立 npm
 * 不能直接 import（isObjectRootSchema 本地副本同例），常量
 * 各自保留、跨包契约测试锁字节相等（tests/cross-package-contract.test.ts）。
 * 本侧职责仅可见性：注册时超限 logger.warn（无 logger API，stderr 直出惯例）提示
 * env 通道有上限，建议拆分 schema 或精简——不拒绝注册（子进程能收到 env 说明 SW
 * 侧闸门已放行，此处拒绝只会把可诊断的降级变成无法启动）。
 *
 * [跨包契约] 任一端改值必须同步另一端，否则 SW 侧硬拒绝线与 SO 侧提示线漂移。
 */
const SCHEMA_SIZE_WARN_KIB = 256;
const BYTES_PER_KIB = 1024;
export const SO_SCHEMA_SIZE_WARN_BYTES = SCHEMA_SIZE_WARN_KIB * BYTES_PER_KIB;

/**
 * 注册期 schema 体积可见性提示（SO-DATA-4 的 SO 侧职责：提示，不拒绝）。
 * stderr 直出（本包惯例：ExtensionContext 无 logger 成员，pi 0.84.1 types.d.ts
 * 核实；与 writeTerminatedLog 同通道）。
 */
function warnIfSchemaOversized(envSchema: string): void {
	const bytes = Buffer.byteLength(envSchema, "utf8");
	if (bytes <= SO_SCHEMA_SIZE_WARN_BYTES) return;
	process.stderr.write(
		`[structured-output] PI_WORKFLOW_SCHEMA is ${bytes} bytes (> ${SO_SCHEMA_SIZE_WARN_BYTES} bytes / `
			+ `${SO_SCHEMA_SIZE_WARN_BYTES / BYTES_PER_KIB} KiB). The env channel has a size ceiling: the workflow runner `
			+ "rejects injection above its own limit (spawn fails, hard to attribute), and oversized values can "
			+ "hit E2BIG (ARG_MAX) at spawn. "
			+ "👉 精简 outputSchema（删冗余 description / 收敛深嵌套）或拆分为多个小 schema 步骤。\n",
	);
}

// ── Workflow variant (parameters = authoritative schema) ─────────────

/**
 * 合成 workflow 单参数工具（D1）。
 *
 * @param envSchema PI_WORKFLOW_SCHEMA env 原值（JSON 字符串；tryParseJson 兼容已解析对象）。
 * @throws 权威 schema 非法（非 object/boolean 根、boolean true、keyword-less object）
 *   时在注册期 fail-fast——错误指回 workflow 脚本的 schema 定义（§5.2 形态 d）。
 */
export function createWorkflowToolDefinition(envSchema: string) {
	// SO-DATA-4：注册期体积可见性提示（超 256KiB 提示精简/拆分；硬拒绝在 SW 侧注入点）
	warnIfSchemaOversized(envSchema);

	// ── 注册期 fail-fast 防御（上移自 execute 权威分支）──
	const schema = tryParseJson(envSchema);
	assertJsonSchemaRoot(schema);

	if (schema === true) {
		// ERR-7 上移：boolean true（accept-all）不提供任何形状约束，workflow 用它等于没校验。
		throw new Error(
			"Authoritative schema (PI_WORKFLOW_SCHEMA) is boolean true (accept-all), "
				+ "provides no shape constraint. 👉 改为带 type/properties/items 的 object schema。",
		);
	}

	if (isRecord(schema) && !hasSchemaKeyword(schema)) {
		// ERR-3 上移：keyword-less 对象会被编译成 accept-all，workflow 声明的约束静默失效。
		throw new Error(
			"Authoritative schema (PI_WORKFLOW_SCHEMA) has no recognized keyword. "
				+ "A workflow schema must describe shape via type/properties/items/... "
				+ "👉 检查 workflow 脚本的 outputSchema 定义，补全 JSON Schema 关键字。 "
				+ `Received schema=${echo(schema)}`,
		);
	}

	const isObjectRoot = isObjectRootSchema(schema);
	const isBareObjectRoot = isBareObjectRootSchema(schema);

	// D4：根级 additionalProperties 未声明时注入 false；作者显式声明（true / 子 schema）
	// 尊重不动。堵输出污染：旧双参数 envelope 把模型习惯携带的 schema 隔离在专用参数里，
	// 单参数后该习惯会直接混进 arguments（事故证明 deepseek 类模型有强烈携带倾向），
	// 参数层显式拒绝并让模型自修正，优于静默剥离。嵌套层级宽严完全由作者 schema 自治。
	// P6：非 object 根（array / string / boolean / 组合根等）包一层 {value}——tool call
	// arguments 协议上必须是 object。包装/解包判定与 execute 同源（isObjectRootSchema）。
	const parameters = isObjectRoot
		? Type.Unsafe<Record<string, unknown>>({
				...schema,
				// type 数组根（如 ["object","null"]）收敛为字符串 "object"：顶层 type 序列化为
				// 数组会被严格 OpenAI 兼容网关按 C-ext-03 立约动机整会话 400；且 arguments
				// 协议上恒为 object，"null" 成员本就不可达，含 object 成员时收敛语义无损。
				...(Array.isArray(schema.type) && schema.type.includes("object") ? { type: "object" } : {}),
				additionalProperties: schema.additionalProperties ?? false,
			})
		: Type.Unsafe<{ value: unknown }>({
				type: "object",
				properties: { value: schema },
				required: ["value"],
				additionalProperties: false,
			});

	return {
		name: TOOL_NAME,
		label: "Structured Output",
		// 根类型条件化（与上方 parameters 包装判定同一 isObjectRootSchema，天然同源）。
		// 保持内联 ternary + 公共尾部：prompt-quality.test.ts 按源码拼接文本断言，
		// object 根口径字面量被逐字锁定，抽出辅助函数会破坏提取与锁定。
		description:
			(isObjectRoot
				// object 根：arguments 即 data。
				? "Return the structured result for this task. Your arguments ARE the data; "
					+ "they are validated against this schema — this tool's parameter schema IS the required shape of your result."
				// 非 object 根：参数层实际是 {value} 包装（P6），直传裸值必首调失败，
				// 必须显式告知包装契约；value. 错误路径前缀一并在首读时说明（参数层
				// 错误文案无改写通道，指引只能前置携带）。
				: "Return the structured result for this task. Your single argument must be an object "
					+ "`{value: <data>}` — put the result itself in `value`, and it must conform to this schema. "
					+ "Non-object schemas are wrapped in a `value` field because tool call arguments must be objects. "
					+ "Validation errors may reference paths starting with `value.` (e.g. `value.0`, `value.name`): "
					+ "that prefix addresses the wrapper, not your data — strip it to locate the offending field.")
			// 裸 object：D4 注入后 parameters 只接受空对象，首读即警示，避免模型
			// 携带字段反复撞校验。
			+ (isBareObjectRoot
				? "\n\nNote: this schema accepts only an empty object {}; any fields will be rejected."
				: "")
			+ "\n\nDo not output the result as text — call this tool instead.\n"
			+ "If validation fails, the error names the fields that failed: "
			+ "fix those fields to match this tool's parameter schema and call the tool again.",
		parameters,
		async execute(_toolCallId: string, params: unknown) {
			// D2 透传：pi-ai 参数层已按上面的 parameters（= 权威 schema）校验 + 类型矫正过
			// arguments，execute 不做第二校验（第二校验权威是方案 A 明令禁止的形态）。
			// 非 object 根的 {value} 解包由 executeStructuredOutput 的 workflow 分支按
			// 「根是否 object」对称完成（与注册期包装判定同一函数 isObjectRootSchema）。
			return executeStructuredOutput({ data: params, authoritativeSchema: schema });
		},
	};
}

/**
 * 裸 object 根检测：object 形态但无任何属性约束（无 properties/patternProperties/
 * required/minProperties/maxProperties，且未显式声明 additionalProperties）。该形态经
 * D4 注入 false 后 parameters 只接受空对象 {}。注册期静态可判定 → description 显式警示。
 * minProperties/maxProperties 也构成约束（F2）：{type:object,minProperties:1} 连空对象
 * 都拒绝，警示「只接受空对象」反而误导——同 required 一样交由参数层校验错误自然暴露。
 */
function isBareObjectRootSchema(schema: unknown): boolean {
	if (!isObjectRootSchema(schema)) return false;
	return !("properties" in schema)
		&& !("patternProperties" in schema)
		&& !("required" in schema)
		&& !("minProperties" in schema)
		&& !("maxProperties" in schema)
		&& !("additionalProperties" in schema);
}

// ── Daily variant (self-reported {schema, data}, unchanged behavior) ──

export function createDailyToolDefinition() {
	return {
		name: TOOL_NAME,
		label: "Structured Output",
		description:
			"Return structured output validated against a JSON Schema. "
			+ "Call this tool to produce validated JSON data. "
			+ "Pass `schema` (a JSON Schema draft-07 object) and `data` (the value to validate). "
			+ "schema describes the shape; data fills the values; they must match.\n\n"
			+ `✅ Correct (full call): ${TOOL_NAME}({schema:{type:'object',properties:{name:{type:'string'},age:{type:'number'}},required:['name']}, data:{name:'Alice',age:30}})\n`
			+ "✅ Correct: schema={type:'array',items:{type:'string'}}, data=['a','b','c']\n"
			+ "✅ Correct: schema={type:'string',enum:['low','medium','high']}, data='medium'\n"
			+ "✅ Correct: schema={type:'number',minimum:0,maximum:100}, data=42\n"
			+ "✅ Correct: schema={type:'boolean'}, data=true\n\n"
			+ "❌ Wrong: putting the answer in text instead of calling this tool\n"
			+ "❌ Wrong: data not matching schema (e.g. schema requires number but data is string)\n"
			+ "❌ Wrong: schema={type:'object'} with data='hello' (string ≠ object)\n"
			+ `❌ Wrong: ${TOOL_NAME}({name:'Alice'}) — missing the schema/data envelope. Wrap as {schema:{...}, data:{name:'Alice'}}.\n`
			+ "❌ Wrong: swapping schema and data (passing the answer as schema). The tool detects this as 'likely swapped' and rejects it.\n"
			+ "❌ Wrong: merging schema and data into one object.\n"
			+ "❌ Wrong: schema with no recognized JSON Schema keyword (e.g. {} or {answer:42}). The schema must describe shape via draft-07 keywords (type/properties/items/if-then-else/enum/...); a keyword-less object is rejected to prevent silent accept-all compilation.",
		promptSnippet:
			"Use structured-output to return validated JSON data. "
			+ "Pass schema (JSON Schema draft-07) and data (your output). "
			+ "Example: {schema:{type:'object',properties:{score:{type:'number'}},required:['score']}, data:{score:8}}",
		promptGuidelines: [
			"schema must be a valid JSON Schema (draft-07). data must conform to it.",
			"Both primitive types (string, number, boolean) and complex types (object, array) are valid schema roots.",
			"Do not output JSON in text — call this tool instead.",
		],
		parameters: Type.Object({
			schema: Type.Unknown({
				description: "JSON Schema draft-07 object. Example: {type:'object',properties:{name:{type:'string'}},required:['name']}",
			}),
			data: Type.Unknown({
				description: "The value to validate against schema. Example: {name:'Alice'}",
			}),
		}),
		async execute(
			_toolCallId: string,
			params: { schema: unknown; data: unknown },
		) {
			// 运行假设：workflow 子进程是单 session 进程（由 applySchemaEnvToChildEnv 在
			// session-runner 注入 PI_WORKFLOW_SCHEMA）。装配分岔下日常变体注册时 env 为空，
			// 但桥接判定保留（ENV_SCHEMA 存在 = workflow 模式）：env 有值时注入
			// authoritativeSchema 走 execute 的 workflow 透传分支。
			// 判空用 `|| undefined` 归一空串为 undefined（truthy 语义），与 entry 的
			// `if (schemaEnv)` 统一：空串 env 视为未设置。
			const authoritativeSchema = process.env[ENV_SCHEMA] || undefined;
			return executeStructuredOutput(
				authoritativeSchema !== undefined
					? { ...params, authoritativeSchema }
					: params,
			);
		},
	};
}
