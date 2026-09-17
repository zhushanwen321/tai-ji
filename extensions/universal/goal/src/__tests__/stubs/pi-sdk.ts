/**
 * Pi SDK stub for vitest — 提供运行时 mock，避免 import 真实的 Pi 包
 */

// StringEnum: 返回 values 的 union type 的 runtime 值（简化为第一个元素）
export function StringEnum<T extends readonly string[]>(values: T, _options?: Record<string, unknown>): T[number] {
	return values[0] as T[number];
}

// Text: pi-tui 的渲染节点 stub（goal-control-adapter renderCall/renderResult 返回值）。
// 承载 content 并提供最小 render（原样单行返回）——renderCall 的非法 args 安全渲染
// 测试经它断言渲染文本。
export class Text {
	content: unknown;
	constructor(content: unknown, _x: number, _y: number) {
		this.content = content;
	}
	render(_width: number): string[] {
		return [String(this.content)];
	}
}

// Pi SDK types used in import chains — re-export as empty
export {};
