/**
 * Mock for typebox (typebox)
 */
export const Type = {
  Object: (properties: Record<string, unknown>, _options?: Record<string, unknown>) => ({ type: "object", properties }),
  String: (_options?: Record<string, unknown>) => ({ type: "string" }),
  Optional: (schema: unknown) => ({ ...(schema as Record<string, unknown>), optional: true }),
  Number: (_options?: Record<string, unknown>) => ({ type: "number" }),
  Record: (_key: unknown, _value: unknown) => ({ type: "object" }),
  Unknown: () => ({ type: "unknown" }),
  Boolean: (_options?: Record<string, unknown>) => ({ type: "boolean" }),
  Array: (_item: unknown, _options?: Record<string, unknown>) => ({ type: "array" }),
  // 跨扩展依赖（@zhushanwen/pi-pending-notifications 的 registerTool schema）需要：
  // Literal/Union 返回可序列化的 schema 对象即可（测试不校验 schema 语义）。
  Literal: (value: unknown) => ({ type: "literal", value }),
  Union: (items: unknown[]) => ({ type: "union", items }),
};
export type Static<_T> = unknown;
