import { createReadStream, type ReadStream } from 'node:fs'
import { open, stat, type FileHandle } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { basename, dirname } from 'node:path'
import type { SessionRef } from '../core/family.js'
import {
  resolveSessionRoots,
  type SessionFileMeta,
  type SessionRoot,
  type SessionRootSignals,
} from './roots.js'
import {
  listRecordManifests,
  extractSessionIdFromFilename,
  readTailIdentity,
  type RecordManifest,
} from './subagents.js'

/**
 * M2 discovery 发现层：按 query 定位 session（design §3.3 D-3 + §3.4 find action）。
 *
 * 匹配三路（D-3）：
 * - uuid 片段子串：sessionId 含 query，或文件路径含 query
 * - "recent" 特殊值：按 mtime 倒序返回最近 N 个（不经片段匹配）
 * - 名称关键词：标题（u11，metadataProvider 注入）或首消息预览含 query（fallback，仅在
 *   uuid 片段零匹配且 query 非 uuid 特征时——D-5：不为定位付全文解析成本）
 *
 * 首行扫描策略（D-5）：先全量首行扫描拿 header（id/cwd/parentSession），不做全文解析；
 * 首消息预览仅在需要时（recent/uuid 匹配的最终结果 + 关键词 fallback）对候选单独深读。
 *
 * agentDir 注入：同 roots.ts，零 pi 依赖（仅 node:fs + 相对 import M1 core）。
 * u11（design 2026-09-10 §6.6）：标题元数据经 metadataProvider 注入（index.ts 包 pi 的
 * SessionManager.listAll），本层只见注入函数；三条调用策略——①惰性（仅 keyword 路径调）
 * ②窄化（仅平铺目录：未剥层 liveSessionDir 本身 + 无子目录候选根）③TTL 缓存（注入侧
 * tool-handler 包装，本层无缓存状态）。
 */

/** 候选来源标记（DM1 必填）：main = agentDir/sessions/、subagent = agentDir/subagents/。 */
export type SessionSource = 'main' | 'subagent'

export interface MatchedSession extends SessionRef {
  /** 候选来源（DM1 必填标记）：main 或 subagent，按文件所在目录标记 */
  source: SessionSource
  /** 首条 user message text 截 80 字符（从全文读，不只首行） */
  firstMessagePreview?: string
  /**
   * session 标题（u11：session_info entry 的 name，来自 metadataProvider）。仅在元数据
   * 可达（平铺目录 + provider 未抛错）时出现；标题检索降级时留空——「能找到 session」
   * 不受影响，只损失标题维度（§6.6 降级路径）。
   */
  name?: string
}

// ============================================================
// u11 标题元数据（design 2026-09-10 §6.6）：发现层契约类型，结构对齐 pi SessionInfo
// 消费子集（index.ts 直接传 listAll 返回值，结构兼容即透传，本层零 pi 依赖）
// ============================================================

/** 单目录元数据条目（pi SessionInfo 的消费子集：path/id/cwd/name/modified/firstMessage）。 */
export interface SessionMetadataEntry {
  /** 绝对路径（与候选 meta.path 同源） */
  path: string
  id: string
  cwd: string
  /** 用户标题（session_info entry 的 name）；旧 session 缺失 */
  name?: string
  /** pi 返回 Date，测试替身可传 number */
  modified: Date | number
  /** 首消息全文（title 命中时填充 firstMessagePreview，免二次读文件） */
  firstMessage?: string
}

/**
 * 标题元数据 provider（index.ts 构造：`(dir) => SessionManager.listAll(dir)`）。
 * 实装语义（§6.6 两条前提）：只扫一层平铺目录、每文件全量解析——调用方须遵守
 * 三条调用策略（惰性/窄化/缓存，缓存由 tool-handler 注入侧包装）。
 */
export type SessionMetadataProvider = (dir: string) => Promise<SessionMetadataEntry[]>

const DEFAULT_LIMIT = 20
const PREVIEW_MAX = 80
/** readFirstLine 单次读取 buffer 上限。session header（id/cwd/parentSession）远小于此。 */
const HEADER_READ_BYTES = 8192

