/**
 * history 域完整模块（S6 迁出，缓存 + 读编排同居）：HistoryRebuildCache（纯缓存类，
 * wave:perf-w20 D6）+ SessionHistoryReader（读编排：getHistory 三分支重建 + [u6] 游标
 * 翻页，原 Facade 方法逐字随迁；[u6] getFullHistory 文件直读已随全量通路退役）。
 *
 * 设计依据：.xyz-harness/2026-08-15-perf/04-history-incremental.md §3.3 D6-1/D6-3。
 *
 * 为什么缓存做在 runtime 而非 renderer：getHistory 只在「无基底路径」被调
 * （首次进入 / LRU 驱逐后重进 / renderer 重载——renderer 消息数组已空），
 * renderer 无 append 入口可用；runtime 是唯一持有「上次重建结果」的层。
 *
 * 生命周期（D6-1）：
 * - 写入：getHistory 每次成功重建后（全量与增量路径都写；B8 起单条目字节帽 32MB，
 *   超限不入缓存——「缓存从未存在」退化，见 HistoryRebuildCache 类注释）
 * - 读取：getHistory 命中时走 getEntries(since=lastLeafId) 增量（空增量 = 缓存新鲜）
 * - 清除：SessionHistoryReader.onSessionDisposed（Facade removeSessionEntry 第 ⑤ 步直调，
 *   与 traceSync/projection/records 并列；session 删除 + pi 进程退出两条路汇聚点）
 *   + 容量帽 LRU 驱逐 + reclaim 驱逐（B8：onSessionReclaimed，reclaimManagedSession 经
 *   ReclaimSessionDeps 注入调用——驱逐后重激活走单次全量重建，显式登记代价）
 * - 无持久化：重开 app 后 runtime 内存已空，必然全量重建（纯派生数据，丢弃无一致性风险）
 *
 * pi get_entries(since) 行为（2026-08-16 实测，pi 0.84.0，脚本 /tmp/verify-pi-since.mjs 已验证后删除）：
 * - leafId 随 append 前进；空增量（since=当前 leafId）返回 success + entries:[]
 * - since 指向不存在的 entry → error "Entry not found: <id>"（E 大写 not 小写）
 * - compact 是 append-only（compaction entry append，旧 entry 不删除）→ since 不会因 compact 失效
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Message, SegmentsMetadataFile } from '@xyz-agent/shared'
import { HISTORY_BUDGET } from '@xyz-agent/shared'
// paths.ts 是 Node-only 模块，刻意不从 shared barrel 导出（见 shared/src/index.ts L32 注释），
// Node 端从子路径 import
import { getAttachmentsDir } from '@xyz-agent/shared/paths'
import type { IProcessManager } from '../ports/pi-engine.js'
import type { ISessionStore } from '../ports/session.js'
import { getHistoryTailFromFile, type HistoryWindowQuery, type HistoryWindowResult } from '../session-history.js'
import { applyOrphanToolResults } from '../../infra/pi/message-converter.js'
import { isEntryNotFoundError } from './trace-sync.js'
import { toErrorMessage } from '../../utils/errors.js'

/**
 * get_entries RPC 响应的域内收窄（u-s4 EntriesSinceResult 同款先例）：entries 只消费
 * parentId（增量首条的不变量检测）+ 整体透传 rebuildHistoryFromEntries（unknown[] 形参），
 * 不依赖 pi 原始 entry 全形状。
 */
type GetEntriesResult = { data?: { entries?: Array<{ parentId?: string | null }>; leafId?: string | null } }

/** 单个 session 的重建缓存条目。 */
export interface HistoryRebuildCacheEntry {
  /** 上次重建时 get_entries 响应的 leafId（增量拉取的 since 基准）。 */
  leafId: string | null
  /** 上次重建的全量消息（增量合并的基底）。 */
  messages: Message[]
  /** 上次重建的 truncated 标志（entry 树重建恒 false，保留字段对齐 getHistory 返回形状）。 */
  truncated: boolean
}

/**
 * 容量帽 = 最近 8 个 session（对齐 renderer LRU_MAX_SESSIONS）。
 * 只有可能被驱逐重进的 session 才值得缓存，超出 renderer LRU 窗口的缓存无消费者。
 */
const HISTORY_CACHE_MAX_SESSIONS = 8

/**
 * 单条目字节帽 = 32MB（B8，memory-leak-remediation §3.3-B8 候选 A）。语义对齐
 * READ_PRECHECK_MAX_BYTES（shared SSOT，同为 32MB）——超过该量级的 session 本就走
 * 离线分块路径，不值得整份驻留缓存；超限条目不入缓存（「缓存从未存在」退化：下次
 * getHistory 全量重建，行为等价于从未命中缓存）。量级口径 = 全量 Message[] 逐条
 * Buffer.byteLength(JSON.stringify(m)) 求和（estimateMessagesBytes，与
 * applyHistoryBudgetWindow 的预算字节同源）。
 */
// eslint-disable-next-line no-magic-numbers -- 设计标定阈值（对齐 READ_PRECHECK_MAX_BYTES），校准依据见上方 JSDoc
const HISTORY_CACHE_MAX_ENTRY_BYTES = 32 * 1024 * 1024

