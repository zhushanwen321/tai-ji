/**
 * 崩溃台账 runtime writer（crash-forensics-and-watchdog.md §3.3 D1，实施单元 u1b）。
 *
 * 职责：runtime 进程侧死亡/自愈/条件信号事件的统一落盘——`<dataDir>/logs/crashes/runtime.jsonl`
 * （双文件形态的 runtime 半边：main 侧事件由 main 侧双胞胎 writer 写 main.jsonl，
 * 消除跨进程写竞争——D1 被否②）。事件类型消费 @taiji/shared 的 schema SSOT
 * （crash-journal-schema.ts，u1a），本模块不复制定义。
 *
 * 同步 append 形态（【oe-audit C3】对齐 main 侧双胞胎 u1c 的同步选型，删异步流机制族）：
 * - 台账事件量 KB 级/日 + watermark daily 1 条/日（D2 代价声明），写入频率极低——
 *   同步 appendFileSync 使「崩溃瞬间落盘」不依赖 flush 时机，无在途写丢失窗口
 *   （异步缓冲形态下 kill -9 时轮转窗口内的行丢失——对「记录崩溃事件」的台账是
 *   语义倒置：恰在最需要落盘的时刻最不可靠）；
 * - **写入字节计数**（替代每行 statSync）触发 size 轮转，默认单档 10MB（构造参数可
 *   注入小阈值供测试）；**末 3 段级联 rename**：runtime.jsonl → .jsonl.1 → .jsonl.2，
 *   最旧（.2）删除——同步 rename 无在途写，logger.ts 的「end 等 flush 再 rename」
 *   顺序约束在此形态下结构性消失；
 * - 轮转边界行不丢由同步结构保证（append 完成即落盘，无 pendingLines 队列）。
 *
 * 清理只依赖自带轮转（D1）：crashes/ 是 logs/ 的子目录，cleanExpiredLogs 只认顶层平铺
 * 前缀、结构性跳过子目录——台账不进 7 天保留期清理，寿命由 3 段 ×10MB 自界。
 *
 * best-effort 语义（日志类设施契约）：append 为 fire-and-forget，任何写入失败（磁盘满/
 * 权限/序列化异常）不向调用方业务链抛错；首个失败经注入 sink 记一次 warn 后静默。
 * close() 供 shutdown 链与测试取确定性收口点（ended 标记；同步形态无在途数据，close
 * 即完成；end 后 append 为 no-op）。
 *
 * 留痕出口经注入（C-comm-01 循环依赖零容忍）：本模块**不 import logger**——write 失败
 * 的 warn 出口由组合根 initCrashJournal(dataDir, logger) 注入（logger → crash-journal
 * 单向保留，crash-journal → logger 的反向边删除）。注入的是 logger 稳定对象引用，运行期
 * 函数体内调用，initLogger 先后皆可；未注入 = no-op（测试直接 createCrashJournalWriter
 * 构造零副作用，对齐 logger 未初始化 no-op 契约）。
 *
 * 单例风格对齐 logger.ts：initCrashJournal(dataDir) 组合根调一次；未初始化时
 * getCrashJournal() 返回 no-op writer（单元测试零副作用）。
 */
import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  type CrashJournalEvent,
  type CrashJournalWriter,
  type CrashJournalWriterOptions,
} from '@taiji/shared'
import { getDataDir } from '@taiji/shared/paths'

/** 字节换算基数（对齐 logger.ts 既有 BYTES_PER_KB 惯例，禁裸 1024）。 */
const BYTES_PER_KB = 1024

/** 单档默认上限 MB（设计 D1：单文件 10MB size 轮转）。 */
const DEFAULT_MAX_FILE_MB = 10

/** 单档默认上限（字节）。 */
const DEFAULT_MAX_FILE_BYTES = DEFAULT_MAX_FILE_MB * BYTES_PER_KB * BYTES_PER_KB

/** 级联段后缀（旧 → 新）。`.2` 最旧、先删；活跃档无后缀。 */
const SEGMENT_SUFFIXES = ['.1', '.2'] as const

/**
 * runtime 侧台账 writer（扩展 schema 的 CrashJournalWriter 契约，附加 close 收口）。
 * main 侧双胞胎（u1c）实现同款 close 语义；两实现共用 schema 类型不复制定义。
 */
export interface CrashJournalFileWriter extends CrashJournalWriter {
  /**
   * 确定性收口点：置 ended 后续 append 为 no-op。同步形态下 append 完成即落盘、
   * 无在途数据，close 无需等待（shutdown 链挂点保持 close-crash-journal 步骤不变）。
   */
  close(): Promise<void>
}

