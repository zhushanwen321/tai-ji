/**
 * runtime 内存看门狗（crash-forensics-and-watchdog.md §3.3 D4，实施单元 u6）。
 *
 * 职责：heap 用量周期采样 + 两级阈值判定 + memory-relief 降级动作点 + renderer WS 通知。
 * 与 mem-pressure.ts 的分工（D4 采样形态裁决）：本模块 = runtime 自身视角的 heap 百分比
 * （趋势判定需要历史 → 60s 采样环）；mem-pressure = 系统级 swap/物理空闲（判定时刻一拍
 * 即得 → 即时查询、无历史依赖）。两模块不共享状态，消费方各异（本模块 → relief 降级；
 * mem-pressure → reattach 高水位延迟 / D5 硬升级）。
 *
 * 趋势判定形态（D4）：`process.memoryUsage()` + `v8.getHeapStatistics().heap_size_limit`，
 * 持续性判定走连续拍计数器（consecutiveAboveWarn）+ 最近一拍样本（lastSample）——单拍
 * 采样即得，无历史依赖。【oe-audit C4】D4 原文的 24h 采样环已删：环只存内存不落盘、
 * 无 RPC / 不进诊断包 / 重启即丢，运行期判定不读环（走计数器），Gate W 水位复审的人工
 * 明细走既有 5min 水位日志行（startMemoryWatermarkTimer）——环是无出口的观测，删除
 * 不改变任何现役或武装后行为；armed 后若需分钟级历史，给水位日志加密采样即可（落盘、
 * 可复盘）。
 *
 * 两级阈值（相对 heap_size_limit，D4：告警 70% / 临界 85%，具体值 Gate W 校准；env 可覆盖）：
 * - warn（≥70%）：memory-relief 降级档——清可回收物（renderer LRU 收紧经 WS 通知通道）。
 * - critical（≥85%）：D5 滚动重启决策档——本单元只负责广播通知，决策入口由 u7c 消费。
 *
 * 持续性条件（降级反弹缓解，D4）：memory-relief 只在告警档**持续存在**（连续 2 个采样
 * 周期 ≥ 告警线）才执行——单周期越线可能是瞬时毛刺（如一次性大分配），立即清缓存反而
 * 制造「重建尖峰 → 直推临界档」的降级反弹（D4 风险声明原文）。
 *
 * 反弹缓解锁（一次语义）：relief 执行后若水位未回落（仍 ≥ 告警线）不重复执行——重复清
 * 可回收物无益（上次清理已证明水位不是可回收物撑起来的）且每次清理都可能再造重建尖峰。
 * 锁在水位回落到告警线以下（normal 拍）时重置，此后再次持续越线可再次执行。
 * 设计原文表述为「memory-relief 只在告警档持续存在（连续 2 个采样周期）且执行后水位未
 * 回落时才执行」，字面可读出相反语义（未回落才执行 = 反弹循环）；按 D4 降级反弹风险
 * 声明的意图（降级动作不得制造升级触发）与实施计划 u6 验收行 A4（「relief 执行后未
 * 回落 → 不重复执行；回落后再越线 → 可再次执行」）取本实现口径。
 *
 * 武装门（Gate W，设计 §3.2 方案 B / §5 env 命名）：`TAIJI_RUNTIME_WATCHDOG_ARMED` 默认
 * off——代码完整交付但降级动作默认不武装。off 时采样照跑（判定面运行，getStatus 可查），
 * relief 与 renderer 通知都不执行。
 *
 * best-effort 契约（对齐 crash-journal/mem-pressure：旁路设施故障不放大为调用链故障）：
 * 采样回调全量 try/catch，失败记一次主日志 warn（模块级 once 防周期失败刷屏）后静默；
 * relief 动作（onRelief 注入）抛错同样吞掉——台账照记（触发事实独立于动作成败）。
 *
 * 任务级墙钟语义声明（AGENTS 关键规则 19）：本模块是周期采样器（观测面），非任务超时
 * ——60s 周期是 D4 设计规定的采样粒度，不属「任务级默认无超时」约束对象。
 */
import { getHeapStatistics } from 'node:v8'
import type { CrashJournalWriter } from '@taiji/shared'
import type { WatchdogMemoryLevel, WatchdogMemoryPressurePayload } from '@taiji/shared'
import { logger } from './logger.js'
import { getCrashJournal } from './crash-journal.js'

