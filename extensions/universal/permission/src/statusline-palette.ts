// statusline-palette.ts
//
// permission footer renderer 的色彩映射工具。
// 把 Pi Theme 的语义色 API（theme.fg(token, text)）包装为字符串着色器接口，
// 便于纯函数渲染与单测。语义与 pi-statusline（~/Code/pi-statusline）的 Pallet 对齐。

/** 语义色 token 到字符串着色器的映射（与 pi-statusline 的 Pallet 对齐）。 */
export interface PermissionPalette {
	/** dim 文本（次要信息） */
	dim(s: string): string;
	/** 主文本 */
	text(s: string): string;
	/** accent（模式标签高亮） */
	accent(s: string): string;
	/** success（enabled 状态） */
	success(s: string): string;
	/** warning（disabled 状态） */
	warning(s: string): string;
}

/**
 * 从 Pi Theme 构造 PermissionPalette（生产用）。
 *
 * theme.fg(token, text) 是 Pi 的语义着色 API（token 如 "dim"/"text"/"success"）。
 * 本地包装为 PermissionPalette 接口，便于 footer renderer 与测试共用纯函数。
 *
 * @param theme Pi Theme 对象（需含 fg 函数）。不由 ctx.ui.theme 提供——由 pi-statusline
 *     每次 render 时经 render(ctx, theme) 第二参传入（见 index.ts footer renderer 装配）。
 */
export function paletteFromTheme(theme: { fg(token: string, text: string): string }): PermissionPalette {
	return {
		dim: (s) => theme.fg("dim", s),
		text: (s) => theme.fg("text", s),
		accent: (s) => theme.fg("accent", s),
		success: (s) => theme.fg("success", s),
		warning: (s) => theme.fg("warning", s),
	};
}