/**
 * 估算全量 Message[] 的序列化字节（B8 字节帽量级口径）：逐条求和（与
 * selectTurnWindowStart 的预算字节同源——近 wire reply 实际体积，images base64
 * 等大字段如实计入）。分条求和而非整串 JSON.stringify：避免单次巨串分配，且与既有
 * 预算窗口代码逐条口径一致。
 */
function estimateMessagesBytes(messages: Message[]): number {
  let bytes = 0
  for (const m of messages) {
    bytes += Buffer.byteLength(JSON.stringify(m), 'utf-8')
  }
  return bytes
}

/**
 * per-session 重建缓存（LRU，Map 插入序实现）。
 *
 * LRU 语义：get/set 命中时把 key 移到 Map 尾部（delete + set），超帽驱逐 Map 头部
 * （最久未访问）。与 renderer chat store 的 LRU 窗口对齐——被 renderer 驱逐的 session
 * 下次重进走全量重建，等价于「缓存从未存在」，行为退化为现状。
 *
 * 字节帽（B8，memory-leak-remediation §3.3-B8 候选 A）：条目写入前量全量 Message[]
 * 序列化字节，超 32MB 不入缓存。缓存基线**始终存全量重建结果**（增量合并正确性依赖
 * ——被否候选 B「缓存也切预算窗」的否决理由：增量基线错位 = 会话内容错乱），故字节
 * 维度只能整条目取舍，不做窗口化。
 */
export class HistoryRebuildCache {
  private readonly entries = new Map<string, HistoryRebuildCacheEntry>()

  constructor(
    private readonly maxSessions = HISTORY_CACHE_MAX_SESSIONS,
    /** 单条目字节帽（B8；构造参数注入便于测试，对齐 B7 ring 预算注入范式）。 */
    private readonly maxEntryBytes = HISTORY_CACHE_MAX_ENTRY_BYTES,
  ) {}

  /** 取缓存并刷新 LRU 位置。无缓存返回 undefined。 */
  get(sessionId: string): HistoryRebuildCacheEntry | undefined {
    const entry = this.entries.get(sessionId)
    if (entry === undefined) return undefined
    // LRU touch：移到 Map 尾部（最近使用）
    this.entries.delete(sessionId)
    this.entries.set(sessionId, entry)
    return entry
  }

  /**
   * 写入/覆盖缓存条目。两道帽：
   * 1. 单条目字节帽（B8-A）——set 前量全量 Message[] 序列化字节，超 maxEntryBytes
   *    不入缓存并摘除既有条目（「缓存从未存在」退化：该 session 每次 getHistory 全量
   *    重建）。摘除旧条目防「冻结基线」——历史 append-only 只增不减，保留旧条目会让
   *    增量 delta 从旧叶子无界增长，退化不如全量重建。
   * 2. 容量帽 LRU——超 maxSessions 驱逐最久未访问的 session 条目（原有行为）。
   */
  set(sessionId: string, entry: HistoryRebuildCacheEntry): void {
    const bytes = estimateMessagesBytes(entry.messages)
    if (bytes > this.maxEntryBytes) {
      console.warn(
        `[history-rebuild-cache] entry exceeds byte cap, skipping cache (sessionId=${sessionId}: ${bytes} > ${this.maxEntryBytes} bytes), session degrades to full rebuild per getHistory`,
      )
      this.entries.delete(sessionId)
      return
    }
    if (this.entries.has(sessionId)) this.entries.delete(sessionId)
    this.entries.set(sessionId, entry)
    while (this.entries.size > this.maxSessions) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  /** 删除单个 session 的缓存（session 删除 / pi 进程退出清理点）。 */
  delete(sessionId: string): void {
    this.entries.delete(sessionId)
  }

  /**
   * 清空全部条目，返回清除条目数（u7c：memory-relief 可回收物 ①——crash-forensics
   * D4 降级代价清单：清后该 session 下次 getHistory 走全量重建（纯派生数据，丢弃
   * 无一致性风险，见文件头生命周期注释）；watchdog onRelief 接线在组合根 index.ts）。
   */
  clearAll(): number {
    const cleared = this.entries.size
    this.entries.clear()
    return cleared
  }

  /** 当前缓存条目数（测试用）。 */
  get size(): number {
    return this.entries.size
  }
}

/**
 * 增量合并（D6-3）：缓存消息 + 增量消息按 piEntryId 去重合并。
 *
 * - 增量消息的 piEntryId 已在缓存中 → 跳过（不重复；pi 端 slice 已排除 since entry 本身，
 *   正常时序无重复，此去重是 compact/异常时序的防御性兜底）
 * - 新 piEntryId → 追加到尾部
 * - 无 piEntryId 的消息（理论上重建路径全带——entry-tree-builder 全路径传 entryIds；
 *   防御）→ 顺序追加 + debug 日志，保证消息不丢
 *
 * 去重身份是 piEntryId 而非 Message.id：重建消息的 id 由 core applyEntry reducer 从
 * entry 确定性派生（entry.id（真实 uuidv7）缺失时按喂入下标 `e<N>`，W20 起），跨两次
 * 重建无 entry id 的消息仍不保证稳定——按 Message.id 去重恒失效。renderer
 * prependHistoryMut（mutations.ts）是同语义的现成范式，此处是 runtime 侧复用。
 *
 * @returns 新数组（不修改入参），供直接写入缓存与返回
 */
export function mergeIncrementalMessages(cached: Message[], incremental: Message[]): Message[] {
  const seen = new Set<string>()
  for (const m of cached) {
    if (m.piEntryId !== undefined) seen.add(m.piEntryId)
  }
  const merged = [...cached]
  for (const m of incremental) {
    if (m.piEntryId === undefined) {
      // 防御：重建路径理论上全带 piEntryId。无 id 时宁可重复不可丢消息（append + 可见日志）。
      console.debug('[history-rebuild-cache] incremental message without piEntryId, appending defensively')
      merged.push(m)
      continue
    }
    if (seen.has(m.piEntryId)) continue
    seen.add(m.piEntryId)
    merged.push(m)
  }
  return merged
}

/**
 * turn 边界索引（正序）：role==='user' 是 turn 起点（D11 语义在重建后 Message[] 上的等价物）。
 */
function collectTurnStarts(messages: Message[]): number[] {
  const turnStarts: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') turnStarts.push(i)
  }
  return turnStarts
}

