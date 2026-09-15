// src/question-view.ts
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import {
	isHighSurrogate,
	OTHER_LABEL,
	type Question,
	type QuestionState,
	SPLIT_PANE_LEFT_MIN,
	SPLIT_PANE_MIN_WIDTH,
	SPLIT_PANE_RIGHT_MIN,
	SPLIT_PANE_SEPARATOR,
	SURROGATE_PAIR_LEN,
	type ThemeLike,
} from "./types";

const SPLIT_PANE_LEFT_RATIO = 0.42;
const DESCRIPTION_INDENT_MULTI = 10;
const DESCRIPTION_INDENT_SINGLE = 8;
const PREVIEW_MIN_WIDTH = 10;
/** 分屏右列（详情预览）最小行数（左列较短时占位，避免预览区域过矮）。 */
const PREVIEW_MIN_LINES = 8;
const QUESTION_TEXT_MARGIN = 2;

export interface DisplayOption {
	label: string;
	description?: string;
	isOther?: boolean;
}

/** 渲染上下文——收拢 q/state/theme/width 四个总是成对出现的参数。
 *  draftText 从 state.draftText 取（不再重复传递）。 */
export interface RenderContext {
	question: Question;
	state: QuestionState;
	theme: ThemeLike;
	width: number;
	/** 单问题模式（无 Tab 提示）。 */
	isSingle: boolean;
}

/** Other 自由输入 / 已保存预览的软换行行数上限。超出则截断并加省略号。 */
const MAX_EDITOR_LINES = 5;

/**
 * 渲染编辑器文本，光标位置用反色高亮（ANSI SGR 7/27），不占额外列。
 * surrogate pair 安全：光标在高代理前时反色高亮整个 code point（2 个 code unit），
 * 与光标移动/Backspace 的跳过逻辑对称，避免拆散 emoji 导致终端显示替换字符。
 * 光标在文本末尾（超出范围）时反色高亮一个空格占位。
 */
function renderCursorText(text: string, cursorPos: number): string {
	const before = text.slice(0, cursorPos);
	// 光标在高代理前 → 反色高亮整个 surrogate pair
	const charLen = isHighSurrogate(text, cursorPos) ? SURROGATE_PAIR_LEN : 1;
	const charAtCursor = text.slice(cursorPos, cursorPos + charLen) || " ";
	const after = text.slice(cursorPos + charLen);
	return `${before}\x1b[7m${charAtCursor}\x1b[27m${after}`;
}

/**
 * 把一段带样式的文本按 availWidth 软换行输出为多行，最多 maxLines 行。
 * - 首行前缀 lead（如 "> [ ] "），后续行用等宽空格缩进到 input 起始列对齐。
 * - 超过 maxLines：截断到 maxLines 行，并在最后一行末尾用 ellipsis 提示。
 *   此时末行可能已不含末尾光标字符，用 ellipsis 占位表达「还有更多」。
 *
 * @param push      输出回调（通常为带 truncateToWidth 的 add，提供安全兜底）
 * @param lead      首行前缀（含选中标记 / 勾选框）
 * @param content   待换行展示的已样式化文本（可含 ANSI + 末尾反色光标），为空则只输出 lead
 * @param availWidth 单行可用宽度
 * @param maxLines  最多行数
 */
function addWrappedInput(
	push: (s: string) => void,
	lead: string,
	content: string,
	availWidth: number,
	maxLines: number,
): void {
	const avail = Math.max(1, availWidth);
	const indent = " ".repeat(visibleWidth(lead));
	if (content === "") {
		push(lead);
		return;
	}
	let wrapped = wrapTextWithAnsi(content, avail);
	if (wrapped.length > maxLines) {
		wrapped = wrapped.slice(0, maxLines);
		// 最后一行去掉超出，用省略号占位（光标已被省略号取代）
		const lastIdx = wrapped.length - 1;
		wrapped[lastIdx] = truncateToWidth(wrapped[lastIdx]!, Math.max(1, avail - 1), "…");
	}
	for (let i = 0; i < wrapped.length; i++) {
		const seg = wrapped[i]!;
		push(i === 0 ? `${lead}${seg}` : `${indent}${seg}`);
	}
}

