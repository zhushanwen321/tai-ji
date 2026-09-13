/**
 * rolling-restart —— 优雅滚动重启执行链（crash-forensics-and-watchdog.md §3.3 D5，
 * 实施单元 u7c）。
 *
 * 职责（单一变化轴「滚动重启决策与推迟编排」）：
 * - 触发：看门狗 critical 档（u6 广播 watchdog:memoryPressure level='critical'）进入
 *   决策——warn 档是 relief 降级（u6），不进本模块。
 * - 推迟判定谓词（D5 ①，两源并集；2026-09-13 oe-audit 删第三源「引擎侧快照」——
 *   引擎池活在 pi 进程、runtime 进程内无引擎实例，注入槽自交付起零接线，引擎宿主
 *   迁入 runtime 侧时再按 git 历史恢复）：
 *   ① pi 侧镜像（inflight-mirror，u7b）：遍历活跃 session，绝对计数 >0 即在途；
 *      「已注入但从未收到上报」（errs/absent-report，reporter 放弃 / 通道结构性故障）
 *      → 推迟且计数未知（deferred 事件 inflight=null——u7b 配方：0 = 在场且无在途的
 *      已证事实，null = 计数未知）。Path A 保活天然被镜像谓词排除：上报口径即
 *      `hasLiveProcessHandle && !hasIdleTimer`（extension 侧 getInFlightSnapshot 双谓词），
 *      settled 后等待续聊的进程不计数 → 不推迟。
 *   ② relay-registry 在途子进程（kill-on-disconnect 同一注册表，size 即在途数）——经
 *      relayInFlight 注入槽消费，生产接线在组合根 index.ts（services 层不直连有状态
 *      IO infra）；未注入 = 该维不贡献（0）。
 * - 推迟有界可升级（D5 ②）：命中 → deferred 相位，每拍重判；上限
 *   XYZ_ROLLING_RESTART_DEFER_LIMIT_MS（默认 30min）到点强制执行 reason=defer-limit；
 *   双维硬升级 = heap ≥ XYZ_RUNTIME_WATCHDOG_FORCE_PCT（默认 92%）或 memPressure 越限
 *   （mem-pressure.ts isMemPressureHigh，即时系统级查询），任一命中跳过推迟立即执行
 *   reason=hard-threshold。errs 推迟无完成信号、必然走到上限（其 defer-limit 在评估器
 *   #8 占比子句分子中被排除，absent-report 单列观测）。
 * - 执行（D5 ③）：非 forced 路径先进 countdown 相位（T-30s 二次预告广播，覆盖推迟期内
 *   新开终端的知情窗口），到点触发 onExecute（组合根注入 = 完整 shutdown 序 + 专用退出
 *   码 86 退出）；forced 路径红牌即执行（无 30s 等待）。退出链本体在 index.ts 逐行继承
 *   既有 shutdown 序（本模块不写任何退出逻辑）。
 * - 状态可拉取（D5 ③）：getStatus 返回 RollingRestartStatusPayload，经只读 RPC
 *   rollingRestart.status 供 renderer 重连/刷新后拉取恢复横幅；deferred/forced/countdown
 *   广播只作加速显示（「broadcast 时序竞争」教训）。
 * - 台账（D1/D5）：deferred 开始记 rolling-restart-deferred（携带当时镜像在途计数）；
 *   forced 记 rolling-restart-forced（reason=hard-threshold | defer-limit）；执行记
 *   rolling-restart。
 *
 * 武装门（Gate W，B2）：armed=false 时 onMemoryPressure 零动作（无判定无事件无执行）——
 * u6「代码完整交付、武装挂门」语义延伸到重启编排。armed 由组合根按
 * XYZ_RUNTIME_WATCHDOG_ARMED 解析传入（与 watchdog 同一 resolveWatchdogConfig 结果）。
 *
 * best-effort 契约（对齐 watchdog/mem-pressure）：决策链全量容错，判定/台账/广播任一
 * 异常不逃逸出定时器回调与广播入口。
 *
 * 任务级墙钟语义声明（AGENTS 关键规则 19）：defer 上限与 countdown 是 D5 设计规定的
 * 推迟窗口边界（重启编排自身的有界性），不属「任务级默认无超时」约束对象；在途任务
 * 本身不受任何墙钟限制。
 */