/** writer 构造选项（schema CrashJournalWriterOptions 的 runtime 侧扩展，不改 SSOT）。 */
export interface CrashJournalWriterCreateOptions extends CrashJournalWriterOptions {
  /**
   * 数据根目录；缺省 getDataDir() 动态推导（排查规则：禁止硬编码绝对路径）。
   * 台账落位 `<dataDir>/logs/crashes/<role>.jsonl`，目录不存在自动创建。
   */
  dataDir?: string
  /** 单档字节上限；缺省 10MB。测试注入小阈值触发轮转。 */
  maxFileBytes?: number
}

/**
 * 创建台账 writer 实例（单例的内部实现，测试直接构造注入小阈值）。
 *
 * 构造即创建 crashes/ 目录；目录创建失败（ENOTDIR/权限）时 writer 降级为永久 no-op
 * 并记一次主日志 warn——台账是旁路设施，不得因自身故障放大为调用链故障。
 */
export function createCrashJournalWriter(opts: CrashJournalWriterCreateOptions): CrashJournalFileWriter {
  const dataDir = opts.dataDir ?? getDataDir()
  const baseFile = join(dataDir, 'logs', 'crashes', `${opts.role}.jsonl`)
  let dirReady = false
  try {
    mkdirSync(dirname(baseFile), { recursive: true })
    dirReady = true
  } catch {
    reportWriteFailureOnce(`crashes dir create failed: ${dirname(baseFile)}`)
  }
  return new CrashJournalFileWriterImpl(baseFile, opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, dirReady)
}

class CrashJournalFileWriterImpl implements CrashJournalFileWriter {
  /** 活跃档路径。 */
  private readonly baseFile: string
  /** 单档字节上限（size 轮转判定，写前预测）。 */
  private readonly maxFileBytes: number
  /** 构造期目录创建成功标记；false = 永久 no-op。 */
  private readonly dirReady: boolean
  /** 活跃档自本次打开以来的写入字节数（打开时以盘上真实 size 为起点）。 */
  private bytesWritten = 0
  /** 惰性打开标记：首次 append 时 stat 弥合 + 越限级联（每条 append 重试 mkdir 自愈）。 */
  private opened = false
  /** close 已调；后续 append/close 均 no-op。 */
  private ended = false
  /** 失败已上报过一次（once 形态，防失败风暴刷主日志）。 */
  private errorReported = false

  constructor(baseFile: string, maxFileBytes: number, dirReady: boolean) {
    this.baseFile = baseFile
    this.maxFileBytes = maxFileBytes
    this.dirReady = dirReady
  }

  append(event: CrashJournalEvent): void {
    if (this.ended || !this.dirReady) return
    try {
      // ts 缺省补写入时刻（显式 null = 调用方声明「不知道」，展开覆盖语义保留 null 不改写）
      // ——评估器（D2）按 ts 窗口计数，无 ts 的行不可判。JSON.stringify 不产生裸换行
      // （\n 被转义），单行 JSONL 的逐行可解析性由此保证。
      const record: CrashJournalEvent = { ts: event.ts ?? new Date().toISOString(), ...event }
      const line = `${JSON.stringify(record)}\n`
      const bytes = Buffer.byteLength(line, 'utf8')
      if (!this.ensureOpened()) return
      // size 轮转（写入字节计数，写前判定）：超阈值 → 同步级联，本行写新档
      if (this.bytesWritten + bytes > this.maxFileBytes) this.cascadeSegments()
      appendFileSync(this.baseFile, line)
      this.bytesWritten += bytes
    } catch {
      this.reportWriteFailure(`append failed: ${this.baseFile}`)
    }
  }

  async close(): Promise<void> {
    // 同步形态无在途数据（appendFileSync 完成即落盘），close 只需关断后续写入
    this.ended = true
  }

  /**
   * 惰性打开：stat 弥合跨重启字节计数（进程内计数不覆盖历史）+ 首开越限级联
   * （上次运行崩溃遗留的超大档先滚一段再续写，10MB 上限按文件绝对大小跨重启成立）。
   */
  private ensureOpened(): boolean {
    if (this.opened) return true
    this.opened = true
    this.bytesWritten = statSizeSafe(this.baseFile)
    if (this.bytesWritten > this.maxFileBytes) this.cascadeSegments()
    return true
  }

