/**
 * 空闲 pi 回收 reaper 判定矩阵（idle-pi-reclamation D2/D4/D7，实施计划 u2）。
 *
 * 覆盖（全部 fake deps + fake timers，零真实子进程/真实数据目录）：
 * 1. 阈值边界：比较语义 = idleMs 严格大于阈值才回收——恰好等于阈值不回收（边界值一律往
 *    「不回收」方向偏，防时钟毛刺触发边界回收），超一毫秒即回收。
 * 2. 七类豁免各一例（D2 表序）：命中即跳过 + 每拍汇总分布计数精确。
 * 3. 占座中的 session 跳过（reaper 自身 seat，D2 #7 后半）。
 * 4. 多回收合并单次 broadcast（D3 第 7 步），且广播发生在全部回收完成之后。
 * 5. 配置纯 options（不读 process.env）：默认 5min tick / 传入值生效 / stop 后不再触发。
 * 6. ReclaimSeat 原语语义（tryAcquire 互斥 / release 唤醒全部等待方 / waitRelease 超时
 *    resolve false 供观测、绝不自行抢跑）。
 *
 * 运行命令: cd packages/runtime && npx vitest run src/__tests__/services/idle-pi-reaper.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  ReclaimSeat,
  startIdlePiReaper,
  hasFreshPendingUiRequest,
  DEFAULT_REAP_TICK_MS,
  DEFAULT_IDLE_THRESHOLD_MS,
  DEFAULT_VIEWED_WINDOW_MS,
  DEFAULT_FORM_MAX_AGE_MS,
  type IdlePiReaperOptions,
  type IdlePiReaperHandle,
  type ReclaimSkipDistribution,
} from '../../services/session/idle-pi-reaper.js'
// 生产权威默认值（shared/constants SSOT）：仅末尾「默认值双源等值守卫」describe 使用
import {
  DEFAULT_PI_RECLAIM_TICK_MS,
  DEFAULT_PI_RECLAIM_IDLE_MS,
  DEFAULT_PI_RECLAIM_VIEWED_WINDOW_MS,
  DEFAULT_PI_RECLAIM_FORM_MAX_AGE_MS,
} from '@taiji/shared'

// ── fake 装置 ─────────────────────────────────────────────────

interface FakeSessionState {
  /** lastActivityAt（u1a）；undefined = 无信号（client 不存在/未上报）。 */
  activityAt?: number
  viewedAt?: number
  occupied?: boolean
  bgTasks?: boolean
  relay?: boolean
  handoff?: boolean
  queued?: boolean
  restoring?: boolean
  /** 挂起 UI 请求（v6 第四案）；receivedAt 用于计龄上界判定。 */
  pendingUi?: Array<{ receivedAt: number }>
}

interface Harness {
  seat: ReclaimSeat
  states: Map<string, FakeSessionState>
  nowMs: number
  reclaimCalls: string[]
  reclaimOutcome: Map<string, boolean | Error>
  /** 每次 broadcast 触发时已完成的 reclaim 数（断言「广播在全部回收之后」）。 */
  broadcastAtReclaimCount: number[]
  logs: Array<{ args: unknown[] }>
  options: IdlePiReaperOptions
}

/**
 * 构造 fake 装置。注意返回同一引用（非 spread 拷贝）：options 各闭包捕获 h 本体，
 * 测试用例对 harness.nowMs / harness.states 的运行中修改必须对 reaper 可见。
 */
