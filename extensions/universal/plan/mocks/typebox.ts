/**
 * Mock for typebox (typebox)
 *
 * plan 扩展用 Type 定义 tool 参数 schema；运行时仅需形状存在，
 * 真实校验由 Pi 运行时提供。
 */
export const Type = {
	Object: (properties: Record<string, unknown>, _options?: Record<string, unknown>) =>
		({ type: "object", properties }),
	String: (_options?: Record<string, unknown>) => ({ type: "string" }),
	Optional: (schema: unknown) => ({ ...(schema as Record<string, unknown>), optional: true }),
	Number: (_options?: Record<string, unknown>) => ({ type: "number" }),
	Boolean: (_options?: Record<string, unknown>) => ({ type: "boolean" }),
	Array: (_item: unknown, _options?: Record<string, unknown>) => ({ type: "array" }),
	Record: (_key: unknown, _value: unknown) => ({ type: "object" }),
	Unknown: () => ({ type: "unknown" }),
};
export type Static<_T> = unknown;
