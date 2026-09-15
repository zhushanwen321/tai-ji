// src/submit-view.ts
import { truncateToWidth } from "@earendil-works/pi-tui";

import {
	type AnswerValue,
	HEADER_MAX_CHARS,
	type Question,
	type QuestionState,
	type Result,
	type ThemeLike,
} from "./types";

/** 渲染 [ Submit ]   [ Cancel ] 按钮栏，返回带样式的单行字符串。
 *  focus: null=纯展示（问题 tab footer），"submit"/"cancel"=高亮对应按钮（Submit tab）。
 *  统一了 component.ts footer 版与 submit-view 内嵌版的样式逻辑。 */
export function renderButtonBar(theme: ThemeLike, allDone: boolean, focus: "submit" | "cancel" | null): string {
	const t = theme;
	const isSubmit = focus === "submit";
	const isCancel = focus === "cancel";
	const submit = isSubmit
		? (allDone ? t.fg("success", t.bold(" Submit ")) : t.fg("accent", t.bold(" Submit ")))
		: (allDone ? t.fg("success", " Submit ") : t.fg("dim", " Submit "));
	const cancel = isCancel
		? t.fg("accent", t.bold(" Cancel "))
		: t.fg("muted", " Cancel ");
	return `${t.fg("dim", "[")}${submit}${t.fg("dim", "]")}   ${t.fg("dim", "[")}${cancel}${t.fg("dim", "]")}`;
}

/**
 * 把结构化 AnswerValue 格式化为展示文本（TUI Submit tab / index.ts renderResult 共用）。
 * 规则：selected join(", ")；other 非空时追加 ", ${other}"。
 */
export function answerValueText(v: AnswerValue): string {
	const parts = [...v.selected];
	if (v.other !== null && v.other !== "") parts.push(v.other);
	return parts.join(", ");
}

/**
 * 获取单问题的结构化答案（供 Submit tab 显示）。
 * 返回 null 表示未答。
 */
export function getAnswerText(q: Question, s: QuestionState): AnswerValue | null {
	if (!s.confirmed) return null;
	const selected: string[] = [];
	if (q.multiSelect) {
		const labels = [...s.selectedIndices]
			.sort((a, b) => a - b)
			.map((idx) => q.options[idx]?.label)
			.filter((l): l is string => !!l);
		selected.push(...labels);
	} else if (s.selectedIndex !== null) {
		const label = q.options[s.selectedIndex]?.label;
		if (label) selected.push(label);
	}
	// confirmed 但无任何答案内容（selected 空 && other 空）→ null（未答，buildResult 不写入）
	if (selected.length === 0 && (s.freeTextValue === null || s.freeTextValue === "")) return null;
	return { selected, other: s.freeTextValue };
}

/**
 * 渲染 Submit tab 视图。
 * focus: 当前在 [Submit]/[Cancel] 上的焦点（Tab 切换）。
 *   渲染内嵌按钮栏高亮 focus；help 行更新为 "←/→ navigate · Tab toggle · Enter confirm"。
 */
export function renderSubmitView(
	questions: Question[],
	states: QuestionState[],
	theme: ThemeLike,
	width: number,
	focus: "submit" | "cancel" = "submit",
): string[] {
	const t = theme;
	const lines: string[] = [];
	const add = (s: string): void => {
		lines.push(truncateToWidth(s, width));
	};

	const allDone = states.every((s) => s.confirmed);

	add(
		allDone
			? t.fg("success", t.bold(" Ready to submit"))
			: t.fg("warning", t.bold(" Unanswered questions")),
	);
	add("");

	for (let i = 0; i < questions.length; i++) {
		const q = questions[i]!;
		const answer = getAnswerText(q, states[i]!);
		const headerLabel = truncateToWidth(q.header ?? "", HEADER_MAX_CHARS);
		if (answer !== null) {
			add(` ${t.fg("muted", `${headerLabel}: `)}${t.fg("text", answerValueText(answer))}`);
		} else {
			add(` ${t.fg("dim", `${headerLabel}: `)}${t.fg("warning", "—")}`);
		}
	}

	add("");
	if (allDone) {
		add(t.fg("success", " All questions answered"));
	} else {
		const missing = questions
			.filter((_, i) => !states[i]!.confirmed)
			.map((q) => truncateToWidth(q.header ?? "", HEADER_MAX_CHARS))
			.join(", ");
		add(t.fg("warning", ` Still needed: ${missing}`));
	}

	// 内嵌按钮栏：[ Submit ]   [ Cancel ]，根据 focus 高亮
	add("");
	add(renderButtonBar(t, allDone, focus));

	// Submit tab 帮助行
	add("");
	add(t.fg("dim", " ←/→ navigate · Tab toggle Submit/Cancel · Enter confirm · Esc back"));

	return lines;
}

/**
 * 从 states 构建 Result（供组件 buildResult 调用）。
 */
export function buildResult(questions: Question[], states: QuestionState[]): Result {
	const answers: Record<string, AnswerValue> = {};
	for (let i = 0; i < questions.length; i++) {
		const q = questions[i]!;
		const s = states[i]!;
		const answer = getAnswerText(q, s);
		if (answer !== null) answers[q.question] = answer;
	}
	return { questions, answers, cancelled: false };
}
