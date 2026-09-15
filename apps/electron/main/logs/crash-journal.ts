/**
 * Main 进程崩溃台账 writer（crash-forensics-and-watchdog §3.3 D1，实施计划 u1c）。
 *
 * 双文件形态（D1）：main 写 `<dataDir>/logs/crashes/main.jsonl`（main 自身 + renderer
 * 事件），runtime 写同目录 `runtime.jsonl`——与 runtime writer 是**双胞胎独立实现**
 * （main 不 import runtime 包），仅共享 `@taiji/shared` 的 schema 类型（u1a SSOT，
 * 禁止各自复制定义）。事件形态 / 写入点矩阵见设计 D1；消费者 = D2 评估器 + D6 诊断导出。
 *
 * 轮转（D1，对既有 main-logger 单代 `.1` 形态的扩展而非照抄）：单文件 10MB size 轮转，
 * 保留末 3 段级联 rename（`main.jsonl` → `.jsonl.1` → `.jsonl.2`；最老段先删腾位）。
 * 清理**只依赖自带轮转**：`crashes/` 是子目录，cleanExpiredLogs（runtime）与 log-retention
 * （main）均只认顶层平铺前缀、结构性跳过子目录（设计 D1 显式裁决，不修改清理器语义）。
 *
 * 同步 append 的取舍（与 main-logger 缓冲写的分叉点）：台账事件量 KB 级/日 + watermark
 * daily 1 条/日（D2 代价声明），写入频率极低；同步 appendFileSync 使「崩溃瞬间落盘」
 * （探针 P-A1 在场性）不依赖 flush 时机，且轮转无在途写窗口（无 pendingLines 队列），
 * 轮转边界行不丢由实现结构保证而非时序防护。
 *
 * 失败容错（D1 防漏设计前提）：台账是崩溃路径上的旁路，写失败（磁盘满/权限）best-effort
 * 不抛进调用方（接口契约见 shared CrashJournalWriter 注释）；首个失败经 main-logger 记
 * 一次受限 warn，后续静默——失败风暴时写失败路径不得反灌主日志（对齐 main-logger
 * attachStreamErrorHandler 的 first-only 形态）。
 *
 * 未 initCrashJournal 时单例 append 为 no-op（对齐 main-logger：单元测试不依赖文件系统、
 * 无副作用；接线单元在 main.ts init 之后挂接）。
 */
import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { getDataDir } from '@taiji/shared/paths'
import type {
  CrashJournalEvent,
  CrashJournalFileRole,
  CrashJournalWriter,
  CrashJournalWriterOptions,
} from '@taiji/shared'
import { mainLogger } from './main-logger.js'

// ── 常量（D1：单文件 10MB，保留末 3 段 = 主文件 + .1 + .2）────────────
const BYTES_PER_KB = 1024
const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB
const DEFAULT_MAX_FILE_MB = 10
/** 单文件 size 轮转帽默认值（D1 定值；无 env 旋钮——设计 §5 env 清单未含台账项）。 */
const DEFAULT_MAX_FILE_BYTES = DEFAULT_MAX_FILE_MB * BYTES_PER_MB

/** 台账文件名按角色（D1 双文件）；writer 构造时按 role 取名。 */
const FILE_BY_ROLE: Record<CrashJournalFileRole, string> = {
  main: 'main.jsonl',
  runtime: 'runtime.jsonl',
}

/**
 * crashes 目录路径：`<dataDir>/logs/crashes`，从 shared getDataDir() 动态推导
 * （禁止写死绝对路径，仓规：dev/prod/dev-worktree 数据目录不同）。
 * 与 runtime 侧 writer 同目录不同文件（D1 双文件消跨进程写竞争）。
 */
export function getCrashJournalDir(): string {
  return join(getDataDir(), 'logs', 'crashes')
}

/** writer 构造选项：shared 契约（role）+ main 侧注入项（测试注入小阈值/临时目录）。 */
export interface CrashJournalFileWriterOptions extends CrashJournalWriterOptions {
  /** 台账目录；缺省 getCrashJournalDir()（生产路径），测试注入 mkdtemp 自建目录。 */
  dir?: string
  /** 单文件 size 帽（字节）；缺省 10MB（D1）。 */
  maxFileBytes?: number
}

/**
 * 崩溃台账文件 writer：单行 JSONL 同步原子追加 + size 级联轮转。
 *
 * append 语义（shared CrashJournalWriter 接口）：fire-and-forget，任何 fs 失败都不向
 * 调用方抛错。event.ts 缺省/null 时补写落盘时刻（ISO 8601 UTC）——ts 是 D2 评估器窗口
 * 统计的唯一时间轴，缺行即对窗口统计不可见，补写是「不知道 ≠ 没打点」（D1 字段原则）
 * 在时间维度的兑现；其余字段原样序列化，writer 不擅自填充业务字段。
 */
export class CrashJournalFileWriter implements CrashJournalWriter {
  private readonly dir: string
  private readonly maxFileBytes: number
  private readonly mainFile: string
  /** 主文件自打开（或跨重启 stat 弥合）以来的字节数（轮转判定，main-logger 同款计数）。 */
  private bytesWritten = 0
  /** 惰性打开标记：首次 append 时建目录 + 读既有主文件 size。 */
  private opened = false
  /** 首个写失败已上报标记（first-only，防失败风暴反灌主日志）。 */
  private failureReported = false

