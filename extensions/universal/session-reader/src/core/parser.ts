import { readFile } from 'node:fs/promises'

/**
 * session JSONL 文件解析后的单行 entry（冻结接口，M2-M5 契约）。
 *
 * 字段对齐 pi session JSONL 各 type 的 payload：
 * - type / id / parentId：树结构字段。root（session header）在文件里无 parentId，
 *   归一化为 null（design §3.5 算法 2 的 root 判定依据）。
 * - message：仅 type=message（role/content/toolCalls）。
 *   toolName/toolCallId：仅 role=toolResult 的 message 透出（probe 实测 515/515 带，
 *   O2/O3 据此精确关联同 turn 内 toolCall 取参数，替代 v1 脆弱的顺序关联）。
 * - customType / data：仅 type=custom。
 * - parentSession / cwd：仅 type=session；parentSession 是 fork 文件指向来源的路径指针。
 * - summary：仅 type=compaction。
 *
 * 注：冻结接口未列的 per-type 附加字段（如 model_change.provider、
 * compaction.firstKeptEntryId、session.version）不在此暴露——M2+ 若需消费，
 * 扩展 Entry 接口并同步 design.md §3.4，不在 parser 层私自保留。
 */
export interface Entry {
  type: string
  id: string
  parentId: string | null
  timestamp?: string
  message?: {
    role: 'user' | 'assistant' | 'toolResult'
    content: unknown
    toolCalls?: unknown[]
    /** toolResult 的工具名（probe 实测 515/515 带，仅 role=toolResult 时存在） */
    toolName?: string
    /** toolResult 关联的 toolCall.id（probe 实测 515/515 全部匹配 toolCall.id） */
    toolCallId?: string
  }
  customType?: string
  data?: unknown
  parentSession?: string
  cwd?: string
  summary?: unknown
}

export interface ParseResult {
  entries: Entry[]
  /** JSON 解析失败（含缺必填结构字段）的行数 */
  skippedLines: number
  totalBytes: number
  /** 最后一行疑似半行（活跃 session 写入中），区别于中间坏行 */
  lastLinePartial: boolean
}

function isMessageRole(v: unknown): v is 'user' | 'assistant' | 'toolResult' {
  return v === 'user' || v === 'assistant' || v === 'toolResult'
}

/**
 * 归一化 message 字段（阶段 helper：role 经值守卫收窄，缺/非法 role 时
 * 返回 undefined，调用方丢弃 message 字段——接口 role 必填）。
 */
function parseEntryMessage(raw: unknown): Entry['message'] | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const m = raw as Record<string, unknown>
  if (!isMessageRole(m.role)) return undefined
  const message: NonNullable<Entry['message']> = { role: m.role, content: m.content }
  if (Array.isArray(m.toolCalls)) message.toolCalls = m.toolCalls
  // toolResult 自带的工具关联字段（O2/O3 用，additive，实测 515/515 存在）
  if (typeof m.toolName === 'string') message.toolName = m.toolName
  if (typeof m.toolCallId === 'string') message.toolCallId = m.toolCallId
  return message
}

/** 归一化剩余可选字段（阶段 helper：customType/data/parentSession/cwd/summary）。 */
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
 */
function toEntry(raw: unknown): Entry | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const obj = raw as Record<string, unknown>
  if (typeof obj.type !== 'string') return undefined

  // id 解析：pi appendCustomEntry 恒写顶层 id（session-manager.js:820-828）——
  // 无需 fallback。data.id 是扩展业务字段（如 subagent-identity payload），不是 entry id。
  // [W4 删除] 原 data.id fallback 分支对 pi 写出的 entry 是死分支（对历史/异构文件
  // 也无必要——entry id 语义以顶层为准）。
  const id: unknown = obj.id
  if (typeof id !== 'string') return undefined

  const entry: Entry = {
    type: obj.type,
    id: id as string,
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
 * 逐行 JSON.parse，坏行（语法错误或缺必填结构字段）计入 skippedLines 并跳过，
 * 不中断整体解析——pi 坏 session 容错（design §2 失败模式）。
 *
 * 末尾换行产生的空行忽略（不计 skipped、不计 partial）。最后一行 parse 失败时
 * lastLinePartial=true（活跃 session 写到一半的半行），区别于中间坏行。
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

    // 中间空行容错：pi 正常 jsonl 无空行，防御文件损坏；不计 skipped
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
