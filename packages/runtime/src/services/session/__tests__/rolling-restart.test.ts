/**
 * 滚动重启执行链单测（crash-forensics-and-watchdog §3.3 D5，实施单元 u7c）。
 *
 * 覆盖（impl-plan u7c 验收行逐项）：
 * - A1 三形态：①谓词命中推迟（rolling-restart-deferred 事件 + deferred 相位）；
 *   ②双维硬升级（heap ≥ FORCE_PCT / memPressure 越限任一）跳过推迟立即执行
 *   （rolling-restart-forced reason=hard-threshold）；③30min 上限到点强制执行
 *   （reason=defer-limit，经 deferLimitMs 注入短上限验证，不靠硬阈值）。
 * - A2 Path A 保活：settled 无在途（镜像全 idle + zcode 快照 0 + relay 空）→ 不推迟
 *   （无 deferred 事件）直接进 countdown → 执行（!hasIdleTimer 谓词语义——保活进程
 *   在镜像计数中恒 0）。
 * - A3 deferred 台账字段语义（u7b 配方）：计数在场 = 数字；errs 形态（已注入从未上报）
 *   = inflight=null + reason=absent-report。
 * - A4 planned 边不进计数状态机（main 侧测试，见 restart-policy-planned.test.ts）。
 * - A5 shutdown 步骤打点序列：SHUTDOWN_STEP_SEQUENCE SSOT 断言（首步取消推迟定时器；
 *   engine-pool-dispose 位于 server-stop 与 close-logger 之间；close-crash-journal
 *   位于 close-logger 之前——D1 台账尾部 flush 先于 logger 关闭）。
 * - B2 Gate W：armed=false 时编排零动作。
 * - 推迟循环：在途清零 → countdown（T-30s 广播）→ 执行（journal event=rolling-restart）。
 * - resolveRollingRestartConfig env 解析（合法/非法/上界）。
 *
 * 全程 fake timers（30s 重判/预告窗口真实等待不可接受）；mirror/journal/broadcast/判定源
 * 全量注入，零 fs 写删、零真实 process 内存依赖。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/rolling-restart.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import {
  startRollingRestart,
  resolveRollingRestartConfig,
  SHUTDOWN_STEP_SEQUENCE,
  ENV_ROLLING_RESTART_DEFER_LIMIT_MS,
  ENV_WATCHDOG_FORCE_PCT,
  DEFAULT_ROLLING_RESTART_DEFER_LIMIT_MS,
  DEFAULT_ROLLING_RESTART_FORCE_PERCENT,
  type RollingRestartBroadcastPayload,
  type RollingRestartBroadcastType,
} from '../rolling-restart.js'
import { createInFlightMirror } from '../inflight-mirror.js'
import type { InFlightMirror } from '../inflight-mirror.js'
import type { CrashJournalEvent, WatchdogMemoryPressurePayload } from '@xyz-agent/shared'
import type { SubagentInFlightReport } from '@xyz-agent/extension-protocol'

const SID = 'sess-rolling-1'

function report(inFlight: number, sessionId = SID): SubagentInFlightReport {
  return { inFlight, sessionId, emittedAt: 1_700_000_000_000 }
}

/** 构造 watchdog critical 档广播 payload（rolling-restart 只消费 level 字段）。 */
function criticalPayload(level: 'warn' | 'critical' = 'critical'): WatchdogMemoryPressurePayload {
  return {
    level,
    heapUsed: 900_000_000,
    heapSizeLimit: 1_000_000_000,
    usedPercent: 90,
    warnPercent: 70,
    criticalPercent: 85,
  }
}

interface Harness {
  handle: ReturnType<typeof startRollingRestart>
  mirror: InFlightMirror
  journalAppend: Mock
  broadcast: Mock
  onExecute: Mock
  setHeapPercent(pct: number): void
  setRelayInFlight(n: number): void
}

