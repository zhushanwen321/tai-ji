/**
 * renderer-log IPC handler（crash-resilience §3.3 D2-② / u2-renderer-errors +
 * crash-forensics §3.3 D8 结构化标记承接）。
 *
 * 接收 renderer 三件套（app.config.errorHandler / window error / unhandledrejection）
 * 经 RENDERER_LOG 通道上报的错误，落盘 `logs/renderer-error-<date>.log`：
 * - **每条一行的紧凑 JSON 行**：JSON.stringify 把错误栈内换行转义为 \n 字面量，
 *   单行性与 main-logger foldNewlines 同效（grep 栈帧文本仍可命中），行级解析友好
 * - **按 windowId 限流（风暴防护）**：每窗口每分钟最多 100 条，超限计数合并为一条
 *   汇总行（含 dropped count，限流窗口翻转时落 `kind:"rate-limit-summary"`）——
 *   renderer 错误风暴不能分钟级刷 GB（设计 D2 原文）。汇总同时镜像一条 warn 进
 *   main log（mainLogger），崩溃取证时 main log 侧也有风暴痕迹
 * - **windowId main 权威**：取 `event.sender.id`（webContents id，每窗口稳定、reload
 *   不变），不信任 renderer 自报；windowId 不在 payload 类型内（ipc-payloads.ts）
 * - **handler 零抛错**：payload 运行时再校验（renderer 崩溃/中毒状态可能发畸形
 *   payload，类型不作信任依据）、落盘失败吞没——日志通道自身故障不得放大为 main
 *   崩溃或 invoke rejection 风暴（对齐 main-logger 写失败容错）
 *
 * 实现取舍（对齐 main-logger 的偏离点，均经论证）：
 * - **同步 appendFileSync 而非 WriteStream**：写入率被限流钳制在 ≤ ~101 行/分/窗口，
 *   低频诊断通道的同步 fs 写代价可忽略；换来无持有型 fd——size 滚动 rename 不存在
 *   「写方 fd 落孤儿 inode」问题类别（main-logger 为此付出 end→close→rename 顺序
 *   复杂度，本通道写入率低一档，不需要）
 * - **size 轮转复用 readMainLogMaxBytes() 同一旋钮**（TAIJI_LOG_MAX_BYTES，单代 .1
 *   滚动对齐）：超龄清理由 u5a 每日复扫兜底（log-retention.ts 前缀清单已含
 *   `renderer-error-`），size 帽防的是「单日内」限流满载折算的数百 MB 膨胀（D6-①
 *   双策略声明）
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import type { RendererLogPayload } from '@taiji/shared'
import { RENDERER_LOG } from '@taiji/shared'
import { getDataDir } from '@taiji/shared/paths'
import { readMainLogMaxBytes } from './main-logger.js'
import { mainLogger } from './main-logger.js'
import { crashJournal } from './crash-journal.js'

// ── 限流常量（设计 D2 原文：每窗口每分钟最多 100 条）─────────────────
export const RENDERER_LOG_RATE_LIMIT_PER_WINDOW = 100
const MS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const MS_PER_MINUTE = SECONDS_PER_MINUTE * MS_PER_SECOND
const RATE_LIMIT_WINDOW_MINUTES = 1
const RATE_LIMIT_WINDOW_MS = RATE_LIMIT_WINDOW_MINUTES * MS_PER_MINUTE
/** 限流 entry 惰性清扫阈值：窗口过期且再无活动的 entry 删除（防 webContents 销毁后泄漏）。 */
const RATE_LIMIT_ENTRY_IDLE_MINUTES = 10
const RATE_LIMIT_ENTRY_IDLE_MS = RATE_LIMIT_ENTRY_IDLE_MINUTES * MS_PER_MINUTE
/** senderFrame.url 落盘长度帽（超长 URL 不灌日志）。 */
const MAX_URL_LENGTH = 512
/** ISO 日期 YYYY-MM-DD 的字符长度（对齐 main-logger 同名常量）。 */
const ISO_DATE_LENGTH = 10
/** 台账 detailDigest 长度帽（schema D1：≤2KB 内嵌摘要）。 */
const DETAIL_DIGEST_MAX_LENGTH = 2048

// ── 限流状态（模块级单例；测试经 vi.resetModules 取全新实例）──────────
interface RateLimitState {
  windowStartMs: number
  /** 本窗口已落盘条数（不含汇总行）。 */
  written: number
  /** 超限被丢弃条数（窗口翻转时合并为一条汇总行）。 */
  dropped: number
}
const stateByWindowId = new Map<number, RateLimitState>()
let logDirEnsured = ''
let registered = false

