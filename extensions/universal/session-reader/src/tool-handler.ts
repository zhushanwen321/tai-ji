/**
 * [M3 工具适配层] session_read 工具的纯逻辑 handler（design §3.4 接口规格）。
 *
 * 分层约定（同 scheduler/cw-tool）：本文件零 pi 依赖——agentDir 作参数注入，
 * 不调用 getAgentDir()，可完全单测；pi 注册与 getAgentDir() 调用在 index.ts。
 *
 * 按 action 分发到 11 条路径，串联 M1 core（parser/tree/turns/render）+ M2 discovery
 *（find/subagents）+ doctor 的环境判定与根表渲染（u8，discovery/env）。content 给 LLM
 * 读（人类可读摘要），details 供程序化消费/测试断言。
 *
 * 域模块拆分（max-lines 拆分轮机械提取，零行为变更，result-action.ts 先例同型）：
 *   result-action.ts（result）/ doctor.ts（doctor + SessionReadSignals）/
 *   search-across.ts（search 管线 + u12 跨会话）/ extract.ts（extract 预设）/
 *   no-match.ts（F1 自检行）/ handler-utils.ts（pad/err/stripHash/requireStr/
 *   SESSION_ID_PREFIX_LEN/turn 索引解析低层小工具）。
 * 本模块保留公共类型、定位解析（resolveSessionId）、各 action 编排与共享渲染；
 * 域模块符号不经此 re-export——从所属域模块直接 import（唯一例外 SessionReadSignals：
 * 本模块 re-export 供 index.ts 生产消费）。
 *
 * 错误规格 F1-F6：handler 抛 Error（message 含 👉 恢复指引），index.ts 的 execute 闭包
 * 原样传播给 pi——pi-agent-core 只对 execute throw 置 isError:true（返回值里的 isError
 * 字段被丢弃，agent-loop.js:453-483）。handler 可抛（纯逻辑可测）。
 * 例外：F2 多匹配与 F1 find 零匹配「不视为错误」，返回消歧/提示结果而非抛错。
 */
import { existsSync } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { toErrorMessage } from '@zhushanwen/pi-ext-guards'
import {
  findSessions,
  type MatchedSession,
  type SessionMetadataEntry,
  type SessionMetadataProvider,
} from './discovery/find.js'
import { resolveSessionRoots, type SessionRoot } from './discovery/roots.js'
import { readSessionHeaderIdSync } from './discovery/session-header.js'
import {
  buildFamilyFromFs,
  listRecordManifests,
  type RecordManifest,
} from './discovery/subagents.js'
import { readRunSnapshot, resolveWorkflows } from './discovery/workflows.js'
import { parseSessionFile, type Entry, type ParseResult } from './core/parser.js'
import { parseRunSnapshot, renderWorkflowOverview, type WorkflowOverview } from './core/workflow.js'
import { buildTreeView } from './core/tree.js'
import { segmentTurns } from './core/turns.js'
import {
  renderOutline,
  renderExpand,
  renderDetail,
  formatBytesMarker,
  type OutlineOptions,
  type OutlineResult,
  type EntryBrief,
  type ToolResultSummaryEntry,
} from './core/render.js'
import type { Family, SessionRef, WorkflowRef } from './core/family.js'
import { doResult } from './result-action.js'

// result action 主体在 result-action.ts（max-lines 拆分轮机械提取，零行为变更）。
import {
  buildExecutionTree,
  formatExecutionTreeText,
  type ExecutionTree,
} from './core/execution-tree.js'
// 同轮拆分的域模块（依赖方向：本模块 → 域模块 → handler-utils，无循环；
// 域模块对本模块仅 type import——编译期擦除，同 result-action.ts 先例）。
// stripHash/requireStr/SESSION_ID_PREFIX_LEN 经 handler-utils 供本模块与 result-action
// 直接消费（ext-simplify-04 E5：同包 helper 获取范式单一化）。
import {
  SESSION_ID_PREFIX_LEN,
  err,
  pad,
  parseTurnIndex,
  parseTurnsRange,
  rangeLabel,
  requireStr,
  stripHash,
} from './handler-utils.js'
import { formatNoMatch } from './no-match.js'
import {
  collectSearchHits,
  compilePattern,
  formatSearchText,
  isCatastrophicPattern,
  searchAcrossSessions,
  SEARCH_DEFAULT_LIMIT,
} from './search-across.js'
import {
  extractCommits,
  extractCommands,
  extractFiles,
  extractToolResults,
  extractUserMessages,
  type ExtractWhat,
} from './extract.js'
import { doDoctor, type SessionReadSignals } from './doctor.js'

// SessionReadSignals re-export 是生产链（index.ts 工具注册消费），非测试兼容转发。
export type { SessionReadSignals }

// ---------------------------------------------------------------------------
// 公共类型（与 index.ts 的 TypeBox schema 对齐）
// ---------------------------------------------------------------------------

export type SessionReadAction =
  | 'find'
  | 'family'
  | 'outline'
  | 'expand'
  | 'detail'
  | 'search'
  | 'export'
  | 'extract'
  | 'workflow'
  | 'result'
  | 'doctor'

