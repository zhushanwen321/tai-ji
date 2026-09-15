/**
 * Mock for @earendil-works/pi-tui
 *
 * plan 扩展仅用 Text 作为 renderResult 返回类型；测试不断言渲染输出，
 * 故此处提供最小可构造的 Text 桩。真实类型由 Pi 运行时提供。
 */
export class Text {
	private text: string;

	constructor(text = "") {
		this.text = text;
	}

	setText(text: string): void {
		this.text = text;
	}

	invalidate(): void {}

	render(_width: number): string[] {
		return this.text ? [this.text] : [];
	}
}
