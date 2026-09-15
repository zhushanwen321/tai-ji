/**
 * Main 进程日志落盘 writer（crash-resilience §3.3 D6-①）。
 *
 * [HISTORICAL] 背景（E3 事故取证缺口）：main 是四层进程中生命周期最长的进程，但打包版
 * stdout 无人收集、main 的 console 无落盘通道——renderer 崩溃（render-process-gone）、
 * main 侧决策、内存水位全部无痕。本模块显式新建 main 落盘通道，写
 * `logs/main-<date>.log`，承接：main 内存水位（5min 定时器）、render-process-gone 详情
 * （u3 消费）、renderer-log IPC 转发落盘（u2 消费）。
 *
 * 设计：**对齐 packages/runtime/src/infra/logger.ts 的 date+size 双策略轮转惯例**
 * （同构实现而非跨包复用——runtime logger 是绑定 runtime logsDir 的模块级单例，main
 * 无法 import；跨进程共享 writer 也不成立，D6 被否项③）。关键语义逐一继承：
 * - date 轮转：按天文件名，跨天 end 旧流 → 惰性开新日期流（不 rename）
 * - size 轮转：**写入字节计数**（非每行 statSync）触发 .1 滚动，顺序硬约束：
 *   **end 旧流 → 等 'close'（在途写全部落盘）→ rename → 开新流 → 回放队列**——rename
 *   早于 flush 完成会把在途写 orphan 进已改名 inode（runtime 探针实测每边界丢 ~2 行）
 * - WriteStream 缓冲写（热路径无同步盘写）；pendingLines 容量上限防 fs 挂起时无界入队
 * - 写失败容错不杀进程（logger 自身故障不能放大为 main 崩溃）
 * - 保留期清理委托 ./log-retention.ts（init 时跑一次 + 每日定时器复扫）
 *
 * 未 initMainLogger 时全部写入 no-op（单元测试不依赖文件系统、无副作用）。
 *
 * 消费者：main.ts（init + 水位 + before-quit flush）· u2 renderer-log-handler ·
 * u3 render-process-gone 落盘 · supervisor/process-control.ts（size 帽常量复用）。
 */
