/**
 * Ajv 编译缓存 — 纯逻辑叶节点（零业务依赖）。
 *
 * 从 index.ts 拆出：WeakMap 缓存 + getOrCompileValidator 编译入口。
 * schema 对象引用即缓存 key（WeakMap 不强引用，GC 友好）；
 * boolean 根 schema 不缓存（见下注释）。
 */

import Ajv, { type ValidateFunction } from "ajv";

// ── Ajv WeakMap cache ─────────────────────────────────────────
const ajvCache = new WeakMap<object, ValidateFunction>();

export function getOrCompileValidator(schema: Record<string, unknown> | boolean): ValidateFunction {
	// boolean 根 schema（true=接受一切，false=拒绝一切）是合法 draft-07，
	// 但 boolean 不能做 WeakMap key，故不缓存（编译结果恒定，重复编译无副作用）。
	if (typeof schema === "boolean") {
		return new Ajv({ strict: false }).compile(schema);
	}
	const cached = ajvCache.get(schema);
	if (cached) return cached;

	const ajv = new Ajv({ strict: false });
	const validate = ajv.compile(schema);
	ajvCache.set(schema, validate);
	return validate;
}