// ── 注册 ───────────────────────────────────────────────────────────

/**
 * handler 依赖的 invoke event 结构最小面（sender.id + senderFrame.url）。
 * 不直接用 IpcMainInvokeEvent 签名：handler 对 event 只消费这两个字段，收窄结构让
 * 测试桩无需伪造 frameId/processId 等无关字段（结构类型，IpcMainInvokeEvent 可赋）。
 */
export interface RendererLogEventLike {
  sender?: { id?: unknown }
  senderFrame?: { url?: unknown } | null
}

/**
 * 注册 RENDERER_LOG handler。main.ts 组合链（registerIpcHandlers）调用一次；
 * 幂等（重复注册 Electron 会 throw「second handler」，标志位防重复注册炸启动）。
 */
export function registerRendererLogHandler(): void {
  if (registered) return
  registered = true
  try {
    ipcMain.handle(RENDERER_LOG, (_event: IpcMainInvokeEvent, payload: unknown) => {
      handleRendererLogReport(_event, payload)
      // 显式返回 undefined：invoke 方不消费返回值；handler 内部已零抛错，无 rejection 面
      return undefined
    })
    mainLogger.debug('[renderer-log-handler] registered', { channel: RENDERER_LOG })
  // eslint-disable-next-line taste/no-silent-catch -- 注册失败（极端：channel 被占）不能炸 main 启动；renderer 错误降级为无落盘，且此路径仅开发期可见
  } catch {
    // no-op
  }
}

// ── 核心处理（测试直入点）──────────────────────────────────────────

/**
 * 处理一条 renderer 错误上报：限流判定 → 组装 JSON 行落盘。任何输入/环境异常都
 * 不外抛（验收条款：handler 异常不外抛）。
 *
 * @param event invoke 事件（windowId 取 event.sender.id，url 取 event.senderFrame?.url）
 * @param payload renderer 上报（不可信输入，运行时再校验）
 */
export function handleRendererLogReport(event: RendererLogEventLike | undefined, payload: unknown): void {
  try {
    if (!isRendererLogPayload(payload)) return
    const now = Date.now()
    const windowId = typeof event?.sender?.id === 'number' ? event.sender.id : -1
    if (!admitUnderRateLimit(windowId, now)) return
    writeRendererErrorLine({
      ts: new Date(now).toISOString(),
      windowId,
      source: payload.source,
      message: payload.message,
      ...(payload.stack !== undefined ? { stack: payload.stack } : {}),
      ...(payload.sessionId !== undefined ? { sessionId: payload.sessionId } : {}),
      ...(payload.memory !== undefined ? { memory: payload.memory } : {}),
      ...(readSenderUrl(event) !== undefined ? { url: readSenderUrl(event) } : {}),
    })
    // 结构化标记（crash-forensics §3.3 D8 / D1 写入点矩阵）：入站超界帧丢弃上报 →
    // 崩溃台账行（main.jsonl `layer=renderer, event=inbound-frame-dropped`）。已过限流门
    // （与 renderer-error 行共享同一窗口配额，风暴防护对台账同样生效）；写失败在 writer
    // 内 best-effort 吞没，不影响 renderer-error 落盘主路径。
    if (payload.source === 'inbound-frame-dropped') {
      crashJournal.append({
        layer: 'renderer',
        event: 'inbound-frame-dropped',
        sessionId: payload.sessionId ?? null,
        reason: 'over-size-limit',
        detailDigest: payload.message.slice(0, DETAIL_DIGEST_MAX_LENGTH),
      })
    }
  // eslint-disable-next-line taste/no-silent-catch -- 上报处理失败（畸形 event/fs 异常等）不得外抛成 invoke rejection；renderer 侧三件套对 invoke reject 也已静默，此处吞没是同一容错契约的 main 侧半边
  } catch {
    // no-op
  }
}

// ── 限流 ───────────────────────────────────────────────────────────

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
  if (state.written >= RENDERER_LOG_RATE_LIMIT_PER_WINDOW) {
    state.dropped++
    return false
  }
  state.written++
  return true
}

