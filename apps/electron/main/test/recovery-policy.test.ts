/**
 * recovery-policy 单测（crash-resilience u3-renderer-recovery 验收条款：
 * 滑窗 3 次熔断 / 第 4 次不 reload / 过期恢复 / 多窗口隔离 / 时间注入）。
 *
 * 被测对象是纯逻辑（时钟经 nowMs 参数注入、零 IO 零 electron 依赖），
 * 直接实例化驱动，无需 fake timers。
 * 运行：cd apps/electron/main && npx vitest run test/recovery-policy.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  RecoveryPolicy,
  DEFAULT_RECOVERY_WINDOW_MS,
  DEFAULT_MAX_CRASHES_IN_WINDOW,
} from '../window/recovery-policy.js'

describe('RecoveryPolicy：60s 滑动窗口 ≤3 次熔断（默认参数）', () => {
  it('窗口内前 3 次崩溃均决策自动 reload', () => {
    const policy = new RecoveryPolicy()
    expect(policy.recordCrash('win-a', 1_000)).toBe('reload')
    expect(policy.recordCrash('win-a', 2_000)).toBe('reload')
    expect(policy.recordCrash('win-a', 3_000)).toBe('reload')
  })

  it('窗口内第 4 次熔断：不再 reload 改 show-error-page', () => {
    const policy = new RecoveryPolicy()
    policy.recordCrash('win-a', 1_000)
    policy.recordCrash('win-a', 2_000)
    policy.recordCrash('win-a', 3_000)
    expect(policy.recordCrash('win-a', 4_000)).toBe('show-error-page')
  })

  it('熔断后窗口内继续崩溃维持 show-error-page（不回弹）', () => {
    const policy = new RecoveryPolicy()
    for (let t = 1_000; t <= 4_000; t += 1_000) policy.recordCrash('win-a', t)
    expect(policy.recordCrash('win-a', 5_000)).toBe('show-error-page')
    expect(policy.recordCrash('win-a', 6_000)).toBe('show-error-page')
  })

  it('滑窗出窗边界：now - crashAt 恰好等于 windowMs 视为出窗，小于则仍在窗内', () => {
    const policy = new RecoveryPolicy()
    policy.recordCrash('win-a', 0)
    // 59_999ms 后：旧记录仍在窗内 → 计数 2
    expect(policy.recordCrash('win-a', DEFAULT_RECOVERY_WINDOW_MS - 1)).toBe('reload')
    // 再推 1ms：首条恰好出窗 → 计数衰减为 1（本次），仍 reload
    expect(policy.recordCrash('win-a', DEFAULT_RECOVERY_WINDOW_MS)).toBe('reload')
  })

  it('过期恢复：旧记录全部出窗后熔断自然解除，恢复自动 reload', () => {
    const policy = new RecoveryPolicy()
    for (let t = 0; t <= 4_000; t += 1_000) policy.recordCrash('win-a', t)
    expect(policy.recordCrash('win-a', 4_000)).toBe('show-error-page')
    // 64s 后：0/1/2/3/4s 五条全部出窗（64s-t ≥ 60s）→ 窗内仅本次 1 条 → reload
    // （滑动窗口的自然衰减，无需显式恢复定时器）
    expect(policy.recordCrash('win-a', 64_000)).toBe('reload')
  })
})

describe('RecoveryPolicy：多窗口互不影响', () => {
  it('A 窗熔断不改变 B 窗的判定（B 首崩仍 reload）', () => {
    const policy = new RecoveryPolicy()
    for (let t = 0; t <= 3_000; t += 1_000) policy.recordCrash('win-a', t)
    expect(policy.recordCrash('win-a', 4_000)).toBe('show-error-page')
    expect(policy.recordCrash('win-b', 4_500)).toBe('reload')
  })

  it('A/B 各自独立计数：B 连崩 4 次同样熔断，且 A 的窗口状态不被 B 影响', () => {
    const policy = new RecoveryPolicy()
    for (let t = 0; t <= 3_000; t += 1_000) policy.recordCrash('win-a', t)
    for (let t = 100; t <= 3_100; t += 1_000) policy.recordCrash('win-b', t)
    expect(policy.recordCrash('win-b', 4_100)).toBe('show-error-page')
    // A 第 4 次崩：其自身计数（4 条在窗）独立于 B → 熔断
    expect(policy.recordCrash('win-a', 4_500)).toBe('show-error-page')
  })

  it('reset 单窗口：仅清除该窗口计数，其他窗口不受影响', () => {
    const policy = new RecoveryPolicy()
    for (let t = 0; t <= 3_000; t += 1_000) policy.recordCrash('win-a', t)
    policy.recordCrash('win-a', 4_000) // A 熔断
    policy.recordCrash('win-b', 4_000)
    policy.recordCrash('win-b', 5_000)
    policy.reset('win-a')
    expect(policy.recordCrash('win-a', 5_000)).toBe('reload')
    // B 已有 2 条在窗，本次第 3 条 → 仍 reload（未被 A 的 reset 波及）
    expect(policy.recordCrash('win-b', 6_000)).toBe('reload')
  })
})

describe('RecoveryPolicy：reset 与参数注入', () => {
  it('reset 后重新获得完整自动 reload 预算（静态错误页「重试」语义）', () => {
    const policy = new RecoveryPolicy()
    for (let t = 0; t <= 4_000; t += 1_000) policy.recordCrash('win-a', t)
    expect(policy.recordCrash('win-a', 5_000)).toBe('show-error-page')
    policy.reset('win-a')
    expect(policy.recordCrash('win-a', 6_000)).toBe('reload')
  })

  it('windowMs / maxCrashesInWindow 可注入（非默认档位生效）', () => {
    const policy = new RecoveryPolicy({ windowMs: 10_000, maxCrashesInWindow: 1 })
    expect(policy.recordCrash('win-a', 0)).toBe('reload')
    expect(policy.recordCrash('win-a', 5_000)).toBe('show-error-page')
    // 15s 后：0s/5s 两条恰好全部出窗（15s-t ≥ 10s）→ 计数衰减恢复 reload
    expect(policy.recordCrash('win-a', 15_000)).toBe('reload')
  })

  it('时间完全由注入的 nowMs 驱动（不依赖真实时钟：远未来时间戳正常判定）', () => {
    const policy = new RecoveryPolicy()
    const farFuture = 1_000_000_000_000
    policy.recordCrash('win-a', farFuture)
    policy.recordCrash('win-a', farFuture + 1)
    policy.recordCrash('win-a', farFuture + 2)
    expect(policy.recordCrash('win-a', farFuture + 3)).toBe('show-error-page')
    // 窗宽推移后 4 条全部出窗 → 计数衰减恢复 reload
    expect(policy.recordCrash('win-a', farFuture + 60_100)).toBe('reload')
  })

  it('默认常量与设计定值一致（60s / 3 次）', () => {
    expect(DEFAULT_RECOVERY_WINDOW_MS).toBe(60_000)
    expect(DEFAULT_MAX_CRASHES_IN_WINDOW).toBe(3)
  })
})