/**
 * 读文件首行（header）。用定长 buffer 一次 read（避免 stream 开销），
 * 空文件/读失败返回 undefined。header 超 8KB 的极端情况会截断致 parse 失败——
 * session header（id+cwd）实测 < 300 字节，8KB 足够 27 倍余量。
 */
async function readFirstLine(path: string): Promise<string | undefined> {
  let fh: FileHandle | undefined
  try {
    fh = await open(path, 'r')
    const buf = Buffer.alloc(HEADER_READ_BYTES)
    const { bytesRead } = await fh.read(buf, 0, HEADER_READ_BYTES, 0)
    if (bytesRead === 0) return undefined
    const content = buf.subarray(0, bytesRead).toString('utf8')
    const nl = content.indexOf('\n')
    return nl === -1 ? content : content.slice(0, nl)
  } catch {
    return undefined
  } finally {
    await fh?.close().catch(() => {})
  }
}

/** 从单行 JSON 提取 message entry 的 user role 文本，非 user message 行返回 undefined。 */
function extractUserText(line: string): string | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const obj = raw as Record<string, unknown>
  if (obj.type !== 'message') return undefined
  const msg = obj.message
  if (typeof msg !== 'object' || msg === null) return undefined
  const m = msg as Record<string, unknown>
  if (m.role !== 'user') return undefined
  return extractTextFromContent(m.content)
}

/**
 * 从 message content 提取可读文本。
 * 兼容 pi 两种形态：string content（直接用）与 array content（拼 type:text 项的 text）。
 */
function extractTextFromContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const item of content) {
      if (typeof item === 'object' && item !== null) {
        const it = item as Record<string, unknown>
        if (it.type === 'text' && typeof it.text === 'string') {
          parts.push(it.text)
        }
      }
    }
    return parts.length > 0 ? parts.join(' ') : undefined
  }
  return undefined
}

/**
 * 读文件首条 user message 的文本。逐行扫描直到命中 role:user（不读全文，命中即停 stream）。
 * 用于名称关键词匹配 + firstMessagePreview 填充。
 */
async function readFirstUserMessageText(path: string): Promise<string | undefined> {
  let stream: ReadStream | undefined
  try {
    stream = createReadStream(path, { encoding: 'utf8' })
    const rl = createInterface({ input: stream, crlfDelay: Infinity })
    try {
      for await (const line of rl) {
        const text = extractUserText(line)
        if (text !== undefined) return text
      }
    } finally {
      rl.close()
    }
    return undefined // 无 user message（如纯 compaction session）
  } catch {
    return undefined
  } finally {
    stream?.destroy()
  }
}

interface SessionHeader {
  id: string
  cwd?: string
  parentSession?: string
}

/** 解析 header 首行为 SessionHeader。非 session 行/缺 id → null。 */
function parseHeader(line: string | undefined): SessionHeader | null {
  if (!line) return null
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  if (obj.type !== 'session' || typeof obj.id !== 'string') return null
  const header: SessionHeader = { id: obj.id }
  if (typeof obj.cwd === 'string') header.cwd = obj.cwd
  if (typeof obj.parentSession === 'string') header.parentSession = obj.parentSession
  return header
}

/**
 * uuid 归一化键（design 2026-09-10 §6.7 子决策 1）：小写 + 去连字符。
 * 修复 §3.3 的两个盲区——大写 uuid（String.includes 大小写敏感）与去连字符 uuid
 *（与带连字符 id 不构成子串）原先都 0 命中，且被 looksLikeUuidFragment（/i 大小写
 * 不敏感）误判为「像 uuid 片段」跳过关键词回退，彻底查不到。
 */
export function normalizeUuidKey(s: string): string {
  return s.toLowerCase().replace(/-/g, '')
}