// ─────────────────────────────────────────────────────────────────────────────
// 常量与默认值（初值随 Gate W 校准）
// ─────────────────────────────────────────────────────────────────────────────

/** 默认采样周期（D4：60s 采样环）。 */
export const DEFAULT_WATCHDOG_SAMPLE_INTERVAL_MS = 60_000

/** 告警档默认阈值（%，D4：相对 heap_size_limit 70%，Gate W 校准）。 */
export const DEFAULT_WATCHDOG_WARN_PERCENT = 70

/** 临界档默认阈值（%，D4：85%，Gate W 校准）。 */
export const DEFAULT_WATCHDOG_CRITICAL_PERCENT = 85

/** 百分比换算基数（usedPercent 刻度与 env 阈值合法性上界共用，禁裸 100）。 */
const PERCENT_SCALE = 100

/** relief 触发的持续周期数（D4：告警档连续 2 个采样周期）。 */
export const WATCHDOG_SUSTAIN_TICKS = 2

/**
 * env 旋钮名（设计 §5 钉死 `TAIJI_RUNTIME_WATCHDOG_*` 前缀，ENV_WHITELIST_PREFIXES 按前缀
 * 放行）。旋钮值 SSOT 暂在本模块本地定义（shared/constants.ts 领地外，u6 汇报登记）；
 * `_FORCE_PCT`（D5 硬升级 92%）属 u7c 滚动重启消费面，本单元不解析不消费。
 */
export const ENV_WATCHDOG_ARMED = 'TAIJI_RUNTIME_WATCHDOG_ARMED'
export const ENV_WATCHDOG_WARN_PCT = 'TAIJI_RUNTIME_WATCHDOG_WARN_PCT'
export const ENV_WATCHDOG_CRIT_PCT = 'TAIJI_RUNTIME_WATCHDOG_CRIT_PCT'
export const ENV_WATCHDOG_SAMPLE_MS = 'TAIJI_RUNTIME_WATCHDOG_SAMPLE_MS'

/** 单个采样样本。usedPercent = heapUsed / heapSizeLimit × 100。 */
export interface WatchdogSample {
  /** 采样时刻（epoch ms）。 */
  ts: number
  /** process.memoryUsage().heapUsed（bytes）。 */
  heapUsed: number
  /** v8.getHeapStatistics().heap_size_limit（bytes）。 */
  heapSizeLimit: number
  /** process.memoryUsage().rss（bytes）（台账用量快照字段与 schema rss 对齐）。 */
  rss: number
  /** heap 用量占比（0-100）。 */
  usedPercent: number
}

/** 看门狗运行态快照（观测面：getStatus 暴露，测试断言共用）。 */
export interface WatchdogStatus {
  /** 最近一拍档位（从未采样 = 'normal'）。 */
  level: 'normal' | WatchdogMemoryLevel
  /** 连续越线拍数（≥ 告警线连续计；normal 拍归零）。 */
  consecutiveAboveWarn: number
  /**
   * relief 锁状态：true = 可执行；false = 已执行且水位未回落（反弹缓解锁，见文件头）。
   */
  reliefAvailable: boolean
  /** 最近一拍样本（从未采样 = null）。 */
  lastSample: WatchdogSample | null
}

/** 看门狗启动选项（全部可注入；缺省值见各字段——生产接线经 resolveWatchdogConfig 展开）。 */
export interface WatchdogOptions {
  /** 武装门（Gate W）：false = 纯观测（采样照跑，relief/广播不执行）。 */
  armed?: boolean
  /** 采样周期 ms（默认 60_000）。 */
  sampleIntervalMs?: number
  /** 告警档阈值 %（默认 70）。 */
  warnPercent?: number
  /** 临界档阈值 %（默认 85）。 */
  criticalPercent?: number
  /** process.memoryUsage 注入（测试构造任意水位）。 */
  memoryUsage?: () => NodeJS.MemoryUsage
  /** heap 上限来源注入（测试固定分母；缺省 v8.getHeapStatistics().heap_size_limit）。 */
  heapSizeLimit?: () => number
  /** memory-relief 动作（清可回收物；生产接线在组合根，缺省无动作——广播与台账仍执行）。 */
  onRelief?: () => void
  /** renderer 广播出口（组合根注入 server.broadcast 包装；armed 且越线拍每拍调用）。 */
  broadcast?: (payload: WatchdogMemoryPressurePayload) => void
  /** 台账 writer（缺省 getCrashJournal()；测试注入 spy 断言事件字段）。 */
  journal?: CrashJournalWriter
  /** 时钟注入（采样 ts；测试配 fake timers 断言）。 */
  now?: () => number
}

