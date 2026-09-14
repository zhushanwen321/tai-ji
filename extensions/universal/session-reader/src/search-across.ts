/**
 * search 域基础设施 + u12 跨会话内容检索（design 2026-09-10 §2 目标 5 / §8.2 V8）。
 *
 * 从 tool-handler.ts 机械提取（max-lines 拆分轮，零行为变更）。search 单会话的
 * pattern 编译/文本提取/命中收集/渲染与跨会话检索共享同一扫描管线（safeParse →
 * buildTreeView → segmentTurns → collectSearchHits），拆为独立低层模块保持单向依赖
 *（tool-handler 的 doSearch 消费本模块导出，本模块只反向 type import 公共类型）。
 */
import { dirname } from 'node:path'
import {
  buildSessionFileIndex,
  type SessionFileRef,
  type SessionMetadataEntry,
  type SessionMetadataProvider,
} from './discovery/find.js'
import { parseSessionFile } from './core/parser.js'
import { segmentTurns, type Turn } from './core/turns.js'
import { buildTreeView } from './core/tree.js'
import { err, pad } from './handler-utils.js'
import type { SessionReadSignals } from './doctor.js'
import type { SessionReadParams, ToolResult } from './tool-handler.js'

// ---------------------------------------------------------------------------
// search 辅助
// ---------------------------------------------------------------------------

/**
 * 灾难性正则形态探测（MF-5）：组内含量词/`|` 且组本身又被量词修饰的 pattern
 *（`(a+)+`、`(a*)*`、`(a|aa)+`、`(a{1,3})*` 等）对长文本指数级回溯，可挂死整个 turn（5.4MB session
 * 全文逐 entry 匹配）。内层字符类含 `{` 以捕获 `{m,n}` 范围量词（MF-1）；`(a{1,3})` 单独使用
 *（组后无尾随量词）不命中，仍按正则执行。命中则降级为字面子串匹配（与非法正则同一兜底路径）。
 * 保守拒绝（把合法但形似的 pattern 降级为子串）比挂死可接受。
 */
export function isCatastrophicPattern(pattern: string): boolean {
  return (
    /\((?:[^()\\]|\\.)*[+*?{](?:[^()\\]|\\.)*\)[+*?{]/.test(pattern) ||
    /\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)[+*?{]/.test(pattern)
  )
}

/** 编译检索 pattern：先当正则，非法/灾难性则转义为字面子串（design §3.4 pattern 子串或正则）。 */
export function compilePattern(pattern: string): RegExp {
  if (isCatastrophicPattern(pattern)) {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  }
  try {
    return new RegExp(pattern, 'i')
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  }
}

/** 安全序列化：循环引用等异常时返回空串（catch 非空——记默认值）。 */
function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return '' // 循环引用等致 stringify 失败，跳过该块
  }
}

/** search 的可检索文本：含 text/thinking/toolResult 全量（按 scope 过滤由调用方做）。 */
function searchableText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const b of content) {
      if (b && typeof b === 'object') {
        const o = b as Record<string, unknown>
        if (typeof o.text === 'string') parts.push(o.text)
        else if (typeof o.thinking === 'string') parts.push(o.thinking)
        else {
          const serialized = safeStringify(o)
          if (serialized) parts.push(serialized)
        }
      }
    }
    return parts.join('\n')
  }
  return safeStringify(content)
}

/** search 命中片段的前后上下文字符数。 */
const SNIPPET_CONTEXT_CHARS = 20

function snippet(text: string, idx: number, len: number): string {
  const start = Math.max(0, idx - SNIPPET_CONTEXT_CHARS)
  const end = Math.min(text.length, idx + len + SNIPPET_CONTEXT_CHARS)
  return (
    (start > 0 ? '…' : '') +
    text.slice(start, end).replace(/\s+/g, ' ').trim() +
    (end < text.length ? '…' : '')
  )
}

/** search action 的默认命中数上限。 */
export const SEARCH_DEFAULT_LIMIT = 20