/**
 * 从新到旧选 turn 入窗（applyHistoryBudgetWindow 的窗口选择段）：首个 turn 豁免字节
 * 条件（单 turn 超预算完整放行，D4）；窗口扩到最老 turn 时带上其前的前导段（病态
 * 孤儿 entry，如增量合并边界的孤儿 toolResult）——多给不少给，避免预算内误报
 * truncated / 丢配对。
 *
 * @returns startIdx = 窗口起点下标（>0 即窗口外有更早历史）；accBytes = 入窗字节合计
 *（可能超 maxBytes——单 turn 豁免所致，由调用方 warn 如实暴露）
 */
function selectTurnWindowStart(
  messages: Message[],
  turnStarts: number[],
  limitTurns: number,
  maxBytes: number,
): { startIdx: number; loadedTurns: number; accBytes: number } {
  const total = messages.length
  let accBytes = 0
  let loadedTurns = 0
  let startIdx = total
  for (let t = turnStarts.length - 1; t >= 0; t--) {
    if (loadedTurns >= limitTurns) break
    const turnStart = turnStarts[t]
    const turnEnd = t + 1 < turnStarts.length ? turnStarts[t + 1] : total
    let turnBytes = 0
    for (let i = turnStart; i < turnEnd; i++) {
      turnBytes += Buffer.byteLength(JSON.stringify(messages[i]), 'utf-8')
    }
    if (loadedTurns > 0 && accBytes + turnBytes > maxBytes) break
    accBytes += turnBytes
    loadedTurns++
    startIdx = t === 0 ? 0 : turnStart
  }
  return { startIdx, loadedTurns, accBytes }
}

/**
 * session 历史加载双预算窗口（crash-resilience §3.3 D4 / 实施计划 u4b-history-budget）。
 *
 * 按双条件从**最新** turn 向前截取：最近 limitTurns（默认 HISTORY_BUDGET.RECENT_TURNS=20）
 * turns 且总字节 ≤ maxBytes（默认 HISTORY_BUDGET.MAX_BYTES=640KB）。字节估算 = 逐条
 * Buffer.byteLength(JSON.stringify(message))（近 wire reply 实际体积，images base64
 * 等大字段如实计入）。切分点在重建后的 Message[] 上做，不依赖 pi 行为。
 *
 * 切分粒度（D4 契约）：
 * - **预算作用于 turn 选择**：窗口起点恒落在 turn 边界（role==='user' 的消息）上；
 * - **单 turn 内 entry 不切分**（entry 原子性——切 entry 会破坏 reducer 幂等与
 *   parentId 链）：窗口内消息按整 turn 进出；
 * - **最近一个 turn 自身超预算仍完整放行**（保证对话可见性连续），字节超出经
 *   warn 日志如实暴露（响应本身无字节字段；极端 turn 由 D3 帧守卫与 U7 截断兜底）。
 *
 * truncated 判定 = 窗口起点之前仍有消息（有更早历史未返回）。预算内（全部 turn
 * 入窗且字节未超）→ truncated=false，行为与预算化前一致（A6 回归基线）。
 *
 * 缓存关系：缓存基线始终存**全量**重建结果（增量合并的正确性依赖），本函数只作用
 * 于返回值——三分支（空增量/增量合并/全量重建）统一在返回前调用。
 *
 * totalTurnsEstimate：入参 Message[] 上的精确 turn 总数（user 消息计数）。[u6] 游标翻页
 * 时入参是「锚点之前」的前缀，此值即前缀内精确总量（读到锚点为精确值）。
 *
 * [u6] opts（crash-resilience §3.3 D4 中期分页协议）：session.history 请求的
 * limitTurns/maxBytes 覆盖默认预算；缺省回落 shared HISTORY_BUDGET（u4b 现状不变）。
 * cursor 切前缀不在此函数（sliceMessagesBeforeCursor），两路径先切前缀再进本函数。
 */