/** 看门狗运行句柄（stop 供 shutdown 链与测试收口；getStatus 观测面）。 */
export interface WatchdogHandle {
  stop(): void
  getStatus(): WatchdogStatus
}

// ─────────────────────────────────────────────────────────────────────────────
// env 旋钮解析（对齐 startup-background-init resolveReclaimConfig 先例：env 是运维
// 逃生旋钮不是校验面，非法值 warn 回落默认，不 throw）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 解析看门狗 env 旋钮（独立导出便于单测；组合根展开进 startWatchdog 选项）。
 *
 * armed：仅 '1'/'true'（大小写不敏感）武装——Gate W 默认 off，任何其他值（含缺失）
 * 都不武装（fail-safe 向：漏配的代价 = 降级动作不执行 = 维持现状观测，不产生误动作）。
 * 百分比：非法值（非数字 / NaN / Infinity / ≤0 / ≥100）warn 回落默认。
 */
export function resolveWatchdogConfig(env: NodeJS.ProcessEnv): {
  armed: boolean
  sampleIntervalMs: number
  warnPercent: number
  criticalPercent: number
} {
  const rawArmed = env[ENV_WATCHDOG_ARMED]
  const armed = rawArmed === '1' || rawArmed?.toLowerCase() === 'true'
  const parsePercent = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined) return fallback
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0 || n >= PERCENT_SCALE) {
      logger.warn(`[watchdog] invalid env percent value "${raw}", falling back to ${fallback}%`)
      return fallback
    }
    return n
  }
  const rawInterval = env[ENV_WATCHDOG_SAMPLE_MS]
  let sampleIntervalMs = DEFAULT_WATCHDOG_SAMPLE_INTERVAL_MS
  if (rawInterval !== undefined) {
    const n = Number(rawInterval)
    if (!Number.isFinite(n) || n <= 0) {
      logger.warn(`[watchdog] invalid env interval value "${rawInterval}", falling back to ${DEFAULT_WATCHDOG_SAMPLE_INTERVAL_MS}ms`)
    } else {
      sampleIntervalMs = n
    }
  }
  return {
    armed,
    sampleIntervalMs,
    warnPercent: parsePercent(env[ENV_WATCHDOG_WARN_PCT], DEFAULT_WATCHDOG_WARN_PERCENT),
    criticalPercent: parsePercent(env[ENV_WATCHDOG_CRIT_PCT], DEFAULT_WATCHDOG_CRITICAL_PERCENT),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 采样与判定
// ─────────────────────────────────────────────────────────────────────────────

function defaultMemoryUsage(): NodeJS.MemoryUsage {
  return process.memoryUsage()
}

function defaultHeapSizeLimit(): number {
  return getHeapStatistics().heap_size_limit
}

/** 档位判定（纯函数）：≥ 临界档优先；≥ 告警档次之；否则 normal。 */
export function classifyMemoryLevel(
  usedPercent: number,
  warnPercent: number,
  criticalPercent: number,
): 'normal' | WatchdogMemoryLevel {
  if (usedPercent >= criticalPercent) return 'critical'
  if (usedPercent >= warnPercent) return 'warn'
  return 'normal'
}

// ─────────────────────────────────────────────────────────────────────────────
// 看门狗主体
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 启动看门狗（组合根 listen 成功后调用一次；测试直接构造注入全量依赖）。
 *
 * 返回句柄持 stop（clearInterval；观测态随实例丢弃，不跨重启）。
 * 定时器 unref：采样是旁路观测面，不得阻止进程自然退出（对齐水位定时器形态）。
 */
export function startWatchdog(options: WatchdogOptions = {}): WatchdogHandle {
  const armed = options.armed ?? false
  const sampleIntervalMs = options.sampleIntervalMs ?? DEFAULT_WATCHDOG_SAMPLE_INTERVAL_MS
  const warnPercent = options.warnPercent ?? DEFAULT_WATCHDOG_WARN_PERCENT
  const criticalPercent = options.criticalPercent ?? DEFAULT_WATCHDOG_CRITICAL_PERCENT
  const memoryUsage = options.memoryUsage ?? defaultMemoryUsage
  const heapSizeLimit = options.heapSizeLimit ?? defaultHeapSizeLimit
  const onRelief = options.onRelief
  const broadcast = options.broadcast
  const journal = options.journal ?? getCrashJournal()
  const now = options.now ?? (() => Date.now())

  let lastSample: WatchdogSample | null = null
  let consecutiveAboveWarn = 0
  let reliefAvailable = true
  let lastLevel: 'normal' | WatchdogMemoryLevel = 'normal'
  let stopped = false

  function takeSample(): WatchdogSample | null {
    // 采样分母防御：heapSizeLimit ≤ 0（异常 v8 状态）无法算百分比，跳过本拍。
    const limit = heapSizeLimit()
    if (!Number.isFinite(limit) || limit <= 0) return null
    const usage = memoryUsage()
    const sample: WatchdogSample = {
      ts: now(),
      heapUsed: usage.heapUsed,
      heapSizeLimit: limit,
      rss: usage.rss,
      usedPercent: (usage.heapUsed / limit) * PERCENT_SCALE,
    }
    lastSample = sample
    return sample
  }

  /** relief 执行点：动作 best-effort + 台账落 memory-relief 事件（触发事实独立于动作成败）。 */
  function fireRelief(sample: WatchdogSample): void {
    reliefAvailable = false
    try {
      onRelief?.()
    } catch (e) {
      // relief 动作失败不阻断台账与后续采样（旁路降级设施故障不放大，文件头契约）；
      // relief 由反弹缓解锁保障单水位周期至多一次，此处 warn 不会刷屏。
      logger.warn(`[watchdog] onRelief action failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    // 台账字段（D1 schema）：level 走 reason='warn-tier'（触发条件档位 = 告警线持续，
    // 已知值登记面复用）；用量快照 = heapUsed + rss（schema 同名字段直通）。
    journal.append({
      layer: 'runtime',
      event: 'memory-relief',
      reason: 'warn-tier',
      heapUsed: sample.heapUsed,
      rss: sample.rss,
    })
    logger.warn(`[watchdog] memory-relief fired at ${sample.usedPercent.toFixed(1)}% heap (sustained ${consecutiveAboveWarn} ticks)`)
  }

  function tick(): void {
    // 全量容错（best-effort 契约）：采样/判定/广播/relief 任一异常不逃逸出定时器回调。
    try {
      const sample = takeSample()
      if (sample === null) return
      const level = classifyMemoryLevel(sample.usedPercent, warnPercent, criticalPercent)
      lastLevel = level
      if (level === 'normal') {
        // 回落：持续计数归零 + 反弹缓解锁重置（A4：回落后再越线可再次执行）。
        consecutiveAboveWarn = 0
        reliefAvailable = true
        return
      }
      consecutiveAboveWarn++
      if (!armed) return // Gate W off：纯观测（判定面照算，lastSample 可查），无动作无通知
      broadcast?.({
        level,
        heapUsed: sample.heapUsed,
        heapSizeLimit: sample.heapSizeLimit,
        usedPercent: Math.round(sample.usedPercent * PERCENT_SCALE) / PERCENT_SCALE,
        warnPercent,
        criticalPercent,
      })
      // 持续性条件：连续 2 拍越告警线才 relief（单拍毛刺不触发，A2）；反弹缓解锁
      // 内的拍只计数不执行（A4：执行后未回落不重复）。
      if (consecutiveAboveWarn >= WATCHDOG_SUSTAIN_TICKS && reliefAvailable) {
        fireRelief(sample)
      }
    } catch {
      reportTickFailureOnce()
    }
  }

  const timer = setInterval(tick, sampleIntervalMs)
  timer.unref?.()

  return {
    stop(): void {
      if (stopped) return
      stopped = true
      clearInterval(timer)
    },
    getStatus(): WatchdogStatus {
      return {
        level: lastLevel,
        consecutiveAboveWarn,
        reliefAvailable,
        lastSample,
      }
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 失败上报（模块级 once：周期回调失败只刷一条主日志，防采样失败风暴）
// ─────────────────────────────────────────────────────────────────────────────

let tickFailureReported = false
function reportTickFailureOnce(): void {
  if (tickFailureReported) return
  tickFailureReported = true
  logger.warn('[watchdog] sample tick failed once; further tick failures suppressed (best-effort observer)')
}
