/**
 * useChat disposeSession 测试（W1 / S3）。
 *
 * 锁定 streamSubscriptions 的取消能力：session 删除时不仅清 chat store 数据，
 * 还要取消 WS 流式订阅（streamSubscriptions 模块级 Map 中的 unsub 函数）。
 *
 * 覆盖（U2）：
 * - send 后 streamSubscriptions 含 sid，disposeSession(sid) 调用 unsub + 从 Map 删除
 * - disposeSession 后 chat store 的 per-session 状态也被清理（调用 chat store disposeSession）
 *
 * 运行：npx vitest run src/__tests__/composables/use-chat-dispose.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { textToSegments } from '@taiji/shared'

// mock chatApi：streamSubscribe 返回可控的 unsubscribe mock
const unsubscribeMock = vi.hoisted(() => vi.fn())
const streamSubscribeMock = vi.hoisted(() => vi.fn(() => unsubscribeMock))
const sendMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))

vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  chat: {
    streamSubscribe: streamSubscribeMock,
    send: sendMock,
    getHistory: vi.fn(() => Promise.resolve([])),
  },
  // w5：useChat 薄包装 import session.writeSegments（写 segments sidecar），mock 补全
  session: {
    writeSegments: vi.fn(() => Promise.resolve()),
  },
}))

import { useChat, resetChatModuleState } from '@/composables/features/chat/useChat'
import { useChatStore } from '@/stores/chat'

describe('useChat disposeSession（W1：取消 streamSubscriptions + 清 chat store）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetChatModuleState()
    vi.clearAllMocks()
  })

  it('U2: disposeSession 调用 unsubscribe 并从 streamSubscriptions 删除 + 清 chat store', async () => {
    const chat = useChat()
    const store = useChatStore()
    const sid = 's1'

    // send 触发 ensureStreamSubscription → streamSubscriptions.set(sid, unsub)
    await chat.send(sid, textToSegments('hello'))

    // 前置：streamSubscribe 被调用，unsub 已存入 Map
    expect(streamSubscribeMock).toHaveBeenCalledWith(sid, expect.any(Function))

    // 写入一些 chat store 状态以便验证清理
    store.hydrate(sid, [{ id: 'm1', role: 'user', content: 'x', status: 'complete', timestamp: 1 }])
    expect(store.isHydrated(sid)).toBe(true)

    // act
    chat.disposeSession(sid)

    // assert：unsub 被调用
    await vi.waitFor(() => {
      expect(unsubscribeMock).toHaveBeenCalledTimes(1)
    })
    // chat store 状态被清理
    expect(store.isHydrated(sid)).toBe(false)
    expect(store.getMessages(sid)).toEqual([])

    // 再次 disposeSession 幂等（unsub 不重复调用）
    chat.disposeSession(sid)
    expect(unsubscribeMock).toHaveBeenCalledTimes(1)
  })
})
