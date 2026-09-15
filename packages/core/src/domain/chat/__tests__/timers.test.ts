/**
 * timers 子域独立单测（MF-2，initTimers factory + clearSessionTimer 行为锁定）。
 *
 * 直接调 initTimers() 工厂构造实例：finalizeSession 用 vi.fn() mock（依赖注入，避免引
 * 循环 import）。timer 用 vi.useFakeTimers() + vi.advanceTimersByTime() 模拟到期，避免
 * 真实等待触发 vitest 5s 超时。
 *
 * 覆盖分支（对应 R1 MF-2）：
 * - streaming timer 到期调 finalizeSession(reason='timeout')
 * - [idle-refresh] 阈值 getter 注入（挂载时读当前值）+ refreshStreamingTimer（有 timer 重挂
 *   读当前值 / 无 timer no-op 不复活）
 * - clearStreamingTimer / disposeAllTimers（HMR/dispose 清理）
 * - clearSessionTimer（export 纯函数）
 * - per-session 隔离 + 重复 arm 不泄漏旧 timer
 *
 * [timeout-streaming-ui-idle u-s3] dormant bash timer 契约整链删除（§5.4 D4），
 * bash timer 用例随删除移除（纯减法，行为无变化）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { initTimers, clearSessionTimer } from '../timers'

const STREAMING_TIMEOUT_MS = 10_000

function makeTimers() {
  const finalizeSession = vi.fn<(sessionId: string, reason: string, errorText?: string) => void>()
  let timeoutMs = STREAMING_TIMEOUT_MS
  const t = initTimers(finalizeSession, () => timeoutMs)
  return {
    t,
    finalizeSession,
    /** [idle-refresh] 模拟配置源更新（store.setStreamingIdleTimeoutMs 等价物）。 */
    setTimeoutMs: (ms: number) => { timeoutMs = ms },
  }
}

