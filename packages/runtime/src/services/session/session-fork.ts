/**
 * Session fork 工具（路径 A：runtime 读 JSONL 截断 + 新进程 switch_session）。
 *
 * pi 原生 fork RPC 有语义限制（只支持 user message + position="before"，clone 只能 leaf），
 * 且 fork 在当前进程内 rebind 会破坏源 session 活跃状态。
 * 本工具在 runtime 层实现截断：读源 session JSONL → 按 entryId 树回溯 → 写新 JSONL，
 * 不调 pi fork RPC，不动源 session 的 pi 进程。
 *
 * fork 点解析（S6 随 lifecycle fork 编排迁入，原 Facade resolveEntryIdByTimestamp）：
 * RPC 路径加载的 session 无 piEntryId 时，按前端消息 timestamp + role 在源 JSONL 中
 * 匹配 fork 点 entryId（纯函数，消费方 session-lifecycle.forkSession）。
 *
 * entry 树结构（pi 0.80.3 JSONL v3）：
 *   - session（header，root，无 parentId）：{ type:"session", version, id, timestamp, cwd }
 *   - message：{ type:"message", id, parentId, timestamp, message:{role, content:[]} }
 *   - custom_message：{ type:"custom_message", id, parentId, timestamp, customType, content, ... }
 *   - model_change / thinking_level_change：{ type, id, parentId, timestamp, ... }
 *   - compaction：{ type:"compaction", id, parentId, timestamp, summary, ... }
 *   - session_info（可选，不参与树）：{ type:"session_info", name }
 *
 * 截断语义：
 *   - includeFrom=true：保留 root → forkEntry 的路径（含 forkEntry 自身）
 *   - includeFrom=false：保留 root → forkEntry 的路径（不含 forkEntry）
 *   兄弟分支（不在路径上的 entry）全部丢弃。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseJsonl } from '../../utils/jsonl.js'
import { isEnoent } from '../../utils/errors.js'
import { encodeCwd } from '../../infra/pi/pi-paths.js'

/** pi JSONL entry 的最小结构（只关心树拓扑）。 */
interface PiEntry {
  type: string
  id?: string
  parentId?: string | null
  timestamp?: string
  [key: string]: unknown
}

/** session header entry（树的 root）。parentSession 在 fork 出的 session 上指向源文件。 */
interface SessionHeaderEntry extends PiEntry {
  type: 'session'
  version: number
  id: string
  timestamp: string
  cwd: string
  parentSession?: string
  forkEntryId?: string
}

/** fork 结果：新文件路径 + 新 session id（+ sourceFilePath 供 FR-20 fallback 判断）。 */
export interface ForkedFile {
  filePath: string
  sessionId: string
  /** 源 session 文件路径（fork 调用方传入的 sourceFilePath，供上层判断 parentSession fallback）。 */
  sourceFilePath: string
}

/**
 * 读源 session JSONL，按 forkEntryId 截断，写新 JSONL 文件。
 *
 * @param sourceFilePath   源 session JSONL 绝对路径
 * @param forkEntryId      fork 点的 pi entryId（截断用，message entry 的 id）
 * @param includeFrom      true: 保留到 forkEntry（含）；false: 保留到 forkEntry 前（不含）
 * @param targetDir        新 JSONL 写入目录（pi sessions 根；产物实际落在其下
 *                         `<encodeCwd(header.cwd)>/` 子目录，方案 B 布局）
 * @param forkEntryIdField 可选，写入新 header 的 forkEntryId 字段（供后续 merge 定位 fork 点）。
 *                         与 forkEntryId 区别：后者用于截断回溯，前者是落盘标记（二者常相等，
 *                         但 includeFrom=false 等场景下语义不同；undefined 时不写该字段）。
 * @param fallbackParentId 可选，源 session 未落盘（sessionFilePath=undefined）时的 parentSession
 *                         fallback 键（FR-20）：用此值（源 sessionId）而非 sourceFilePath，
 *                         形成可追溯的父子链。parentSession 始终指向直接父级（源 session），
 *                         不透传源 header 的 parentSession（那是祖父）。
 * @returns 新文件路径 + 新 session id + sourceFilePath（供上层 fallback 判断）
 * @throws 源文件不存在 / forkEntryId 在树中找不到 / 源文件无 session header
 */
/**
 * 读源 session JSONL 并解析为 entry 列表（阶段 1）。
 * ENOENT 语义逐字节保持：文件不存在 → 带路径错误；其他读错误（EACCES 等）原样上抛。
 */
