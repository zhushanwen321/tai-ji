/**
 * Handoff 域共享常量（chat-flow-consistency U9 / 特殊流程 S2）。
 *
 * HANDOFF_PROMPT_TEMPLATE 是 agent-driven handoff 的固定 prompt 模板（原
 * packages/runtime/src/services/handoff-prompt.ts 持有，迁本文件单源）：
 * runtime 发送侧（handoff-prompt.buildHandoffPrompt）与 core 派生侧（交接回合识别，
 * apply-entry-convert）共同 import 同一常量——「内容 === 常量」的识别判定与发送值同源，
 * 派生规则不会与发送侧漂移。
 *
 * 措辞冻结约束（design-special-flows S2 方案穷举登记）：本常量是交接回合识别的
 * 精确匹配锚点，改措辞会让旧会话的交接回合漏识别——若必须调整，旧值须保留在
 * 识别集合（数组）里。
 */

/**
 * Handoff turn prompt 模板。
 *
 * 基于 ~/.agents/skills/handoff/SKILL.md 改写：保留 skill 的全部指令
 * （生成文档 / suggested skills / 不重复 artifact / 脱敏），改为适合直接作为
 * prompt 发送给 pi agent 的祈使句文本。
 *
 * 不再要求 agent 写文件到 temp 目录——runtime 只从 agent_end 事件提取文本
 * （extractFinalTextFromAgentEnd），写入的文件会被忽略，原指令只会浪费 agent
 * 一次工具调用。改为直接输出文档作回复。
 */
export const HANDOFF_PROMPT_TEMPLATE = `Write a handoff document summarising the current conversation so a fresh agent can continue the work. Output the document directly as your response.

Include a "suggested skills" section in the document, which suggests skills that the agent should invoke.

Do not duplicate content already captured in other artifacts (PRDs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

The handoff document is the only output the next session will receive as its first message, so make it complete and self-contained.`
