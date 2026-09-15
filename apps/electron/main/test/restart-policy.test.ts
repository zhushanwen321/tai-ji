/**
 * RestartPolicy 单测 —— runtime 崩溃重启策略（纯逻辑）。
 *
 * 覆盖（spec §3.2 五个不变量）：
 * - shouldRestart：stopping 短路 / 计数上限
 * - recordCrashAndGetDelay：指数退避序列 1s/2s/4s/8s/16s
 * - recordSuccess：稳定窗口清零（区分瞬时簇 vs 持续故障）
 * - markStopping / reset：主动停止生命周期
 *
 * 运行：pnpm --filter @taiji/electron run test:main -- main/test/restart-policy.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  RestartPolicy,
  MAX_RESTARTS,
  RESTART_BASE_DELAY_MS,
  STABLE_MS,
} from '../supervisor/restart-policy.js'

describe('RestartPolicy.shouldRestart', () => {
  it('初始态应重启（计数 0 < MAX）', () => {
    const p = new RestartPolicy()
    expect(p.shouldRestart()).toBe(true)
    expect(p.count).toBe(0)
    expect(p.exhausted).toBe(false)
  })

  it('stopping 标志短路：markStopping 后永不重启', () => {
    const p = new RestartPolicy()
    p.markStopping()
    expect(p.shouldRestart()).toBe(false)
  })

  it('达到 MAX_RESTARTS 后 exhausted，不再重启', () => {
    const p = new RestartPolicy()
    for (let i = 0; i < MAX_RESTARTS; i++) {
      expect(p.shouldRestart()).toBe(true)
      p.recordCrashAndGetDelay()
    }
    expect(p.exhausted).toBe(true)
    expect(p.shouldRestart()).toBe(false)
  })

  it('reset 清除 stopping 标志（手动重试入口）', () => {
    const p = new RestartPolicy()
    p.markStopping()
    expect(p.shouldRestart()).toBe(false)
    p.reset()
    expect(p.shouldRestart()).toBe(true)
  })
})

describe('RestartPolicy.recordCrashAndGetDelay（指数退避）', () => {
  it('退避序列：1s/2s/4s/8s/16s（2^(n-1) * BASE，clamp MAX）', () => {
    const p = new RestartPolicy()
    const delays: number[] = []
    for (let i = 0; i < MAX_RESTARTS; i++) {
      delays.push(p.recordCrashAndGetDelay())
    }
    // 第 1..5 次：1000/2000/4000/8000/16000
    expect(delays).toEqual([
      1 * RESTART_BASE_DELAY_MS,
      2 * RESTART_BASE_DELAY_MS,
      4 * RESTART_BASE_DELAY_MS,
      8 * RESTART_BASE_DELAY_MS,
      16 * RESTART_BASE_DELAY_MS,
    ])
  })

  it('计数耗尽后再调 recordCrashAndGetDelay 抛错（前置 shouldRestart 未检查）', () => {
    const p = new RestartPolicy()
    for (let i = 0; i < MAX_RESTARTS; i++) {
      p.recordCrashAndGetDelay()
    }
    expect(() => p.recordCrashAndGetDelay()).toThrow(/exhausting/)
  })

  it('每次 recordCrash 递增 count', () => {
    const p = new RestartPolicy()
    expect(p.count).toBe(0)
    p.recordCrashAndGetDelay()
    expect(p.count).toBe(1)
    p.recordCrashAndGetDelay()
    expect(p.count).toBe(2)
  })
})

describe('RestartPolicy.recordSuccess（稳定窗口清零）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('稳定窗口内 recordSuccess 不清零（同簇内累计）', () => {
    const p = new RestartPolicy()
    p.recordCrashAndGetDelay()
    p.recordCrashAndGetDelay()
    expect(p.count).toBe(2)

    // 首次 recordSuccess：lastSuccessAt 初始 0，守卫 lastSuccessAt>0 不成立，不清零
    p.recordSuccess()
    expect(p.count).toBe(2)

    // 紧接着再成功（now - lastSuccessAt ≈ 0 < STABLE_MS），不清零
    p.recordSuccess()
    expect(p.count).toBe(2)
  })

  it('稳定窗口外 recordSuccess 清零计数（新故障簇）', () => {
    const p = new RestartPolicy()
    p.recordCrashAndGetDelay()
    p.recordCrashAndGetDelay()
    expect(p.count).toBe(2)

    p.recordSuccess() // 设 lastSuccessAt = T0
    expect(p.count).toBe(2)

    // 推进时间超过稳定窗口
    vi.advanceTimersByTime(STABLE_MS + 1)
    p.recordSuccess() // now - T0 > STABLE_MS → 清零
    expect(p.count).toBe(0)
  })

  it('稳定后再次崩溃从 1 开始（非累计历史）', () => {
    const p = new RestartPolicy()
    // 第一簇：崩 3 次
    for (let i = 0; i < 3; i++) p.recordCrashAndGetDelay()
    expect(p.count).toBe(3)

    // 稳定运行超过窗口
    p.recordSuccess()
    vi.advanceTimersByTime(STABLE_MS + 1)
    p.recordSuccess()
    expect(p.count).toBe(0)

    // 新故障簇：从 1 开始
    p.recordCrashAndGetDelay()
    expect(p.count).toBe(1)
    expect(p.exhausted).toBe(false)
  })
})

describe('RestartPolicy 主动停止生命周期', () => {
  it('markStopping → shouldRestart false → reset 恢复', () => {
    const p = new RestartPolicy()
    expect(p.stopping).toBe(false)

    p.markStopping()
    expect(p.stopping).toBe(true)
    expect(p.shouldRestart()).toBe(false)

    p.reset()
    expect(p.stopping).toBe(false)
    expect(p.shouldRestart()).toBe(true)
  })

  it('clearForManualRestart 给新配额：之前耗尽也能再重启', () => {
    const p = new RestartPolicy()
    for (let i = 0; i < MAX_RESTARTS; i++) p.recordCrashAndGetDelay()
    expect(p.exhausted).toBe(true)

    // 手动重试：clearForManualRestart 清计数，重新有 MAX 次配额
    p.clearForManualRestart()
    expect(p.shouldRestart()).toBe(true)
    expect(p.exhausted).toBe(false)
    expect(p.count).toBe(0)
  })

  it('reset（start 用）只清 stopping 不清计数，自动重启路径计数保持', () => {
    const p = new RestartPolicy()
    p.recordCrashAndGetDelay()
    p.recordCrashAndGetDelay()
    p.markStopping()
    expect(p.count).toBe(2)

    // start() 开头调 reset：清 stopping，但计数保留（崩溃自动重启路径需要累计）
    p.reset()
    expect(p.stopping).toBe(false)
    expect(p.count).toBe(2)
  })
})