/** 在选项数组末尾追加 Other 自由输入项。 */
export function allOptions(q: Question): DisplayOption[] {
	return [...q.options, { label: OTHER_LABEL, isOther: true }];
}

/**
 * 宽终端（≥SPLIT_PANE_MIN_WIDTH）计算左右分屏宽度。窄终端返回 null（单列模式）。
 */
export function getSplitPaneWidths(width: number): { left: number; right: number } | null {
	if (width < SPLIT_PANE_MIN_WIDTH) return null;
	const available = width - SPLIT_PANE_SEPARATOR.length;
	if (available < SPLIT_PANE_LEFT_MIN + SPLIT_PANE_RIGHT_MIN) return null;
	const preferredLeft = Math.floor(available * SPLIT_PANE_LEFT_RATIO);
	const left = Math.max(
		SPLIT_PANE_LEFT_MIN,
		Math.min(preferredLeft, available - SPLIT_PANE_RIGHT_MIN),
	);
	const right = available - left;
	if (right < SPLIT_PANE_RIGHT_MIN) return null;
	return { left, right };
}

/** 编辑器底部操作提示：随实现能力更新（实现偏差 D-005 已支持光标移动）。
 *  反色光标占位已暗示可输入，故突出新增的方向键/移动能力。 */
const EDITOR_HINT = " ←/→ Home/End move · Backspace deletes · Enter submit · Esc back";

/**
 * 构建选项列表行（不含分屏预览）。hideDescriptions 用于分屏模式左列。
 *  freeform 模式下，Other 行**原地**变 [ ] <input> 反色光标（多选）/ <input> 反色光标（单选）。
 * 主函数只留逐行编排：Other / 多选 / 单选三类行各自提取为独立 append helper。
 */
function buildOptionLines(
	ctx: RenderContext,
	hideDescriptions: boolean,
): string[] {
	const { question: q, state, theme: t, width } = ctx;
	const opts = allOptions(q);
	const lines: string[] = [];
	const add = (s: string): void => {
		lines.push(truncateToWidth(s, width));
	};

	for (let i = 0; i < opts.length; i++) {
		const opt = opts[i]!;
		// 编辑器模式下用 savedOptionsCursorIndex 判断选项高亮，cursorIndex 此时是文本光标
		const activeOptionCursor = state.mode === "freeform" ? state.savedOptionsCursorIndex : state.cursorIndex;
		const isSelected = i === activeOptionCursor;
		const prefix = isSelected ? t.fg("accent", ">") : " ";

		if (opt.isOther === true) {
			appendOtherRow(ctx, opt, i, isSelected, prefix, add);
		} else if (q.multiSelect) {
			appendMultiSelectRow(ctx, opt, i, isSelected, prefix, hideDescriptions, add);
		} else {
			appendSingleSelectRow(ctx, opt, i, isSelected, prefix, hideDescriptions, add);
		}
	}
	return lines;
}

