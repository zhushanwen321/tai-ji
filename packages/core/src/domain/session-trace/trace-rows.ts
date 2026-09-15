/**
 * entry → TraceRow 映射（A21，design §3.4 渲染模型）。
 *
 * 12 种行 kind + 损坏行占位；行摘要为「数据提取」（headline + meta 标量），
 * 不做 i18n 文案（trace-i18n 单元职责）；inspector 详情消费原始 entry 透传。
 * inContext / shadowed 由 context-boundary 计算（探针 P4 语义）。
 */
import { computeTraceContextBoundary } from './context-boundary'
import { extractContentBlocks } from './trace-blocks'
import type {
  ParsedSessionTraceLine,
} from './parse-jsonl'
import type {
  TraceAgentMessage,
  TraceFileEntry,
  TraceRowKind,
  TraceSessionEndMeta,
  TraceSessionEntry,
} from './types'

/** taiji system prompt 留痕 customType（trace-ext 单元的写入约定，design D2）。 */
export const SYSTEM_PROMPT_CUSTOM_TYPE = 'taiji:system-prompt'

/** 行摘要 meta：kind 无关的标量字段包（UI 直接展示；值限标量或标量数组）。 */
export type TraceRowMeta = Record<string, string | number | boolean | undefined>

/** 台账行（§3.4：一行 = 一个 entry；损坏行/sidecar 终态行也有行）。 */
export interface TraceRow {
  /** 稳定 key：entry id；无 id 行用 `line:N`；损坏行 `malformed:N`；sidecar `sidecar:session_end`。 */
  key: string
  /** 1-based 台账序号（含损坏行与 sidecar 行，全量连续）。 */
  seq: number
  kind: TraceRowKind
  /** JSONL 行号（1-based；sidecar 行无）。 */
  lineNumber?: number
  timestamp?: string
  /** 进当前 LLM context（buildContextEntries ∩ 转换非空）。 */
  inContext: boolean
  /** 影子化（在 leaf 路径、可进类型、被 compaction 排除）。不可进类型恒 false。 */
  shadowed: boolean
  /** 行首摘要（纯数据提取，非 i18n 文案；UI 渲染态标题）。 */
  headline: string
  /** 关键标量字段（模型/exitCode/tokensBefore/thinkingLevel/customType/display…）。 */
  meta: TraceRowMeta
  /** 来源 entry（inspector 详情；MALFORMED 无；sidecar 行为 session_end 元数据）。 */
  entry?: TraceFileEntry | TraceSessionEndMeta
  /** 损坏行原文（仅 MALFORMED）。 */
  raw?: string
  /** 行来源：JSONL 文件行 / sidecar .meta.json（session_end 不污染 JSONL）。 */
  source: 'jsonl' | 'sidecar'
}

/** mapSessionTraceRows 输入。 */
export interface SessionTraceInput {
  /** JSONL 逐行解析产物（含 header / handoff_marker / 损坏行占位）。 */
  lines: ParsedSessionTraceLine[]
  /** sidecar session_end（runtime 读 `.jsonl.meta.json` 后传入；core 不读文件）。 */
  sessionEnd?: TraceSessionEndMeta
  /**
   * leaf entry id（活跃 session 路径 A：RPC get_entries 的 leafId）。
   * undefined = 尾部 entry fallback（文件直读路径 B 无 leaf 概念时的 pi 默认行为）。
   */
  leafId?: string
}

/** entry.type → kind 直映表（§3.4 映射表的无歧义项；custom/message 需按子字段细分）。 */
const TYPE_TO_KIND: Partial<Record<string, TraceRowKind>> = {
  session: 'SESSION',
  compaction: 'COMPACTED',
  branch_summary: 'BRANCH',
  custom_message: 'NOTICE',
  model_change: 'LIFECYCLE',
  thinking_level_change: 'LIFECYCLE',
  session_info: 'LIFECYCLE',
  label: 'LIFECYCLE',
  handoff_marker: 'BOUNDARY',
}

/** message.role → kind（message entry 的二级分派键）。 */
const MESSAGE_ROLE_TO_KIND: Partial<Record<string, TraceRowKind>> = {
  user: 'USER',
  assistant: 'ASSISTANT',
  toolResult: 'TOOL',
  bashExecution: 'BASH',
  custom: 'NOTICE',
}