function makeHarness(seedStates: Record<string, FakeSessionState> = {}): Harness {
  const h = {} as Harness
  h.seat = new ReclaimSeat()
  h.states = new Map(Object.entries(seedStates))
  h.nowMs = 1_000_000
  h.reclaimCalls = []
  h.reclaimOutcome = new Map()
  h.broadcastAtReclaimCount = []
  h.logs = []
  h.options = {
    seat: h.seat,
    exemptions: {
      isOccupied: (sid) => h.states.get(sid)?.occupied ?? false,
      hasRunningBackgroundTasks: (sid) => h.states.get(sid)?.bgTasks ?? false,
      hasInflightRelayChildren: (sid) => h.states.get(sid)?.relay ?? false,
      hasHandoffInflight: (sid) => h.states.get(sid)?.handoff ?? false,
      hasQueuedDeliveries: (sid) => h.states.get(sid)?.queued ?? false,
      getLastViewedAt: (sid) => h.states.get(sid)?.viewedAt,
      isRestoring: (sid) => h.states.get(sid)?.restoring ?? false,
      // 生产语义直引（与组合根同一纯函数）：max(receivedAt) 聚合 + 超龄视同无 pending
      hasPendingUiRequest: (sid, maxAgeMs) =>
        hasFreshPendingUiRequest(h.states.get(sid)?.pendingUi ?? [], h.nowMs, maxAgeMs),
    },
    getClientActivity: (sid) => h.states.get(sid)?.activityAt,
    listCandidateSessionIds: () => Array.from(h.states.keys()),
    reclaim: async (sid) => {
      h.reclaimCalls.push(sid)
      const outcome = h.reclaimOutcome.get(sid)
      if (outcome instanceof Error) throw outcome
      return outcome ?? true
    },
    broadcast: () => {
      h.broadcastAtReclaimCount.push(h.reclaimCalls.length)
    },
    now: () => h.nowMs,
  }
  return h
}

/** 超阈空闲（threshold 默认 2h；activityAt = now - 2h - 1ms → idleMs 超阈 1ms）。 */
function idleBeyondThreshold(state: FakeSessionState, nowMs: number): FakeSessionState {
  return { activityAt: nowMs - DEFAULT_IDLE_THRESHOLD_MS - 1, ...state }
}

/** 取最后一拍汇总日志的 skipped 分布（D7 汇总 meta 的 skipped 字段）。 */
function lastSummary(h: Harness): { reclaimed: string[]; skipped: ReclaimSkipDistribution } {
  for (let i = h.logs.length - 1; i >= 0; i--) {
    const meta = h.logs[i].args[1] as { action?: string; reclaimed?: string[]; skipped?: ReclaimSkipDistribution } | undefined
    if (meta?.action === 'idle_pi_reaper_tick') {
      return { reclaimed: meta.reclaimed ?? [], skipped: meta.skipped as ReclaimSkipDistribution }
    }
  }
  throw new Error('no tick summary log captured')
}

