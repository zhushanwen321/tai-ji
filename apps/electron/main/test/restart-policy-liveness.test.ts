/**
 * RestartPolicy 存活探针协同测试 —— W5 回归基线（应绿灯）。
 *
 * 目的：W5 改动为 restart-policy 引入「存活探针触发重启」新场景前，
 * 先把现有核心不变量钉死，防止 W5 重构退避序列 / 计数清零 / 手动重试配额时回退。
 *
 * 本文件是【回归基线测试】——restart-policy 已有实现，这里只验证：
 * - MAX_RESTARTS=5 + 退避序列 1/2/4/8/16s（W5 后必须保持不变）
 * - clearForManualRestart 清零后给新 5 次配额（W5 后必须保持不变）
 * - recordSuccess 无时间窗清零（ADR-0112：计数清零唯一入口 = 用户显式重试）
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
} from '../supervisor/restart-policy.js'

// 回归基线断言：常量值在 W5 后不得变动（存活探针复用同一套退避/上限）
describe('W5 回归基线：restart-policy 常量不变', () => {
  it('MAX_RESTARTS=5（存活探针触发的重启也走同一上限）', () => {
    expect(MAX_RESTARTS).toBe(5)
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

// 回归基线：无时间窗清零（ADR-0112：recordSuccess 只记录事实，计数清零唯一入口 = 用户显式重试）
describe('recordSuccess 无时间窗清零（ADR-0112）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('连续成功不清零（存活探针恢复也不清零）', () => {
    const p = new RestartPolicy()
    p.recordCrashAndGetDelay()
    p.recordCrashAndGetDelay()
    expect(p.count).toBe(2)

    p.recordSuccess()
    expect(p.count).toBe(2)

    vi.advanceTimersByTime(60_000)
    p.recordSuccess()
    expect(p.count).toBe(2)
  })

  it('计数持续累计直到 MAX 或 clearForManualRestart（用户显式重试是唯一清零入口）', () => {
    const p = new RestartPolicy()
    for (let i = 0; i < 3; i++) p.recordCrashAndGetDelay()
    expect(p.count).toBe(3)

    p.recordSuccess()
    vi.advanceTimersByTime(60_000)
    p.recordSuccess()
    expect(p.count).toBe(3)

    p.clearForManualRestart()
    expect(p.count).toBe(0)

    // 新故障簇：从 1 开始
    p.recordCrashAndGetDelay()
    expect(p.count).toBe(1)
    expect(p.exhausted).toBe(false)
  })
})
