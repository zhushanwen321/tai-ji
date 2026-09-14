/**
 * Runtime 日志持久化模块（架构约定 #4）。
 *
 * [HISTORICAL] 背景：handoff 2026-07-04 P1「pi 静默卡死」——坏 session 的 JSONL 只有 2 行、
 * 零 message，pi 子进程 0% CPU 不退出。runtime 发了 prompt 后 pi 发了什么事件（或什么都没发）
 * 无法事后追溯，因为日志只在 concurrently 终端，关掉即丢。本模块把 runtime + pi 日志持久化
 * 到文件，并按天/大小轮转，避免磁盘膨胀。
 *
 * 设计（perf W30 / 06 §3.3 D10-1、D10-2）：
 * - 纯 node:fs 自实现轮转，**零第三方依赖**（不动 tsup noExternal，规避规则 #12 摩擦）
 * - **WriteStream 缓冲写**：主日志与 pi session log 均用 createWriteStream(flags:'a') 常驻写流，
 *   替代 appendFileSync 同步盘写（旧实现的每行同步写是热路径阻塞点）
 * - date 轮转：按天文件名（runtime-YYYY-MM-DD.log），跨天 end 旧流 → 惰性开新日期流
 * - size 轮转：按**写入字节计数**（替代 statSync）触发 .1 滚动，顺序硬约束（审查 m-6）：
 *   **end 旧流 → rename → 开新流**——且必须**异步等待旧流 'close'（全部在途 fs.write 落盘）
 *   后再 rename**：rename 早于 flush 完成时，旧流在途写会落进已改名 inode，而单代 .1
 *   在下一次轮转时被新 inode 覆盖路径，在途数据随之丢失（探针实测每个轮转边界丢 ~2 行）。
 *   轮转窗口内到达的写入行暂存内存队列，新流就绪后按序回放（窗口通常 <1ms）
 * - pi 流 size 轮转（2026-09 磁盘膨胀修复）：pi tee 与主日志**共用 MAX_FILE_BYTES 与写入字节
 *   计数**，达阈值 → end 旧流等待 flush → zlib 流式 gzip 为 `<file>.1.gz`（**只保留 1 代**，
 *   下一次轮转 rename 覆盖）→ 重开新流写原路径 → 回放轮转窗口内的行。磁盘上限 ≈ 当前文件
 *   （≤ MAX_FILE_BYTES + 回放队列）+ 1 个压缩代（产物通常远小于阈值）。**逐行原样写 JSONL
 *   的铁律不变**（禁合并 delta / 采样 / 丢弃行——tee 的定位是「pi 卡死时唯一诊断证据」，
 *   保真优先于体积；压缩只改存储形态、不改内容形态）。gzip/IO 失败 best-effort：保留原文件
 *   + warn 一次，写入本体不中断
 * - 保留期：启动时清理 KEEP_DAYS 天前的日志
 * - 级别：dev 默认 debug，prod 默认 info，XYZ_LOG_LEVEL 可覆盖（XYZ_ 前缀自动过白名单）
 * - pi stdout JSONL 独立落盘：pi-<date>-<sessionId>.jsonl（卡死诊断的决定性证据），同款 size
 *   轮转（达阈值 gzip 归档为 <原路径>.1.gz）
 * - 退出 flush（D10-1 分档承诺的配套）：shutdown 链必须 `await closeLogger()`（主日志 +
 *   全部 pi session 写流 end 并等 flush 完成）后再 process.exit(0)；硬崩溃（SIGKILL/断电）
 *   丢缓冲窗口内尾部几行已声明为取证能力削弱
 * - 挂起兜底（审查 W30 Fix-1）：endAndAwait 等 'close' 有 5s 超时降级——超时强制销毁流 +
 *   记 error 级日志（fs 挂起时 closeLogger/轮转不永久阻塞），轮转窗口 pendingLines 有
 *   10_000 行容量上限（超限丢弃、合并记一次 warn）
 *
 * 用法（组合根 index.ts 初始化）：
 *   initLogger(getDataDir())                // 初始化全局 logger + patch console
 *   const sessionLog = createPiSessionLog(sessionId)  // pi stdout tee
 *   sessionLog.write(line)
 *   sessionLog.end()
 *   await closeLogger()                     // shutdown：flush 所有写流后进程才可退出
 */