/**
 * query 是否具备 uuid 片段特征（归一化后仅十六进制字符）。
 * 用于 uuid 片段零匹配时决定是否走名称关键词 fallback：纯十六进制 query（如 e6c96、019fe635）
 * 几乎不会出现在自然语言首消息里，深读首消息徒劳，跳过；含非十六进制字符的 query（如 plugin、
 * 重构）才走 fallback。边界词（如 abc，恰好全十六进制）会被判 uuid 特征不走 fallback——
 * 可接受（abc 作为首消息关键词罕见，且 uuid 片段匹配已先尝试）。
 *
 * u9 起用 norm(query) 判定（§6.7 子决策 1 / §11.5）：/i 已忽略大小写、去连字符不扩
 * 字符类，与旧判定 `/^[0-9a-f-]+$/i` 等价（唯一差异：纯连字符 query 归一化为空串后
 * 不再判 uuid 特征——精确子串层已先处理它，此处语义更准确）。
 */
function looksLikeUuidFragment(query: string): boolean {
  return /^[0-9a-f]+$/.test(normalizeUuidKey(query))
}

interface Candidate {
  meta: SessionFileMeta
  ref: SessionRef
  /** 候选来源（透传到 MatchedSession.source，DM1） */
  source: SessionSource
}

interface Matched extends Candidate {
  /** 名称关键词匹配路径已读出的预览；recent/uuid 路径 undefined，后续按需补读 */
  preview?: string
  /** 标题命中时携带（u11）；透传到 MatchedSession.name */
  name?: string
}

// ============================================================
// U5：subagent task/slug/agentName 匹配（manifest 索引 + P-fallback identity 回退）
// ============================================================

/**
 * 建 sessionId→RecordManifest 索引（U5：subagent task/slug/agentName 匹配用）。
 *
 * listRecordManifests 一次性读全部 manifest（json 小，几百字节），用 extractSessionIdFromFilename
 * 从 manifest.sessionFile 文件名提取 sessionId 作 key（与候选 header.id 同源真实 id）。无 subagent
 * 候选时跳过（避免无谓 IO——TC-find-manifest-index 的 O(1) 查表前提）。
 */
async function buildManifestIndex(
  agentDir: string,
  hasSubagentCandidates: boolean,
): Promise<Map<string, RecordManifest>> {
  if (!hasSubagentCandidates) return new Map()
  const manifests = await listRecordManifests(agentDir)
  const index = new Map<string, RecordManifest>()
  for (const m of manifests) {
    const sid = extractSessionIdFromFilename(basename(m.sessionFile))
    if (sid) index.set(sid, m)
  }
  return index
}

/**
 * subagent 候选元数据匹配（U5）：manifest 命中走 task/slug/agentName 子串；索引未命中（P-fallback，
 * 场景 A）读尾行 identity 回退匹配 task/slug/agent。
 *
 * manifest 命中但不匹配时不再回退 identity——manifest 是权威主表，task/slug/agentName 即其提供，
 * identity 同源数据回退无新信息（探针 manifest 20/20 全有 task/slug）。manifest 缺某字段（旧 manifest）
 * 时该字段 undefined，includes 自然 false，不影响其他字段。
 */
async function matchSubagentMetadata(
  candidate: Candidate,
  query: string,
  manifestIndex: Map<string, RecordManifest>,
): Promise<boolean> {
  const manifest = manifestIndex.get(candidate.ref.sessionId)
  if (manifest) {
    return (
      (manifest.task?.includes(query) ?? false) ||
      (manifest.slug?.includes(query) ?? false) ||
      (manifest.agentName?.includes(query) ?? false)
    )
  }
  // P-fallback：manifest 索引未命中 → 读尾行 identity 回退。E8（ext-simplify-04）：
  // 复用 subagents.ts 的 readTailIdentity 单实现，取 task/slug/agent 子集。行为差异 =
  // 缺 rootSessionId 的畸形 identity 行从「可匹配」变「不匹配」（m0 契约外数据，
  // design §3.3 E8 登记为可接受）。
  const ident = await readTailIdentity(candidate.meta.path, candidate.meta.size)
  if (!ident) return false
  return (
    (ident.task?.includes(query) ?? false) ||
    (ident.slug?.includes(query) ?? false) ||
    (ident.agent?.includes(query) ?? false)
  )
}