/** Other 行：freeform 原地编辑器（反色光标）/ 非 freeform 的 ✓ 标记 + 已保存文本预览。 */
function appendOtherRow(
	ctx: RenderContext,
	opt: DisplayOption,
	index: number,
	isSelected: boolean,
	prefix: string,
	add: (s: string) => void,
): void {
	const { question: q, state, theme: t, width } = ctx;
	const num = index + 1;

	if (state.mode === "freeform") {
		// 标记位宽度必须与普通选项一致，否则编号列错位：
		//   单选 check = 1 列，多选 box = 3 列。
		//   此前单选 freeform 占位用 "  "(2列)、多选非 freeform 用 check(1列)，
		//   两种情况下 Other 编号都与普通选项错位。
		const marker = q.multiSelect ? t.fg("dim", "[ ]") : " ";
		const lead = `${prefix} ${marker} `;
		const avail = Math.max(1, width - visibleWidth(lead));
		// 编号 + 文本，光标用反色高亮当前字符（surrogate pair 安全，不占额外位置）
		const cursorText = renderCursorText(state.draftText, state.cursorIndex);
		const styled = `${t.fg("muted", `${num}. `)}${t.fg("text", cursorText)}`;
		addWrappedInput(add, lead, styled, avail, MAX_EDITOR_LINES);
	} else {
		const hasFreeText = state.freeTextValue !== null;
		const marker = q.multiSelect
			? (hasFreeText ? t.fg("success", "[✓]") : t.fg("dim", "[ ]"))
			: (hasFreeText ? t.fg("success", "✓") : " ");
		const labelColor = isSelected ? "accent" : "text";
		add(`${prefix} ${marker} ${t.fg(labelColor, `${num}. ${opt.label}`)}`);
		if (hasFreeText) {
			// 预览缩进对齐到 label 起始列：prefix + sp + marker + sp + "N." + sp。
			// 随 num 位数与单/多选 marker 宽度动态变化，硬编码会错位。
			const numStr = `${num}.`;
			const lead = " ".repeat(
				visibleWidth(prefix) + 1 + visibleWidth(marker) + 1 + numStr.length + 1,
			);
			const avail = Math.max(1, width - visibleWidth(lead));
			const styled = t.fg("dim", `"${state.freeTextValue ?? ""}"`);
			addWrappedInput(add, lead, styled, avail, MAX_EDITOR_LINES);
		}
	}
}

/** 多选普通选项行：勾选框 + 编号 label + 缩进描述（hideDescriptions 时省略描述）。 */
function appendMultiSelectRow(
	ctx: RenderContext,
	opt: DisplayOption,
	index: number,
	isSelected: boolean,
	prefix: string,
	hideDescriptions: boolean,
	add: (s: string) => void,
): void {
	const { state, theme: t, width } = ctx;
	const checked = state.selectedIndices.has(index);
	const box = checked ? t.fg("accent", "[✓]") : t.fg("dim", "[ ]");
	const labelColor = isSelected ? "accent" : "text";
	const num = index + 1;
	add(`${prefix} ${box} ${t.fg(labelColor, `${num}. ${opt.label}`)}`);
	if (opt.description && !hideDescriptions) {
		const wrapped = wrapTextWithAnsi(t.fg("muted", opt.description), width - DESCRIPTION_INDENT_MULTI);
		for (const line of wrapped) add(`          ${line}`);
	}
}

/** 单选普通选项行：✓ 确认标记 + 编号 label + 缩进描述（hideDescriptions 时省略描述）。 */
function appendSingleSelectRow(
	ctx: RenderContext,
	opt: DisplayOption,
	index: number,
	isSelected: boolean,
	prefix: string,
	hideDescriptions: boolean,
	add: (s: string) => void,
): void {
	const { state, theme: t, width } = ctx;
	const isConfirmed = state.selectedIndex === index;
	const check = isConfirmed ? t.fg("success", "✓") : " ";
	const labelColor = isSelected ? "accent" : "text";
	const num = index + 1;
	add(`${prefix} ${check} ${t.fg(labelColor, `${num}. ${opt.label}`)}`);
	if (opt.description && !hideDescriptions) {
		const wrapped = wrapTextWithAnsi(t.fg("muted", opt.description), width - DESCRIPTION_INDENT_SINGLE);
		for (const line of wrapped) add(`        ${line}`);
	}
}