function startHarness(opts: {
  armed?: boolean
  heapPercent?: number
  memPressureHigh?: () => Promise<boolean> | boolean
  deferLimitMs?: number
  deferRetryMs?: number
  countdownMs?: number
  forcePercent?: number
  sessionIds?: string[]
} = {}): Harness {
  const mirror = createInFlightMirror()
  const journalAppend = vi.fn()
  const broadcast = vi.fn<(type: RollingRestartBroadcastType, payload: RollingRestartBroadcastPayload) => void>()
  const onExecute = vi.fn()
  let heapPct = opts.heapPercent ?? 50
  let relayCount = 0
  const handle = startRollingRestart({
    armed: opts.armed ?? true,
    mirror,
    listSessionIds: () => opts.sessionIds ?? [SID],
    relayInFlight: () => relayCount,
    heapPercent: () => heapPct,
    memPressureHigh: opts.memPressureHigh ?? (async () => false),
    onExecute,
    broadcast: (type, payload) => broadcast(type, payload),
    journal: { append: journalAppend },
    deferLimitMs: opts.deferLimitMs ?? DEFAULT_ROLLING_RESTART_DEFER_LIMIT_MS,
    deferRetryMs: opts.deferRetryMs ?? 1_000,
    countdownMs: opts.countdownMs ?? 30_000,
    forcePercent: opts.forcePercent ?? DEFAULT_ROLLING_RESTART_FORCE_PERCENT,
  })
  return {
    handle,
    mirror,
    journalAppend,
    broadcast,
    onExecute,
    setHeapPercent: (pct: number) => { heapPct = pct },
    setRelayInFlight: (n: number) => { relayCount = n },
  }
}

