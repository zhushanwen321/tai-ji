/**
 * useCopy composable 单测（W2，对话流 markdown 渲染增强）。
 *
 * 覆盖：
 *  - U1 copy 写入剪贴板 + 写盘成功后才置 copied key（[RD-1#3] 假成功修复）
 *  - U2 COPIED_FEEDBACK_MS 后 copied 清回 null
 *  - U3 连续 copy 后者覆盖前者定时（U2 的边界）
 *  - U4 [RD-1#3] 写盘失败：copied 不置（不显示「已复制」）+ console.warn 留痕 +
 *       toast error 显形（与 composer 快捷键复制路径同口径）
 *  - U5 [RD-1#3] 失败不清洗其他 key 的成功反馈（只回滚本次 key）
 *
 * mock 策略：navigator.clipboard.writeText stub；vi.useFakeTimers 控制 1200ms 反馈；
 * useToast mock 捕获失败 toast（降级显形的用户可见半边）。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/composables/useCopy.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const toastErrorMock = vi.hoisted(() => vi.fn())
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastErrorMock, info: vi.fn(), warning: vi.fn() }),
}))

import { useCopy } from '@/composables/panel/useCopy'

/** 冲干净微任务队列（writeText 的 then 回调在 microtask 里置 copied）。 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('useCopy', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    toastErrorMock.mockClear()
  })

  it('U1: copy 写入剪贴板且写盘成功后才置 copied key', async () => {
    const { copied, copy } = useCopy()
    expect(copied.value).toBeNull()
    copy('hello', 'k1')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('hello')
    // [RD-1#3] 同步不置图标：写盘结果未定时不得显示「已复制」
    expect(copied.value).toBeNull()
    await flushMicrotasks()
    expect(copied.value).toBe('k1')
  })

  it('U2: 1200ms 后 copied 清回 null', async () => {
    const { copied, copy } = useCopy()
    copy('hello', 'k1')
    await flushMicrotasks()
    expect(copied.value).toBe('k1')
    vi.advanceTimersByTime(1200)
    expect(copied.value).toBeNull()
  })

  it('U3: 连续 copy 后者覆盖前者定时——前者 timer 被 clear 不残留', async () => {
    // 用间隔模拟真实连续复制：k1 后过 400ms 再 k2（k1 的 timer 设在 t=1200, k2 的设在 t=1600）
    const { copied, copy } = useCopy()
    copy('a', 'k1')
    await flushMicrotasks()
    vi.advanceTimersByTime(400)
    copy('b', 'k2')
    await flushMicrotasks()
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

  it('U4 [RD-1#3]: writeText 失败 → 不置成功图标 + console.warn + toast error（假成功修复）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('clipboard denied'))
    const { copied, copy } = useCopy()

    expect(() => copy('hello', 'k1')).not.toThrow()
    await flushMicrotasks()

    // 不显示「已复制」（回滚：copied 保持 null）
    expect(copied.value).toBeNull()
    // warn 留痕（非静默吞噬）
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[useCopy] clipboard writeText failed (key=k1)'),
      expect.any(Error),
    )
    // toast 显形：与 composer 快捷键复制路径同 key（panel.composer.copyLastReplyFailed）
    expect(toastErrorMock).toHaveBeenCalledWith('复制失败')
    // 反馈 timer 未起：推进 1200ms 无副作用（也不会误清其他 key）
    vi.advanceTimersByTime(1200)
    expect(copied.value).toBeNull()
  })

  it('U5 [RD-1#3]: 本次失败不清洗其他 key 已显示的成功反馈', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { copied, copy } = useCopy()
    // k1 成功 → 图标显示中
    copy('a', 'k1')
    await flushMicrotasks()
    expect(copied.value).toBe('k1')
    // k2 失败：只回滚自己的 key，不动 k1 的反馈
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('denied'))
    copy('b', 'k2')
    await flushMicrotasks()
    expect(copied.value).toBe('k1')
    // k1 的定时照常到期清除
    vi.advanceTimersByTime(1200)
    expect(copied.value).toBeNull()
  })
})
