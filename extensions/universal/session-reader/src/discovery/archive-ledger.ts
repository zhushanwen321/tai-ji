/**
 * 归档簿记域（session-archive 设计 D7：session-reader 归档根感知）。
 *
 * taiji 归档功能把闲置 session 整体搬入 `<agentDir>/archive/`（D1 镜像布局）并
 * zstd 压缩主文件，每个归档单元一份明文簿记 `<原主文件名>.archive.json`（D3
 * schema）。本模块是 extension 侧的簿记消费子集：解析 + 扫描 + 归档态渲染——
 * **类型自含**（universal 包不依赖 taiji workspace shared，簿记字段子集在本地
 * 接口声明），零内部依赖（不 import 本包其他模块，roots.ts 单向消费本模块，
 * 规避 archive-ledger→find→roots 的值级循环 import）。
 *
 * 收集契约（D7 硬约束）：归档根**只收 `.archive.json` 簿记、不收 `.jsonl`**——
 * staging 期归档目录内暂存明文主文件，一旦误收会被当「可完整读取的在场 session」
 * 进候选集，归档标注随之失效；`.restoring` 后缀（恢复中，D9）不以
 * `.archive.json` 结尾，天然不进收集。
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'

/** 归档根目录名（`<agentDir>/archive/`，与 sessions/ 平级——D1）。 */
export const ARCHIVE_DIRNAME = 'archive'

/** 归档根目录（`<agentDir>/archive/`，agentDir 注入推导）。 */
export function resolveArchiveDir(agentDir: string): string {
  return join(agentDir, ARCHIVE_DIRNAME)
}

/**
 * 存储树分区目录名合法性正则（镜像 shared `PI_SESSION_ID_PATTERN` 与 roots.ts
 * 同字面副本：首尾字母数字，中间 [A-Za-z0-9._-]，禁 `:`）。簿记 sessionId 是
 * 路径消费与展示的锚，形态非法（含穿越片段）的簿记整条拒收。
 */
const PI_SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/

/** 摘要单 turn（D4 算法产出：user 原文 + agent 最后一段文本；agent null = 该 turn 以工具调用结束）。 */
export interface ArchiveLedgerTurn { // oe-exempt:20261020:framework:SDK 契约接口——跨进程/跨包协议载体，接口先立、单实现常态
  user: string
  agent: string | null
}

/**
 * 归档簿记消费子集（D3 schema 的本包视角）。仅声明本域消费字段——rawBytes/
 * codec/sha256 等压缩侧字段不进（extension 侧不消费压缩体，D7：命中归档
 * session 时不读压缩体）。
 */
export interface ArchiveLedgerEntry { // oe-exempt:20261020:framework:SDK 契约接口——跨进程/跨包协议载体，接口先立、单实现常态
  /** 簿记文件绝对路径（`archive/<encodeCwd>/<原主文件名>.archive.json`） */
  ledgerPath: string
  sessionId: string
  /** 归档时从明文 JSONL 提取的名称（免解压名称数据源，D3——名称片段匹配的键之一） */
  name?: string
  /** staging（搬移完成、摘要/压缩未完成）| archived（终态，摘要已入簿记） */
  status: 'staging' | 'archived'
  /** 摘要 turns；staging 期缺省 null（归档态返回走占位文案） */
  summary: ArchiveLedgerTurn[] | null
  /** 原工作目录（簿记可选字段，展示备用） */
  cwd?: string
  /** 归档时间（ISO 字符串，消歧展示用） */
  archivedAt?: string
  /** 簿记文件 mtime（ms，多命中排序键——簿记终态原子重写时间即归档完成时间） */
  mtime: number
}

/** summary 字段的解析结果：turns 数组 / null / 非法（undefined）。 */
function parseSummary(raw: unknown): ArchiveLedgerTurn[] | null | undefined {
  if (raw === null) return null
  // raw 非 null 已由上一行保证（summary 合法形态恰为 turns 数组或显式 null），此处只需挡非对象。
  if (typeof raw !== 'object') return undefined
  const turnsRaw = (raw as Record<string, unknown>).turns
  if (!Array.isArray(turnsRaw)) return undefined
  const turns: ArchiveLedgerTurn[] = []
  for (const t of turnsRaw) {
    if (typeof t !== 'object' || t === null) return undefined
    const obj = t as Record<string, unknown>
    if (typeof obj.user !== 'string') return undefined
    if (obj.agent !== null && typeof obj.agent !== 'string') return undefined
    turns.push({ user: obj.user, agent: obj.agent as string | null })
  }
  return turns
}

/**
 * 解析簿记 JSON 文本（D3 消费子集）。非法形态返回 undefined 整条拒收：
 * sessionId 缺失/形态非法、status 词表外、summary 结构非法——坏簿记不中断
 * 扫描（调用方跳过），与 scanJsonlRecursive 的容错哲学一致。
 */
export function parseArchiveLedgerText(text: string): Omit<ArchiveLedgerEntry, 'ledgerPath' | 'mtime'> | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const obj = raw as Record<string, unknown>
  if (typeof obj.sessionId !== 'string' || !PI_SESSION_ID_PATTERN.test(obj.sessionId)) {
    return undefined
  }
  if (obj.status !== 'staging' && obj.status !== 'archived') return undefined
  const summary = parseSummary(obj.summary)
  if (summary === undefined) return undefined
  const out: Omit<ArchiveLedgerEntry, 'ledgerPath' | 'mtime'> = {
    sessionId: obj.sessionId,
    status: obj.status,
    summary,
  }
  if (typeof obj.name === 'string' && obj.name.length > 0) out.name = obj.name
  if (typeof obj.cwd === 'string' && obj.cwd.length > 0) out.cwd = obj.cwd
  if (typeof obj.archivedAt === 'string' && obj.archivedAt.length > 0) out.archivedAt = obj.archivedAt
  return out
}

