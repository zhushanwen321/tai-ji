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
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

const { loadMoreHistoryMock, hasMoreRef } = vi.hoisted(() => ({
  loadMoreHistoryMock: vi.fn<() => Promise<void>>(),
  hasMoreRef: { value: true },
}))

vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({
    loadMoreHistory: loadMoreHistoryMock,
    hasMoreHistory: () => hasMoreRef.value,
  }),
}))

import { useLoadMoreHistory, TOP_AUTO_LOAD_THRESHOLD_PX } from '../useLoadMoreHistory'

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
    loadMoreHistoryMock.mockResolvedValue(undefined)
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

describe('handleLoadMore（载荷与 isPrepend 生命周期）', () => {
  beforeEach(() => {
    loadMoreHistoryMock.mockReset()
    loadMoreHistoryMock.mockResolvedValue(undefined)
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
