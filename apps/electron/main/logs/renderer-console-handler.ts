/**
 * renderer console 落盘器（renderer-console-persist U1 / 设计 D1-D3）。
 *
 * main 侧 webContents 'console-message' 事件的被动信号落盘 sink：写
 * `logs/renderer-console-<date>.log`（JSON 行），只收 'warning' | 'error' 级
 * （D2——level 是 Electron 42+ 的**字符串枚举**，非旧位置参数的数字，过滤必须
 * 字符串比较）。监听挂载归 window-factory（U2）；本模块不 import electron，
 * 纯落盘器，单测无需 electron mock 即可直入（与 renderer-log-handler 的
 * IPC handler 形态差异——那是不可信 renderer payload 入口，这是 main 进程内部直调）。
 *
 * 与 renderer-log-handler（同目录先例）的复刻与偏离：
 * - 复刻：按 windowId（webContents.id）限流 100 条/min（超限**丢弃**非缓存、
 *   窗口翻转落 dropped 计数汇总行 + main log 镜像 warn）+ sweepIdleEntries
 *   惰性清扫（窗口销毁后限流 Map entry 不泄漏）+ 同步 appendFileSync（低频诊断
 *   通道无写流即无 flush 面，退出无需编排）+ size 滚动（.1 单代，帽值复用
 *   readMainLogMaxBytes 同一旋钮 TAIJI_LOG_MAX_BYTES）
 * - 偏离①：写失败**不在 writer 内吞**，上抛到入口 catch 统一兜底——本管道对
 *   首次故障经 mainLogger.warn 记一次（模块级布尔去重，window-factory
 *   unresponsiveJournaled「防刷屏记一次」惯用法），区分「管道死」与「无事件」
 *   （设计 D3①；renderer-error 通道纯静默吞，无此诊断需求）
 * - 偏离②：不设 IPC 注册面与 payload 运行时校验——消费入口是 U2 的事件回调
 *   直调（main 进程内部契约，结构由 Electron 事件保证），不可信输入才需要校验
 *
 * 停用旋钮（设计 D3④）：`TAIJI_RENDERER_CONSOLE_OFF` 值感知解析——仅 '1'/'true'
 * 视为停用（对齐 TAIJI_RUNTIME_WATCHDOG_ARMED 先例形态；presence-only 会让残留
 * '=0' 仍静默停用，恢复通道自身在排障现场失效）。生效粒度 = 启动时（模块加载）
 * 读取一次，app 启动后设置不生效；U2 挂载前消费 isRendererConsoleDisabled()
 * 决定是否挂监听。`_OFF` 后缀是 main 侧第一个反向极性旋钮（全仓 TAIJI_ env 无
 * 同族），显式登记防后来者误当惯例复制。
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getDataDir } from '@taiji/shared/paths'
import { mainLogger, readMainLogMaxBytes } from './main-logger.js'

// ── 常量 ───────────────────────────────────────────────────────────
/** 限流配额：每 windowId 每分钟最多落盘条数（设计 D3②，对齐 renderer-error 先例值）。 */
export const RENDERER_CONSOLE_RATE_LIMIT_PER_WINDOW = 100
const MS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const MS_PER_MINUTE = SECONDS_PER_MINUTE * MS_PER_SECOND
const RATE_LIMIT_WINDOW_MINUTES = 1
const RATE_LIMIT_WINDOW_MS = RATE_LIMIT_WINDOW_MINUTES * MS_PER_MINUTE
/** 限流 entry 惰性清扫阈值：窗口过期且再无活动的 entry 删除（防 webContents 销毁后泄漏）。 */
const RATE_LIMIT_ENTRY_IDLE_MINUTES = 10
const RATE_LIMIT_ENTRY_IDLE_MS = RATE_LIMIT_ENTRY_IDLE_MINUTES * MS_PER_MINUTE
/** message 单条落盘字节帽（设计 D1 新增决策：防单条超长堆栈刷盘；体积预算按字节折算）。 */
const MAX_MESSAGE_BYTES = 1024
/** UTF-8 续字节掩码：`(byte & 0xc0) === 0x80`（0b10xxxxxx）判定字节是否多字节字符的续字节。 */
const UTF8_CONTINUATION_MASK = 0xc0
/** UTF-8 续字节值域起点（0b10000000）。 */
const UTF8_CONTINUATION_VALUE = 0x80
/** ISO 日期 YYYY-MM-DD 的字符长度（对齐 main-logger 同名常量）。 */
const ISO_DATE_LENGTH = 10
/** 停用旋钮 env 名（值感知解析，见文件头）。 */
const ENV_RENDERER_CONSOLE_OFF = 'TAIJI_RENDERER_CONSOLE_OFF'

