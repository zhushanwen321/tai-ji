/**
 * [M3 工具适配层] session_read 工具的纯逻辑 handler（design §3.4 接口规格）。
 *
 * 分层约定（同 scheduler/cw-tool）：本文件零 pi 依赖——agentDir 作参数注入，
 * 不调用 getAgentDir()，可完全单测；pi 注册与 getAgentDir() 调用在 index.ts。
 *
 * 按 action 分发到 11 条路径，串联基座解析（session-core parse）+ M1 core（tree/turns/render）+ M2 discovery
 *（find/subagents）+ doctor 的环境判定与根表渲染（u8，discovery/env）。content 给 LLM
 * 读（人类可读摘要），details 供程序化消费/测试断言。
 *
 * 域模块拆分（max-lines 拆分轮机械提取，零行为变更，result-action.ts 先例同型）：
 *   result-action.ts（result）/ doctor.ts（doctor + SessionReadSignals）/
 *   search-across.ts（search 管线 + u12 跨会话）/ extract.ts（extract 预设）/
 *   tool-format.ts（各 action 输出文本渲染 + 错误面 message + F2 消歧与
 *   find 零匹配包装）/ no-match.ts（F1 自检行）/ zcode-anchor-classify.ts（entry
 *   兜底归因的 entry 级纯判定）/ handler-utils.ts（pad/err/
 *   stripHash/requireStr/SESSION_ID_PREFIX_LEN/turn 索引解析低层小工具）。
 * 本模块保留公共类型、定位解析（resolveSessionId）、zcode 读链与各 action 编排；
 * 域模块符号不经此 re-export——从所属域模块直接 import（唯一例外 SessionReadSignals：
 * 本模块 re-export 供 index.ts 生产消费）。
 *
 * 错误规格 F1-F6：handler 抛 Error（message 含 👉 恢复指引），index.ts 的 execute 闭包
 * 原样传播给 pi——pi-agent-core 只对 execute throw 置 isError:true（返回值里的 isError
 * 字段被丢弃，agent-loop.js:453-483）。handler 可抛（纯逻辑可测）。
 * 例外：F2 多匹配与 F1 find 零匹配「不视为错误」，返回消歧/提示结果而非抛错。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { toErrorMessage } from '@zhushanwen/pi-ext-guards'
import { getLogger } from '@zhushanwen/pi-extension-logger'
import { convertZcodeTranscript, openZcodeSessionDb } from '@zhushanwen/zcode-session-source'
import {
  findSessions,
  type MatchedSession,
  type SessionMetadataEntry,
  type SessionMetadataProvider,
} from './discovery/find.js'
import { resolveSessionRoots } from './discovery/roots.js'
import { readSessionHeaderIdSync } from './discovery/session-header.js'
import { findZcodeEntryAnchor, type ZcodeAnchor } from './discovery/entry-anchor.js'
import {
  listZcodeManifests,
  readZcodeManifest,
  type ZcodeAnchorMissingReason,
} from './discovery/zcode-manifest.js'
import { assertZcodeDbPathAllowed } from './discovery/whitelist.js'
import {
  buildFamilyFromFs,
  listRecordManifests,
  type RecordManifest,
} from './discovery/subagents.js'
import { readRunSnapshot, resolveWorkflows } from './discovery/workflows.js'
import {
  parseSessionContent,
  parseSessionFile,
  type ParseResult,
} from '@zhushanwen/session-core'
import { parseRunSnapshot, renderWorkflowOverview, type WorkflowOverview } from './core/workflow.js'
import { buildTreeView } from './core/tree.js'
import { segmentTurns } from './core/turns.js'
import { renderOutline, renderExpand, renderDetail, type OutlineOptions } from './core/render.js'
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
// 同轮拆分的渲染域模块（format* 纯函数簇，含 zcode 错误面 message 与
// zcodeReadErrorMessage 错误映射）：运行时依赖方向本模块 → tool-format，
// tool-format 对本模块仅 type import（ToolResult），无循环。
import {
  disambiguate,
  entryReadableText,
  findNoMatch,
  formatDetailText,
  formatExpandText,
  formatFamilyText,
  formatFindContent,
  formatOutlineTail,
  formatSaIdAmbiguous,
  formatSaIdNotFound,
  formatSessionGc,
  formatZcodeAnchorMissing,
  formatZcodeParamInvalid,
  formatZcodeRecordNotFound,
  formatZcodeSessionNotFound,
  isToolResultSummary,
  zcodeReadErrorMessage,
} from './tool-format.js'
import { doDoctor, type SessionReadSignals } from './doctor.js'
// entry 兜底归因的 entry 级判定（同目录域模块，零 I/O 纯函数，复杂度偿还提取）。
import { firstIncompleteAnchorReason } from './zcode-anchor-classify.js'

// SessionReadSignals re-export 是生产链（index.ts 工具注册消费），非测试兼容转发。
export type { SessionReadSignals }

// zcode 读链的结构化日志（「事后排查」通道：degradations 留痕 / L2-L3 恢复成功 /
// anchor-missing 归因——§3.4 可观测性 + P2 降级隔离契约 F13，均不进 LLM 可见面）。
// pi handle 由 index.ts 初始化时 setPiHandle 注入（appendEntry 通道）；未注入时
// warn/error 降级文件日志，双开关缺省 no-op（纯 pi 独立用户零行为影响）。
const logger = getLogger('session-reader')

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
// resolveSessionId：片段 → 完整 id（design §3.4 resolveSessionId 辅助）
// ---------------------------------------------------------------------------

export type ResolveResult =
  | {
      kind: 'ok'
      sessionId: string
      /**
       * 内容源路径。pi = session .jsonl 绝对路径；zcode 路由命中 = 会话库 .sqlite
       * 绝对路径（loadParsed 按 zcodeAnchor 分流，safeParse 不会以此路径开 JSONL）。
       */
      fileName: string
      /**
       * zcode 锚（U9 路由命中时在场）：内容加载走 zcode 读链（白名单闸 →
       * openZcodeSessionDb → convertZcodeTranscript），pi 路径恒 undefined——
       * 可选字段不改变既有消费方的 pi 行为（toEqual 语义下 undefined 键不可见）。
       */
      zcodeAnchor?: ZcodeAnchor
    }
  | { kind: 'multi'; query: string; candidates: MatchedSession[] }

