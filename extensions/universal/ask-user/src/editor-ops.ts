// src/editor-ops.ts
// 文本编辑器的纯操作函数——操作 QuestionState.draftText/cursorIndex。
// 从 AskUserComponent 提取，使 component 聚焦于问卷交互（tab 导航/状态转换/渲染编排），
// 不再理解终端转义序列解析和 surrogate pair 细节。
//
// 所有函数直接修改传入的 state（mutation 风格，与调用方 component 的命令式风格一致）。
// 是否产生了变更由返回值表达，调用方据此决定是否 rerender。

import { isHighSurrogate, SURROGATE_PAIR_LEN, type QuestionState } from "./types";

// ── 编辑器纯操作 ──

/** 在光标处插入文本，光标前移 text.length。 */
export function insertAtCursor(state: QuestionState, text: string): void {
	state.draftText = state.draftText.slice(0, state.cursorIndex) + text + state.draftText.slice(state.cursorIndex);
	state.cursorIndex += text.length;
}

/** 删除光标前一个 code point（surrogate pair 时删整个 code point）。
 *  返回 true 表示有删除发生（调用方据此决定是否 invalidate）。 */
export function deleteCharBeforeCursor(state: QuestionState): boolean {
	if (state.cursorIndex <= 0) return false;
	const deleteCount = state.cursorIndex >= SURROGATE_PAIR_LEN && isHighSurrogate(state.draftText, state.cursorIndex - SURROGATE_PAIR_LEN) ? SURROGATE_PAIR_LEN : 1;
	state.draftText = state.draftText.slice(0, state.cursorIndex - deleteCount) + state.draftText.slice(state.cursorIndex);
	state.cursorIndex -= deleteCount;
	return true;
}

/** 光标左移一个 code point（surrogate pair 安全）。不超出 0。 */
export function moveCursorLeft(state: QuestionState): void {
	const newLeft = state.cursorIndex - 1;
	state.cursorIndex = newLeft > 0 && isHighSurrogate(state.draftText, newLeft - 1)
		? newLeft - 1
		: Math.max(0, newLeft);
}

/** 光标右移一个 code point（surrogate pair 安全）。不超出 draftText.length。 */
export function moveCursorRight(state: QuestionState): void {
	state.cursorIndex = isHighSurrogate(state.draftText, state.cursorIndex)
		? Math.min(state.draftText.length, state.cursorIndex + SURROGATE_PAIR_LEN)
		: Math.min(state.draftText.length, state.cursorIndex + 1);
}

/** 光标移到行首。 */
export function moveCursorHome(state: QuestionState): void {
	state.cursorIndex = 0;
}

/** 光标移到行尾。 */
export function moveCursorEnd(state: QuestionState): void {
	state.cursorIndex = state.draftText.length;
}

/** 多字符粘贴 chunk → printable 提取。
 *  排除 bracketed paste 标记，过滤未识别控制序列（OSC/DA/DCS/APC/unknown CSI）。
 *  返回 true 表示有文本插入。
 *  data 整体性由 StdinBuffer 序列拆分保证。 */
export function handleEditorPaste(state: QuestionState, data: string): boolean {
	if (data.startsWith("\x1b") && !data.includes("\x1b[200~") && !data.includes("\x1b[201~")) {
		return false;
	}
	const cleaned = data.replace(/\x1b\[200~|\x1b\[201~/g, "");
	let changed = false;
	// 用 Array.from 正确拆分 emoji/surrogate pairs
	for (const c of Array.from(cleaned)) {
		if (c >= " ") {
			state.draftText = state.draftText.slice(0, state.cursorIndex) + c + state.draftText.slice(state.cursorIndex);
			state.cursorIndex += c.length;
			changed = true;
		}
	}
	return changed;
}
