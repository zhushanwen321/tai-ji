/**
 * extract 预设管线（v2 O4：跨 turn 按类型提取素材）。
 *
 * 从 tool-handler.ts 机械提取（max-lines 拆分轮，零行为变更）。
 * design §3.3 D3 的 5 个预设 + F8/F9 规格；F7（what 校验）与 doExtract 编排
 *（resolveSessionId/safeParse/turns 范围限定依赖 tool-handler 私有定位层）留守
 * tool-handler，经本模块导出的 5 预设函数分发。纯提取，不调 LLM。
 */
import { textBlockParts } from './core/render.js'
import { extractToolCalls, formatToolCallSummary, basename } from './core/toolcall.js'
import type { Turn } from './core/turns.js'
import { pad } from './handler-utils.js'
import type { ToolResult } from './tool-handler.js'

/** extract 的 5 个合法 what（design §3.3 D3）。 */
export type ExtractWhat = 'user-messages' | 'commands' | 'files' | 'commits' | 'tool-results'

/** extract 结果预算（design §3.3 F9）：8000 字节 ≈ 2000 token。 */
const EXTRACT_BUDGET_BYTES = 8000

/** 含 path 参数的文件类工具（design §3.3 D3 files scope）。 */
const FILE_TOOLS = new Set(['read', 'edit', 'write', 'head'])

/** git 命令关键词（commits 预设判定 bash 结果是否来自 git 命令）。 */
const GIT_CMD_RE = /\bgit\s+(log|show|commit|push|merge|cherry-pick|revert|reset|rebase|diff)\b/
/** git short hash（commits 预设，保守限定 7-8 位避免 uuid 全量误报）。 */
const SHORT_HASH_RE = /\b[0-9a-f]{7,8}\b/g
/** commit 上下文消歧关键词（commits 次路径：hash 附近出现才纳入）。 */
const COMMIT_CTX_RE = /feat:|fix:|refactor:|chore:|docs:|\b(commit|commits|merged|pushed|merge)\b/i

/**
 * 从 message.content 提取纯 text（E11 归一：共享核 textBlockParts 组合调用，'\n' join
 * 语义留在本调用点）。extract 仅需纯 text（user-messages / tool-results 的正文），
 * 不要 thinking/toolCall 占位。
 */
function extractContentText(content: unknown): string {
  return textBlockParts(content).join('\n')
}

/** 截断到 max 字符，超出加省略号（防爆；tool-results 正文用）。 */
function truncateText(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…'
}

/** turnsLabel 展示的 turn 数上限（超出折叠为 +N）。 */
const TURNS_LABEL_HEAD_COUNT = 5

/** turns 数组紧凑标签（前 5 个 + +N，避免一行过长撑爆预算）。 */
function turnsLabel(turns: number[]): string {
  const head = turns.slice(0, TURNS_LABEL_HEAD_COUNT).map((n) => `T${pad(n)}`)
  const suffix = turns.length > TURNS_LABEL_HEAD_COUNT ? `+${turns.length - TURNS_LABEL_HEAD_COUNT}` : ''
  return head.join(',') + suffix
}

/**
 * 计算工具分布（按出现次数降序），用于 F8 提示 + details.toolDistribution。
 * 遍历 assistant entry 的 toolCall，复用 extractToolCalls。
 */
function computeToolDistribution(
  turns: Turn[],
): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>()
  for (const t of turns) {
    for (const e of t.entries) {
      if (e.message?.role !== 'assistant') continue
      for (const tc of extractToolCalls(e)) {
        counts.set(tc.name, (counts.get(tc.name) ?? 0) + 1)
      }
    }
  }
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
}

/** F8 提示展示的工具分布条数上限。 */
const TOOL_DISTRIBUTION_LIMIT = 10

/** F8：commands/tool-results 的 tool 过滤零匹配 → 返回工具分布 + 👉（不抛错，design §3.3 F8）。 */
function f8ToolNoMatch(what: ExtractWhat, tool: string, turns: Turn[]): ToolResult {
  const dist = computeToolDistribution(turns).slice(0, TOOL_DISTRIBUTION_LIMIT)
  const distStr = dist.map((d) => `${d.name}×${d.count}`).join(', ')
  const text = `what=${what} tool="${tool}" 无匹配。该 session 工具：${distStr}。👉 用存在的工具名重试。`
  return { content: [{ type: 'text', text }], details: { what, tool, toolDistribution: dist } }
}