export function applyHistoryBudgetWindow(
  messages: Message[],
  opts?: { limitTurns?: number; maxBytes?: number },
): HistoryWindowResult {
  const total = messages.length
  if (total === 0) return { messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 }

  const limitTurns = opts?.limitTurns ?? HISTORY_BUDGET.RECENT_TURNS
  const maxBytes = opts?.maxBytes ?? HISTORY_BUDGET.MAX_BYTES

  const turnStarts = collectTurnStarts(messages)
  // 病态兜底：无 user 消息（纯 custom/compaction 窗口）→ 整段视为一个 turn 完整放行
  //（单 turn 豁免语义同款：切它必然破坏原子性）
  if (turnStarts.length === 0) {
    return { messages: messages.slice(), truncated: false, loadedTurns: 1, totalTurnsEstimate: 1 }
  }

  const { startIdx, loadedTurns, accBytes } = selectTurnWindowStart(messages, turnStarts, limitTurns, maxBytes)
  if (accBytes > maxBytes) {
    console.warn(
      `[history-rebuild-cache] history budget exceeded by the most recent turn(s): ${accBytes} bytes > ${maxBytes}, released in full per entry atomicity`,
    )
  }
  return {
    messages: messages.slice(startIdx),
    truncated: startIdx > 0,
    loadedTurns,
    totalTurnsEstimate: turnStarts.length,
  }
}

/**
 * [u6] 游标切前缀（crash-resilience §3.3 D4 中期分页协议）：返回 turn 边界锚点 entryId
 * 所在 turn **之前**的全部消息（前缀），供 applyHistoryBudgetWindow 取「锚点之前最近 N turns」。
 *
 * 身份匹配 `piEntryId ?? id`（与 renderer 侧 cursor 取值、splitHistoryBeforeAnchor 的
 * exact 判据同构——user/assistant 带 piEntryId；system 族 id 即 entry 派生 uuidv7）。
 * 前缀终点 = cursor 消息所在 turn 的起点（cursor 落在 turn 中间时该 turn 不返回——
 * renderer 传的 cursor 恒为窗口起点，天然对齐 turn 边界；中间形态是防御语义）。
 *
 * @returns null = cursor 未命中任何消息（已被清理 / 超出扫描域）——调用方按「翻页到头」
 * 返回空页 + truncated=false（D4 空游标边界：不报错）。
 */
export function sliceMessagesBeforeCursor(messages: Message[], cursor: string): Message[] | null {
  const identity = (m: Message): string => m.piEntryId ?? m.id
  const cursorIdx = messages.findIndex((m) => identity(m) === cursor)
  if (cursorIdx < 0) return null
  // cursor 所在 turn 起点：≤ cursorIdx 的最近 user 边界；cursor 之前无 user 边界
  //（cursor 在前导孤儿段内）→ turnStart 保持 0，前缀为空（无更早 turn 可返回）
  let turnStart = 0
  for (let i = cursorIdx; i >= 0; i--) {
    if (messages[i].role === 'user') {
      turnStart = i
      break
    }
  }
  return messages.slice(0, turnStart)
}

/**
 * SessionHistoryReader 装配依赖（窄注入，S5/D2 风格；原 Facade 字段直读的逐字等价面）。
 */
export interface SessionHistoryReaderDeps {
  /** pi 进程管理（getClient：活跃 session 走 RPC 重建，无 client 走尾读降级）。 */
  pm: IProcessManager
  /** session 存储端口（rebuildHistoryFromEntries 重建 / 尾读与全量文件读的转换链）。 */
  sessionStore: ISessionStore
}

/**
 * session 历史读编排（S6 迁出，原 Facade 方法逐字随迁）：getHistory 三分支重建 +
 * [u6] 游标翻页（crash-resilience §3.3 D4 中期；getFullHistory 文件直读已随全量通路
 * 退役）。销毁清理经 onSessionDisposed 由 Facade removeSessionEntry 第 ⑤ 步直调
 * （与 traceSync/projection/records 并列）。
 */
export class SessionHistoryReader {
  /**
   * wave:perf-w20（D6）：per-session 历史重建缓存 + lastLeafId（LRU 容量帽 8）。
   * getHistory 命中缓存时走 getEntries(since=lastLeafId) 增量；onSessionDisposed
   * （session 删除 + pi 进程退出汇聚点）清除。纯派生数据，可随时丢弃退化为全量重建。
   */
  private readonly historyCache: HistoryRebuildCache
  /**
   * W20 review Fix-5：per-session getHistory inflight 复用。并发 getHistory 共享同一
   * promise（GitStateService inflightSnapshot 同款模式），消除「后完成者的旧 delta 与
   * 先完成者的新缓存交错写回」竞态。finally 清理，无泄漏。
   */
  private readonly inflightGetHistory = new Map<string, Promise<HistoryWindowResult>>()

  /**
   * @param historyCache 缓存实例注入（B8 测试缝：字节帽/容量帽可注入，对齐 B7 ring
   * 「预算构造参数注入」范式）；缺省默认帽（8 session / 32MB 单条目）。
   */
  constructor(private readonly deps: SessionHistoryReaderDeps, historyCache?: HistoryRebuildCache) {
    this.historyCache = historyCache ?? new HistoryRebuildCache()
  }

