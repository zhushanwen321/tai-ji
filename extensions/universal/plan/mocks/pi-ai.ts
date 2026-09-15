/**
 * Mock for @earendil-works/pi-ai
 *
 * plan 扩展仅用 StringEnum 定义 tool schema，真实类型由 Pi 运行时提供。
 */
export const StringEnum = (values: readonly string[], _options?: Record<string, unknown>) =>
	({ type: "string", enum: [...values] });