// readSessionHeaderIdSync（同步读首行 header 取 id，resolveSessionId 形态①/②消费）
// 在 discovery/session-header.ts（基座 readFirstJsonlLineSync 的谓词/降级薄包装，G2 单源）。

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

  // ② sa-id 前缀 → zcode 路由（§3.5 定位链，U9）前置，pi 现路径零改动地在其中承接
  if (session.startsWith('sa-')) {
    return resolveSaIdRoute(session, agentDir, prefetchedManifests, action, liveSessionDir)
  }

  // §3.4 第 0 段：sess_ 形态 id 无第一梯队直读入口（agent 从不持有 sess id，F14；
  // 且无 zcode 候选发现，D6）→ zcode_param_invalid。pi 的 session id 是 uuid（无
  // sess_ 前缀），此检测只改变错误输入的错误面文案。
  if (session.startsWith('sess_')) {
    throw err(formatZcodeParamInvalid(session))
  }

  // ③ 其余：findSessions 透传 source/liveSessionDir 沿用 F1/F2
  return resolveByFragment(session, agentDir, source, liveSessionDir)
}

/**
 * sa- 形态的路由前置（U9，design §3.5 三层定位链；**不加任何工具参数**，D4——
 * 判别源 = manifest 自带 engine 字段）：
 *
 * ① zcode manifest 直读（`readZcodeManifest`，文件名由 sa-id 确定性推出，窄 walk
 *   命中即止）：`{kind:'zcode'}` → zcode 读链；`{kind:'anchor-missing'}` →
 *   `zcode_anchor_missing`。
 * ② `{kind:'not-zcode'}` → **pi 现路径零改动承接**：pi manifest 有命中即走既有
 *   `resolveByRecordId`（engine 缺省/'pi' 形态，行为与今天逐字节一致）。
 * ③ pi 无命中（今天此处直接 ES2）→ entry 兜底（§3.5 第②层，仅 liveSessionDir 内，
 *   越界显式失败）：命中 → zcode 读链；未命中 → `zcode_record_not_found` + 👉
 *  （§3.4：sa-id 语境的统一错误面——F14 agent 唯一持有的 id 就是 sa-id，指引动作
 *   覆盖除 find 指针外的全部恢复路径（find 按 §3.4 刻意不保留）。
 */
