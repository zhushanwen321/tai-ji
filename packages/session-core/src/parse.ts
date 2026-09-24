/**
 * JSONL 解析原语：session JSONL 文本/文件 → canonical entries。
 *
 * 坏行语义（严格模型，设计 D1）：逐行 JSON.parse，语法错误或缺必填结构字段计入
 * skippedLines 并丢弃，不占位、不中断整体解析。宽松「坏行保留占位」形态是
 * core/session-trace 的私有语义（设计 D1 被否项），不进本基座。
 */

import { readFile } from 'node:fs/promises'

import type { Entry, ParseResult, SessionMessageRole } from './types.js'

function isMessageRole(v: unknown): v is SessionMessageRole {
  return v === 'user' || v === 'assistant' || v === 'toolResult'
}

/**
 * 归一化 message 字段：role 经值守卫收窄，缺/非法 role 时返回 undefined，
 * 调用方丢弃 message 字段（接口 role 必填，该行仍是合法 entry——message 缺省）。
 */
function parseEntryMessage(raw: unknown): Entry['message'] | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const m = raw as Record<string, unknown>
  if (!isMessageRole(m.role)) return undefined
  const message: NonNullable<Entry['message']> = { role: m.role, content: m.content }
  if (Array.isArray(m.toolCalls)) message.toolCalls = m.toolCalls
  if (typeof m.toolName === 'string') message.toolName = m.toolName
  if (typeof m.toolCallId === 'string') message.toolCallId = m.toolCallId
  return message
}

/** 归一化剩余可选字段（customType/data/parentSession/cwd/summary）。 */
function assignOptionalFields(obj: Record<string, unknown>, entry: Entry): void {
  if (typeof obj.customType === 'string') entry.customType = obj.customType
  if (obj.data !== undefined) entry.data = obj.data
  if (typeof obj.parentSession === 'string') entry.parentSession = obj.parentSession
  if (typeof obj.cwd === 'string') entry.cwd = obj.cwd
  if (obj.summary !== undefined) entry.summary = obj.summary
}

/**
 * 把单个已 JSON.parse 成功的原始对象归一化为 Entry。
 * 缺必填结构字段（type/id）返回 undefined，调用方计为坏行（skippedLines++）。
 *
 * id 取顶层 id（pi appendCustomEntry 恒写顶层 id）；data.id 是扩展业务字段
 * （如 subagent-identity payload），不是 entry id，不做 fallback。
 */
function toEntry(raw: unknown): Entry | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const obj = raw as Record<string, unknown>
  if (typeof obj.type !== 'string') return undefined
  const id: unknown = obj.id
  if (typeof id !== 'string') return undefined

  const entry: Entry = {
    type: obj.type,
    id,
    parentId: typeof obj.parentId === 'string' ? obj.parentId : null,
  }
  if (typeof obj.timestamp === 'string') entry.timestamp = obj.timestamp

  const message = parseEntryMessage(obj.message)
  if (message !== undefined) entry.message = message

  assignOptionalFields(obj, entry)

  return entry
}

/**
 * 解析 session JSONL 文本为 entries。
 *
 * 末尾换行产生的空行忽略（不计 skipped、不计 partial）；中间空行容错跳过
 * （正常 JSONL 无空行，防御文件损坏）。最后一行 parse 失败时 lastLinePartial=true
 * （活跃 session 写到一半的半行），区别于中间坏行。
 */
export function parseSessionContent(content: string): ParseResult {
  const entries: Entry[] = []
  let skippedLines = 0
  let lastLinePartial = false

  const lines = content.split('\n')
  // 移除末尾因 trailing newline 产生的空行（非真实行）
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const isLast = i === lines.length - 1

    // 中间空行容错：不计 skipped
    if (line.trim() === '') continue

    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      skippedLines++
      if (isLast) lastLinePartial = true
      continue
    }

    const entry = toEntry(raw)
    if (entry === undefined) {
      skippedLines++
      if (isLast) lastLinePartial = true
      continue
    }
    entries.push(entry)
  }

  return {
    entries,
    skippedLines,
    totalBytes: Buffer.byteLength(content, 'utf8'),
    lastLinePartial,
  }
}

/** 读取 session 文件并解析。文件不存在按 Node fs 原生错误抛出（ENOENT）。 */
export async function parseSessionFile(filePath: string): Promise<ParseResult> {
  const content = await readFile(filePath, 'utf8')
  return parseSessionContent(content)
}
