/**
 * 消息格式化纯逻辑（R2 logic 层）。
 *
 * assistantToMarkdown：把一条 assistant 消息（thinking/tool/content）展平为 markdown，
 * 用于「复制为 MD」功能。分区：思考（引用块）/ 工具（代码块）/ 正文。
 */
import { normalizeContent } from '@taiji/shared'
import type { Message } from '@taiji/shared'
import i18n from '@/i18n'

const t = i18n.global.t

/** JSON 缩进空格数（工具参数序列化） */
const JSON_INDENT = 2

/** 把 assistant 消息格式化成 markdown（思考/工具/正文分区） */
export function assistantToMarkdown(msg: Message): string {
  const parts: string[] = []

  for (const th of msg.thinking ?? []) {
    const c = th.content.trim()
    if (c) parts.push(`> ${t('panel.message.thinkingHeader')}\n>\n> ${c.replace(/\n/g, '\n> ')}`)
  }

  for (const tc of msg.toolCalls ?? []) {
    const status = tc.status === 'error' ? t('panel.message.toolFailed') : tc.status === 'end_not_received' ? t('panel.message.toolNoResult') : ''
    let block = `**工具 \`${tc.toolName}\`**${status}`
    const input = tc.input
    if (input && Object.keys(input as object).length > 0) {
      block += `\n\n\`\`\`json\n${JSON.stringify(input, null, JSON_INDENT)}\n\`\`\``
    }
    if (tc.output?.trim()) block += `\n\n\`\`\`\n${tc.output}\n\`\`\``
    parts.push(block)
  }

  const text = normalizeContent(msg.content)
  if (text.trim()) parts.push(text)
  return parts.join('\n\n')
}
