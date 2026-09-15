/**
 * 压缩 prompt 工程（D13-6/7/8/9/12 + D12 same-model 压缩指令）。
 *
 * 全部为纯常量/纯函数。措辞吸收自 Claude Code / Codex / deepseek-harness（附录 B 吸收记录），
 * 实施期按摘要质量迭代（§5.3-3）。
 */

/** 落回包裹语（D13-9）：消除压缩后"确认收到摘要"的浪费回合。 */
export const CHECKPOINT_PREAMBLE =
	"This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.";

/** same-model 压缩指令的结构化模板（D13-7：pi 原生 6 节 + Files and Code + Errors and Fixes）。 */
const CHECKPOINT_TEMPLATE = `## Goal
- [the user's original and evolving goals; quote verbatim where the exact wording matters]

## Constraints & Preferences
- [constraints, conventions, and user preferences in play]

## Progress
- Done: [completed work with verification status]
- In Progress: [what was underway at this checkpoint]
- Blocked: [blocked items and why]

## Key Decisions
- [decisions made and their rationale]

## Files and Code
- [exact path: why it matters, key changes or snippets]

## Errors and Fixes
- [error: how it was resolved, plus any related user feedback/corrections]

## Next Steps
- [the single next action, directly in line with the most recent request, or "(none)"]

## Critical Context
- [data, examples, or references needed to continue]`;

/**
 * same-model 模式的压缩指令 user message（追加在完整上下文末尾，D12）。
 *
 * - 首尾 TEXT ONLY 双保险（D13-6，防模型在压缩调用里乱调工具）
 * - 先验 checkpoint 合并规则（D13-8，输入里已有上次摘要时：不逐字复制、保留仍真、丢弃过时）
 * - custom_instructions（agent 的重点关注）非空时追加
 */
export function buildSameModelInstruction(customInstructions?: string): string {
	const prior = `If the conversation above already contains a checkpoint summary from an earlier compaction, do NOT copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated checkpoint under the same structure.`;
	const focus = customInstructions?.trim()
		? `\n\nAdditional focus from the calling agent (weight these higher):\n${customInstructions.trim()}`
		: "";
	return [
		`CRITICAL: Respond with TEXT ONLY. Do NOT call any tools. This is a compaction request.`,
		``,
		`You are now acting as a compaction engine for this AI coding session. Condense the conversation ABOVE into a structured checkpoint that lets the next model turn resume the work with no loss of essential context.`,
		``,
		prior,
		``,
		`Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section. Preserve exact file paths, commands, error strings, identifiers, numeric values, and function signatures.`,
		``,
		CHECKPOINT_TEMPLATE,
		focus,
		``,
		`REMINDER: Respond with TEXT ONLY. Do NOT call any tools. Output only the checkpoint text.`,
	].join("\n");
}

/** transcript 回查指针（D13-4）：附在 summary 末尾。 */
export function buildTranscriptPointer(sessionFilePath: string): string {
	return `\n\n<transcript-ref>Need details from before this compaction? Read the full session transcript at: ${sessionFilePath}</transcript-ref>`;
}