/** 决策链含异步 memPressure 查询（microtask）——flush 后断言稳定态。 */
async function flushDecisions(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

function eventsOf(journalAppend: Mock, event: CrashJournalEvent['event']): CrashJournalEvent[] {
  return journalAppend.mock.calls.map((c) => c[0] as CrashJournalEvent).filter((e) => e.event === event)
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('A1① 谓词命中推迟（D5 ①②）', () => {
  it('镜像在途 >0 → deferred 相位 + rolling-restart-deferred 事件（计数在场=数字）+ deferred 广播，不执行', async () => {
    const h = startHarness()
    h.mirror.setInjected(SID, true)
    h.mirror.applyReport(SID, report(2))

    h.handle.onMemoryPressure(criticalPayload())
    await flushDecisions()

    expect(h.onExecute).not.toHaveBeenCalled()
    const deferredEvents = eventsOf(h.journalAppend, 'rolling-restart-deferred')
    expect(deferredEvents).toHaveLength(1)
    expect(deferredEvents[0].layer).toBe('runtime')
    expect(deferredEvents[0].reason).toBe('inflight')
    expect(deferredEvents[0].inflight).toBe(2) // A3：计数在场 = 数字
    expect(h.broadcast).toHaveBeenCalledWith('rollingRestart:deferred', expect.objectContaining({
      reason: 'inflight',
      inflight: { inFlight: 2 },
    }))
    const status = h.handle.getStatus()
    expect(status.state).toBe('deferred')
    expect(status.reason).toBe('inflight')
    expect(status.deferDeadlineAt).toBeDefined()
  })

  it('deferred 期间第二次 critical 不重复记事件（相位守卫）', async () => {
    const h = startHarness()
    h.mirror.applyReport(SID, report(1))
    h.handle.onMemoryPressure(criticalPayload())
    await flushDecisions()
    h.handle.onMemoryPressure(criticalPayload())
    await flushDecisions()
    expect(eventsOf(h.journalAppend, 'rolling-restart-deferred')).toHaveLength(1)
  })
})

describe('A1② 双维硬升级跳过推迟（D5 ②）', () => {
  it('heap ≥ FORCE_PCT（92%）→ 立即执行 rolling-restart-forced reason=hard-threshold，无 deferred', async () => {
    const h = startHarness({ heapPercent: 92 })
    h.mirror.applyReport(SID, report(3)) // 有在途——硬升级仍跳过推迟

    h.handle.onMemoryPressure(criticalPayload())
    await flushDecisions()

    expect(h.onExecute).toHaveBeenCalledTimes(1)
    const forced = eventsOf(h.journalAppend, 'rolling-restart-forced')
    expect(forced).toHaveLength(1)
    expect(forced[0].reason).toBe('hard-threshold')
    expect(eventsOf(h.journalAppend, 'rolling-restart-deferred')).toHaveLength(0)
    expect(h.broadcast).toHaveBeenCalledWith('rollingRestart:forced', { reason: 'hard-threshold', inflight: { inFlight: 3 } })
    expect(h.handle.getStatus().state).toBe('rolling')
  })

  it('heap 未达硬阈值但 memPressure 越限 → 同样跳过推迟立即执行', async () => {
    const h = startHarness({ heapPercent: 80, memPressureHigh: async () => true })
    h.mirror.applyReport(SID, report(1))

    h.handle.onMemoryPressure(criticalPayload())
    await flushDecisions()

    expect(h.onExecute).toHaveBeenCalledTimes(1)
    expect(eventsOf(h.journalAppend, 'rolling-restart-forced')[0]?.reason).toBe('hard-threshold')
    expect(eventsOf(h.journalAppend, 'rolling-restart-deferred')).toHaveLength(0)
  })

  it('heap 恰在硬阈值之下（91.9%）且系统无高压 → 走推迟而非硬升级', async () => {
    const h = startHarness({ heapPercent: 91.9 })
    h.mirror.applyReport(SID, report(1))

    h.handle.onMemoryPressure(criticalPayload())
    await flushDecisions()

    expect(h.onExecute).not.toHaveBeenCalled()
    expect(eventsOf(h.journalAppend, 'rolling-restart-deferred')).toHaveLength(1)
  })
})

describe('A1③ 推迟上限到点强制执行 reason=defer-limit（D5 ②）', () => {
  it('在途恒不清零 → 到点 forced defer-limit（不靠硬阈值），executed 后不再重判', async () => {
    const h = startHarness({ deferLimitMs: 5_000, deferRetryMs: 1_000 })
    h.mirror.applyReport(SID, report(1))

    h.handle.onMemoryPressure(criticalPayload())
    await flushDecisions()
    expect(h.handle.getStatus().state).toBe('deferred')

    // 上限 5s 内（4s）：仍在推迟
    await vi.advanceTimersByTimeAsync(4_000)
    expect(h.onExecute).not.toHaveBeenCalled()

    // 跨过 5s 上限的下一拍：forced defer-limit
    await vi.advanceTimersByTimeAsync(2_000)
    expect(h.onExecute).toHaveBeenCalledTimes(1)
    const forced = eventsOf(h.journalAppend, 'rolling-restart-forced')
    expect(forced).toHaveLength(1)
    expect(forced[0].reason).toBe('defer-limit')
    // 执行后 rolling 相位，不再产生新事件
    await vi.advanceTimersByTimeAsync(60_000)
    expect(eventsOf(h.journalAppend, 'rolling-restart-forced')).toHaveLength(1)
  })

  it('errs 推迟（absent-report）无完成信号 → 必然走到上限 defer-limit，事件计数保持 null', async () => {
    const h = startHarness({ deferLimitMs: 3_000, deferRetryMs: 1_000 })
    h.mirror.setInjected(SID, true) // 已注入、从未上报 → errs 形态

    h.handle.onMemoryPressure(criticalPayload())
    await flushDecisions()

    const deferred = eventsOf(h.journalAppend, 'rolling-restart-deferred')
    expect(deferred[0].reason).toBe('absent-report')
    expect(deferred[0].inflight).toBeNull() // A3：errs 形态计数 = null（非 0）

    await vi.advanceTimersByTimeAsync(4_000)
    const forced = eventsOf(h.journalAppend, 'rolling-restart-forced')
    expect(forced[0].reason).toBe('defer-limit')
    expect(forced[0].inflight).toBeNull()
    expect(h.onExecute).toHaveBeenCalledTimes(1)
  })
})

describe('A2 Path A 保活不推迟（settled 无在途）', () => {
  it('镜像全 idle（settled 后计数 0）+ relay 空 → 无 deferred 直接 countdown → 执行', async () => {
    const h = startHarness()
    // Path A 保活形态：曾上报（hasEverReported=true）且当前计数 0——活句柄但 idle timer
    // armed 的进程在镜像口径中不计（getInFlightSnapshot 双谓词），故恒 0。
    h.mirror.setInjected(SID, true)
    h.mirror.applyReport(SID, report(0))

    h.handle.onMemoryPressure(criticalPayload())
    await flushDecisions()

    expect(eventsOf(h.journalAppend, 'rolling-restart-deferred')).toHaveLength(0)
    expect(h.broadcast).toHaveBeenCalledWith('rollingRestart:countdown', expect.objectContaining({
      inflight: { inFlight: 0 },
      executesAt: expect.any(Number),
    }))
    expect(h.handle.getStatus().state).toBe('countdown')
    expect(h.onExecute).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.onExecute).toHaveBeenCalledTimes(1)
    // 非 forced 执行：journal event=rolling-restart（无 forced 事件）
    expect(eventsOf(h.journalAppend, 'rolling-restart')).toHaveLength(1)
    expect(eventsOf(h.journalAppend, 'rolling-restart-forced')).toHaveLength(0)
  })

  it('无任何镜像条目（未注入/未上报）→ 无在途 → 不推迟直接 countdown', async () => {
    const h = startHarness()
    h.handle.onMemoryPressure(criticalPayload())
    await flushDecisions()
    expect(eventsOf(h.journalAppend, 'rolling-restart-deferred')).toHaveLength(0)
    expect(h.handle.getStatus().state).toBe('countdown')
  })
})

describe('推迟循环收口：在途清零 → countdown → 执行', () => {
  it('deferred 期间任务完成（计数归 0）→ countdown 广播 → T-30s 后执行', async () => {
    const h = startHarness({ deferRetryMs: 1_000, countdownMs: 30_000 })
    h.mirror.applyReport(SID, report(2))

    h.handle.onMemoryPressure(criticalPayload())
    await flushDecisions()
    expect(h.handle.getStatus().state).toBe('deferred')

    // 任务完成：绝对计数新帧覆盖为 0（下一拍重判命中）
    await vi.advanceTimersByTimeAsync(500)
    h.mirror.applyReport(SID, report(0))
    await vi.advanceTimersByTimeAsync(1_000)

    expect(h.broadcast).toHaveBeenCalledWith('rollingRestart:countdown', expect.anything())
    expect(h.handle.getStatus().state).toBe('countdown')
    expect(h.onExecute).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.onExecute).toHaveBeenCalledTimes(1)
    expect(h.handle.getStatus().state).toBe('rolling')
  })

  it('countdown 相位二次 critical 且 heap 升至 FORCE_PCT → 硬升级 forced=hard-threshold（非 planned 记账）', async () => {
    const h = startHarness({ countdownMs: 30_000 })
    // Path A：无在途 → 首拍 critical 直接进 countdown（planned 排队，无台账事件）
    h.handle.onMemoryPressure(criticalPayload())
    await flushDecisions()
    expect(h.handle.getStatus().state).toBe('countdown')
    expect(h.journalAppend).not.toHaveBeenCalled()

    // countdown 窗口内 heap 升至硬阈值 + 在途回升（与 countdown 进入时快照分异，验证 lastSummary 回退）
    h.setHeapPercent(99)
    h.setRelayInFlight(3)
    h.handle.onMemoryPressure(criticalPayload())
    await flushDecisions()

    const forced = eventsOf(h.journalAppend, 'rolling-restart-forced')
    expect(forced).toHaveLength(1)
    expect(forced[0]?.reason).toBe('hard-threshold')
    // 非 planned 记账（否则 D5 归因语义漂移：forced vs planned）
    expect(eventsOf(h.journalAppend, 'rolling-restart')).toHaveLength(0)
    expect(h.onExecute).toHaveBeenCalledTimes(1)
    expect(h.handle.getStatus().state).toBe('rolling')
    // lastSummary 回退：journal 的 inflight 用 countdown 进入时快照（0）而非复查时新评估（3）
    expect(forced[0]?.inflight).toEqual(0)
  })
})

