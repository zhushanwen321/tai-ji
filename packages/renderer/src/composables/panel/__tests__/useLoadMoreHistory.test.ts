// @vitest-environment node

/**
 * useLoadMoreHistory —— [scroll-top-auto-load] 触顶自动续载的判定与防重入。
 *
 * 背景（2026-09-19 会话 01a0b8b3 实证）：runtime 历史窗口按「20 轮 + 640KB」双预算收窗，
 * 而重 agent 会话单轮就去到 100KB–1.5MB（实测该 session 7 轮共 3.5MB → 一页只装下 1 轮），
 * 「加载更早」按钮高频出现且每点一次只翻一轮。改为：滚到顶自动续载，按钮退化为兜底/进度位。
 *
 * 本文件锁四个前置条件（每个都是一个曾经会出错的形态）：
 * - isDetached=false（贴底 / session 切换的 scrollTop clamp 回声）不触发——否则切 session 白拉一页；
 * - offset 未触顶不触发；
 * - 无更早历史（showLoadMore=false）不触发；
 * - 加载中不重入（单一守卫源在 handleLoadMore）。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'

const { loadMoreHistoryMock, hasMoreRef } = vi.hoisted(() => ({
  loadMoreHistoryMock: vi.fn<() => Promise<boolean>>(),
  hasMoreRef: { value: true },
}))

vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({
    loadMoreHistory: loadMoreHistoryMock,
    hasMoreHistory: () => hasMoreRef.value,
  }),
}))

import { useLoadMoreHistory, TOP_AUTO_LOAD_THRESHOLD_PX, SLOW_LINE_DELAY_MS } from '../useLoadMoreHistory'

/** 可控 resolve 的 deferred（验证加载中防重入 + isPrepend 生命周期）。 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function setup(): ReturnType<typeof useLoadMoreHistory> {
  const sessionId = ref('s1')
  return useLoadMoreHistory(() => sessionId.value)
}

describe('onScrollOffset（触顶自动续载）', () => {
  beforeEach(() => {
    loadMoreHistoryMock.mockReset()
    loadMoreHistoryMock.mockResolvedValue(true)
    hasMoreRef.value = true
  })

  it('触顶 + 已脱离锚定 → 自动加载一页', () => {
    const loadMore = setup()
    loadMore.onScrollOffset(0, true)
    expect(loadMoreHistoryMock).toHaveBeenCalledTimes(1)
    expect(loadMoreHistoryMock).toHaveBeenCalledWith('s1')
  })

  it('阈值边界：≤ 阈值触发、> 阈值不触发', () => {
    const loadMore = setup()
    loadMore.onScrollOffset(TOP_AUTO_LOAD_THRESHOLD_PX, true)
    expect(loadMoreHistoryMock).toHaveBeenCalledTimes(1)
    loadMore.onScrollOffset(TOP_AUTO_LOAD_THRESHOLD_PX + 1, true)
    expect(loadMoreHistoryMock).toHaveBeenCalledTimes(1)
  })

  it('未脱离锚定（贴底 / session 切换回声）不触发', () => {
    const loadMore = setup()
    loadMore.onScrollOffset(0, false)
    expect(loadMoreHistoryMock).not.toHaveBeenCalled()
  })

  it('无更早历史（truncated=false）不触发', () => {
    hasMoreRef.value = false
    const loadMore = setup()
    loadMore.onScrollOffset(0, true)
    expect(loadMoreHistoryMock).not.toHaveBeenCalled()
  })

  it('加载中不重入（同一守卫源），完成后可再次触发', async () => {
    const d = deferred()
    loadMoreHistoryMock.mockReturnValueOnce(d.promise)
    const loadMore = setup()

    loadMore.onScrollOffset(0, true)
    loadMore.onScrollOffset(0, true)
    loadMore.onScrollOffset(10, true)
    expect(loadMoreHistoryMock).toHaveBeenCalledTimes(1)

    d.resolve()
    await d.promise
    await Promise.resolve() // 让 handleLoadMore 的 finally 落地
    loadMore.onScrollOffset(0, true)
    expect(loadMoreHistoryMock).toHaveBeenCalledTimes(2)
  })
})

describe('slowLine（慢网兜底细线，OpenDesign spec §2.2）', () => {
  beforeEach(() => {
    loadMoreHistoryMock.mockReset()
    loadMoreHistoryMock.mockResolvedValue(true)
    hasMoreRef.value = true
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('快载（<150ms 完成）全程不显示细线（零指示防闪烁）', async () => {
    const loadMore = setup()
    await loadMore.handleLoadMore()
    vi.advanceTimersByTime(SLOW_LINE_DELAY_MS + 200)
    expect(loadMore.slowLine.value).toBe(false)
  })

  it('慢载（>150ms 未完成）显示细线；完成后立即复位（160ms 淡出由 CSS 承担）', async () => {
    const d = deferred()
    loadMoreHistoryMock.mockReturnValueOnce(d.promise)
    const loadMore = setup()

    void loadMore.handleLoadMore()
    vi.advanceTimersByTime(SLOW_LINE_DELAY_MS - 1)
    expect(loadMore.slowLine.value).toBe(false)
    vi.advanceTimersByTime(1)
    expect(loadMore.slowLine.value).toBe(true)

    d.resolve()
    await d.promise
    await Promise.resolve() // 让 handleLoadMore 的 finally 落地
    expect(loadMore.slowLine.value).toBe(false)
  })

  it('加载失败同样收敛细线（失败态由 loadMoreError 错误行显形，细线不残留）', async () => {
    loadMoreHistoryMock.mockResolvedValueOnce(false)
    const loadMore = setup()

    void loadMore.handleLoadMore()
    vi.advanceTimersByTime(SLOW_LINE_DELAY_MS + 1)
    expect(loadMore.slowLine.value).toBe(true)

    await Promise.resolve() // 加载 promise 链落地
    await Promise.resolve() // handleLoadMore 的 await nextTick + finally 落地
    expect(loadMore.slowLine.value).toBe(false)
    expect(loadMore.loadMoreError.value).toBe(true)
  })

  it('切 session 复位：延迟落盘的加载不属于新会话（细线 + 未触发定时器一并清）', async () => {
    const d = deferred()
    loadMoreHistoryMock.mockReturnValueOnce(d.promise)
    const sessionId = ref('s1')
    const loadMore = useLoadMoreHistory(() => sessionId.value)

    void loadMore.handleLoadMore()
    vi.advanceTimersByTime(SLOW_LINE_DELAY_MS + 1)
    expect(loadMore.slowLine.value).toBe(true)

    sessionId.value = 's2'
    await nextTick() // watch（pre flush）落地
    expect(loadMore.slowLine.value).toBe(false)

    d.resolve()
    await d.promise
    await Promise.resolve()
  })
})

describe('handleLoadMore（载荷与 isPrepend 生命周期）', () => {
  beforeEach(() => {
    loadMoreHistoryMock.mockReset()
    loadMoreHistoryMock.mockResolvedValue(true)
    hasMoreRef.value = true
  })

  it('加载期间 isPrepend=true（virtua :shift 保位），完成后回落 false', async () => {
    const d = deferred()
    loadMoreHistoryMock.mockReturnValueOnce(d.promise)
    const loadMore = setup()

    loadMore.onScrollOffset(0, true)
    expect(loadMore.isPrepend.value).toBe(true)
    expect(loadMore.loadingMore.value).toBe(true)

    d.resolve()
    await d.promise
    await Promise.resolve()
    expect(loadMore.isPrepend.value).toBe(false)
    expect(loadMore.loadingMore.value).toBe(false)
  })

  it('手动点击（按钮兜底路径）与自动续载共用同一加载通路', async () => {
    const loadMore = setup()
    await loadMore.handleLoadMore()
    expect(loadMoreHistoryMock).toHaveBeenCalledTimes(1)
    expect(loadMoreHistoryMock).toHaveBeenCalledWith('s1')
  })
})