  /**
   * 末 3 段级联：删最旧 `.2` → `.1`→`.2` → 活跃档→`.1`。
   *
   * 逐点容错（首轮轮转时 `.2`/`.1` 不存在是常态）：unlink/rename ENOENT 容错跳过；
   * 活跃档 rename 失败时续写原档（仅丢失滚动、数据不丢，对齐 logger.ts 容错语义）。
   */
  private cascadeSegments(): void {
    const [seg1, seg2] = SEGMENT_SUFFIXES.map((s) => `${this.baseFile}${s}`)
    try {
      unlinkSync(seg2)
    // eslint-disable-next-line taste/no-silent-catch -- ENOENT = 首轮/无最旧段常态；unlink 失败不阻塞级联
    } catch {
      // no-op
    }
    try {
      renameSync(seg1, seg2)
    // eslint-disable-next-line taste/no-silent-catch -- ENOENT = 首轮常态；次新段缺位不阻塞顶档滚动
    } catch {
      // no-op
    }
    try {
      renameSync(this.baseFile, seg1)
    // eslint-disable-next-line taste/no-silent-catch -- 顶档滚动失败不阻塞写入；续写原档，仅丢失轮转、数据不丢
    } catch {
      // no-op
    }
    this.bytesWritten = 0
  }

  /** 失败上报（writer 级 once：首个失败记主日志 warn，后续静默）。 */
  private reportWriteFailure(message: string): void {
    if (this.errorReported) return
    this.errorReported = true
    reportWriteFailureOnce(message)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// runtime 侧单例（对齐 logger.ts 既有单例风格：组合根 init + 模块级单例 + 未初始化 no-op）
// ─────────────────────────────────────────────────────────────────────────────

/** runtime 单例（写 runtime.jsonl；D1 双文件的 runtime 半边）。 */
let runtimeSingleton: CrashJournalFileWriter | undefined

/** 未初始化时的 no-op writer（单元测试零副作用，对齐 createPiSessionLog 未初始化契约）。 */
const NOOP_CRASH_JOURNAL: CrashJournalWriter = { append: () => {} }

/**
 * 初始化 runtime 台账单例（组合根 index.ts 最早处调一次，幂等）。
 *
 * @param dataDir 数据根目录；缺省 getDataDir() 动态推导（TAIJI_AGENT_DATA_DIR 可覆盖）
 * @param logSink 留痕出口（write 失败的 warn）；生产 = 组合根注入 logger 单例
 *   （循环依赖零容忍：本模块不 import logger，反向边已删）。缺省维持当前 sink
 *   （未注入过则为 no-op）——测试直接构造、main 侧双胞胎零副作用。
 */
export function initCrashJournal(
  dataDir: string = getDataDir(),
  logSink?: CrashJournalLogSink,
): CrashJournalWriter {
  if (logSink) journalLogSink = logSink
  runtimeSingleton ??= createCrashJournalWriter({ role: 'runtime', dataDir })
  return runtimeSingleton
}

/** 获取 runtime 台账单例；未初始化时返回 no-op writer。 */
export function getCrashJournal(): CrashJournalWriter {
  return runtimeSingleton ?? NOOP_CRASH_JOURNAL
}

/**
 * 关闭 runtime 台账单例（shutdown 链挂点，保持 close-crash-journal 步骤；同步形态下
 * append 完成即落盘，close 只关断后续写入）。幂等；close 后 getCrashJournal() 回到 no-op。
 */
export async function closeCrashJournal(): Promise<void> {
  const writer = runtimeSingleton
  runtimeSingleton = undefined
  await writer?.close()
}

// ─────────────────────────────────────────────────────────────────────────────
// 留痕出口（循环依赖破除：logger → crash-journal 单向化，本模块不 import logger）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 台账留痕出口契约（生产 = logger 单例的 warn 子集；组合根 initCrashJournal 注入）。
 * 【oe-audit C3】error 通道随异步流形态消亡（endAndAwait 超时出口已删）一并移除。
 */
export interface CrashJournalLogSink {
  warn(message: string): void
}

/** 未注入时的 no-op sink（测试 / 直接构造零副作用，对齐 logger 未初始化 no-op 契约）。 */
const NOOP_LOG_SINK: CrashJournalLogSink = { warn: () => {} }

let journalLogSink: CrashJournalLogSink = NOOP_LOG_SINK

// ─────────────────────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────────────────────

function statSizeSafe(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0 // ENOENT = 档不存在常态；其余 IO 错误按 0 降级（best-effort）
  }
}

/**
 * 台账写入失败的唯一出口：记 runtime 主日志一条 warn（经注入的 sink 直写文件、不经
 * console patch，与 crash-journal 写失败互不触发递归）。logger 自身写失败由其内部容错。
 * 模块级 once：实例级 once（reportWriteFailure）在其上聚合，防多实例失败风暴刷屏。
 */
let failureReported = false
function reportWriteFailureOnce(message: string): void {
  if (failureReported) return
  failureReported = true
  journalLogSink.warn(`[crash-journal] ${message}`)
}