async function readSourceEntries(sourceFilePath: string): Promise<PiEntry[]> {
  let raw: string
  try {
    raw = await readFile(sourceFilePath, 'utf-8')
  } catch (e) {
    if (isEnoent(e)) {
      throw new Error(`fork: source session file not found: ${sourceFilePath}`)
    }
    throw e
  }
  return parseJsonl(raw) as PiEntry[]
}

/** 找 session header（root），提取 cwd；无有效 header → 带路径错误（阶段 2）。 */
function requireSessionHeader(entries: PiEntry[], sourceFilePath: string): SessionHeaderEntry {
  const header = entries.find((e): e is SessionHeaderEntry =>
    e.type === 'session' && typeof e.id === 'string' && typeof e.cwd === 'string',
  )
  if (!header) {
    throw new Error(`fork: source session has no valid session header: ${sourceFilePath}`)
  }
  return header
}

/** 建 id → entry 索引（只索引有 id 的 entry）（阶段 3）。 */
function buildEntryIndex(entries: PiEntry[]): Map<string, PiEntry> {
  const entryById = new Map<string, PiEntry>()
  for (const e of entries) {
    if (typeof e.id === 'string') entryById.set(e.id, e)
  }
  return entryById
}

/**
 * 从 forkEntryId 沿 parentId 回溯到 root，收集路径上的 entryId 集合（阶段 4）。
 * header（type session）到达即停、不加入集合（header 单独重建）；
 * parentId 指向不存在的 entry（跨文件 parent 或数据损坏）即停；
 * 空集 → forkEntryId 在树中找不到，带路径错误。
 */
function collectKeptEntryIds(
  entryById: Map<string, PiEntry>,
  forkEntryId: string,
  sourceFilePath: string,
  entryCount: number,
): Set<string> {
  const keepIds = new Set<string>()
  let currentId: string | undefined = forkEntryId
  let visited = 0
  // 安全阀：正常树深度 ≤ allEntries.length，+SAFETY_MARGIN 防循环引用死循环
  const SAFETY_MARGIN = 10
  const maxDepth = entryCount + SAFETY_MARGIN
  while (currentId && visited < maxDepth) {
    const entry = entryById.get(currentId)
    if (!entry) break // parentId 指向不存在的 entry（跨文件 parent 或数据损坏）
    if (entry.type === 'session') {
      // 到达 root header，不加入 keepIds（header 会单独重建）
      break
    }
    keepIds.add(currentId)
    currentId = entry.parentId ?? undefined
    visited++
  }

  if (keepIds.size === 0) {
    throw new Error(`fork: forkEntryId "${forkEntryId}" not found in session tree: ${sourceFilePath}`)
  }
  return keepIds
}

/**
 * 生成新 session id + 文件路径（阶段 5）。now 同时供 header timestamp 用，单次取值。
 *
 * 产物落 `<targetDir>/<encodeCwd(cwd)>/` 子目录（方案 B 布局对齐 pi：pi 默认布局按
 * cwd 分子目录且原生 listAll 只枚举子目录，写平铺根的 fork session 会从 TUI /
 * `/session-pick` 消失；写入形态与 import-service 对齐）。cwd 取源 header 的原始 cwd。
 */
function buildForkTarget(targetDir: string, cwd: string): { newSessionId: string; now: Date; newFilePath: string } {
  const newSessionId = randomUUID()
  const now = new Date()
  // pi 用 ISO 时间把 : 和 . 替换为 -，如 2026-07-07T03-23-49-092Z
  const isoTs = now.toISOString().replace(/[:.]/g, '-')
  const fileName = `${isoTs}_${newSessionId}.jsonl`
  const newFilePath = join(targetDir, encodeCwd(cwd), fileName)
  return { newSessionId, now, newFilePath }
}

/**
 * 解析新 header 的 parentSession 血缘键（阶段 6a）。
 *
 * parentSession 指向直接父级（源 session），不透传源的 parentSession（那是祖父）。
 * 多级 fork（A→B→C）：C 读 B 的文件，B.header.parentSession 是 A 的路径——但 C 的直接父级
 * 是 B，不能透传 A。故 parentSession 始终用源 session 的文件路径（sourceFilePath），
 * 它指向直接父级文件，与 forkEntryId（指向 B 内 entry）坐标系一致。
 * 源 session 可能尚未落盘（pi 延迟写入，上层 sessionFilePath=undefined），此时
 * sourceFilePath 是上层临时拷贝/不可靠路径，改用 fallbackParentId（源 sessionId）作血缘键，
 * 保证父子链可追溯（FR-20）。
 */
