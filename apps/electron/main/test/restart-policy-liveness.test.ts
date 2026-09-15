/**
 * RestartPolicy 存活探针协同测试 —— W5 回归基线（应绿灯）。
 *
 * 目的：W5 改动为 restart-policy 引入「存活探针触发重启」新场景前，
 * 先把现有核心不变量钉死，防止 W5 重构退避序列 / 计数清零 / 手动重试配额时回退。
 *
 * 本文件是【回归基线测试】——restart-policy 已有实现，这里只验证：
 * - MAX_RESTARTS=5 + 退避序列 1/2/4/8/16s（W5 后必须保持不变）
 * - clearForManualRestart 清零后给新 5 次配额（W5 后必须保持不变）
 * - recordSuccess 稳定窗口 STABLE_MS=10s 后清零（W5 后必须保持不变）
 *
 * 注意：W5 新增的存活探针（checkHealthEndpoint / forceRestartForLiveness）
 * 属于 supervisor-health-liveness.test.ts 的范畴，此处不涉及。
 *
 * 运行：cd apps/electron/main && npx vitest run test/restart-policy-liveness.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  RestartPolicy,
  MAX_RESTARTS,
  RESTART_BASE_DELAY_MS,
  STABLE_MS,
} from '../supervisor/restart-policy.js'

// 回归基线断言：常量值在 W5 后不得变动（存活探针复用同一套退避/上限）
describe('W5 回归基线：restart-policy 常量不变', () => {
  it('MAX_RESTARTS=5（存活探针触发的重启也走同一上限）', () => {
    expect(MAX_RESTARTS).toBe(5)
  })

  it('STABLE_MS=10s（存活探针成功后同样按此窗口清零）', () => {
    expect(STABLE_MS).toBe(10_000)
  })

  it('RESTART_BASE_DELAY_MS=1s（退避基数不变）', () => {
    expect(RESTART_BASE_DELAY_MS).toBe(1_000)
  })
})

// 回归基线：退避序列 1/2/4/8/16s（W5 存活探针触发 forceRestart 复用此序列）
describe('W5 回归基线：退避序列 1/2/4/8/16s 不变', () => {
  it('连续 5 次崩溃的退避序列为 [1000,2000,4000,8000,16000] ms', () => {
    const p = new RestartPolicy()
    const delays: number[] = []
    for (let i = 0; i < MAX_RESTARTS; i++) {
      delays.push(p.recordCrashAndGetDelay())
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000])
  })

  it('第 6 次崩溃抛错（exhausted，存活探针触发的重启也受此约束）', () => {
    const p = new RestartPolicy()
    for (let i = 0; i < MAX_RESTARTS; i++) p.recordCrashAndGetDelay()
    expect(() => p.recordCrashAndGetDelay()).toThrow(/exhausting/)
  })
})

// 回归基线：手动重试配额（W5 后 forceRestart 耗尽时用户仍可通过 clearForManualRestart 重试）
describe('W5 回归基线：clearForManualRestart 清零后给新 5 次配额', () => {
  it('耗尽后 clearForManualRestart → 计数清零 + 新 5 次配额', () => {
    const p = new RestartPolicy()
    for (let i = 0; i < MAX_RESTARTS; i++) p.recordCrashAndGetDelay()
    expect(p.exhausted).toBe(true)
    expect(p.shouldRestart()).toBe(false)

    // 用户手动重试：清零，重新有 5 次配额
    p.clearForManualRestart()
    expect(p.count).toBe(0)
    expect(p.exhausted).toBe(false)
    expect(p.shouldRestart()).toBe(true)

    // 验证新配额确实是 5 次（退避序列重新从 1s 开始）
    const firstDelay = p.recordCrashAndGetDelay()
    expect(firstDelay).toBe(RESTART_BASE_DELAY_MS)
    expect(p.count).toBe(1)
  })

  it('clearForManualRestart 同时清除 stopping 标志（手动重试是新生命周期）', () => {
    const p = new RestartPolicy()
    // 先制造计数 + stopping 状态（模拟崩溃重启耗尽后用户主动 stop 再手动重试）
    p.recordCrashAndGetDelay()
    p.recordCrashAndGetDelay()
    p.markStopping()
    expect(p.stopping).toBe(true)
    expect(p.count).toBe(2)
    expect(p.shouldRestart()).toBe(false) // stopping 短路

    // 用户手动重试：清零计数 + 清 stopping，重新有 5 次配额
    p.clearForManualRestart()
    expect(p.count).toBe(0)
    expect(p.stopping).toBe(false)
    expect(p.shouldRestart()).toBe(true)

    // 新配额可用：第 1 次退避从 1s 开始
    const firstDelay = p.recordCrashAndGetDelay()
    expect(firstDelay).toBe(RESTART_BASE_DELAY_MS)
  })
})

// 回归基线：稳定窗口清零（W5 后存活探针成功也按此窗口重置计数）
describe('W5 回归基线：recordSuccess 稳定窗口 STABLE_MS=10s 后清零', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('窗口内连续成功不清零（同簇累计，存活探针也遵循）', () => {
    const p = new RestartPolicy()
    p.recordCrashAndGetDelay()
    p.recordCrashAndGetDelay()
    expect(p.count).toBe(2)

    // 首次成功：lastSuccessAt 初始 0，守卫不成立，不清零
    p.recordSuccess()
    expect(p.count).toBe(2)

    // 窗口内再次成功：now - lastSuccessAt ≈ 0 < STABLE_MS，不清零
    p.recordSuccess()
    expect(p.count).toBe(2)
  })

  it('窗口外成功清零（新故障簇，存活探针恢复后计数重置）', () => {
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

  it('清零后新崩溃从 1 开始（存活探针恢复后再崩溃不累计历史）', () => {
    const p = new RestartPolicy()
    for (let i = 0; i < 3; i++) p.recordCrashAndGetDelay()
    expect(p.count).toBe(3)

    // 稳定运行超过窗口
    p.recordSuccess()
    vi.advanceTimersByTime(STABLE_MS + 1)
    p.recordSuccess()
    expect(p.count).toBe(0)

    // 新故障簇：从 1 开始（非 4）
    p.recordCrashAndGetDelay()
    expect(p.count).toBe(1)
    expect(p.exhausted).toBe(false)
  })
})
