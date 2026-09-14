/**
 * useToast 限流（D7 S3-W4 在列上限）单测。
 *
 * 覆盖（useToast.test.ts 锁 timer/pause 契约，本文件补限流行为——测试舰队审查
 * batch-r2-03 登记「限流是缺口非冗余」）：
 * 1. 在列达到 UI_TOAST_LIMITS.MAX_IN_FLIGHT（shared SSOT，默认 5）后新 toast 被丢弃：
 *    不入列 + droppedCount 递增 + warn 留痕
 * 2. droppedCount 是累计计数：连续丢弃累加；限流基于「在列数」而非累计数——
 *    在列条目移除腾出空位后新 toast 可再入列，droppedCount 不回落
 * 3. setToastLimiter 注入恒丢弃策略同样走 droppedCount 计数；传 null 恢复默认放行
 *
 * 断言全部用「增量」（读用例开始时基线再比差值）：droppedCount 是模块级单例状态
 * （useToast.ts 模块顶 ref，无重置出口），增量断言可抗用例顺序重排与跨文件执行环境差异。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useToast.limiter.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useToast, setToastLimiter } from '@/composables/useToast'
import { UI_TOAST_LIMITS } from '@xyz-agent/shared'

describe('useToast 限流（D7 S3-W4 在列上限）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    // useToast 是模块级单例状态：跑完残留 timer 清空 toasts，避免跨用例污染
    vi.runAllTimers()
    vi.useRealTimers()
  })

  it('在列达到 MAX_IN_FLIGHT 后新 toast 被丢弃：不入列 + droppedCount 递增 + warn 留痕', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { toasts, info, droppedCount } = useToast()
      const droppedBefore = droppedCount.value

      for (let i = 0; i < UI_TOAST_LIMITS.MAX_IN_FLIGHT; i++) info(`t${i}`)
      expect(toasts.value).toHaveLength(UI_TOAST_LIMITS.MAX_IN_FLIGHT)
      expect(droppedCount.value).toBe(droppedBefore) // 未达上限：零丢弃

      info('overflow') // 超限的第 N+1 条
      expect(toasts.value).toHaveLength(UI_TOAST_LIMITS.MAX_IN_FLIGHT) // 不入列
      expect(toasts.value.some((t) => t.message === 'overflow')).toBe(false)
      expect(droppedCount.value).toBe(droppedBefore + 1)
      expect(warnSpy).toHaveBeenCalledTimes(1) // 丢弃留痕（通知风暴排查证据）
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('droppedCount 连续丢弃累加；移除一条后新 toast 可再入列（限流基于在列数，累计计数不回落）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { toasts, info, remove, droppedCount } = useToast()
      const droppedBefore = droppedCount.value

      for (let i = 0; i < UI_TOAST_LIMITS.MAX_IN_FLIGHT; i++) info(`t${i}`)
      info('drop-1')
      info('drop-2')
      expect(droppedCount.value).toBe(droppedBefore + 2)
      expect(toasts.value).toHaveLength(UI_TOAST_LIMITS.MAX_IN_FLIGHT)

      remove(toasts.value[0].id) // 腾出 1 个在列空位
      info('fits-now')
      expect(toasts.value.some((t) => t.message === 'fits-now')).toBe(true) // 可再入列
      expect(toasts.value).toHaveLength(UI_TOAST_LIMITS.MAX_IN_FLIGHT)
      expect(droppedCount.value).toBe(droppedBefore + 2) // 累计计数不回落
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('setToastLimiter 注入恒丢弃策略同样走 droppedCount 计数；传 null 恢复默认放行', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { toasts, info, droppedCount } = useToast()
      const droppedBefore = droppedCount.value

      setToastLimiter(() => true)
      info('always-dropped')
      expect(toasts.value).toHaveLength(0)
      expect(droppedCount.value).toBe(droppedBefore + 1) // 注入策略与默认共用丢弃计数路径

      setToastLimiter(null) // 恢复默认限流
      info('passes-again')
      expect(toasts.value.some((t) => t.message === 'passes-again')).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })
})
