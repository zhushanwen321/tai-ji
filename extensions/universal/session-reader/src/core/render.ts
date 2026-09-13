import type { Entry } from './parser.js'
import { extractToolCalls, formatToolCallSummary, type ToolCallInfo } from './toolcall.js'
import type { Turn } from './turns.js'
import type { TreeView } from './tree.js'

// ---------------------------------------------------------------------------
// 模块常量（渲染口径：截断宽度 / 换算基数 / 降级档位）
// ---------------------------------------------------------------------------

/** bytes→KB 换算基数（omitted 字节 / read 结果规模的 KB 显示）。 */
const BYTES_PER_KB = 1024
/** userBrief 截断字符数（TurnBrief.userBrief 文档口径「截 60 字符」）。 */
const USER_BRIEF_MAX_CHARS = 60
/** assistantBrief 截断字符数（TurnBrief.assistantBrief 文档口径「截 80 字符」）。 */
const ASSISTANT_BRIEF_MAX_CHARS = 80
/** L2 expand 单 entry brief 截断字符数。 */
const ENTRY_BRIEF_MAX_CHARS = 100
/** turn 索引显示宽度（T013 三位补零）。 */
const TURN_INDEX_WIDTH = 3
/** outline 默认 token 预算（OutlineOptions.budget 缺省值）。 */
const OUTLINE_DEFAULT_BUDGET_TOKENS = 2000
/** token 估算换算基数（chars/4，与 tokenEstimate 口径一致）。 */
const CHARS_PER_TOKEN = 4
/** toolResult 摘要头行数（O3 摘要态展示前 N 行）。 */
const SUMMARY_HEAD_LINE_COUNT = 3
/** toolResult 摘要单头行截断字符数。 */
const SUMMARY_HEAD_LINE_MAX_CHARS = 80

/** 行渲染降级档位（design §3.5 算法 1 step3）：0=全有 / 1=砍 assistantBrief / 2=再砍 toolSummary（骨架）。 */
const LINE_LEVEL_FULL = 0
const LINE_LEVEL_NO_ASSISTANT = 1
const LINE_LEVEL_SKELETON = 2
type LineLevel = typeof LINE_LEVEL_FULL | typeof LINE_LEVEL_NO_ASSISTANT | typeof LINE_LEVEL_SKELETON

/**
 * L1 outline 的单行 turn 摘要（design §3.5 算法 1 的渲染单元，冻结接口）。
 *
 * 预算不足时按降级序清空 assistantBrief → toolSummary（保留 userBrief + omittedBytes 骨架），
 * 由 renderOutline 直接改写本对象的字段（消费方拿到的就是降级后的形态）。
 */
export interface TurnBrief {
  index: number
  startTime?: string
  /** user message text 截 60 字符（compaction turn 为 `[compaction] 摘要…`） */
  userBrief: string
  /** 聚合该 turn 所有 toolCall.name 计数 → `bash×2,read×2`；无则空串 */
  toolSummary: string
  /** assistant text 截 80 字符 */
  assistantBrief: string
  /** 该 turn 省略的 toolResult + thinking 字节数 */
  omittedBytes: number
  /** forkPointId（仅 allBranches 时设置：该 turn 含 forkPoint 节点） */
  branch?: string
}

export interface OutlineResult {
  turns: TurnBrief[]
  /**
   * 渲染行（E7/D3 行渲染统一）：formatLine 产出、降级与总预算截断后的最终展示行——
   * 预算度量与工具层展示共用同一份（度量 = 展示 by construction），展示侧不得重建行格式。
   */
  lines: string[]
  /** skippedLines：JSON 解析失败/缺结构字段的行数（parser 检测，工具层覆盖精确值；render 层无 ParseResult 恒 0） */
  stats: { totalTurns: number; totalEntries: number; totalBytes: number; parsedBytes: number; skippedLines: number }
  /** chars / 4 近似（与 design P-outline 口径一致） */
  tokenEstimate: number
  /** 被总预算截断的 turn 数（从尾部丢弃） */
  truncated?: number
}

