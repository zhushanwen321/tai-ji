// guards.ts — 运行时形状守卫（读侧不信任外部格式；替代到全可选类型的结构断言）。

/** 普通对象判定（非 null/非数组）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
