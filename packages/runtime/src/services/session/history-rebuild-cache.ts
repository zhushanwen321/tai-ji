/**
 * history 域完整模块（S6 迁出，缓存 + 读编排同居）：HistoryRebuildCache（纯缓存类，
 * wave:perf-w20 D6）+ SessionHistoryReader（读编排：getHistory 三分支重建 + [u6] 游标
 * 翻页，原 Facade 方法逐字随迁；[u6] getFullHistory 文件直读已随全量通路退役）。
 *
 * 设计依据：.taiji-harness/2026-08-15-perf/04-history-incremental.md §3.3 D6-1/D6-3。
 *
 * 为什么缓存做在 runtime 而非 renderer：getHistory 只在「无基底路径」被调
 * （首次进入 / LRU 驱逐后重进 / renderer 重载——renderer 消息数组已空），
 * renderer 无 append 入口可用；runtime 是唯一持有「上次重建结果」的层。
 *
 * 生命周期（D6-1）：
 * - 写入：getHistory 每次成功重建后（全量与增量路径都写）
 * - 读取：getHistory 命中时走 getEntries(since=lastLeafId) 增量（空增量 = 缓存新鲜）
 * - 清除：SessionHistoryReader.onSessionDisposed（Facade removeSessionEntry 第 ⑤ 步直调，
 *   与 traceSync/projection/records 并列；session 删除 + pi 进程退出两条路汇聚点）
 *   + 容量帽 LRU 驱逐 + 撤回失效驱逐（onSessionReclaimed：消息撤回编排经
 *   SessionService.evictHistoryRebuildCache 调用——驱逐后下次重建走单次全量）
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
import type { Message, SegmentsMetadataFile, ServerMessage } from '@taiji/shared'
import { HISTORY_BUDGET } from '@taiji/shared'
// paths.ts 是 Node-only 模块，刻意不从 shared barrel 导出（见 shared/src/index.ts L32 注释），
// Node 端从子路径 import
import { getAttachmentsDir } from '@taiji/shared/paths'
import { isPiSessionId } from '@taiji/shared/session-store-paths'
import type { IProcessManager } from '../ports/pi-engine.js'
import type { ISessionStore } from '../ports/session.js'
import { getHistoryTailFromFile, tailReadHistory, type HistoryWindowQuery, type HistoryWindowResult, type TailReadSidecarOpts } from '../session-history.js'
import { applyOrphanToolResults } from '../../infra/pi/message-converter.js'
import { computeActivePathEntries } from '../../infra/pi/session-entry-mapper.js'
import { isEntryNotFoundError } from './trace-sync.js'
import { isEnoent, toErrorMessage } from '../../utils/errors.js'
import { warnOnce } from '../../utils/warn-once.js'

/**
 * get_entries RPC 响应的域内收窄（u-s4 EntriesSinceResult 同款先例）：entries 消费
 * id/parentId（全量路径的活跃路径裁剪 + 增量首条的不变量检测）+ 整体透传
 * rebuildHistoryFromEntries（unknown[] 形参），不依赖 pi 原始 entry 全形状。
 */
type GetEntriesResult = { data?: { entries?: Array<{ id?: string; parentId?: string | null }>; leafId?: string | null } }

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
 * per-session 重建缓存（LRU，Map 插入序实现）。
 *
 * LRU 语义：get/set 命中时把 key 移到 Map 尾部（delete + set），超帽驱逐 Map 头部
 * （最久未访问）。与 renderer chat store 的 LRU 窗口对齐——被 renderer 驱逐的 session
 * 下次重进走全量重建，等价于「缓存从未存在」，行为退化为现状。
 *
 * 缓存基线**始终存完整活跃路径派生视图**（message-revoke U6a 起全量重建经 leafId 裁剪后
 * 落缓存——基线是「未切预算窗的完整活跃路径」，非全文件，被撤分支不进基线），不切预算窗
 * （增量基线错位 = 会话内容错乱），字节维度不做窗口化、不做取舍。
 */
export class HistoryRebuildCache {
  private readonly entries = new Map<string, HistoryRebuildCacheEntry>()