export interface OutlineOptions {
  /** 默认 2000（token） */
  budget?: number
  allBranches?: boolean
  /** 默认 turn；entry = 每 entry 一行不聚合（D-1 兜底，坏 session 调试） */
  granularity?: 'turn' | 'entry'
}

// ---------------------------------------------------------------------------
// content 类型守卫与提取（message.content 是 unknown，design §3.4）
// ---------------------------------------------------------------------------

interface ContentBlock {
  type?: unknown
  text?: unknown
  thinking?: unknown
}

function isStringContent(c: unknown): c is string {
  return typeof c === 'string'
}

function isBlockArray(c: unknown): c is ContentBlock[] {
  if (!Array.isArray(c)) return false
  return c.every((item) => typeof item === 'object' && item !== null)
}

function blockText(block: ContentBlock): string {
  return typeof block.text === 'string' ? block.text : ''
}

function blockThinking(block: ContentBlock): string {
  if (typeof block.thinking === 'string') return block.thinking
  // 兜底：个别实现把 thinking 文本放在 text 字段
  if (block.type === 'thinking' && typeof block.text === 'string') return block.text
  return ''
}

/**
 * E11 共享核：白名单提取 message.content 中 `type==='text'` 块的 text 字段（块 → string[]）。
 * string content 直取为单元素数组；非 string 非数组返回空数组。join 语义（''/'\n'/' '）
 * 与空态语义（空串 vs undefined）留在各调用点组合——S7 警告适用：join 差异是行为敏感点，
 * 不可在共享核合并。消费方：result-action（'' join）/ extract（'\n' join）/ find（' ' join
 * + 空返 undefined）。
 */
export function textBlockParts(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  const parts: string[] = []
  for (const b of content) {
    if (b !== null && typeof b === 'object') {
      const o = b as Record<string, unknown>
      if (o.type === 'text' && typeof o.text === 'string') parts.push(o.text)
    }
  }
  return parts
}

/** 拼接 text 块文本（排除 thinking / toolCall / tool_use / tool_result 块）。 */
function extractText(content: unknown): string {
  if (isStringContent(content)) return content
  if (isBlockArray(content)) {
    return content
      .filter(
        (b) =>
          b.type !== 'thinking' &&
          b.type !== 'toolCall' && // pi 当前真实工具调用 block type（probe 实测 519）
          b.type !== 'tool_use' && // 历史/兼容防御（probe 实测 0，保留兜底）
          b.type !== 'tool_result',
      )
      .map(blockText)
      .join('')
  }
  return ''
}

/** 拼接 thinking 块文本（assistant 推理噪音）。 */
function extractThinking(content: unknown): string {
  if (isBlockArray(content)) {
    return content.filter((b) => b.type === 'thinking').map(blockThinking).join('')
  }
  return ''
}

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

/** 未知 content 的字节数（string 直测，结构化 JSON 序列化后测）。 */
function contentBytes(content: unknown): number {
  if (content === undefined || content === null) return 0
  if (typeof content === 'string') return utf8Bytes(content)
  try {
    return utf8Bytes(JSON.stringify(content))
  } catch {
    return 0
  }
}

/**
 * 该 entry 聚合的工具名列表（O1 toolSummary 用）。
 * 从 assistant content 的 toolCall block 提取（修 v1 读 message.toolCalls 恒返 [] 的 bug——
 * probe 实测 toolCalls 顶层字段从未存在，工具调用全在 content blocks，v1 全程没工作过）。
 */
function entryToolCallNames(entry: Entry): string[] {
  return extractToolCalls(entry).map((tc) => tc.name)
}