async function resolveSaIdRoute(
  session: string,
  agentDir: string,
  prefetchedManifests: RecordManifest[] | undefined,
  action: SessionReadAction,
  liveSessionDir: string | undefined,
): Promise<ResolveResult> {
  const zm = await readZcodeManifest(agentDir, session)
  if (zm.kind === 'anchor-missing') {
    // 归因进结构化日志不进 LLM 可见面（§3.4）：reason 逐键归因（missing-engineHandle /
    // missing-sessionRef / missing-sessionId / missing-dbPath，见 zcode-manifest.ts）
    logger.warn('zcode manifest anchor-missing', { saId: session, reason: zm.reason })
    throw err(formatZcodeAnchorMissing(session))
  }
  if (zm.kind === 'zcode') {
    return resolveZcodeRoute(session, zm.anchor, agentDir, action)
  }
  // not-zcode：pi manifest 命中 → 现路径（同一 manifests 传入，不二次扫描）
  const manifests = prefetchedManifests ?? (await listRecordManifests(agentDir))
  if (manifests.some((m) => m.id === session)) {
    return resolveByRecordId(session, agentDir, manifests)
  }
  // entry 兜底（§3.5 第②层）：候选 = liveSessionDir 内主 session 文件（第一梯队
  // 只在 liveSessionDir 内做，根内全扫不做——越界显式失败）
  const candidates = await liveSessionCandidateFiles(agentDir, liveSessionDir)
  const anchor = findZcodeEntryAnchor(candidates, session)
  if (anchor === undefined) {
    // 兜底失败的两类归因（§3.4 第 0 段，场景 5 ②）：候选里有该 sa-id 的 record entry
    // 但锚不完整 → zcode_anchor_missing（缺失键名进结构化日志——engineHandle 整体
    // 缺席/缺 sessionId/缺 dbPath 归因不同）；完全无该 sa-id → zcode_record_not_found。
    // findZcodeEntryAnchor 契约是「锚或 not-found」不分归因，分类只在罕见失败路径补
    // 一次形态判定。
    const incomplete = await classifyIncompleteEntryAnchor(candidates, session)
    if (incomplete !== undefined) {
      logger.warn('zcode entry anchor incomplete', { saId: session, reason: incomplete })
      throw err(formatZcodeAnchorMissing(session))
    }
    throw err(formatZcodeRecordNotFound())
  }
  return resolveZcodeRoute(session, anchor, agentDir, action)
}

/**
 * 候选文件里该 sa-id 的 `subagent-record` entry 若「在场但锚不完整」，返回缺失归因
 *（§3.4 zcode_anchor_missing 的 entry 形态触发 + 日志归因；记录完全不在场返回
 * undefined）。entry 级判定（五关过滤 + D5 engine 判别 + 锚完整性链）在
 * zcode-anchor-classify.ts 的 firstIncompleteAnchorReason，本函数只做文件扫描 I/O
 *（读失败跳过该文件，首个命中归因即终止扫描）。
 */
async function classifyIncompleteEntryAnchor(
  candidateFiles: readonly string[],
  saId: string,
): Promise<ZcodeAnchorMissingReason | undefined> {
  for (const file of candidateFiles) {
    let content: string
    try {
      content = await readFile(file, 'utf8')
    } catch {
      continue
    }
    const reason = firstIncompleteAnchorReason(parseSessionContent(content).entries, saId)
    if (reason !== undefined) return reason
  }
  return undefined
}

