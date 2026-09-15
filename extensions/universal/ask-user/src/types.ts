// src/types.ts
import { type Static, Type } from "typebox";

// ── 常量 ─────────────────────────────────────────────
export const OTHER_LABEL = "Other";
export const HEADER_MAX_CHARS = 12;
/** question 文本长度上限：保证 details.answers 的 key 有界、可预测（spec FR-2） */
export const QUESTION_MAX_CHARS = 1000;
export const SPLIT_PANE_MIN_WIDTH = 84;
export const SPLIT_PANE_SEPARATOR = " │ ";
export const SPLIT_PANE_LEFT_MIN = 32;
export const SPLIT_PANE_RIGHT_MIN = 28;

// ── Input schema（LLM 调用参数） ─────────────────────
// description 用英文：这些字符串会进 LLM 的 tool schema，英文更利于模型理解。
export const OptionSchema = Type.Object({
	label: Type.String({
		description:
			"Short, mutually exclusive option label (also the answer value returned to the LLM — keep it concise, ≤ ~40 chars). To recommend an option, prefix its label with '(Recommended)' and list it first.",
	}),
	description: Type.Optional(
		Type.String({
			description:
				"Short rationale shown under the label and in the split-pane preview. Helps the user decide — explain the tradeoff, don't restate the label.",
		}),
	),
});

export const QuestionSchema = Type.Object({
	question: Type.String({
		description:
			"Full question text. Must be one self-contained decision; avoid multi-part questions. ≤1000 chars; plain single-line text only (no newlines or control characters).",
	}),
	header: Type.Optional(
		Type.String({
			description:
				"Tab label, <=12 chars, required when questions.length > 1. Omit for a single question.",
		}),
	),
	context: Type.Optional(Type.String({ description: "Short context summary shown above the question. Pass what you learned from read/grep so the user can answer without re-explaining." })),
	options: Type.Array(OptionSchema, {
		minItems: 2,
		maxItems: 4,
		description: "2-4 mutually exclusive options. Each must be a defensible standalone answer; do NOT include an 'Other' option — it is added automatically.",
	}),
	multiSelect: Type.Optional(
		Type.Boolean({ description: "Default false. Set true only when more than one option can validly apply simultaneously; otherwise leave false for a single best answer." }),
	),
});

/**
 * LLM-facing input schema (宽松版 options 元素)。
 *
 * options 元素故意放宽为 `OptionSchema | string`：弱模型最高频误用是把 options
 * 当字符串数组传（`"options":["A","B"]`）。严格 schema 会让 Pi 运行时的 typebox
 * TypeCompiler.Check 直接拦截（干报错 "must be object"），根本进不了 validateInput
 * 的友好文案。这里放宽让 string 元素通过 schema 层、抵达 validateInput，由它返回带
 * Correct 正例的纠正错误（runtime 友好纠错）。
 *
 * 字段描述复用 QuestionSchema.properties（只覆盖 options 数组元素类型），避免描述
 * 双份维护。Static 派生的 InputQuestion.options 是 `(Option | string)[]`，让
 * validateInput 里的 `typeof opt === "string"` 检查在 TS 层 sound（而非死分支）。
 * 通过 validateInput 后，运行时已保证无 string，index.ts 以 `as Question[]` 收窄使用。
 */
const inputOptionElement = Type.Union([OptionSchema, Type.String()]);

export const InputSchema = Type.Object({
	questions: Type.Array(
		Type.Object({
			...QuestionSchema.properties,
			options: Type.Array(inputOptionElement, {
				minItems: 2,
				maxItems: 4,
				description:
					"2-4 mutually exclusive options. Each must be a {label, description} OBJECT, never a bare string; do NOT include an 'Other' option — it is added automatically.",
			}),
		}),
		{
			minItems: 1,
			maxItems: 4,
			description: "1-4 questions, each a single decision. Batch only related decisions that the user should resolve together; otherwise ask the most important one alone.",
		},
	),
});

// ── 派生类型 ─────────────────────────────────────────
export type Option = Static<typeof OptionSchema>;
/** 内部使用的严格 question 形状（options 为干净 Option[]）。validateInput 通过后使用。 */
export type Question = Static<typeof QuestionSchema>;
/** LLM 入参 question 形状：options 可能含 string 误用，validateInput 负责友好拦截。 */
export type InputQuestion = Static<typeof InputSchema>["questions"][number];