/** 该 entry 省略的字节：toolResult 整段 content + assistant 的 thinking 块。 */
function entryOmittedBytes(entry: Entry): number {
  const msg = entry.message
  if (msg === undefined) return 0
  if (msg.role === 'toolResult') return contentBytes(msg.content)
  if (msg.role === 'assistant') return utf8Bytes(extractThinking(msg.content))
  return 0
}

/** toolResult content 提取为纯文本（content 是 [{type:'text',text}] 数组，拼接 text）。 */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (isBlockArray(content)) {
    return content.map(blockText).join('')
  }
  return ''
}

/**
 * O2/O3：toolResult 的类型化摘要 = 参数摘要（formatToolCallSummary）+ 结果规模（按工具）。
 *
 * - bash → append 结果行数（命令输出多行，行数是核心规模信号）
 * - read → append 结果 KB（文件内容体积）
 * - 其余工具（edit/write/head/todo/cw/未知）→ 不 append（formatToolCallSummary 已含 edit/write
 *   的参数规模 blocks/KB，head 含 limit；避免双重括号）
 *
 * tc 匹配失败（toolCallId 缺失或无对应 toolCall，probe 实测 0%）→ base 退化为 toolName；
 * toolName 也缺失 → '[tool result]'。
 */
function formatToolResultSummary(
  toolName: string | undefined,
  tc: ToolCallInfo | undefined,
  resultText: string,
): string {
  const base = tc !== undefined ? formatToolCallSummary(tc) : (toolName ?? '[tool result]')
  if (toolName === 'bash') {
    const lines = resultText === '' ? 0 : resultText.split('\n').length
    return lines > 0 ? `${base} (${lines}行)` : base
  }
  if (toolName === 'read') {
    if (resultText === '') return base
    const kb = Math.max(1, Math.round(utf8Bytes(resultText) / BYTES_PER_KB))
    return `${base} (${kb}KB)`
  }
  return base
}

function entryJsonBytes(e: Entry): number {
  try {
    return utf8Bytes(JSON.stringify(e))
  } catch {
    return 0
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + '…'
}

function formatToolSummary(counts: Map<string, number>): string {
  if (counts.size === 0) return ''
  const parts: string[] = []
  for (const [name, count] of counts) {
    parts.push(count > 1 ? `${name}×${count}` : name)
  }
  return parts.join(',')
}

// ---------------------------------------------------------------------------
// TurnBrief 计算
// ---------------------------------------------------------------------------

function computeBrief(turn: Turn): TurnBrief {
  const toolCounts = new Map<string, number>()
  let assistantText = ''
  let omitted = 0

  for (const entry of turn.entries) {
    const msg = entry.message
    if (msg !== undefined && msg.role === 'assistant') {
      assistantText += extractText(msg.content)
    }
    for (const name of entryToolCallNames(entry)) {
      toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1)
    }
    omitted += entryOmittedBytes(entry)
  }

  // userBrief：compaction turn 显示 `[compaction] 摘要`；其余取 user text
  let userBrief: string
  if (turn.isCompaction) {
    const first = turn.entries[0]
    const summaryStr = typeof first?.summary === 'string' ? first.summary : ''
    userBrief = truncate('[compaction] ' + summaryStr, USER_BRIEF_MAX_CHARS)
  } else {
    let userText = ''
    for (const entry of turn.entries) {
      const msg = entry.message
      if (msg !== undefined && msg.role === 'user') {
        userText += extractText(msg.content)
      }
    }
    userBrief = truncate(userText, USER_BRIEF_MAX_CHARS)
  }

  return {
    index: turn.index,
    startTime: turn.startTime,
    userBrief,
    toolSummary: formatToolSummary(toolCounts),
    assistantBrief: truncate(assistantText, ASSISTANT_BRIEF_MAX_CHARS),
    omittedBytes: omitted,
  }
}

/** 在 turn.entries 中找第一个属于 tree.branches 的 forkPointId（用于 allBranches 标注）。 */
function findBranchForkPoint(turn: Turn, tree: TreeView): string | undefined {
  for (const e of turn.entries) {
    if (tree.branches.has(e.id)) return e.id
  }
  return undefined
}