describe('空闲回收 reaper 判定矩阵（idle-pi-reclamation D2/D4/D7）', () => {
  let harness: ReturnType<typeof makeHarness>
  let handle: IdlePiReaperHandle

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      harness?.logs.push({ args })
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    handle?.stop()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('阈值边界：空闲时长恰好等于阈值不回收，超一毫秒即回收（idleMs > threshold 才回收）', async () => {
    harness = makeHarness({ 's-boundary': { activityAt: 0 } })
    harness.options.idleThresholdMs = 1_000
    handle = startIdlePiReaper(harness.options)
    // now = 1000 → idleMs = 1000 === threshold → 不回收（比较语义：<= 阈值一律跳过）
    harness.nowMs = 1_000
    await handle.runOnce()
    expect(harness.reclaimCalls).toEqual([])
    expect(lastSummary(harness).skipped.belowThreshold).toBe(1)
    // now = 1001 → idleMs = 1001 > threshold → 回收
    harness.nowMs = 1_001
    await handle.runOnce()
    expect(harness.reclaimCalls).toEqual(['s-boundary'])
    expect(lastSummary(harness).reclaimed).toEqual(['s-boundary'])
  })

  it('豁免 #1 occupancy 三维非 idle：命中即跳过且分布计数为 1', async () => {
    harness = makeHarness({ 's-occ': idleBeyondThreshold({ occupied: true }, 1_000_000) })
    handle = startIdlePiReaper(harness.options)
    await handle.runOnce()
    expect(harness.reclaimCalls).toEqual([])
    expect(lastSummary(harness).skipped.occupied).toBe(1)
  })

  it('豁免 #2 running 后台任务：命中即跳过（失败模式 B——回收会让任务被判孤儿杀掉）', async () => {
    harness = makeHarness({ 's-bg': idleBeyondThreshold({ bgTasks: true }, 1_000_000) })
    handle = startIdlePiReaper(harness.options)
    await handle.runOnce()
    expect(harness.reclaimCalls).toEqual([])
    expect(lastSummary(harness).skipped.backgroundTasks).toBe(1)
  })

  it('豁免 #3 在途 relay 子进程：命中即跳过（失败模式 C——subagent 在途）', async () => {
    harness = makeHarness({ 's-relay': idleBeyondThreshold({ relay: true }, 1_000_000) })
    handle = startIdlePiReaper(harness.options)
    await handle.runOnce()
    expect(harness.reclaimCalls).toEqual([])
    expect(lastSummary(harness).skipped.relayChildren).toBe(1)
  })

  it('豁免 #4 handoff 进行中：命中即跳过', async () => {
    harness = makeHarness({ 's-handoff': idleBeyondThreshold({ handoff: true }, 1_000_000) })
    handle = startIdlePiReaper(harness.options)
    await handle.runOnce()
    expect(harness.reclaimCalls).toEqual([])
    expect(lastSummary(harness).skipped.handoff).toBe(1)
  })

  it('豁免 #5 delivery 排队投递：命中即跳过', async () => {
    harness = makeHarness({ 's-queue': idleBeyondThreshold({ queued: true }, 1_000_000) })
    handle = startIdlePiReaper(harness.options)
    await handle.runOnce()
    expect(harness.reclaimCalls).toEqual([])
    expect(lastSummary(harness).skipped.queuedDeliveries).toBe(1)
  })

  it('豁免 #6 查看窗口：窗口内被查看即跳过，恰好等于窗口边界仍豁免（≤ 语义），超一毫秒回收', async () => {
    // viewedAt 距 now 恰好 = 30min（窗口边界）→ 豁免（D2 #6 字面「≤ 30 分钟」）
    harness = makeHarness({ 's-viewed': idleBeyondThreshold({ viewedAt: 1_000_000 - DEFAULT_VIEWED_WINDOW_MS }, 1_000_000) })
    handle = startIdlePiReaper(harness.options)
    await handle.runOnce()
    expect(harness.reclaimCalls).toEqual([])
    expect(lastSummary(harness).skipped.recentlyViewed).toBe(1)
    // 查看时刻调老 1ms（elapsed = 窗口 + 1ms）→ 不再豁免 → 回收（activityAt 仍超空闲阈）
    harness.states.get('s-viewed')!.viewedAt = 1_000_000 - DEFAULT_VIEWED_WINDOW_MS - 1
    await handle.runOnce()
    expect(harness.reclaimCalls).toEqual(['s-viewed'])
  })

  it('豁免 #6 对照：从未被查看（viewedAt undefined）= 长期空闲，不豁免', async () => {
    harness = makeHarness({ 's-never-viewed': idleBeyondThreshold({}, 1_000_000) })
    handle = startIdlePiReaper(harness.options)
    await handle.runOnce()
    expect(harness.reclaimCalls).toEqual(['s-never-viewed'])
    expect(lastSummary(harness).skipped.recentlyViewed).toBe(0)
  })

  it('豁免 #7 restore 进行中：命中即跳过（回收自身占座由 seat 单独覆盖）', async () => {
    harness = makeHarness({ 's-restoring': idleBeyondThreshold({ restoring: true }, 1_000_000) })
    handle = startIdlePiReaper(harness.options)
    await handle.runOnce()
    expect(harness.reclaimCalls).toEqual([])
    expect(lastSummary(harness).skipped.restoring).toBe(1)
  })

  it('豁免 #8 存在未超龄挂起 UI 请求：命中即跳过且分布 pendingUiRequest 计入（V13(d) 豁免生效）', async () => {
    // receivedAt 距 now = 上界 - 1ms（未超龄）
    harness = makeHarness({
      's-form': idleBeyondThreshold({ pendingUi: [{ receivedAt: 1_000_000 - DEFAULT_FORM_MAX_AGE_MS + 1 }] }, 1_000_000),
    })
    handle = startIdlePiReaper(harness.options)
    await handle.runOnce()
    expect(harness.reclaimCalls).toEqual([])
    const skipped = lastSummary(harness).skipped
    expect(skipped.pendingUiRequest).toBe(1)
    // 未命中其余豁免的计数仍为 0（分布可归因）
    expect(skipped.occupied).toBe(0)
  })

  it('豁免 #8 边界：elapsed 恰等于上界不豁免（严格 < 语义），上界内一毫秒则豁免', async () => {
    // 恰好等于上界 → 不豁免（r5 I-1 判定式用 `<`）
    harness = makeHarness({
      's-form': idleBeyondThreshold({ pendingUi: [{ receivedAt: 1_000_000 - DEFAULT_FORM_MAX_AGE_MS }] }, 1_000_000),
    })
    handle = startIdlePiReaper(harness.options)
    await handle.runOnce()
    expect(harness.reclaimCalls).toEqual(['s-form'])
    expect(lastSummary(harness).skipped.pendingUiRequest).toBe(0)
    handle.stop()

    // 上界内一毫秒 → 豁免
    const h2 = makeHarness({
      's-form': idleBeyondThreshold({ pendingUi: [{ receivedAt: 1_000_000 - DEFAULT_FORM_MAX_AGE_MS + 1 }] }, 1_000_000),
    })
    const handle2 = startIdlePiReaper(h2.options)
    try {
      await handle2.runOnce()
      expect(h2.reclaimCalls).toEqual([])
    } finally {
      handle2.stop()
    }
  })

  it('豁免 #8 计龄取 max(receivedAt)：老僵尸（超龄）+ 新活请求（新鲜）→ 仍豁免（r5 I-1 must-fix）', async () => {
    harness = makeHarness({
      's-form': idleBeyondThreshold({
        pendingUi: [
          { receivedAt: 1_000_000 - DEFAULT_FORM_MAX_AGE_MS - 60_000 }, // 老僵尸（超龄）
          { receivedAt: 1_000_000 - 1_000 }, // 新活请求（新鲜）
        ],
      }, 1_000_000),
    })
    handle = startIdlePiReaper(harness.options)
    await handle.runOnce()
    // 若用 min/任一 → 被老僵尸连带判超龄 → 进程被回收时连活请求一起清（静默失败）
    expect(harness.reclaimCalls).toEqual([])
    expect(lastSummary(harness).skipped.pendingUiRequest).toBe(1)
  })

  it('豁免 #8 上界不排空 pending 存储（边界语义：超龄 ≠ 丢弃，仍可被重订阅捞回）', async () => {
    const pending = [{ receivedAt: 1_000_000 - DEFAULT_FORM_MAX_AGE_MS - 1 }]
    harness = makeHarness({ 's-form': idleBeyondThreshold({ pendingUi: pending }, 1_000_000) })
    handle = startIdlePiReaper(harness.options)
    await handle.runOnce()
    // 超龄 → 进程被回收，但 reaper 不触碰 pending 存储（读数闭包仍原样返回）
    expect(harness.reclaimCalls).toEqual(['s-form'])
    expect(harness.states.get('s-form')!.pendingUi).toEqual(pending)
  })

  it('豁免 #8 不误伤：无挂起 UI 请求的 session 照常回收（反向用例）', async () => {
    harness = makeHarness({ 's-plain': idleBeyondThreshold({}, 1_000_000) })
    handle = startIdlePiReaper(harness.options)
    await handle.runOnce()
    expect(harness.reclaimCalls).toEqual(['s-plain'])
    expect(lastSummary(harness).skipped.pendingUiRequest).toBe(0)
  })

  it('豁免 #8 未命中时分布字段为 0（语义明确：0 = 本拍无未超龄 pending）', async () => {
    harness = makeHarness({ 's-none': idleBeyondThreshold({ pendingUi: [] }, 1_000_000) })
    handle = startIdlePiReaper(harness.options)
    await handle.runOnce()
    expect(harness.reclaimCalls).toEqual(['s-none'])
    expect(lastSummary(harness).skipped.pendingUiRequest).toBe(0)
  })

  it('豁免 #8 上界可经 options.pendingUiRequestMaxAgeMs 收窄（真机缩短阈值形态）', async () => {
    harness = makeHarness({
      's-form': idleBeyondThreshold({ pendingUi: [{ receivedAt: 1_000_000 - 5_000 }] }, 1_000_000),
    })
    harness.options.pendingUiRequestMaxAgeMs = 3_000
    handle = startIdlePiReaper(harness.options)
    await handle.runOnce()
    // elapsed=5000 > 收窄后的 3000 → 视同无 pending → 回收
    expect(harness.reclaimCalls).toEqual(['s-form'])
    expect(lastSummary(harness).skipped.pendingUiRequest).toBe(0)
  })

  it('占座中的 session 跳过且不触发任何豁免查询（seat 检查短路在最前）', async () => {
    harness = makeHarness({ 's-seat': idleBeyondThreshold({}, 1_000_000) })
    expect(harness.seat.tryAcquire('s-seat')).toBe(true)
    handle = startIdlePiReaper(harness.options)
    await handle.runOnce()
    expect(harness.reclaimCalls).toEqual([])
    expect(lastSummary(harness).skipped.seatHeld).toBe(1)
  })

  it('无空闲信号（activityAt undefined）不回收：宁漏不误杀', async () => {
    harness = makeHarness({ 's-no-signal': {} })
    handle = startIdlePiReaper(harness.options)
    await handle.runOnce()
    expect(harness.reclaimCalls).toEqual([])
    expect(lastSummary(harness).skipped.noActivity).toBe(1)
  })

  it('多回收合并单次 broadcast，且广播发生在全部回收完成（seat 释放）之后', async () => {
    harness = makeHarness({
      's-1': idleBeyondThreshold({}, 1_000_000),
      's-2': idleBeyondThreshold({}, 1_000_000),
      's-3': idleBeyondThreshold({}, 1_000_000),
      // 豁免 session 不参与回收，也不该触发广播计数
      's-exempt': idleBeyondThreshold({ occupied: true }, 1_000_000),
    })
    handle = startIdlePiReaper(harness.options)
    await handle.runOnce()
    expect(harness.reclaimCalls.sort()).toEqual(['s-1', 's-2', 's-3'])
    expect(harness.broadcastAtReclaimCount).toEqual([3])
    expect(lastSummary(harness).reclaimed.sort()).toEqual(['s-1', 's-2', 's-3'])
  })

  it('无回收不广播；单 session 回收失败（reclaim false / throw）计入 reclaimFailed 且不中断一拍', async () => {
    harness = makeHarness({
      's-ok': idleBeyondThreshold({}, 1_000_000),
      's-refused': idleBeyondThreshold({}, 1_000_000),
      's-throws': idleBeyondThreshold({}, 1_000_000),
    })
    harness.reclaimOutcome.set('s-refused', false)
    harness.reclaimOutcome.set('s-throws', new Error('boom'))
    handle = startIdlePiReaper(harness.options)
    await handle.runOnce()
    // 三个候选都被尝试（失败不中断一拍）
    expect(harness.reclaimCalls.sort()).toEqual(['s-ok', 's-refused', 's-throws'])
    const summary = lastSummary(harness)
    expect(summary.reclaimed).toEqual(['s-ok'])
    expect(summary.skipped.reclaimFailed).toBe(2)
    // 有回收 → 广播一次；广播时刻 = 全部回收尝试完成之后（= reclaimCalls.length）
    expect(harness.broadcastAtReclaimCount).toEqual([3])
  })

  it('无回收的拍（全部跳过）不调 broadcast', async () => {
    harness = makeHarness({ 's-busy': idleBeyondThreshold({ occupied: true }, 1_000_000) })
    handle = startIdlePiReaper(harness.options)
    await handle.runOnce()
    expect(harness.broadcastAtReclaimCount).toEqual([])
  })

  it('配置纯 options：默认 tick 5min（不可配 env）；传入 tickIntervalMs 生效；stop 后不再触发', async () => {
    vi.useFakeTimers()
    harness = makeHarness({ 's-tick': idleBeyondThreshold({}, 1_000_000) })
    // 未传 tickIntervalMs → 默认 DEFAULT_REAP_TICK_MS（权威值由 u3 经 options 传入，本模块不读 env）
    handle = startIdlePiReaper(harness.options)
    await vi.advanceTimersByTimeAsync(DEFAULT_REAP_TICK_MS - 1)
    expect(harness.reclaimCalls).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(harness.reclaimCalls).toEqual(['s-tick'])
    handle.stop()
    await vi.advanceTimersByTimeAsync(DEFAULT_REAP_TICK_MS * 3)
    expect(harness.reclaimCalls).toEqual(['s-tick'])

    // 传入 tickIntervalMs 生效（纯 options 注入）
    const h2 = makeHarness({ 's-fast': idleBeyondThreshold({}, 1_000_000) })
    const handle2 = startIdlePiReaper({ ...h2.options, tickIntervalMs: 1_000 })
    try {
      await vi.advanceTimersByTimeAsync(1_000)
      expect(h2.reclaimCalls).toEqual(['s-fast'])
    } finally {
      handle2.stop()
    }
  })

  it('单拍重入保护：上一拍未完成时 interval 触发的下一拍跳过（runOnce 直呼不受影响）', async () => {
    vi.useFakeTimers()
    harness = makeHarness({ 's-slow': idleBeyondThreshold({}, 1_000_000) })
    let releaseReclaim: (() => void) | undefined
    const gate = new Promise<void>((r) => { releaseReclaim = r })
    const options = {
      ...harness.options,
      tickIntervalMs: 1_000,
      reclaim: async (sid: string) => {
        harness.reclaimCalls.push(sid)
        await gate
        return true
      },
    }
    handle = startIdlePiReaper(options)
    const tickPromise = vi.advanceTimersByTimeAsync(1_000)
    // 第一拍仍在途（reclaim 挂 gate）时推进到下一拍：重入被 inProgress 拦截
    await vi.advanceTimersByTimeAsync(1_000)
    expect(harness.reclaimCalls).toEqual(['s-slow'])
    releaseReclaim?.()
    await tickPromise
    expect(harness.reclaimCalls).toEqual(['s-slow'])
  })
})

