/**
 * Mock for typebox
 *
 * structured-output 用 Type.Object / Type.Unknown 构造日常变体参数 schema，
 * 用 Type.Unsafe 把普通 JSON schema（workflow 权威 schema）包装为 TSchema
 * （U1：真实 Type.Unsafe 返回 schema 本身 + Kind 符号；JSON 序列化视角等价，
 * mock 直接返回原对象即可覆盖测试断言）。
 */
export const Type = {
	Object: (properties: Record<string, unknown>, _options?: Record<string, unknown>) =>
		({ type: "object", properties }),
	String: (_options?: Record<string, unknown>) => ({ type: "string" }),
	Optional: (schema: unknown) => ({ ...(schema as Record<string, unknown>), optional: true }),
	Unknown: (_options?: Record<string, unknown>) => ({ type: "unknown" }),
	Unsafe: <T>(schema: T) => schema,
};
export type Static<_T> = unknown;