// ---------------------------------------------------------------------------
// 行渲染（预算度量与展示同一份渲染行，E7/D3 行渲染统一）
// ---------------------------------------------------------------------------

function formatHHMM(timestamp?: string): string {
  if (timestamp === undefined) return ''
  const m = timestamp.match(/T(\d{2}):(\d{2})/)
  return m ? `${m[1]}:${m[2]}` : ''
}

export function formatBytesMarker(bytes: number): string {
  if (bytes <= 0) return ''
  if (bytes < BYTES_PER_KB) return `[${bytes}B omitted]`
  return `[${Math.round(bytes / BYTES_PER_KB)}KB omitted]`
}

/**
 * 渲染单行为字符串（E7 行渲染统一：预算度量与展示同一份渲染行，OutlineResult.lines 的行工厂）。
 * v2 O1：L1 行含 assistantBrief（补 assistant 结论行让 outline 单独可决策，不再逼反复 expand）。
 * level: 0=全有（toolSummary + assistantBrief）/ 1=砍 assistantBrief / 2=再砍 toolSummary（骨架）。
 * userBrief + omittedBytes 骨架永保。assistantBrief 格式 `→ <结论>`，在 toolSummary 后、omitted 前。
 * 旁支标记 `[旁支 N entries]`（branchSize = 该 forkPoint 下旁支子树 entry 数）。
 */
function formatLine(b: TurnBrief, level: LineLevel, branchSize?: number): string {
  const parts: string[] = []
  const head = `T${String(b.index).padStart(TURN_INDEX_WIDTH, '0')}`
  const time = formatHHMM(b.startTime)
  parts.push(time ? `${head} ${time}` : head)
  if (b.userBrief) parts.push(b.userBrief)
  if (level <= LINE_LEVEL_NO_ASSISTANT && b.toolSummary) parts.push(b.toolSummary)
  if (level <= LINE_LEVEL_FULL && b.assistantBrief) parts.push(`→ ${b.assistantBrief}`)
  const marker = formatBytesMarker(b.omittedBytes)
  if (marker) parts.push(marker)
  if (branchSize !== undefined && branchSize > 0) parts.push(`[旁支 ${branchSize} entries]`)
  return parts.join(' · ')
}

// ---------------------------------------------------------------------------
// renderOutline
// ---------------------------------------------------------------------------

function sumBranchEntries(tree: TreeView): number {
  let s = 0
  for (const n of tree.branches.values()) s += n
  return s
}

/** 计算 parsedBytes（leaf entry JSON 字节和）。totalBytes/totalEntries 由 renderOutline 组装。 */
function leafParsedBytes(turns: Turn[]): number {
  let parsedBytes = 0
  for (const t of turns) {
    for (const e of t.entries) parsedBytes += entryJsonBytes(e)
  }
  return parsedBytes
}

/** allBranches：对每个 brief 标注所在 turn 的 forkPoint（找到才标 branch）。 */
function applyBranchLabels(briefs: TurnBrief[], turns: Turn[], tree: TreeView): void {
  for (const b of briefs) {
    const fp = findBranchForkPoint(turns[b.index], tree)
    if (fp !== undefined) b.branch = fp
  }
}

/**
 * 降级序逐行渲染（design §3.5 算法 1 step3）：level 0 全有；超预算降到 level 1
 * 砍 assistantBrief；仍超降到 level 2 砍 toolSummary（骨架）。
 * 直接改写 brief 的 assistantBrief/toolSummary 字段，返回行缓存（E7 后随结果
 * 返回为 OutlineResult.lines，预算度量与展示同一份）。
 */