  /**
   * 拉取 session 历史（wave:perf-w20 D6：重建缓存 + lastLeafId 增量）。
   *
   * 优先走 pi get_entries RPC + entry 树重建（rebuildHistoryFromEntries）：从完整 entry 树
   * （含 message + custom entry）重建 Message[]，按 clientUuid ↔ userEntryId 映射回填
   * 结构化 Segment[]（image/file/skill badge，读 segments.json sidecar）。
   *
   * 三分支（04-history-incremental.md §3.3）：
   * 1. 缓存命中 → getEntries(since=lastLeafId) 增量。空增量 = leafId 未变 = 缓存新鲜，
   *    直接返回缓存（R-12 短路：不走尾读 fallback）。pi 侧成本 = findIndex + 空/小窗口序列化，
   *    全量 entry 树序列化（主要卡顿源）被消除。
   * 2. 增量非空 → parentId 不变量校验（W20 review Fix-2：delta 首条 entry.parentId 必须等于
   *    缓存 leafId，branch 后不成立 → 丢缓存全量重建，防静默混合历史）→ 重建增量窗口 +
   *    piEntryId 去重合并入缓存（D6-3）+ 孤儿 toolResult 回填（W20 review Fix-1：窗口以
   *    toolResult 开头时配对失败的输出按 toolCallId 回填到缓存 assistant 的 toolCall）。
   * 3. 无缓存（首次进入 / LRU 驱逐重进 / "Entry not found" fallback / parentId 不变量 violation）
   *    → 全量重建 + 写缓存。
   *
   * 并发（W20 review Fix-5）：per-session inflight 复用，同 session 并发调用共享同一 promise。
   *
   * 错误处理（D6-4）：
   * - 增量报 "Entry not found"（pi 实测文案，E 大写 not 小写）→ 丢缓存 → 全量重拉。
   *   触发面：缓存跨 pi 进程存活且 session 文件被外部改写（D6-1 的 removeSessionEntry
   *   清理已结构性消除常态触发，此为防御兜底）。
   * - 其他错误（超时/pi 内部错误）→ 与现状同链降级（尾读），缓存不动（下次重试仍走 since）。
   *
   * R-12：pi RPC 成功但 entries 为空 → 短路返回空列表。pi 的 get_entries 是活跃 session
   * 的权威视图（内存 fileEntries，restore 时从文件加载），空就是空；尾读会给出与 RPC
   * 视图不一致的文件尾部（最多 20 turn），两次 getHistory 结果闪变。
   *
   * 返回 HistoryWindowResult（u4b 起双预算窗口：truncated / loadedTurns /
   * totalTurnsEstimate）——缓存基线始终存全量重建结果，**预算窗口只作用于返回值**
   * （D4：最近 20 turns 且总字节 ≤ 640KB，单 turn 超预算完整放行，entry 原子性），
   * 三分支在返回前统一经 applyHistoryBudgetWindow 切窗。
   *
   * 返回值契约（终审 minor）：messages 是缓存/重建结果的**浅拷贝**（数组级隔离，调用方可
   * 安全就地变更）；Message 元素引用与缓存共享，仍受只读契约约束（深层拷贝在数百条消息
   * 量级下成本不可接受，元素级污染面仅限「调用方 mutate message 对象自身」）。
   *
   * [u6] 游标翻页（crash-resilience §3.3 D4 中期）：query.cursor（turn 边界锚点 entryId）
   * 存在时返回锚点之前的最近窗口——活跃/离线两路径共用同一参数语义：
   * - 活跃：跳过增量分支（增量是「最新窗口」语义），优先在缓存全量基线上切前缀
   *   （sliceMessagesBeforeCursor——锚前内容 append-only，缓存基线对锚前翻页恒新鲜）；
   *   无缓存走 getEntries() 全量重建写缓存后切前缀；RPC 失败降级文件读游标窗口。
   * - 离线：getHistoryTailFromFile 的 cursorId 定位（collectRecentTurnEntriesFromTail 扩展）。
   * - cursor 未命中任何消息（已被清理/超扫描域）→ 空页 + truncated=false（翻页到头，不报错）。
   * limitTurns/maxBytes 缺省回落 shared HISTORY_BUDGET（u4b 预算不变）。
   */
  async getHistory(sessionId: string, query?: HistoryWindowQuery): Promise<HistoryWindowResult> {
    // W20 review Fix-5：并发 getHistory 复用同一 inflight promise（同 session 共享一次
    // RPC + 重建 + 缓存写回），消除「后完成者的旧 delta 写回旧基线 / 覆盖先完成者结果」竞态。
    // [u6] inflight key 含 cursor（同 session 并发翻页不同游标不得共享同一 promise——
    // 不同请求页不同；无 cursor 请求共享现状行为）。
    const inflightKey = query?.cursor ? `${sessionId}::cursor:${query.cursor}` : sessionId
    const inflight = this.inflightGetHistory.get(inflightKey)
    if (inflight) return inflight
    const promise = this.doGetHistory(sessionId, query).finally(() => this.inflightGetHistory.delete(inflightKey))
    this.inflightGetHistory.set(inflightKey, promise)
    return promise
  }

  private async doGetHistory(sessionId: string, query?: HistoryWindowQuery): Promise<HistoryWindowResult> {
    const client = this.deps.pm.getClient(sessionId)
    if (query?.cursor !== undefined) {
      // ── [u6] 游标翻页（活跃路径）：缓存全量基线优先，无缓存走全量重建 ──
      return await this.getCursorWindow(sessionId, query, client)
    }
    if (client) {
      return await this.getLatestWindow(sessionId, query, client)
    }
    // 无 RPC client（离线 session）：走尾读（分块扩窗预算窗口，D5②），
    // 避免大文件全量读（不读不写缓存——文件路径无 leafId 概念）。
    return await this.tailReadOffline(sessionId, query)
  }