/**
 * 通用预算渲染：逐项累加字节，超 EXTRACT_BUDGET_BYTES 截断（design §3.3 F9）。
 *
 * details.items 放实际展示的子集（截断后），count 放全集长度，测试可断言 shown/count/truncated。
 * emptyHint 仅 items 为空时用（files/commits 无匹配不报错，返空 + 提示）。
 *
 * 预算控制：按 item 累计字节达预算即截断。**首项超大也内部截断**（对单行 slice 到剩余字节预算，
 * 字节→字符 ×3 近似防 UTF8 多字节被切半），保证 body 不超预算——而非放行首项致 body 远超预算。
 * 导出供 tool-handler.test 单测 F9 截断逻辑（首项截断 + 文案含 turn 范围 + 实际 token）。
 *
 * getTurns：从 item 提取 turn 列表（files 是 turns 数组，其余单值包数组），供 F9 文案报 turn 范围。
 */

/** UTF8 单字符最大字节数（预算字节→字符的保守换算基数，防多字节字符被切半）。 */
const UTF8_MAX_BYTES_PER_CHAR = 3
/** token 估算换算基数（bytes/4 口径，与 render 层 chars/4 同近似）。 */
const CHARS_PER_TOKEN = 4

export function renderExtractItems<I>(
  what: ExtractWhat,
  items: I[],
  renderLine: (item: I) => string,
  getTurns: (item: I) => number[],
  emptyHint?: string,
): ToolResult {
  if (items.length === 0) {
    const text = emptyHint ?? `what=${what} 无匹配。`
    return {
      content: [{ type: 'text', text }],
      details: { what, count: 0, shown: 0, truncated: false, items: [] },
    }
  }
  const shown: I[] = []
  const shownLines: string[] = []
  let bytes = 0
  let cut = false
  for (const item of items) {
    const line = renderLine(item)
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1 // +\n
    if (bytes + lineBytes > EXTRACT_BUDGET_BYTES) {
      // 超预算：对当前 line 内部截断到剩余预算（首项超大也截断，但保留截断后的内容）
      const remainingBytes = EXTRACT_BUDGET_BYTES - bytes
      const charBudget = Math.floor(remainingBytes / UTF8_MAX_BYTES_PER_CHAR) // 字节→字符 ×3 近似防 UTF8 切半
      if (charBudget > 0) {
        const sliced = line.slice(0, charBudget) + '…'
        shown.push(item)
        shownLines.push(sliced)
      }
      cut = true
      break
    }
    shown.push(item)
    shownLines.push(line)
    bytes += lineBytes
  }
  const body = shownLines.join('\n')
  if (!cut) {
    return {
      content: [{ type: 'text', text: body }],
      details: {
        what,
        count: items.length,
        shown: shown.length,
        truncated: false,
        items: shown,
      },
    }
  }
  // F9：超预算截断。tokens 反映 body 实际体积（非固定 2000）；文案报 shown/count + turn 范围 + 实际 token
  const shownTurns = shown.flatMap(getTurns)
  const turnRange =
    shownTurns.length > 0
      ? `（T${pad(Math.min(...shownTurns))}-T${pad(Math.max(...shownTurns))}）`
      : ''
  const actualTokens = Math.round(Buffer.byteLength(body, 'utf8') / CHARS_PER_TOKEN)
  const text =
    body +
    `\n[what=${what} 已显示 ${shown.length}/${items.length} 项${turnRange}，约 ${actualTokens} token 达预算上限。👉 用较小 turns 范围（如 T000-T005）缩小，或换 what 重试。]`
  return {
    content: [{ type: 'text', text }],
    details: {
      what,
      count: items.length,
      shown: shown.length,
      truncated: true,
      items: shown,
    },
  }
}

/** 预设 1：user-messages——收集 role==='user' 的全文（按 turn 排列，design §3.3 D3）。 */
export function extractUserMessages(turns: Turn[]): ToolResult {
  const items: Array<{ turn: number; text: string }> = []
  for (const t of turns) {
    for (const e of t.entries) {
      if (e.message?.role !== 'user') continue
      items.push({ turn: t.index, text: extractContentText(e.message.content) })
    }
  }
  return renderExtractItems(
    'user-messages',
    items,
    (it) => `T${pad(it.turn)}: ${it.text}`,
    (it) => [it.turn],
  )
}