/** 汇总行：超限丢弃计数合并为一条（设计 D2），同时镜像 warn 进 main log。 */
function writeRateLimitSummary(windowId: number, state: RateLimitState, now: number): void {
  writeRendererErrorLine({
    ts: new Date(now).toISOString(),
    windowId,
    kind: 'rate-limit-summary',
    dropped: state.dropped,
    windowStart: new Date(state.windowStartMs).toISOString(),
  })
  mainLogger.warn('[renderer-log-handler] rate-limited renderer error reports', {
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

// ── payload 运行时校验（不可信输入）────────────────────────────────

/**
 * 合法捕获面（RendererErrorSource 联合）：三件套（crash-resilience D2-①）+
 * 'inbound-frame-dropped' 结构化标记（crash-forensics D8 入站超界帧丢弃上报）。
 */
const VALID_SOURCES: ReadonlySet<string> = new Set([
  'vue-error-handler',
  'window-onerror',
  'unhandledrejection',
  'inbound-frame-dropped',
])

function isRendererLogPayload(v: unknown): v is RendererLogPayload {
  if (typeof v !== 'object' || v === null) return false
  const p = v as Record<string, unknown>
  if (!VALID_SOURCES.has(p.source as string)) return false
  if (typeof p.message !== 'string' || p.message.length === 0) return false
  if (typeof p.timestamp !== 'number' || !Number.isFinite(p.timestamp)) return false
  if (p.stack !== undefined && typeof p.stack !== 'string') return false
  if (p.sessionId !== undefined && typeof p.sessionId !== 'string') return false
  if (p.memory !== undefined && !isMemorySnapshot(p.memory)) return false
  return true
}

function isMemorySnapshot(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false
  const m = v as Record<string, unknown>
  return (
    typeof m.usedJSHeapSize === 'number' &&
    typeof m.totalJSHeapSize === 'number' &&
    typeof m.jsHeapSizeLimit === 'number'
  )
}

// ── 落盘（紧凑 JSON 行）────────────────────────────────────────────

function readSenderUrl(event: RendererLogEventLike | undefined): string | undefined {
  try {
    const url = event?.senderFrame?.url
    if (typeof url !== 'string' || url.length === 0) return undefined
    return url.length > MAX_URL_LENGTH ? url.slice(0, MAX_URL_LENGTH) : url
  } catch {
    // senderFrame 在 webContents 销毁竞态下访问可抛；url 是增强取证字段，缺失不影响核心落盘
    return undefined
  }
}

/**
 * 写一行 JSON 记录到 renderer-error-<date>.log。同步 append（理由见文件头取舍）；
 * 失败吞绝不外抛（日志通道故障不放大）。JSON.stringify 单行性 = 栈折叠能力
 * （换行转义为 \n 字面量，文件行数 == 记录条数）。
 */
function writeRendererErrorLine(record: Record<string, unknown>): void {
  try {
    const dir = ensureLogDir()
    if (!dir) return
    const file = join(dir, `renderer-error-${new Date().toISOString().slice(0, ISO_DATE_LENGTH)}.log`)
    rollSizeIfOverBudget(file)
    appendFileSync(file, JSON.stringify(record) + '\n', 'utf-8')
  // eslint-disable-next-line taste/no-silent-catch -- 落盘失败（磁盘满/权限/EISDIR）不能杀 main；mainLogger 镜像也走同一 logsDir，无更可靠诊断出口（对齐 main-logger 写失败容错）
  } catch {
    // no-op
  }
}

/** 惰性确保 logs/ 存在（main-logger init 已建；测试/降级路径直调时兜底，成功后缓存路径防每条 mkdir）。 */
function ensureLogDir(): string | undefined {
  try {
    const dir = join(getDataDir(), 'logs')
    if (logDirEnsured !== dir) {
      mkdirSync(dir, { recursive: true })
      logDirEnsured = dir
    }
    return dir
  } catch {
    // 目录创建失败（权限/磁盘）返回 undefined 降级丢弃，不外抛
    return undefined
  }
}

/**
 * size 滚动（单代 .1，对齐 main-logger openMainStream 形态）：无持有型 fd，
 * rename 覆盖旧 .1 无孤儿 inode 风险；帽值复用 TAIJI_LOG_MAX_BYTES 同一旋钮。
 */
function rollSizeIfOverBudget(file: string): void {
  try {
    if (statSync(file).size > readMainLogMaxBytes()) {
      renameSync(file, `${file}.1`)
    }
  // eslint-disable-next-line taste/no-silent-catch -- 预检/滚动失败（文件不存在=首写；IO 异常）不阻塞写入
  } catch {
    // no-op
  }
}