  /**
   * [u6] 游标翻页分支（doGetHistory 活跃路径）：缓存全量基线优先切前缀（锚前内容
   * append-only，缓存基线对锚前翻页恒新鲜，零 RPC）；无缓存走全量重建写缓存；
   * 离线 session 走文件读游标窗口（与离线尾读同链，cursorId 定位）。
   */
  private async getCursorWindow(
    sessionId: string,
    query: HistoryWindowQuery,
    client: ReturnType<IProcessManager['getClient']>,
  ): Promise<HistoryWindowResult> {
    const emptyPage: HistoryWindowResult = { messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 }
    const windowOpts = { limitTurns: query.limitTurns, maxBytes: query.maxBytes }
    // cursor 非空由 doGetHistory 分派保证（交叉断言与原实现一致）
    const cursorPrefix = (full: Message[]): HistoryWindowResult => {
      const prefix = sliceMessagesBeforeCursor(full, query.cursor!)
      // cursor 未命中（已被清理 / 文件改写）→ 空页（翻页到头语义，不报错）
      if (prefix === null) return emptyPage
      return applyHistoryBudgetWindow(prefix, windowOpts)
    }
    const cached = this.historyCache.get(sessionId)
    if (cached) {
      // 缓存基线存全量重建结果，且锚前内容 append-only（pi append-only，compaction 不删
      // entry）——锚前翻页对基线新鲜度不敏感，直接切前缀，零 RPC。
      return cursorPrefix(cached.messages)
    }
    if (!client) {
      // 离线 session 游标翻页：文件读游标窗口（与离线尾读同链，cursorId 定位）
      return await this.tailReadOffline(sessionId, query)
    }
    try {
      const messages = await this.rebuildFullHistoryAndCache(sessionId, client)
      // entries 空（R-12 同款空语义）：RPC 是活跃 session 权威空视图 → 空页，不走文件读
      if (messages === null) return emptyPage
      return cursorPrefix(messages)
    } catch (e) {
      console.warn(`[session-service] cursor getHistory via getEntries failed: ${toErrorMessage(e)}, falling back to file cursor read`)
      return await this.tailReadOffline(sessionId, query)
    }
  }

  /**
   * 最新窗口分支（doGetHistory 分支 1/2/3）：缓存命中走 getEntries(since=leafId) 增量
   *（增量丢失缓存时 fall-through 全量重建）；无缓存 / fallback 走全量重建写缓存后
   * 按双预算切窗返回。
   */
  private async getLatestWindow(
    sessionId: string,
    query: HistoryWindowQuery | undefined,
    client: NonNullable<ReturnType<IProcessManager['getClient']>>,
  ): Promise<HistoryWindowResult> {
    const windowOpts = { limitTurns: query?.limitTurns, maxBytes: query?.maxBytes }
    // ── 分支 1/2：缓存命中 → since 增量 ──
    const cached = this.historyCache.get(sessionId)
    if (cached && cached.leafId !== null) {
      const incremental = await this.getIncrementalHistory(sessionId, client, cached, windowOpts)
      if (incremental) return incremental
    }
    // ── 分支 3：全量重建（无缓存 / D6-4 fallback / Fix-2 parentId 不变量 violation 丢缓存后）──
    try {
      const messages = await this.rebuildFullHistoryAndCache(sessionId, client)
      // R-12：entries 空 → 短路返回空列表（pi RPC 是活跃 session 的权威视图，不走尾读）。
      if (messages === null) return { messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 }
      // entry 树重建返回全量历史（get_entries 不截断），窗口截断在重建后的 Message[] 上做
      return applyHistoryBudgetWindow(messages, windowOpts)
    } catch (e) {
      console.warn(`[session-service] getHistory via getEntries failed: ${toErrorMessage(e)}, falling back to tail read`)
      // 字节预算缺省与游标分支同源（D4 同一预算逻辑）：原样透传 query 时 maxBytes=
      // undefined → 尾读仅按 turn 数截取，20 个大 turn 的 reply 超 32MB 被
      // payload_too_large 拒绝且 truncated 未置位（「加载更早」入口不存在）——历史打不开。
      return await this.tailReadOffline(sessionId, query)
    }
  }