/** liveSessionDir 内的主 session 文件（entry 兜底候选；无 live 信号 → 空集=越界失败）。 */
async function liveSessionCandidateFiles(
  agentDir: string,
  liveSessionDir: string | undefined,
): Promise<string[]> {
  if (liveSessionDir === undefined || liveSessionDir === '') return []
  const roots = await resolveSessionRoots({ agentDir, liveSessionDir })
  return roots.filter((r) => r.kind === 'live').flatMap((r) => r.files.map((f) => f.path))
}

/**
 * zcode 锚 → ResolveResult（路由命中后的 action 分叉）：
 * - family：以**发起 session（rootSessionId）**为家族视图入口——zcode 会话无 JSONL
 *   文件，buildFamilyFromFs 的 byId 索引查不到锚 sessionId；zcode 节点按 rootSessionId
 *   挂载（D5-1），rootSessionId 视图即「该 subagent 的后代与关联」（§3.4 指引语义）。
 *   rootSessionId 取自 `listZcodeManifests` 枚举（readZcodeManifest 直读信号只携带锚，
 *   不携带 rootSessionId——family 是低频 action，枚举一次可接受）。
 * - 其余 action：sessionId = 锚会话 id、fileName = 锚库路径（内容源），zcodeAnchor
 *   在场使 loadParsed 分流到 zcode 读链。
 */
async function resolveZcodeRoute(
  saId: string,
  anchor: ZcodeAnchor,
  agentDir: string,
  action: SessionReadAction,
): Promise<ResolveResult> {
  if (action === 'family') {
    const zcodeNodes = await listZcodeManifests(agentDir)
    const rootSessionId = zcodeNodes.find((n) => n.id === saId)?.rootSessionId
    // 枚举未含该 id（直读命中与枚举之间 manifest 被迁移的极端窗口）→ 退回锚 sessionId，
    // 后续 byId 查不到走既有 not-found 错误面（不静默伪造家族）
    return { kind: 'ok', sessionId: rootSessionId ?? anchor.sessionId, fileName: '' }
  }
  return { kind: 'ok', sessionId: anchor.sessionId, fileName: anchor.dbPath, zcodeAnchor: anchor }
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

// ---------------------------------------------------------------------------
// zcode 读链（U9，design §3.5：白名单闸在开库前——dbPath 来自 session 数据不可信）
// ---------------------------------------------------------------------------

/**
 * zcode 锚 → ParseResult（既有 turns/render 管线的统一内容入口）。
 *
 * 检查顺序三段递进（§3.4，实现与测试双锚定）：第 1 段存在性 → 第 2 段路径闸
 * （whitelist.ts）→ 第 3 段开库与查询（四级恢复阶梯 + schema 已知集闸门在
 * openZcodeSessionDb 单点）。读库发生在 ext 进程内（§3.5 关键论断），不经 taiji。
 */
async function loadZcodeParsed(anchor: ZcodeAnchor, agentDir: string): Promise<ParseResult> {
  assertZcodeDbPathAllowed(anchor.dbPath, agentDir)
  let handle: Awaited<ReturnType<typeof openZcodeSessionDb>>
  try {
    handle = await openZcodeSessionDb(anchor.dbPath)
  } catch (e) {
    throw err(zcodeReadErrorMessage(e, agentDir))
  }
  try {
    // 恢复成功不再是静默事件（§3.4 硬要求）：结构化日志（恢复方式 + db 路径），不进
    // LLM 可见面。用 warn 而非 debug——L2/L3 是恢复降级路径，语义表 warn=内部降级与
    // 失败（appendEntry 持久化）；debug 缺省 no-op 会让恢复成功重新变回静默事件。
    if (handle.via !== 'L1-direct') {
      logger.warn('zcode session db recovered via recovery ladder', {
        dbPath: anchor.dbPath,
        via: handle.via,
      })
    }
    const row = handle.db.getSessionRow(anchor.sessionId)
    if (row === undefined) {
      throw err(formatZcodeSessionNotFound())
    }
    const transcript = handle.db.getSessionTranscript(anchor.sessionId)
    const normalized = convertZcodeTranscript(transcript, {
      id: anchor.sessionId,
      title: row.title,
      timeCreated: row.timeCreated,
    })
    if (normalized.degradations.length > 0) {
      // P2 契约（F13）：明细只进日志；压缩点以 custom entry 形态在 detail 可见
      logger.warn('zcode session conversion degraded', {
        sessionId: anchor.sessionId,
        dbPath: anchor.dbPath,
        degradations: normalized.degradations,
      })
    }
    // ParseResult 形状对齐：zcode 库读无「文件字节/坏行」概念（strict Entry 树已由
    // converter 保证），totalBytes/skippedLines 恒 0
    return { entries: normalized.entries, totalBytes: 0, skippedLines: 0, lastLinePartial: false }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('[zcode_')) throw e // 本函数产出的错误面原样传播
    throw err(zcodeReadErrorMessage(e, agentDir))
  } finally {
    handle.dispose()
  }
}

