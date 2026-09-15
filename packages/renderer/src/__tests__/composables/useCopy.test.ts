/**
 * useCopy composable 单测（W2，对话流 markdown 渲染增强）。
 *
 * 覆盖：
 *  - U1 copy 写入剪贴板 + copied 置 key
 *  - U2 COPIED_FEEDBACK_MS 后 copied 清回 null
 *  - U3 连续 copy 后者覆盖前者定时（U2 的边界）
 *
 * mock 策略：navigator.clipboard.writeText stub；vi.useFakeTimers 控制 1200ms 反馈。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/composables/useCopy.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useCopy } from '@/composables/panel/useCopy'

describe('useCopy', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
  })

  it('U1: copy 写入剪贴板且 copied 置 key', () => {
    const { copied, copy } = useCopy()
    expect(copied.value).toBeNull()
    copy('hello', 'k1')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('hello')
    expect(copied.value).toBe('k1')
  })

  it('U2: 1200ms 后 copied 清回 null', () => {
    const { copied, copy } = useCopy()
    copy('hello', 'k1')
    expect(copied.value).toBe('k1')
    vi.advanceTimersByTime(1200)
    expect(copied.value).toBeNull()
  })

  it('U3: 连续 copy 后者覆盖前者定时——前者 timer 被 clear 不残留', () => {
    // 用间隔模拟真实连续复制：k1 后过 400ms 再 k2（k1 的 timer 设在 t=1200, k2 的设在 t=1600）
    const { copied, copy } = useCopy()
    copy('a', 'k1')
    vi.advanceTimersByTime(400)
    copy('b', 'k2')
    expect(copied.value).toBe('k2')
    // 推进到 k1 原本应触发的时刻（t=1200，即再过 800ms）。
    // 若 k1 timer 未被 clear：触发时 copied===k2（≠'k1'）→ 不误清（守卫成立）；
    // 即无论是否 clear，此处 copied 都应是 k2。真正验证点在下方：k2 的 timer 在 t=1600 正确触发清除。
    vi.advanceTimersByTime(800)
    expect(copied.value).toBe('k2')
    // 推进到 k2 的触发时刻（t=1600，再过 400ms）→ 清除
    vi.advanceTimersByTime(400)
    expect(copied.value).toBeNull()
  })
})