describe('ReclaimSeat 占座原语（D6-2）', () => {
  it('tryAcquire 互斥：未持有 true，二次 false；release 后可重新占座', () => {
    const seat = new ReclaimSeat()
    expect(seat.isHeld('s1')).toBe(false)
    expect(seat.tryAcquire('s1')).toBe(true)
    expect(seat.isHeld('s1')).toBe(true)
    expect(seat.tryAcquire('s1')).toBe(false)
    seat.release('s1')
    expect(seat.isHeld('s1')).toBe(false)
    expect(seat.tryAcquire('s1')).toBe(true)
  })

  it('waitRelease 未持有时立即 resolve(true)', async () => {
    const seat = new ReclaimSeat()
    await expect(seat.waitRelease('never-held', 100)).resolves.toBe(true)
  })

  it('release 唤醒全部等待方 resolve(true)；release 幂等', async () => {
    vi.useFakeTimers()
    const seat = new ReclaimSeat()
    seat.tryAcquire('s1')
    const w1 = seat.waitRelease('s1')
    const w2 = seat.waitRelease('s1')
    seat.release('s1')
    await expect(w1).resolves.toBe(true)
    await expect(w2).resolves.toBe(true)
    seat.release('s1') // 幂等 no-op
    // 占座释放后新等待方立即 resolve
    await expect(seat.waitRelease('s1')).resolves.toBe(true)
  })

  it('waitRelease 超时 resolve(false)（纯观测信号——原语层不做任何抢跑动作），释放后等待方仍被唤醒', async () => {
    vi.useFakeTimers()
    const seat = new ReclaimSeat()
    seat.tryAcquire('s1')
    const timedOut = seat.waitRelease('s1', 5_000)
    const stillWaiting = seat.waitRelease('s1')
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(timedOut).resolves.toBe(false)
    // 超时 waiter 已出队，release 只唤醒仍在等的
    seat.release('s1')
    await expect(stillWaiting).resolves.toBe(true)
  })

  it('waitRelease 无超时（缺省）= 无限等待，直到 release', async () => {
    vi.useFakeTimers()
    const seat = new ReclaimSeat()
    seat.tryAcquire('s1')
    const waiting = seat.waitRelease('s1')
    let settled = false
    void waiting.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(settled).toBe(false)
    seat.release('s1')
    await expect(waiting).resolves.toBe(true)
  })

  it('heldSessionIds 返回当前占座集合（诊断面）', () => {
    const seat = new ReclaimSeat()
    seat.tryAcquire('a')
    seat.tryAcquire('b')
    expect(seat.heldSessionIds().sort()).toEqual(['a', 'b'])
    seat.release('a')
    expect(seat.heldSessionIds()).toEqual(['b'])
  })
})

