/**
 * chat store 的 payload 读取辅助函数（从 chat.ts 提取，控制主文件行数）。
 *
 * 所有函数是纯函数（payload 是 Record<string, unknown>，安全窄化到具体类型）。
 * event-adapter 生产端的 payload 形状见 runtime/src/infra/pi/event-adapter.ts 各 handler。
 *
 * 注：FileChange 合并逻辑 mergeFileChanges 已移至 chat-changeset.ts（FileChanges 子域）。
 */
import type {
  BranchSummary,
  ChangeSetStatus,
  CompactionSummary,
  FileChange,
} from '@taiji/shared'

/** 安全读取 payload 字符串字段（payload 是 Record<string, unknown>） */
export function readString(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key]
  return typeof v === 'string' ? v : undefined
}

/** 读 payload 上的对象字段（tool_call_start.input 等），非对象时回退空对象。 */
export function readRecord(payload: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = payload[key]
  return v && typeof v === 'object' && !Array.isArray(v)
    ? v as Record<string, unknown>
    : {}
}

/** 读 payload 上的数字字段 */
export function readNumber(payload: Record<string, unknown>, key: string): number | undefined {
  const v = payload[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** 读 payload 上的布尔字段 */
export function readBool(payload: Record<string, unknown>, key: string): boolean {
  return payload[key] === true
}

/** 读 payload 上的字符串数组字段（queue_update.steering/followUp） */
export function readStringArray(payload: Record<string, unknown>, key: string): string[] | undefined {
  const v = payload[key]
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : undefined
}

/**
 * 读 tool_call_update.detail。event-adapter 生产端 detail 可能是 string 或 object
 * （见 handleToolExecutionUpdate：partialResult 对象/字符串分支）。窄化到 ToolCall.detail 类型。
 */
export function readDetail(payload: Record<string, unknown>, key: string): string | Record<string, unknown> | undefined {
  const v = payload[key]
  if (v === null || v === undefined) return undefined
  if (typeof v === 'string') return v
  if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  return undefined
}

/**
 * 读 message.complete.usage（event-adapter 生产端形状）。
 * payload.usage = { inputTokens, outputTokens, totalTokens }（见 event-adapter handleAgentEnd）。
 * shared.Usage 只需 { inputTokens, outputTokens }；totalTokens 舍弃（无字段承载）。
 */
export function readUsage(payload: Record<string, unknown>): { inputTokens: number; outputTokens: number } | undefined {
  const u = readRecord(payload, 'usage')
  if (Object.keys(u).length === 0) return undefined
  const inputTokens = readNumber(u, 'inputTokens')
  const outputTokens = readNumber(u, 'outputTokens')
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  return { inputTokens, outputTokens }
}

/** 读 message.compactionSummary payload */
export function readCompactionSummary(payload: Record<string, unknown>): CompactionSummary {
  const summary: CompactionSummary = {}
  // [D2 closure r1 MF-1] 空串透传：pi appendCompaction 无条件直写 summary 字段（session-manager
  // :803-817），'' 在 replay 侧保留为空行（apply-entry `'' ?? fallback` 不触发）——truthiness
  // 门（原 `if (s)`）会把 live 帧的 '' 丢成 undefined 走 fallback，制造两侧内容级分叉。
  const s = readString(payload, 'summary')
  if (s !== undefined) summary.summary = s
  const tokensBefore = readNumber(payload, 'tokensBefore')
  if (tokensBefore !== undefined) summary.tokensBefore = tokensBefore
  const timestamp = readNumber(payload, 'timestamp')
  if (timestamp !== undefined) summary.timestamp = timestamp
  return summary
}

/** 读 message.branchSummary payload */
export function readBranchSummary(payload: Record<string, unknown>): BranchSummary {
  const summary: BranchSummary = {}
  // [D2 closure r1 MF-1] 同 readCompactionSummary：summary 空串透传（同族分叉预防）。
  const s = readString(payload, 'summary')
  if (s !== undefined) summary.summary = s
  const fromId = readString(payload, 'fromId')
  if (fromId) summary.fromId = fromId
  const timestamp = readNumber(payload, 'timestamp')
  if (timestamp !== undefined) summary.timestamp = timestamp
  return summary
}

/** 读 message.file_changes.fileChanges（FileChange[]，W10） */
export function readFileChanges(payload: Record<string, unknown>): FileChange[] {
  const v = payload.fileChanges
  if (!Array.isArray(v)) return []
  return v.filter(
    (c): c is FileChange =>
      c !== null && typeof c === 'object' && typeof (c as FileChange).filePath === 'string',
  )
}

/** 读 message.file_changes.changeSetStatus（ChangeSetStatus，W10） */
export function readChangeSetStatus(payload: Record<string, unknown>): ChangeSetStatus {
  const v = payload.changeSetStatus
  const valid: ChangeSetStatus[] = ['accumulating', 'ready', 'partially-reviewed', 'resolved', 'superseded']
  return typeof v === 'string' && valid.includes(v as ChangeSetStatus) ? v as ChangeSetStatus : 'accumulating'
}