// ── 结构化答案模型（details.answers 的值形态） ─────────
// selected = 选中的 option label 数组（单选长度 0/1，多选任意；不含 Other 文本）；
// other = Other 自由文本（null=未输入）。answers 的 key = question 全文。
export const AnswerValueSchema = Type.Object({
	selected: Type.Array(Type.String()),
	other: Type.Union([Type.String(), Type.Null()]),
});

export type AnswerValue = Static<typeof AnswerValueSchema>;

// ── Result schema（details，renderResult 数据源） ─────
export const ResultSchema = Type.Object({
	questions: Type.Array(QuestionSchema),
	answers: Type.Record(Type.String(), AnswerValueSchema),
	cancelled: Type.Boolean(),
});

export type Result = Static<typeof ResultSchema>;

/**
 * execute 返回的 details 形状：正常/取消/校验失败都复用 Result。
 * 错误路径已全部改为 throw（W4）——pi 对 throw 生成 isError:true 且 details 为空对象，
 * 不存在「错误 details」形态；曾有的 ErrorDetails 死类型随不可达分支一并删除。
 */
export type AskUserDetails = Result;

// ── 跨模块共享的交互状态类型 ─────────────────────────
// 放这里（而非 component.ts）是为了让 question-view.ts / submit-view.ts
// 这两个纯渲染函数只依赖 types.ts，不反向依赖 component.ts（消除循环依赖）。

/** TUI 颜色主题的最小接口（满足真实 Theme 和测试 stub） */
export interface ThemeLike {
	fg(token: string, text: string): string;
	bg(token: string, text: string): string;
	bold(text: string): string;
}

/** 单问题的交互模式 */
export type QuestionMode = "options" | "freeform";

/** 单问题的交互状态（每问题一个实例） */
export interface QuestionState {
	/** 光标位置（高亮的选项，≠ 已选答案） */
	cursorIndex: number;
	/** 单选：显式选中的选项 index；null=未选 */
	selectedIndex: number | null;
	/** 多选：已 toggle 的选项 index 集合 */
	selectedIndices: Set<number>;
	/** 是否已确认（Submit 门的条件） */
	confirmed: boolean;
	/** Other 自由文本答案；null=未输入 */
	freeTextValue: string | null;
	/** freeform Esc 保存的未提交草稿；null=无草稿。
	 *  与 freeTextValue（已提交答案）分离，避免放弃的草稿污染答案、触发 auto-confirm。 */
	freeDraft: string | null;
	/** 当前交互模式 */
	mode: QuestionMode;
	/** 编辑器草稿文本（每问题独立持有，进编辑器时预填、退出时清空） */
	draftText: string;
	/** 进入编辑器前保存的 options 光标位置（退出编辑器时恢复） */
	savedOptionsCursorIndex: number;
}

/** 创建初始 QuestionState */
export function createQuestionState(): QuestionState {
	return {
		cursorIndex: 0,
		selectedIndex: null,
		selectedIndices: new Set<number>(),
		confirmed: false,
		freeTextValue: null,
		freeDraft: null,
		mode: "options",
		draftText: "",
		savedOptionsCursorIndex: 0,
	};
}

// ── UTF-16 surrogate pair 工具（编辑器光标移动/删除/渲染共用） ──
/** 高代理位掩码：charCode & 0xFC00 === 0xD800 判定 surrogate pair 前半 */
export const SURROGATE_HIGH_MASK = 0xFC00;
/** 高代理起始码点（surrogate pair 前半的判定值） */
export const SURROGATE_HIGH_START = 0xD800;
/** 一个 surrogate pair 占用的 UTF-16 code unit 数 */
export const SURROGATE_PAIR_LEN = 2;

/** 检查 s[i] 是否是 UTF-16 高代理（surrogate pair 的前半部分） */
export function isHighSurrogate(s: string, i: number): boolean {
	return (s.charCodeAt(i) & SURROGATE_HIGH_MASK) === SURROGATE_HIGH_START;
}