function renderDegradingLines(
  briefs: TurnBrief[],
  tree: TreeView,
  perTurnCharBudget: number,
): string[] {
  const lineCache: string[] = []
  for (const b of briefs) {
    const branchSize = b.branch !== undefined ? tree.branches.get(b.branch) : undefined
    let line = formatLine(b, LINE_LEVEL_FULL, branchSize)
    if (line.length > perTurnCharBudget) {
      // 超预算：先砍 assistantBrief（level 1），仍超再砍 toolSummary（level 2，骨架）
      b.assistantBrief = ''
      line = formatLine(b, LINE_LEVEL_NO_ASSISTANT, branchSize)
      if (line.length > perTurnCharBudget) {
        b.toolSummary = ''
        line = formatLine(b, LINE_LEVEL_SKELETON, branchSize)
      }
    }
    lineCache.push(line)
  }
  return lineCache
}

/** 总预算截断（从尾部丢弃）：就地截短 lines 与 briefs，返回最终 totalChars 与 truncated。 */
function truncateToTotalBudget(
  briefs: TurnBrief[],
  lines: string[],
  budget: number,
): { totalChars: number; truncated: number | undefined } {
  let totalChars = lines.reduce((s, l) => s + l.length, 0)
  if (totalChars / CHARS_PER_TOKEN <= budget) return { totalChars, truncated: undefined }
  let kept = lines.length
  while (kept > 0 && totalChars / CHARS_PER_TOKEN > budget) {
    kept--
    totalChars -= lines[kept].length
  }
  const truncated = lines.length - kept
  lines.length = kept
  briefs.length = kept
  return { totalChars, truncated }
}

export function renderOutline(
  turns: Turn[],
  tree: TreeView,
  options?: OutlineOptions,
): OutlineResult {
  const budget = options?.budget ?? OUTLINE_DEFAULT_BUDGET_TOKENS
  const allBranches = options?.allBranches ?? false
  const granularity = options?.granularity ?? 'turn'

  const parsedBytes = leafParsedBytes(turns)
  const leafEntryCount = turns.reduce((s, t) => s + t.entries.length, 0)
  // totalEntries = leaf + 旁支子树 + 孤儿；totalBytes 无原始文件字节数（签名不含 ParseResult），
  // 以 leaf entry JSON 字节近似，精确值由 M2 工具层用 ParseResult.totalBytes 覆盖。
  const totalEntriesAll = leafEntryCount + sumBranchEntries(tree) + tree.orphans.length
  const stats: OutlineResult['stats'] = {
    totalTurns: turns.length,
    totalEntries: totalEntriesAll,
    totalBytes: parsedBytes,
    parsedBytes,
    skippedLines: 0,
  }

  if (turns.length === 0) {
    return { turns: [], lines: [], stats, tokenEstimate: 0 }
  }

  // granularity:entry —— 每 entry 一行，不聚合 turn（D-1 兜底）
  if (granularity === 'entry') {
    return renderEntryGranularity(turns, tree, budget, allBranches, stats)
  }

  // 1. 全量 brief
  const briefs: TurnBrief[] = turns.map(computeBrief)

  // allBranches：标注 forkPoint
  if (allBranches) applyBranchLabels(briefs, turns, tree)

  // 2. perTurnBudget（token → chars×4）
  const perTurnCharBudget = (budget / turns.length) * CHARS_PER_TOKEN

  // 3. 降级序渲染：level 0 全有 → level 1 砍 assistantBrief → level 2 骨架
  const lineCache = renderDegradingLines(briefs, tree, perTurnCharBudget)

  // 4. 总预算截断（从尾部丢弃，lines 与 briefs 同步截短）
  const { totalChars, truncated } = truncateToTotalBudget(briefs, lineCache, budget)

  const tokenEstimate = Math.ceil(totalChars / CHARS_PER_TOKEN)
  return { turns: briefs, lines: lineCache, stats, tokenEstimate, truncated }
}

