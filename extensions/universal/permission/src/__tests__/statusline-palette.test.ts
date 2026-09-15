/**
 * statusline-palette.test.ts — paletteFromTheme 适配函数单测。
 *
 * paletteFromTheme 是纯适配函数：把 Pi Theme 的 theme.fg(token, text) 语义着色 API
 * 包装为 PermissionPalette 的 5 个字符串着色器（dim/text/accent/success/warning）。
 * 本测试记录 fg 调用参数，断言每个着色器转发正确的 token + 原始字符串，
 * 避免后续重构拼错 token（如 "succes"）时静默丢失色彩。
 */
import { describe, expect, it, vi } from "vitest";

import { paletteFromTheme } from "../statusline-palette.js";

/** 构造 mock theme：fg 是 spy，记录 (token, text) 调用并原样返回 text。 */
function makeMockTheme(): {
	theme: { fg: (token: string, text: string) => string };
	fg: ReturnType<typeof vi.fn>;
} {
	const fg = vi.fn((_token: string, text: string): string => text);
	return { theme: { fg }, fg };
}

describe("paletteFromTheme", () => {
	it("dim → theme.fg('dim', s)", () => {
		const { theme, fg } = makeMockTheme();
		const palette = paletteFromTheme(theme);
		const result = palette.dim("muted text");
		expect(result).toBe("muted text");
		expect(fg).toHaveBeenCalledWith("dim", "muted text");
	});

	it("text → theme.fg('text', s)", () => {
		const { theme, fg } = makeMockTheme();
		const palette = paletteFromTheme(theme);
		const result = palette.text("main body");
		expect(result).toBe("main body");
		expect(fg).toHaveBeenCalledWith("text", "main body");
	});

	it("accent → theme.fg('accent', s)", () => {
		const { theme, fg } = makeMockTheme();
		const palette = paletteFromTheme(theme);
		const result = palette.accent("Auto");
		expect(result).toBe("Auto");
		expect(fg).toHaveBeenCalledWith("accent", "Auto");
	});

	it("success → theme.fg('success', s)", () => {
		const { theme, fg } = makeMockTheme();
		const palette = paletteFromTheme(theme);
		const result = palette.success("enabled");
		expect(result).toBe("enabled");
		// 关键断言：token 必须是完整的 "success"（防止拼错成 "succes"）
		expect(fg).toHaveBeenCalledWith("success", "enabled");
	});

	it("warning → theme.fg('warning', s)", () => {
		const { theme, fg } = makeMockTheme();
		const palette = paletteFromTheme(theme);
		const result = palette.warning("disabled");
		expect(result).toBe("disabled");
		expect(fg).toHaveBeenCalledWith("warning", "disabled");
	});

	it("五个着色器各自转发正确的 token（全量校验，防 token 漂移）", () => {
		const { theme, fg } = makeMockTheme();
		const palette = paletteFromTheme(theme);
		palette.dim("a");
		palette.text("b");
		palette.accent("c");
		palette.success("d");
		palette.warning("e");
		expect(fg).toHaveBeenNthCalledWith(1, "dim", "a");
		expect(fg).toHaveBeenNthCalledWith(2, "text", "b");
		expect(fg).toHaveBeenNthCalledWith(3, "accent", "c");
		expect(fg).toHaveBeenNthCalledWith(4, "success", "d");
		expect(fg).toHaveBeenNthCalledWith(5, "warning", "e");
		expect(fg).toHaveBeenCalledTimes(5);
	});

	it("返回值是 theme.fg 的返回值（透传，不做额外加工）", () => {
		const theme = {
			fg: (token: string, text: string): string => `<${token}>${text}</${token}>`,
		};
		const palette = paletteFromTheme(theme);
		expect(palette.dim("x")).toBe("<dim>x</dim>");
		expect(palette.success("y")).toBe("<success>y</success>");
	});
});
