/**
 * RestartPolicy planned 边单测（u7c，crash-forensics-and-watchdog §3.3 D5 ④）。
 *
 * 覆盖（A4 验收：86 退出 → restart-policy 记 planned、退避计数不增、立即重启）：
 * - recordPlanned 返回 0（立即重启零退避）且 restartCount 不增（不进 counting 状态机）；
 * - planned 边不受 MAX 配额约束（exhausted 态下滚动重启仍可用——shouldRestart 门不适用）；
 * - planned 不污染 crash 计数序列：planned 后首次 crash 仍按 1s 基数起退避；
 * - planned 重启成功后稳定窗口清零照常适用（既有 recordSuccess 语义不回归）。
 *
 * 运行：cd apps/electron/main && npx vitest run test/restart-policy-planned.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  RestartPolicy,
  PLANNED_RESTART_DELAY_MS,
  RESTART_BASE_DELAY_MS,
  MAX_RESTARTS,
} from '../supervisor/restart-policy.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('recordPlanned：planned 边不进 counting 状态机（A4）', () => {
  it('返回 0 延迟且计数不增', () => {
    const policy = new RestartPolicy()
    expect(policy.count).toBe(0)

    expect(policy.recordPlanned()).toBe(PLANNED_RESTART_DELAY_MS)
    expect(PLANNED_RESTART_DELAY_MS).toBe(0)
    expect(policy.count).toBe(0)
    expect(policy.exhausted).toBe(false)
  })

  it('多次 planned 依旧零计数（滚动重启反复发生不消耗崩溃配额）', () => {
    const policy = new RestartPolicy()
    policy.recordPlanned()
    policy.recordPlanned()
    policy.recordPlanned()
    expect(policy.count).toBe(0)
  })

  it('exhausted 态下 planned 仍可用（planned 不受 shouldRestart 门约束）', () => {
    const policy = new RestartPolicy()
    for (let i = 0; i < MAX_RESTARTS; i++) {
      policy.recordCrashAndGetDelay()
    }
    expect(policy.exhausted).toBe(true)
    expect(policy.shouldRestart()).toBe(false)

    // 滚动重启（86）在崩溃配额耗尽下仍须照常重启（计划内路径与 crash 配额正交）
    expect(policy.recordPlanned()).toBe(0)
    expect(policy.count).toBe(MAX_RESTARTS)
  })

  it('planned 不污染 crash 退避序列：其后首次 crash 仍从 1s 基数起', () => {
    const policy = new RestartPolicy()
    policy.recordPlanned()
    expect(policy.recordCrashAndGetDelay()).toBe(RESTART_BASE_DELAY_MS)
    expect(policy.count).toBe(1)
  })

  it('既有 crash 计数下 planned 成功 + 稳定窗口后 recordSuccess 清零（新稳定周期语义）', async () => {
    vi.useFakeTimers()
    const policy = new RestartPolicy()
    policy.recordCrashAndGetDelay()
    policy.recordCrashAndGetDelay()
    expect(policy.count).toBe(2)

    policy.recordSuccess()
    vi.advanceTimersByTime(10_001) // > STABLE_MS
    policy.recordPlanned() // 滚动重启（不改变计数与 lastSuccessAt）
    policy.recordSuccess() // 重启成功
    expect(policy.count).toBe(0)
  })
})