/** search 单条命中（turn 内 entry 定位 + 角色 + 摘要片段）。 */
export interface SearchHit {
  turnIndex: number
  entryIndex: number
  role: string
  matchSnippet: string
}

/** search 扫描阶段：遍历 turns 收集命中；每 turn 前检查 abort（MF-5 尽早退出）。 */
export function collectSearchHits(
  turns: Turn[],
  regex: RegExp,
  scope: NonNullable<SessionReadParams['scope']>,
  signal: AbortSignal | undefined,
): SearchHit[] {
  const hits: SearchHit[] = []
  for (const t of turns) {
    // MF-5：Esc/abort 后 pi 已丢弃本 turn 结果，尽早退出避免继续扫描长 session
    if (signal?.aborted) {
      throw err('搜索已中断（信号 aborted）。👉 重试或换更精确的 pattern。')
    }
    for (let i = 0; i < t.entries.length; i++) {
      const msg = t.entries[i].message
      if (msg === undefined) continue
      if (scope !== 'all' && msg.role !== scope) continue
      const text = searchableText(msg.content)
      const m = regex.exec(text)
      if (m !== null) {
        hits.push({
          turnIndex: t.index,
          entryIndex: i,
          role: msg.role,
          matchSnippet: snippet(text, m.index, m[0].length),
        })
      }
    }
  }
  return hits
}

/** search 收口阶段：结果文本组装（header 标注降级/scope/截断 + 逐行命中列表）。 */
export function formatSearchText(
  pattern: string,
  degraded: boolean,
  scope: NonNullable<SessionReadParams['scope']>,
  sliced: SearchHit[],
  truncated: boolean,
): string {
  const lines = sliced.map(
    (h) => `  T${pad(h.turnIndex)} #${h.entryIndex} ${h.role}: ${h.matchSnippet}`,
  )
  return `${sliced.length} hit(s) for /${pattern}/${degraded ? '（已降级为字面子串匹配）' : ''}${
    scope !== 'all' ? ' scope=' + scope : ''
  }${truncated ? ` (truncated, showing first ${sliced.length})` : ''}\n${lines.join('\n')}`
}

// ---------------------------------------------------------------------------
// u12 跨会话内容检索（design 2026-09-10 §2 目标 5 / §8.2 V8）
// ---------------------------------------------------------------------------

/**
 * 跨会话单次检索的候选数上限（窄化前置阈值，V8「先 find 窄化，再对结果检索」）。
 * 与 result action 批量 ≤10 先例对齐；候选集全文检索成本 O(总字节)，数量上限是
 * 第一道闸（超限明确拒绝并指引先 find，不静默超时）。
 */
export const MULTI_SEARCH_MAX_SESSIONS = 10

/** 字节展示/预算换算基数（人话格式化与预算常量共用同一量纲）。 */
const BYTES_PER_KB = 1024
const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB

/** 跨会话单次检索的预算 MB 数（§8.2 V8 字节上限的量纲；换算见 SEARCH_SCAN_BYTE_BUDGET）。 */
const SEARCH_SCAN_BUDGET_MB = 64

/**
 * 跨会话单次检索的总扫描字节上限（第二道闸，design §2 Out-of-scope「阶段二先用
 * 『窄化后线性扫 + 字节上限』」）。64MB ≈ 近 3 个大型主 session（P-9 实测单主 session
 * 23MB、纯 pi 全库最坏 2.7GB）——窄化后候选 ≤10 正常远触不到；触顶即「候选集仍不够
 * 窄」或「存在超大单文件」，按列表顺序停止并报告已扫范围（防大库拖死）。
 * 测试经 searchAcrossSessions 的 byteBudget 注入小预算，不构造 64MB fixture。
 */
export const SEARCH_SCAN_BYTE_BUDGET = SEARCH_SCAN_BUDGET_MB * BYTES_PER_MB

