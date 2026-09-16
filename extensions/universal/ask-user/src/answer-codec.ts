// src/answer-codec.ts
// AnswerValue → proto answers 条目的单向序列化（协议边界 SSOT）。
// 与 @zhushanwen/extension-protocol helpers.ts 的解码契约字节级对齐：
//   - 单选：answers[key] = selected[0]
//   - 多选：answers[key] = JSON.stringify(selected)
//   - Other：answers[`${key}__other`] = other
// helpers.ts 的 getAskUserAnswer / getAskUserOther 是输出格式的唯一解码 SSOT。
// 单向 encode，无 parse 对偶（文本反解析已随双模型文本往返删除）。
import type { AnswerValue } from "./types";

/**
 * 把结构化 AnswerValue 序列化为 proto answers 条目。
 *
 * @param value 结构化答案（selected = option label 数组，other = Other 自由文本）
 * @param opts.key 协议 key（header ?? question 全文）
 * @param opts.multiSelect 多选时主 key 写 JSON 数组，单选写首个 label
 * @returns proto answers 条目；selected 空 && other 空/空串 → {}（未答，调用方不写入）
 */
export function encodeAnswer(
	value: AnswerValue,
	opts: { key: string; multiSelect: boolean },
): Record<string, string> {
	const out: Record<string, string> = {};
	if (value.selected.length > 0) {
		out[opts.key] = opts.multiSelect
			? JSON.stringify(value.selected)
			: value.selected[0]!;
	}
	if (value.other !== null && value.other !== "") {
		out[`${opts.key}__other`] = value.other;
	}
	return out;
}