  /**
   * get_entries 全量拉取 → entry 树重建 → 写缓存（游标翻页无缓存路径与分支 3 的共用
   * 核心）。读 segments.json sidecar 的注释见 readSegmentsMetadataFile。
   *
   * @returns 重建的全量消息；null = pi RPC 成功但 entries 为空（R-12：活跃 session 的
   * 权威空视图）。RPC/重建失败原样上抛，由调用方按各自链路降级（日志文案与离线
   * fallback 的游标形态两分支不同，不在此吞）。
   */
  private async rebuildFullHistoryAndCache(
    sessionId: string,
    client: NonNullable<ReturnType<IProcessManager['getClient']>>,
  ): Promise<Message[] | null> {
    const result = await client.getEntries() as GetEntriesResult
    const entries = result.data?.entries ?? []
    if (entries.length === 0) return null
    // 读 segments.json sidecar（runtime 直接读文件，不经 IPC——IPC 是 renderer→main，runtime 是独立进程）。
    // 文件缺失/损坏 → null（rebuildHistoryFromEntries 全降级为占位文本，非硬错误）。
    const segmentsMetadata = await readSegmentsMetadataFile(sessionId)
    const rebuilt = this.deps.sessionStore.rebuildHistoryFromEntries(entries, segmentsMetadata)
    // leafId 是 session 当前叶子 entry id，记录为下次增量拉取的 since 基准（D6-1）。
    // 缓存存全量基线（增量合并正确性依赖）；返回值按双预算切窗（D4）。
    this.historyCache.set(sessionId, { leafId: result.data?.leafId ?? null, messages: rebuilt.messages, truncated: false })
    return rebuilt.messages
  }

  /**
   * 离线尾读 fallback（getHistoryTailFromFile 包装，D5② 分块扩窗预算窗口）：字节预算
   * 缺省同源 HISTORY_BUDGET.MAX_BYTES（D4 同一预算逻辑——仅 turn 数截取挡不住 20 个
   * 大 turn 的超限 reply）；query.cursor 存在时随行透传（离线游标翻页走 cursorId 定位，
   * 缺省路径 cursor 恒 undefined，读侧 query?.cursor 与缺键等价）。
   */
  private async tailReadOffline(sessionId: string, query?: HistoryWindowQuery): Promise<HistoryWindowResult> {
    return await getHistoryTailFromFile(
      sessionId,
      this.deps.sessionStore,
      query?.limitTurns ?? HISTORY_BUDGET.RECENT_TURNS,
      { cursor: query?.cursor, maxBytes: query?.maxBytes ?? HISTORY_BUDGET.MAX_BYTES },
    )
  }

  /**
   * 增量路径（doGetHistory 分支 1/2）：缓存命中时 getEntries(since=leafId) 增量拉取。
   *
   * 返回 undefined = 缓存已丢（parentId 不变量 violation / "Entry not found" fallback），
   * 调用方 fall-through 全量重建；返回结果 = 增量命中或尾读降级。
   */
  private async getIncrementalHistory(
    sessionId: string,
    client: NonNullable<ReturnType<IProcessManager['getClient']>>,
    cached: HistoryRebuildCacheEntry,
    windowOpts?: { limitTurns?: number; maxBytes?: number },
  ): Promise<HistoryWindowResult | undefined> {
    // leafId null 收敛（r1-S18）：调用方已保证非 null，此处守卫消 as 断言——防御性
    // undefined 使外层 fall-through 全量重建，行为等价
    if (cached.leafId === null) return undefined
    try {
      const inc = await client.getEntries(cached.leafId) as GetEntriesResult
      const incEntries = inc.data?.entries ?? []
      if (incEntries.length === 0) {
        // R-12 短路：空增量 = leafId 未变 = 缓存新鲜。零重建直接返回（不走尾读 fallback）。
        console.log(`[session-service] getHistory cache fresh (empty delta) for ${sessionId}, returning ${cached.messages.length} cached messages`)
        // 终审 minor：返回浅拷贝而非缓存引用——调用方就地 sort/splice/push 会打穿缓存
        // 基底（增量合并的正确性依赖缓存未被污染）。元素级引用仍共享（只读契约，
        // 与 scanPiSessions 浅拷贝注释同边界）。u4b：缓存全量基线上按双预算切窗返回。
        return applyHistoryBudgetWindow(cached.messages, windowOpts)
      }
      // W20 review Fix-2：parentId 不变量检测。pi append-only 下 delta 首条 entry 的
      // parentId 恒等于缓存基线 leafId（上次响应的叶子即本次增量的父）；branch
      // （pi rpc-mode 把 navigateTree 暴露给 extension command context）后新分支首条
      // parentId 是 branch 点，pi **不报错**但直接合并会静默产出「老分支尾 + 新分支」
      // 的混合历史（D6-4 的 "Entry not found" fallback 只覆盖 entry 消失场景）。
      // 不满足不变量 → 丢缓存 fall-through 全量重建（正确性优先，代价一次全量）。
      if (incEntries[0].parentId !== cached.leafId) {
        console.warn(
          `[session-service] getHistory incremental parent-id invariant violated for ${sessionId}: ` +
          `delta head parent=${String(incEntries[0].parentId)} != cached leafId=${cached.leafId} (branch/rewrite?), dropping cache and full rebuild`,
        )
        this.historyCache.delete(sessionId)
        return undefined
      }
      const segmentsMetadata = await readSegmentsMetadataFile(sessionId)
      const rebuilt = this.deps.sessionStore.rebuildHistoryFromEntries(incEntries, segmentsMetadata)
      const merged = mergeIncrementalMessages(cached.messages, rebuilt.messages)
      // W20 review Fix-1：增量窗口以 toolResult 开头（缓存 leafId 切在 assistant(toolCalls)
      // 与其 toolResults 之间——后台 session 生成中 getHistory 写缓存所致）时，convertPiHistory
      // 窗口局部配对失败的孤儿 toolResult 按 toolCallId 回填到缓存中 assistant 的 toolCall，
      // 工具输出不再静默丢失。
      if (rebuilt.orphanToolResults.length > 0) {
        applyOrphanToolResults(merged, rebuilt.orphanToolResults)
      }
      const newLeafId = inc.data?.leafId ?? null
      this.historyCache.set(sessionId, { leafId: newLeafId, messages: merged, truncated: false })
      console.log(`[session-service] getHistory incremental for ${sessionId}: ${incEntries.length} delta entries, merged ${cached.messages.length} -> ${merged.length} messages`)
      // merged 已写入缓存（全量基线），返回值按双预算切窗（D4，与缓存本体分离）
      return applyHistoryBudgetWindow(merged, windowOpts)
    } catch (e) {
      if (isEntryNotFoundError(e)) {
        // D6-4 fallback：since 失效（缓存基线不在 pi 当前 entry 集合）→ 丢缓存 → 全量重拉
        console.warn(`[session-service] getHistory incremental Entry-not-found for ${sessionId}, dropping cache and full rebuild`)
        this.historyCache.delete(sessionId)
        return undefined
      }
      // 其他错误：现有降级链（尾读），缓存不动（下次重试仍走 since）。
      // 字节预算缺省同源 HISTORY_BUDGET.MAX_BYTES（D4 同一预算逻辑，防 20 大 turn 超限 reply）。
      console.warn(`[session-service] getHistory via getEntries(since) failed: ${toErrorMessage(e)}, falling back to tail read`)
      return await this.tailReadOffline(sessionId, windowOpts)
    }
  }