function resolveParentSession(sourceFilePath: string, fallbackParentId?: string): string {
  return fallbackParentId ?? sourceFilePath
}

/**
 * 构建新 session header（阶段 6b，存在性判断时序保持：existsSync(cwd) 发生在 writeFile 之前
 * 的内容构建期，且是唯一的存在性判断——不新增对产物文件的任何 fs 探测）。
 *
 * 新 session header（parentSession 指回源文件/源 sessionId，形成父子链）
 * W1（restore-fork-attach-fix F1/MF2）：cwd 做存活兜底——newHeader 原样 spread 会继承
 * 源文件的死路径 cwd（如 worktree 清理后的源会话），fork 产物直附着时 pi 必 throw
 * MissingSessionCwdError（pi-mono session-cwd.ts；RPC switch_session 无 cwdOverride
 * 字段）。fork 文件是创建型新文件（登记表 §4 ⑥），生成 header 时兜底 = 写自己的产物，
 * 无合规问题，且是最早、最便宜的拦截点。
 */
function buildForkedHeader(
  header: SessionHeaderEntry,
  newSessionId: string,
  now: Date,
  resolvedParentSession: string,
  forkEntryIdField?: string,
): SessionHeaderEntry {
  const headerCwd = existsSync(header.cwd) ? header.cwd : homedir()
  const newHeader: SessionHeaderEntry = {
    ...header,
    id: newSessionId,
    timestamp: now.toISOString(),
    cwd: headerCwd,
    parentSession: resolvedParentSession,
    ...(forkEntryIdField !== undefined ? { forkEntryId: forkEntryIdField } : {}),
  }
  return newHeader
}

/** 序列化产物内容（阶段 7）：header 先行，随后按原始顺序写入保留的 entry（保持 entry 到达顺序，pi 重建树依赖顺序）。 */
function renderForkedLines(newHeader: SessionHeaderEntry, allEntries: PiEntry[], keepIds: Set<string>): string[] {
  const lines: string[] = []
  // 保留源 header 的额外字段（如 label），但强制覆盖 id/timestamp/parentSession/forkEntryId
  lines.push(JSON.stringify(newHeader))
  for (const e of allEntries) {
    if (typeof e.id === 'string' && keepIds.has(e.id)) {
      lines.push(JSON.stringify(e))
    }
  }
  return lines
}

export async function createForkedSessionFile(
  sourceFilePath: string,
  forkEntryId: string,
  includeFrom: boolean,
  targetDir: string,
  forkEntryIdField?: string,
  fallbackParentId?: string,
): Promise<ForkedFile> {
  // 1. 读源文件（ENOENT → 带路径错误）
  const allEntries = await readSourceEntries(sourceFilePath)

  // 2. 找 session header（root），提取 cwd
  const header = requireSessionHeader(allEntries, sourceFilePath)

  // 3. 建 id → entry 索引（只索引有 id 的 entry）
  const entryById = buildEntryIndex(allEntries)

  // 4. 从 forkEntryId 沿 parentId 回溯到 root，收集路径上的 entryId 集合
  const keepIds = collectKeptEntryIds(entryById, forkEntryId, sourceFilePath, allEntries.length)

  // includeFrom=false：剔除 forkEntry 自身
  if (!includeFrom) {
    keepIds.delete(forkEntryId)
  }

  // 5. 生成新 session id + 文件名（产物写入源 header cwd 对应的 encodeCwd 子目录）
  const { newSessionId, now, newFilePath } = buildForkTarget(targetDir, header.cwd)

  // 6. 构建新文件内容（header 血缘 + cwd 存活兜底）
  const resolvedParentSession = resolveParentSession(sourceFilePath, fallbackParentId)
  const newHeader = buildForkedHeader(header, newSessionId, now, resolvedParentSession, forkEntryIdField)
  const lines = renderForkedLines(newHeader, allEntries, keepIds)

  // encodeCwd 子目录可能尚不存在（首个该 cwd 的 fork 产物）——recursive 创建
  //（与 import-service 写入先例一致；pi 不预建未来 cwd 的目录）
  await mkdir(dirname(newFilePath), { recursive: true })
  await writeFile(newFilePath, lines.join('\n') + '\n', 'utf-8')

  return { filePath: newFilePath, sessionId: newSessionId, sourceFilePath }
}