describe('A3 errs 形态 status 相位（absent-report）', () => {
  it('status 在 deferred+errs 形态返回 reason=absent-report 与 inflight=null', async () => {
    const h = startHarness()
    h.mirror.setInjected(SID, true)
    h.handle.onMemoryPressure(criticalPayload())
    await flushDecisions()

    const status = h.handle.getStatus()
    expect(status.state).toBe('deferred')
    expect(status.reason).toBe('absent-report')
    expect(status.inflight).toEqual({ inFlight: null })
  })

  it('idle 相位 status = state idle + inflight null（无 reason）', () => {
    const h = startHarness()
    expect(h.handle.getStatus()).toEqual({ state: 'idle', inflight: { inFlight: null } })
  })
})

describe('relay / 引擎侧在途源', () => {
  it('relayInFlight 未注入 = 0 = 该维不贡献（组合根接线缺席语义，不读 registry）', async () => {
    // 不走 harness（harness 恒显式注入 relayInFlight）——直接构造裸缺省形态
    const journalAppend = vi.fn()
    const handle = startRollingRestart({
      armed: true,
      mirror: createInFlightMirror(),
      listSessionIds: () => [SID],
      heapPercent: () => 50,
      memPressureHigh: async () => false,
      journal: { append: journalAppend },
      countdownMs: 30_000,
    })
    handle.onMemoryPressure(criticalPayload())
    await flushDecisions()

    // relay 维贡献 0 → 判定无在途 → 不推迟直接 countdown
    expect(eventsOf(journalAppend, 'rolling-restart-deferred')).toHaveLength(0)
    expect(handle.getStatus().state).toBe('countdown')
  })

  it('relay 在途子进程 >0 → 推迟（计数并入合计）', async () => {
    const h = startHarness()
    h.setRelayInFlight(2)
    h.handle.onMemoryPressure(criticalPayload())
    await flushDecisions()

    const deferred = eventsOf(h.journalAppend, 'rolling-restart-deferred')
    expect(deferred).toHaveLength(1)
    expect(deferred[0].inflight).toBe(2)
  })
})