/** 跨会话检索的单 session 扫描结果（零命中者也入 scanned——已扫范围对调用方可见）。 */
interface CrossSearchScan {
  sessionId: string
  source: 'main' | 'subagent'
  path: string
  /** 用户标题（u11 metadataProvider 尽力补全；provider 缺省/抛错留空） */
  name?: string
  hits: SearchHit[]
  /** 截断前的命中总数（> hits.length 即被 limit 截断，渲染「>N hits, showing first M」） */
  hitsTotal?: number
}

/** 跨会话检索的未扫/跳过条目（有检测必有报告：每条未扫 id 都带原因）。 */
interface CrossSearchSkipped {
  sessionId: string
  /** not-found=库中无此 id；byte-budget=字节预算在此处耗尽（其后全部未扫）；read-error=文件读取/解析失败 */
  reason: 'not-found' | 'byte-budget' | 'read-error'
  sizeBytes?: number
}

/** 跨会话检索 details（程序化消费/测试断言面）。 */
export interface CrossSearchDetails {
  pattern: string
  scope: NonNullable<SessionReadParams['scope']>
  degraded: boolean
  byteBudget: number
  /** 实际已扫字节和（只含解析成功文件） */
  scannedBytes: number
  scanned: CrossSearchScan[]
  skipped: CrossSearchSkipped[]
  truncated: boolean
}

/** 跨会话检索头部/未扫段的人话字节格式（MB 保留 1 位，<1MB 显示 KB）。 */
function formatScanBytes(bytes: number): string {
  if (bytes >= BYTES_PER_MB) return `${(bytes / BYTES_PER_MB).toFixed(1)}MB`
  return `${Math.max(1, Math.round(bytes / BYTES_PER_KB))}KB`
}