import { createReadStream, createWriteStream, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
// [crash-resilience §3.3 D6-⑦] 保留天数两进程共读同一函数（env 覆盖 || 默认）——merge 裁决保留 shared SSOT 形态
import { readLogKeepDays } from '@xyz-agent/shared'
import { createGzip } from 'node:zlib'
import { isPackaged } from '../utils/runtime-env.js'
// endAndAwait 单一实现（偏差 #32①：原模块私有复刻与 crash-journal 同构，收敛共享原语；
// 超时留痕出口 reportEndAwaitTimeout 保持本模块注入）
import { END_AWAIT_TIMEOUT_MS, endAndAwaitStream } from './stream-end-await.js'
import { getCrashJournal } from './crash-journal.js'

// ── 级别 ────────────────────────────────────────────────────────────
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

function parseLevel(env: string | undefined, fallback: LogLevel): LogLevel {
  const v = (env ?? '').toLowerCase()
  if (v === 'debug' || v === 'info' || v === 'warn' || v === 'error') return v
  return fallback
}

// ── 轮转常量（env 可覆盖，走 XYZ_ 白名单前缀自动透传）────────────────
const BYTES_PER_KB = 1024
const DEFAULT_MAX_FILE_MB = 50
const MAX_FILE_BYTES = Number(process.env.XYZ_LOG_MAX_BYTES) || DEFAULT_MAX_FILE_MB * BYTES_PER_KB * BYTES_PER_KB
/**
 * pi tee 单文件 size 轮转阈值（crash-forensics §3.3 D7：50MB 上限，收口 198MB 实证）。
 * [dev-0.9.17 合并] pi tee 与主日志共用 MAX_FILE_BYTES（XYZ_LOG_MAX_BYTES env 单旋钮），
 * 无独立阈值常量——u9 的 opts.maxBytes 注入面与 PI_TEE_MAX_FILE_BYTES 已随 .1.gz
 * gzip 实现取代而删除（裁决见 crash-forensics impl-plan §7 v5）。
 */
const SECONDS_PER_MINUTE = 60
const HOURS_PER_DAY = 24
const MS_PER_SECOND = 1000
const MS_PER_DAY = HOURS_PER_DAY * SECONDS_PER_MINUTE * SECONDS_PER_MINUTE * MS_PER_SECOND
/** ISO 日期 YYYY-MM-DD 的字符长度。 */
const ISO_DATE_LENGTH = 10
/** UUID v7 长度上限（pi sessionId 是 UUID，截断防超长文件名）。 */
const SESSION_ID_MAX_LENGTH = 36

/** 当前级别（initLogger 时定，模块级单例）。未 init 前为 undefined，所有写入降级为 no-op。 */
let currentLevel: LogLevel | undefined
let logsDir: string | undefined

/** 当前 runtime 主日志的日期（YYYY-MM-DD），跨天检测用。 */
let currentDate = ''

// ── 主日志写流状态（D10-1：WriteStream 缓冲写 + 字节计数轮转）─────────
/** 主日志当前写流（按日期惰性打开）；跨天 / size 轮转时 end 后置 undefined。 */
let mainStream: WriteStream | undefined
/** mainStream 对应的文件路径（轮转 rename 目标用）。 */
let mainStreamFile: string | undefined
/** 自本次打开以来写入主日志的字节数（size 轮转判定，替代每行 statSync）。 */
let mainBytesWritten = 0

/** 异步轮转进行中（end 旧流等待 flush 完成 → rename → 开新流）。 */
let rotationInFlight: Promise<void> | null = null
/** 轮转窗口内到达的写入行（新流就绪后按序回放；窗口通常 <1ms）。 */
const pendingLines: Array<{ line: string; bytes: number }> = []
/** pendingLines 容量上限：fs 挂起时轮转窗口无限拉长，无界入队会内存膨胀（审查 W30 Fix-1）。 */
const MAX_PENDING_LINES = 10_000
/** 当前轮转窗口内因超限丢弃的行数（轮转结束后合并记一次 warn，不在热路径递归记日志）。 */
let pendingDroppedCount = 0

// ── pi 流 size 轮转常量 ─────────────────────────────────────────────
/** 压缩产物后缀：**单代**（下一次轮转 rename 覆盖同名文件，磁盘上恒只有 1 个压缩代）。 */
const PI_GZIP_SUFFIX = '.1.gz'
/** 压缩中间名：pipeline 成功后才 rename 到最终名——失败路径删除它，不污染单代语义。 */
const PI_GZIP_TMP_SUFFIX = '.1.gz.tmp'
/**
 * gzip 兜底超时（防挂死）：压缩对象是已关闭、大小 ≤ MAX_FILE_BYTES 的本地文件，正常 <1s；
 * 10s = 该量级的 10 倍余量，且让 closeLogger（同批 await 在途轮转）的总兜底等待保持在
 * supervisor SIGTERM→SIGKILL 升级线以内。超时中止压缩并走失败分支（保留原文件，不丢数据）。
 */
const GZIP_TIMEOUT_MS = 10_000

// ── pi session 写流注册表（D10-1 退出 flush：closeLogger 统一 end + 等待）──
interface PiStreamState {
  /** 惰性打开：首次 write 才建流。轮转窗口内为 undefined（新流由轮转续体重开）。 */
  stream: WriteStream | undefined
  /** end() 已调（write 后续为 no-op）。保留注册直到 closeLogger，确保退出 flush 覆盖。 */
  ended: boolean
  /** 目标文件路径（closeLogger 端 endAndAwait 超时报告的 label 用；轮转 rename 的源）。 */
  file: string
  /** 自本次打开以来写入该文件的字节数（size 轮转判定，与主日志 mainBytesWritten 同款计数）。 */
  bytesWritten: number
  /** 轮转进行中（end 旧流等待 flush → gzip → 重开新流）；窗口内重复触发复用同一 promise。 */
  rotationInFlight: Promise<void> | null
  /** 轮转窗口内到达的行（新流就绪后按序回放；窗口 = 旧流 close 等待 + gzip 压缩耗时）。 */
  pending: Array<{ data: string | Uint8Array; bytes: number }>
  /** 本文件轮转窗口内因队列超限 / 新流不可用丢弃的行数（轮转结束合并记一次 warn）。 */
  dropped: number
}
const openPiStreams = new Set<PiStreamState>()

/**
 * G2 活性无界治理（docs/design/memory-leak-remediation.md §3.4）：流确认 close 后从
 * openPiStreams 摘除。每个 pi spawn（主 session / withEphemeralPi / relay subagent /
 * crash log）各注册一条，原实现唯一清理点是 runtime 退出的 closeLogger——长跑进程内
 * Set 随工作流强度无界增长（~0.5-2KB/条，两组审计独立发现）。摘除条件三合一（全满足才删）：
 * - ended：写入已终止（write 第一道守卫），不再有新数据进流；
 * - 无在途轮转：轮转续体可能重开新流回放 pending 行（rotatePiStream），窗口内摘除会让
 *   closeLogger 漏等回放流；
 * - 无存活流（undefined 或 destroyed）：'close' 事件即 fd 已释放、缓冲全量落盘——
 *   **已 close 的流没有在途数据**，closeLogger 兜底等待契约不变（摘除条目无可等待者）。
 * 触发点：各写流 'close' 监听器（ensurePiStream / 轮转重开处挂）、end()（流从未打开 /
 * 已 destroyed 时无 close 事件可等）、轮转续体 finally（覆盖「轮转窗口内 end 且未重开流」
 * ——该路径无新 close 事件可达）。
 */
function maybeRetirePiStream(state: PiStreamState): void {
  if (state.ended && state.rotationInFlight === null && (state.stream === undefined || state.stream.destroyed)) {
    openPiStreams.delete(state)
  }
}

/** 测试钩子：openPiStreams 当前条目数（G2 摘除断言用；生产代码零消费）。 */
export function _openPiStreamCountForTest(): number {
  return openPiStreams.size
}

/**
 * 初始化全局 logger。组合根（index.ts main 最早处）调用一次。
 *
 * 副作用：
 * 1. 创建 logsDir（<dataDir>/logs/）
 * 2. 清理过期日志（KEEP_DAYS 天前）
 * 3. monkey-patch console.log/warn/error → tee（终端 + 文件）
 *
 * 未调用时（如单元测试），console 保持原生，所有 logger 写入为 no-op——
 * 保证测试不依赖文件系统、不产生副作用。
 */
export function initLogger(dataDir: string): void {
  if (currentLevel) return // 已初始化（幂等）
  logsDir = join(dataDir, 'logs')
  mkdirSync(logsDir, { recursive: true })
  // dev 默认 debug（含 pi 事件流），prod 默认 info（屏蔽 pi 原始事件，避 PII/性能/磁盘）
  currentLevel = parseLevel(process.env.XYZ_LOG_LEVEL, isPackaged() ? 'info' : 'debug')
  cleanExpiredLogs()
  patchConsole()
  writeLogEntry('info', '[logger] initialized', { level: currentLevel, dir: logsDir })
}

/**
 * 把消息中的换行折叠为单行分隔符（终审 minor）。
 *
 * 为什么：日志文件按「一行一条目」组织（时间戳 + 级别前缀），多行消息（如 index.ts
 * shutdown 的 `\n[runtime] received SIGTERM...` 模板串）会拆出「无时间戳的裸次行」，
 * 破坏 grep 与行级解析。在 writeLogEntry（写行唯一出口）折叠，覆盖 console patch
 * （formatArgs 产出）与显式 logger 调用两条入口；终端输出（originalConsole）保持原样。
 * 首尾换行直接去除（调用点用前导 \n 与终端前序输出隔行是终端可读性习惯，文件里无意义），
 * 中间换行折叠为 ' | ' 保留行边界。
 */
function foldNewlines(s: string): string {
  return s.replace(/^[\r\n]+|[\r\n]+$/g, '').replace(/[\r\n]+/g, ' | ')
}

/**
 * 内部：写一条日志到 runtime 主日志文件（含级别 + 时间戳前缀）。
 *
 * D10-1 起为 WriteStream 缓冲写：write() 只入 Node 内部缓冲（非阻塞），
 * 由事件循环异步落盘——热路径（streaming 期间每事件 console 输出）不再有同步盘写。
 * 轮转判定用写入字节计数（mainBytesWritten），替代旧 appendFileSync 方案的每行 statSync。
 *
 * 轮转是异步的（end 旧流须等待 flush 完成才能 rename，见 rotateMain）；轮转窗口内
 * 到达的行先入 pendingLines 队列，由 rotateMain 续体在新流就绪后按序回放——同步写入
 * 路径在轮转期间零阻塞、零丢失。
 */
function writeLogEntry(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (!currentLevel || !logsDir) return
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return
  const today = new Date().toISOString().slice(0, ISO_DATE_LENGTH)
  const metaStr = meta ? ' ' + JSON.stringify(meta) : ''
  // JSON.stringify(meta) 不产生裸换行（转义为 \\n），无需折叠；message 统一折叠单行化
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${foldNewlines(message)}${metaStr}\n`
  const bytes = Buffer.byteLength(line, 'utf8')
  try {
    // 轮转进行中（end 旧流等待 flush 的窗口）：行先入队，续体在新流就绪后回放。
    if (rotationInFlight) {
      // 容量上限（审查 W30 Fix-1）：fs 挂起时轮转窗口无限拉长，无界入队会内存膨胀；
      // 超限行丢弃并计数，轮转结束后合并记一次 warn（见 rotateMain，不在热路径递归记日志）。
      if (pendingLines.length >= MAX_PENDING_LINES) {
        pendingDroppedCount++
        return
      }
      pendingLines.push({ line, bytes })
      return
    }
    // 跨天：end 旧流（旧日期文件保持原状）→ 开新日期流。异步轮转，本行入队。
    if (currentDate !== today) {
      if (mainStream) {
        void rotateMain(today, false)
        pendingLines.push({ line, bytes })
        return
      }
      currentDate = today
    }
    // size 轮转（写入字节计数）：超阈值 → 异步「end 旧流 → rename → 开新流」，本行入队。
    if (mainStream && mainStreamFile && mainBytesWritten + bytes > MAX_FILE_BYTES) {
      void rotateMain(today, true)
      pendingLines.push({ line, bytes })
      return
    }
    if (!mainStream) {
      openMainStream(today)
    }
    const stream = mainStream
    if (!stream) return // 打开失败（异常路径）→ 本轮丢弃，不抛
    // write 返回 false = 背压（缓冲堆积）。日志行量级 KB、磁盘正常不触发；慢盘时内存
    // 增长与轮转窗口 pendingLines 同源，已由容量上限兜底（审查 W30 Fix-6）。
    stream.write(line)
    mainBytesWritten += bytes
  // eslint-disable-next-line taste/no-silent-catch -- logger 自身写入失败（磁盘满/权限等）不能杀进程；console 已被 patch，无可靠诊断出口，吞没是刻意容错
  } catch {
    // no-op
  }
}

/**
 * 异步轮转主日志：end 旧流并**等待 flush 完成** →（size 轮转时）rename → 开新流 → 回放队列。
 *
 * 顺序硬约束（06 §3.3 D10-1 / 审查 m-6）：必须先等旧流 'close'（fd 关闭、全部在途
 * fs.write 落盘）再 rename——否则 rename 后旧流在途写会落进已改名 inode，而单代 .1
 * 在下一次轮转时被新 inode 覆盖路径，在途数据随之丢失（探针实测：rename 早于 flush
 * 完成时每个轮转边界丢 ~2 行）。
 *
 * 幂等并发：轮转窗口内的重复触发复用同一 promise（写入行统一走 pendingLines 队列）。
 */
function rotateMain(nextToday: string, renameOld: boolean): Promise<void> {
  if (rotationInFlight) return rotationInFlight
  const oldStream = mainStream
  const oldFile = mainStreamFile
  // 状态先行清空：轮转窗口内到达的行统一入队（writeLogEntry 的 rotationInFlight 分支）
  mainStream = undefined
  mainStreamFile = undefined
  mainBytesWritten = 0
  rotationInFlight = (async () => {
    if (oldStream) await endAndAwait(oldStream, `main-rotation:${oldFile ?? 'unnamed'}`)
    if (renameOld && oldFile) {
      try {
        renameSync(oldFile, `${oldFile}.1`)
      // eslint-disable-next-line taste/no-silent-catch -- 轮转失败（rename IO 错/权限）不阻塞写入；logger 自身容错，吞没是刻意设计
      } catch {
        // no-op（rename 失败：新流仍写主文件，仅丢失滚动，数据不丢）
      }
    }
    currentDate = nextToday
    const stream = openMainStream(nextToday)
    // 回放轮转窗口内到达的行（续体在微任务队列原子执行，无并发写入插队）
    const pending = pendingLines.splice(0)
    if (stream) {
      for (const p of pending) {
        stream.write(p.line)
        mainBytesWritten += p.bytes
      }
    } else if (pending.length > 0) {
      // 新流打开失败（终审 suggestion）：已 splice 出的回放行无目标流可写，丢弃但必须
      // 计数——对齐超限丢弃的 pendingDroppedCount 出口（不静默），由下方合并 warn 报数
      pendingDroppedCount += pending.length
    }
    rotationInFlight = null
    // 轮转窗口超长（fs 挂起）导致的超限丢弃：合并记一次 warn。此时 rotationInFlight 已清，
    // writeLogEntry 走正常路径（写新流），不递归。受影响的只是缓冲窗口内的日志行——降级可接受。
    if (pendingDroppedCount > 0) {
      const dropped = pendingDroppedCount
      pendingDroppedCount = 0
      writeLogEntry('warn', `[logger] dropped ${dropped} log lines (pending queue overflow / replay target unavailable during rotation)`)
    }
  })()
  return rotationInFlight
}

/**
 * 为 WriteStream 挂容错 'error' 监听器（磁盘满/权限等异步写错误，无监听器会升级为
 * uncaughtException）。
 *
 * 静默吞、不记 console：console 已被 patch（console.error → writeLogEntry），error 处理
 * 里再记 console 会与写失败互相触发形成递归。仅丢日志、不杀进程（与旧 appendFileSync
 * 的 try/catch 容错契约一致）。首个 error 降级记一次**受限出口**——writeLogEntry 直写
 * 主日志文件、不经 console，其自身失败静默（写失败路径已由本监听器吞掉），不构成递归。
 */
function attachStreamErrorHandler(stream: WriteStream, label: string): void {
  let first = true
  stream.on('error', () => {
    if (!first) return
    first = false
    writeLogEntry('warn', `[logger] write stream error (${label}); further errors suppressed`)
  })
}

/**
 * 打开（或重开）当天主日志写流。惰性：仅在首次写入 / 跨天 / size 轮转后调用。
 *
 * 打开前若磁盘上既有文件已超阈值（如上次运行崩溃未轮转、历史大文件），先滚动一次——
 * 进程内字节计数不覆盖历史，此 stat 弥合跨重启的 size 上限（仅打开时一次，非热路径）。
 *
 * 返回新流（失败返回 undefined）。调用方应使用返回值而非重读 mainStream——TS 对
 * 模块级变量的 CFA 会在「先赋 undefined 再读」的闭包路径里把 mainStream 窄化为
 * undefined，直接读会得到 never。
 */
function openMainStream(today: string): WriteStream | undefined {
  if (!logsDir) return undefined
  const file = join(logsDir, `runtime-${today}.log`)
  try {
    if (existsSyncSafe(file) && statSync(file).size > MAX_FILE_BYTES) {
      renameSync(file, `${file}.1`)
    }
  // eslint-disable-next-line taste/no-silent-catch -- 打开前滚动失败不阻塞写入；best-effort 容错
  } catch {
    // no-op
  }
  const stream = createStreamSafe(file)
  if (!stream) return undefined
  attachStreamErrorHandler(stream, `main:${file}`)
  mainStream = stream
  mainStreamFile = file
  mainBytesWritten = 0
  return stream
}

/**
 * createWriteStream 的容错包装（终审 suggestion 配套）：同步抛错（非法路径 / EMFILE 等）
 * 归一为 undefined，兑现 openMainStream「失败返回 undefined」的注释承诺。不包装时异常会
 * 沿 rotationInFlight promise 传播为 unhandled rejection（调用点的 `void rotate...` 不 await），
 * 且 rotateMain / rotatePiStream 的回放丢弃计数分支（stream 为 undefined）因此具备真实可达路径。
 *
 * flags 默认 'a'（主日志与 pi 流的常规续写语义不变）；pi 流轮转压缩成功后传 'w'——旧内容已
 * 归档进 .1.gz，截断即去重（见 rotatePiStream）。
 */
function createStreamSafe(file: string, flags: 'a' | 'w' = 'a'): WriteStream | undefined {
  try {
    return createWriteStream(file, { flags })
  } catch {
    // 打开失败归一 undefined 由调用方降级（回放丢弃计数）；logger 自身容错，不杀进程
    return undefined
  }
}

/**
 * 清理保留期（readLogKeepDays()，shared）天前的日志文件（initLogger 启动时调一次）。
 *
 * [crash-resilience §3.3 D6-⑦] 保留天数从进程内常量改为 shared readLogKeepDays()：
 * 每次调用时读 env（XYZ_LOG_KEEP_DAYS 覆盖 || 默认 7），与 main 侧每日复扫共用同一
 * 值域。本函数仍是 runtime 侧唯一触发点（仅启动时跑）；长寿运行的持续清理由 main
 * 每日定时器承担（u5a），两进程超龄判定同源。
 */
function cleanExpiredLogs(): void {
  if (!logsDir) return
  const cutoff = Date.now() - readLogKeepDays() * MS_PER_DAY
  let entries: string[]
  try {
    entries = readdirSync(logsDir)
  } catch {
    return
  }
  for (const name of entries) {
    // 只清理本模块产出的日志文件（runtime-* / pi-*.jsonl / pi-crash-*.log / plugin-crash-*.log）。
    // pi-crash-* 靠 pi- 前缀覆盖；plugin-crash-*（u5b D6-⑤，plugin worker 崩溃取证）
    // 是新写入面，写入与清理通道同步落地（D6-⑦：有写入无清理 = 新债）。
    // 固定名 stderr 文件（electron-runtime-stderr.log / zcode-appserver-stderr.log）
    // 不匹配任何前缀，天然不进超龄清单（writer 持有型 append fd 的 unlink 会造成
    // 「写成功、盘上无文件」的静默丢失；其治理归 writer 侧 size 轮转）。
    if (!name.startsWith('runtime-') && !name.startsWith('pi-') && !name.startsWith('plugin-crash-')) continue
    const full = join(logsDir, name)
    try {
      if (statSync(full).mtimeMs < cutoff) {
        unlinkSync(full)
      }
    // eslint-disable-next-line taste/no-silent-catch -- 单文件清理失败（并发删除/权限）不影响其他文件；best-effort 容错
    } catch {
      // no-op
    }
  }
}

// ── console monkey-patch（tee：终端 + 文件）────────────────────────
const originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  info: console.info.bind(console),
  debug: console.debug.bind(console),
}

let consolePatched = false
function patchConsole(): void {
  if (consolePatched) return
  consolePatched = true
  // 保留终端可见性（dev 习惯），同时 tee 到文件。
  // 注意：supervisor 仍捕获 runtime stdout → [runtime:out] 前缀，tee 不影响这条链路。
  console.log = (...args: unknown[]) => {
    originalConsole.log(...args)
    writeLogEntry('info', formatArgs(args))
  }
  console.info = (...args: unknown[]) => {
    originalConsole.info(...args)
    writeLogEntry('info', formatArgs(args))
  }
  console.warn = (...args: unknown[]) => {
    originalConsole.warn(...args)
    writeLogEntry('warn', formatArgs(args))
  }
  console.error = (...args: unknown[]) => {
    originalConsole.error(...args)
    writeLogEntry('error', formatArgs(args))
  }
  console.debug = (...args: unknown[]) => {
    originalConsole.debug(...args)
    writeLogEntry('debug', formatArgs(args))
  }
}

/** 把 console 的多参数序列化为单行字符串（含对象 JSON 化）。 */
function formatArgs(args: unknown[]): string {
  return args.map((a) => {
    if (typeof a === 'string') return a
    try {
      return JSON.stringify(a)
    } catch {
      return String(a)
    }
  }).join(' ')
}

// ── 显式 logger 导出（架构约定 #4 落盘）──────────────────────────────
//
// 除 monkey-patch console 外，提供显式 logger 对象供「不依赖 console patch」的场景使用。
// 内部调 writeLogEntry，与 patched console 同源（同文件/同级别/同轮转）。
// 未 initLogger 时为 no-op（单元测试不依赖文件系统）。

export const logger = {
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

// ── pi session 日志（pi stdout JSONL 原始流落盘）────────────────────

export interface PiSessionLog {
  /**
   * 写入 pi stdout 原始内容（不格式化——保留协议原貌供事后分析）。
   * string = 行级写入（readline 消费方契约，缺尾换行补齐）；Uint8Array = 原始字节镜像
   * （relay up 方向 chunk，流自带换行边界，逐字节保真、不补 \n——chunk 可能切断多字节
   * 字符，按 Buffer 写避免按 chunk 解码的 UTF-8 截断）。
   */
  write(line: string | Uint8Array): void
  /** 结束写入（session 销毁 / pi exit 时调）。end 后 write 为 no-op。 */
  end(): void
}

/**
 * 为一个 pi session 创建独立日志写入器。
 *
 * pi stdout 的 JSONL 事件流是诊断 pi 卡死的**决定性证据**（pi 发了什么 / 什么都没发）。
 * 每个独立文件，文件名含 sessionId 便于关联坏 session（与数据目录 agent/sessions/
 * 下的 session JSONL 对应）。
 *
 * size 轮转（2026-09 磁盘膨胀修复）：单 session 事件量并非总是可控——pi 的 message_update
 * delta 逐条落盘（每行一个小 delta + ~870B 信封），高频长 session 实测 30 分钟写到 19.4MB
 * 而有效内容仅 ~40KB（放大 ~500×），且旧实现无任何 size 上限（单文件实测 306MB、持续增长）。
 * 现与主日志共用 MAX_FILE_BYTES：达阈值 → 旧文件 gzip 归档为 <file>.1.gz（单代）→ 新流续写
 * 原路径。session 结束的 end() 与整文件体积无关；跨天/跨 session 仍由文件名 date 隔离。
 *
 * D10-2：接口形状不变（end 后 write 为 no-op），内部从 appendFileSync 换成 WriteStream
 * 缓冲写（惰性打开）。end() 只关闭本 session 写流；注册表保留条目，closeLogger 退出
 * flush 时统一等待全部写流（含已 end 未 flush 完的、含轮转后新流的）落盘——pi 静默
 * 卡死场景丢尾部几行 = 丢「pi 挂在最后哪一步」的冒烟证据（D10-1 分档承诺）。
 */
export function createPiSessionLog(sessionId: string): PiSessionLog {
  if (!logsDir || !currentLevel) {
    // logger 未初始化（如单元测试）：返回 no-op 写入器
    return { write: () => {}, end: () => {} }
  }
  const date = new Date().toISOString().slice(0, ISO_DATE_LENGTH)
  // 文件名：pi-<date>-<sessionId>.jsonl（date 防跨天 session 冲突）
  const safeSid = sessionId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, SESSION_ID_MAX_LENGTH)
  return createPiStreamWriter(join(logsDir, `pi-${date}-${safeSid}.jsonl`))
}

/**
 * 为一个 relay 托管的 subagent 子进程创建 stdout 原始字节镜像写入器（E 方案，
 * relay-registry 的 up 方向落盘；架构约定「pi stdout tee 落盘 = pi 卡死时唯一证据」
 * 对 relay 子进程的同款覆盖）。
 *
 * 文件名 `pi-relay-<date>-<recordId>.jsonl`（pi- 前缀对齐既有命名，cleanExpiredLogs
 * 的保留期清理同样覆盖；date 前缀防跨天冲突）。size 轮转与 createPiSessionLog 同款
 * （D7 复刻点③ `pi-relay-*` 同款：共享 createPiStreamWriter 的 per-writer 轮转，旋段
 * `pi-relay-*.jsonl.1.gz` 仍以 pi- 开头，白名单不变量保持）。recordId 来自握手帧（extension
 * 注入），按文件名安全字符集清洗。logger 未初始化时返回 no-op 写入器（与
 * createPiSessionLog 同契约，单元测试无副作用）。
 */
export function createPiRelayLog(recordId: string): PiSessionLog {
  if (!logsDir || !currentLevel) {
    return { write: () => {}, end: () => {} }
  }
  const date = new Date().toISOString().slice(0, ISO_DATE_LENGTH)
  const safeRecordId = recordId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, SESSION_ID_MAX_LENGTH)
  return createPiStreamWriter(join(logsDir, `pi-relay-${date}-${safeRecordId}.jsonl`))
}

// ── 崩溃取证上下文（crash-resilience §3.3 D6-④⑤ / A8）────────────────

/** runtime 进程内存快照的四指标（process.memoryUsage() 的取证子集）。 */
export interface MemorySnapshot {
  rss: number
  heapUsed: number
  heapTotal: number
  external: number
}

/**
 * pi 崩溃时 runtime 侧可得的上下文（D6-④，A8 交叉归因的 runtime 半边）。
 *
 * 全字段可空：来源是 ProcessManager/RpcClient 在崩溃时刻已知的内存态，未知一律 null
 * （显式落盘「不知道」而不是省略行——字段名恒在，事后 grep 可判别「没采到」与「没打点」）。
 */
export interface PiCrashContext {
  /** 崩溃 session id（rpc-client options.sessionId；早期 spawn 崩溃可能缺失）。 */
  sessionId: string | null
  /**
   * pi 历史文件绝对路径：switch_session 参数或 get_state 返回的 sessionFile，二者
   * 任一发生过才非 null。新建 session 在首条 assistant 前 pi 侧尚未落盘（仓规 #6），
   * runtime 不主动创建/探测文件，未知即 null。
   */
  sessionFile: string | null
  /** 最后一次发出的 RPC 命令类型（sendCommand 记录，如 'send_prompt' / 'switch_session'）。 */
  lastRpcCommand: string | null
  /** pi 进程存活时长 ms（spawn 完成到崩溃时刻；未记录到 spawn 点为 null）。 */
  uptimeMs: number | null
  /** 崩溃时刻 runtime 进程内存快照（captureMemorySnapshot，恒可得除非宿主异常）。 */
  memory: MemorySnapshot | null
}

/**
 * 采集当前进程内存快照（D6-②④ 共用的四指标提取）。
 * process.memoryUsage() 恒同步可得，无失败路径；包装成函数便于测试替身与统一形状。
 */
export function captureMemorySnapshot(): MemorySnapshot {
  const m = process.memoryUsage()
  return { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external }
}

/**
 * 渲染 pi-crash log 的 runtime 上下文头块（D6-④）。每行 `[runtime-context] key=value`
 * 形态：与 stderr 原文可肉眼区分、grep 'runtime-context' 可整块提取、null 显式落盘。
 * 返回多行字符串（无尾换行），调用方负责块间分隔。
 */
export function formatPiCrashContextHeader(ctx: PiCrashContext): string {
  return [
    `[runtime-context] sessionId=${ctx.sessionId ?? 'null'}`,
    `[runtime-context] sessionFile=${ctx.sessionFile ?? 'null'}`,
    `[runtime-context] lastRpcCommand=${ctx.lastRpcCommand ?? 'null'}`,
    `[runtime-context] uptimeMs=${ctx.uptimeMs ?? 'null'}`,
    `[runtime-context] memory=${ctx.memory ? JSON.stringify(ctx.memory) : 'null'}`,
  ].join('\n')
}

/**
 * 内存水位行格式化（D6-②，runtime 水位定时器每 5 分钟一行，A8 断言「5 分钟间隔水位行」）。
 * 单行、数值单位 MB（1 位小数）+ session/pi 计数——grep '[watermark]' 可提取全序列画曲线。
 *
 * u1e（crash-forensics D1）：本函数同时是 watermark-daily 自然日聚合的采样入口——组合根
 * 水位定时器每拍经此处消费样本（唯一生产调用点，依赖事实见上方聚合段注释）。聚合任何
 * 异常已在 recordWatermarkDailySample 内消化，不影响本函数返回格式化行。
 */
export function formatMemoryWatermarkLine(sample: MemoryWatermarkSample): string {
  recordWatermarkDailySample(sample)
  const mb = (n: number): string => (n / (BYTES_PER_KB * BYTES_PER_KB)).toFixed(1)
  return `[watermark] rss=${mb(sample.rss)}MB heapUsed=${mb(sample.heapUsed)}MB heapTotal=${mb(sample.heapTotal)}MB external=${mb(sample.external)}MB sessions=${sample.activeSessions} pi=${sample.piProcesses}`
}

/** 内存水位行载荷（四指标 + 两个进程计数）。 */
export interface MemoryWatermarkSample extends MemorySnapshot {
  /** 活跃 session 数（sessionService.getActiveSessionIds().length）。 */
  activeSessions: number
  /** 托管 pi 进程数（ProcessManager.size）。 */
  piProcesses: number
}

/** 水位打点周期（分钟，D6-②：每 5 分钟一行）。 */
const WATERMARK_INTERVAL_MINUTES = 5
/** runtime 内存水位定时器周期（D6-②）。 */
export const MEMORY_WATERMARK_INTERVAL_MS = WATERMARK_INTERVAL_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND

// ── watermark-daily 自然日聚合（crash-forensics-and-watchdog §3.3 D1，u1e）────────
//
// 设计 D1：既有水位 5min 定时器处聚合，自然日窗口一条（rss/heapUsed min/max/avg +
// coverage 起止戳，评估器条件 #4/#5 数据源，coverage<50% 由评估器降权）；明细 5min 行
// 仍只进 runtime-*.log 不进台账。**钩子位置的事实依据**：水位定时器本体在组合根
// index.ts startMemoryWatermarkTimer，其每拍回调恰调用本模块 formatMemoryWatermarkLine
// 一次（唯一生产消费点）——聚合钩子挂该函数即「既有 5min 水位定时器处」，采样链迁移
// 时钩子必须随迁。**日内重启处置（D1 原文）**：聚合态在本模块内存、重启即清零——重启
// 后从进程内首个样本起算当日剩余窗口，coverage 戳随条目落盘；当日未完结不写（只写
// 完整窗口）。**依赖方向（循环依赖破除后单向）**：本模块 import crash-journal
// （getCrashJournal），crash-journal 不反向 import logger——其留痕出口经组合根
// initCrashJournal(dataDir, logger) 注入；台账单例未初始化时 getCrashJournal 返回
// no-op（crash-journal 契约）。

/** 单个自然日窗口的水位聚合态（模块内存态，重启清零——D1 日内重启处置）。 */
interface WatermarkDailyAccumulator {
  /** 窗口所属自然日（UTC，YYYY-MM-DD）。 */
  day: string
  rssMin: number
  rssMax: number
  rssSum: number
  heapUsedMin: number
  heapUsedMax: number
  heapUsedSum: number
  /** 样本数（avg 分母，digest 携带供评估器判窗口密度）；coverageStart/End = 窗口首末样本时刻（ISO）。 */
  samples: number
  coverageStart: string
  coverageEnd: string
}

let watermarkDailyAcc: WatermarkDailyAccumulator | undefined

/**
 * 记录一个水位样本进自然日聚合窗口；检测到日翻转时先把**已完结的前一日窗口**写进
 * 崩溃台账（event=watermark-daily）再开新窗口。now 缺省当前时刻，测试注入固定时刻
 * 控制日翻转（真实 IO 不与 fake timers 交互——writer 是真实异步流）。
 */
export function recordWatermarkDailySample(sample: MemoryWatermarkSample, now: Date = new Date()): void {
  try {
    const day = now.toISOString().slice(0, ISO_DATE_LENGTH)
    if (watermarkDailyAcc && watermarkDailyAcc.day !== day) {
      flushWatermarkDaily(watermarkDailyAcc) // 日翻转：前一日窗口已完结（末样本即 coverage 终点）
      watermarkDailyAcc = undefined
    }
    const iso = now.toISOString()
    const acc = watermarkDailyAcc ?? {
      day, rssMin: sample.rss, rssMax: sample.rss, rssSum: 0,
      heapUsedMin: sample.heapUsed, heapUsedMax: sample.heapUsed, heapUsedSum: 0,
      samples: 0, coverageStart: iso, coverageEnd: iso,
    }
    acc.rssMin = Math.min(acc.rssMin, sample.rss)
    acc.rssMax = Math.max(acc.rssMax, sample.rss)
    acc.rssSum += sample.rss
    acc.heapUsedMin = Math.min(acc.heapUsedMin, sample.heapUsed)
    acc.heapUsedMax = Math.max(acc.heapUsedMax, sample.heapUsed)
    acc.heapUsedSum += sample.heapUsed
    acc.samples += 1
    acc.coverageEnd = iso
    watermarkDailyAcc = acc
  // eslint-disable-next-line taste/no-silent-catch -- 聚合是水位定时器回调的旁路观测面，不得打断水位行落盘（writeLogEntry 同款容错哲学）
  } catch {
    // no-op
  }
}

/**
 * 把一个已完结的自然日窗口写成一条 watermark-daily 台账事件。字段映射（schema 无统计
 * 专字段）：顶层 rss/heapUsed = 当日**平均值**（评估器趋势判定主形态）；min/max 与
 * coverage 起止戳内嵌 detailDigest（JSON，百字节级 ≪ 2KB 上限）。台账未初始化（no-op
 * 单例）时窗口数据丢弃——no-sink 窗口不伪装成已落盘（与「重启清零」同语义）。
 *
 * **digest 键名契约（d2 评估器消费面）**：heap 族 max 键名 = `heapMax`（非 `heapUsedMax`）——
 * 评估器 extractWatermarkSample（apps/electron/main/diagnostics/trigger-evaluator.ts）
 * 对 #4「回收态存量致水位不回落」取 `digest.heapMax` 为当日 heap 峰值，缺失则回退顶层
 * `heapUsed`（当日**平均**）。键名不齐时趋势判定会静默退化为均值口径（无错误、无告警），
 * 故此处以评估器已声明的键名对齐；rss 族键名同理被评估器用作次选（`rssMax`）。改键名
 * 前先核对评估器取值链。
 */
function flushWatermarkDaily(acc: WatermarkDailyAccumulator): void {
  if (acc.samples === 0) return
  const rssAvg = acc.rssSum / acc.samples
  const heapAvg = acc.heapUsedSum / acc.samples
  getCrashJournal().append({
    layer: 'runtime',
    event: 'watermark-daily',
    rss: rssAvg,
    heapUsed: heapAvg,
    detailDigest: JSON.stringify({
      coverageStart: acc.coverageStart, coverageEnd: acc.coverageEnd,
      rssMin: acc.rssMin, rssMax: acc.rssMax, rssAvg,
      heapMin: acc.heapUsedMin, heapMax: acc.heapUsedMax, heapAvg,
      samples: acc.samples,
    }),
  })
}

/**
 * pi 崩溃 stderr 全量落盘（设计 file-lock-unification-and-reaper-sink §3.2-D4 / U3-4，
 * rpc-client exit handler 的异常退出分支调用）。
 *
 * [crash-resilience §3.3 D6-④] 第三参 context（可选）：runtime 侧上下文头
 * （formatPiCrashContextHeader 渲染）插在 stderr 原文之前，A8 交叉归因的 runtime 半边；
 * 未传时行为与历史版本逐字一致（纯 stderr 内容）。
 *
 * 文件名 `pi-crash-<date>-<sessionId>.log`：复用 pi-*.jsonl 命名惯例（pi- 前缀使
 * cleanExpiredLogs 的保留期清理自动覆盖，无需改过滤规则）；date + sessionId 防同日
 * 多 session / 跨天冲突。sessionId 缺失（无 session 的早期 spawn 崩溃）用 'nosid' 占位。
 *
 * 写入复用 createPiStreamWriter（WriteStream 缓冲 + 惰性打开 + closeLogger 退出 flush
 * 覆盖 + 流错误自愈）而非 appendFileSync——logger.ts 写入路径禁同步 append 是
 * logger.test.ts 的源码硬保证（grep 断言），且崩溃落盘后 runtime 可能很快 shutdown，
 * 注册进 openPiStreams 保证 closeLogger 等待其落盘完成。
 *
 * 未初始化（单元测试）no-op；重复调用（同 session 多次崩溃理论上不可能，防御性
 * 支持）append 语义不覆盖历史。内容为 best-effort：写失败不向上抛（调用方在 exit
 * 主流程上，观测增强不得影响 rejectAll / exitCallbacks 通知链）。
 */
export function writePiCrashLog(sessionId: string | undefined, content: string, context?: PiCrashContext): void {
  if (!logsDir || !currentLevel) return
  const date = new Date().toISOString().slice(0, ISO_DATE_LENGTH)
  // 文件名安全化与 createPiSessionLog 同规则；空清洗结果（如全非法字符）回落 'nosid'
  const safeSid = (sessionId ?? 'nosid').replace(/[^a-zA-Z0-9-]/g, '').slice(0, SESSION_ID_MAX_LENGTH) || 'nosid'
  const writer = createPiStreamWriter(join(logsDir, `pi-crash-${date}-${safeSid}.log`))
  const body = content.endsWith('\n') ? content : content + '\n'
  // context 头块与 stderr 原文之间空一行分隔（块尾无换行，此处补两个 \n）
  writer.write(context ? `${formatPiCrashContextHeader(context)}\n\n${body}` : body)
  writer.end()
}

/**
 * plugin worker 崩溃 stderr 全量落盘（[crash-resilience §3.3 D6-⑤ / A8]，plugin-host
 * handleWorkerCrash 的三入口汇聚点调用）。
 *
 * 形态对齐 writePiCrashLog：`plugin-crash-<date>-<workerId>.log`（独立 plugin-crash- 前缀
 * 进 cleanExpiredLogs 白名单，D6-⑦ 有写入即有清理）；worker 是 Worker Thread 无 pid，
 * 文件名键用 workerId（如 'trusted-1'），内容头块记录 threadId。重复调用 append 不覆盖
 * （同 worker 冷却窗内多次崩溃，防御性支持）。
 *
 * 未初始化（单元测试）no-op；best-effort：写失败不向上抛（调用方在 crash 处置主流程上，
 * 观测增强不得影响 rebuild / onCrash 通知链）。
 */
export function writePluginCrashLog(workerId: string, content: string): void {
  if (!logsDir || !currentLevel) return
  const date = new Date().toISOString().slice(0, ISO_DATE_LENGTH)
  // 文件名安全化与 writePiCrashLog 同规则；空清洗结果回落 'noworker'
  const safeWorkerId = workerId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, SESSION_ID_MAX_LENGTH) || 'noworker'
  const writer = createPiStreamWriter(join(logsDir, `plugin-crash-${date}-${safeWorkerId}.log`))
  writer.write(content.endsWith('\n') ? content : content + '\n')
  writer.end()
}

/**
 * pi 原始流写入器的共享实现（createPiSessionLog / createPiRelayLog / writePiCrashLog 共用）：
 * WriteStream 缓冲写 + 惰性打开 + destroyed 自愈重建 + **size 轮转**（达 MAX_FILE_BYTES → gzip
 * 归档 .1.gz 单代 → 重开新流写原路径 → 回放窗口内的行）。条目注册进 openPiStreams 由
 * closeLogger 统一等待退出 flush。失败语义 best-effort：同步异常静默吞、异步流错误由
 * attachStreamErrorHandler 记一次 warn——绝不向上抛（调用方是数据转发热路径）。
 *
 * 内容形态铁律：**逐行原样写 JSONL**——不合并 delta、不采样、不丢弃行。tee 的定位是
 * 「pi 卡死时唯一诊断证据」，保真优先于体积；轮转只改存储形态（可达性靠 .1.gz），不改内容。
 */
function createPiStreamWriter(file: string): PiSessionLog {
  const state: PiStreamState = {
    stream: undefined,
    ended: false,
    file,
    bytesWritten: 0,
    rotationInFlight: null,
    pending: [],
    dropped: 0,
  }
  openPiStreams.add(state)
  return {
    write: (line) => {
      if (state.ended) return // end 后 no-op
      if (!currentLevel || !logsDir) return // closeLogger 后 no-op（与 writeLogEntry 一致，审查 W30 Fix-8）
      const data = toPiLineData(line)
      const bytes = Buffer.byteLength(data)
      try {
        // 轮转窗口（旧流 close 等待 + gzip 压缩耗时）：行先入队，续体在新流就绪后按序回放
        // ——窗口内零阻塞、零丢失。pi delta 行可达每秒数百条，而压缩窗口比主日志的纯 end
        // 等待长（50MB 级约 1s），回放队列是保真的必要条件（不是优化；与主日志 pendingLines 同款）。
        if (state.rotationInFlight) {
          pushPendingPiLine(state, data, bytes)
          return
        }
        // 写入前守卫（审查 W30 Fix-9）：writableEnded = end() 已调、flush 未完（正常被
        // state.ended 拦截，此处防御外部直接调 stream.end() 的场景）——等同 end 语义，no-op。
        if (state.stream?.writableEnded) return
        // size 轮转（写入字节计数，与主日志同款）：达阈值 → 异步轮转，本行入队。
        // 排在自愈重建之前：轮转续体自带「end 旧流 → gzip → 重开新流」，无需先重建被销毁的流。
        if (shouldRotatePiStream(state, bytes)) {
          rotateAndPushPendingPiLine(state, data, bytes)
          return
        }
        // write 返回 false = 背压（缓冲堆积）。日志行量级 KB、磁盘正常不触发；慢盘时
        // 内存增长与轮转窗口 pendingLines 同源，已由容量上限兜底（审查 W30 Fix-6）。
        // ensurePiStream 惰性打开（首写开流）——勿在其前检查 state.stream（合并事故：
        // 残留 u9 版「先显式打开再检查」的前置守卫会把首行全部丢弃且流永不打开）。
        ensurePiStream(state).write(data)
        state.bytesWritten += bytes
      // eslint-disable-next-line taste/no-silent-catch -- pi stdout 落盘失败（磁盘满/权限）不影响 runtime 主流程；best-effort 容错
      } catch {
        // no-op
      }
    },
    end: () => {
      if (state.ended) return
      state.ended = true
      // 轮转进行中时 state.stream 已摘空：回放行由续体写完后再 end（见 rotatePiStream），
      // 续体打开的新流仍留在 state.stream 上，closeLogger 才能等到它 flush 完成。
      state.stream?.end() // 缓冲数据异步 flush 后关闭 fd；closeLogger 会等待其完成
      // G2 摘除（§3.4）：覆盖「流从未打开（惰性打开未触发）」与「流已 destroyed（error
      // 自愈前终止）」两形态——此时无 close 事件可等，直接摘除；正常路径由流的 'close'
      // 监听器（ensurePiStream / 轮转重开处挂载）在 flush 完成后摘除。
      maybeRetirePiStream(state)
    },
  }
}

/**
 * write 的行形态归一：string 补齐尾换行（readline 消费方契约），Uint8Array 原样透传
 *（relay up 方向 chunk 逐字节保真，不补 \n——按 chunk 解码会截断多字节字符）。
 */
function toPiLineData(line: string | Uint8Array): string | Uint8Array {
  return typeof line === 'string' ? (line.endsWith('\n') ? line : line + '\n') : line
}

/** size 轮转前置判定（与主日志 writeLogEntry 同款字节计数口径）。 */
function shouldRotatePiStream(state: PiStreamState, bytes: number): boolean {
  return !!state.stream && state.bytesWritten + bytes > MAX_FILE_BYTES
}

/**
 * 惰性打开 / destroyed 自愈重建（自 write 抽出，行为逐字等价）。
 *
 * 自愈（审查 W30 Fix-2）：流 error 后 autoDestroy，write 静默丢弃；pi session log 是 pi
 * 卡死诊断的决定性证据，静默丢失后续行 = 失去冒烟证据（主日志有轮转自愈、pi 流没有）——
 * destroyed 时重建（flags:'a' 续写同文件 + 重新挂 error 监听器）。
 *
 * 重建前摘掉旧流的 error 监听（审查 W30 Fix-9）：destroyed 流不会再 emit，但显式移除避免
 * 悬挂监听器持有旧流引用（防监听器泄漏/重复注册）。可选链：首次惰性打开时 stream 为
 * undefined（此分支为 true 的主路径）。
 */
function ensurePiStream(state: PiStreamState): WriteStream {
  if (state.stream && !state.stream.destroyed) return state.stream
  state.stream?.removeAllListeners('error')
  state.stream = createWriteStream(state.file, { flags: 'a' })
  attachStreamErrorHandler(state.stream, `pi:${state.file}`)
  // G2 摘除（§3.4）：close = fd 释放 + 缓冲全量落盘（无在途数据），此时摘除不破坏
  // closeLogger 兜底等待契约；ended/轮转条件见 maybeRetirePiStream。
  state.stream.once('close', () => maybeRetirePiStream(state))
  return state.stream
}

/** 轮转窗口内的行入队：队列满 → 丢弃并计数（不静默），否则按序入队。 */
function pushPendingPiLine(state: PiStreamState, data: string | Uint8Array, bytes: number): void {
  if (state.pending.length >= MAX_PENDING_LINES) {
    state.dropped++
    return
  }
  state.pending.push({ data, bytes })
}

/**
 * size 轮转触发 + 本行入队（顺序硬约束，与拆分前逐字等价）：
 * ① 队列满（fs 挂起导致窗口超长）→ 本行丢弃并计数、**不触发轮转**；
 * ② 否则先 `rotatePiStream`（同步置 rotationInFlight + 摘空 stream）再 push——push 必落轮转
 * 窗口队列，不会被续体的 pending.splice 漏掉。
 */
function rotateAndPushPendingPiLine(state: PiStreamState, data: string | Uint8Array, bytes: number): void {
  if (state.pending.length >= MAX_PENDING_LINES) {
    state.dropped++ // 队列满（fs 挂起导致窗口超长）：本行丢弃并计数，不静默
    return
  }
  void rotatePiStream(state) // 同步置 rotationInFlight + 摘空 stream，随后的 push 必入队
  state.pending.push({ data, bytes })
}

/**
 * 异步轮转单个 pi 流：end 旧流并**等待 flush 完成** → gzip 归档 → 重开新流 → 回放队列。
 *
 * 顺序硬约束（与 rotateMain 同源，但多一个压缩阶段）：
 * ① 先等旧流 'close' 再压缩——在途 fs.write 落进压缩段会让「同一行既进 .1.gz 又被新流重写」，
 *   且压缩读到的内容边界不确定（同 inode 边读边写）；
 * ② gzip **完成后才能重开新流写原路径**——若先开 append 流，新行会被进行中的 read stream
 *   读走，同内容在 .1.gz 与新文件里各存一份（体积翻倍，与「上限有界」目标相悖）。
 *   故压缩成功用 flags:'w' 重开（旧内容已进 .1.gz，截断即去重，也免去 unlink 失败时
 *   追加旧内容的重复）；压缩失败/放弃用 flags:'a'（保留原文件，保真优先，磁盘上限暂时让位）。
 *
 * 幂等并发：轮转窗口内的重复触发复用同一 promise（写入统一走 state.pending 队列）。
 * 永不 reject：调用点 `void rotatePiStream(...)` 不 await，reject 会变成 unhandled rejection。
 */
function rotatePiStream(state: PiStreamState): Promise<void> {
  if (state.rotationInFlight) return state.rotationInFlight
  const oldStream = state.stream
  const file = state.file
  // 状态先行清空：轮转窗口内到达的行统一入队（write 的 rotationInFlight 分支）
  state.stream = undefined
  state.bytesWritten = 0
  state.rotationInFlight = (async () => {
    try {
      await endAndAwait(oldStream, `pi-rotation:${file}`)
      const archived = await gzipRotatedFile(file)
      // 回放轮转窗口内到达的行（续体在微任务队列原子执行，无并发写入插队）
      const pending = state.pending.splice(0)
      // ended 且无回放行时不必重开流（无内容可写，免得白建文件）
      const stream = pending.length > 0 || !state.ended ? createStreamSafe(file, archived ? 'w' : 'a') : undefined
      if (!stream) {
        // 新流不可用（EMFILE / 目录被删 / 压缩失败后原文件也打不开）：回放行无目标可写，
        // 丢弃但必须计数（对齐主日志出口，不静默），由下方合并 warn 报数
        state.dropped += pending.length
      } else {
        attachStreamErrorHandler(stream, `pi:${file}`)
        state.stream = stream
        // G2 摘除（§3.4）：轮转重开的流同样挂 close 摘除（含「回放行写完即 end」的短命形态）
        stream.once('close', () => maybeRetirePiStream(state))
        for (const p of pending) {
          stream.write(p.data)
          state.bytesWritten += p.bytes
        }
        // end() 在轮转窗口内被调：回放行是 end 前已接受的写入，必须落盘后再关流
        if (state.ended) stream.end()
      }
    // eslint-disable-next-line taste/no-silent-catch -- 轮转是写入路径的旁路，任何步骤失败都降级为「丢压缩产物、不丢写入」；且调用点不 await，reject 即 unhandled rejection
    } catch {
      // no-op
    } finally {
      state.rotationInFlight = null
      // G2 摘除（§3.4）：「轮转窗口内 end 且未重开流」（pending 空 + ended → 续体不建新流）
      // 无新 close 事件可达，在此兜底摘除；重开了流（回放 + end）则 stream 未 destroyed，
      // 条件不满足，由该流的 'close' 监听器在 flush 完成后摘除。
      maybeRetirePiStream(state)
      // 轮转窗口超长（fs 挂起）/ 新流不可用的丢弃：合并记一次 warn（此时 rotationInFlight
      // 已清，writeLogEntry 走正常路径，不递归；只影响缓冲窗口内的行，降级可接受）
      if (state.dropped > 0) {
        const dropped = state.dropped
        state.dropped = 0
        writeLogEntry('warn', `[logger] dropped ${dropped} pi log lines (pending queue overflow / replay target unavailable during rotation)`)
      }
    }
  })()
  return state.rotationInFlight
}

/**
 * 把已关闭的旧 pi 日志文件流式压缩为 `<file>.1.gz`（best-effort，返回是否成功）。
 *
 * 单代保留：先写 `<file>.1.gz.tmp`，成功后 rename 覆盖 `<file>.1.gz`——POSIX rename 原子替换，
 * 磁盘上恒只有 1 个压缩代（上限 = 当前文件 + 1 代），失败路径也不删上一代（它仍是完整产物）。
 * 不用「先删上一代再压缩」：删除与新产物落盘之间有空窗，期间中断会两代尽失。
 *
 * 失败语义（best-effort）：任何一步失败 → 删除临时残片、保留原文件、返回 false，由
 * rotatePiStream 用 flags:'a' 重开（不丢数据）+ 此处 warn 一次。**绝不向上抛**（tee 写入本体
 * 不得因压缩失败中断）。
 *
 * 兜底超时（防挂死）：pipeline 带 AbortSignal，超时中止走失败分支（GZIP_TIMEOUT_MS 见常量注释）。
 * 无此兜底时 closeLogger（await 在途轮转）会被挂起的压缩永久卡住。
 */
async function gzipRotatedFile(file: string): Promise<boolean> {
  // 旧文件已不存在（外部清理 / 从未创建）：无需归档，按成功处理（避免无意义的 warn 噪音）
  if (!existsSyncSafe(file)) return true
  const tmp = `${file}${PI_GZIP_TMP_SUFFIX}`
  const gz = `${file}${PI_GZIP_SUFFIX}`
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), GZIP_TIMEOUT_MS)
  timer.unref?.()
  try {
    // createGzip()/createWriteStream() 同步抛错也落在 try 内（整段归入失败分支）
    await pipeline(createReadStream(file), createGzip(), createWriteStream(tmp), { signal: abort.signal })
    renameSync(tmp, gz) // 覆盖上一个 .1.gz —— 单代保留，且不留 tmp 残骸
    return true
  } catch {
    try {
      unlinkSync(tmp) // 失败残片（0 字节 / 半截 gzip）删除：不污染「单代」语义
    // eslint-disable-next-line taste/no-silent-catch -- 残片清理自身失败（并发删除等）无需处理
    } catch {
      // no-op
    }
    writeLogEntry('warn', `[logger] pi log gzip failed (${file}); original file kept, rotation skipped`)
    return false
  } finally {
    clearTimeout(timer)
  }
}

// ── 工具 ────────────────────────────────────────────────────────────
function existsSyncSafe(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * end 一个写流并等待其真正关闭（'close' 事件，fd 已释放、缓冲已 flush）。
 *
 * 退出 flush（D10-1）与轮转（审查 m-6）的核心：process.exit() 立即终止进程、rename
 * 前必须有「无在途写」保证——都要求 end 后**等待落盘完成**（形态契约与超时降级见
 * stream-end-await.ts，偏差 #32① 收敛后的单一实现）。
 */
function endAndAwait(stream: WriteStream | undefined, label: string): Promise<void> {
  return endAndAwaitStream(stream, label, reportEndAwaitTimeout)
}

/**
 * endAndAwait 超时的错误出口（审查 W30 Fix-1：记 error 级日志，防「静默降级」放大日志丢失）。
 *
 * 双出口：writeLogEntry 走常规写路径（轮转场景入 pendingLines、轮转后回放落盘；
 * closeLogger 后 currentLevel 已清则 no-op）；originalConsole.error 是**未 patch 的原生
 * console**（不递归进 writeLogEntry），stderr 由 supervisor 捕获落盘——超时意味着 fs
 * 本身可能挂起，文件路径不可靠时 stderr 是兜底出口。轮转窗口队列满时文件路被丢弃
 * （计入 pendingDroppedCount，随合并 warn 报数），stderr 恒可达。
 */
function reportEndAwaitTimeout(label: string): void {
  const msg = `[logger] endAndAwait timeout after ${END_AWAIT_TIMEOUT_MS}ms (${label}); stream force-destroyed, in-flight buffer tail lost`
  writeLogEntry('error', msg)
  originalConsole.error(msg)
}

/**
 * 关闭 logger（runtime shutdown 时调）。
 *
 * **必须 await**：先等待进行中的轮转完成（队列回放），再 end 主日志写流 + 全部已注册
 * pi session 写流，并等待 flush 完成——之后调用方才可 process.exit(0)（现状 index.ts
 * shutdown 链已改为 await closeLogger()）。
 *
 * 幂等：再次调用（或 closeLogger 后的写入）均为 no-op。
 */
export async function closeLogger(): Promise<void> {
  if (rotationInFlight) await rotationInFlight
  // pi 流在途轮转同样必须先落定：续体会重开新流并回放 pending 行——不等的话，下面的流快照
  // 拿到的是 undefined（轮转中 state.stream 已摘空），新流与其回放行既不被 end 也不被等待，
  // 退出时直接丢尾部（退出 flush 契约破裂）。**取舍**：纳入等待，而非放弃压缩产物——压缩
  // 对象是 ≤MAX_FILE_BYTES 的已关闭文件（正常 <1s），而放弃产物要么丢掉 tee 证据的唯一载体
  // （.1.gz），要么让原文件停在半归档态（旧内容既不在 .1.gz 也没截断）；保真优先，代价是退出
  // 最多多等一次压缩。挂死兜底：压缩自带 GZIP_TIMEOUT_MS 中止（见 gzipRotatedFile）。
  const piRotations = [...openPiStreams].map((s) => s.rotationInFlight).filter((p): p is Promise<void> => p !== null)
  if (piRotations.length > 0) await Promise.allSettled(piRotations)
  // 先捕获所有写流引用再清状态——await 窗口内新写入应直接 no-op，
  // 捕获的旧流照常 end + 等待（退出前最后几行不丢）。
  const streams: Array<{ stream: WriteStream | undefined; label: string }> = [
    { stream: mainStream, label: `main-shutdown:${mainStreamFile ?? 'unnamed'}` },
  ]
  for (const s of openPiStreams) streams.push({ stream: s.stream, label: `pi-shutdown:${s.file}` })
  mainStream = undefined
  mainStreamFile = undefined
  mainBytesWritten = 0
  pendingLines.length = 0
  openPiStreams.clear()
  currentLevel = undefined
  logsDir = undefined
  currentDate = ''
  // 各写流独立且 endAndAwait 永不 reject——allSettled 与 all 等价，但符合
  // taste/prefer-allsettled（独立数据源允许部分降级，不互相阻塞）。
  await Promise.allSettled(streams.map(({ stream, label }) => endAndAwait(stream, label)))
}