/**
 * 预设 2：commands——assistant 的 toolCall，带 name + D1 摘要（design §3.3 D3）。
 * 可选 tool 过滤；过滤后零匹配 → F8（工具分布 + 👉，不抛错）。
 * index = entry 在 turn.entries 内的位置，与 expand 的 [N] 对齐便于定位。
 */
export function extractCommands(turns: Turn[], tool: string | undefined): ToolResult {
  const items: Array<{ turn: number; index: number; name: string; summary: string }> = []
  for (const t of turns) {
    for (let ei = 0; ei < t.entries.length; ei++) {
      const e = t.entries[ei]
      if (e.message?.role !== 'assistant') continue
      for (const tc of extractToolCalls(e)) {
        if (tool !== undefined && tc.name !== tool) continue
        items.push({
          turn: t.index,
          index: ei,
          name: tc.name,
          summary: formatToolCallSummary(tc),
        })
      }
    }
  }
  if (tool !== undefined && items.length === 0) return f8ToolNoMatch('commands', tool, turns)
  return renderExtractItems(
    'commands',
    items,
    (it) => `T${pad(it.turn)} #${it.index} ${it.summary}`,
    (it) => [it.turn],
  )
}

/**
 * 预设 3：files——read/edit/write/head 的 path 去重（design §3.3 D3）。
 * 同 path 多次操作合并，op 聚合成 `read+edit` 形式，turns 记录出现过的轮次。
 * todo/subagent/cw 无 path 不纳入。无匹配不报错（返空 + 提示）。
 */
export function extractFiles(turns: Turn[]): ToolResult {
  const map = new Map<string, { ops: Set<string>; turns: Set<number> }>()
  for (const t of turns) {
    for (const e of t.entries) {
      if (e.message?.role !== 'assistant') continue
      for (const tc of extractToolCalls(e)) {
        if (!FILE_TOOLS.has(tc.name)) continue
        const p = tc.arguments.path
        if (typeof p !== 'string') continue
        let rec = map.get(p)
        if (rec === undefined) {
          rec = { ops: new Set(), turns: new Set() }
          map.set(p, rec)
        }
        rec.ops.add(tc.name)
        rec.turns.add(t.index)
      }
    }
  }
  const items = Array.from(map.entries()).map(([path, rec]) => ({
    path,
    basename: basename(path),
    op: Array.from(rec.ops).sort().join('+'),
    turns: Array.from(rec.turns).sort((a, b) => a - b),
  }))
  return renderExtractItems(
    'files',
    items,
    (it) => `${it.op}: ${it.path} (${turnsLabel(it.turns)})`,
    (it) => it.turns,
    `what=files 无匹配（该 session 无 read/edit/write/head 文件操作）。`,
  )
}

/**
 * 预设 4：commits——git 命令 toolResult 的 hash（design §3.3 D3 + D6 误匹配处理）。
 *
 * 保守策略（宁可少召回不要乱报 uuid）：
 * ① 主路径（高置信）：只从 bash 且关联 command 含 git (log|show|commit|push|merge|...) 的
 *    toolResult 文本提取 7-8 位 hex；
 * ② 次路径（中置信）：扫所有 toolResult 文本，hash 前后各 30 字符内含
 *    feat:/fix:/commit/merge 等关键词的才纳入；
 * ③ 去重，git-cmd 置信度优先；不扫 user/assistant 自由文本（uuid/session-id 误报太多）。
 *
 * 已知局限：7-8 位 hex 与 uuid v7 片段形似，靠 git 命令上下文过滤；仍可能漏报
 *（git 操作未被 toolResult 捕获）或误报（git log 输出里的其他 hex）。每条标注来源 turn
 * + source + context，agent 可快速辨认。完全语义判断需 LLM，本工具零 LLM 依赖。
 */
/** commits 提取的 hash 前后上下文字符数（次路径关键词判定窗口）。 */
const COMMIT_CONTEXT_CHARS = 30

/** commits 预设的单条提取结果（hash + 来源 turn + 置信来源 + 上下文片段）。 */
interface CommitItem {
  hash: string
  turn: number
  source: 'git-cmd' | 'commit-context'
  context: string
}

/** 建 toolCallId → bash command 映射（用于判定 toolResult 是否来自 git 命令）。 */
function collectBashCommands(turns: Turn[]): Map<string, string> {
  const bashCmds = new Map<string, string>()
  for (const t of turns) {
    for (const e of t.entries) {
      if (e.message?.role !== 'assistant') continue
      for (const tc of extractToolCalls(e)) {
        if (tc.name === 'bash') {
          const cmd = tc.arguments.command
          if (typeof cmd === 'string') bashCmds.set(tc.id, cmd)
        }
      }
    }
  }
  return bashCmds
}

