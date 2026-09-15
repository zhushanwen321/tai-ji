/**
 * SelectList 默认主题（model-picker 与 rule-editor 共享单一常量，避免字面量双份漂移）。
 *
 * G2/WR2 修正：selectedPrefix 实现为 `(t) => '▶ ' + t`（非 identity），
 * 选中行有视觉区分（▶ 前缀）。
 */
import type { SelectListTheme } from "@earendil-works/pi-tui";

export const DEFAULT_SELECT_THEME: SelectListTheme = {
	selectedPrefix: (t: string): string => "\u25B6 " + t,
	selectedText: (t: string): string => t,
	description: (t: string): string => t,
	scrollInfo: (t: string): string => t,
	noMatch: (t: string): string => t,
};
