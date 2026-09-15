/**
 * successCriteria 逐条校验（adapters 层双通道共享，DRY）：
 * - slash 通道：/goal update --criteria（command-adapter.ts handleUpdate）
 * - tool 通道：goal_control create（goal-control-adapter.ts requireCreateSuccessCriteria）
 *
 * 三条校验规则（typeof string / trim 非空 / 单行）与错误消息前半句在两通道逐字一致；
 * 「Correct:」恢复正例经 CriteriaUsageHints 参数化——notString/empty 两通道都是 JSON 形式
 * （action 字段区分 update/create），仅 multiline 的 Correct 正例随通道不同
 * （slash 用法提示 vs tool JSON 正例）。校验顺序与错误文案与折叠前完全一致。
 */

/** 各通道的恢复正例（「Correct:」之后的部分） */
export interface CriteriaUsageHints {
	/** 非 string 元素错误的 Correct: 正例 */
	notString: string;
	/** 空串项错误的 Correct: 正例 */
	empty: string;
	/** 单行校验错误的 Split 说明 + Correct: 正例 */
	multiline: string;
}

/** slash 通道（/goal update）正例 */
export const CRITERIA_HINTS_SLASH: CriteriaUsageHints = {
	notString: '{"action":"update","objective":"...","successCriteria":["<condition 1>","<condition 2>"]}',
	empty: '{"action":"update","objective":"...","successCriteria":["tests pass","tsc clean"]}',
	multiline:
		'Split multi-line text into separate semicolon-separated items, one condition per item. Correct: /goal update <objective> --criteria "line 1; line 2"',
};

/** tool 通道（goal_control create）正例 */
export const CRITERIA_HINTS_TOOL: CriteriaUsageHints = {
	notString: '{"action":"create","objective":"...","successCriteria":["<condition 1>","<condition 2>"]}',
	empty: '{"action":"create","objective":"...","successCriteria":["tests pass","tsc clean"]}',
	multiline:
		'Split multi-line text into separate array items, one condition per item. Correct: {"action":"create","objective":"...","successCriteria":["line 1","line 2"]}',
};

/**
 * 逐条校验并归一（trim），任一条非法即 throw（校验前置语义由调用方保证：
 * mutate state 之前调用，任一条目非法时 state 不动）。
 *
 * 运行时 typeof 防御（U28②）：测试/直调可能绕过 schema 传脏元素，
 * 此处给业务错误而非让下方 .trim() 抛 TypeError。
 * 换行校验（U7）：/[\r\n]/ 覆盖 \n / \r\n / \r 三形态，schema pattern ^[^\r\n]+$ 的 handler 兜底。
 */
export function validateSuccessCriteriaItems(
	items: readonly unknown[],
	hints: CriteriaUsageHints,
): string[] {
	const validated: string[] = [];
	for (const item of items) {
		if (typeof item !== "string") {
			throw new Error(
				`'successCriteria' must be an array of strings. Correct: ${hints.notString}`,
			);
		}
		const trimmed = item.trim();
		if (!trimmed) {
			throw new Error(
				`'successCriteria' items must not be empty. Each condition should be a short, single-line, checkable statement. Correct: ${hints.empty}`,
			);
		}
		if (/[\r\n]/.test(trimmed)) {
			throw new Error(
				`'successCriteria' items must be single-line (no line breaks). ${hints.multiline}`,
			);
		}
		validated.push(trimmed);
	}
	return validated;
}