describe('cancel 与一次执行语义（D5 退出链首步）', () => {
  it('cancel 复位 deferred 相位：定时器清零、状态回 idle、此后不执行', async () => {
    const h = startHarness({ deferRetryMs: 1_000 })
    h.mirror.applyReport(SID, report(1))
    h.handle.onMemoryPressure(criticalPayload())
    await flushDecisions()
    expect(h.handle.getStatus().state).toBe('deferred')

    h.handle.cancel()
    expect(h.handle.getStatus().state).toBe('idle')

    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.onExecute).not.toHaveBeenCalled()
  })

  it('执行后（rolling 相位）再入 critical 不二次执行', async () => {
    const h = startHarness({ heapPercent: 95 })
    h.handle.onMemoryPressure(criticalPayload())
    await flushDecisions()
    expect(h.onExecute).toHaveBeenCalledTimes(1)

    h.handle.onMemoryPressure(criticalPayload())
    await flushDecisions()
    expect(h.onExecute).toHaveBeenCalledTimes(1)
  })
})

describe('B2 Gate W：armed=false 编排零动作', () => {
  it('critical 到达但不武装 → 无判定无事件无广播无执行', async () => {
    const h = startHarness({ armed: false })
    h.mirror.applyReport(SID, report(5))

    h.handle.onMemoryPressure(criticalPayload())
    await flushDecisions()
    await vi.advanceTimersByTimeAsync(120_000)

    expect(h.journalAppend).not.toHaveBeenCalled()
    expect(h.broadcast).not.toHaveBeenCalled()
    expect(h.onExecute).not.toHaveBeenCalled()
    expect(h.handle.getStatus().state).toBe('idle')
  })

  it('armed=true 但 warn 档（relief 档）不进重启决策', async () => {
    const h = startHarness()
    h.mirror.applyReport(SID, report(5))
    h.handle.onMemoryPressure(criticalPayload('warn'))
    await flushDecisions()
    await vi.advanceTimersByTimeAsync(120_000)

    expect(h.journalAppend).not.toHaveBeenCalled()
    expect(h.onExecute).not.toHaveBeenCalled()
    expect(h.handle.getStatus().state).toBe('idle')
  })
})

