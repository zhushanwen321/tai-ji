/**
 * Handoff prompt —— agent-driven handoff 的 prompt 构建。
 *
 * 主 session 跑 handoff turn 时发送给 pi 的 prompt 由本文件组装：
 * - HANDOFF_PROMPT_TEMPLATE：基于 ~/.agents/skills/handoff/SKILL.md 改写，
 *   保留全部指令（生成文档 / suggested skills / 不重复 artifact / 脱敏），
 *   改为适合直接作为 prompt 发送的文本。
 * - buildHandoffPrompt：reply 存在时 sanitize 后追加定制后缀。
 * - sanitizeReply：trust boundary 外的 reply 清洗（strip 控制字符 + 折叠空白 + trim + 截断）。
 *
 * 纯函数模块，无副作用，无 import 依赖。
 */

/** reply 截断阈值（来自客户端 payload，trust boundary 外）。 */
export const REPLY_MAX_LENGTH = 5000

/**
 * Handoff turn prompt 模板。
 *
 * 基于 ~/.agents/skills/handoff/SKILL.md 改写：保留 skill 的全部指令
 * （生成文档 / suggested skills / 不重复 artifact / 脱敏），改为适合直接作为
 * prompt 发送给 pi agent 的祈使句文本。
 *
 * S2：不再要求 agent 写文件到 temp 目录——runtime 只从 agent_end 事件提取文本
 * （extractFinalTextFromAgentEnd），写入的文件会被忽略，原指令只会浪费 agent
 * 一次工具调用。改为直接输出文档作回复。
 */
export const HANDOFF_PROMPT_TEMPLATE = `Write a handoff document summarising the current conversation so a fresh agent can continue the work. Output the document directly as your response.

Include a "suggested skills" section in the document, which suggests skills that the agent should invoke.

Do not duplicate content already captured in other artifacts (PRDs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

The handoff document is the only output the next session will receive as its first message, so make it complete and self-contained.`

/**
 * sanitize 客户端传入的 reply（trust boundary 外）。
 *
 * S3：除 CR/LF 外一并 strip 全部控制字符（含 tab / 零宽 / NUL 等，[\x00-\x1F\x7F]
 * 覆盖 C0 控制字符集 + DEL），折叠连续空白防 prompt injection 注入畸形空白，
 * 再 trim + 截断到 REPLY_MAX_LENGTH。控制字符 → 空格（而非删除）保留可读分词。
 */
export function sanitizeReply(reply: string): string {
  return reply
    // 控制字符 → 空格：C0 (U+0000-U+001F) + DEL (U+007F) + C1 (U+0080-U+009F)
    // + zero-width (U+200B-U+200F) + BiDi override (U+202A-U+202E, U+2066-U+2069) + BOM (U+FEFF)
    .replace(/[\x00-\x1F\x7F\u0080-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, ' ')
    .replace(/\s+/g, ' ') // 折叠连续空白（防畸形空白 prompt injection）
    .trim()
    .slice(0, REPLY_MAX_LENGTH)
}

/**
 * 构建 handoff turn prompt。
 *
 * [HISTORICAL] reply 不再拼接到 prompt 末尾。
 * 旧实现把 reply 当成 "The next session will focus on: {reply}" 追加到 prompt，
 * 导致 agent 把用户的开场消息（如 "hi"）当成 handoff 文档的主题词，
 * 生成的文档围绕 "hi" 展开而非真正的对话内容。
 *
 * 修复：prompt 只含模板（指导 agent 生成文档），reply 由 HandoffService
 * 在新 session 注入时作为独立的开场消息追加（wrapWithXmlTag 之后）。
 */
export function buildHandoffPrompt(): string {
  return HANDOFF_PROMPT_TEMPLATE
}