/** 单条 toolResult 文本的 hash 提取：git-cmd 全收（高置信），否则按上下文关键词过滤（次路径）。 */
function matchCommitsInResult(
  text: string,
  turnIndex: number,
  isGitBash: boolean,
  high: CommitItem[],
  low: CommitItem[],
): void {
  for (const m of text.matchAll(SHORT_HASH_RE)) {
    const hash = m[0]
    const idx = m.index ?? 0
    const ctx = text
      .slice(Math.max(0, idx - COMMIT_CONTEXT_CHARS), idx + hash.length + COMMIT_CONTEXT_CHARS)
      .replace(/\s+/g, ' ')
      .trim()
    if (isGitBash) {
      high.push({ hash, turn: turnIndex, source: 'git-cmd', context: ctx })
    } else if (COMMIT_CTX_RE.test(ctx)) {
      low.push({ hash, turn: turnIndex, source: 'commit-context', context: ctx })
    }
  }
}

/** 主扫描阶段：遍历 toolResult entry，分类收集高/低置信 commit 候选。 */
function collectCommitCandidates(
  turns: Turn[],
  bashCmds: Map<string, string>,
): { high: CommitItem[]; low: CommitItem[] } {
  const high: CommitItem[] = []
  const low: CommitItem[] = []
  for (const t of turns) {
    for (const e of t.entries) {
      if (e.message?.role !== 'toolResult') continue
      const msg = e.message
      const text = extractContentText(msg.content)
      if (text === '') continue
      const cmd = msg.toolCallId !== undefined ? bashCmds.get(msg.toolCallId) : undefined
      const isGitBash = msg.toolName === 'bash' && cmd !== undefined && GIT_CMD_RE.test(cmd)
      matchCommitsInResult(text, t.index, isGitBash, high, low)
    }
  }
  return { high, low }
}

/** 收口阶段：去重，高置信优先，同 hash 保留首次。 */
function dedupeCommits(high: CommitItem[], low: CommitItem[]): CommitItem[] {
  const seen = new Set<string>()
  const items: CommitItem[] = []
  for (const c of high) {
    if (seen.has(c.hash)) continue
    seen.add(c.hash)
    items.push(c)
  }
  for (const c of low) {
    if (seen.has(c.hash)) continue
    seen.add(c.hash)
    items.push(c)
  }
  return items
}

export function extractCommits(turns: Turn[]): ToolResult {
  // 建 toolCallId → bash command 映射（用于判定 toolResult 是否来自 git 命令）
  const bashCmds = collectBashCommands(turns)
  const { high, low } = collectCommitCandidates(turns, bashCmds)
  const items = dedupeCommits(high, low)

  return renderExtractItems(
    'commits',
    items,
    (it) => `T${pad(it.turn)} ${it.hash} [${it.source}] ${it.context}`,
    (it) => [it.turn],
    `what=commits 无匹配（该 session 无 git commit hash，或未在 toolResult 中出现）。`,
  )
}

/** tool-results 正文截断上限（防爆）。 */
const TOOL_RESULT_TEXT_MAX_CHARS = 500

/**
 * 预设 5：tool-results——role==='toolResult' 文本（design §3.3 D3）。
 * text 截断到 500 字防爆；可选 tool 过滤（msg.toolName）；过滤零匹配 → F8。
 */
export function extractToolResults(turns: Turn[], tool: string | undefined): ToolResult {
  const items: Array<{ turn: number; index: number; toolName: string; text: string }> = []
  for (const t of turns) {
    for (let ei = 0; ei < t.entries.length; ei++) {
      const e = t.entries[ei]
      if (e.message?.role !== 'toolResult') continue
      const tn = e.message.toolName ?? '?'
      if (tool !== undefined && tn !== tool) continue
      const text = truncateText(extractContentText(e.message.content), TOOL_RESULT_TEXT_MAX_CHARS)
      items.push({ turn: t.index, index: ei, toolName: tn, text })
    }
  }
  if (tool !== undefined && items.length === 0)
    return f8ToolNoMatch('tool-results', tool, turns)
  return renderExtractItems(
    'tool-results',
    items,
    (it) => `T${pad(it.turn)} #${it.index} ${it.toolName}: ${it.text}`,
    (it) => [it.turn],
  )
}