/** 调用串内嵌 pattern 的转义（文案是 JSON-ish 形态，引号/反斜杠须保真可复制执行）。 */
function escapeCallArg(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * 窄化前置拒绝（V8：宽搜明确拒绝，不静默超时）。返回结果不抛——引导类输出与
 * F1（find 零匹配）/F2（多匹配消歧）同形态。
 */
function formatCrossSearchRejected(candidateCount: number): ToolResult {
  const text = [
    `跨会话检索已拒绝：候选集 ${candidateCount} 个 session 超出单次上限 ${MULTI_SEARCH_MAX_SESSIONS} 个。`,
    `对大候选集做全文检索的扫描量不可控（单次字节上限 ${formatScanBytes(SEARCH_SCAN_BYTE_BUDGET)}）——先窄化，再检索。`,
    `👉 先窄化候选集：session_read { action:"find", query:"<标题/cwd/时间关键词>" }`,
    `   再对 find 结果中的完整 id 检索：session_read { action:"search", session:"<id1>,<id2>", pattern:"<关键词>" }（≤${MULTI_SEARCH_MAX_SESSIONS} 个）`,
  ].join('\n')
  return {
    content: [{ type: 'text', text }],
    details: { rejected: true, candidateCount, maxSessions: MULTI_SEARCH_MAX_SESSIONS },
  }
}

/**
 * 跨会话检索结果渲染：命中 session 块（完整 id + source + 标题若有 + 命中数 + 逐命中
 * turn 索引/角色/片段 + 可直接执行的调用串）+ 已扫无命中 + 未扫（超预算，附单检指引）
 * + not-found。结构行英文（渲染类现状风格），👉 指引中文（disambiguate/F1 同风格）。
 */
/** 头部：命中 session 数/已扫数 + pattern + 降级/scope 标注 + 已扫字节。 */
function formatCrossSearchHead(d: CrossSearchDetails, hitCount: number): string {
  const scannedBytesLabel = `${formatScanBytes(d.scannedBytes)} of ${formatScanBytes(d.byteBudget)} budget`
  return (
    `${hitCount}/${d.scanned.length} session(s) hit for /${d.pattern}/` +
    (d.degraded ? '（已降级为字面子串匹配）' : '') +
    (d.scope !== 'all' ? ` scope=${d.scope}` : '') +
    ` · scanned ${scannedBytesLabel}`
  )
}

/** 单个命中 session 块：`序号. id · source · 标题` + 命中数标注 + 逐命中 + 可直接执行的调用串。 */
function formatHitSessionBlock(s: CrossSearchScan, index: number, pattern: string): string[] {
  const lines: string[] = []
  const parts = [`${index}. ${s.sessionId}`, s.source]
  if (s.name !== undefined) parts.push(s.name)
  const overflow = s.hitsTotal !== undefined && s.hitsTotal > s.hits.length
  // 命中数是块级标注（对整个 session），不并入 ' · ' 信息段——紧跟末段拼接
  const countLabel = overflow
    ? `（>${s.hitsTotal} hits, showing first ${s.hits.length}）`
    : `（${s.hits.length} hit${s.hits.length === 1 ? '' : 's'}）`
  lines.push(`  ${parts.join(' · ')}${countLabel}`)
  for (const h of s.hits) {
    lines.push(`     T${pad(h.turnIndex)} #${h.entryIndex} ${h.role}: ${h.matchSnippet}`)
  }
  lines.push(
    `     ↳ session_read { action:"search", session:"${s.sessionId}", pattern:"${escapeCallArg(pattern)}" }`,
  )
  return lines
}

/** 「已扫无命中」段（空则零行）。 */
function formatNoHitSection(noHit: CrossSearchScan[]): string[] {
  if (noHit.length === 0) return []
  const lines = ['scanned, no hit:']
  for (const s of noHit) lines.push(`  ${s.sessionId} · ${s.source}`)
  return lines
}

/** 「超字节预算未扫」段（附每条的单检指引；空则零行）。 */
function formatOverBudgetSection(
  overBudget: CrossSearchSkipped[],
  d: CrossSearchDetails,
): string[] {
  if (overBudget.length === 0) return []
  const lines = [
    `not scanned (byte budget ${formatScanBytes(d.byteBudget)} reached after ${formatScanBytes(d.scannedBytes)}):`,
  ]
  for (const s of overBudget) {
    lines.push(`  - ${s.sessionId}（${formatScanBytes(s.sizeBytes ?? 0)}）`)
    lines.push(
      `    👉 检索单个：session_read { action:"search", session:"${s.sessionId}", pattern:"${escapeCallArg(d.pattern)}" }`,
    )
  }
  return lines
}

/** 「库中无此 id」段（空则零行）。 */
function formatNotFoundSection(notFound: CrossSearchSkipped[]): string[] {
  if (notFound.length === 0) return []
  const lines = ['not found in library (confirm full id via find):']
  for (const s of notFound) lines.push(`  - ${s.sessionId}`)
  return lines
}

/** 「读取/解析失败跳过」段（空则零行）。 */
function formatReadErrorSection(readErrors: CrossSearchSkipped[]): string[] {
  if (readErrors.length === 0) return []
  const lines = ['skipped (read/parse failed):']
  for (const s of readErrors) lines.push(`  - ${s.sessionId}`)
  return lines
}

/**
 * 跨会话检索结果渲染：命中 session 块（完整 id + source + 标题若有 + 命中数 + 逐命中
 * turn 索引/角色/片段 + 可直接执行的调用串）+ 已扫无命中 + 未扫（超预算，附单检指引）
 * + not-found。结构行英文（渲染类现状风格），👉 指引中文（disambiguate/F1 同风格）。
 *
 * 本函数只管段序组装；每段的行构造由上方 per-段 helper 承担（拆解自原单函数多分支，
 * 行内容与顺序零变更）。
 */
function formatCrossSearchText(d: CrossSearchDetails): string {
  const hitSessions = d.scanned.filter((s) => s.hits.length > 0)

  const lines: string[] = []
  if (hitSessions.length > 0) lines.push('hits:')
  let index = 0
  for (const s of d.scanned) {
    if (s.hits.length === 0) continue
    index += 1
    lines.push(...formatHitSessionBlock(s, index, d.pattern))
  }
  lines.push(...formatNoHitSection(d.scanned.filter((s) => s.hits.length === 0)))
  lines.push(...formatOverBudgetSection(d.skipped.filter((s) => s.reason === 'byte-budget'), d))
  lines.push(...formatNotFoundSection(d.skipped.filter((s) => s.reason === 'not-found')))
  lines.push(...formatReadErrorSection(d.skipped.filter((s) => s.reason === 'read-error')))
  if (hitSessions.length === 0 && d.scanned.length > 0) {
    lines.push('👉 无命中：换更精确 pattern，或用 find 重新窄化候选集后重试。')
  }
  return `${formatCrossSearchHead(d, hitSessions.length)}\n${lines.join('\n')}`
}

/** searchAcrossSessions 的可选参数。byteBudget 为测试注入缝（E10 定性）：非模型可见参数
 * （session_read schema 无此入参），存在动机 = 测试注入小预算触发预算截断用例，不必构造
 * 64MB fixture；生产路径（doSearch）不传，走 SEARCH_SCAN_BYTE_BUDGET 默认。 */
interface CrossSearchOptions {
  scope?: NonNullable<SessionReadParams['scope']>
  limit?: number
  signal?: AbortSignal
  metadataProvider?: SessionMetadataProvider
  byteBudget?: number
}

/** 缺省值收口后的检索参数（各缺省值与旧内联 `opts?.** ?? 常量` 逐一对应）。 */
interface CrossSearchResolvedOptions {
  scope: NonNullable<SessionReadParams['scope']>
  limit: number
  byteBudget: number
  signal: AbortSignal | undefined
  metadataProvider: SessionMetadataProvider | undefined
}

function resolveCrossSearchOptions(opts: CrossSearchOptions | undefined): CrossSearchResolvedOptions {
  return {
    scope: opts?.scope ?? 'all',
    limit: opts?.limit ?? SEARCH_DEFAULT_LIMIT,
    byteBudget: opts?.byteBudget ?? SEARCH_SCAN_BYTE_BUDGET,
    signal: opts?.signal,
    metadataProvider: opts?.metadataProvider,
  }
}

/** 单 session 扫描结果：命中块 + 截断标记；read-error 不入 scanned（只归 skipped）。 */
type CrossSearchSessionScan =
  | { kind: 'scanned'; scan: CrossSearchScan; truncated: boolean }
  | { kind: 'read-error' }

/**
 * 单 session 扫描：复用单会话扫描管线（core 层只读复用，零新解析）；坏文件返回
 * read-error 不拖死整体（F6 只属单会话契约）。
 */
async function scanOneSession(
  sessionId: string,
  ref: SessionFileRef,
  regex: RegExp,
  scope: NonNullable<SessionReadParams['scope']>,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<CrossSearchSessionScan> {
  let turns: Turn[]
  try {
    const { entries } = await parseSessionFile(ref.path)
    turns = segmentTurns(entries, new Set(buildTreeView(entries).leafPath))
  } catch {
    return { kind: 'read-error' }
  }
  const hits = collectSearchHits(turns, regex, scope, signal)
  if (hits.length > limit) {
    return {
      kind: 'scanned',
      truncated: true,
      scan: {
        sessionId,
        source: ref.source,
        path: ref.path,
        hits: hits.slice(0, limit),
        hitsTotal: hits.length,
      },
    }
  }
  return {
    kind: 'scanned',
    truncated: false,
    scan: { sessionId, source: ref.source, path: ref.path, hits },
  }
}

/**
 * 字节预算耗尽：从下标起整段标未扫（含更小的后续文件也不扫）——已扫范围恒为
 * 列表前缀，报告无歧义；超大单文件走括注的单检通路（单会话 search 不受此预算）。
 */
function markRestOverBudget(
  ids: string[],
  startIndex: number,
  index: Map<string, SessionFileRef>,
  skipped: CrossSearchSkipped[],
): void {
  for (const rest of ids.slice(startIndex)) {
    skipped.push({ sessionId: rest, reason: 'byte-budget', sizeBytes: index.get(rest)?.sizeBytes })
  }
}

/**
 * 标题尽力补全（u11 provider 复用；仅对已扫 session 的所在目录，按目录去重 +
 * 单目录 try/catch 记空——provider 缺省/抛错标题留空，检索本体不受影响）。
 */
async function attachScannedTitles(
  scanned: CrossSearchScan[],
  provider: SessionMetadataProvider,
): Promise<void> {
  const titles = new Map<string, string>()
  for (const dir of new Set(scanned.map((s) => dirname(s.path)))) {
    let entries: SessionMetadataEntry[]
    try {
      entries = await provider(dir)
    } catch {
      continue // 降级：该目录标题不可用（§6.6 同款 guard），留空继续
    }
    for (const e of entries) {
      if (e.name !== undefined) titles.set(e.id, e.name)
    }
  }
  for (const s of scanned) {
    const name = titles.get(s.sessionId)
    if (name !== undefined) s.name = name
  }
}

/**
 * 跨会话内容检索主体（u12 导出：byteBudget 为测试注入缝，非模型可见——工具路径经
 * doSearch 走默认 SEARCH_SCAN_BYTE_BUDGET）。
 *
 * 流程：窄化拒绝（候选 > MULTI_SEARCH_MAX_SESSIONS，V8）→ buildSessionFileIndex（一次
 * 根扫描，id 语义与 find 候选同源）→ 按传入顺序逐个「复用单会话扫描管线」（safeParse →
 * buildTreeView → segmentTurns → collectSearchHits，零新解析；signal.abort 中断与单会话
 * 一致抛错）→ 字节预算按序消耗（放不下的文件起整段停止，已扫范围 = 列表前缀，报告
 * 每条未扫 id 与原因）→ 标题尽力补全（仅对已扫 session 的目录调 metadataProvider，
 * 按目录去重 + 单目录 try/catch 降级留空）→ 渲染。
 *
 * limit 语义延续单会话（每 session 命中数上限，默认 SEARCH_DEFAULT_LIMIT）；候选 ≤10
 * 且每 session ≤limit 命中，输出规模有界。truncated = 任一 session 命中被截断。
 */
export async function searchAcrossSessions(
  ids: string[],
  pattern: string,
  signals: SessionReadSignals,
  opts?: CrossSearchOptions,
): Promise<ToolResult> {
  // ① 窄化前置（V8）：候选集超阈值明确拒绝（不进入扫描）
  if (ids.length > MULTI_SEARCH_MAX_SESSIONS) {
    return formatCrossSearchRejected(ids.length)
  }

  const { scope, limit, byteBudget, signal, metadataProvider } = resolveCrossSearchOptions(opts)
  const degraded = isCatastrophicPattern(pattern)
  const regex = compilePattern(pattern)

  // ② 候选索引（一次根扫描；候选数上限在上方已闸，索引只做 id 全覆盖）
  const index = await buildSessionFileIndex(signals)

  // ③ 按传入顺序逐个扫描（调用方列表顺序即优先级，字节预算按序消耗）
  const scanned: CrossSearchScan[] = []
  const skipped: CrossSearchSkipped[] = []
  let scannedBytes = 0
  let truncated = false
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!
    const ref = index.get(id)
    if (ref === undefined) {
      skipped.push({ sessionId: id, reason: 'not-found' })
      continue
    }
    if (scannedBytes + ref.sizeBytes > byteBudget) {
      markRestOverBudget(ids, i, index, skipped)
      break
    }
    const outcome = await scanOneSession(id, ref, regex, scope, limit, signal)
    if (outcome.kind === 'read-error') {
      skipped.push({ sessionId: id, reason: 'read-error' })
      continue
    }
    if (outcome.truncated) truncated = true
    scanned.push(outcome.scan)
    scannedBytes += ref.sizeBytes
  }

  // ④ 标题尽力补全
  if (metadataProvider !== undefined && scanned.length > 0) {
    await attachScannedTitles(scanned, metadataProvider)
  }

  const details: CrossSearchDetails = {
    pattern,
    scope,
    degraded,
    byteBudget,
    scannedBytes,
    scanned,
    skipped,
    truncated,
  }
  return { content: [{ type: 'text', text: formatCrossSearchText(details) }], details }
}