import { createWriteStream, mkdirSync, renameSync, statSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import { getDataDir } from '@taiji/shared/paths'
import { startLogRetentionTimer, runLogRetentionNow } from './log-retention.js'

// ── 级别 ────────────────────────────────────────────────────────────
export type MainLogLevel = 'debug' | 'info' | 'warn' | 'error'
const LEVEL_ORDER: Record<MainLogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

function parseLevel(env: string | undefined, fallback: MainLogLevel): MainLogLevel {
  const v = (env ?? '').toLowerCase()
  if (v === 'debug' || v === 'info' || v === 'warn' || v === 'error') return v
  return fallback
}

// ── 轮转常量（对齐 runtime logger：TAIJI_LOG_MAX_BYTES / TAIJI_LOG_LEVEL 同名 env 旋钮）──
const BYTES_PER_KB = 1024
const DEFAULT_MAX_FILE_MB = 50
const SECONDS_PER_MINUTE = 60
const MS_PER_SECOND = 1000
/** ISO 日期 YYYY-MM-DD 的字符长度。 */
const ISO_DATE_LENGTH = 10

/**
 * size 轮转帽（字节）：env `TAIJI_LOG_MAX_BYTES` 覆盖 || 50MB 默认。
 *
 * 取值对齐 runtime logger 现值（DEFAULT_MAX_FILE_MB=50，校准依据见其文件头：限流
 * 100 条/分折算的持续错误风暴单日可写数百 MB，无 size 帽不行）。导出为函数供
 * supervisor/process-control.ts（electron-runtime-stderr.log 轮转）复用同一旋钮——
 * main 进程内两个轮转 writer 共用同一 size 语义，不出现两套帽值漂移。
 */
export function readMainLogMaxBytes(): number {
  return Number(process.env.TAIJI_LOG_MAX_BYTES) || DEFAULT_MAX_FILE_MB * BYTES_PER_KB * BYTES_PER_KB
}

// ── 模块状态（对齐 runtime logger 命名与语义）──────────────────────
/** 当前级别。未 init 为 undefined，所有写入/定时器为 no-op。 */
let currentLevel: MainLogLevel | undefined
let logsDir: string | undefined
/** 当前主日志日期（YYYY-MM-DD），跨天检测用。 */
let currentDate = ''
/** 主日志当前写流（按日期惰性打开）；跨天 / size 轮转时 end 后置 undefined。 */
let mainStream: WriteStream | undefined
/** mainStream 对应文件路径（轮转 rename 目标用）。 */
let mainStreamFile: string | undefined
/** 自本次打开以来写入字节数（size 轮转判定）。 */
let mainBytesWritten = 0
/** 异步轮转进行中（end 旧流等待 flush → rename → 开新流）；窗口内写入入 pendingLines。 */
let rotationInFlight: Promise<void> | null = null
/** 轮转窗口内到达的写入行（新流就绪后按序回放；窗口通常 <1ms）。 */
const pendingLines: Array<{ line: string; bytes: number }> = []
/** pendingLines 容量上限：fs 挂起时轮转窗口无限拉长，无界入队会内存膨胀（对齐 runtime）。 */
const MAX_PENDING_LINES = 10_000
/** 当前轮转窗口内因超限丢弃的行数（轮转结束后合并记一次 warn）。 */
let pendingDroppedCount = 0
/** endAndAwait 等待 'close' 的超时：fs 挂起时降级 resolve + 强制销毁流（对齐 runtime 5s）。 */
const END_AWAIT_TIMEOUT_MS = 5_000

/** 内存水位定时器句柄（stopMemoryWatermarkTimer 用）。 */
let watermarkTimer: ReturnType<typeof setInterval> | undefined
/** 保留期清理定时器的 stop 函数（closeMainLogger 用；startLogRetentionTimer 返回值）。 */
let stopRetention: (() => void) | undefined

// ── 初始化 / 关闭 ──────────────────────────────────────────────────

export interface MainLoggerInitOptions {
  /**
   * 打包态判定（级别分档：dev 默认 debug / prod 默认 info，TAIJI_LOG_LEVEL 可覆盖）。
   * main 进程自身进程 env 无 TAIJI_AGENT_PACKAGED（该 env 只在 spawn runtime 时注入），
   * 调用方须注入 app.isPackaged；缺省回退 env 判定（测试/工具进程用）。
   */
  isPackaged?: boolean
}

/**
 * 初始化 main 日志 writer。main.ts 模块加载早期调用一次（幂等）。
 *
 * 副作用：① 创建 <dataDir>/logs/；② 立即跑一次保留期清理 + 挂每日复扫定时器
 * （对齐 runtime initLogger「启动时清理」惯例，每日复扫补长寿窗口——D6-⑦）；
 * ③ 写 initialized 行。定时器均 unref，不 hold 进程退出。
 */
export function initMainLogger(options: MainLoggerInitOptions = {}): void {
  if (currentLevel) return // 已初始化（幂等）
  logsDir = join(getDataDir(), 'logs')
  mkdirSync(logsDir, { recursive: true })
  currentLevel = parseLevel(process.env.TAIJI_LOG_LEVEL, options.isPackaged ? 'info' : 'debug')
  runLogRetentionNow()
  stopRetention = startLogRetentionTimer()
  startMemoryWatermarkTimer()
  writeLogEntry('info', '[main-logger] initialized', { level: currentLevel, dir: logsDir })
}

/**
 * 关闭 main 日志 writer（main.ts before-quit 调用，**必须 await**）。
 *
 * 先停定时器（防 close 窗口内再触发写入），再等待进行中的轮转完成，最后 end 主流并等
 * flush——之后调用方才可 app.quit()（丢缓冲尾部几行 = 硬崩溃同档，已声明可接受；
 * 正常 quit 路径不丢）。幂等：close 后写入/再次 close 均 no-op。
 */
export async function closeMainLogger(): Promise<void> {
  stopMemoryWatermarkTimer()
  stopRetention?.()
  stopRetention = undefined
  if (rotationInFlight) await rotationInFlight
  const stream = mainStream
  const file = mainStreamFile
  mainStream = undefined
  mainStreamFile = undefined
  mainBytesWritten = 0
  pendingLines.length = 0
  currentLevel = undefined
  logsDir = undefined
  currentDate = ''
  await endAndAwait(stream, `main-shutdown:${file ?? 'unnamed'}`)
}

// ── 显式 logger 出口（u2/u3 落盘消费的 API 面）─────────────────────

/**
 * main 进程显式 logger。行格式 `[ISO时间戳] [LEVEL] message {"meta":...}`（验收条款：
 * 日志行含时间戳 + level）。未 init 时 no-op。message 内换行折叠为 ' | ' 单行化
 * （错误栈等多行消息不拆出无时间戳裸行，保 grep/行级解析——对齐 runtime foldNewlines）。
 */
export const mainLogger = {
  debug(message: string, meta?: Record<string, unknown>): void {
    writeLogEntry('debug', message, meta)
  },
  info(message: string, meta?: Record<string, unknown>): void {
    writeLogEntry('info', message, meta)
  },
  warn(message: string, meta?: Record<string, unknown>): void {
    writeLogEntry('warn', message, meta)
  },
  error(message: string, meta?: Record<string, unknown>): void {
    writeLogEntry('error', message, meta)
  },
}

// ── 内存水位定时器（D6-② main 侧）────────────────────────────────

/** 水位打点间隔：5 分钟（设计 D6-② 定值）。 */
const MEMORY_WATERMARK_INTERVAL_MINUTES = 5
const MS_PER_MINUTE = SECONDS_PER_MINUTE * MS_PER_SECOND
const MEMORY_WATERMARK_INTERVAL_MS = MEMORY_WATERMARK_INTERVAL_MINUTES * MS_PER_MINUTE

/**
 * 挂 main 内存水位定时器：每 5 分钟一行 process.memoryUsage() 进 main log。
 *
 * 验收形态：`[ISO] [INFO] [main] memory watermark {"rss":...,"heapUsed":...,
 * "heapTotal":...,"external":...}`——崩溃取证（G5）回答「崩前内存水位」的数据源。
 * initMainLogger 时自动挂载（dev/prod 同频——水位是取证基线不是调试项）。
 */
export function startMemoryWatermarkTimer(): () => void {
  if (!currentLevel || watermarkTimer) return () => {} // 未 init / 已挂载：no-op
  watermarkTimer = setInterval(() => {
    const mem = process.memoryUsage()
    mainLogger.info('[main] memory watermark', {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
    })
  }, MEMORY_WATERMARK_INTERVAL_MS)
  watermarkTimer.unref?.()
  return stopMemoryWatermarkTimer
}

function stopMemoryWatermarkTimer(): void {
  if (watermarkTimer) {
    clearInterval(watermarkTimer)
    watermarkTimer = undefined
  }
}

// ── 写入核心（对齐 runtime logger writeLogEntry / rotateMain / openMainStream）──

/**
 * 折叠消息中的换行为单行分隔符（对齐 runtime logger foldNewlines）。
 * 日志文件按「一行一条目」组织，多行消息（u2 落盘的错误栈）会拆出无时间戳的裸次行，
 * 破坏 grep 与行级解析。首尾换行去除，中间换行折叠为 ' | '。
 */
function foldNewlines(s: string): string {
  return s.replace(/^[\r\n]+|[\r\n]+$/g, '').replace(/[\r\n]+/g, ' | ')
}

/**
 * 写一条日志（写入唯一出口）。WriteStream 缓冲写；轮转判定用写入字节计数。
 * 轮转窗口内到达的行入 pendingLines，由轮转续体在新流就绪后按序回放——同步路径
 * 零阻塞、零丢失（size 轮转）或按日期换文件（date 轮转）。
 */
function writeLogEntry(level: MainLogLevel, message: string, meta?: Record<string, unknown>): void {
  if (!currentLevel || !logsDir) return
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return
  const today = new Date().toISOString().slice(0, ISO_DATE_LENGTH)
  const metaStr = meta ? ' ' + JSON.stringify(meta) : ''
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${foldNewlines(message)}${metaStr}\n`
  const bytes = Buffer.byteLength(line, 'utf8')
  try {
    if (rotationInFlight) {
      if (pendingLines.length >= MAX_PENDING_LINES) {
        pendingDroppedCount++
        return
      }
      pendingLines.push({ line, bytes })
      return
    }
    // 跨天：end 旧流（旧日期文件保持原状）→ 开新日期流。本行入队待新流回放。
    if (currentDate !== today) {
      if (mainStream) {
        void rotateMain(today, false)
        pendingLines.push({ line, bytes })
        return
      }
      currentDate = today
    }
    // size 轮转（字节计数）：超阈值 → 异步「end 旧流 → rename → 开新流」，本行入队。
    if (mainStream && mainStreamFile && mainBytesWritten + bytes > readMainLogMaxBytes()) {
      void rotateMain(today, true)
      pendingLines.push({ line, bytes })
      return
    }
    if (!mainStream) {
      openMainStream(today)
    }
    const stream = mainStream
    if (!stream) return // 打开失败（异常路径）→ 本轮丢弃，不抛
    stream.write(line)
    mainBytesWritten += bytes
  // eslint-disable-next-line taste/no-silent-catch -- logger 自身写入失败（磁盘满/权限等）不能杀 main 进程；无可靠诊断出口，吞没是刻意容错（对齐 runtime logger）
  } catch {
    // no-op
  }
}

/**
 * 异步轮转主日志：end 旧流并等 flush 完成 →（size 轮转时）rename → 开新流 → 回放队列。
 * 顺序硬约束与幂等并发语义见文件头（对齐 runtime rotateMain，含探针实测依据）。
 */
function rotateMain(nextToday: string, renameOld: boolean): Promise<void> {
  if (rotationInFlight) return rotationInFlight
  const oldStream = mainStream
  const oldFile = mainStreamFile
  mainStream = undefined
  mainStreamFile = undefined
  mainBytesWritten = 0
  rotationInFlight = (async () => {
    if (oldStream) await endAndAwait(oldStream, `main-rotation:${oldFile ?? 'unnamed'}`)
    if (renameOld && oldFile) {
      try {
        renameSync(oldFile, `${oldFile}.1`)
      // eslint-disable-next-line taste/no-silent-catch -- rename 失败（IO 错/权限）不阻塞写入；新流仍写主文件，仅丢失滚动，数据不丢（对齐 runtime）
      } catch {
        // no-op
      }
    }
    currentDate = nextToday
    const stream = openMainStream(nextToday)
    const pending = pendingLines.splice(0)
    if (stream) {
      for (const p of pending) {
        stream.write(p.line)
        mainBytesWritten += p.bytes
      }
    } else if (pending.length > 0) {
      pendingDroppedCount += pending.length
    }
    rotationInFlight = null
    if (pendingDroppedCount > 0) {
      const dropped = pendingDroppedCount
      pendingDroppedCount = 0
      writeLogEntry('warn', `[main-logger] dropped ${dropped} log lines (pending queue overflow / replay target unavailable during rotation)`)
    }
  })()
  return rotationInFlight
}

/**
 * 打开（或重开）当天主日志写流。打开前若既有文件已超阈值（上次运行崩溃未轮转、历史
 * 大文件），先滚动一次——进程内字节计数不覆盖历史，此 stat 弥合跨重启的 size 上限
 * （仅打开时一次，非热路径）。
 */
function openMainStream(today: string): WriteStream | undefined {
  if (!logsDir) return undefined
  const file = join(logsDir, `main-${today}.log`)
  try {
    if (existsSyncSafe(file) && statSync(file).size > readMainLogMaxBytes()) {
      renameSync(file, `${file}.1`)
    }
  // eslint-disable-next-line taste/no-silent-catch -- 打开前滚动失败不阻塞写入；best-effort 容错（对齐 runtime）
  } catch {
    // no-op
  }
  try {
    const stream = createWriteStream(file, { flags: 'a' })
    attachStreamErrorHandler(stream, `main:${file}`)
    mainStream = stream
    mainStreamFile = file
    mainBytesWritten = 0
    return stream
  } catch {
    // createWriteStream 同步抛错（非法路径/EMFILE）归一 undefined：调用方降级丢弃，
    // 且不沿 rotationInFlight promise 传播为 unhandled rejection（对齐 runtime createStreamSafe）
    return undefined
  }
}

/**
 * 为写流挂容错 'error' 监听器（异步写错误无监听器会升级为 uncaughtException）。
 * 仅首个 error 记一次受限出口 warn（writeLogEntry 直写、不经 console），后续静默——
 * 写失败路径里再记日志会与写失败互相触发递归（对齐 runtime attachStreamErrorHandler）。
 */
function attachStreamErrorHandler(stream: WriteStream, label: string): void {
  let first = true
  stream.on('error', () => {
    if (!first) return
    first = false
    writeLogEntry('warn', `[main-logger] write stream error (${label}); further errors suppressed`)
  })
}

function existsSyncSafe(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * end 写流并等真正关闭（'close'：fd 已释放、缓冲已 flush）。rename 前必须有「无在途
 * 写」保证。永不 reject；超时降级 resolve + 强制销毁流（防 fs 挂起时轮转/退出永久挂起）。
 * 对齐 runtime endAndAwait（含超时 destroy 与 timer.unref 语义）。
 */
function endAndAwait(stream: WriteStream | undefined, label: string): Promise<void> {
  if (!stream) return Promise.resolve()
  if (stream.closed) return Promise.resolve()
  if (!stream.writableEnded) stream.end()
  if (stream.closed) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let settled = false
    const finish = (timedOut: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stream.removeListener('close', onClose)
      stream.removeListener('error', onError)
      if (timedOut) {
        // 强制销毁释放 fd：不销毁则 fd 悬挂、'close' 永不触发（对齐 runtime 审查 W30 Fix-1）
        stream.destroy()
        writeLogEntry('error', `[main-logger] endAndAwait timeout after ${END_AWAIT_TIMEOUT_MS}ms (${label}); stream force-destroyed, in-flight buffer tail lost`)
      }
      resolve()
    }
    const onClose = (): void => finish(false)
    const onError = (): void => finish(false)
    const timer = setTimeout(() => finish(true), END_AWAIT_TIMEOUT_MS)
    timer.unref?.()
    stream.once('close', onClose)
    stream.once('error', onError)
  })
}