/** entry → 行 kind（§3.4 映射表；独立导出供单测/复用）。 */
export function resolveTraceRowKind(entry: TraceFileEntry): TraceRowKind {
  if (entry.type === 'custom') {
    return (entry as { customType?: unknown }).customType === SYSTEM_PROMPT_CUSTOM_TYPE
      ? 'SYSTEM'
      : 'DATA'
  }
  if (entry.type === 'message') {
    // role ?? ''：无 message 体/无 role 统一走查表 miss → NOTICE 兜底（与旧 switch default 等价）
    const role = (entry as { message?: TraceAgentMessage }).message?.role ?? ''
    // 未知 role 的 message：类型上可进 context（转换非空），归消息类兜底 NOTICE
    return MESSAGE_ROLE_TO_KIND[role] ?? 'NOTICE'
  }
  // pi 未来新增/未建模 entry：不可进 context，按纯数据兜底（不丢失，G1）
  return TYPE_TO_KIND[entry.type] ?? 'DATA'
}

/** 取 content 中第一段可读文本（text block 或 string content），供 USER/NOTICE headline。 */
function firstText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        return (block as { text: string }).text
      }
    }
  }
  return ''
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** 非空 string 或 undefined（空串/非 string 统一 undefined——meta 不落空值键）。 */
function strOpt(v: unknown): string | undefined {
  return str(v) || undefined
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

/** 行摘要产物（headline + meta；子函数与分派表的统一返回形状）。 */
type RowSummary = { headline: string; meta: TraceRowMeta }

function summarizeSessionRow(entry: TraceFileEntry | TraceSessionEndMeta): RowSummary {
  const meta: TraceRowMeta = {}
  const h = entry as TraceFileEntry & { cwd?: unknown; parentSession?: unknown; forkEntryId?: unknown }
  meta.cwd = str(h.cwd)
  if (h.parentSession !== undefined) meta.parentSession = str(h.parentSession)
  if (h.forkEntryId !== undefined) meta.forkEntryId = str(h.forkEntryId)
  return { headline: str(h.cwd), meta }
}

function summarizeSystemRow(entry: TraceFileEntry | TraceSessionEndMeta): RowSummary {
  const meta: TraceRowMeta = {}
  const d = (entry as { data?: unknown }).data
  const rec = typeof d === 'object' && d !== null ? (d as Record<string, unknown>) : {}
  meta.version = num(rec.version)
  meta.reason = strOpt(rec.reason)
  meta.hash = strOpt(rec.hash)
  meta.charCount = num(rec.charCount)
  return { headline: `system prompt v${rec.version ?? '?'}`, meta }
}

function summarizeUserRow(entry: TraceFileEntry | TraceSessionEndMeta): RowSummary {
  const m = (entry as { message?: TraceAgentMessage }).message ?? ({} as TraceAgentMessage)
  return { headline: firstText(m.content), meta: {} }
}

/**
 * assistant usage 标量提取（pi AssistantMessage 必带；字段可选防御——corpus 有 4 种键集变体）。
 * input/cacheRead/cacheWrite 是互斥桶（pi-ai 跨协议归一化：anthropic 原生互斥，
 * openai chat/responses 的总量含缓存、pi 已减除）——输入侧合计 = 三者之和。
 */
function collectAssistantUsage(m: TraceAgentMessage, meta: TraceRowMeta): void {
  const u = typeof m.usage === 'object' && m.usage !== null ? (m.usage as Record<string, unknown>) : {}
  meta.inputTokens = num(u.input)
  meta.outputTokens = num(u.output)
  meta.cacheReadTokens = num(u.cacheRead)
  meta.cacheWriteTokens = num(u.cacheWrite)
  const cacheWrite = num(u.cacheWrite) ?? 0
  const inputTotal =
    (num(u.input) ?? 0) + (num(u.cacheRead) ?? 0) + cacheWrite
  if (inputTotal > 0) meta.inputTotal = inputTotal
  meta.reasoningTokens = num(u.reasoning)
  const cost = typeof u.cost === 'object' && u.cost !== null ? (u.cost as Record<string, unknown>) : {}
  meta.costTotal = num(cost.total)
}

/** assistant content 的块分布计数（thinking / toolCall / text）。 */
function countContentBlocks(content: unknown): { thinking: number; toolCall: number; text: number } {
  let thinking = 0
  let toolCall = 0
  let text = 0
  for (const b of extractContentBlocks(content)) {
    if (b.kind === 'thinking') thinking++
    else if (b.kind === 'toolCall') toolCall++
    else if (b.kind === 'text') text++
  }
  return { thinking, toolCall, text }
}

function summarizeAssistantRow(entry: TraceFileEntry | TraceSessionEndMeta): RowSummary {
  const meta: TraceRowMeta = {}
  const m = (entry as { message?: TraceAgentMessage }).message ?? ({} as TraceAgentMessage)
  meta.provider = strOpt(m.provider)
  meta.model = strOpt(m.model)
  meta.stopReason = strOpt(m.stopReason)
  collectAssistantUsage(m, meta)
  const blocks = countContentBlocks(m.content)
  meta.thinkingBlocks = blocks.thinking
  meta.toolCalls = blocks.toolCall
  meta.textBlocks = blocks.text
  return { headline: str(m.model) || str(m.provider), meta }
}

function summarizeToolRow(entry: TraceFileEntry | TraceSessionEndMeta): RowSummary {
  const meta: TraceRowMeta = {}
  const m = (entry as { message?: TraceAgentMessage }).message ?? ({} as TraceAgentMessage)
  meta.toolName = strOpt(m.toolName)
  meta.toolCallId = strOpt(m.toolCallId)
  meta.isError = bool(m.isError)
  return { headline: str(m.toolName), meta }
}

function summarizeBashRow(entry: TraceFileEntry | TraceSessionEndMeta): RowSummary {
  const meta: TraceRowMeta = {}
  const m = (entry as { message?: TraceAgentMessage }).message ?? ({} as TraceAgentMessage)
  meta.command = strOpt(m.command)
  meta.exitCode = num(m.exitCode)
  meta.cancelled = bool(m.cancelled)
  meta.truncated = bool(m.truncated)
  meta.fullOutputPath = strOpt(m.fullOutputPath)
  // pi bashExecution message 的 excludeFromContext（messages.ts:39，!! 前缀透传）：
  // 标记该次输出不进 LLM context，行渲染据此显示「不进上下文」注记
  meta.excludeFromContext = bool(m.excludeFromContext)
  return { headline: str(m.command), meta }
}

/** NOTICE 两种来源形态：custom_message entry 与 message(role=custom)（字段同名同义）。 */
function summarizeNoticeRow(entry: TraceFileEntry | TraceSessionEndMeta): RowSummary {
  const meta: TraceRowMeta = {}
  if (entry.type === 'custom_message') {
    const e = entry as TraceFileEntry & { customType?: unknown; display?: unknown }
    meta.customType = strOpt(e.customType)
    meta.display = bool(e.display)
    return { headline: str(e.customType), meta }
  }
  const m = (entry as { message?: TraceAgentMessage }).message ?? ({} as TraceAgentMessage)
  meta.customType = strOpt(m.customType)
  meta.display = bool(m.display)
  return { headline: str(m.customType), meta }
}

function summarizeCompactedRow(entry: TraceFileEntry | TraceSessionEndMeta): RowSummary {
  const meta: TraceRowMeta = {}
  const e = entry as TraceFileEntry & { tokensBefore?: unknown; firstKeptEntryId?: unknown; fromHook?: unknown }
  meta.tokensBefore = num(e.tokensBefore)
  meta.firstKeptEntryId = strOpt(e.firstKeptEntryId)
  meta.fromHook = bool(e.fromHook)
  return { headline: `compaction (${num(e.tokensBefore) ?? '?'} tok before)`, meta }
}

function summarizeBranchRow(entry: TraceFileEntry | TraceSessionEndMeta): RowSummary {
  const meta: TraceRowMeta = {}
  const e = entry as TraceFileEntry & { fromId?: unknown }
  meta.fromId = strOpt(e.fromId)
  return { headline: `branch from ${str(e.fromId) || '?'}`, meta }
}

/** LIFECYCLE 覆盖 4 种 lifecycle entry（model/thinking/rename/label），headline 用类型前缀区分。 */
function summarizeLifecycleRow(entry: TraceFileEntry | TraceSessionEndMeta): RowSummary {
  const meta: TraceRowMeta = {}
  switch (entry.type) {
    case 'model_change': {
      const e = entry as TraceFileEntry & { provider?: unknown; modelId?: unknown }
      meta.provider = strOpt(e.provider)
      meta.modelId = strOpt(e.modelId)
      return { headline: `${str(e.provider)}/${str(e.modelId)}`, meta }
    }
    case 'thinking_level_change': {
      const e = entry as TraceFileEntry & { thinkingLevel?: unknown }
      meta.thinkingLevel = strOpt(e.thinkingLevel)
      return { headline: `thinking: ${str(e.thinkingLevel) || '?'}`, meta }
    }
    case 'session_info': {
      const e = entry as TraceFileEntry & { name?: unknown }
      meta.name = strOpt(e.name)
      return { headline: `rename: ${str(e.name) || '?'}`, meta }
    }
    case 'label': {
      const e = entry as TraceFileEntry & { targetId?: unknown; label?: unknown }
      meta.targetId = strOpt(e.targetId)
      meta.label = strOpt(e.label)
      return { headline: `label ${str(e.label) || '(cleared)'} → ${str(e.targetId) || '?'}`, meta }
    }
    default:
      return { headline: entry.type, meta }
  }
}

function summarizeDataRow(entry: TraceFileEntry | TraceSessionEndMeta): RowSummary {
  const meta: TraceRowMeta = {}
  const e = entry as TraceFileEntry & { customType?: unknown }
  meta.customType = strOpt(e.customType)
  return { headline: str(e.customType) || entry.type, meta }
}

/** BOUNDARY 两种来源：JSONL handoff_marker 行与 sidecar session_end（终态行）。 */
function summarizeBoundaryRow(entry: TraceFileEntry | TraceSessionEndMeta): RowSummary {
  const meta: TraceRowMeta = {}
  if (entry.type === 'handoff_marker') {
    const e = entry as TraceFileEntry & { handedOffTo?: unknown }
    meta.handedOffTo = strOpt(e.handedOffTo)
    return { headline: `handoff → ${str(e.handedOffTo) || '?'}`, meta }
  }
  const e = entry as TraceSessionEndMeta
  meta.outcome = e.outcome
  meta.reason = e.reason
  return { headline: `session end: ${e.outcome}`, meta }
}

/**
 * kind → 行摘要子函数分派表（§3.4 数据提取按 kind 一行一态）。MALFORMED 无 entry 来源
 * 不进表——查表 miss 走空摘要兜底（等价旧 switch default，空 headline 由 UI 兜底）。
 */
const ROW_SUMMARIZERS: Partial<
  Record<TraceRowKind, (entry: TraceFileEntry | TraceSessionEndMeta) => RowSummary>
> = {
  SESSION: summarizeSessionRow,
  SYSTEM: summarizeSystemRow,
  USER: summarizeUserRow,
  ASSISTANT: summarizeAssistantRow,
  TOOL: summarizeToolRow,
  BASH: summarizeBashRow,
  NOTICE: summarizeNoticeRow,
  COMPACTED: summarizeCompactedRow,
  BRANCH: summarizeBranchRow,
  LIFECYCLE: summarizeLifecycleRow,
  DATA: summarizeDataRow,
  BOUNDARY: summarizeBoundaryRow,
}

/** 单行摘要：headline + meta（数据提取；空 headline 由 UI 以 kind 标签兜底）。 */
function summarizeRow(entry: TraceFileEntry | TraceSessionEndMeta, kind: TraceRowKind): RowSummary {
  return ROW_SUMMARIZERS[kind]?.(entry) ?? { headline: '', meta: {} }
}

/**
 * JSONL 逐行产物 + sidecar → 台账行数组。
 *
 * 行序 = 文件行序（损坏行占位在原位）；sidecar session_end 追加尾部。
 * inContext/shadowed 语义见 context-boundary；无 id 行（handoff_marker、畸形 entry）无法
 * 匹配 context 集合，恒为 false（不可进类型语义本就如此）。
 */
export function mapSessionTraceRows(input: SessionTraceInput): TraceRow[] {
  const { lines, sessionEnd, leafId } = input

  // boundary 输入 = 排除 header 的全部 ok entry（pi getEntries 语义；handoff_marker 等自定义行保留——
  // 忠实复刻 pi 把它们当 loose entry 参与尾 fallback 的行为）
  const entriesForBoundary: TraceSessionEntry[] = []
  for (const line of lines) {
    if (line.ok && line.entry.type !== 'session') {
      entriesForBoundary.push(line.entry as TraceSessionEntry)
    }
  }
  const boundary = computeTraceContextBoundary(entriesForBoundary, leafId)

  const rows: TraceRow[] = []
  let seq = 0
  for (const line of lines) {
    seq++
    if (!line.ok) {
      rows.push({
        key: `malformed:${line.lineNumber}`,
        seq,
        kind: 'MALFORMED',
        lineNumber: line.lineNumber,
        inContext: false,
        shadowed: false,
        headline: `unparseable line #${line.lineNumber}`,
        meta: {},
        raw: line.raw,
        source: 'jsonl',
      })
      continue
    }
    const entry = line.entry
    const kind = resolveTraceRowKind(entry)
    const { headline, meta } = summarizeRow(entry, kind)
    const id = entry.id
    rows.push({
      key: id !== undefined && id !== '' ? id : `line:${line.lineNumber}`,
      seq,
      kind,
      lineNumber: line.lineNumber,
      timestamp: entry.timestamp,
      inContext: id !== undefined && id !== '' ? boundary.contextEntryIds.has(id) : false,
      shadowed: id !== undefined && id !== '' ? boundary.shadowedEntryIds.has(id) : false,
      headline,
      meta,
      entry,
      source: 'jsonl',
    })
  }

  if (sessionEnd !== undefined) {
    seq++
    const kind = 'BOUNDARY' as const
    const { headline, meta } = summarizeRow(sessionEnd, kind)
    rows.push({
      key: 'sidecar:session_end',
      seq,
      kind,
      timestamp: sessionEnd.timestamp,
      inContext: false,
      shadowed: false,
      headline,
      meta,
      entry: sessionEnd,
      source: 'sidecar',
    })
  }

  return rows
}