/** 构建分屏右侧 Markdown 详情预览。 */
function buildPreviewLines(
	ctx: RenderContext,
	maxLines: number,
): string[] {
	const { question: q, state, theme: t, width } = ctx;
	const opts = allOptions(q);
	const opt = opts[state.cursorIndex];
	if (!opt) return [t.fg("dim", "—")];

	let text = "";
	if (opt.isOther) {
		text = `${opt.label}: enter a custom answer not listed above.`;
	} else {
		text = opt.label;
		if (opt.description?.trim()) text += `\n\n${opt.description}`;
	}

	const wrapped = wrapTextWithAnsi(t.fg("muted", text), Math.max(PREVIEW_MIN_WIDTH, width));
	const lines = wrapped.slice(0, maxLines);
	if (wrapped.length > maxLines) lines.push(t.fg("dim", "…"));
	return lines;
}

/** 渲染分屏模式下的左右双列（选项列表 + 详情预览）。 */
function buildSplitPane(
	ctx: RenderContext,
	split: { left: number; right: number },
): string[] {
	const { theme: t, width } = ctx;
	const lines: string[] = [];
	const add = (s: string): void => {
		lines.push(truncateToWidth(s, width));
	};
	const leftCtx: RenderContext = { ...ctx, width: split.left };
	const rightCtx: RenderContext = { ...ctx, width: split.right };
	const leftLines = buildOptionLines(leftCtx, true);
	const rightLines = buildPreviewLines(rightCtx, Math.max(leftLines.length, PREVIEW_MIN_LINES));
	const rowCount = Math.max(leftLines.length, rightLines.length);
	const sep = t.fg("dim", SPLIT_PANE_SEPARATOR);
	for (let i = 0; i < rowCount; i++) {
		const left = truncateToWidth(leftLines[i] ?? "", split.left, "", true);
		const right = truncateToWidth(rightLines[i] ?? "", split.right);
		add(`${left}${sep}${right}`);
	}
	return lines;
}

/**
 * 渲染单个问题视图（spec FR-4）。
 */export function renderQuestionView(ctx: RenderContext): string[] {
	const { question: q, state, theme: t, width, isSingle } = ctx;
	const lines: string[] = [];
	const add = (s: string): void => {
		lines.push(truncateToWidth(s, width));
	};
	const divider = (): void => add(t.fg("dim", "─".repeat(Math.max(0, width))));

	// 问题文本（word-wrap）
	const wrapped = wrapTextWithAnsi(t.fg("text", ` ${q.question}`), width - QUESTION_TEXT_MARGIN);
	for (const line of wrapped) add(line);

	// 上下文（如有）
	if (q.context?.trim()) {
		divider();
		const ctxWrapped = wrapTextWithAnsi(t.fg("muted", q.context), width - QUESTION_TEXT_MARGIN);
		for (const line of ctxWrapped) add(line);
	}

	// 分屏判断
	const split = getSplitPaneWidths(width);

	// 选项模式下：question/context 与 options 之间加分割线（三段式）
	// 编辑器模式不加（编辑器块自带视觉边界）
	if (state.mode !== "freeform") {
		divider();
	}

	// freeform 模式 help 行：光标锁在 Other 上，正在输入；编辑器行前留一个空行与选项列表分开。
	if (state.mode === "freeform") {
		add("");
		for (const line of buildOptionLines(ctx, false)) add(line);
		add("");
		add(t.fg("dim", EDITOR_HINT));
		return lines;
	}

	if (!split) {
		// 单列模式
		for (const line of buildOptionLines(ctx, false)) add(line);
	} else {
		// 分屏模式
		lines.push(...buildSplitPane(ctx, split));
	}

	add("");

	// 帮助行（上下文相关）
	const opts = allOptions(q);
	const onOther = state.cursorIndex === opts.length - 1;
	const tabHint = isSingle ? "" : " · ←/→ switch tabs";
	const actionHint = onOther
		? "Enter open editor"
		: q.multiSelect
			? "Space toggle · Enter confirm"
			: "Enter select";
	add(t.fg("dim", ` ↑↓ navigate · ${actionHint}${tabHint} · Esc back`));

	return lines;
}