  constructor(
    private readonly maxSessions = HISTORY_CACHE_MAX_SESSIONS,
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
   * 写入/覆盖缓存条目。容量帽 LRU——超 maxSessions 驱逐最久未访问的 session 条目。
   */
  set(sessionId: string, entry: HistoryRebuildCacheEntry): void {
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
 *   warn 日志如实暴露（响应本身无字节字段；极端 turn 由 D3 帧检查与 U7 截断兜底）。
 *
 * truncated 判定 = 窗口起点之前仍有消息（有更早历史未返回）。预算内（全部 turn
 * 入窗且字节未超）→ truncated=false，行为与预算化前一致（A6 回归基线）。
 *
   * 缓存关系：缓存基线始终存**完整活跃路径派生视图**（全量重建经 leafId 裁剪后的未切窗结果，
 * message-revoke U6a；增量合并的正确性依赖），本函数只作用于返回值——三分支（空增量/
 * 增量合并/全量重建）统一在返回前调用。
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
  /**
   * [btw-question 重载链修复] btw 线 session id → 线会话文件绝对路径（组合根接 BtwService
   * 注册表成员查询——rebuildFromDisk 启动重建的内存派生视图，late-bound 闭包）。返回
   * undefined = 注册表无此线（离线尾读按异常态 warn 后返回空页，见 tailReadBtwOffline）。
   * W4a 后本注入兼作「是否 btw 线」的成员查询判别器（tailReadOffline 分支判据）。
   * 缺省注入（未接线构造）= btw 线尾读恒空 + warn，主会话路径零影响。
   */
  resolveBtwThreadFile?: (sessionId: string) => string | undefined
  /**
   * [session-cold-switch-perf §3.3-1] session.historyCacheReady 帧出口（组合根接
   * messageBus.publish——session 级分区广播，与 session.deliveryHandled 同形态）。
   * 缺省注入（未接线构造，存量测试形态）= 不发帧，后台任务其余行为不变。
   */
  publishToBus?: (sessionId: string, msg: ServerMessage) => void
}

/**
 * [session-cold-switch-perf §3.3-1] 后台全量重建任务的结果（deferred 消费形态）：
 * - ok=true：快照落定（snapshotLeafId = 重建快照末条 entry id；messages = 完整活跃路径
 *   派生视图，挂靠方自行按预算切窗）。
 * - ok=false：任务失败（进程丢失 / get_entries 失败 / 会话删除或撤回使在途快照失效）。
 *   挂靠方按现状失败语义收敛（态 4 不无限等待的机制保证——promise 恒有终态）。
 */
export type RebuildOutcome =
  | { ok: true; snapshotLeafId: string; messages: Message[] }
  | { ok: false; error: string }

/** 后台全量重建任务句柄（sessionId 键单例的内部形态）。 */
interface RebuildJob {
  readonly promise: Promise<RebuildOutcome>
  resolve: (outcome: RebuildOutcome) => void
  /**
   * 会话删除（onSessionDisposed）或撤回失效（onSessionReclaimed）置位：任务不中断，
   * 完成时丢弃结果——不写缓存（防删除后写回残留 / 撤回后写回含被撤分支的旧快照）、
   * 不发帧；挂靠方收到 ok=false 按失败语义收敛。
   */
  disposed: boolean
}

/**
 * 事件循环让出点（全量重建编排段间）：setImmediate 让并发 RPC 插队，降低全量重建
 * 对其他会话请求的干扰（session-cold-switch-perf §3.3-1 实现项②）。
 *
 * 偏差如实登记（impl-plan §5 合理偏差 D1）：设计原案「同步 parse 段分批执行」的批内
 * 切分需改 entry 树构建语义（convertPiHistory 的 toolCall/toolResult 配对是跨 entry
 * 窗口语义，按 entry 切批会断配对）或 worker 化（设计明文 out-of-scope），实现降格为
 * 「编排段间让出」——让出点置于重建各同步块之间（RPC 返回后 / rebuild 调用前 / rebuild
 * 落定后），rebuild 段自身仍是单次同步 O(n)：42MB 级会话该块为秒级干扰窗口（§2.1 段 3
 * 实测口径），残留风险与重审触发线已按秒级校准回写设计。
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
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
   * [session-cold-switch-perf §3.3-1] 后台全量重建任务单例（sessionId 键，含在途与
   * 排队中）：态 2 触发 / 态 3 事件驱动启动的唯一登记处。并发请求（态 4 挂靠、游标翻页、
   * 重复态 2 派单）复用同一 promise——同会话不重复触发第二次全量重建。任务终态后由
   * runRebuildJob finally 清槽。
   */
  private readonly rebuildJobs = new Map<string, RebuildJob>()
  /**
   * [态 3] 待启动登记（缓存 miss + 进程不在 + 非 btw 线）：getHistory 分派自身不消费槽
   * 不 spawn（查看路径永不消费执行槽），由并行的 switch 侧进程获取完成事件
   *（onSessionActivated 挂点 → startPendingRebuild）驱动启动。会话删除时清出。
   */
  private readonly pendingRebuilds = new Set<string>()
  /**
   * 后台任务 FIFO 排队（跨会话并发上限 1，设计 §3.3-1 资源边界：连续查看多个大会话时
   * 后台成本不叠加）。登记序 ≈ 最近使用序（getHistory 消费驱动触发），FIFO 出队即按
   * 最近使用排序的简化实现。
   */
  private readonly rebuildQueue: string[] = []
  /** 在途后台任务数（全局并发帽 1 的计数器）。 */
  private activeRebuilds = 0

  /**
   * @param historyCache 缓存实例注入（测试缝：容量帽可注入）；缺省默认帽（8 session）。
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
   * 三分支：
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
   * - 增量报 "Entry not found"（pi 实测文案，E 大写 not 小写）→ 丢缓存 → 全量重新拉取。
   *   触发点：缓存跨 pi 进程存活且 session 文件被外部改写（D6-1 的 removeSessionEntry
   *   清理已结构性消除常态触发，此为防御兜底）。
   * - 其他错误（超时/pi 内部错误）→ 与现状同链降级（尾读），缓存不动（下次重试仍走 since）。
   *
   * R-12：pi RPC 成功但 entries 为空 → 短路返回空列表。pi 的 get_entries 是活跃 session
   * 的权威视图（内存 fileEntries，restore 时从文件加载），空就是空；尾读会给出与 RPC
   * 视图不一致的文件尾部（最多 20 turn），两次 getHistory 结果闪变。
   *
   * 返回 HistoryWindowResult（u4b 起双预算窗口：truncated / loadedTurns /
   * totalTurnsEstimate）——缓存基线始终存完整活跃路径派生视图（message-revoke U6a：全量
   * 重建经 leafId 裁剪后的未切窗结果），**预算窗口只作用于返回值**
   *（D4：最近 20 turns 且总字节 ≤ 640KB，单 turn 超预算完整放行，entry 原子性），
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
      // ── [session-cold-switch-perf §3.3-1 态 1] 缓存命中 → 现状快路径，不变 ──
      //（增量 + fallback 同步全量；缓存命中但 leafId null 的异常条目也留在本路径——
      // 行为与改造前逐点等价）
      if (this.historyCache.get(sessionId) !== undefined) {
        return await this.getLatestWindow(sessionId, query, client)
      }
      // ── [态 2 / 态 4] 缓存 miss + 进程在场（缓存逐出后重切的常见态）：尾读首屏
      // 立即返回 + 后台用在场进程全量重建（不消费预热槽——查看路径永不消费执行槽）。
      // 尾读 IO 失败（态 4）→ 挂后台任务等全量（有终态，不无限等待）。
      return await this.getTailFirstWindow(sessionId, query)
    }
    // ── [态 3 / 态 4] 缓存 miss + 进程不在（冷启动首点态）：尾读首屏立即返回；主会话
    // 后台全量任务登记为待启动，由并行 switch 侧进程获取完成事件驱动启动
    //（onSessionActivated 挂点）；btw 线不登记（回放不经切入链、无 switch 侧，登记必成
    // 无完成时点的无主条目）。尾读 IO 失败 → 按现状失败语义返回（不无限等待）。
    return await this.getTailFirstOfflineWindow(sessionId, query)
  }

  /**
   * [session-cold-switch-perf §3.3-1 态 2 / 态 4] 尾读首屏 + 后台全量重建（进程在场）：
   * 尾读成功 → 首屏立即返回 + ensureRebuildJob 触发（fire-and-forget，单例）；尾读抛错
   *（IO 失败，态 4）→ 挂同一在途任务等待，任务成功返回全量窗口、失败按现状失败语义
   * 上抛（promise 恒有终态 = 不无限等待的机制保证）。空文件/断尾是合法空页（尾读内部
   * 静默语义），不触发态 4（设计注）。
   */
  private async getTailFirstWindow(sessionId: string, query?: HistoryWindowQuery): Promise<HistoryWindowResult> {
    const windowOpts = { limitTurns: query?.limitTurns, maxBytes: query?.maxBytes }
    let tailResult: HistoryWindowResult
    try {
      tailResult = await this.tailReadOffline(sessionId, query)
    } catch (e) {
      console.warn(`[session-service] tail read failed for ${sessionId}: ${toErrorMessage(e)}, awaiting background full rebuild`)
      const outcome = await this.ensureRebuildJob(sessionId).promise
      if (!outcome.ok) throw new Error(`[session-history] background rebuild failed for ${sessionId}: ${outcome.error}`)
      return applyHistoryBudgetWindow(outcome.messages, windowOpts)
    }
    // 态 2：后台全量重建（写缓存 → historyCacheReady 帧）。不 await——首屏返回不被
    // 重建阻塞；任务失败不自动重起（失败帧显式上报，下次派单按四态重新决策）。
    this.ensureRebuildJob(sessionId)
    return tailResult
  }

  /**
   * [session-cold-switch-perf §3.3-1 态 3 / 态 4] 离线尾读首屏 + 待启动登记（进程不在）：
   * 行为与改造前的 tailReadOffline 直调逐点等价（含 detectInterrupted 联合判定），叠加
   * 态 3 登记——主会话（非 btw 线）登记待启动任务，由 onSessionActivated 事件驱动启动；
   * btw 线排除（判别器 = resolveBtwThreadFile 成员查询，零新增接线）。尾读抛错（IO
   * 失败，态 4）→ 主会话登记后按现状失败语义 rethrow（待启动无完成时点，不等待）。
   */
  private async getTailFirstOfflineWindow(sessionId: string, query?: HistoryWindowQuery): Promise<HistoryWindowResult> {
    // btw 线判别（注册表纯查询；与 tailReadOffline 内部分支判定双调冗余——同款既有先例）
    const isBtw = this.deps.resolveBtwThreadFile?.(sessionId) !== undefined
    try {
      const result = await this.tailReadOffline(sessionId, query, { detectInterrupted: true })
      if (!isBtw) this.pendingRebuilds.add(sessionId)
      return result
    } catch (e) {
      if (!isBtw) this.pendingRebuilds.add(sessionId)
      throw e
    }
  }

  /**
   * [态 3 挂点] 待启动任务的进程获取事件驱动启动（session-service onSessionActivated
   * 注册——switch 成功时该会话进程已获取，据此启动登记中的任务）。非登记会话 no-op；
   * 启动走 ensureRebuildJob 单例（client 由 runRebuildJob 启动时经 pm.getClient 取——
   * 排队等待期间进程变化的形态由该取点覆盖）。
   */
  startPendingRebuild(sessionId: string): void {
    if (!this.pendingRebuilds.delete(sessionId)) return
    this.ensureRebuildJob(sessionId)
  }

  /**
   * [session-cold-switch-perf §3.3-1] 后台全量重建任务单例入口：同 sessionId 已有任务
   *（在途或排队）复用，否则登记新任务并入队。跨会话并发帽 1（pumpRebuildQueue 出队）。
   */
  private ensureRebuildJob(sessionId: string): RebuildJob {
    const existing = this.rebuildJobs.get(sessionId)
    if (existing) return existing
    let resolve!: (outcome: RebuildOutcome) => void
    const promise = new Promise<RebuildOutcome>((r) => { resolve = r })
    const job: RebuildJob = { promise, resolve, disposed: false }
    this.rebuildJobs.set(sessionId, job)
    this.rebuildQueue.push(sessionId)
    this.pumpRebuildQueue()
    return job
  }

  /** 跨会话并发帽 1 的出队点：无在途任务时启动队头。 */
  private pumpRebuildQueue(): void {
    if (this.activeRebuilds > 0) return
    const sessionId = this.rebuildQueue.shift()
    if (sessionId === undefined) return
    const job = this.rebuildJobs.get(sessionId)
    if (!job) return this.pumpRebuildQueue()
    this.activeRebuilds++
    void this.runRebuildJob(sessionId, job)
  }

  /**
   * 后台任务执行体：get_entries 全量 → entry 树重建（与同步全量路径同一 fetchAndRebuildFull
   * 核心）→ 编排段间让出 → 终态守卫（disposed / 过期快照）→ 写缓存 → historyCacheReady
   * 帧。失败 resolve(ok:false) + 失败帧（不自动重起——失败显式上报、首败即停；下次
   * getHistory 派单按四态重新决策）。
   */
  private async runRebuildJob(sessionId: string, job: RebuildJob): Promise<void> {
    // 成功终态日志（设计 §3.3-1 重审触发线①的可观测前提：同一会话单日全量重建次数按
    // 「background full rebuild ok」前缀可数）；耗时供触发线②干扰窗口口径对照。
    const startedAt = Date.now()
    try {
      const client = this.deps.pm.getClient(sessionId)
      if (!client) throw new Error('pi client unavailable for background full rebuild')
      const full = await this.fetchAndRebuildFull(sessionId, client)
      await yieldToEventLoop()
      // 会话删除 / 撤回失效：丢弃在途结果——不写缓存、不发帧；挂靠方按失败语义收敛
      //（promise 恒有终态，态 4 不无限等待）。
      if (job.disposed) {
        job.resolve({ ok: false, error: 'session disposed or reclaimed during background rebuild' })
        return
      }
      if (full === null) {
        // R-12 同语义：活跃 session 权威空视图（get_entries 空响应）。不写缓存（与同步
        // 全量路径现状一致），成功帧照发（空快照基线）。
        this.publishCacheReady(sessionId, '')
        console.log(`[session-service] background full rebuild ok for ${sessionId}: snapshotLeafId= (empty authoritative view), took ${Date.now() - startedAt}ms`)
        job.resolve({ ok: true, snapshotLeafId: '', messages: [] })
        return
      }
      // 过期快照守卫（snapshotLeafId 版本对账的 runtime 侧）：任务在途期间缓存已被活跃链
      // 写入（增量/另一重建——leafId 非 null 的新鲜基线）→ 本次快照（拉取时点定格）不覆盖；
      // 缓存缺失或 leafId null 残缺条目（不可增量基线）→ 写入。帧照发（renderer 按
      // snapshotLeafId 自行对账是否重拉）。
      const existing = this.historyCache.get(sessionId)
      if (existing === undefined || existing.leafId === null) {
        this.historyCache.set(sessionId, { leafId: full.leafId, messages: full.messages, truncated: false })
      }
      this.publishCacheReady(sessionId, full.leafId ?? '')
      console.log(`[session-service] background full rebuild ok for ${sessionId}: snapshotLeafId=${full.leafId ?? ''}, took ${Date.now() - startedAt}ms`)
      job.resolve({ ok: true, snapshotLeafId: full.leafId ?? '', messages: full.messages })
    } catch (e) {
      const error = toErrorMessage(e)
      console.warn(`[session-service] background full rebuild failed for ${sessionId}: ${error}`)
      this.publishCacheReady(sessionId, '', error)
      job.resolve({ ok: false, error })
    } finally {
      this.activeRebuilds--
      this.rebuildJobs.delete(sessionId)
      this.pumpRebuildQueue()
    }
  }

  /** session.historyCacheReady 轻通知帧（成功/失败都推，失败带 error；协议 SSOT = shared protocol.ts）。 */
  private publishCacheReady(sessionId: string, snapshotLeafId: string, error?: string): void {
    this.deps.publishToBus?.(sessionId, {
      type: 'session.historyCacheReady',
      payload: { sessionId, snapshotLeafId, ...(error !== undefined && { error }) },
    })
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
    // [session-cold-switch-perf §3.3-1] 态 2 叠加点：与在途后台全量任务并发时挂到在途
    // promise 复用（不重复触发第二次全量重建）。任务成功 → 快照切前缀；失败 → 现状降级
    //（文件读游标窗口，与下方 catch 同链）。
    const inflightJob = this.rebuildJobs.get(sessionId)
    if (inflightJob) {
      const outcome = await inflightJob.promise
      if (outcome.ok) return cursorPrefix(outcome.messages)
      console.warn(`[session-service] cursor getHistory awaiting background rebuild failed: ${outcome.error}, falling back to file cursor read`)
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
    const full = await this.fetchAndRebuildFull(sessionId, client)
    if (full === null) return null
    // leafId 是 session 当前叶子 entry id，记录为下次增量拉取的 since 基准（D6-1）——
    // 存 pi 真实 leafId（非裁剪派生尾），增量 delta 首条 parent 与之配对（W20 Fix-2 不变量）。
    // 缓存基线 = 完整活跃路径派生视图（全量重建裁剪后落缓存——「全量」指未切预算窗的完整
    // 活跃路径，非全文件；增量合并正确性依赖基线为完整活跃路径）；返回值按双预算切窗（D4）。
    this.historyCache.set(sessionId, { leafId: full.leafId, messages: full.messages, truncated: false })
    return full.messages
  }

  /**
   * [session-cold-switch-perf] 全量重建共享核心（同步路径 rebuildFullHistoryAndCache 与
   * 后台任务 runRebuildJob 单源）：get_entries 拉取 → 活跃路径裁剪 → segments sidecar 读
   * → entry 树重建。不写缓存、不发帧——落定语义由调用方承载（同步路径直接写；后台路径
   * 过守卫后写 + 发帧）。
   *
   * @returns null = pi RPC 成功但 entries 为空（R-12：活跃 session 的权威空视图）。
   */
  private async fetchAndRebuildFull(
    sessionId: string,
    client: NonNullable<ReturnType<IProcessManager['getClient']>>,
  ): Promise<{ leafId: string | null; messages: Message[] } | null> {
    const result = await client.getEntries() as GetEntriesResult
    // [session-cold-switch-perf §3.3-1 实现项②] 段间让出（impl-plan §5 偏差 D1 降格形态）：
    // RPC 响应恢复后先排空事件循环再进同步裁剪块，让并发 RPC 插队。
    await yieldToEventLoop()
    const entries = result.data?.entries ?? []
    if (entries.length === 0) return null
    // [message-revoke U6a] 全量重建路径接活跃路径裁剪（调用点契约：仅全量重建裁剪）。
    // get_entries 返回全文件 entries + leafId（无路径过滤），不裁剪则撤回后被撤分支按
    // 文件序渲染（A1「旧分支不渲染」结构性前提）。port 签名（ISessionStore
    // rebuildHistoryFromEntries 两参）不含 leafId，故在调用点预过滤——与经
    // rebuildHistoryFromEntries 第三参裁剪等价（同一 computeActivePathEntries SSOT）。
    const leafId = result.data?.leafId ?? null
    const scopedEntries = computeActivePathEntries(entries, leafId ?? undefined)
    // 读 segments.json sidecar（runtime 直接读文件，不经 IPC——IPC 是 renderer→main，runtime 是独立进程）。
    // 文件缺失/损坏 → null（rebuildHistoryFromEntries 全降级为占位文本，非硬错误）。
    const segmentsMetadata = await readSegmentsMetadataFile(sessionId)
    // [session-cold-switch-perf §3.3-1 实现项②] 段间让出：rebuild 大块（单次同步 O(n)，
    // 42MB 级会话秒级——偏差 D1）启动前显式排空事件循环；sidecar 的 fs await 在文件命中
    // 时可能瞬时返回，不构成可靠让出点。
    await yieldToEventLoop()
    const rebuilt = this.deps.sessionStore.rebuildHistoryFromEntries(scopedEntries, segmentsMetadata)
    return { leafId, messages: rebuilt.messages }
  }

  /**
   * 离线尾读 fallback（getHistoryTailFromFile 包装，D5② 分块扩窗预算窗口）：字节预算
   * 缺省同源 HISTORY_BUDGET.MAX_BYTES（D4 同一预算逻辑——仅 turn 数截取挡不住 20 个
   * 大 turn 的超限 reply）；query.cursor 存在时随行透传（离线游标翻页走 cursorId 定位，
   * 缺省路径 cursor 恒 undefined，读侧 query?.cursor 与缺键等价）。
   *
   * [message-revoke U6a] 离线路径的活跃路径裁剪在本链末端统一接入（convertWindowEntries
   * 以窗口末条 entry 为 leafId——见该函数注释），被撤分支条目不进返回的 messages；
   * 已知边界：turn 计数/字节预算在 collect 阶段按原始行计算（含旧分支行）→ 分支
   * session 的窗口可能欠填、totalTurnsEstimate 偏大（设计 D3 允许的降级面，内容正确性优先）。
   *
   * [btw-question 重载链修复] btw 线分支先于通用链：线目录在 session 存储树侧
   *（`<dataDir>/ext-sessions/<mainSid>/btw/`，公式权威源 = getSessionBtwDir，
   * packages/shared/src/session-store-paths.ts；无 encodeCwd 层、无 agent/btw
   * 前缀），构造性不在 sessions/ 扫描范围，通用链的
   * scanSessions 对 btw 线必 miss → 静默空（重启后线视图空态的根因）。分支收窄在
   * 注册表成员查询内（W4a：resolveBtwThreadFile 注入即 BtwService.getLine 成员查询，
   * 键 = 线 session id = piSessionId——旧 isBtwVirtualId 前缀判别对 piId 形态恒 false，
   * 随键切换同批替换，设计 §3.3.6 迁移表），非 btw 路径逐字节原行为；cursor 翻页离线
   * 路径同走本方法，btw 线「加载更早」一并生效。
   *
   * [U8 重启中断标记] opts.detectInterrupted = 尾部中断形态判定开关（缺省 false）：只在
   * doGetHistory 分支 3（最新窗口 ∧ 无 RPC client）开启；其余降级调用点（活跃 RPC 失败
   * fall-through，含附着 btw 线的 rekey 通道）恒缺省，interrupted 不出场——判定性质 = 推断，
   * 「会话未附着」是它的成立前提（design-session-lifecycle 缺陷 4 方向 A 联合判定）。
   */
  private async tailReadOffline(
    sessionId: string,
    query?: HistoryWindowQuery,
    opts?: { detectInterrupted?: boolean },
  ): Promise<HistoryWindowResult> {
    // btw 分支与通用链同受下方剥除门禁：附着 btw 线（rekey 进共享 pm 后活跃，走
    // getLatestWindow/getIncrementalHistory 的 RPC catch 降级到此处）同样不得透传
    // interrupted——「会话未附着」是判定的成立前提，与线类型无关（F1 修复：早退分支
    // 曾绕过剥除行，把 tailReadHistory 判出的 interrupted 原样出场）。
    // btw 线文件只解析一次，分支判定与线下读共用同一结果（注册表纯查询，双调冗余）。
    // [session-cold-switch-perf §3.3-1 实现项①] 尾读路径补 segments sidecar 回填：两条
    // 尾读链（通用 / btw）都注入 sidecar 元数据（runtime 直接读文件，缺失 → null 全降级
    // 纯文本——与全量路径降级语义一致），窗口消息内容对齐全量重建路径（图片/文件/技能
    // chip），回填判定链单源 backfillConvertedSegments（session-history convertWindowEntries）。
    const segmentsMetadata = await readSegmentsMetadataFile(sessionId)
    const sidecar: TailReadSidecarOpts = { segmentsMetadata }
    const btwFile = this.deps.resolveBtwThreadFile?.(sessionId)
    const result = btwFile !== undefined
      ? await this.tailReadBtwOffline(sessionId, btwFile, query, sidecar)
      : await getHistoryTailFromFile(
        sessionId,
        this.deps.sessionStore,
        query?.limitTurns ?? HISTORY_BUDGET.RECENT_TURNS,
        { cursor: query?.cursor, maxBytes: query?.maxBytes ?? HISTORY_BUDGET.MAX_BYTES },
        sidecar,
      )
    // 开关关闭时剥除（tailReadHistory 内 cursor 翻页本就不判，此处防未来判定面扩大后
    // 降级路径误透传；字段可选，剥除 = 不出场而非 false——消费方按「无判定」处理）
    return opts?.detectInterrupted === true ? result : { ...result, interrupted: undefined }
  }

  /**
   * btw 线离线尾读（btw 面解析路径）：线文件路径由调用方 tailReadOffline 经注册表
   * （resolveBtwThreadFile，组合根接 BtwService 注册表）解析后传入 → 命中且文件在场 →
   * 与通用链同一 tailReadHistory（同一预算窗口 / cursor 定位 / entry 转换链）；文件缺失 /
   * 注册表 miss → warn + 空页。
   *
   * 异常态口径（与「合法空线」区分）：合法空线 = 文件在场但无 turn（tailReadHistory 静默
   * 空页）；异常态 = 线文件缺失（pi 从未 flush 的分支②回落线被删 / 目录被外部清理 /
   * 注册表与磁盘不一致）——轻量 warn 留痕含线 session id 与期望路径 + 恢复动作，不做 UI 错误条
   * （renderer 侧空历史另有对等 warn，btw-replay）。
   */
  private async tailReadBtwOffline(
    sessionId: string,
    file: string,
    query?: HistoryWindowQuery,
    sidecar?: TailReadSidecarOpts,
  ): Promise<HistoryWindowResult> {
    const emptyPage: HistoryWindowResult = { messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 }
    if (!file) {
      console.warn(
        `[session-history] btw line history unavailable: no registry entry for ${sessionId} — ` +
        'expected a rebuilt line (rebuildFromDisk); verify the btw line layout: ls <dataDir>/ext-sessions/<mainSid>/btw/ (formula = getSessionBtwDir, packages/shared/src/session-store-paths.ts), or reopen/delete the line in the btw panel',
      )
      return emptyPage
    }
    if (!existsSync(file)) {
      console.warn(
        `[session-history] btw line session file missing for ${sessionId}: ${file} — ` +
        'the line never flushed (pi lazy write) or was removed; send a message to re-establish it, or close the line',
      )
      return emptyPage
    }
    return await tailReadHistory(
      file,
      this.deps.sessionStore,
      query?.limitTurns ?? HISTORY_BUDGET.RECENT_TURNS,
      { cursor: query?.cursor, maxBytes: query?.maxBytes ?? HISTORY_BUDGET.MAX_BYTES },
      sidecar,
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
    // leafId null 收敛（r1-S18）：调用方已保证非 null，此处检查消 as 断言——防御性
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
      // [message-revoke U6a 反直觉契约——增量路径不裁剪] 此处刻意不传 leafId（设计 D3/U6
      // 定死的反向约束，勿「顺手统一」两路径）：delta 是活跃路径的后缀切片——上方 W20
      // Fix-2 不变量保证首条 parent = 缓存 leafId = 活跃 tip，delta 条目构造性全在活跃
      // 路径上；而活跃路径裁剪是「leafId 回溯到根」的全树语义，在 since 窗口切片上执行
      // 会把窗口边界误当树边界（切片首条之前无根可回溯），属语义误用。缓存基线已是
      // 活跃路径派生视图（rebuildFullHistoryAndCache 裁剪后落缓存），merge 结果保持派生语义。
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
        // D6-4 fallback：since 失效（缓存基线不在 pi 当前 entry 集合）→ 丢缓存 → 全量重新拉取
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
    // [session-cold-switch-perf §3.3-1] 两张新增内存表同步清出：态 3 待启动登记删除
    //（该会话进程永不注册的无主条目由本挂点清出）；在途后台任务不中断但置 disposed——
    // 完成时丢弃结果（不写缓存防删除后写回残留、不发帧），挂靠方按失败语义收敛。
    this.pendingRebuilds.delete(sessionId)
    const job = this.rebuildJobs.get(sessionId)
    if (job) job.disposed = true
  }

  /**
   * 驱逐单 session 的历史重建缓存条目。现行唯一调用链 = 消息撤回编排（revoke-orchestrator
   * 第 ④ 步）→ SessionService.evictHistoryRebuildCache → 本方法：撤回使缓存基线失效，
   * 驱逐后下次 getHistory 走单次全量重建。只驱逐历史缓存（纯派生数据，丢弃无一致性
   * 风险），不改调 removeSessionEntry 汇聚点（会连带 bus 分区清理 / PTY 连杀 / 插件
   * didDestroy 投递）。
   */
  onSessionReclaimed(sessionId: string): void {
    this.historyCache.delete(sessionId)
    // [session-cold-switch-perf] 撤回同样使在途后台快照失效（job 置 disposed）：撤回经
    // pi append label entry 改树，任务在途快照（label 前 get_entries 定格）完成后若写入，
    // 缓存会含被撤分支（message-revoke U6a「旧分支不渲染」被绕过）——丢弃结果，与缓存
    // 驱逐同因。态 3 待启动登记保留（撤回需活跃 turn，进程不在的会话不可撤回，登记与
    // 撤回无交集——保守不动）。
    const job = this.rebuildJobs.get(sessionId)
    if (job) job.disposed = true
  }

  /**
   * 清空全部历史重建缓存（u7c：memory-relief 可回收物 ① 的 reader 出口——组合根
   * watchdog onRelief 接线经 SessionService 透传至此）。返回清除条目数（观测范围）。
   */
  clearHistoryCache(): number {
    return this.historyCache.clearAll()
  }
}

/**
 * 读 segments.json sidecar（runtime 直接读文件，不经 IPC）。
 *
 * IPC 的 writeSegmentsMetadata / readSegmentsMetadata 是 renderer→main 通道，runtime 是独立 Node 进程
 * （不持 electron app 句柄），不能走 IPC。runtime 直接读 getAttachmentsDir(sessionId)
 * （session 存储树域 1，<root>/<sessionId>/attachments/）下的 segments.json。
 *
 * 文件缺失/损坏（JSON parse 失败 / entries 非数组）→ 返回 null（rebuildHistoryFromEntries 据此
 * 全降级为占位文本，非硬错误）。异步读：与周围 getEntries RPC / readFile 一致，sidecar 是小文件
 * （每条 user message 一条 entry）但统一走异步避免事件循环阻塞。
 *
 * 非法 pi sessionId（如 subagent 三段式虚拟 id `subagent:<main>:<sub>`）同样按「无 sidecar」
 * 返 null：getAttachmentsDir 对非法 id 会 assertPiSessionId fail-fast（路径穿越防线），而本函数
 * 所在的尾读链对这类 id 的语义是通用链空页静默降级——sidecar 缺失（null）恰是该降级的
 * 一部分，不是可 fail-fast 的异常。
 */
async function readSegmentsMetadataFile(sessionId: string): Promise<SegmentsMetadataFile | null> {
  if (!isPiSessionId(sessionId)) return null
  const filePath = join(getAttachmentsDir(sessionId), 'segments.json')
  try {
    if (!existsSync(filePath)) return null
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as SegmentsMetadataFile
    if (!parsed || !Array.isArray(parsed.entries)) {
      // RT-5#6：结构损坏（合法 JSON 但 entries 非数组）显形——不留痕则「全降级占位文本」不可归因
      warnOnce(
        filePath,
        `[history-rebuild-cache] segments.json sidecar 结构损坏（entries 非数组），本次全降级为占位文本：${filePath}`,
      )
      return null
    }
    return parsed
  } catch (e) {
    // RT-5#6：读失败不留痕则降级不可归因；ENOENT（existsSync 后 TOCTOU 删除窗口）保持
    // 安静，其余（EACCES/半截 JSON 等）warn 一次（按路径去重）
    if (!isEnoent(e)) {
      warnOnce(
        filePath,
        `[history-rebuild-cache] segments.json sidecar 读/解析失败，本次全降级为占位文本：${filePath}`,
        e instanceof Error ? e.message : e,
      )
    }
    return null
  }
}