/** granularity:entry 模式：每 entry 一行 TurnBrief，不聚合，仅总预算截断。 */
function renderEntryGranularity(
  turns: Turn[],
  tree: TreeView,
  budget: number,
  allBranches: boolean,
  stats: OutlineResult['stats'],
): OutlineResult {
  const briefs: TurnBrief[] = []
  let entryIdx = 0
  for (const t of turns) {
    for (const e of t.entries) {
      const msg = e.message
      let text = ''
      if (msg !== undefined && (msg.role === 'user' || msg.role === 'assistant')) {
        text = extractText(msg.content)
      }
      const counts = new Map<string, number>()
      for (const name of entryToolCallNames(e)) {
        counts.set(name, (counts.get(name) ?? 0) + 1)
      }
      const b: TurnBrief = {
        index: entryIdx++,
        startTime: e.timestamp,
        userBrief: truncate(text, USER_BRIEF_MAX_CHARS) || `[${e.type}]`,
        toolSummary: formatToolSummary(counts),
        assistantBrief: '',
        omittedBytes: entryOmittedBytes(e),
      }
      if (allBranches && tree.branches.has(e.id)) b.branch = e.id
      briefs.push(b)
    }
  }

  const lines = briefs.map((b) =>
    formatLine(b, LINE_LEVEL_FULL, b.branch !== undefined ? tree.branches.get(b.branch) : undefined),
  )
  let totalChars = lines.reduce((s, l) => s + l.length, 0)
  let truncated: number | undefined
  if (totalChars / CHARS_PER_TOKEN > budget) {
    let kept = lines.length
    while (kept > 0 && totalChars / CHARS_PER_TOKEN > budget) {
      kept--
      totalChars -= lines[kept].length
    }
    truncated = lines.length - kept
    lines.length = kept
    briefs.length = kept
  }
  return {
    turns: briefs,
    lines,
    stats,
    tokenEstimate: Math.ceil(totalChars / CHARS_PER_TOKEN),
    truncated,
  }
}

// ---------------------------------------------------------------------------
// renderExpand（L2 单轮展开）
// ---------------------------------------------------------------------------

export interface EntryBrief {
  index: number
  type: string
  role?: string
  brief: string
  omittedBytes: number
}

/**
 * 单 entry 的一行 brief（L2 expand 用）。
 * O2：toolResult 改类型化摘要（toolName + toolCallId 关联取 args + 结果规模），
 * 不再是结果文本前 100 字（v1 agent 不知工具维度）。
 */
function entryBrief(e: Entry, tcMap?: Map<string, ToolCallInfo>): string {
  const msg = e.message
  if (msg !== undefined) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      return truncate(extractText(msg.content), ENTRY_BRIEF_MAX_CHARS) || `[${msg.role}]`
    }
    if (msg.role === 'toolResult') {
      const toolCallId = msg.toolCallId
      const tc = toolCallId !== undefined ? tcMap?.get(toolCallId) : undefined
      return formatToolResultSummary(msg.toolName, tc, toolResultText(msg.content))
    }
  }
  if (e.type === 'compaction') {
    const s = typeof e.summary === 'string' ? e.summary : '[compaction]'
    return truncate(s, ENTRY_BRIEF_MAX_CHARS)
  }
  if (e.type === 'custom') return `[custom:${e.customType ?? 'unknown'}]`
  return `[${e.type}]`
}

export function renderExpand(turn: Turn): {
  turn: string
  entries: EntryBrief[]
} {
  const head = `T${String(turn.index).padStart(TURN_INDEX_WIDTH, '0')}`
  const bits = [`${turn.entries.length} entries`]
  if (turn.startTime !== undefined) bits.push(`started ${formatHHMM(turn.startTime)}`)
  if (turn.isCompaction) bits.push('compaction')
  if (turn.userEntry === undefined && !turn.isCompaction) bits.push('preface')
  const header = `${head} (${bits.join(', ')})`

  // O2：建 toolCallId → ToolCallInfo 索引（收本 turn assistant entry 的 toolCall，供 toolResult 关联取 args）
  const tcMap = new Map<string, ToolCallInfo>()
  for (const e of turn.entries) {
    for (const tc of extractToolCalls(e)) tcMap.set(tc.id, tc)
  }

  const entries: EntryBrief[] = turn.entries.map((e, i) => ({
    index: i,
    type: e.type,
    role: e.message?.role,
    brief: entryBrief(e, tcMap),
    omittedBytes: entryOmittedBytes(e),
  }))
  return { turn: header, entries }
}