// ── 默认值双源等值守卫 ────────────────────────────────────────

/**
 * 回收三旋钮默认值存在双源：shared/constants 的 DEFAULT_PI_RECLAIM_* 是生产权威值——
 * u3b 装配经 resolveReclaimConfig（env 可覆盖）恒传给 reaper config；idle-pi-reaper
 * 模块内的 DEFAULT_* 仅为 options 未传时的 fallback 兜底（DI 纯单测场景，模块不读 env）。
 * 两处同源此前仅靠注释声明、无测试锁定——shared 改默认值而 reaper 兜底值未跟随会静默
 * 陈旧。本守卫逐对断言相等：任一侧单独改动即红，强迫同步两源。
 */
describe('默认值双源等值守卫', () => {
  it('reaper 兜底默认值与 shared 权威默认值逐对相等（TICK / IDLE / VIEWED_WINDOW / FORM_MAX_AGE 四对）', () => {
    expect(DEFAULT_REAP_TICK_MS).toBe(DEFAULT_PI_RECLAIM_TICK_MS)
    expect(DEFAULT_IDLE_THRESHOLD_MS).toBe(DEFAULT_PI_RECLAIM_IDLE_MS)
    expect(DEFAULT_VIEWED_WINDOW_MS).toBe(DEFAULT_PI_RECLAIM_VIEWED_WINDOW_MS)
    expect(DEFAULT_FORM_MAX_AGE_MS).toBe(DEFAULT_PI_RECLAIM_FORM_MAX_AGE_MS)
  })
})