  /**
   * [u6] getFullHistory 已退役（crash-resilience §3.3 D4 中期：「加载更早」改走
   * session.history 游标翻页，全量通路删除——游标翻页完全替代）。
   *
   * 销毁清理（Facade removeSessionEntry 第 ⑤ 步直调，与 traceSync/projection/records
   * 的 onSessionDisposed 并列）：清历史重建缓存 + lastLeafId——真删除后缓存必须清。
   * [HISTORICAL] 空闲回收曾刻意保留缓存（P7 真机实测 2026-09-11 回收→恢复 leafId
   * 命中空增量短路零重建，PASS incremental，证据：packages/runtime/src/__tests__/
   * services/idle-pi-reclaim-integration.test.ts 阶段 4）；B8
   *（memory-leak-remediation §3.3-B8 候选 C）起 reclaim 改经 onSessionReclaimed
   * 驱逐——回收态驻留 8×全量历史的内存收益 > 低频单次全量重建的 CPU 成本（代价
   * 四要素显式登记于设计 §3.3-B8「与 P7 实测的张力」）。
   */
  onSessionDisposed(sessionId: string): void {
    this.historyCache.delete(sessionId)
  }

  /**
   * B8（memory-leak-remediation §3.3-B8 候选 C）：空闲回收（reclaimManagedSession）时
   * 驱逐该 session 的缓存条目。回收不是销毁——**禁止**改调 removeSessionEntry 汇聚点
   *（会连带 bus 分区清理断流 / PTY 连杀 / 插件 didDestroy 投递，D3 三重冲突）；本
   * 方法只驱逐历史缓存（纯派生数据，丢弃无一致性风险）。驱逐后重激活走单次全量
   * 重建（P7「回收→恢复零重建」路径被显式放弃，代价四要素：量级 = 单次全量重建
   * 典型数百 ms~秒级；恢复路径 = 无需恢复（重建即路径）；重审条件 = 回收→重激活
   * 频率实测升高时重审「回收态保留缓存」策略；显式判定 = 接受）。装配：
   * reclaimManagedSession 经 ReclaimSessionDeps.evictHistoryRebuildCache（组合根绑
   * SessionService.evictHistoryRebuildCache → 本方法）。
   */
  onSessionReclaimed(sessionId: string): void {
    this.historyCache.delete(sessionId)
  }

  /**
   * 清空全部历史重建缓存（u7c：memory-relief 可回收物 ① 的 reader 出口——组合根
   * watchdog onRelief 接线经 SessionService 透传至此）。返回清除条目数（观测面）。
   */
  clearHistoryCache(): number {
    return this.historyCache.clearAll()
  }
}

/**
 * 读 segments.json sidecar（runtime 直接读文件，不经 IPC）。
 *
 * IPC 的 writeSegmentsMetadata / readSegmentsMetadata 是 renderer→main 通道，runtime 是独立 Node 进程
 * （不持 electron app 句柄），不能走 IPC。runtime 直接读 <dataDir>/attachments/<sessionId>/segments.json。
 *
 * 文件缺失/损坏（JSON parse 失败 / entries 非数组）→ 返回 null（rebuildHistoryFromEntries 据此
 * 全降级为占位文本，非硬错误）。异步读：与周围 getEntries RPC / readFile 一致，sidecar 是小文件
 * （每条 user message 一条 entry）但统一走异步避免事件循环阻塞。
 */
async function readSegmentsMetadataFile(sessionId: string): Promise<SegmentsMetadataFile | null> {
  try {
    const filePath = join(getAttachmentsDir(sessionId), 'segments.json')
    if (!existsSync(filePath)) return null
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as SegmentsMetadataFile
    if (!parsed || !Array.isArray(parsed.entries)) return null
    return parsed
  } catch {
    return null
  }
}
