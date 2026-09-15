/**
 * inspector 聚合态文本全文层（preText）构造（从 TraceInspector 提取的纯函数，
 * script setup 行数约束；Gate-1.5 复杂度门禁后按 kind 拆子构造器，主函数只分派）。
 * 各 kind 语义与提取前一致：USER/NOTICE 文本全文、TOOL 输出（text 全文 + image
 * 占位计数）、COMPACTED/BRANCH summary、SYSTEM 留痕全文、MALFORMED raw；
 * 空值统一返回 null（模板层不渲染该层）。
 */
import { extractContentBlocks } from '@taiji/core/domain/session-trace'
import type { TraceRow } from '@taiji/core/domain/session-trace'

/** content 中第一段长文本（USER/NOTICE 文本全文，与 core firstText 语义一致但保留全文）。 */
function textContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b) => typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text')
      .map((b) => String((b as { text?: unknown }).text ?? ''))
      .join('\n')
  }
  return ''
}

/** toolResult 输出结构化：text block 全文 + image 占位计数（真实 corpus toolResult 仅这两种）。 */
function toolOutputText(content: unknown): string | null {
  if (typeof content === 'string') return content || null
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  let images = 0
  for (const b of extractContentBlocks(content)) {
    if (b.kind === 'text') parts.push(b.text)
    else if (b.kind === 'image') images++
  }
  if (images > 0) parts.push(`[image ×${images}]`)
  return parts.join('\n') || null
}

/** NOTICE 两种形态：custom_message 直接 content，普通 message 走 message.content。 */
function noticeText(entry: TraceRow['entry']): string | null {
  if (entry?.type === 'custom_message') {
    const c = (entry as { content?: unknown }).content
    return typeof c === 'string' ? c : textContent(c) || null
  }
  if (entry?.type === 'message') {
    return textContent((entry as { message?: { content?: unknown } })?.message?.content) || null
  }
  return null
}

/** COMPACTED / BRANCH 的 summary 全文。 */
function summaryText(entry: TraceRow['entry']): string | null {
  const s = (entry as { summary?: unknown } | undefined)?.summary
  return typeof s === 'string' && s ? s : null
}

/** SYSTEM 留痕全文（data.fullText；无则 null，兜底走 rawJson）。 */
function systemFullText(entry: TraceRow['entry']): string | null {
  const data = (entry as { data?: { fullText?: unknown } } | undefined)?.data
  const full = data && typeof data === 'object' ? data.fullText : undefined
  return typeof full === 'string' && full ? full : null
}

/** kind 分派：文本全文层（USER / NOTICE / TOOL 输出 / COMPACTED·BRANCH summary /
 *  SYSTEM 留痕全文 / MALFORMED raw）；无对应文本的 kind 返回 null。 */
export function buildTracePreText(row: TraceRow): string | null {
  switch (row.kind) {
    case 'MALFORMED':
      return row.raw ?? null
    case 'USER':
      return textContent((row.entry as { message?: { content?: unknown } })?.message?.content) || null
    case 'TOOL':
      return toolOutputText((row.entry as { message?: { content?: unknown } })?.message?.content)
    case 'NOTICE':
      return noticeText(row.entry)
    case 'COMPACTED':
    case 'BRANCH':
      return summaryText(row.entry)
    case 'SYSTEM':
      return systemFullText(row.entry)
    default:
      return null
  }
}
