/**
 * 用量统计扫描服务（W1 数据层）
 *
 * 扫描 session JSONL 目录，按四分类聚合 Token 用量，返回 UsageRow[]：
 * ①②③ 为 pi 三分类（assistant / toolResult-with-usage / compaction-with-usage），
 * ④ 为 taiji 自有口径（rename-session custom entry，G3 rename 落账通道，
 * usage-page-fixes §3.3 ④；落盘形态锚 docs/pi-semantics.json PS-29，非 pi 语义）。
 *
 * 为什么走「读文件」而非实时事件流聚合：runtime 事件链路只透传
 * input/output/totalTokens，cacheRead/cacheWrite/cost 仅存在于 JSONL 落盘数据，
 * 完整用量维度只能从落盘文件获得（原用量设计提案验证结论，提案文档已删除）。
 *
 * 缓存策略：per-file 分片 (mtimeMs, size) 双键（D9）——append-only 场景下
 * mtime 不变但 size 变仍能 miss。
 */

import { readdir, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { createInterface } from 'node:readline'
import { createReadStream } from 'node:fs'
import { basename, join } from 'node:path'
import { getSessionsDir } from '../../infra/pi/pi-paths.js'
import type { UsageMetrics, UsageRow, UsageStatsResult } from '@taiji/shared'

// ── 分片类型 ─────────────────────────────────────────────────

interface FileShard {
  mtimeMs: number
  size: number
  rows: UsageRow[]
  skippedLines: number
  cwd: string | null
  /**
   * 读流/解析过程整体失败（RT-8#12）：文件存在（stat 成功、计入 sessionCount）但数据点
   * 全缺——聚合偏低须可观测（failedFiles 计数），否则与「该 session 无用量」不可区分。
   */
  failed: boolean
}

/**
 * 单行分类结果（scanFile 主循环与分类辅助方法之间的信号契约）：
 * - UsageRow：命中分类且 timestamp 有效，计入 rows
 * - 'skip'：命中分类但 timestamp 无效，计入 skippedLines（行级失败）
 * - null：不命中该分类，继续尝试下一分类
 */
type ScanRowResult = UsageRow | 'skip' | null

/** 空分片降级（scanFile 读流失败时返回）：mtime/size 键保留，文件未变更期间不重读。 */
function emptyShard(fileStat: { mtimeMs: number; size: number }): FileShard {
  return { mtimeMs: fileStat.mtimeMs, size: fileStat.size, rows: [], skippedLines: 0, cwd: null, failed: true }
}

/** getStats 逐文件聚合的累计口径（aggregateFiles 输出，拼装进 UsageStatsResult）。 */
interface UsageFileAggregate {
  rows: UsageRow[]
  skippedLines: number
  sessionCount: number
  failedFiles: number
}

/**
 * 收集单个目录层内可扫描的 .jsonl 文件路径（仅普通文件）。
 *
 * 文件过滤：复刻 isScannableSessionFile 规则——排除 .tmp-migrate-*.jsonl
 *（归一化崩溃残留）；.jsonl.meta.json（sidecar）不以 .jsonl 结尾被天然排除。
 */
function collectScannableJsonlPaths(dirPath: string, entries: Dirent[]): string[] {
  const paths: string[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.jsonl')) continue
    if (entry.name.includes('.tmp-migrate-')) continue
    paths.push(join(dirPath, entry.name))
  }
  return paths
}

// ── 服务主体 ─────────────────────────────────────────────────

export class UsageStatsService {
  private readonly sessionsDir: string

  /** @data-owner #16 派生缓存：per-file 分片，(mtimeMs, size) 双键失效（登记表主表 #16）。
   * 2026-09-14 内存审计复核：量级维持可控，维持不治裁决（ADR-0069，原审计文档已删除 git 可追溯） */
  private readonly shards = new Map<string, FileShard>()

  constructor(sessionsDir: string = getSessionsDir()) {
    this.sessionsDir = sessionsDir
  }

  /**
   * 聚合全部 session 文件的用量数据。
   *
   * 两层扫描（方案 B 布局）：pi 默认布局把 session jsonl 写入
   * `<sessionsDir>/<encodeCwd>/` 子目录（锚点 pi@0.84.4 dist/core/session-manager.js:242-246
   * getDefaultSessionDirPath：`join(agentDir, "sessions", "--<encoded-cwd>--")`，
   * SessionManager.create 无显式 sessionDir 时走 getDefaultSessionDir 同源），单层 readdir
   * 会漏掉全部子目录文件 → 统计归零，故根层 + 一层子目录都统计（§11.12：两层即够——pi 只写一层
   * encodeCwd，`_migrated-no-cwd/` 与 fork 产物也都是一层）。
   *
   * 流程：readdir(withFileTypes)（根层 + 一层子目录）→ stat → 比对 (mtimeMs, size)
   * 双键 → 未变用分片、变化/新增重读、删除丢分片 → 拼装。
   */
  async getStats(): Promise<UsageStatsResult> {
    const scannedAt = Date.now()

    const entries = await this.readRootEntries()
    if (entries === null) {
      return { rows: [], scannedAt, sessionCount: 0, skippedLines: 0, failedFiles: 0 }
    }

    // 根层 + 一层 encodeCwd 子目录（只下钻一层，孙目录不进）
    const jsonlPaths = await this.collectJsonlPaths(entries)
    // 收集当前磁盘文件路径，用于清理已删除文件的分片
    const currentPaths = new Set<string>()
    const agg = await this.aggregateFiles(jsonlPaths, currentPaths)
    this.pruneDeletedShards(currentPaths)

    return { ...agg, scannedAt }
  }

  /**
   * 根层 readdir；不可读时 warn 留痕（含恢复动作）并返回 null，调用方返回空结果
   * （sessionCount=0 + rows 空，UI 至少显示空态而非崩溃）。
   */
  private async readRootEntries(): Promise<Dirent[] | null> {
    try {
      return await readdir(this.sessionsDir, { withFileTypes: true })
    } catch (e) {
      // ENOENT（首启未产生 session 目录）= 合法空态；其他错误（EACCES 等）= 全量数据点
      // 不可读——warn 留痕，但不伪装成「无用量」之外的任何形态
      if (!isEnoent(e)) {
        console.warn(
          `[usage-stats] session 目录不可读，用量统计返回空（实际用量不可见）: ${this.sessionsDir}。` +
            '恢复动作：检查目录读权限后刷新用量页',
          e,
        )
      }
      return null
    }
  }

  /** 根层 + 一层 encodeCwd 子目录的 .jsonl 路径清单（§11.12：两层即够——pi 只写一层）。 */
  private async collectJsonlPaths(entries: Dirent[]): Promise<string[]> {
    const jsonlPaths = collectScannableJsonlPaths(this.sessionsDir, entries)
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const subDir = join(this.sessionsDir, entry.name)
      let subEntries: Dirent[]
      try {
        subEntries = await readdir(subDir, { withFileTypes: true })
      } catch (e) {
        // 单个子目录不可读 → 跳过继续（与单文件读失败的容错语义一致）——但留痕
        //（RT-8#12：该目录下全部 session 的数据点静默缺失不可观测）。无法预知其中
        // 文件数，不进 failedFiles 计数（那是文件级口径），warn 含路径。
        if (!isEnoent(e)) {
          console.warn(
            `[usage-stats] session 子目录不可读，该目录用量未计入: ${subDir}。恢复动作：检查目录读权限`,
            e,
          )
        }
        continue
      }
      jsonlPaths.push(...collectScannableJsonlPaths(subDir, subEntries))
    }
    return jsonlPaths
  }

  /**
   * 逐文件聚合：(mtimeMs, size) 双键命中（D9）→ 直接用分片；变化/新增 → 重读并回写分片。
   * currentPaths 记录磁盘现存文件（pruneDeletedShards 的清理依据）。
   */
  private async aggregateFiles(
    jsonlPaths: string[],
    currentPaths: Set<string>,
  ): Promise<UsageFileAggregate> {
    const rows: UsageRow[] = []
    let skippedLines = 0
    let sessionCount = 0
    let failedFiles = 0

    for (const filePath of jsonlPaths) {
      let fileStat
      try {
        fileStat = await stat(filePath)
      } catch {
        // stat 失败（扫描间隙被删/权限）：文件级失败计数（RT-8#12）而非静默跳过
        failedFiles++
        continue
      }

      currentPaths.add(filePath)
      const cached = this.shards.get(filePath)

      if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
        // 未变文件：直接用分片
        rows.push(...cached.rows)
        skippedLines += cached.skippedLines
        if (cached.failed) failedFiles++
        sessionCount++
        continue
      }

      // 变化/新增文件：重读
      const shard = await this.scanFile(filePath, fileStat)
      this.shards.set(filePath, shard)
      rows.push(...shard.rows)
      skippedLines += shard.skippedLines
      if (shard.failed) failedFiles++
      sessionCount++
    }

    return { rows, skippedLines, sessionCount, failedFiles }
  }

  /** 清理已删除文件的分片（磁盘上不再存在的路径对应分片丢弃）。 */
  private pruneDeletedShards(currentPaths: Set<string>): void {
    for (const key of this.shards.keys()) {
      if (!currentPaths.has(key)) {
        this.shards.delete(key)
      }
    }
  }

  /**
   * 流式扫描单个 JSONL 文件，按四分类计入 usage。
   *
   * 计入规则（①②③ 对齐 pi getUsageCostBreakdown，锚点：@earendil-works/pi-coding-agent@0.84.4
   * dist/core/usage-totals.js:23-33，升级 pi 时须重新核对该锚点；④ 为 taiji 自有口径）：
   * ① type==='message' && message.role==='assistant' && message.usage → 主桶
   * ② type==='message' && message.role==='toolResult' && message.usage → compaction 虚拟桶
   * ③ (type==='compaction' || type==='branch_summary') && entry.usage → compaction 虚拟桶
   *    model 归属：details.model（smart-context 落盘的 `${provider}/${id}`）权威优先，
   *    非 string/空串回退 'compaction'（usage-page-fixes §3.3 ④ 守卫与回退字面量）
   * ④ type==='custom' && customType==='rename-session' && data.usage 为非 null 对象
   *    → rename-session 虚拟桶（G3）
   *
   * 四类判定互斥（①② 同 type 不同 role，③④ 不同 type），拆分到
   * rowFromAssistant / rowFromToolResult / rowFromCompactionEntry /
   * rowFromRenameSessionEntry 四个辅助方法；本方法只做行读取 + cwd 提取 + 编排。
   *
   * @returns FileShard 分片（含 rows, skippedLines, cwd）
   */
  private async scanFile(filePath: string, fileStat: { mtimeMs: number; size: number }): Promise<FileShard> {
    const rows: UsageRow[] = []
    let skippedLines = 0
    let cwd: string | null = null
    let foundSessionEntry = false

    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    })
    // rl error 吞转发（2026-09-04 事故审计）：readline 把 input 流 error 转发到
    // interface 实例 re-emit，与 for-await 的 iterator listener 多播共存；文件级
    // 容错由下方 try/catch 承担（双保险：iterator rejection / 裸 emit 两路都不逃逸）
    rl.on('error', () => {})

    try {
      for await (const line of rl) {
        if (!line.trim()) continue

        let entry: Record<string, unknown>
        try {
          entry = JSON.parse(line) as Record<string, unknown>
        } catch {
          skippedLines++
          continue
        }

        // 提取 cwd：逐行读直到找到第一个 type==='session' entry
        // 容错首行为 session_info 的旧文件——继续读找 session entry
        if (!foundSessionEntry && entry.type === 'session' && typeof entry.cwd === 'string') {
          cwd = entry.cwd
          foundSessionEntry = true
        }

        // 按原顺序尝试四类判定；'skip' 短路（timestamp 无效行不再计入任何桶）
        const row =
          this.rowFromAssistant(entry, cwd) ??
          this.rowFromToolResult(entry, cwd) ??
          this.rowFromCompactionEntry(entry, cwd) ??
          this.rowFromRenameSessionEntry(entry, cwd)

        if (row === 'skip') {
          skippedLines++
          continue
        }
        if (row) {
          rows.push(row)
        }

        // 其余行 continue
      }
    } catch {
      // 单文件读失败 → 空分片降级，不打断整个聚合（与上方 readdir 失败返回空结果的
      // 容错语义一致）；mtime/size 键保留，下次变更时重读。
      // 范围声明：本 catch 同时兜住循环体内 rowFrom* 的逻辑异常（非仅流错误）——有意
      // 取舍，聚合容错优先于显式失败；代价是该文件数据点静默缺失至文件变更。排查
      // 入口 = 空分片 + skippedLines 归零（收紧为仅流错误须 rethrow 逻辑异常，属行为
      // 变更另走设计）。
      return emptyShard(fileStat)
    }

    return {
      mtimeMs: fileStat.mtimeMs,
      size: fileStat.size,
      rows,
      skippedLines,
      cwd,
      failed: false,
    }
  }

  /**
   * ① assistant 主桶：type==='message' 且 message.role==='assistant' 且带 usage。
   * 命中但 timestamp 无效 → 'skip'（计 skippedLines）；不命中 → null。
   */
  private rowFromAssistant(entry: Record<string, unknown>, cwd: string | null): ScanRowResult {
    if (entry.type !== 'message') return null
    const message = entry.message as Record<string, unknown> | undefined
    if (message?.role !== 'assistant') return null
    if (!message?.usage) return null

    const date = toLocalDate(entry.timestamp as string)
    if (date === null) return 'skip'

    const provider = message.provider as string | undefined
    const model = (message.responseModel ?? message.model) as string | undefined
    return this.makeRow(date, provider ?? '(unknown)', model ?? '(unknown)', cwd, message.usage as Record<string, unknown>)
  }

  /**
   * ② toolResult-with-usage → compaction 虚拟桶。
   * 命中但 timestamp 无效 → 'skip'（计 skippedLines）；不命中 → null。
   */
  private rowFromToolResult(entry: Record<string, unknown>, cwd: string | null): ScanRowResult {
    if (entry.type !== 'message') return null
    const message = entry.message as Record<string, unknown> | undefined
    if (message?.role !== 'toolResult') return null
    if (!message?.usage) return null

    const date = toLocalDate(entry.timestamp as string)
    if (date === null) return 'skip'

    return this.makeRow(date, 'compaction', 'compaction', cwd, message.usage as Record<string, unknown>)
  }

  /**
   * ③ compaction / branch_summary with entry.usage → compaction 虚拟桶。
   * model 归属：details.model 权威优先（smart-context 落盘 `${provider}/${id}`），
   * 非 string/空串诚实回退 generic 'compaction' 行（存量数据/守卫降级，不猜测归属）。
   * 命中但 timestamp 无效 → 'skip'（计 skippedLines）；不命中 → null。
   */
  private rowFromCompactionEntry(entry: Record<string, unknown>, cwd: string | null): ScanRowResult {
    if (entry.type !== 'compaction' && entry.type !== 'branch_summary') return null
    if (!entry.usage) return null

    const date = toLocalDate(entry.timestamp as string)
    if (date === null) return 'skip'

    const details = entry.details as Record<string, unknown> | undefined
    const model =
      typeof details?.model === 'string' && details.model !== '' ? details.model : 'compaction'
    return this.makeRow(date, 'compaction', model, cwd, entry.usage as Record<string, unknown>)
  }

  /**
   * ④ rename-session custom entry（taiji 自有口径，非 pi 三分类）→ rename-session 虚拟桶。
   * 落盘形态锚：docs/pi-semantics.json PS-29（appendCustomEntry 字面量含
   * customType/data/timestamp）。usage 存在性守卫：data.usage 为非 null 对象才计 row
   * （同 ①②③ 范式）；字段缺失由 extractMetrics 按 0 兜底，cost 缺失 → 费用视角 $0
   * （诚实降级）。model 守卫与 ③ 对称：data.model 非 string/空串回退 'rename-session'。
   * 命中但 timestamp 无效 → 'skip'（计 skippedLines）；不命中 → null。
   */
  private rowFromRenameSessionEntry(entry: Record<string, unknown>, cwd: string | null): ScanRowResult {
    if (entry.type !== 'custom') return null
    if (entry.customType !== 'rename-session') return null
    const data = entry.data as Record<string, unknown> | undefined
    const usage = data?.usage
    if (typeof usage !== 'object' || usage === null) return null

    const date = toLocalDate(entry.timestamp as string)
    if (date === null) return 'skip'

    const model = typeof data?.model === 'string' && data.model !== '' ? data.model : 'rename-session'
    return this.makeRow(date, 'rename-session', model, cwd, usage as Record<string, unknown>)
  }

  /**
   * 构造 UsageRow，从 usage 对象提取指标。
   * usage 存在性守卫：缺失字段按 0。
   */
  private makeRow(
    date: string,
    provider: string,
    model: string,
    cwd: string | null,
    usage: Record<string, unknown>,
  ): UsageRow {
    const metrics = extractMetrics(usage)
    const project = this.extractProject(cwd)
    return { ...metrics, date, provider, model, project }
  }

  /** 从 cwd 提取 project（basename）。 */
  private extractProject(cwd: string | null): string {
    if (!cwd) return '(unknown)'
    const name = basename(cwd)
    return name || '(unknown)'
  }
}