/** 落盘级别白名单（D2：字符串枚举比较，非白名单值丢弃——info/debug 不收）。 */
const PERSISTED_LEVELS: ReadonlySet<string> = new Set(['warning', 'error'])

// ── 停用旋钮 ───────────────────────────────────────────────────────

/** 值感知解析：仅 '1' / 大小写不敏感 'true' 为 true（watchdog armed 旋钮同款）。 */
function parseOffKnob(raw: string | undefined): boolean {
  return raw === '1' || raw?.toLowerCase() === 'true'
}

/** 启动时（模块加载）读取一次；此后 env 变更不改变返回值（设计 D3④ 显式边界）。 */
const consoleOffRequested = parseOffKnob(process.env[ENV_RENDERER_CONSOLE_OFF])

/** U2 挂载消费：true 时跳过 console-message 监听挂载（前提 3 的回退通道）。 */
export function isRendererConsoleDisabled(): boolean {
  return consoleOffRequested
}

// ── 入口（U2 事件回调直调）─────────────────────────────────────────

/**
 * console-message 回调 params 的最小消费面（D1：只取四个标量字段构造 JSON 行，
 * 禁整体序列化 params——frame 是 WebFrameMain 结构对象，序列化即抛错/内存膨胀，
 * 本接口结构上将其排除）。main 进程内部契约（U2 直调），结构由 Electron 事件
 * 保证，不作运行时校验（对照：renderer-log-handler 的不可信 IPC payload 才校验）。
 */
export interface RendererConsoleMessageParams {
  /** Chromium 控制台级别（字符串枚举 'info'|'warning'|'error'|'debug'；白名单外丢弃）。 */
  level: string
  message: string
  lineNumber: number
  sourceId: string
}

/**
 * 处理一条 renderer console 消息：level 过滤 → 限流判定 → 六标量字段 JSON 行落盘。
 * 任何管道自身故障（磁盘满/权限/EISDIR/畸形字段访问）都不外抛（fail-safe，D3①：
 * 日志通道故障不得拖垮 main 事件回调）；首次故障 mainLogger.warn 一次。
 *
 * @param windowId webContents.id（U2 传入，main 权威数字 id——与 renderer-error
 *   文件的 event.sender.id 同语义，跨文件窗口对账用）
 */