describe('initTimers — streaming timer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('armStreamingTimer 挂 timer；未到期不调 finalizeSession', () => {
    const { t, finalizeSession } = makeTimers()
    t.armStreamingTimer('s1')
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(STREAMING_TIMEOUT_MS - 1)
    expect(finalizeSession).not.toHaveBeenCalled()
  })

  it('streaming timer 到期调 finalizeSession(sessionId, "timeout")', () => {
    const { t, finalizeSession } = makeTimers()
    t.armStreamingTimer('s1')

    vi.advanceTimersByTime(STREAMING_TIMEOUT_MS)
    expect(finalizeSession).toHaveBeenCalledTimes(1)
    expect(finalizeSession).toHaveBeenCalledWith('s1', 'timeout')
  })

  it('streaming timer 到期后自动从 Map 移除（getTimerCount 归 0）', () => {
    const { t } = makeTimers()
    t.armStreamingTimer('s1')
    vi.advanceTimersByTime(STREAMING_TIMEOUT_MS)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clearStreamingTimer 清 timer，到期不再调 finalizeSession', () => {
    const { t, finalizeSession } = makeTimers()
    t.armStreamingTimer('s1')
    t.clearStreamingTimer('s1')
    expect(vi.getTimerCount()).toBe(0)

    vi.advanceTimersByTime(STREAMING_TIMEOUT_MS)
    expect(finalizeSession).not.toHaveBeenCalled()
  })

  it('重复 armStreamingTimer 先清旧再挂新（同 session 不叠加）', () => {
    const { t } = makeTimers()
    t.armStreamingTimer('s1')
    t.armStreamingTimer('s1') // 再次 arm
    expect(vi.getTimerCount()).toBe(1)
  })

  it('per-session 隔离：s1 到期不影响 s2 的 timer', () => {
    const { t, finalizeSession } = makeTimers()
    t.armStreamingTimer('s1')
    t.armStreamingTimer('s2')

    vi.advanceTimersByTime(STREAMING_TIMEOUT_MS)
    // 两个同时挂同时到期（同 timeout），都应触发
    expect(finalizeSession).toHaveBeenCalledWith('s1', 'timeout')
    expect(finalizeSession).toHaveBeenCalledWith('s2', 'timeout')
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('initTimers — refreshStreamingTimer [idle-refresh]', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('有 timer 时 refresh 清 + 重挂：计时从刷新点重新起算（活动即刷新）', () => {
    const { t, finalizeSession } = makeTimers()
    t.armStreamingTimer('s1')
    // 推进阈值 - 1ms（即将到期）后活动帧到达 → refresh 重挂
    vi.advanceTimersByTime(STREAMING_TIMEOUT_MS - 1)
    t.refreshStreamingTimer('s1')
    // 再推进阈值 - 1ms（累计 2×(阈值-1) > 单阈值）：若未重挂早已触发
    vi.advanceTimersByTime(STREAMING_TIMEOUT_MS - 1)
    expect(finalizeSession).not.toHaveBeenCalled()
    // 推进最后 2ms（自刷新点满阈值）→ 触发
    vi.advanceTimersByTime(2)
    expect(finalizeSession).toHaveBeenCalledWith('s1', 'timeout')
  })

  it('refresh 挂载时读当前配置值（getter 注入，配置更新后新计时按新值）', () => {
    const { t, finalizeSession, setTimeoutMs } = makeTimers()
    t.armStreamingTimer('s1')
    setTimeoutMs(STREAMING_TIMEOUT_MS * 2) // 配置翻倍（arm 后生效）
    t.refreshStreamingTimer('s1') // refresh 重挂按新值
    // 推进旧阈值：若 refresh 仍按旧值，此处已触发
    vi.advanceTimersByTime(STREAMING_TIMEOUT_MS)
    expect(finalizeSession).not.toHaveBeenCalled()
    // 推进到新阈值（自 refresh 点起 2×）→ 触发
    vi.advanceTimersByTime(STREAMING_TIMEOUT_MS)
    expect(finalizeSession).toHaveBeenCalledWith('s1', 'timeout')
  })

  it('无 timer 时 refresh no-op（不复活——P-H 构造性语义）', () => {
    const { t, finalizeSession } = makeTimers()
    // 从未挂载
    t.refreshStreamingTimer('s1')
    expect(vi.getTimerCount()).toBe(0)
    // finalize 后（timer 到期自动移除）迟到刷新
    t.armStreamingTimer('s2')
    vi.advanceTimersByTime(STREAMING_TIMEOUT_MS)
    expect(finalizeSession).toHaveBeenCalledWith('s2', 'timeout')
    t.refreshStreamingTimer('s2')
    expect(vi.getTimerCount()).toBe(0)
    // 再推进长时间也无二次 finalize
    vi.advanceTimersByTime(STREAMING_TIMEOUT_MS * 3)
    expect(finalizeSession).toHaveBeenCalledTimes(1)
  })

  it('refresh 不影响其他 session 的 timer（只重挂目标 sid 的计时）', () => {
    const { t, finalizeSession } = makeTimers()
    t.armStreamingTimer('s1')
    t.armStreamingTimer('s2')
    // 两 timer 同挂；推进半程后只 refresh s1
    vi.advanceTimersByTime(STREAMING_TIMEOUT_MS / 2)
    t.refreshStreamingTimer('s1')
    expect(vi.getTimerCount()).toBe(2)
    // 再推半程：s2 走完原全程到期；s1 自刷新点仅过半程未到期
    vi.advanceTimersByTime(STREAMING_TIMEOUT_MS / 2)
    expect(finalizeSession).toHaveBeenCalledTimes(1)
    expect(finalizeSession).toHaveBeenCalledWith('s2', 'timeout')
    expect(vi.getTimerCount()).toBe(1)
    // s1 在刷新点 + 满阈值时到期
    vi.advanceTimersByTime(STREAMING_TIMEOUT_MS / 2)
    expect(finalizeSession).toHaveBeenCalledTimes(2)
    expect(finalizeSession).toHaveBeenCalledWith('s1', 'timeout')
  })
})

describe('initTimers — disposeAllTimers', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('disposeAllTimers 清全部 streaming timer（HMR/store dispose）', () => {
    const { t, finalizeSession } = makeTimers()
    t.armStreamingTimer('s1')
    t.armStreamingTimer('s2')
    t.armStreamingTimer('s3')
    expect(vi.getTimerCount()).toBe(3)

    t.disposeAllTimers()
    expect(vi.getTimerCount()).toBe(0)

    // advance 超过 timeout：无任何回调
    vi.advanceTimersByTime(STREAMING_TIMEOUT_MS)
    expect(finalizeSession).not.toHaveBeenCalled()
  })

  it('disposeAllTimers 幂等：无 timer 时 no-op', () => {
    const { t } = makeTimers()
    expect(() => t.disposeAllTimers()).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('disposeAllTimers 后可重新 arm timer（实例可复用）', () => {
    const { t, finalizeSession } = makeTimers()
    t.armStreamingTimer('s1')
    t.disposeAllTimers()

    t.armStreamingTimer('s1') // 重新 arm
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(STREAMING_TIMEOUT_MS)
    expect(finalizeSession).toHaveBeenCalledTimes(1)
  })
})

describe('clearSessionTimer — export 纯函数', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('清指定 session 的 timer（从 Map 移除 + clearTimeout）', () => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    timers.set('s1', setTimeout(() => {}, 1000))
    timers.set('s2', setTimeout(() => {}, 1000))

    clearSessionTimer(timers, 's1')

    expect(timers.has('s1')).toBe(false)
    expect(timers.has('s2')).toBe(true) // s2 不受影响
  })

  it('幂等：清不存在的 session timer 不报错（Map 无该 key 时 no-op）', () => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    expect(() => clearSessionTimer(timers, 'ghost')).not.toThrow()
    expect(timers.size).toBe(0)
  })

  it('clearSessionTimer 是 timers.ts 公共 API：initTimers 内部 arm/refresh/clear 共用同一函数', () => {
    // 间接验证：armStreamingTimer 后用 clearSessionTimer 形态（经 clearStreamingTimer 封装）
    // 能正确清除，说明 initTimers 内部 Map 与 clearSessionTimer 的 Map 类型一致
    const { t } = makeTimers()
    t.armStreamingTimer('s1')
    t.clearStreamingTimer('s1') // 内部调 clearSessionTimer
    expect(vi.getTimerCount()).toBe(0)
  })
})