// ---------------------------------------------------------------------------
// renderDetail（L3 全文，按 opts 过滤噪音）
// ---------------------------------------------------------------------------

/** 过滤掉 thinking 块；非 block 数组原样返回。 */
function stripThinking(content: unknown): unknown {
  if (!isBlockArray(content)) return content
  return content.filter((b) => b.type !== 'thinking')
}

/**
 * L3 detail 默认摘要态的 toolResult entry（v2 O3：toolResult 不再整条消失，给中间态）。
 * includeToolResult:true 时 renderDetail 直接 push 原 Entry（全文态真实路径），否则返回此摘要。
 */
export interface ToolResultSummaryEntry {
  type: 'toolResultSummary'
  /** 原 toolResult entry 的 id（与全文 Entry 对齐，便于定位） */
  id: string
  /** 类型化摘要（同 O2 格式：toolName + 参数摘要 + 结果规模） */
  summary: string
  /** 结果文本前 3 行（每行截 80 字，' | ' 分隔，单行便于渲染） */
  headLines: string
  /** 结果文本总行数 */
  totalLines: number
}

export function renderDetail(
  turns: Turn[],
  opts: { includeToolResult?: boolean; includeThinking?: boolean } = {},
): Array<Entry | ToolResultSummaryEntry> {
  const includeToolResult = opts.includeToolResult ?? false
  const includeThinking = opts.includeThinking ?? false

  const out: Array<Entry | ToolResultSummaryEntry> = []
  for (const t of turns) {
    // O2/O3：turn 级 toolCallId → ToolCallInfo 索引（toolResult 摘要的参数部分用）
    const tcMap = new Map<string, ToolCallInfo>()
    for (const e of t.entries) {
      for (const tc of extractToolCalls(e)) tcMap.set(tc.id, tc)
    }

    for (const e of t.entries) {
      const msg = e.message
      if (msg !== undefined && msg.role === 'toolResult') {
        if (includeToolResult) {
          // 全文态：返回原 entry（thinking 剥离不适用 toolResult）
          out.push(e)
        } else {
          // O3 摘要态：不消失，给类型化摘要 + 头 3 行 + 总行数
          const toolCallId = msg.toolCallId
          const tc = toolCallId !== undefined ? tcMap.get(toolCallId) : undefined
          const text = toolResultText(msg.content)
          // 空文本口径与 formatToolResultSummary 一致：空结果 = 0 行
          //（''.split('\n') 返 [''] length=1，会与 summary 的 (0行) 自相矛盾）
          const lines = text === '' ? [] : text.split('\n')
          const headLines = lines.slice(0, SUMMARY_HEAD_LINE_COUNT).map((l) => truncate(l, SUMMARY_HEAD_LINE_MAX_CHARS)).join(' | ')
          out.push({
            type: 'toolResultSummary',
            id: e.id,
            summary: formatToolResultSummary(msg.toolName, tc, text),
            headLines,
            totalLines: lines.length,
          })
        }
        continue
      }
      // 非 toolResult：thinking 剥离逻辑保留
      if (msg !== undefined && !includeThinking) {
        const cleaned = stripThinking(msg.content)
        if (cleaned !== msg.content) {
          out.push({ ...e, message: { ...msg, content: cleaned } })
          continue
        }
      }
      out.push(e)
    }
  }
  return out
}
