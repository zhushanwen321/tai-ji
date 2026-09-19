// src/form-adapter.ts
//
// ask-user 包内归一 adapter（设计 ui-presentation-protocol D3：askUserInteract 退役后，
// AskUserQuestion↔FormQuestion 的归一职责从协议包下沉到本包）。
//
// 三种问题形态在此互转（答案编解码不在本模块——FormAnswers 的 choice/text 部分与
// legacy AskUserAnswers 逐字兼容，解码统一走协议包 getAskUserAnswer/getAskUserOther）：
//   internal Question     本包 TUI 组件 + tool details 的形态（options 必填）
//   FormQuestion          统一表单协议 wire 形态（UI_FORM_MARKER + uiFormInteract）
//   legacy AskUserQuestion 旧 npm 子进程经 channel 传入的形态（D9 双读的旧 payload）
//
// 键位规则（设计 D2，与 renderer 归一层 / FormOverlay 逐字对齐）：
// key = header ?? question；多选 value = JSON.stringify(labels[])；
// Other/自由文本答案键 `${key}__other`。
// schedule 问题类型非 ask-user 产生（scheduler 域），Form→本包形态的转换中跳过。

import type {
	AskUserQuestion,
	ChoiceQuestion,
	FormQuestion,
} from "@zhushanwen/extension-protocol";

import type { Option, Question } from "./types";

/** internal Question[] → ChoiceQuestion[]（ask_user 工具的 wire 形态）。
 *  工具 schema 锁 options 必填（minItems 2）→ 恒映射为 choice；multiSelect → multi
 *  重命名（D2）；allowOther 固定 true——ask-user 无条件自动追加 Other，schema 不暴露该字段。 */
export function internalToFormQuestions(questions: Question[]): ChoiceQuestion[] {
	return questions.map((q: Question): ChoiceQuestion => ({
		type: "choice",
		header: q.header,
		question: q.question,
		context: q.context,
		options: q.options.map((o: Option) => ({
			label: o.label,
			description: o.description,
		})),
		multi: q.multiSelect,
		allowOther: true,
	}));
}

/** legacy AskUserQuestion[] → FormQuestion[]（D9 双读的旧 payload 归一）。
 *  有 options → choice（multiSelect → multi）；无 options → text（协议值域完备保留，
 *  答案只写 `${key}__other` 键，与现状纯 other 形态一致）。 */
export function askUserToFormQuestions(legacy: AskUserQuestion[]): FormQuestion[] {
	return legacy.map((q: AskUserQuestion): FormQuestion => {
		if (q.options === undefined) {
			return {
				type: "text",
				header: q.header,
				question: q.question,
				context: q.context,
			};
		}
		return {
			type: "choice",
			header: q.header,
			question: q.question,
			context: q.context,
			options: q.options.map((o) => ({
				label: o.label,
				description: o.description,
			})),
			multi: q.multiSelect,
			allowOther: q.allowOther,
		};
	});
}

/** FormQuestion[] → legacy AskUserQuestion[]（解码视图：复用协议包
 *  getAskUserAnswer/getAskUserOther 的解码 SSOT，multi 还原为 multiSelect）。
 *  保持顺序、跳过 schedule（ask-user 链路不产生；与 formToInternalQuestions 同规则）。 */
export function formToAskUserQuestions(form: FormQuestion[]): AskUserQuestion[] {
	return form.flatMap((q: FormQuestion): AskUserQuestion[] => {
		if (q.type === "schedule") return [];
		const common = {
			header: q.header,
			question: q.question,
			context: q.context,
		};
		return [
			q.type === "choice"
				? {
						...common,
						options: q.options,
						multiSelect: q.multi,
						allowOther: q.allowOther,
					}
				: common,
		];
	});
}

/** FormQuestion[] → internal Question[]（TUI 组件渲染形态）。
 *  choice → options 原样（multiSelect 还原）；text → 空 options（组件渲染为仅 Other
 *  行的自由输入，与旧 payload 无 options 问题的现状处理一致）；schedule 跳过
 *  （防止把草稿题渲染成自由文本框——ask-user channel 不携带该类型）。 */
export function formToInternalQuestions(form: FormQuestion[]): Question[] {
	return form.flatMap((q: FormQuestion): Question[] => {
		if (q.type === "schedule") return [];
		const opts: Option[] =
			q.type === "choice"
				? q.options.map((o) => ({
						label: o.label,
						...(o.description !== undefined ? { description: o.description } : {}),
					}))
				: [];
		return [
			{
				question: q.question,
				...(q.header !== undefined ? { header: q.header } : {}),
				...(q.context !== undefined ? { context: q.context } : {}),
				options: opts,
				...(q.type === "choice" && q.multi !== undefined ? { multiSelect: q.multi } : {}),
			},
		];
	});
}