import { getHeapStatistics } from 'node:v8'
import type {
  CrashJournalEventName,
  CrashJournalWriter,
  RollingRestartCountdownPayload,
  RollingRestartDeferredPayload,
  RollingRestartForcedPayload,
  RollingRestartInflightSummary,
  RollingRestartReason,
  RollingRestartState,
  RollingRestartStatusPayload,
  WatchdogMemoryPressurePayload,
} from '@xyz-agent/shared'
import { logger } from '../../infra/logger.js'
import { getCrashJournal } from '../../infra/crash-journal.js'
import { isMemPressureHigh, queryMemPressure } from '../../infra/mem-pressure.js'
import { inflightMirror, type InFlightMirror } from './inflight-mirror.js'

// ─────────────────────────────────────────────────────────────────────────────
// 常量与默认值（初值随 Gate W 校准）
// ─────────────────────────────────────────────────────────────────────────────

/** env 旋钮：推迟上限 ms（设计 §5 钉死命名，A4 注入短上限端到端验证 defer-limit 路径）。 */
export const ENV_ROLLING_RESTART_DEFER_LIMIT_MS = 'XYZ_ROLLING_RESTART_DEFER_LIMIT_MS'

/**
 * env 旋钮：硬升级 heap 阈值 %（设计 §5 `XYZ_RUNTIME_WATCHDOG_FORCE_PCT`，D5 双维硬
 * 升级第一维）。u6 watchdog.ts 明确「本单元不解析不消费」——常量与解析都归本模块。
 */
export const ENV_WATCHDOG_FORCE_PCT = 'XYZ_RUNTIME_WATCHDOG_FORCE_PCT'

/** 推迟上限默认值（D5：30 分钟）。 */
// eslint-disable-next-line no-magic-numbers -- 设计标定值（D5 ②），校准依据见上方 JSDoc
export const DEFAULT_ROLLING_RESTART_DEFER_LIMIT_MS = 30 * 60 * 1000

/** 推迟期重判间隔（defer 窗口；设计未钉粒度——30s 对在途任务完成检测足够细且低频）。 */
// eslint-disable-next-line no-magic-numbers -- 编排粒度取值，非任务超时（见文件头墙钟声明）
export const DEFAULT_ROLLING_RESTART_DEFER_RETRY_MS = 30 * 1000

/** T-30s 二次预告时长（D5 ③「执行前 30s 二次广播预告」）。 */
// eslint-disable-next-line no-magic-numbers -- 设计标定值（D5 ③）
export const DEFAULT_ROLLING_RESTART_COUNTDOWN_MS = 30 * 1000

/** 硬升级 heap 阈值默认（D5：92%，Gate W 校准）。 */
export const DEFAULT_ROLLING_RESTART_FORCE_PERCENT = 92

/** 百分比换算基数（heapPercent 缺省实现与 env 阈值合法性上界共用）。 */
const PERCENT_SCALE = 100

// ─────────────────────────────────────────────────────────────────────────────
// shutdown 步骤打点（A4 机械验证继承完整性的可测面）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 完整 shutdown 序的步骤名（index.ts shutdown 逐行继承既有链，本清单是「打点序列」
 * 的 SSOT——index.ts 每步经 shutdownStep(常量成员) 打点，写错名字 tsc 红）。
 *
 * 顺序契约（D5 退出链）：首步 = 取消推迟定时器（app 级退出 / 86 执行中不得再入滚动
 * 重启）；引擎池 dispose 在 server.stop 之后、closeLogger 之前（杀链期间日志与 stderr
 * tee 要经 logger 落盘，closeLogger 先行则现场丢失）；close-crash-journal 在
 * closeLogger 之前（台账尾部行——server.stop→destroyAll 触发的 shutdown/deleted 行经
 * 异步缓冲——必须等落盘后才能 process.exit，且台账 close 自身的降级日志仍能经 logger
 * 落盘）。中间步骤与 index.ts 既有链逐行同序（只加打点，不重排）。
 */