describe('A5 shutdown 步骤打点序列 SSOT（SHUTDOWN_STEP_SEQUENCE）', () => {
  it('首步 = 取消推迟定时器（D5 退出链首步）', () => {
    expect(SHUTDOWN_STEP_SEQUENCE[0]).toBe('cancel-rolling-restart')
  })

  it('engine-pool-dispose 位于 server-stop 之后、close-logger 之前（D5 挂点钉死）', () => {
    const seq = SHUTDOWN_STEP_SEQUENCE as readonly string[]
    const engineIdx = seq.indexOf('engine-pool-dispose')
    const serverStopIdx = seq.indexOf('server-stop')
    const closeLoggerIdx = seq.indexOf('close-logger')
    expect(engineIdx).toBeGreaterThan(serverStopIdx)
    expect(closeLoggerIdx).toBeGreaterThan(engineIdx)
  })

  it('close-crash-journal 位于 close-logger 之前（D1 台账尾部 flush 先于 logger 关闭）', () => {
    const seq = SHUTDOWN_STEP_SEQUENCE as readonly string[]
    const journalIdx = seq.indexOf('close-crash-journal')
    const closeLoggerIdx = seq.indexOf('close-logger')
    expect(journalIdx).toBeGreaterThan(-1)
    expect(closeLoggerIdx).toBeGreaterThan(journalIdx)
  })

  it('完整序列含既有 shutdown 链全部步骤（逐行继承的机械对照面）', () => {
    expect([...SHUTDOWN_STEP_SEQUENCE]).toEqual([
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
    ])
  })
})

describe('resolveRollingRestartConfig（env 旋钮解析）', () => {
  it('缺省 = 30min 上限 + 92% 硬阈值', () => {
    const cfg = resolveRollingRestartConfig({})
    expect(cfg.deferLimitMs).toBe(DEFAULT_ROLLING_RESTART_DEFER_LIMIT_MS)
    expect(cfg.forcePercent).toBe(DEFAULT_ROLLING_RESTART_FORCE_PERCENT)
  })

  it('合法覆盖：A4 注入短上限（defer-limit 端到端验证通道）', () => {
    const cfg = resolveRollingRestartConfig({
      [ENV_ROLLING_RESTART_DEFER_LIMIT_MS]: '30000',
      [ENV_WATCHDOG_FORCE_PCT]: '95',
    })
    expect(cfg.deferLimitMs).toBe(30_000)
    expect(cfg.forcePercent).toBe(95)
  })

  it('非法值（非数字 / ≤0 / ≥100）warn 回落默认，不 throw', () => {
    const cfg = resolveRollingRestartConfig({
      [ENV_ROLLING_RESTART_DEFER_LIMIT_MS]: 'abc',
      [ENV_WATCHDOG_FORCE_PCT]: '100',
    })
    expect(cfg.deferLimitMs).toBe(DEFAULT_ROLLING_RESTART_DEFER_LIMIT_MS)
    expect(cfg.forcePercent).toBe(DEFAULT_ROLLING_RESTART_FORCE_PERCENT)
  })
})