/** 从 usage 对象提取 UsageMetrics 字段，缺失按 0。messages 语义：每行恰代表一个计入事件（主桶一条消息 / 虚拟桶一个压缩或摘要事件）。 */
function extractMetrics(usage: Record<string, unknown>): UsageMetrics {
  const input = typeof usage.input === 'number' ? usage.input : 0
  const output = typeof usage.output === 'number' ? usage.output : 0
  const cacheRead = typeof usage.cacheRead === 'number' ? usage.cacheRead : 0
  const cacheWrite = typeof usage.cacheWrite === 'number' ? usage.cacheWrite : 0

  let costUSD = 0
  const cost = usage.cost as Record<string, unknown> | undefined
  if (cost && typeof cost.total === 'number') {
    costUSD = cost.total
  }

  const messages = 1

  return { input, output, cacheRead, cacheWrite, costUSD, messages }
}

/** Node fs 错误的 ENOENT 判定（合法空态 vs 真读取失败分流用）。 */
function isEnoent(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'ENOENT'
}
/**
 * UTC timestamp → 本地时区 'YYYY-MM-DD'（D6）；非法/缺失 timestamp 返回 null（行级失败，计入 skippedLines）。
 *
 * 用 Intl.DateTimeFormat 'sv-SE' locale 保证 ISO 格式输出，timeZone 缺省 = 本地时区。
 * 禁止 toISOString().slice(0,10)（UTC 切日会让晚 8 点后的用量算到「明天」）。
 * dateFormatter 为模块级复用实例（逐行 new 实测慢 ~37x @60k 行）。
 */
const dateFormatter = new Intl.DateTimeFormat('sv-SE')
function toLocalDate(timestamp: string): string | null {
  if (!timestamp) return null
  const d = new Date(timestamp)
  if (Number.isNaN(d.getTime())) return null
  // Intl.DateTimeFormat 的 timeZone 缺省值 = 运行环境本地时区（Node.js 下 = 系统时区）
  return dateFormatter.format(d)
}