export const SHUTDOWN_STEP_SEQUENCE = [
  'cancel-rolling-restart',
  'stop-memory-watermark-timer',
  'stop-watchdog',
  'cancel-pending-respawns',
  'stop-idle-reaper',
  'flush-stores',
  'dispose-skill-registry',
  'dispose-completion-backflow',
  'deinit-relay-server',
  'server-stop',
  'engine-pool-dispose',
  'close-crash-journal',
  'close-logger',
] as const

export type ShutdownStepName = (typeof SHUTDOWN_STEP_SEQUENCE)[number]

/** 打点单步（console 经 initLogger monkey-patch 自动 tee 进 runtime-*.log，A4 验收读日志断言）。 */
export function shutdownStep(name: ShutdownStepName): void {
  console.log(`[runtime] shutdown step: ${name}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// env 旋钮解析（对齐 resolveWatchdogConfig 先例：非法值 warn 回落默认，不 throw）
// ─────────────────────────────────────────────────────────────────────────────

/** 解析滚动重启 env 旋钮（独立导出便于单测；组合根展开进 startRollingRestart 选项）。 */
export function resolveRollingRestartConfig(env: NodeJS.ProcessEnv): {
  deferLimitMs: number
  forcePercent: number
} {
  const parsePositive = (raw: string | undefined, fallback: number, label: string): number => {
    if (raw === undefined) return fallback
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) {
      logger.warn(`[rolling-restart] invalid env ${label} value "${raw}", falling back to ${fallback}`)
      return fallback
    }
    return n
  }
  const forcePercent = parsePositive(env[ENV_WATCHDOG_FORCE_PCT], DEFAULT_ROLLING_RESTART_FORCE_PERCENT, ENV_WATCHDOG_FORCE_PCT)
  if (forcePercent >= PERCENT_SCALE) {
    logger.warn(`[rolling-restart] invalid env ${ENV_WATCHDOG_FORCE_PCT} value "${String(env[ENV_WATCHDOG_FORCE_PCT])}" (must be < 100), falling back to ${DEFAULT_ROLLING_RESTART_FORCE_PERCENT}%`)
  }
  return {
    deferLimitMs: parsePositive(env[ENV_ROLLING_RESTART_DEFER_LIMIT_MS], DEFAULT_ROLLING_RESTART_DEFER_LIMIT_MS, ENV_ROLLING_RESTART_DEFER_LIMIT_MS),
    forcePercent: forcePercent >= PERCENT_SCALE ? DEFAULT_ROLLING_RESTART_FORCE_PERCENT : forcePercent,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 编排主体
// ─────────────────────────────────────────────────────────────────────────────

/** rollingRestart 域 WS 推送类型（Server→Client 冒号 camelCase，见 protocol.ts）。 */
export type RollingRestartBroadcastType = 'rollingRestart:deferred' | 'rollingRestart:countdown' | 'rollingRestart:forced'

/** rollingRestart 域推送的 payload 联合。 */
export type RollingRestartBroadcastPayload =
  | RollingRestartDeferredPayload
  | RollingRestartCountdownPayload
  | RollingRestartForcedPayload

/** 滚动重启编排启动选项（全量注入；缺省值见各字段——生产接线经 resolveRollingRestartConfig 展开）。 */
export interface RollingRestartOptions {
  /** 武装门（Gate W）：false = 零动作（onMemoryPressure 直接忽略）。 */
  armed?: boolean
  /** pi 侧在途镜像（缺省进程级单例 inflightMirror）。 */
  mirror?: InFlightMirror
  /** 活跃 session 清单（判定遍历域；缺省空表——组合根注入 sessionService.getActiveSessionIds）。 */
  listSessionIds?: () => string[]
  /**
   * relay 在途子进程数（D5 判定源 ②：kill-on-disconnect 同一注册表的 size）。生产由
   * 组合根接线（index.ts 持有 registry 句柄）；**未注入 = 0 = 谓词该维不贡献**（services
   * 层禁止 value import 有状态 IO infra，check_services_infra_import 守卫）。
   */
  relayInFlight?: () => number
  /** heap 用量百分比（0-100；缺省即时查 process.memoryUsage / v8 heap_size_limit）。 */
  heapPercent?: () => number
  /** 系统内存高压判定（D5 双维硬升级第二维；缺省 mem-pressure 即时查询 + isMemPressureHigh）。 */
  memPressureHigh?: () => Promise<boolean> | boolean
  /** 执行动作（组合根注入 = 完整 shutdown 序 + 退出码 86；缺省无动作——纯决策可测）。 */
  onExecute?: () => void
  /** WS 广播出口（缺省无动作；组合根注入 server.broadcast 包装）。 */
  broadcast?: (type: RollingRestartBroadcastType, payload: RollingRestartBroadcastPayload) => void
  /** 台账 writer（缺省 getCrashJournal()；测试注入 spy 断言事件字段）。 */
  journal?: CrashJournalWriter
  /** 推迟上限 ms（默认 30min；env XYZ_ROLLING_RESTART_DEFER_LIMIT_MS）。 */
  deferLimitMs?: number
  /** 推迟期重判间隔 ms（默认 30s）。 */
  deferRetryMs?: number
  /** T-30s 预告时长 ms（默认 30s）。 */
  countdownMs?: number
  /** 硬升级 heap 阈值 %（默认 92；env XYZ_RUNTIME_WATCHDOG_FORCE_PCT）。 */
  forcePercent?: number
  /** 时钟注入（deadline 计算；测试配 fake timers）。 */
  now?: () => number
}

/** 滚动重启编排句柄（组合根持广播喂入与 status provider；cancel 供 shutdown 首步）。 */
export interface RollingRestartHandle {
  /** 看门狗越线拍喂入：warn 档（relief）忽略，critical 档进入重启决策；未武装零动作。 */
  onMemoryPressure(payload: WatchdogMemoryPressurePayload): void
  /** 状态快照（只读 RPC rollingRestart.status 的 provider；idle = 横幅不重现）。 */
  getStatus(): RollingRestartStatusPayload
  /**
   * 取消推迟/预告定时器并复位状态机（D5 退出链首步：app 级退出与 86 执行序开始时
   * 调用——执行中不得再入）。幂等。
   */
  cancel(): void
}

/** 在途判定结果（汇总语义：任一 session errs → 整体计数未知，errs-safe 方向）。 */
interface InflightEvaluation {
  /** 存在「已注入但从未上报」的 session（D5 ④ errs 推迟形态）。 */
  errsAbsent: boolean
  /** 已知镜像在途计数合计（errs 命中时不可信，summary 已收敛为 null）。 */
  total: number
  /** 事件/推送载荷形态（errs → inFlight=null；否则数字）。 */
  summary: RollingRestartInflightSummary
}

/**
 * 启动滚动重启编排（组合根 listen 成功后调用一次；测试直接构造注入全量依赖）。
 *
 * 定时器 unref：推迟/预告定时器不得阻止进程自然退出（对齐水位定时器/watchdog 形态）；
 * shutdown 首步 cancel 是显式收口。
 */
export function startRollingRestart(options: RollingRestartOptions = {}): RollingRestartHandle {
  const armed = options.armed ?? false
  const mirror = options.mirror ?? inflightMirror
  const listSessionIds = options.listSessionIds ?? (() => [])
  const relayInFlight = options.relayInFlight ?? (() => 0)
  const heapPercent = options.heapPercent ?? defaultHeapPercent
  const memPressureHigh = options.memPressureHigh ?? defaultMemPressureHigh
  const onExecute = options.onExecute
  const broadcast = options.broadcast
  const journal = options.journal ?? getCrashJournal()
  const now = options.now ?? (() => Date.now())

  const deferLimitMs = options.deferLimitMs ?? DEFAULT_ROLLING_RESTART_DEFER_LIMIT_MS
  const deferRetryMs = options.deferRetryMs ?? DEFAULT_ROLLING_RESTART_DEFER_RETRY_MS
  const countdownMs = options.countdownMs ?? DEFAULT_ROLLING_RESTART_COUNTDOWN_MS
  const forcePercent = options.forcePercent ?? DEFAULT_ROLLING_RESTART_FORCE_PERCENT

  let phase: RollingRestartState = 'idle'
  /** deferred 相位成因（'inflight' | 'absent-report'）；其余相位 undefined。 */
  let phaseReason: Extract<RollingRestartReason, 'inflight' | 'absent-report'> | undefined
  /** 最近一次在途摘要（status 推送载荷；idle 相位 undefined）。 */
  let lastSummary: RollingRestartInflightSummary | undefined
  /** deferred 上限到点时刻（ms epoch；非 deferred 相位 undefined）。 */
  let deferDeadlineAt: number | undefined
  let deferTimer: NodeJS.Timeout | undefined
  let countdownTimer: NodeJS.Timeout | undefined
  /** 一次句柄一次执行（execute 后拒绝再入——重启序开始后决策面必须静默）。 */
  let executed = false

  function clearTimers(): void {
    if (deferTimer !== undefined) clearTimeout(deferTimer)
    if (countdownTimer !== undefined) clearTimeout(countdownTimer)
    deferTimer = undefined
    countdownTimer = undefined
  }

  // ── 判定面（D5 ①）──

  function evaluateInflight(): InflightEvaluation {
    let total = 0
    let errsAbsent = false
    for (const sid of listSessionIds()) {
      if (mirror.errsShape(sid) === 'absent-report') errsAbsent = true
      const entry = mirror.query(sid)
      if (entry && entry.inFlight > 0) total += entry.inFlight
    }
    total += relayInFlight()
    // errs 收敛（u7b 配方）：任一 session 计数未知 → 整体计数未知（null），errs-safe
    // 方向 = 推迟有 30min 上限封顶，不因未知计数而漏推迟。
    return {
      errsAbsent,
      total,
      summary: errsAbsent ? { inFlight: null } : { inFlight: total },
    }
  }

  /** 双维硬升级（D5 ②）：heap ≥ forcePercent 或系统 memPressure 越限，任一命中即真。 */
  async function isHardUpgrade(): Promise<boolean> {
    if (heapPercent() >= forcePercent) return true
    return await memPressureHigh()
  }

  /** 用量快照（台账 heapUsed 字段；判定源缺省实现的字节值，字段全可空原则下可缺省）。 */
  function heapUsedBytes(): number | undefined {
    try {
      return process.memoryUsage().heapUsed
    } catch {
      return undefined
    }
  }

  // ── 动作面（D5 ②③）──

  function journalAppend(event: CrashJournalEventName, reason: string | undefined, summary: RollingRestartInflightSummary): void {
    journal.append({
      layer: 'runtime',
      event,
      ...(reason !== undefined ? { reason } : {}),
      inflight: summary.inFlight,
      heapUsed: heapUsedBytes(),
    })
  }

  function execute(forcedReason: 'hard-threshold' | 'defer-limit' | undefined, summary: RollingRestartInflightSummary): void {
    if (executed) return
    executed = true
    clearTimers()
    deferDeadlineAt = undefined
    phase = 'rolling'
    phaseReason = undefined
    lastSummary = summary
    if (forcedReason !== undefined) {
      journalAppend('rolling-restart-forced', forcedReason, summary)
      broadcast?.('rollingRestart:forced', { reason: forcedReason, inflight: summary })
    } else {
      journalAppend('rolling-restart', undefined, summary)
    }
    logger.warn(`[rolling-restart] executing graceful shutdown (reason=${forcedReason ?? 'planned'})`)
    onExecute?.()
  }

  function enterCountdown(summary: RollingRestartInflightSummary): void {
    phase = 'countdown'
    phaseReason = undefined
    lastSummary = summary
    const executesAt = now() + countdownMs
    broadcast?.('rollingRestart:countdown', { executesAt, inflight: summary })
    countdownTimer = setTimeout(() => {
      countdownTimer = undefined
      execute(undefined, summary)
    }, countdownMs)
    countdownTimer.unref?.()
  }

  function enterDeferred(infl: InflightEvaluation): void {
    phase = 'deferred'
    phaseReason = infl.errsAbsent ? 'absent-report' : 'inflight'
    lastSummary = infl.summary
    deferDeadlineAt = now() + deferLimitMs
    journalAppend('rolling-restart-deferred', phaseReason, infl.summary)
    broadcast?.('rollingRestart:deferred', {
      reason: phaseReason,
      inflight: infl.summary,
      deferDeadlineAt,
    })
    scheduleDeferTick()
  }

  function scheduleDeferTick(): void {
    deferTimer = setTimeout(() => {
      deferTimer = undefined
      void deferTick()
    }, deferRetryMs)
    deferTimer.unref?.()
  }

  async function deferTick(): Promise<void> {
    if (phase !== 'deferred' || deferDeadlineAt === undefined) return
    if (now() >= deferDeadlineAt) {
      execute('defer-limit', evaluateInflight().summary)
      return
    }
    if (await isHardUpgrade()) {
      execute('hard-threshold', evaluateInflight().summary)
      return
    }
    const infl = evaluateInflight()
    if (!infl.errsAbsent && infl.total === 0) {
      enterCountdown(infl.summary)
      return
    }
    scheduleDeferTick()
  }

  /** critical 档决策入口（fire-and-forget；判定含异步 memPressure 查询）。 */
  async function decide(): Promise<void> {
    if (executed) return
    // countdown 相位复查硬升级（S-4）：30s 窗口内 heap 升至 force 阈值 → 升级立即执行，
    // 按 forced=hard-threshold 记账（否则最终以 planned 记账，与 D5 归因语义漂移）
    if (phase === 'countdown') {
      if (await isHardUpgrade()) {
        execute('hard-threshold', lastSummary ?? evaluateInflight().summary)
      }
      return
    }
    if (phase !== 'idle') return
    if (await isHardUpgrade()) {
      execute('hard-threshold', evaluateInflight().summary)
      return
    }
    const infl = evaluateInflight()
    if (infl.errsAbsent || infl.total > 0) {
      enterDeferred(infl)
      return
    }
    enterCountdown(infl.summary)
  }

  return {
    onMemoryPressure(payload: WatchdogMemoryPressurePayload): void {
      if (!armed) return // Gate W off：零动作（B2）
      if (payload.level !== 'critical') return // warn = relief 档（u6），非本模块决策输入
      void decide().catch((e) => {
        logger.warn(`[rolling-restart] decision flow failed (best-effort): ${e instanceof Error ? e.message : String(e)}`)
      })
    },

    getStatus(): RollingRestartStatusPayload {
      if (phase === 'idle') return { state: 'idle', inflight: { inFlight: null } }
      if (phase === 'deferred') {
        return {
          state: 'deferred',
          ...(phaseReason !== undefined ? { reason: phaseReason } : {}),
          inflight: lastSummary ?? { inFlight: null },
          ...(deferDeadlineAt !== undefined ? { deferDeadlineAt } : {}),
        }
      }
      if (phase === 'countdown') {
        return { state: 'countdown', inflight: lastSummary ?? { inFlight: null } }
      }
      return { state: 'rolling', inflight: lastSummary ?? { inFlight: null } }
    },

    cancel(): void {
      clearTimers()
      deferDeadlineAt = undefined
      phase = 'idle'
      phaseReason = undefined
      lastSummary = undefined
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 缺省判定源（即时查询，无历史依赖——D4 采样形态裁决）
// ─────────────────────────────────────────────────────────────────────────────

function defaultHeapPercent(): number {
  const limit = getHeapStatistics().heap_size_limit
  if (!Number.isFinite(limit) || limit <= 0) return 0
  return (process.memoryUsage().heapUsed / limit) * PERCENT_SCALE
}

function defaultMemPressureHigh(): Promise<boolean> {
  return queryMemPressure().then((sample) => isMemPressureHigh(sample))
}