/**
 * 归档根扫描时整体跳过的子目录名：`assets/` 是附件三目录区（D1 映射表），
 * 体积可达归档单元的大头且无簿记，递归进去只耗 IO。
 */
const SKIP_DIRS_ARCHIVE = new Set(['assets'])

/**
 * 递归扫描归档根下全部 `.archive.json` 簿记并解析（D7 独立簿记收集器）。
 * 只收 `.archive.json` 后缀——`.jsonl`（staging 明文主文件）与 `.restoring`
 * （恢复中簿记）天然排除。单个簿记读/解析失败跳过不中断（容错）。根不存在/
 * 无权限 → 空数组，不抛错（roots.ts 单根失败契约）。
 */
export async function scanArchiveLedgers(archiveRoot: string): Promise<ArchiveLedgerEntry[]> {
  const results: ArchiveLedgerEntry[] = []

  async function walk(currentDir: string): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await readdir(currentDir, { withFileTypes: true })
    } catch {
      return // 目录不存在/无权限 → 静默返回（容错，同 scanJsonlRecursive）
    }
    for (const entry of entries) {
      const full = join(currentDir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS_ARCHIVE.has(entry.name)) continue
        await walk(full)
      } else if (entry.isFile() && entry.name.endsWith('.archive.json')) {
        let text: string
        try {
          text = await readFile(full, 'utf8')
        } catch {
          continue // 并发删除/不可读 → 跳过该簿记
        }
        const parsed = parseArchiveLedgerText(text)
        if (parsed === undefined) continue // 坏簿记跳过
        try {
          const s = await stat(full)
          results.push({ ...parsed, ledgerPath: full, mtime: s.mtimeMs })
        } catch {
          continue
        }
      }
    }
  }

  await walk(archiveRoot)
  return results
}

// ============================================================
// 归档态渲染（D7 返回形态——硬契约：agent 必须能区分摘要与完整历史）
// ============================================================

/** 归档态头部标注（D7 字面契约）。 */
const ARCHIVED_HEADER = '状态: 已归档 (archived) — 完整内容已压缩离线，以下仅为摘要'

/** staging 态头部标注（V10：头部 + 占位句 + 名称/id 元数据）。 */
const STAGING_HEADER = '状态: 已归档 (staging) — 摘要生成中，请稍后再查'

/** 尾注恢复指引（D7 字面契约）。 */
const RESTORE_NOTE = '注: 如需完整历史，请让用户在归档列表中恢复该会话。'

/** 纯图片/附件 user 消息的占位（D4：空串 user 文本，D11 同款占位语义）。 */
const USER_ATTACHMENT_PLACEHOLDER = '[图片/附件消息]'

/** turn 无 agent 文本的占位（D4：agent null = 以工具调用结束）。 */
const AGENT_NO_TEXT_PLACEHOLDER = '（此 turn 以工具调用结束，无文本回复）'

/**
 * 渲染归档态返回正文（纯函数，两态）：
 *
 * - archived：头部标注 + 摘要 turns（`── turn N ──` 分隔，user / assistant (摘要)
 *   两行，两类占位规则同 D11）+ 尾注恢复指引——**不含任何完整历史内容**
 *   （turns 只来自簿记 summary，agent 可区分摘要与完整历史的硬契约）。
 * - staging：头部（staging 标注）+ 名称/id 元数据 + 尾注；无摘要可渲染。
 */
export function formatArchivedText(entry: ArchiveLedgerEntry): string {
  const lines: string[] = []
  if (entry.status === 'staging') {
    lines.push(`[session-reader] session: ${entry.name ?? entry.sessionId}（id: ${entry.sessionId}）`)
    lines.push(STAGING_HEADER)
    lines.push(RESTORE_NOTE)
    return lines.join('\n')
  }
  lines.push(`[session-reader] session: ${entry.name ?? entry.sessionId}`)
  lines.push(ARCHIVED_HEADER)
  const turns = entry.summary ?? []
  turns.forEach((t, i) => {
    lines.push(`── turn ${i + 1} ──`)
    lines.push(`user: ${t.user.length > 0 ? t.user : USER_ATTACHMENT_PLACEHOLDER}`)
    lines.push(`assistant (摘要): ${t.agent ?? AGENT_NO_TEXT_PLACEHOLDER}`)
  })
  lines.push(RESTORE_NOTE)
  return lines.join('\n')
}

/** 归档多命中消歧文案（F2 同构：列候选 + 👉 更精确重试，不抛错）。 */
export function formatArchivedDisambiguation(query: string, entries: ArchiveLedgerEntry[]): string {
  // mtime 倒序（最新归档在前，与 find 排序口径一致）
  const sorted = [...entries].sort((a, b) => b.mtime - a.mtime)
  const lines = [`多个归档 session 匹配 "${query}"，按归档时间倒序：`]
  for (const e of sorted) {
    const when = e.archivedAt !== undefined ? `，归档于 ${e.archivedAt}` : ''
    lines.push(`  - ${e.name ?? '(未命名)'}（id: ${e.sessionId}${when}）`)
  }
  lines.push('👉 用完整 session id 或更长的名称片段重试（归档 session 直接用 session 参数引用，返回摘要）。')
  return lines.join('\n')
}