/**
 * 内容加载统一入口：zcode 路由命中 → zcode 读链（agentDir 供白名单派生，F11）；pi →
 * 既有 safeParse（行为零改动）。各 do* 的 safeParse(resolved.fileName) 消费点统一换
 * 此函数（pi 输出逐字节不变——zcodeAnchor 缺省即原路径）。
 */
async function loadParsed(
  resolved: Extract<ResolveResult, { kind: 'ok' }>,
  agentDir: string,
): Promise<ParseResult> {
  if (resolved.zcodeAnchor !== undefined) {
    return loadZcodeParsed(resolved.zcodeAnchor, agentDir)
  }
  return safeParse(resolved.fileName)
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

// ===========================================================================
// 各 action 实现
// ===========================================================================

/** find action 的默认匹配数上限。 */
const FIND_DEFAULT_LIMIT = 20

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
  const { entries, totalBytes, skippedLines } = await loadParsed(resolved, agentDir)
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
  // [D8d] skippedLines 同模式覆盖：解析层（session-core parseSessionFile）已检测坏行计数（render 签名不含 ParseResult 恒 0），
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
  const { entries } = await loadParsed(resolved, agentDir)
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
  const { entries } = await loadParsed(resolved, agentDir)
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
  const { entries } = await loadParsed(resolved, agentDir)
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
    const { entries } = await loadParsed(resolved, agentDir)
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
    const { entries } = await loadParsed(resolved, agentDir)
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
  const { entries } = await loadParsed(resolved, agentDir)
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
    case 'result': {
      // per-call 构造注入面（仅剩 tool-handler 文件私有 helper，纯函数经 handler-utils
      // 直接 import——ext-simplify-04 E5）：resolveSessionId 包装把信号包中的
      // liveSessionDir 闭包进解析调用（ResultActionDeps 接口签名固定 5 参，包装保持
      // 同形、末位补传），result 的片段形态与 find/outline 消费同一 roots
      //（sa-/绝对路径分支在 resolveSessionId 内不受影响）。
      // U9 zcode 路由：deps.safeParse 只认 fileName 字符串，而 zcode 内容源是库——
      // per-call Map 按 fileName（=锚库路径）携带锚，safeParse 包装分流到 zcode 读链
      //（pi 路径 Map 未命中 → 原样 safeParse，行为零变化）。
      const zcodeByFile = new Map<string, ZcodeAnchor>()
      return doResult(params, agentDir, {
        resolveSessionId: async (rawSession, action, ad, source, prefetchedManifests) => {
          const resolved = await resolveSessionId(
            rawSession,
            action,
            ad,
            source,
            prefetchedManifests,
            signals.liveSessionDir,
          )
          if (resolved.kind === 'ok' && resolved.zcodeAnchor !== undefined) {
            zcodeByFile.set(resolved.fileName, resolved.zcodeAnchor)
          }
          return resolved
        },
        disambiguate,
        safeParse: (fileName) => {
          const anchor = zcodeByFile.get(fileName)
          if (anchor !== undefined) {
            return loadZcodeParsed(anchor, agentDir)
          }
          return safeParse(fileName)
        },
      })
    }
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
