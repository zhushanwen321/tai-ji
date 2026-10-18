/**
 * Mock for typebox (typebox)
 * 仅覆盖 pending-notifications 用到的 Type 方法（Type.Object / Type.Union /
 * Type.Literal / Type.Array / Type.Optional / Type.String / Type.Number）。
 * 真实类型校验由 Pi 运行时提供。
 */
export const Type = {
	Object: (properties: Record<string, unknown>, _options?: Record<string, unknown>) => ({
		type: "object",
		properties,
	}),
	Union: (members: unknown[], _options?: Record<string, unknown>) => ({
		type: "union",
		anyOf: members,
	}),
	Literal: (value: unknown) => ({ type: "literal", const: value }),
	Array: (items: unknown, _options?: Record<string, unknown>) => ({
		type: "array",
		items,
	}),
	String: (_options?: Record<string, unknown>) => ({ type: "string" }),
	Number: (_options?: Record<string, unknown>) => ({ type: "number" }),
	Optional: (schema: unknown) => schema,
};

export type Static<_T> = unknown;