// ============================================================
// findSessions 编排 helpers（按处理阶段拆分：收集 → 匹配 → 排序截断 → 预览补读）
// ============================================================

/** meta + header → 候选构造（ref.cwd 归一化空串 + parentSession 按需挂载）。 */
function buildCandidate(
  meta: SessionFileMeta,
  header: SessionHeader,
  src: SessionSource,
): Candidate {
  const ref: SessionRef = {
    sessionId: header.id,
    // 完整绝对路径（与 parentSession 同构，便于 family 按 includes(sid) 反查）
    fileName: meta.path,
    mtime: meta.mtime,
    sizeBytes: meta.size,
    cwd: header.cwd ?? '',
  }
  if (header.parentSession) ref.parentSession = header.parentSession
  return { meta, ref, source: src }
}

/**
 * 步骤 0+1：逐根首行扫描建候选（source 过滤在根层，cwd 过滤在候选层）。
 *
 * u11 起直接消费 resolveSessionRoots 的根列表（单次实扫，files 与根归属信息同批产出——
 * 标题窄化策略需要「扫描结果无子目录的候选根」这一根级事实，薄包装的扁平列表给不出）。
 * 对只含 agentDir 的信号包，根集合 = [default]+[legacy]+[subagent]，与已删除薄包装
 * listMainSessions/listSubagentSessions（ext-simplify-04 U4/A3）原并集逐文件一致（含
 * workflow-state 跳过与 realpath 去重语义）；传 liveSessionDir 时按 §6.1 追加 [live] 根（realpath 去重保优先级）。
 */
async function collectCandidates(
  roots: SessionRoot[],
  sourceFilter: SessionSource | undefined,
  cwdFilter: string | undefined,
): Promise<Candidate[]> {
  const candidates: Candidate[] = []
  for (const root of roots) {
    if (root.dedupedInto !== undefined) continue // 被去重根未实扫（files 恒空），不产候选
    if (sourceFilter !== undefined && root.source !== sourceFilter) continue
    for (const meta of root.files) {
      const header = parseHeader(await readFirstLine(meta.path))
      if (!header) continue // 非 session 文件/坏 header → 跳过
      if (cwdFilter !== undefined && (header.cwd ?? '') !== cwdFilter) continue
      candidates.push(buildCandidate(meta, header, root.source))
    }
  }
  return candidates
}

// ============================================================
// u11 标题检索（design 2026-09-10 §6.6）：惰性触发 + 平铺窄化 + 两条 guard
// ============================================================

/** 匹配层的元数据上下文（全部来自注入；metadataProvider 缺省 = 现状行为零变化）。 */
interface MetadataContext {
  agentDir: string
  /** 本查询刚完成的实扫根列表（窄化判据「扫描结果无子目录的候选根」的数据源） */
  roots: SessionRoot[]
  /** 未剥层 liveSessionDir 原始信号（窄化目标 ①；缺省 = 三根降级形态，全部回退） */
  liveSessionDir?: string
  metadataProvider?: SessionMetadataProvider
}

