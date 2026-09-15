/**
 * TurnRail 节点摘要纯函数（chat 域 SSOT，w6 从 renderer/composables/logic/summarizeTurn.ts 迁入）。
 *
 * 用途：rail 节点只显示一行短文本（用户输入的开头），
 * 因此需把 user message 的结构化 content 归一化 + 剥 markdown + 截断。
 *
 * 依赖：normalizeContent（shared）+ MessageTurn/countThinking/countToolCalls（同目录 message-turns）。
 */
import { normalizeContent } from '@taiji/shared'
import type { MessageTurn } from './message-turns'
import { countThinking, countToolCalls } from './message-turns'

/** rail 节点摘要最大字符数（中文算 1，超出加省略号）。 */
const MAX_CHARS = 20
/** 截断后缀（单字符省略号，比 '...' 视觉更轻，符合 rail 节点紧凑排版）。 */
const ELLIPSIS = '…'

/** 从 MessageTurn 提取 rail 节点摘要文本。 */
export function summarizeTurnForRail(turn: MessageTurn): string {
  if (!turn.user) return ''
  const raw = normalizeContent(turn.user.content)
  const cleaned = stripMarkdown(raw)
  return truncate(cleaned, MAX_CHARS)
}

/** 剥离常见 markdown 标记，保留纯文本语义。 */
export function stripMarkdown(text: string): string {
  let s = text
  s = s.replace(/```[\s\S]*?```/g, (m) => m.replace(/```[^\n]*\n?/g, '').replace(/```/g, ''))
  s = s.replace(/`([^`]+)`/g, '$1')
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
  s = s.replace(/___([^_]+)___/g, '$1')
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1')
  s = s.replace(/__([^_]+)__/g, '$1')
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
  s = s.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1$2')
  s = s.replace(/~~([^~]+)~~/g, '$1')
  s = s.replace(/^#{1,6}\s+/gm, '')
  s = s.replace(/^>\s?/gm, '')
  s = s.replace(/^[-*+]\s+\[[ xX]\]\s+/gm, '')
  s = s.replace(/^[-*+]\s+/gm, '')
  s = s.replace(/^\d+\.\s+/gm, '')
  s = s.replace(/^\s*([-*_])\1{2,}\s*$/gm, '')
  s = s.replace(/\s+/g, ' ').trim()
  return s
}

/** 截断到 maxChars 个 Unicode 码点（中文/emoji 均算 1），超长加省略号。 */
export function truncate(text: string, maxChars: number): string {
  const chars = Array.from(text)
  if (chars.length <= maxChars) return text
  return chars.slice(0, Math.max(0, maxChars - ELLIPSIS.length)).join('') + ELLIPSIS
}

/** 分隔符（fallback 计数拼接用，与 Turn.vue badge「N thoughts · M tools」同构）。 */
const COUNT_SEP = ' · '

/** 从 turn.assistants 派生 agent 行的一行摘要（rail 节点第二行）。 */
export function summarizeAssistantForRail(turn: MessageTurn): string {
  for (const m of turn.assistants) {
    const text = normalizeContent(m.content).trim()
    if (text) {
      return truncate(stripMarkdown(text), MAX_CHARS)
    }
  }
  const thoughts = countThinking(turn)
  const tools = countToolCalls(turn)
  const parts: string[] = []
  if (thoughts > 0) parts.push(`${thoughts} thoughts`)
  if (tools > 0) parts.push(`${tools} tools`)
  return parts.join(COUNT_SEP)
}
