/**
 * [u6-paging-protocol] 「加载更早」游标翻页测试（D4 中期）。
 *
 * 原 W4 getFullHistory 全量通路已退役（游标翻页完全替代）。策略：mock WS RPC
 * （chat.getHistory 带 cursor），验证：
 * - 点击加载更早 → 调用 session.history RPC（cursor = 分区最旧消息的文件侧身份）
 * - 返回的游标页合并到消息列表头部（P-paging：顺序正确 + 无重复）
 * - 空页（翻页到头 / cursor 未命中）分区不变 + 窗口收敛
 * - RPC 失败不破坏现有消息
 * - [RD-1#4] RPC 失败 → loadMoreError 态 + truncated 窗口不变（显形可重试，非「已到头」）
 * - useLoadMoreHistory 交互态：isPrepend 顶部插入信号翻转（`<Virtualizer :shift>`
 *   视口锚定的驱动源——prepend 后视口不跳变）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/load-more-history.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, ref } from 'vue'
import type { Message } from '@taiji/shared'

// mock @/api 的 chat domain（getHistory 游标参数是 [u6] 新增）
vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return {
    ...actual,
    chat: {
      ...actual.chat,
      getHistory: vi.fn(),
    },
  }
})

import { useChatStore } from '@/stores/chat'
import { useChat, resetChatModuleState } from '@/composables/features/chat/useChat'
import { useLoadMoreHistory } from '@/composables/panel/useLoadMoreHistory'
import { chat } from '@/api'

function makeMessage(id: string, content: string, piEntryId?: string): Message {
  return piEntryId !== undefined
    ? { id, piEntryId, role: 'user', content, status: 'complete', timestamp: Date.now() }
    : { id, role: 'user', content, status: 'complete', timestamp: Date.now() }
}

function windowReply(messages: Message[], opts?: { truncated?: boolean; loadedTurns?: number; totalTurnsEstimate?: number }) {
  return {
    messages,
    truncated: opts?.truncated ?? false,
    loadedTurns: opts?.loadedTurns ?? messages.length,
    totalTurnsEstimate: opts?.totalTurnsEstimate ?? messages.length,
  }
}

describe('「加载更早」游标翻页（[u6] D4 中期）', () => {
  let loadMoreHistory: (sessionId: string) => Promise<void>

  beforeEach(() => {
    setActivePinia(createPinia())
    resetChatModuleState()
    loadMoreHistory = useChat().loadMoreHistory
    vi.mocked(chat.getHistory).mockReset()
  })

  it('游标 = 分区最旧消息的 piEntryId；页消息前插且顺序正确（P-paging）', async () => {
    const store = useChatStore()
    const sid = 's1'

    // 当前分区 = 最近窗口（hydrate 注入，最旧 m8 带 piEntryId）
    store.hydrate(sid, [
      makeMessage('m8', 'msg-8', 'entry-8'),
      makeMessage('m9', 'msg-9', 'entry-9'),
      makeMessage('m10', 'msg-10', 'entry-10'),
    ], { truncated: true, loadedTurns: 3, totalTurnsEstimate: 6 })

    // 游标页（runtime 返回锚点 entry-8 之前的最近窗口）
    vi.mocked(chat.getHistory).mockResolvedValue(windowReply([
      makeMessage('m6', 'msg-6', 'entry-6'),
      makeMessage('m7', 'msg-7', 'entry-7'),
    ], { truncated: false, loadedTurns: 2, totalTurnsEstimate: 6 }))

    await loadMoreHistory(sid)

    // session.history 带 cursor（分区最旧消息的 piEntryId）
    expect(chat.getHistory).toHaveBeenCalledWith(sid, { cursor: 'entry-8' })

    // P-paging：页前插在头部，分区顺序正确（页 + 原窗口），无重复
    const messages = store.getMessages(sid)
    expect(messages.map((m) => m.id)).toEqual(['m6', 'm7', 'm8', 'm9', 'm10'])
    const ids = messages.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)

    // 窗口状态：翻页到头收敛（truncated=false → 顶部条消失）+ loadedTurns 累计
    expect(store.getHistoryWindow(sid)).toEqual({ truncated: false, loadedTurns: 5, totalTurnsEstimate: 6 })
  })

  it('游标回落 id（消息无 piEntryId 时取 id——对称取值 piEntryId ?? id）', async () => {
    const store = useChatStore()
    const sid = 's2'
    store.hydrate(sid, [makeMessage('m1', 'msg-1')], { truncated: true, loadedTurns: 1, totalTurnsEstimate: 2 })

    vi.mocked(chat.getHistory).mockResolvedValue(windowReply([]))
    await loadMoreHistory(sid)

    expect(chat.getHistory).toHaveBeenCalledWith(sid, { cursor: 'm1' })
  })

  it('空页（cursor 未命中 / 翻页到头）：分区不变 + 窗口收敛，不报错', async () => {
    const store = useChatStore()
    const sid = 's3'
    store.hydrate(sid, [makeMessage('m1', 'msg-1', 'entry-1')], { truncated: true, loadedTurns: 1, totalTurnsEstimate: 1 })

    vi.mocked(chat.getHistory).mockResolvedValue(windowReply([], { truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 }))
    await loadMoreHistory(sid)

    expect(store.getMessages(sid)).toHaveLength(1)
    expect(store.getMessages(sid)[0]!.id).toBe('m1')
    expect(store.getHistoryWindow(sid)?.truncated).toBe(false)
  })

  it('RPC 失败时不破坏现有消息', async () => {
    const store = useChatStore()
    const sid = 's4'
    store.hydrate(sid, [makeMessage('m1', 'msg-1', 'entry-1')], { truncated: true, loadedTurns: 1, totalTurnsEstimate: 1 })

    vi.mocked(chat.getHistory).mockRejectedValue(new Error('network error'))

    await expect(loadMoreHistory(sid)).resolves.not.toThrow()

    // 现有消息不受影响
    expect(store.getMessages(sid)).toHaveLength(1)
    expect(store.getMessages(sid)[0]!.id).toBe('m1')
  })

  it('[RD-1#4] loadMoreHistory 返回布尔：成功 true / RPC 失败 false（失败显形的调用契约）', async () => {
    const store = useChatStore()
    const okSid = 's4b-ok'
    store.hydrate(okSid, [makeMessage('m1', 'msg-1', 'entry-1')], { truncated: true, loadedTurns: 1, totalTurnsEstimate: 2 })
    vi.mocked(chat.getHistory).mockResolvedValue(windowReply([makeMessage('m0', 'msg-0', 'entry-0')], { truncated: false, loadedTurns: 1, totalTurnsEstimate: 2 }))
    await expect(loadMoreHistory(okSid)).resolves.toBe(true)

    const failSid = 's4b-fail'
    store.hydrate(failSid, [makeMessage('m1', 'msg-1', 'entry-1')], { truncated: true, loadedTurns: 1, totalTurnsEstimate: 1 })
    vi.mocked(chat.getHistory).mockRejectedValue(new Error('network error'))
    await expect(loadMoreHistory(failSid)).resolves.toBe(false)
  })
})

describe('useLoadMoreHistory 交互态（P-paging 视口锚定信号）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetChatModuleState()
    vi.mocked(chat.getHistory).mockReset()
  })

  it('handleLoadMore 期间 isPrepend=true（Virtualizer :shift 保位窗口），完成后翻 false', async () => {
    const store = useChatStore()
    const sid = 's5'
    store.hydrate(sid, [makeMessage('m2', 'msg-2', 'entry-2')], { truncated: true, loadedTurns: 1, totalTurnsEstimate: 2 })

    let resolvePage!: (v: unknown) => void
    vi.mocked(chat.getHistory).mockImplementation(() => new Promise((resolve) => { resolvePage = resolve }))

    const { loadingMore, showLoadMore, handleLoadMore, isPrepend } = useLoadMoreHistory(() => sid)
    expect(showLoadMore.value).toBe(true)

    const pending = handleLoadMore()
    // 加载中：isPrepend 前置 true（virtua shift 保位窗口开启）+ 按钮态
    expect(isPrepend.value).toBe(true)
    expect(loadingMore.value).toBe(true)

    resolvePage(windowReply([makeMessage('m1', 'msg-1', 'entry-1')], { truncated: false, loadedTurns: 1, totalTurnsEstimate: 2 }))
    await pending

    // 完成后信号复位（virtua 已按 shift=true 处理 data length change）
    expect(isPrepend.value).toBe(false)
    expect(loadingMore.value).toBe(false)
    // 翻页到头 → showLoadMore 收敛
    expect(showLoadMore.value).toBe(false)
  })

  it('showLoadMore=false（truncated=false）时 handleLoadMore 短路（不发请求）', async () => {
    const store = useChatStore()
    const sid = 's6'
    store.hydrate(sid, [makeMessage('m1', 'msg-1', 'entry-1')], { truncated: false, loadedTurns: 1, totalTurnsEstimate: 1 })

    const { handleLoadMore, isPrepend } = useLoadMoreHistory(() => sid)
    await handleLoadMore()
    expect(chat.getHistory).not.toHaveBeenCalled()
    expect(isPrepend.value).toBe(false)
  })

  it('[RD-1#4] RPC 失败 → loadMoreError=true + truncated 窗口不变（显形可重试，非「已到头」）', async () => {
    const store = useChatStore()
    const sid = 's7'
    store.hydrate(sid, [makeMessage('m1', 'msg-1', 'entry-1')], { truncated: true, loadedTurns: 1, totalTurnsEstimate: 2 })
    vi.mocked(chat.getHistory).mockRejectedValue(new Error('network error'))

    const { loadingMore, showLoadMore, handleLoadMore, loadMoreError } = useLoadMoreHistory(() => sid)
    expect(loadMoreError.value).toBe(false)

    await handleLoadMore()

    // 失败态显形（顶部条据此渲染可重试错误行）
    expect(loadMoreError.value).toBe(true)
    // loading 复位（按钮可再点 = 可重试）
    expect(loadingMore.value).toBe(false)
    // 关键：truncated 窗口不变——失败不得被 UI 误读成「已到头」
    expect(showLoadMore.value).toBe(true)
    expect(store.getHistoryWindow(sid)).toEqual({ truncated: true, loadedTurns: 1, totalTurnsEstimate: 2 })
    // 分区未被破坏
    expect(store.getMessages(sid)).toHaveLength(1)
  })

  it('[RD-1#4] 重试成功 → loadMoreError 清除', async () => {
    const store = useChatStore()
    const sid = 's8'
    store.hydrate(sid, [makeMessage('m1', 'msg-1', 'entry-1')], { truncated: true, loadedTurns: 1, totalTurnsEstimate: 2 })
    vi.mocked(chat.getHistory).mockRejectedValueOnce(new Error('network error'))

    const { handleLoadMore, loadMoreError } = useLoadMoreHistory(() => sid)
    await handleLoadMore()
    expect(loadMoreError.value).toBe(true)

    vi.mocked(chat.getHistory).mockResolvedValue(
      windowReply([makeMessage('m0', 'msg-0', 'entry-0')], { truncated: false, loadedTurns: 1, totalTurnsEstimate: 2 }),
    )
    await handleLoadMore()
    expect(loadMoreError.value).toBe(false)
    expect(store.getMessages(sid).map((m) => m.id)).toEqual(['m0', 'm1'])
  })

  it('[RD-1#4] 切换 session → loadMoreError 复位（失败态不跨 session 残留）', async () => {
    const store = useChatStore()
    const sid = ref('s9')
    store.hydrate(sid.value, [makeMessage('m1', 'msg-1', 'entry-1')], { truncated: true, loadedTurns: 1, totalTurnsEstimate: 2 })
    vi.mocked(chat.getHistory).mockRejectedValue(new Error('network error'))

    const { handleLoadMore, loadMoreError } = useLoadMoreHistory(() => sid.value)
    await handleLoadMore()
    expect(loadMoreError.value).toBe(true)

    sid.value = 's10'
    await nextTick()
    expect(loadMoreError.value).toBe(false)
  })
})
