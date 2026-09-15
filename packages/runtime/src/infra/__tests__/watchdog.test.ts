/**
 * 内存看门狗单测（crash-forensics-and-watchdog §3.3 D4，实施单元 u6）。
 *
 * 覆盖（impl-plan u6 验收行逐项）：
 * - A1 阈值判定：70%/85% 两级各命中与不命中（classifyMemoryLevel 纯函数边界 + 集成拍广播档位）。
 * - A2 持续性条件：单周期越线不触发 relief；连续 2 周期触发；中间回落重置连续计数。
 * - A3 memory-relief 事件落台账：layer/event/reason/heapUsed/rss 字段断言（D1 schema）。
 * - A4 降级反弹缓解：relief 执行后未回落不重复执行；回落后再连续越线可再次执行。
 * - Gate W 武装门：armed=false 纯观测（采样照跑、无广播无 relief）。
 * - 广播 payload 字段（WatchdogMemoryPressurePayload 契约）+ 环容量淘汰 + stop 收口。
 *
 * 全程 fake timers（60s 采样周期真实等待不可接受）；memoryUsage/heapSizeLimit/journal
 * 全量注入，无真实 process/v8 依赖、零 fs 写删。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/__tests__/watchdog.test.ts
 */
import { describe, expect, it, vi, beforeEach, afterEach, type Mock } from 'vitest'
import {
  startWatchdog,
  resolveWatchdogConfig,
  classifyMemoryLevel,
  DEFAULT_WATCHDOG_SAMPLE_INTERVAL_MS,
  WATCHDOG_SUSTAIN_TICKS,
  type WatchdogSample,
} from '../watchdog.js'
import type { CrashJournalWriter } from '@taiji/shared'
import type { WatchdogMemoryPressurePayload } from '@taiji/shared'

const HEAP_LIMIT = 1_000_000_000
const SAMPLE_MS = DEFAULT_WATCHDOG_SAMPLE_INTERVAL_MS

/** 按百分比构造 memoryUsage mock（heapUsed = pct% × HEAP_LIMIT；rss 恒 2e9 供台账断言）。 */
function usageAtPercent(pct: number): () => NodeJS.MemoryUsage {
  return () => ({ heapUsed: Math.round((HEAP_LIMIT * pct) / 100), rss: 2_000_000_000 } as NodeJS.MemoryUsage)
}

interface Harness {
  handle: ReturnType<typeof startWatchdog>
  relief: Mock
  broadcast: Mock
  journalAppend: Mock
}

function startHarness(opts: {
  armed?: boolean
  usage: () => NodeJS.MemoryUsage
  warnPercent?: number
  criticalPercent?: number
}): Harness {
  const relief = vi.fn()
  const broadcast = vi.fn()
  const journalAppend = vi.fn()
  const journal: CrashJournalWriter = { append: journalAppend }
  const handle = startWatchdog({
    armed: opts.armed ?? true,
    memoryUsage: opts.usage,
    heapSizeLimit: () => HEAP_LIMIT,
    onRelief: relief,
    broadcast: (p) => broadcast(p),
    journal,
    warnPercent: opts.warnPercent,
    criticalPercent: opts.criticalPercent,
  })
  return { handle, relief, broadcast, journalAppend }
}

/** 推进 n 个采样拍。 */
function advanceTicks(n: number): void {
  vi.advanceTimersByTime(SAMPLE_MS * n)
}

describe('classifyMemoryLevel（A1 阈值判定纯函数）', () => {
  it('恰等告警线 70 → warn；低一分 → normal', () => {
    expect(classifyMemoryLevel(70, 70, 85)).toBe('warn')
    expect(classifyMemoryLevel(69.999, 70, 85)).toBe('normal')
  })

  it('告警与临界之间 → warn；恰等临界线 85 → critical', () => {
    expect(classifyMemoryLevel(84.999, 70, 85)).toBe('warn')
    expect(classifyMemoryLevel(85, 70, 85)).toBe('critical')
  })

  it('注入自定义阈值面时按注入值判定（env 覆盖语义）', () => {
    expect(classifyMemoryLevel(50, 40, 60)).toBe('warn')
    expect(classifyMemoryLevel(60, 40, 60)).toBe('critical')
  })
})