export function handleRendererConsoleMessage(windowId: number, params: RendererConsoleMessageParams): void {
  try {
    if (!PERSISTED_LEVELS.has(params.level)) return
    const now = Date.now()
    if (!admitUnderRateLimit(windowId, now)) return
    writeRendererConsoleLine({
      ts: new Date(now).toISOString(),
      windowId,
      level: params.level,
      sourceId: params.sourceId,
      // lineNumber 0（Chromium 未给出行号）原样保留：结构化 JSON 字段中 0 无歧义，
      // 不引入拼接形态（sourceId:lineNumber）才需要的「0 省略」特判
      lineNumber: params.lineNumber,
      message: truncateMessageBytes(params.message),
    })
  } catch (err) {
    // fail-safe（D3①）：静默吞不炸回调 + 首次故障 warn 一次（模块级布尔去重防刷屏
    // ——unresponsiveJournaled 惯用法），排障时区分「管道死」与「无事件」。
    // mainLogger.warn 自身零抛（writeLogEntry 内部吞），不会从 catch 反向炸出。
    if (!firstFailureWarned) {
      firstFailureWarned = true
      mainLogger.warn('[renderer-console-handler] console log persistence failed; further failures suppressed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

// ── 限流（先例 renderer-log-handler 全套复刻，含 sweepIdleEntries）──

// 限流状态模块级单例；测试经 vi.resetModules 取全新实例（先例同款）
interface RateLimitState {
  windowStartMs: number
  /** 本窗口已落盘条数（不含汇总行）。 */
  written: number
  /** 超限被丢弃条数（窗口翻转时合并为一条汇总行）。 */
  dropped: number
}
const stateByWindowId = new Map<number, RateLimitState>()
let logDirEnsured = ''
let firstFailureWarned = false

/**
 * 限流判定与计数：每 windowId 独立窗口（验收条款：跨窗口独立）；窗口翻转时若有
 * dropped，先落一条汇总行（含 dropped count）再开新窗口。返回 true = 允许落盘。
 */
function admitUnderRateLimit(windowId: number, now: number): boolean {
  sweepIdleEntries(now)
  let state = stateByWindowId.get(windowId)
  if (!state || now - state.windowStartMs >= RATE_LIMIT_WINDOW_MS) {
    if (state && state.dropped > 0) writeRateLimitSummary(windowId, state, now)
    state = { windowStartMs: now, written: 0, dropped: 0 }
    stateByWindowId.set(windowId, state)
  }
  if (state.written >= RENDERER_CONSOLE_RATE_LIMIT_PER_WINDOW) {
    state.dropped++
    return false
  }
  state.written++
  return true
}

/** 汇总行：超限丢弃计数合并为一条（设计 D3②），同时镜像 warn 进 main log（风暴痕迹在 main log 侧可查）。 */
function writeRateLimitSummary(windowId: number, state: RateLimitState, now: number): void {
  writeRendererConsoleLine({
    ts: new Date(now).toISOString(),
    windowId,
    kind: 'rate-limit-summary',
    dropped: state.dropped,
    windowStart: new Date(state.windowStartMs).toISOString(),
  })
  mainLogger.warn('[renderer-console-handler] rate-limited renderer console messages', {
    windowId,
    dropped: state.dropped,
    windowMs: RATE_LIMIT_WINDOW_MS,
  })
}

/** 惰性清扫：窗口已过期且空闲超阈值的 entry 删除（dropped 未 flush 视为仍活跃，保留）。 */
function sweepIdleEntries(now: number): void {
  for (const [id, s] of stateByWindowId) {
    if (
      now - s.windowStartMs >= RATE_LIMIT_WINDOW_MS &&
      now - (s.windowStartMs + RATE_LIMIT_WINDOW_MS) >= RATE_LIMIT_ENTRY_IDLE_MS &&
      s.dropped === 0
    ) {
      stateByWindowId.delete(id)
    }
  }
}

// ── 落盘（紧凑 JSON 行）────────────────────────────────────────────

/**
 * message 字节帽截断：按 UTF-8 字节计（体积量级折算的预算口径），切点在多字节
 * 字符中间时回退到字符首字节边界，不产出半个字符的替换符（U+FFFD）。
 */
function truncateMessageBytes(message: string): string {
  if (Buffer.byteLength(message, 'utf8') <= MAX_MESSAGE_BYTES) return message
  const buf = Buffer.from(message, 'utf8')
  let end = MAX_MESSAGE_BYTES
  // 切点落在续字节上说明拆了多字节字符，回退到字符首字节
  while (end > 0 && (buf[end] & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION_VALUE) end--
  return buf.subarray(0, end).toString('utf8')
}

/**
 * 写一行 JSON 记录到 renderer-console-<date>.log。同步 append（设计 D3③：低频
 * 诊断通道，无写流无 flush 面）；写失败**上抛**到入口 catch 由 warn-once 兜底
 * ——与 renderer-log-handler 的 writer 内吞形态刻意不同，理由见文件头偏离①。
 */
function writeRendererConsoleLine(record: Record<string, unknown>): void {
  const dir = ensureLogDir()
  const file = join(dir, `renderer-console-${new Date().toISOString().slice(0, ISO_DATE_LENGTH)}.log`)
  rollSizeIfOverBudget(file)
  appendFileSync(file, JSON.stringify(record) + '\n', 'utf-8')
}

/**
 * 惰性确保 logs/ 存在（main-logger init 已建；测试/降级路径直调时兜底，成功后
 * 缓存路径防每条 mkdir）。失败上抛——目录建不起来 = 管道死信号，归入口 warn-once。
 */
function ensureLogDir(): string {
  const dir = join(getDataDir(), 'logs')
  if (logDirEnsured !== dir) {
    mkdirSync(dir, { recursive: true })
    logDirEnsured = dir
  }
  return dir
}

/**
 * size 滚动（单代 .1，对齐 main-logger / renderer-error 先例形态）：无持有型 fd，
 * rename 覆盖旧 .1 无孤儿 inode 风险；帽值复用 TAIJI_LOG_MAX_BYTES 同一旋钮。
 */
function rollSizeIfOverBudget(file: string): void {
  try {
    if (statSync(file).size > readMainLogMaxBytes()) {
      renameSync(file, `${file}.1`)
    }
  // eslint-disable-next-line taste/no-silent-catch -- 预检/滚动失败（首写 ENOENT=常态；IO 异常）不阻塞主 append——轮转是 best-effort 附属功能，失败只丢滚动不丢数据；滚动失败不属于「管道死」（append 仍可写），不触发首错 warn
  } catch {
    // no-op
  }
}