export interface SessionReadParams {
  action: SessionReadAction
  session?: string
  query?: string
  turns?: string
  turn?: string
  pattern?: string
  scope?: 'all' | 'user' | 'assistant' | 'toolResult'
  format?: 'outline' | 'full' | 'family'
  includeToolResult?: boolean
  includeThinking?: boolean
  allBranches?: boolean
  granularity?: 'turn' | 'entry'
  cwd?: string
  /** find/resolveSessionId: 按来源过滤。"main" = sessions/、"subagent" = subagents/。默认两者合并。 */
  source?: 'main' | 'subagent'
  /** workflow action: 可选，聚焦单个 runId（多 run 消歧）。不传 → 全部 run 概览。 */
  runId?: string
  limit?: number
  /** extract action: 素材类型（必填）。其他 action 忽略。 */
  what?: 'user-messages' | 'commands' | 'files' | 'commits' | 'tool-results'
  /** extract action: 过滤 commands/tool-results 的工具名（可选）。 */
  tool?: string
  /** family action: 返回嵌套执行树（任意深度 subagent↔workflow-call 相互嵌套）。默认 false（flat family）。 */
  recursive?: boolean
  /**
   * doctor action: 是否同时扫描 subagent 根（产文件数）。默认 false——subagent 根在纯 pi
   * 下可达数千文件，doctor 可能被反复询问（design 2026-09-10 §6.3 成本控制），默认只列
   * 路径与可扫性（exists）。
   */
  includeSubagents?: boolean
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  details: unknown
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** formatDate 日期段（月/日）补零宽度。 */
const DATE_FIELD_WIDTH = 2

function formatDate(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(DATE_FIELD_WIDTH, '0')}-${String(
    d.getDate(),
  ).padStart(DATE_FIELD_WIDTH, '0')}`
}

/** shortCwd 保留的目录末段数。 */
const SHORT_CWD_SEGMENTS = 2

/** cwd 取末两段缩短显示（完整 cwd 在 details 里）。 */
function shortCwd(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts.slice(-SHORT_CWD_SEGMENTS).join('/')
}

// ---------------------------------------------------------------------------
// resolveSessionId：片段 → 完整 id（design §3.4 resolveSessionId 辅助）
// ---------------------------------------------------------------------------

export type ResolveResult =
  | { kind: 'ok'; sessionId: string; fileName: string }
  | { kind: 'multi'; query: string; candidates: MatchedSession[] }

// readSessionHeaderIdSync（同步读首行 header 取 id，resolveSessionId 形态①/②消费）
// 在 discovery/session-header.ts（D5 单源，sync 4KB 版原样搬入）。

/** ~ 前缀（home 目录简写），与 expandHome 配套避免 magic number。 */
const HOME_TILDE_PREFIX = '~/'

/** 展开 ~ 前缀到 homedir（'~' → homedir；'~/x' → homedir/x；其余原样）。 */
function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith(HOME_TILDE_PREFIX))
    return join(homedir(), p.slice(HOME_TILDE_PREFIX.length))
  return p
}

/**
 * 把 session 参数解析到唯一完整 id（design §6.1 M0 + U2/U3）。三形态各拆独立解析器：
 * resolveBySessionPath（① 绝对路径/~）→ resolveByRecordId（② sa- 前缀）→ resolveByFragment（③ 片段）。
 * 错误契约（U3）：① 文件不存在/非 .jsonl/header 读不出 → F6 风格；② sessionFile GC → ES1（manifest 元数据 + 👉）；
 * sa-id 0/>1 命中 → ES2（👉 family）。仅用于 family/outline/expand/detail/search/export/extract/workflow/result
 *（find 自行调 findSessions，零匹配时返回空 + 提示，不抛错；doctor 为环境自检，无 session 解析）。
 *
 * liveSessionDir（§6.1 信号 1）只作用于形态③：片段匹配与 find 消费同一 roots
 *（[live] 根对片段解析可见——否则 find 能列出的 session 在 [live]≠[default] 环境
 * 下 outline 等解析不到，违反「同一 roots」契约）；①按路径直读、②按 agentDir 下
 * manifest 反查，均不依赖根列表，不消费该信号。
 */
async function resolveSessionId(
  rawSession: string | undefined,
  action: SessionReadAction,
  agentDir: string,
  source?: 'main' | 'subagent',
  /** S3（code-simplify）：批量调用方（doResult）预取的 manifest 列表——省去逐 id
   *  重复全量扫 subagents/ 树（N+1）。单 id 调用点不传，行为零变化。 */
  prefetchedManifests?: RecordManifest[],
  /** 信号包中的 liveSessionDir，透传形态③（resolveByFragment）；缺省 = 三根降级。 */
  liveSessionDir?: string,
): Promise<ResolveResult> {
  const session = stripHash(requireStr(rawSession, 'session', action))

  // ① 绝对路径或 ~ 前缀（Windows 盘符由 isAbsolute 处理）
  if (isAbsolute(session) || session === '~' || session.startsWith('~/')) {
    return resolveBySessionPath(session)
  }

  // ② sa-id 前缀 → record manifest 精确反查
  if (session.startsWith('sa-')) {
    return resolveByRecordId(session, agentDir, prefetchedManifests)
  }

  // ③ 其余：findSessions 透传 source/liveSessionDir 沿用 F1/F2
  return resolveByFragment(session, agentDir, source, liveSessionDir)
}

/** 形态①：绝对路径 / ~ 前缀 → 展开后读首行 header，sessionId=header 真实 id（文件名仅定位）。 */
function resolveBySessionPath(session: string): ResolveResult {
  const expanded = expandHome(session)
  if (!expanded.endsWith('.jsonl')) {
    throw err(
      `读取失败：${session}（非 .jsonl session 文件）。👉 检查文件或换 session。`,
    )
  }
  if (!existsSync(expanded)) {
    throw err(`读取失败：${session}（文件不存在）。👉 检查文件或换 session。`)
  }
  const headerId = readSessionHeaderIdSync(expanded)
  if (headerId === undefined) {
    throw err(
      `读取失败：${session}（首行非合法 session header）。👉 检查文件或换 session。`,
    )
  }
  return { kind: 'ok', sessionId: headerId, fileName: expanded }
}

/**
 * 形态②：sa-id 前缀 → record manifest 精确反查，sessionId=sessionFile header id
 *（禁止降级 record.id——sa- 形态不可当 sessionId，CQ3 决策）。批量调用方传预取列表
 *（S3：避免逐 id 全量重扫）；单 id 调用点现场扫一次。
 */
async function resolveByRecordId(session: string, agentDir: string, prefetchedManifests: RecordManifest[] | undefined): Promise<ResolveResult> {
  const manifests = prefetchedManifests ?? (await listRecordManifests(agentDir))
  const hits = manifests.filter((m) => m.id === session)
  if (hits.length === 0) {
    throw err(formatSaIdNotFound(session))
  }
  if (hits.length > 1) {
    throw err(formatSaIdAmbiguous(session, hits))
  }
  const record = hits[0]
  if (!existsSync(record.sessionFile)) {
    throw err(formatSessionGc(record))
  }
  const headerId = readSessionHeaderIdSync(record.sessionFile)
  if (headerId === undefined) {
    // header 读不出不降级 record.id（sa- 形态不可当 sessionId，CQ3）
    throw err(
      `读取失败：${record.sessionFile}（首行非合法 session header）。👉 检查文件或换 session。`,
    )
  }
  return { kind: 'ok', sessionId: headerId, fileName: record.sessionFile }
}

/**
 * 形态③：其余片段 → findSessions 透传 source/liveSessionDir 沿用 F1（零匹配）/ F2（多匹配消歧）。
 * liveSessionDir 透传保证片段匹配与 find 同一 roots；F1 自检行同理须含 [live] 根行
 *（否则 [live]≠[default] 环境下自检行看不到最高优先级根，计数失真）。
 */
async function resolveByFragment(
  session: string,
  agentDir: string,
  source?: 'main' | 'subagent',
  liveSessionDir?: string,
): Promise<ResolveResult> {
  const opts = {
    limit: 10,
    ...(source ? { source } : {}),
    ...(liveSessionDir ? { liveSessionDir } : {}),
  }
  const { matches } = await findSessions(session, agentDir, opts)
  if (matches.length === 0) {
    // F1 自检行需要发现层实况：无 options 的 resolveSessionRoots 恒实扫（根扫描无
    // 缓存——doctor 缓存机已删除，ext-simplify-04 U3），与 find 刚完成的扫描同一数据
    // 源（roots.ts 薄包装语义）；信号包同源（liveSessionDir 透传）——findSessions
    // 内部对空串/undefined 已有降级 guard。
    const roots = await resolveSessionRoots({ agentDir, liveSessionDir })
    throw err(formatNoMatch(session, roots))
  }
  if (matches.length === 1) {
    return { kind: 'ok', sessionId: matches[0].sessionId, fileName: matches[0].fileName }
  }
  return { kind: 'multi', query: session, candidates: matches }
}

/** ES1（SESSION_FILE_GC）：sa-id 恰 1 命中但 sessionFile 不存在（GC/未写入）。含 manifest 元数据 + 👉。 */
function formatSessionGc(record: RecordManifest): string {
  return (
    `subagent "${record.id}" 的 session 文件不存在（可能已被 GC 或未写入）：\n` +
    `  rootSessionId: ${record.rootSessionId}\n` +
    `  agentName: ${record.agentName ?? '(未记录)'}\n` +
    `  sessionFile: ${record.sessionFile}\n` +
    `👉 改用 session_read { action:"family" } 查该 subagent 的后代，或换一个 completed subagent 重试。`
  )
}

/** ES2（SA_ID_NO_MATCH）：sa-id 无精确匹配（可能仍在运行 / 片段输入）。 */
function formatSaIdNotFound(saId: string): string {
  return (
    `subagent "${saId}" 无匹配 record（若刚启动，record 可能尚未落盘）。` +
    `\n👉 用 session_read { action:"family" } 查活跃/已完成的 subagent；` +
    `若是片段输入，请用完整 sa- id 或 action:"find" 重试。`
  )
}

/** ES2（SA_ID_AMBIGUOUS）：sa-id 多 manifest 命中（数据异常，record.id 应唯一）。 */
function formatSaIdAmbiguous(saId: string, records: RecordManifest[]): string {
  return (
    `subagent "${saId}" 匹配 ${records.length} 个 record（数据异常，record.id 应唯一）：\n` +
    records
      .map((r) => `  ${r.id} (root=${r.rootSessionId} file=${r.sessionFile})`)
      .join('\n') +
    `\n👉 用 session_read { action:"family" } 或完整 session uuid 重试。`
  )
}

/** 消歧提示的 uuid 片段长度（比短显略长，引导输入更长片段消歧）。 */
const HINT_ID_PREFIX_LEN = 12

/** F2 多匹配消歧结果（不抛错，返回候选 + 👉）。 */
function disambiguate(query: string, candidates: MatchedSession[]): ToolResult {
  const lines = candidates.map(
    (m, i) =>
      `  ${i + 1}. ${m.sessionId} · ${formatDate(m.mtime)}${m.firstMessagePreview ? ' · ' + m.firstMessagePreview : ''}`,
  )
  const hint =
    candidates[0] !== undefined
      ? `（如 ${candidates[0].sessionId.slice(0, HINT_ID_PREFIX_LEN)}）`
      : ''
  const text =
    `${candidates.length} 个匹配 "${query}"：\n${lines.join('\n')}\n` +
    `👉 用更长的 uuid 片段${hint}，或 action:"find" 加 cwd 过滤。`
  return { content: [{ type: 'text', text }], details: { ambiguous: true, candidates } }
}

// ---------------------------------------------------------------------------
// 文件读取（F6 包装）
// ---------------------------------------------------------------------------

async function safeParse(fileName: string): Promise<ParseResult> {
  try {
    return await parseSessionFile(fileName)
  } catch (e) {
    throw err(
      `读取失败：${fileName}（${toErrorMessage(e)}）。👉 检查文件或换 session。`,
    )
  }
}

// ---------------------------------------------------------------------------
// 文本渲染（content）
// ---------------------------------------------------------------------------

/**
 * find 分组渲染的单组数据（u10，design 2026-09-10 §6.7 子决策 2）。
 * main 组恒在 groups 首位（置顶），编号跨组连续。
 */
interface FindGroup {
  source: 'main' | 'subagent'
  /** 配额切片后实际展示的候选 */
  shown: MatchedSession[]
  /** 溢出：该组命中数 > shown.length（+1 探测；溢出时精确总数未知，只知更多） */
  overflow: boolean
}

/**
 * find 输出渲染（u10 分组版，design §5.1 形态 + §6.7 子决策 2/3 精确规格）：
 *
 * - 按 source 分组、main 段置顶（subagent 噪声不淹没目标），组头标注各组命中数，
 *   组内编号跨组连续（§5.1 示例：subagent 段从 main 段末尾续号）。
 * - 候选行打印完整 sessionId（废除 8 字符截断——agent 拿到截断 id 无法粘回做精确调用，
 *   §3.2 失败模式 D）。SESSION_ID_PREFIX_LEN 常量本体与 result 通路不动（§6.7 范围声明）。
 * - 每条 main 候选附一行可直接复制执行的 outline 调用串（↳，§6.7 子决策 3）；
 *   subagent 候选不附（噪声不配指针）。
 * - 候选行末段文本：标题优先（u11，name 来自 SessionManager.listAll，§5.1 形态
 *   「… · 福耀玻璃深度研究」），无标题回退首消息预览（现状行为）。
 * - truncated 按**合并总量**（命中总数 vs 实际输出数）计算，由调用方传入，此处只负责标注。
 * - subagent 段超配额折叠为一行展开提示（加 source:"subagent" 查看）；main 段溢出
 *   仅在组头标注（规格的折叠提示只针对 subagent）。
 */
function formatFindContent(query: string, groups: FindGroup[], truncated: boolean): string {
  const shown = groups.flatMap((g) => g.shown)
  const head = `${shown.length} session(s) matched "${query}"${
    truncated ? ` (truncated, showing first ${shown.length})` : ''
  }`
  const lines: string[] = []
  let index = 0
  for (const g of groups) {
    lines.push('')
    if (g.overflow && g.shown.length === 0) {
      // main 占满配额、subagent 有命中但 0 条展示（§6.7：「subagent 段为 0 条仅显示计数」；
      // 命中总数须全量深读首条 user 才能精确计数，recent 形态下 IO 不可接受，只报有命中）
      lines.push(`${g.source}（有命中未显示——展示配额已被 main 占满）：`)
    } else if (g.overflow) {
      lines.push(`${g.source}（>${g.shown.length} 条命中，显示前 ${g.shown.length} 条）：`)
    } else {
      lines.push(`${g.source}（${g.shown.length} 条命中）：`)
    }
    for (const m of g.shown) {
      index += 1
      const parts = [`${index}. ${m.sessionId}`, formatDate(m.mtime)]
      if (m.cwd) parts.push(shortCwd(m.cwd))
      if (m.name) parts.push(m.name)
      else if (m.firstMessagePreview) parts.push(m.firstMessagePreview)
      lines.push(`  ${parts.join(' · ')}`)
      if (g.source === 'main') {
        lines.push(`     ↳ session_read { action:"outline", session:"${m.sessionId}" }`)
      }
    }
    if (g.overflow && g.source === 'subagent') {
      lines.push('  … 另有 subagent 命中未显示。👉 加 source:"subagent" 查看')
    }
  }
  return `${head}\n${lines.join('\n')}`
}

/**
 * outline 尾段（stats 摘要行 + truncated 提示）。E7/D3 行渲染统一：行主体 = result.lines
 *（renderOutline 返回的渲染行，预算度量与展示同一份），行格式知识只在 core/render.ts 的
 * formatLine 一处，tool-handler 不再重建行格式；本函数只拼 stats 尾段（skippedLines 由
 * doOutline 用 ParseResult 覆盖后再渲染）。doOutline/doExport 同一拼装
 * （`lines.join('\n')` + 本尾段），两 action 输出一致 by construction。
 */
function formatOutlineTail(r: OutlineResult): string {
  const tail = [
    `${r.stats.totalTurns} turns · ${r.stats.totalEntries} entries · ~${r.tokenEstimate} tokens${
      r.stats.skippedLines > 0 ? ` · ${r.stats.skippedLines} skipped lines` : ''
    }`,
    r.truncated ? `[还有 ${r.truncated} 轮未显示，用 detail 的 turns 参数看指定 turn 范围]` : '',
  ]
    .filter(Boolean)
    .join('\n')
  return tail
}

function formatExpandText(turn: string, entries: EntryBrief[]): string {
  const lines = entries.map(
    (e) =>
      `  [${e.index}] ${e.type}${e.role ? '/' + e.role : ''} ${e.brief}${
        e.omittedBytes > 0 ? ' ' + formatBytesMarker(e.omittedBytes) : ''
      }`,
  )
  return `${turn}\n${lines.join('\n')}`
}

/** 从 message.content 提取可读文本（text/thinking 块；toolCall 留 name 占位）。 */
function messageReadableText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b && typeof b === 'object') {
          const o = b as Record<string, unknown>
          if (o.type === 'text' && typeof o.text === 'string') return o.text
          if (o.type === 'thinking' && typeof o.thinking === 'string') return `[thinking] ${o.thinking}`
          if (o.type === 'toolCall')
            return `[toolCall: ${typeof o.name === 'string' ? o.name : '?'}]`
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/**
 * ToolResultSummaryEntry 判别（Entry.type 是宽 string，TS 无法靠 === 判别联合，须显式谓词收窄）。
 */
function isToolResultSummary(
  e: Entry | ToolResultSummaryEntry,
): e is ToolResultSummaryEntry {
  return e.type === 'toolResultSummary'
}

/**
 * 从 message.content 提取可读文本（text/thinking 块；toolCall 留 name 占位）。
 * v2 O3：接受 Entry | ToolResultSummaryEntry，toolResultSummary 返摘要文本（doExport full 用）。
 */
function entryReadableText(e: Entry | ToolResultSummaryEntry): string {
  if (isToolResultSummary(e)) {
    return `${e.summary} (共 ${e.totalLines} 行，前 3 行：${e.headLines})`
  }
  const msg = e.message
  if (msg !== undefined) {
    if (msg.role === 'toolResult') return `[toolResult] ${messageReadableText(msg.content)}`
    return messageReadableText(msg.content)
  }
  if (e.type === 'compaction')
    return `[compaction] ${typeof e.summary === 'string' ? e.summary : JSON.stringify(e.summary ?? '')}`
  if (e.type === 'custom') return `[custom:${e.customType ?? '?'}]`
  return `[${e.type}]`
}

function formatDetailText(
  range: { start: number; end: number },
  entries: Array<Entry | ToolResultSummaryEntry>,
): string {
  const head = `turns ${rangeLabel(range)} · ${entries.length} entries`
  const body = entries
    .map((e) => {
      if (isToolResultSummary(e)) {
        // v2 O3：摘要态渲染（summary + 头 3 行 + 看全文提示）
        return `---\ntoolResultSummary (${e.id.slice(0, SESSION_ID_PREFIX_LEN)})\n${e.summary}\n     │ 共 ${e.totalLines} 行，前 3 行：${e.headLines}\n     │ （+ includeToolResult:true 看全文）`
      }
      const role = e.message ? `/${e.message.role}` : ''
      return `---\n${e.type}${role} (${e.id.slice(0, SESSION_ID_PREFIX_LEN)})\n${entryReadableText(e)}`
    })
    .join('\n')
  return `${head}\n${body}`
}

/**
 * family subagents 行的 task 摘要截断宽度（D2②：LLM 判断「哪个 subagent 分支相关」所需
 * 的信息量，信息密度对齐 find 的 firstMessagePreview；探针 P4 输出量级锚点）。
 */
const FAMILY_TASK_RENDER_LIMIT = 60

/**
 * task → 单行摘要：压平空白（task 原文可含换行，换行会破坏 family 输出的行结构）后截断。
 */
function familyTaskSummary(task: string): string {
  const flat = task.replace(/\s+/g, ' ').trim()
  return flat.length <= FAMILY_TASK_RENDER_LIMIT ? flat : flat.slice(0, FAMILY_TASK_RENDER_LIMIT) + '…'
}

/**
 * subagents 行富字段展示（ext-simplify-04 D2②）：status 终态短标签 + agent 名 + task 摘要。
 * 富字段来自 manifest/identity 组装（SubagentRef，不经 enrichRefs——已删除）；孤儿
 *（cleanedUp）只标 [已清理]，不再展开摘要（已清理即终局，文件 GC 后无深读入口）。
 */
function formatSubagentLine(s: Family['subagents'][number]): string {
  const base = `  ${s.sessionId.slice(0, SESSION_ID_PREFIX_LEN)} root=${s.rootSessionId.slice(0, SESSION_ID_PREFIX_LEN)} slug=${s.slug}`
  if (s.cleanedUp) return `${base} [已清理]`
  const parts: string[] = []
  if (s.status) parts.push(`[${s.status}]`)
  if (s.agentName) parts.push(s.agentName)
  if (s.task) parts.push(`· ${familyTaskSummary(s.task)}`)
  return parts.length > 0 ? `${base} ${parts.join(' ')}` : base
}

function formatFamilyText(f: Family): string {
  const lines: string[] = []
  lines.push(`root: ${f.root.sessionId} (${formatDate(f.root.mtime)})`)
  if (f.parents.length)
    lines.push(`parents: ${f.parents.map((p) => p.sessionId.slice(0, SESSION_ID_PREFIX_LEN)).join(', ')}`)
  if (f.forks.length)
    lines.push(`forks: ${f.forks.map((p) => p.sessionId.slice(0, SESSION_ID_PREFIX_LEN)).join(', ')}`)
  if (f.subagents.length)
    lines.push(`subagents:\n${f.subagents.map(formatSubagentLine).join('\n')}`)
  if (f.workflows.length)
    lines.push(
      `workflows:\n${f.workflows
        .map((w) => `  ${w.runId} (${w.calls.length} calls)`)
        .join('\n')}`,
    )
  return lines.join('\n')
}

// ===========================================================================
// 各 action 实现
// ===========================================================================

/** find action 的默认匹配数上限。 */
const FIND_DEFAULT_LIMIT = 20

/**
 * find 零匹配：F1 自检行（u9）。计数取本次实扫（无 options 恒实扫——根扫描无缓存，
 * doctor 缓存机已删除，ext-simplify-04 U3），完整信号包保证 [live] 根（最高优先级）
 * 计数可见。
 *
 * E1（ext-simplify-04 §3 D1）：roots 由 doFind 预解析传入——与匹配用同一次实扫
 * （调用方保证无 options），不再独立第三次全量扫盘。
 */
function findNoMatch(query: string, roots: SessionRoot[]): ToolResult {
  return {
    content: [{ type: 'text', text: formatNoMatch(query, roots) }],
    details: { matches: [], truncated: false },
  }
}

/**
 * find：按片段/名称/recent 定位 session（design §3.4 find）。零匹配不抛，返回提示。
 *
 * u10 分组（design 2026-09-10 §6.7 子决策 2 精确规格，纯展示层规则）：
 * - `limit` 作用于**分组后的合并列表**：main 段优先占满（上限 limit），剩余配额给
 *   subagent 段；main 命中 > limit 时 subagent 段为 0 条仅显示计数 + 展开提示。
 * - `truncated` 按**合并总量**（命中总数 vs 实际输出数）计算：各 source 独立查询以
 *   「配额 +1」探测溢出，`hasMore ⟺ 该组命中数 > 该组展示数`，合取即精确等价于
 *   「命中总数 > 实际输出数」，与单次合并查询的 truncated 语义逐值一致。
 * - 匹配层 findSessions 不动：分组只是展示规则，各 source 独立查询的组内语义仍是
 *   mtime 排序 + limit 截断。subagent 溢出时不做精确计数（需对全部命中深读首条 user，
 *   recent 形态下命中可达全库量级，IO 不可接受），折叠行只报「有更多 + 展开方式」。
 * - 显式 source 过滤走单组查询（现状语义）：显式 source 本身就是折叠提示所指的展开
 *   动作，不再折叠。
 *
 * u11（design 2026-09-10 §6.6）：metadataProvider / liveSessionDir 透传匹配层——标题
 * 检索的惰性/窄化/TTL 缓存策略都在发现层与注入包装侧，本函数只负责透传（缺省
 * undefined = 现状行为）。多次 findSessions 调用（分组探测）经注入侧 TTL 缓存去重，
 * 标题 listAll 每 TTL 窗口至多一次/目录。
 *
 * E1 预解析根复用（ext-simplify-04 §3 D1，清 impl-plan D-15④ 债）：开头一次
 * resolveSessionRoots(signals)（无 options 恒实扫——根扫描无缓存，doctor 缓存机
 * 已删除，ext-simplify-04 U3），显式 source / 分组两段 findSessions 与零匹配
 * findNoMatch（F1 自检行）共用——一次 doFind 内 signals 恒同值、数据完全同源，
 * 目录扫描从 2-3 次收敛为恒 1 次。
 */
async function doFind(
  params: SessionReadParams,
  signals: SessionReadSignals,
  metadataProvider?: SessionMetadataProvider,
): Promise<ToolResult> {
  const query = requireStr(params.query, 'query', 'find')
  const limit = params.limit ?? FIND_DEFAULT_LIMIT
  const cwd = params.cwd
  // E1：单次根解析（完整信号包——空 liveSessionDir 由 sessionRootSpecs 内部 guard 降级）
  const roots = await resolveSessionRoots(signals)

  // 显式 source：单组，匹配层原语义（mtime 排序 + limit 截断），无分组展示
  if (params.source !== undefined) {
    const { matches, truncated } = await findSessions(query, signals.agentDir, {
      cwd,
      limit,
      source: params.source,
      liveSessionDir: signals.liveSessionDir,
      metadataProvider,
      roots,
    })
    if (matches.length === 0) return findNoMatch(query, roots)
    return {
      content: [
        {
          type: 'text',
          text: formatFindContent(
            query,
            [{ source: params.source, shown: matches, overflow: false }],
            truncated,
          ),
        },
      ],
      details: { matches, truncated },
    }
  }

  // 分组查询：main 段以 limit+1 探测溢出，优先占满配额
  const mainRes = await findSessions(query, signals.agentDir, {
    cwd,
    limit: limit + 1,
    source: 'main',
    liveSessionDir: signals.liveSessionDir,
    metadataProvider,
    roots,
  })
  const mainHasMore = mainRes.matches.length > limit
  const mainShown = mainHasMore ? mainRes.matches.slice(0, limit) : mainRes.matches

  // subagent 段：remaining>0 → 配额 remaining+1 探测溢出；remaining=0（main 占满/溢出）
  // → limit:1 仅探测有无命中（折叠计数判据，不做全量深读）
  const remaining = limit - mainShown.length
  const subLimit = remaining > 0 ? remaining + 1 : 1
  const subRes = await findSessions(query, signals.agentDir, {
    cwd,
    limit: subLimit,
    source: 'subagent',
    liveSessionDir: signals.liveSessionDir,
    metadataProvider,
    roots,
  })
  const subOverflow = remaining > 0 ? subRes.matches.length > remaining : subRes.matches.length > 0
  const subShown = subRes.matches.slice(0, Math.max(remaining, 0))

  const matches = [...mainShown, ...subShown]
  if (matches.length === 0) return findNoMatch(query, roots)
  const truncated = mainHasMore || subOverflow
  return {
    content: [
      {
        type: 'text',
        text: formatFindContent(
          query,
          [
            { source: 'main', shown: mainShown, overflow: mainHasMore },
            { source: 'subagent', shown: subShown, overflow: subOverflow },
          ],
          truncated,
        ),
      },
    ],
    details: { matches, truncated },
  }
}

/**
 * family：fork 父链/子代 + 隔代 subagent + workflow run（design §3.4 family）。
 *
 * recursive=false（默认）→ flat family（buildFamilyFromFs + formatFamilyText，m0/m1/m2 行为零回归）。
 * recursive=true → 嵌套执行树（buildExecutionTree + formatExecutionTreeText，任意深度
 * subagent↔workflow-call 相互嵌套，IF4）。错误契约同构：multi→disambiguate；构建抛错→catch 转 👉。
 */
async function doFamily(
  params: SessionReadParams,
  agentDir: string,
  liveSessionDir?: string,
): Promise<ToolResult> {
  const resolved = await resolveSessionId(
    params.session,
    'family',
    agentDir,
    params.source,
    undefined,
    liveSessionDir,
  )
  if (resolved.kind === 'multi') return disambiguate(resolved.query, resolved.candidates)

  // recursive=true：嵌套执行树（U7/U8）
  if (params.recursive) {
    let tree: ExecutionTree
    try {
      // MF-1：传 resolved.fileName 使 main root 填 sessionFile——main session 自身发起的
      // workflow run（workflow-state-link）进入执行树，与 flat family 行为一致。
      tree = await buildExecutionTree(resolved.sessionId, agentDir, resolved.fileName)
    } catch (e) {
      throw err(
        `构建执行树失败：${resolved.sessionId}（${toErrorMessage(e)}）。👉 检查 session 或用 find 重新定位，或改用 recursive:false 看 flat family 兜底。`,
      )
    }
    return {
      content: [{ type: 'text', text: formatExecutionTreeText(tree) }],
      details: { tree },
    }
  }

  // recursive falsy（默认）：flat family（m0/m1/m2 现状零回归）
  let family: Family
  try {
    family = await buildFamilyFromFs(resolved.sessionId, agentDir)
  } catch (e) {
    throw err(
      `读取家族失败：${resolved.sessionId}（${toErrorMessage(e)}）。👉 检查 session 或用 find 重新定位。`,
    )
  }
  return { content: [{ type: 'text', text: formatFamilyText(family) }], details: family }
}

/** outline：turn 级全貌 TOC（design §3.4 outline，~1500 token；budget 走 render 侧
 * OUTLINE_DEFAULT_BUDGET_TOKENS 默认，handler 不再传测试专用缝参数）。 */
async function doOutline(
  params: SessionReadParams,
  agentDir: string,
  liveSessionDir?: string,
): Promise<ToolResult> {
  const resolved = await resolveSessionId(
    params.session,
    'outline',
    agentDir,
    params.source,
    undefined,
    liveSessionDir,
  )
  if (resolved.kind === 'multi') return disambiguate(resolved.query, resolved.candidates)
  const { entries, totalBytes, skippedLines } = await safeParse(resolved.fileName)
  const tree = buildTreeView(entries)
  const turns = segmentTurns(entries, new Set(tree.leafPath))
  const opts: OutlineOptions = {
    allBranches: params.allBranches,
    granularity: params.granularity,
  }
  const result = renderOutline(turns, tree, opts)
  // 覆盖 stats.totalBytes：render 用 parsedBytes（leaf entry JSON 字节和）近似，
  // 此处用 ParseResult.totalBytes（原始文件字节数，design §3.4 stats.totalBytes 语义）
  result.stats.totalBytes = totalBytes
  // [D8d] skippedLines 同模式覆盖：parser 已检测坏行计数（render 签名不含 ParseResult 恒 0），
  // 有检测必有报告——静默跳过行对调用方不可见 = 数据完整性缺口
  result.stats.skippedLines = skippedLines
  // E7 行渲染统一：行主体 = result.lines（renderOutline 渲染行），handler 只拼 stats 尾段
  return {
    content: [{ type: 'text', text: `${result.lines.join('\n')}\n${formatOutlineTail(result)}` }],
    details: result,
  }
}

/** expand：单 turn 的 entry 列表（design §3.4 expand）。turn 越界抛 F4。 */
async function doExpand(
  params: SessionReadParams,
  agentDir: string,
  liveSessionDir?: string,
): Promise<ToolResult> {
  const resolved = await resolveSessionId(
    params.session,
    'expand',
    agentDir,
    params.source,
    undefined,
    liveSessionDir,
  )
  if (resolved.kind === 'multi') return disambiguate(resolved.query, resolved.candidates)
  const turnIdx = parseTurnIndex(requireStr(params.turn, 'turn', 'expand'))
  const { entries } = await safeParse(resolved.fileName)
  const tree = buildTreeView(entries)
  const turns = segmentTurns(entries, new Set(tree.leafPath))
  const turn = turns.find((t) => t.index === turnIdx)
  if (turn === undefined) {
    const max = turns.length - 1
    throw err(
      `turn T${pad(turnIdx)} 越界，该 session 共 ${turns.length} 轮（T000-T${pad(Math.max(0, max))}）。👉 用 outline 重看有效范围。`,
    )
  }
  const result = renderExpand(turn)
  return {
    content: [{ type: 'text', text: formatExpandText(result.turn, result.entries) }],
    details: result,
  }
}

/** detail：turns 范围的完整文本（design §3.4 detail）。默认省略 toolResult/thinking。 */
async function doDetail(
  params: SessionReadParams,
  agentDir: string,
  liveSessionDir?: string,
): Promise<ToolResult> {
  const resolved = await resolveSessionId(
    params.session,
    'detail',
    agentDir,
    params.source,
    undefined,
    liveSessionDir,
  )
  if (resolved.kind === 'multi') return disambiguate(resolved.query, resolved.candidates)
  const range = parseTurnsRange(requireStr(params.turns, 'turns', 'detail'))
  const { entries } = await safeParse(resolved.fileName)
  const tree = buildTreeView(entries)
  const turns = segmentTurns(entries, new Set(tree.leafPath))
  const max = turns.length - 1
  if (turns.length === 0 || range.start > max || range.end > max) {
    throw err(
      `turns "${rangeLabel(range)}" 越界，该 session 共 ${turns.length} 轮（T000-T${pad(Math.max(0, max))}）。👉 用 outline 重看有效范围。`,
    )
  }
  const inRange = turns.filter((t) => t.index >= range.start && t.index <= range.end)
  const det = renderDetail(inRange, {
    includeToolResult: params.includeToolResult,
    includeThinking: params.includeThinking,
  })
  return {
    content: [{ type: 'text', text: formatDetailText(range, det) }],
    details: { turns: rangeLabel(range), entries: det },
  }
}

/** search：全文检索（design §3.4 search，M3 新实现）。
 *
 * u12 两种形态（design 2026-09-10 §2 目标 5 / §8.2 V8）：
 * - session 含逗号 → 跨会话模式（searchAcrossSessions）：候选集 = find 输出的完整 id
 *   列表，窄化前置 + 字节上限 + 分 session 渲染；
 * - 否则单会话模式（现状零变化）：session 经 resolveSessionId 解析后对单个 session 检索。
 */
async function doSearch(
  params: SessionReadParams,
  signals: SessionReadSignals,
  signal?: AbortSignal,
  metadataProvider?: SessionMetadataProvider,
): Promise<ToolResult> {
  const pattern = requireStr(params.pattern, 'pattern', 'search')
  const rawSession = params.session
  if (rawSession !== undefined && rawSession.includes(',')) {
    const ids = rawSession
      .split(',')
      .map((s) => stripHash(s.trim()))
      .filter((s) => s.length > 0)
    return searchAcrossSessions(ids, pattern, signals, {
      scope: params.scope,
      limit: params.limit,
      signal,
      metadataProvider,
    })
  }
  const agentDir = signals.agentDir
  const resolved = await resolveSessionId(
    rawSession,
    'search',
    agentDir,
    params.source,
    undefined,
    signals.liveSessionDir,
  )
  if (resolved.kind === 'multi') return disambiguate(resolved.query, resolved.candidates)
  const scope = params.scope ?? 'all'
  const limit = params.limit ?? SEARCH_DEFAULT_LIMIT
  const { entries } = await safeParse(resolved.fileName)
  const tree = buildTreeView(entries)
  const turns = segmentTurns(entries, new Set(tree.leafPath))
  const regex = compilePattern(pattern)
  // S-3：启发式降级时在 header 标注，避免 LLM 把 0 hit(s) 误读为「无匹配」（静默错数据）
  const degraded = isCatastrophicPattern(pattern)
  const hits = collectSearchHits(turns, regex, scope, signal)
  const truncated = hits.length > limit
  const sliced = truncated ? hits.slice(0, limit) : hits
  const text = formatSearchText(pattern, degraded, scope, sliced, truncated)
  return { content: [{ type: 'text', text }], details: { hits: sliced, truncated } }
}

/** export full 模式的 entry 分隔线（'=' 重复）宽度。 */
const EXPORT_SEPARATOR_LEN = 40

/** export：物化摘要到 <agentDir>/tmp/session-view-<id>.md（design §3.4 export，D-8）。 */
async function doExport(
  params: SessionReadParams,
  agentDir: string,
  liveSessionDir?: string,
): Promise<ToolResult> {
  const format = params.format ?? 'outline'
  const resolved = await resolveSessionId(
    params.session,
    'export',
    agentDir,
    params.source,
    undefined,
    liveSessionDir,
  )
  if (resolved.kind === 'multi') return disambiguate(resolved.query, resolved.candidates)

  let text: string
  let label: string
  if (format === 'family') {
    let family: Family
    try {
      family = await buildFamilyFromFs(resolved.sessionId, agentDir)
    } catch (e) {
      throw err(
        `读取家族失败：${resolved.sessionId}（${toErrorMessage(e)}）。👉 检查 session 或用 find 重新定位。`,
      )
    }
    text = formatFamilyText(family)
    label = 'family'
  } else if (format === 'full') {
    const { entries } = await safeParse(resolved.fileName)
    const tree = buildTreeView(entries)
    const turns = segmentTurns(entries, new Set(tree.leafPath))
    const det = renderDetail(turns, {
      includeToolResult: params.includeToolResult,
      includeThinking: false,
    })
    text = det
      .map((e) => {
        if (isToolResultSummary(e)) {
          return `${'='.repeat(EXPORT_SEPARATOR_LEN)}\ntoolResultSummary (${e.id.slice(0, SESSION_ID_PREFIX_LEN)})\n${entryReadableText(e)}`
        }
        return `${'='.repeat(EXPORT_SEPARATOR_LEN)}\n${e.type}${e.message ? '/' + e.message.role : ''} (${e.id.slice(0, SESSION_ID_PREFIX_LEN)})\n${entryReadableText(e)}`
      })
      .join('\n')
    label = 'full'
  } else {
    const { entries } = await safeParse(resolved.fileName)
    const tree = buildTreeView(entries)
    const turns = segmentTurns(entries, new Set(tree.leafPath))
    const result = renderOutline(turns, tree, {
      allBranches: params.allBranches,
      granularity: params.granularity,
    })
    // E7 行渲染统一：与 doOutline 同一拼装（lines + 尾段），两 action 输出一致
    text = `${result.lines.join('\n')}\n${formatOutlineTail(result)}`
    label = 'outline'
  }

  const outDir = join(agentDir, 'tmp')
  const outPath = join(outDir, `session-view-${resolved.sessionId}.md`)
  await mkdir(outDir, { recursive: true })
  await writeFile(outPath, text, 'utf8')
  const sizeBytes = Buffer.byteLength(text, 'utf8')
  return {
    content: [
      {
        type: 'text',
        text: `已导出 ${label} 视图到 ${outPath}（${sizeBytes} bytes）。可用 read/grep 进一步检索。`,
      },
    ],
    details: { path: outPath, sizeBytes },
  }
}

// ===========================================================================
// extract action（v2 O4：跨 turn 按类型提取素材）
// ===========================================================================
//
// design §3.3 D3 的 5 个预设 + F7/F8/F9 错误规格。预设管线与预算渲染在 extract.ts
//（max-lines 拆分轮机械提取）；本段保留 F7 what 校验与 doExtract 编排（定位依赖
// tool-handler 私有的 resolveSessionId/safeParse/segmentTurns）。纯提取，不调 LLM。

/** what 类型守卫（直接比较，避开不安全断言；schema 已校验，此处防御 + 可单测绕过）。 */
function isExtractWhat(v: unknown): v is ExtractWhat {
  return (
    v === 'user-messages' ||
    v === 'commands' ||
    v === 'files' ||
    v === 'commits' ||
    v === 'tool-results'
  )
}

/**
 * extract：跨 turn 按类型提取素材（design §3.3 D3 五预设 + F7/F8/F9）。
 *
 * 流程：resolveSessionId（multi 走 disambiguate）→ safeParse → buildTreeView +
 * segmentTurns → 可选 turns 范围限定（复用 parseTurnsRange）→ F7 校验 what → 分发 5 预设。
 */
async function doExtract(
  params: SessionReadParams,
  agentDir: string,
  liveSessionDir?: string,
): Promise<ToolResult> {
  const resolved = await resolveSessionId(
    params.session,
    'extract',
    agentDir,
    params.source,
    undefined,
    liveSessionDir,
  )
  if (resolved.kind === 'multi') return disambiguate(resolved.query, resolved.candidates)
  const { entries } = await safeParse(resolved.fileName)
  // extract 遍历全量 entry（含旁支/压缩历史），与 outline/expand/detail 的 leaf 视图不同：
  // 素材提取要全量（design §2.3 实测全量 519 toolCall / 26 user / 515 toolResult），
  // 用 leafPath 过滤会漏掉旁支素材。turn 标注是全量分段 index（含 compaction 周期 + 旁支
  // turn），与 outline 的 32 leaf turn index 不一定逐一对齐，但素材内容完整。
  const allTurns = segmentTurns(entries, new Set(entries.map((e) => e.id)))

  // 可选 turns 范围限定（复用 parseTurnsRange；未传则全 session）
  let turns = allTurns
  if (params.turns !== undefined) {
    const range = parseTurnsRange(params.turns)
    const max = allTurns.length - 1
    if (allTurns.length === 0 || range.start > max || range.end > max) {
      throw err(
        `turns "${rangeLabel(range)}" 越界，extract 的 turn 范围与 outline 不同（extract 含 compaction 周期/旁支，turn 数更多）。该 session extract 共 ${allTurns.length} 轮（T000-T${pad(Math.max(0, max))}）。👉 用较小 turns 范围（如 T000-T005）试探，或先不带 turns extract 看全量 turn 标注。`,
      )
    }
    turns = allTurns.filter((t) => t.index >= range.start && t.index <= range.end)
  }

  // F7：what 校验（schema 已校验，此处防御 + 可单测绕过 schema）
  const what = params.what
  if (!isExtractWhat(what)) {
    const given = what === undefined ? '(missing)' : String(what)
    throw err(
      `what "${given}" 无效，应为 user-messages/commands/files/commits/tool-results。👉 用合法 what 重试。`,
    )
  }

  switch (what) {
    case 'user-messages':
      return extractUserMessages(turns)
    case 'commands':
      return extractCommands(turns, params.tool)
    case 'files':
      return extractFiles(turns)
    case 'commits':
      return extractCommits(turns)
    case 'tool-results':
      return extractToolResults(turns, params.tool)
    default: {
      // exhaustive guard：5 预设全覆盖，default 不可达；防御未来新增 what 未加 case
      const exhaustive: never = what
      throw err(`unreachable extract what: ${JSON.stringify(exhaustive)}`)
    }
  }
}

// ===========================================================================
// workflow action（w6：消费 w5 的 readRunSnapshot/parseRunSnapshot/renderWorkflowOverview）
// ===========================================================================

/** doWorkflow 的 details 结构（ES-wf-no-runs/runid-not-found/snapshot-* 错误契约的具体类型）。 */
interface WorkflowDetails {
  runs: WorkflowOverview[]
  runIds: string[]
  skippedRuns?: Array<{ runId: string; stateFile: string; reason: string }>
  requestedRunId?: string
  sessionId?: string
}

/** 单个被跳过的 run 记录（snapshot 不可读/不可解析）。 */
interface SkippedRun {
  runId: string
  stateFile: string
  reason: string
}

/**
 * workflow：workflow run 概览（design §3.4 workflow，m2 IF-doWorkflow）。
 *
 * 流程：① resolveSessionId（multi 走 disambiguate）→ ② 读目标 session 的 workflow-state-link
 * → ③ 无 run → ES-wf-no-runs（提示+👉family，不抛错）→ ④ runId 过滤，无匹配 →
 * ES-wf-runid-not-found（列候选+👉，不抛错）→ ⑤ 逐 run readRunSnapshot+parseRunSnapshot，
 * 不可读/不可解析 → skippedRuns（不中断其他 run，ES-wf-snapshot-read-fail/unparseable）
 * → ⑥ renderWorkflowOverview 拼接。
 *
 * ② 的读取（MF-2）：不用 buildFamilyFromFs（其 resolveFamily 只索引 main session，subagent
 * session 会抛「session not found in family index」）——resolveSessionId 已把 session 解析到
 * 真实文件（kind==='ok' 保证文件存在，三形态：绝对路径/sa-id 均 existsSync 校验，片段匹配
 * 来自实际 fs 扫描），直接用 resolved.fileName 构造单条目 sessionIdToPath 调 resolveWorkflows
 *（与 buildFamilyFromFs 步骤 6 的 workflow 腿同源）。pathToRef 传空 Map（单条目链路无其他
 * 文件可反查），call 引用 100% 走 sessionRefFromPath 文件名最小回退（sessionId+fileName，
 * 足够 LLM 跳 outline/detail 深读）。
 *
 * 错误契约（C2）：workflow 概览探索语义，三类错误均返回 ToolResult 不抛错。
 * step 的 call sessionId/sessionFile 是 LLM 跳 outline/detail 的入口（m0 resolveSessionId
 * 三形态复用：sessionId/绝对路径/sa-id 均可深读，TC-wf-step-sessionfile-link）。
 */
async function doWorkflow(
  params: SessionReadParams,
  agentDir: string,
  liveSessionDir?: string,
): Promise<ToolResult> {
  const resolved = await resolveSessionId(
    params.session,
    'workflow',
    agentDir,
    params.source,
    undefined,
    liveSessionDir,
  )
  if (resolved.kind === 'multi') return disambiguate(resolved.query, resolved.candidates)

  let workflows: WorkflowRef[]
  try {
    // MF-2：直读 resolved.fileName（subagent session 亦可），绕过 buildFamilyFromFs 的
    // main-only byId 索引（对 subagent 抛「session not found in family index」）。
    // resolveWorkflows 自身容错（读失败返回 []），「session 真不存在」的 F 级契约已由
    // resolveSessionId 保证（kind==='ok' 前已 existsSync/扫描校验）。
    const sessionIdToPath = new Map<string, string>([[resolved.sessionId, resolved.fileName]])
    const pathToRef = new Map<string, SessionRef>()
    workflows = await resolveWorkflows(resolved.sessionId, sessionIdToPath, pathToRef)
  } catch (e) {
    throw err(
      `读取 workflow run 失败：${resolved.sessionId}（${toErrorMessage(e)}）。👉 检查 session 或用 find 重新定位。`,
    )
  }
  const allRunIds = workflows.map((w) => w.runId)

  // ③ ES-wf-no-runs：session 未发起任何 workflow run（不抛错，返提示+👉family）
  if (workflows.length === 0) {
    const text =
      `session ${resolved.sessionId} 无 workflow run。\n` +
      `👉 用 session_read { action:'family' } 查该 session 的 subagent 后代，或确认 session 是否发起过 workflow。`
    const details: WorkflowDetails = { runs: [], runIds: [], sessionId: resolved.sessionId }
    return { content: [{ type: 'text', text }], details }
  }

  // ④ runId 过滤（可选，多 run 消歧）
  const requestedRunId =
    params.runId !== undefined && params.runId.trim() !== '' ? params.runId.trim() : undefined
  let selected: WorkflowRef[] = workflows
  if (requestedRunId !== undefined) {
    selected = workflows.filter((w) => w.runId === requestedRunId)
    if (selected.length === 0) {
      // ES-wf-runid-not-found：列出可用 runId + 👉（不抛错，与 F2 多匹配消歧同构）
      const lines = allRunIds.map((rid) => `  ${rid}`).join('\n')
      const text =
        `runId "${requestedRunId}" 无匹配。可用 runId：\n${lines}\n` +
        `👉 用上述完整 runId 重试，或不传 runId 看全部 run 概览。`
      const details: WorkflowDetails = { runs: [], runIds: allRunIds, requestedRunId }
      return { content: [{ type: 'text', text }], details }
    }
  }

  // ⑤⑥ 逐 run 读 snapshot → parse → render
  const runs: WorkflowOverview[] = []
  const runIds: string[] = []
  const skippedRuns: SkippedRun[] = []
  const contentParts: string[] = []

  for (const wf of selected) {
    const snap = await readRunSnapshot(wf.stateFile)
    if (snap === undefined) {
      // ES-wf-snapshot-read-fail：文件不存在/读失败/全行不可解析 → 跳过，不中断其他 run
      skippedRuns.push({ runId: wf.runId, stateFile: wf.stateFile, reason: 'snapshot-unreadable' })
      contentParts.push(`run ${wf.runId}: 快照不可读（stateFile=${wf.stateFile}）已跳过`)
      continue
    }
    const overview = parseRunSnapshot(snap, wf.runId, wf.stateFile)
    if (overview === null) {
      // ES-wf-snapshot-unparseable：对象既非 NEW 也非 OLD → 跳过
      skippedRuns.push({ runId: wf.runId, stateFile: wf.stateFile, reason: 'snapshot-unparseable' })
      contentParts.push(`run ${wf.runId}: 快照格式不可识别（stateFile=${wf.stateFile}）已跳过`)
      continue
    }
    runs.push(overview)
    runIds.push(wf.runId)
    contentParts.push(renderWorkflowOverview(overview))
  }

  const details: WorkflowDetails = { runs, runIds }
  if (requestedRunId !== undefined) details.requestedRunId = requestedRunId
  if (skippedRuns.length > 0) details.skippedRuns = skippedRuns

  // 全部 run 都跳过的兜底提示（ES-wf-snapshot-read-fail 末段）
  let text: string
  if (runs.length === 0) {
    text =
      contentParts.join('\n') +
      `\n👉 检查 stateFile 或用 session_read { action:'family' } 看 call session 直接深读。`
  } else {
    text = contentParts.join('\n\n')
  }

  return { content: [{ type: 'text', text }], details }
}

// ---------------------------------------------------------------------------
// u11 标题元数据 TTL 缓存（design 2026-09-10 §6.6 调用策略 ③）
// ---------------------------------------------------------------------------

/**
 * 标题缓存条目（SessionMetadataEntry[] keyed by 目录字面路径）。进程内唯一实例，
 * 仅缓存标题元数据（session_info name / firstMessage，低频变更）——根扫描统计
 * 不再有缓存（doctor 缓存机已删除，ext-simplify-04 U3），与根扫描无共享状态。
 */
interface MetadataCacheEntry {
  entries: SessionMetadataEntry[]
  /** 写入时刻（Date.now()），TTL 判定用 */
  cachedAt: number
  /** 目录 mtime(ms)；不存在为 null（存在性翻转即失效） */
  dirMtimeMs: number | null
}

const metadataCache = new Map<string, MetadataCacheEntry>()
// §7.5 豁免（development-guide.md「纯性能缓存豁免」）：TTL 纯性能缓存，jiti 双路径加载
// 分裂成两份仅多一次 miss 重扫，无正确性影响，不升级 globalThis 单例。

/**
 * 标题缓存 TTL（秒级，§6.6 策略 ③）。独立定义 5000（原「与 doctor 根扫描缓存同档
 * （DOCTOR_CACHE_TTL_MS）」的别名已随 doctor 缓存机删除而撤销，ext-simplify-04 U3）；
 * 量级待 §11.3a 实测校准；mtime 是主失效通道，TTL 兜「目录内文件追加不改目录 mtime」
 * 的陈旧面（标题恰好随首条消息落盘，同窗口内新增标题最多延迟一个 TTL 可见，可接受）。
 */
export const METADATA_CACHE_TTL_MS = 5000

/** stat 目录 mtime；不存在返回 null（与缓存条目的 null 比对 = 存在性未翻转）。 */
async function statDirMtimeOrNull(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs
  } catch (err) {
    // 目录不存在是常态输入（候选根降级形态），非异常——void 同 roots.ts 容错
    void err
    return null
  }
}

/**
 * 把注入的 metadataProvider 包上 TTL 缓存（get 失效判定 + set 快照）。
 *
 * 只缓存成功结果——provider 抛错原样上抛，由发现层单目录 try/catch 记空继续（guard），
 * 且瞬态失败不污染缓存（下个查询即重试）。find 的多次 findSessions 调用（u10 分组探测
 * main/subagent 两路）与连续 keyword 查询都经此处去重，listAll 每 TTL 窗口至多一次/目录。
 */
function withMetadataCache(provider: SessionMetadataProvider): SessionMetadataProvider {
  return async (dir) => {
    const hit = metadataCache.get(dir)
    if (hit !== undefined) {
      const expired = Date.now() - hit.cachedAt >= METADATA_CACHE_TTL_MS
      const mtime = await statDirMtimeOrNull(dir)
      if (!expired && mtime === hit.dirMtimeMs) return hit.entries
      metadataCache.delete(dir)
    }
    const entries = await provider(dir)
    metadataCache.set(dir, {
      entries,
      cachedAt: Date.now(),
      dirMtimeMs: await statDirMtimeOrNull(dir),
    })
    return entries
  }
}

// ===========================================================================
// 入口：按 action 分发
// ===========================================================================

/**
 * session_read 工具的纯逻辑 handler（信号包注入，零 pi 依赖，可单测）。
 *
 * 按 params.action 分发到 do* 家族（11 个 action，与本文件各 action 实现一一对应）。
 * F1(resolve)/F4/F5/F6 抛 Error（含 👉）；F2 多匹配与 find 零匹配返回结果不抛。
 *
 * @param signals 发现层信号包（design §7B：index.ts 采集 { agentDir, liveSessionDir? }，
 *   采集端全可选链可降级）。u9 起 find/F1 路径消费根列表（F1 自检行计数恒取本次
 *   实扫，无任何根扫描缓存，§7B 要点 8）。
 * @param signal 可选 AbortSignal（MF-5）：仅 search 消费（长扫描可中断）；其余 action 有界，不接。
 * @param metadataProvider 可选标题元数据注入（u11，design 2026-09-10 §6.6）：index.ts 构造
 *   `(dir) => SessionManager.listAll(dir)`，此处包 TTL 缓存后透传 find。缺省 = undefined =
 *   现状行为（标题检索不可用，首条 user 匹配不受影响）；provider 抛错由发现层单目录
 *   try/catch 降级，不外抛。
 */
export async function handleSessionRead(
  params: SessionReadParams,
  signals: SessionReadSignals,
  signal?: AbortSignal,
  metadataProvider?: SessionMetadataProvider,
): Promise<ToolResult> {
  const agentDir = signals.agentDir
  // u11：TTL 缓存包装在注入边界（策略 ③，metadata 缓存独立实例）；仅 find/search 消费。
  const cachedProvider =
    metadataProvider === undefined ? undefined : withMetadataCache(metadataProvider)
  switch (params.action) {
    case 'find':
      return doFind(params, signals, cachedProvider)
    case 'family':
      return doFamily(params, agentDir, signals.liveSessionDir)
    case 'outline':
      return doOutline(params, agentDir, signals.liveSessionDir)
    case 'expand':
      return doExpand(params, agentDir, signals.liveSessionDir)
    case 'detail':
      return doDetail(params, agentDir, signals.liveSessionDir)
    case 'search':
      return doSearch(params, signals, signal, cachedProvider)
    case 'export':
      return doExport(params, agentDir, signals.liveSessionDir)
    case 'extract':
      return doExtract(params, agentDir, signals.liveSessionDir)
    case 'workflow':
      return doWorkflow(params, agentDir, signals.liveSessionDir)
    case 'result':
      // per-call 构造注入面（仅剩 tool-handler 文件私有 helper，纯函数经 handler-utils
      // 直接 import——ext-simplify-04 E5）：resolveSessionId 包装把信号包中的
      // liveSessionDir 闭包进解析调用（ResultActionDeps 接口签名固定 5 参，包装保持
      // 同形、末位补传），result 的片段形态与 find/outline 消费同一 roots
      //（sa-/绝对路径分支在 resolveSessionId 内不受影响）。
      return doResult(params, agentDir, {
        resolveSessionId: (rawSession, action, ad, source, prefetchedManifests) =>
          resolveSessionId(rawSession, action, ad, source, prefetchedManifests, signals.liveSessionDir),
        disambiguate,
        safeParse,
      })
    case 'doctor':
      return doDoctor(params, signals)
    default: {
      // exhaustive guard：switch 覆盖全部 11 action，此处 params.action 收窄为 never；
      // 仅防御运行时非法 action（schema 正常校验下不可达）
      const exhaustive: never = params.action
      throw err(
        `未知 action "${JSON.stringify(exhaustive)}"。👉 合法 action: find/family/outline/expand/detail/search/export/extract/workflow/result/doctor。`,
      )
    }
  }
}