/** stat 目录是否存在（guard：仅对存在的根/目录调用 provider）。 */
async function pathExistsDir(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 条目 modified 的可比数值（pi 返回 Date，测试替身可传 number）。 */
function modifiedOf(e: SessionMetadataEntry): number {
  return typeof e.modified === 'number' ? e.modified : e.modified.getTime()
}

/**
 * 平铺目录判据（§6.6 调用策略 ②）：本根实扫出的全部 .jsonl 都直接位于根本身
 *（即扫描结果无子目录）。listAll(dir) 实装语义是「只扫一层平铺目录」——平铺根意味着
 * listAll 能看到全部文件；含子目录根（如纯 pi 的 encodeCwd 布局）跳过，标题检索对其中
 * 候选不可用（枚举全部子目录 × 全量解析成本不可接受），候选不退出 keyword 匹配。
 */
function isFlatRoot(root: SessionRoot): boolean {
  return root.files.every((f) => dirname(f.path) === root.path)
}

/**
 * 加载标题元数据索引（u11）。仅 keyword 路径调用（惰性触发：uuid 精确/归一化两级零命中
 * 且 query 非纯 hex 才到达此处，§6.6 调用策略 ①）。
 *
 * 窄化目标（策略 ②，按序）：未剥层 liveSessionDir 本身（xyz-agent 下即平铺主根；纯 pi 下
 * 即当前 cwd 目录，小）+ 实扫结果无子目录的候选根。两条 guard：
 * - 仅对存在的根/目录调用（root.exists / stat liveSessionDir），且永传非空串——pi 的
 *   listAll 对空串 falsy 走默认全盘分支（数千项 / 秒级，hash-provider.ts 空参灾难先例）；
 * - 单目录 try/catch：provider 抛错记空继续，不中断其他目录（策略降级路径）。
 *
 * 多目录结果合并语义（§11.3b）：按 id 去重，重复取新 modified。
 */
async function loadTitleIndex(ctx: MetadataContext): Promise<Map<string, SessionMetadataEntry>> {
  const index = new Map<string, SessionMetadataEntry>()
  const provider = ctx.metadataProvider
  if (provider === undefined) return index

  const targets: string[] = []
  const seen = new Set<string>()
  const push = (dir: string): void => {
    if (dir.length === 0 || seen.has(dir)) return // guard：永传非空串；同字面路径只调一次
    seen.add(dir)
    targets.push(dir)
  }
  if (ctx.liveSessionDir !== undefined && ctx.liveSessionDir.length > 0) {
    if (await pathExistsDir(ctx.liveSessionDir)) push(ctx.liveSessionDir)
  }
  for (const root of ctx.roots) {
    if (root.dedupedInto !== undefined) continue
    if (!root.exists) continue // guard：仅对存在的根调用
    if (!isFlatRoot(root)) continue // 策略 ②：含子目录根跳过 listAll
    push(root.path)
  }

  for (const dir of targets) {
    let entries: SessionMetadataEntry[]
    try {
      entries = await provider(dir)
    } catch {
      continue // guard：单目录抛错记空继续 → 该目录候选回退首条 user 匹配，标题留空
    }
    for (const e of entries) {
      const prev = index.get(e.id)
      if (prev === undefined || modifiedOf(e) > modifiedOf(prev)) index.set(e.id, e)
    }
  }
  return index
}

/** 步骤 2 关键词层（U5 扩展 + u11 标题）：manifest 元数据（subagent）→ 标题（u11）→ 首消息预览，命中任一即入选。 */
async function matchByKeywords(
  candidates: Candidate[],
  query: string,
  ctx: MetadataContext,
): Promise<Matched[]> {
  const manifestIndex = await buildManifestIndex(
    ctx.agentDir,
    candidates.some((c) => c.source === 'subagent'),
  )
  // 惰性触发点（§6.6 策略 ①）：仅 keyword 路径构建标题索引；uuid/recent 匹配路径不经过
  // 本函数。provider 缺省时 loadTitleIndex 直接返回空 Map（现状行为零变化）。
  const titles = await loadTitleIndex(ctx)
  const keywordHits: Matched[] = []
  for (const c of candidates) {
    // - subagent 候选：先查 manifest 索引（命中走元数据子串，未命中 P-fallback 读尾行 identity）；
    //   元数据命中即入选（preview 留空，第 5 步补读首消息），未命中仍可走首消息 fallback
    // - 标题命中（u11）：name 含 query 即入选，标题检索是首消息维度的**增量**能力（§6.6）；
    //   命中候选免深读首消息（preview 取元数据 firstMessage），免读文件
    // - 元数据/标题未命中：首消息预览 query 子串匹配（m0 现状路径不变——含子目录根、
    //   provider 缺省/抛错形态都落到这里，成本与召回均无变化）
    if (c.source === 'subagent' && (await matchSubagentMetadata(c, query, manifestIndex))) {
      keywordHits.push({ ...c })
      continue
    }
    const meta = titles.get(c.ref.sessionId)
    if (meta?.name !== undefined && meta.name.includes(query)) {
      keywordHits.push({
        ...c,
        name: meta.name,
        preview: meta.firstMessage !== undefined && meta.firstMessage !== ''
          ? meta.firstMessage.slice(0, PREVIEW_MAX)
          : undefined,
      })
      continue
    }
    const text = await readFirstUserMessageText(c.meta.path)
    if (text && text.includes(query)) {
      // 标题索引有该候选但不命中 query 时仍携带 name（渲染层标题优先展示，§5.1 形态）
      keywordHits.push({
        ...c,
        ...(meta?.name !== undefined ? { name: meta.name } : {}),
        preview: text.slice(0, PREVIEW_MAX),
      })
    }
  }
  return keywordHits
}

/** 步骤 2 三路匹配：recent / uuid 片段（两级：精确 + 归一化，§6.7 子决策 1）/ 名称关键词+U5 元数据+u11 标题。 */
async function matchCandidates(
  candidates: Candidate[],
  query: string,
  ctx: MetadataContext,
): Promise<Matched[]> {
  if (query === 'recent') {
    // recent：不经片段匹配，全部候选按 mtime 倒序后截 limit
    return candidates.map((c) => ({ ...c }))
  }
  // 第一级 uuid 片段匹配（sessionId 或文件路径含 query）——cheap，已有 header。
  // 零命中才进入第二级（互斥回退，非合并排序，§6.7 子决策 1）。
  const exactHits = candidates.filter(
    (c) => c.ref.sessionId.includes(query) || c.meta.path.includes(query),
  )
  if (exactHits.length > 0) {
    return exactHits.map((c) => ({ ...c }))
  }
  // 第二级归一化匹配：norm(sessionId).includes(norm(query))（小写 + 去连字符）。
  // 只比 sessionId 不比 path——path 含时间戳等非 id 数字，norm 后误吸面大。
  // 到达此层与第一级互斥（精确命中已返回），即归一化命中恒排在精确命中之后；
  // keyword 命中只在归一化零命中时发生，层序自然成立。nq 为空串（纯连字符
  // query）时跳过——includes('') 恒 true 会误吸全部候选。
  const nq = normalizeUuidKey(query)
  if (nq.length > 0) {
    const normHits = candidates.filter((c) => normalizeUuidKey(c.ref.sessionId).includes(nq))
    if (normHits.length > 0) {
      // mtime 倒序由 sortByMtimeAndTruncate 统一处理
      return normHits.map((c) => ({ ...c }))
    }
  }
  if (looksLikeUuidFragment(query)) {
    // query 像 uuid 片段但精确 + 归一化两级均无匹配 → uuid 写错的可能性高，
    // 不对全部候选深读首消息
    return []
  }
  // 惰性触发（§6.6 策略 ①）：到此层 ⟺ uuid 精确 = 0 且归一化 = 0 且 query 非纯 hex，
  // 即 keyword 路径——只有这里才允许调 metadataProvider。
  return matchByKeywords(candidates, query, ctx)
}

/** 步骤 3+4：mtime 倒序 + limit 截断（truncated 标记是否截断）。 */
function sortByMtimeAndTruncate(
  matched: Matched[],
  limit: number,
): { items: Matched[]; truncated: boolean } {
  matched.sort((a, b) => b.ref.mtime - a.ref.mtime)
  const truncated = matched.length > limit
  return { items: truncated ? matched.slice(0, limit) : matched, truncated }
}

/** recent 路径的目录级标题元数据（按目录去重 + 单目录抛错记空 + 同 id 取新 modified）。 */
async function loadRecentTitles(
  sliced: Matched[],
  provider: SessionMetadataProvider,
): Promise<Map<string, SessionMetadataEntry>> {
  const titles = new Map<string, SessionMetadataEntry>()
  // 候选所在目录天然平铺（文件直在其下）；按目录去重合并调用，多目录同 id 取新 modified
  const dirs = [...new Set(sliced.map((m) => dirname(m.meta.path)))]
  for (const dir of dirs) {
    let entries: SessionMetadataEntry[]
    try {
      entries = await provider(dir)
    } catch {
      continue // guard：抛错记空 → 该目录候选回退 readFirstUserMessageText
    }
    for (const e of entries) {
      const prev = titles.get(e.id)
      if (prev === undefined || modifiedOf(e) > modifiedOf(prev)) titles.set(e.id, e)
    }
  }
  return titles
}

/** 标题优先级：本层已命中 name > 元数据 name（u11）；两者皆无→ undefined（不挂字段）。 */
function resolveName(m: Matched, meta: SessionMetadataEntry | undefined): string | undefined {
  if (m.name !== undefined) return m.name
  return meta?.name
}

/**
 * 预览优先级：本层已读 preview > 元数据 firstMessage（免深读）> 实读文件首条 user message。
 * 最后一条兼作 readFirstUserMessageText 的唯一调用点（最多 limit 次 IO）。
 */
async function resolvePreview(
  m: Matched,
  meta: SessionMetadataEntry | undefined,
): Promise<string | undefined> {
  if (m.preview !== undefined) return m.preview
  if (meta?.firstMessage !== undefined && meta.firstMessage !== '') {
    return meta.firstMessage.slice(0, PREVIEW_MAX)
  }
  const text = await readFirstUserMessageText(m.meta.path)
  return text ? text.slice(0, PREVIEW_MAX) : undefined
}

/**
 * 步骤 5：填 firstMessagePreview / name（recent/uuid 路径未读，对最终 limit 个补读——最多 limit 个 IO）。
 *
 * u11 recent 补充（§6.6 策略 ① 括注）：recent 路径不参与标题匹配，但**仅对 limit 截断后
 * 的少数候选**按其所在目录补元数据（标题 + 免深读的 preview）。provider 缺省 = 现状行为；
 * provider 抛错按目录记空回退读文件（与 loadTitleIndex 同款 guard）。
 */
async function fillFirstMessagePreviews(
  sliced: Matched[],
  recentMetadataProvider?: SessionMetadataProvider,
): Promise<MatchedSession[]> {
  const titles =
    recentMetadataProvider !== undefined && sliced.length > 0
      ? await loadRecentTitles(sliced, recentMetadataProvider)
      : new Map<string, SessionMetadataEntry>()
  const result: MatchedSession[] = []
  for (const m of sliced) {
    const meta = titles.get(m.ref.sessionId)
    const out: MatchedSession = { ...m.ref, source: m.source }
    const name = resolveName(m, meta)
    if (name !== undefined) out.name = name
    const preview = await resolvePreview(m, meta)
    if (preview !== undefined) out.firstMessagePreview = preview
    result.push(out)
  }
  return result
}

/**
 * 按 query 找 session（接口冻结，design §3.4 find action）。
 *
 * 返回按 mtime 倒序，limit 截断（默认 20），truncated 标记是否截断。
 * cwd 过滤：opts.cwd 提供时只留 header.cwd === opts.cwd 的（在匹配前过滤，减少 fallback 深读量）。
 * 匹配为空 → `{ matches: [], truncated: false }`（F1 恢复指引在 M3 tool-adapter 层）。
 *
 * u11（design 2026-09-10 §6.6）：
 * - opts.liveSessionDir：未剥层 live 信号，透传 resolveSessionRoots（[live] 根，realpath
 *   去重）并作标题窄化目标；缺省 = 现状三根降级行为。
 * - opts.metadataProvider：标题元数据注入（仅 keyword 路径 + recent 截断后补充消费）；
 *   缺省 = undefined = 现状行为（标题检索不可用，首条 user 匹配不受影响）。
 *
 * E1 预解析根复用（ext-simplify-04 §3 D1）：opts.roots = 调用方预解析的根列表——同一
 * 次 doFind 内多段查询（分组 main/subagent 两路）复用同一次根解析，目录扫描不随查询
 * 段数翻倍。缺省 = 本函数自解析（既有测试与单段调用方零改动）。调用方须保证传入的
 * roots 来自无 options 的 resolveSessionRoots 实扫（预解析是复用同一次实扫——根扫描
 * 无缓存，doctor 缓存机已删除，ext-simplify-04 U3）。
 */
export async function findSessions(
  query: string,
  agentDir: string,
  opts?: {
    cwd?: string
    limit?: number
    source?: SessionSource
    liveSessionDir?: string
    metadataProvider?: SessionMetadataProvider
    /** 预解析根列表（E1/D1）：提供则跳过内部 resolveSessionRoots，直接消费 */
    roots?: SessionRoot[]
  },
): Promise<{ matches: MatchedSession[]; truncated: boolean }> {
  const limit = opts?.limit ?? DEFAULT_LIMIT
  const cwdFilter = opts?.cwd
  const sourceFilter = opts?.source

  // 0. 根解析（单次实扫，无 options——根扫描无缓存）；
  // E1：调用方已预解析（opts.roots）时复用，不再自扫
  const signals: SessionRootSignals =
    opts?.liveSessionDir !== undefined && opts.liveSessionDir.length > 0
      ? { agentDir, liveSessionDir: opts.liveSessionDir }
      : { agentDir }
  const roots = opts?.roots ?? (await resolveSessionRoots(signals))
  // 0+1. 逐根首行扫描建候选
  const candidates = await collectCandidates(roots, sourceFilter, cwdFilter)
  // 2. 三路匹配（recent / uuid 片段 / 名称关键词+U5 元数据+u11 标题）
  const matched = await matchCandidates(candidates, query, {
    agentDir,
    roots,
    liveSessionDir: opts?.liveSessionDir,
    metadataProvider: opts?.metadataProvider,
  })
  // 3+4. mtime 倒序 + limit 截断
  const { items, truncated } = sortByMtimeAndTruncate(matched, limit)
  // 5. 填 firstMessagePreview（对最终 limit 个补读）；recent 路径仅对截断后少数候选补标题元数据
  const matches = await fillFirstMessagePreviews(
    items,
    query === 'recent' ? opts?.metadataProvider : undefined,
  )

  return { matches, truncated }
}

// ============================================================
// u12 跨会话内容检索（design 2026-09-10 §2 目标 5 / §8.2 V8）：候选索引
// ============================================================

/** 跨会话检索的候选文件引用（id/路径/大小/来源，字节预算与渲染所需的最小集）。 */
export interface SessionFileRef {
  sessionId: string
  path: string
  sizeBytes: number
  mtime: number
  source: SessionSource
}

/**
 * 一次根扫描建 sessionId → 文件引用索引（u12，跨会话 search 的候选来源）。
 *
 * id 取自首行 header（复用 collectCandidates 的首行扫描——与 find 候选、resolveSessionId
 * 同一 id 语义，agent 从 find 输出复制的完整 id 恒能命中；不按文件名反推，避免「文件改名
 * 后与 header id 失配」的误报面）。workflow-state 跳过、坏 header 跳过、被去重根不产候选
 * 均随 collectCandidates 继承。同 id 多根出现（[live] 与 [default] 不去重，V2 语义）时取
 * mtime 新者（与 loadTitleIndex 合并语义一致）。
 *
 * 本函数不做数量限制——窄化前置（候选数阈值拒绝）与字节预算在调用方（tool-handler
 * searchAcrossSessions），索引只负责「一次实扫、id 全覆盖」。
 */
export async function buildSessionFileIndex(
  signals: SessionRootSignals,
): Promise<Map<string, SessionFileRef>> {
  const roots = await resolveSessionRoots(signals)
  const candidates = await collectCandidates(roots, undefined, undefined)
  const index = new Map<string, SessionFileRef>()
  for (const c of candidates) {
    const prev = index.get(c.ref.sessionId)
    if (prev === undefined || c.ref.mtime > prev.mtime) {
      index.set(c.ref.sessionId, {
        sessionId: c.ref.sessionId,
        path: c.ref.fileName,
        sizeBytes: c.ref.sizeBytes,
        mtime: c.ref.mtime,
        source: c.source,
      })
    }
  }
  return index
}