/**
 * fork 点 entryId 按 timestamp 匹配时的容差（W7）。
 *
 * 来源：前端 messageTimestamp 是 Unix ms（Date.now()），JSONL 中 pi 写入的 timestamp 是
 * ISO 字符串（new Date(...).getTime() 还原回 ms）。两者本应完全相等，但：
 *   - 早期实现/历史 session 的 timestamp 精度可能到秒（无毫秒位）；
 *   - 时钟在不同阶段读到的瞬时值可能差几毫秒；
 *   - 序列化舍入（JSONL 写入时 Date.toISOString 的毫秒舍入）。
 * 旧值 2ms 在历史 session（秒级精度）下会全部漏匹配 → fallback 到最后一条 entry，
 * 导致 fork 点错位（用户期望 fork 到第 N 条消息，实际 fork 到最后一条）。
 * 1000ms 容差让「同一秒内」的 entry 视为同一条——fork 点按 timestamp + role 唯一性已足够区分，
 * 同秒内两条相同 role 的 entry 概率极低，且 fallback warn 仍会触发（兜底可见）。
 */
const TIMESTAMP_TOLERANCE_MS = 1000

/**
 * RPC 路径加载的 session 无 piEntryId，读 JSONL 按 timestamp + role 匹配 entryId（S6 迁入，
 * 原实现经 Facade → lifecycle 中转后落位 fork 域模块）。
 * [HISTORICAL] 2026-07-16：历史 session 通过 RPC 加载后 fork 报“缺少 piEntryId”。
 *
 * wave:perf-w26（微项 12）：source 由调用方（forkSession）单次扫描解析后传入，
 * 本函数不自扫（同 handler 的 scanSessions 合并为一次）。
 */
export async function resolveEntryIdByTimestamp(
  sourceFilePath: string,
  messageTimestamp?: number,
  messageRole?: string,
): Promise<string> {
  // AGENTS.md 规则 #6：所有读取 session 文件必须处理「不存在」（scan 与读间竞态——
  // 文件可能已被外部删除：pi 异常退出未 flush / 用户手动清理）。模式对齐 getHistoryFromFilePath。
  let content: string
  try {
    content = await readFile(sourceFilePath, 'utf-8')
  } catch (e) {
    if (isEnoent(e)) {
      console.warn(`[session-service] resolveEntryIdByTimestamp: session file missing: ${sourceFilePath}`)
      throw new Error(`fork: source session file missing for resolve: ${sourceFilePath}`)
    }
    throw e
  }
  const entries = parseJsonl(content) as Array<Record<string, unknown>>
  // 只看 message 类型 entry（有 entry.id 和 entry.message.timestamp）
  const msgEntries = entries.filter((e) =>
    e.type === 'message'
    && typeof e.id === 'string'
    && e.message && typeof e.message === 'object'
  )
  if (msgEntries.length === 0) {
    throw new Error(`fork: source session has no message entries: ${sourceFilePath}`)
  }
  // 按 timestamp + role 匹配（JSONL timestamp 是 ISO 字符串，前端是 Unix ms）
  // ±TIMESTAMP_TOLERANCE_MS（模块顶层常量，W7）容差：历史 session 可能秒级精度，1000ms 容差兜底
  if (messageTimestamp != null) {
    // 容差内取 |diff| 最小者（r1-S3）：取首个命中会在「容差内多条同 role entry」时选错
    // fork 点（timestamp 越接近目标消息越可能是用户所指的那条）
    let best: { id: string; diff: number } | null = null
    for (const e of msgEntries) {
      const msg = e.message as Record<string, unknown>
      const entryTs = typeof msg.timestamp === 'string'
        ? new Date(msg.timestamp).getTime()
        : typeof e.timestamp === 'string'
          ? new Date(e.timestamp).getTime()
          : 0
      const roleMatch = !messageRole || msg.role === messageRole
      if (!roleMatch) continue
      const diff = Math.abs(entryTs - messageTimestamp)
      if (diff <= TIMESTAMP_TOLERANCE_MS && (best === null || diff < best.diff)) {
        best = { id: e.id as string, diff }
      }
    }
    if (best) return best.id
  }
  // fallback：取最后一条 message entry（用户最可能 fork 到最近的消息）
  const last = msgEntries[msgEntries.length - 1]
  if (!last) throw new Error('msgEntries unexpectedly empty after length check')
  console.warn(`[session-service] resolveEntryIdByTimestamp: no timestamp match, falling back to last entry: ${last.id}`)
  return last.id as string
}