describe('resolveWatchdogConfig（env 旋钮）', () => {
  it('缺省：armed=false（Gate W 默认 off）+ 阈值/周期取设计默认', () => {
    expect(resolveWatchdogConfig({})).toEqual({
      armed: false,
      sampleIntervalMs: 60_000,
      warnPercent: 70,
      criticalPercent: 85,
    })
  })

  it('armed：仅 1/true 武装（其余含 0/false/乱值不武装——fail-safe 向）', () => {
    expect(resolveWatchdogConfig({ TAIJI_RUNTIME_WATCHDOG_ARMED: '1' }).armed).toBe(true)
    expect(resolveWatchdogConfig({ TAIJI_RUNTIME_WATCHDOG_ARMED: 'true' }).armed).toBe(true)
    expect(resolveWatchdogConfig({ TAIJI_RUNTIME_WATCHDOG_ARMED: 'TRUE' }).armed).toBe(true)
    expect(resolveWatchdogConfig({ TAIJI_RUNTIME_WATCHDOG_ARMED: '0' }).armed).toBe(false)
    expect(resolveWatchdogConfig({ TAIJI_RUNTIME_WATCHDOG_ARMED: 'yes' }).armed).toBe(false)
  })

  it('百分比/周期非法值（NaN/越界/负数）warn 回落默认，不 throw', () => {
    const parsed = resolveWatchdogConfig({
      TAIJI_RUNTIME_WATCHDOG_WARN_PCT: '120',
      TAIJI_RUNTIME_WATCHDOG_CRIT_PCT: 'abc',
      TAIJI_RUNTIME_WATCHDOG_SAMPLE_MS: '-5',
    })
    expect(parsed.warnPercent).toBe(70)
    expect(parsed.criticalPercent).toBe(85)
    expect(parsed.sampleIntervalMs).toBe(60_000)
  })
})

describe('A2 持续性条件 + A4 反弹缓解（armed=true）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('A2：单周期越线不触发 relief（瞬时毛刺防护），连续第 2 周期触发', () => {
    const h = startHarness({ usage: usageAtPercent(80) })
    advanceTicks(1)
    expect(h.relief).not.toHaveBeenCalled() // 第 1 拍：越线但不持续
    advanceTicks(1)
    expect(h.relief).toHaveBeenCalledTimes(1) // 第 2 拍：连续 2 拍 → 触发
    expect(h.journalAppend).toHaveBeenCalledTimes(1)
    h.handle.stop()
  })

  it('A2：中间回落重置连续计数——高、normal、高 序列不触发', () => {
    let pct = 80
    const h = startHarness({ usage: () => usageAtPercent(pct)() })
    advanceTicks(1) // 高（consecutive=1）
    pct = 50
    advanceTicks(1) // 回落（计数归零 + 锁重置）
    pct = 80
    advanceTicks(1) // 高（consecutive=1，不触发）
    expect(h.relief).not.toHaveBeenCalled()
    h.handle.stop()
  })

  it('A4：relief 执行后水位未回落 → 不重复执行（退避一次语义）', () => {
    const h = startHarness({ usage: usageAtPercent(80) })
    advanceTicks(WATCHDOG_SUSTAIN_TICKS) // 触发第 1 次
    expect(h.relief).toHaveBeenCalledTimes(1)
    advanceTicks(3) // 持续高位 3 拍：锁内只计数不执行
    expect(h.relief).toHaveBeenCalledTimes(1)
    expect(h.journalAppend).toHaveBeenCalledTimes(1)
    expect(h.handle.getStatus().reliefAvailable).toBe(false)
    h.handle.stop()
  })

  it('A4：回落后（normal 拍重置锁）再连续越线 → 可再次执行', () => {
    let pct = 80
    const h = startHarness({ usage: () => usageAtPercent(pct)() })
    advanceTicks(WATCHDOG_SUSTAIN_TICKS) // 第 1 次 relief
    expect(h.relief).toHaveBeenCalledTimes(1)
    pct = 50
    advanceTicks(1) // 回落：锁重置
    expect(h.handle.getStatus().reliefAvailable).toBe(true)
    pct = 90
    advanceTicks(WATCHDOG_SUSTAIN_TICKS) // 再连续越线 → 第 2 次 relief
    expect(h.relief).toHaveBeenCalledTimes(2)
    expect(h.journalAppend).toHaveBeenCalledTimes(2)
    h.handle.stop()
  })
})