  constructor(options: CrashJournalFileWriterOptions) {
    this.dir = options.dir ?? getCrashJournalDir()
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    this.mainFile = join(this.dir, FILE_BY_ROLE[options.role])
  }

  append(event: CrashJournalEvent): void {
    // ts 缺省补落盘时刻；JSON.stringify 保证单行（值内换行被转义），行级 JSONL 恒成立
    const normalized: CrashJournalEvent = event.ts ? event : { ...event, ts: new Date().toISOString() }
    let line: string
    try {
      line = JSON.stringify(normalized) + '\n'
    } catch {
      // 循环引用等不可序列化 event：本行放弃，不抛（接线侧 bug 不经台账放大）
      this.reportWriteFailureOnce('serialize')
      return
    }
    const bytes = Buffer.byteLength(line, 'utf8')
    try {
      if (!this.ensureOpened()) return
      // size 轮转（写入前预测，main-logger 同款判定）：本行将使主文件越帽 → 先级联滚动
      if (this.bytesWritten + bytes > this.maxFileBytes) this.rotate()
      appendFileSync(this.mainFile, line)
      this.bytesWritten += bytes
    } catch {
      this.reportWriteFailureOnce('append')
    }
  }

  /**
   * 惰性打开：建目录（每条 append 都尝试，磁盘满恢复后自愈）+ stat 弥合跨重启 size
   * （进程内字节计数不覆盖历史——上次运行崩溃未轮转的超阈主文件在下条 append 触发
   * 轮转，main-logger openMainStream 同款语义，stat 仅首次一次非热路径）。
   */
  private ensureOpened(): boolean {
    if (this.opened) return true
    try {
      mkdirSync(this.dir, { recursive: true })
    } catch {
      // 目录建不了（EEXIST-同名文件 / EACCES）：后续 append 仍会重试，此处仅本次放弃
      this.reportWriteFailureOnce('mkdir')
      return false
    }
    try {
      this.bytesWritten = statSync(this.mainFile).size
    } catch {
      this.bytesWritten = 0 // ENOENT = 全新台账（常态），其他错误同归零（下条写入重建）
    }
    this.opened = true
    return true
  }

  /**
   * 级联轮转（D1 定值三段：主文件 + `.1` + `.2`，对齐 runtime 侧 SEGMENT_SUFFIXES 形态）：
   * 最老段先删腾位 → 逐代 rename 上移（`.1`→`.2`，主文件→`.1`）。
   * 顺序硬约束：必须从最老代开始，保证每个 rename 的目标不存在（POSIX 原子覆盖 /
   * Windows 目标已存即失败——从老到新腾位使两平台语义一致）。全部 best-effort：
   * 单步失败不阻塞后续步（数据不丢优先于段位整齐——rename 失败时主文件继续写，仅
   * 丢失该次滚动）。首启无旧段时 ENOENT 是常态，静默。
   */
  private rotate(): void {
    try {
      unlinkSync(`${this.mainFile}.2`)
    // eslint-disable-next-line taste/no-silent-catch -- 最老段 unlink 的 ENOENT 是首启常态；IO 错误 best-effort 不阻塞级联后续步（对齐 rotate 整体容错）
    } catch {
      // no-op
    }
    try {
      renameSync(`${this.mainFile}.1`, `${this.mainFile}.2`)
    // eslint-disable-next-line taste/no-silent-catch -- 轮转 rename 失败不阻塞写入链路；主文件续写数据不丢，仅丢该次滚动（对齐 main-logger rotateMain 容错）
    } catch {
      // no-op
    }
    try {
      renameSync(this.mainFile, `${this.mainFile}.1`)
    // eslint-disable-next-line taste/no-silent-catch -- 同上：主文件→.1 失败仅丢该次滚动，appendFileSync 续写数据不丢
    } catch {
      // no-op
    }
    this.bytesWritten = 0
  }

  /** 首个写失败经 main-logger 记一次受限 warn，后续静默（first-only，见文件头）。 */
  private reportWriteFailureOnce(phase: string): void {
    if (this.failureReported) return
    this.failureReported = true
    try {
      mainLogger.warn(`[crash-journal] append failed at ${phase} (${this.mainFile}); further failures suppressed`)
    // eslint-disable-next-line taste/no-silent-catch -- main-logger 自身故障（未 init 为 no-op 不会抛；其余为盘故障）不得反噬台账调用方
    } catch {
      // no-op
    }
  }
}

// ── 模块级单例（对齐 main-logger：显式 init 幂等 + 未 init 写入 no-op）────────

let instance: CrashJournalFileWriter | undefined

/** main 侧单例 init 选项：role 固定 'main'（本文件只写 main.jsonl），仅开放注入项。 */
export type CrashJournalInitOptions = Omit<CrashJournalFileWriterOptions, 'role'>

/**
 * 初始化 main 崩溃台账单例（main.ts 模块加载早期调用一次，幂等）。
 * 纯惰性 IO：目录在首条 append 时才创建，init 本身零副作用。
 */
export function initCrashJournal(options: CrashJournalInitOptions = {}): void {
  if (instance) return // 已初始化（幂等）
  instance = new CrashJournalFileWriter({ role: 'main', ...options })
}

/**
 * main 崩溃台账单例出口（接线单元消费面：crashJournal.append(event)）。
 * 未 init 时 no-op（对齐 main-logger：不抛错、不建文件）。
 */
export const crashJournal = {
  append(event: CrashJournalEvent): void {
    instance?.append(event)
  },
}