// ── 挂起 UI 请求豁免纯判定（r5 I-1）────────────────────

/**
 * `hasFreshPendingUiRequest` 是组合根豁免闭包与 reaper 单测共用的纯函数（生产语义单点）。
 * 这里直接锁「max 聚合 / 严格 < / 超龄视同无 pending / 不修改入参」四个不变量。
 */
describe('hasFreshPendingUiRequest（挂起 UI 请求豁免判定纯函数）', () => {
  const MAX = 6 * 60 * 60 * 1000
  const NOW = 10_000_000

  it('无 pending → false；未超龄（含边界内一毫秒）→ true；恰等上界/超龄 → false（严格 <）', () => {
    expect(hasFreshPendingUiRequest([], NOW, MAX)).toBe(false)
    expect(hasFreshPendingUiRequest([{ receivedAt: NOW - MAX + 1 }], NOW, MAX)).toBe(true)
    expect(hasFreshPendingUiRequest([{ receivedAt: NOW - MAX }], NOW, MAX)).toBe(false)
    expect(hasFreshPendingUiRequest([{ receivedAt: NOW - MAX - 1 }], NOW, MAX)).toBe(false)
  })

  it('计龄取 max(receivedAt)：老僵尸 + 新活请求 → true（不得被老僵尸连带误判）', () => {
    const pending = [
      { receivedAt: NOW - MAX - 1 }, // 老僵尸
      { receivedAt: NOW - 10 }, // 新活请求
    ]
    expect(hasFreshPendingUiRequest(pending, NOW, MAX)).toBe(true)
  })

  it('全部超龄 → false（视同无 pending）；且不修改入参（不排空存储）', () => {
    const pending = [{ receivedAt: NOW - MAX - 1 }, { receivedAt: NOW - MAX - 2 }]
    const snapshot = JSON.stringify(pending)
    expect(hasFreshPendingUiRequest(pending, NOW, MAX)).toBe(false)
    expect(JSON.stringify(pending)).toBe(snapshot)
  })
})