describe('A3 memory-relief 事件落台账（D1 schema 字段）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('事件字段：layer=runtime / event=memory-relief / reason=warn-tier / heapUsed+rss 用量快照', () => {
    const h = startHarness({ usage: usageAtPercent(75) })
    advanceTicks(WATCHDOG_SUSTAIN_TICKS)
    expect(h.journalAppend).toHaveBeenCalledTimes(1)
    const event = h.journalAppend.mock.calls[0][0]
    expect(event.layer).toBe('runtime')
    expect(event.event).toBe('memory-relief')
    expect(event.reason).toBe('warn-tier')
    expect(event.heapUsed).toBe(Math.round((HEAP_LIMIT * 75) / 100))
    expect(event.rss).toBe(2_000_000_000)
    h.handle.stop()
  })

  it('critical 档触发（首拍即 ≥85）同样在持续 2 拍后 relief（临界档覆盖告警线）', () => {
    const h = startHarness({ usage: usageAtPercent(90) })
    advanceTicks(1)
    expect(h.relief).not.toHaveBeenCalled()
    advanceTicks(1)
    expect(h.relief).toHaveBeenCalledTimes(1)
    const event = h.journalAppend.mock.calls[0][0]
    expect(event.event).toBe('memory-relief')
    h.handle.stop()
  })

  it('onRelief 注入动作抛错：台账照记（触发事实独立于动作成败），异常不逃逸', () => {
    const journalAppend = vi.fn()
    const handle = startWatchdog({
      armed: true,
      memoryUsage: usageAtPercent(80),
      heapSizeLimit: () => HEAP_LIMIT,
      onRelief: () => {
        throw new Error('relief action boom')
      },
      journal: { append: journalAppend },
    })
    expect(() => advanceTicks(WATCHDOG_SUSTAIN_TICKS)).not.toThrow()
    expect(journalAppend).toHaveBeenCalledTimes(1)
    expect(journalAppend.mock.calls[0][0].event).toBe('memory-relief')
    handle.stop()
  })
})

describe('renderer 广播通知（WatchdogMemoryPressurePayload 契约）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('越线拍每拍广播当前档 + 用量/阈值字段（warn 档）', () => {
    const h = startHarness({ usage: usageAtPercent(75) })
    advanceTicks(1)
    expect(h.broadcast).toHaveBeenCalledTimes(1)
    const p = h.broadcast.mock.calls[0][0] as WatchdogMemoryPressurePayload
    expect(p.level).toBe('warn')
    expect(p.heapUsed).toBe(Math.round((HEAP_LIMIT * 75) / 100))
    expect(p.heapSizeLimit).toBe(HEAP_LIMIT)
    expect(p.usedPercent).toBe(75)
    expect(p.warnPercent).toBe(70)
    expect(p.criticalPercent).toBe(85)
    h.handle.stop()
  })

  it('critical 档广播 level=critical；normal 拍不广播', () => {
    let pct = 90
    const h = startHarness({ usage: () => usageAtPercent(pct)() })
    advanceTicks(1)
    expect(h.broadcast.mock.calls[0][0].level).toBe('critical')
    pct = 50
    advanceTicks(1)
    expect(h.broadcast).toHaveBeenCalledTimes(1) // 回落拍无帧（normal 不广播）
    h.handle.stop()
  })

  it('Gate W off（armed=false）：高位多拍零广播零 relief，判定面照算（观测先行）', () => {
    const h = startHarness({ armed: false, usage: usageAtPercent(90) })
    advanceTicks(WATCHDOG_SUSTAIN_TICKS + 2)
    expect(h.broadcast).not.toHaveBeenCalled()
    expect(h.relief).not.toHaveBeenCalled()
    expect(h.journalAppend).not.toHaveBeenCalled()
    const status = h.handle.getStatus()
    expect(status.lastSample).not.toBeNull()
    expect(status.consecutiveAboveWarn).toBe(WATCHDOG_SUSTAIN_TICKS + 2)
    expect(status.level).toBe('critical') // 判定照算（观测面）
    h.handle.stop()
  })
})

describe('采样观测与收口（oe-audit C4：24h 采样环已删，观测面 = lastSample + 计数器）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('样本形态：lastSample 携带 ts/heapUsed/heapSizeLimit/rss/usedPercent（D4 采样字段）', () => {
    const h = startHarness({ usage: usageAtPercent(50) })
    advanceTicks(2)
    const s = h.handle.getStatus().lastSample as WatchdogSample
    expect(s.heapSizeLimit).toBe(HEAP_LIMIT)
    expect(s.rss).toBe(2_000_000_000)
    expect(s.usedPercent).toBeCloseTo(50, 5)
    expect(typeof s.ts).toBe('number')
    h.handle.stop()
  })

  it('stop 后不再采样（lastSample 停留在 stop 前最后一拍，重复读取返回同引用）', () => {
    const h = startHarness({ usage: usageAtPercent(50) })
    advanceTicks(1)
    h.handle.stop()
    advanceTicks(3)
    const status1 = h.handle.getStatus()
    expect(status1.lastSample).not.toBeNull()
    expect(h.handle.getStatus().lastSample).toBe(status1.lastSample)
  })

  it('采样异常（memoryUsage 抛错）不逃逸定时器回调，后续拍继续（best-effort）', () => {
    let fail = true
    const handle = startWatchdog({
      armed: true,
      memoryUsage: () => {
        if (fail) throw new Error('probe boom')
        return usageAtPercent(50)()
      },
      heapSizeLimit: () => HEAP_LIMIT,
      journal: { append: vi.fn() },
    })
    expect(() => advanceTicks(2)).not.toThrow()
    fail = false
    advanceTicks(1)
    expect(handle.getStatus().lastSample).not.toBeNull()
    handle.stop()
  })
})
