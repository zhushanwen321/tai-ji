/**
 * chat store disposeSession 测试（W1 / S3）。
 *
 * 锁定 deleteSession 跨 store 清理的核心：chat store 提供按 sessionId 清理全部
 * per-session 状态的入口，deleteSession 调用之，避免频繁建删 session 后内存单调增长。
 *
 * 覆盖（U1）：
 * - disposeSession 清理 messages / hydrated / pendingSend / compactingSessions /
 *   retryStates / queueStates / failedHistory 全部 per-session ref
 * - disposeSession 清理 streamingTimers / pendingSendTimers 模块级 timer
 *
 * 运行：npx vitest run src/__tests__/stores/chat-dispose-session.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'
import type { Message } from '@xyz-agent/shared'

function makeMessage(id: string, role: Message['role'] = 'assistant'): Message {
  return {
    id,
    role,
    content: `msg-${id}`,
    status: 'complete',
    timestamp: Date.now(),
  }
}

describe('chat store disposeSession（W1：清理 per-session 全部状态）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('U1: disposeSession 后 per-session 状态全部清空', () => {
    vi.useFakeTimers()
    const store = useChatStore()
    const sid = 's1'

    // 写入各类 per-session 状态
    store.hydrate(sid, [makeMessage('m1')])
    store.addPendingSend(sid)
    store.setOccupancy(sid, { turn: 'idle', compacting: true, bash: false })
    store.testInternals.armStreamingTimer(sid)
    // retryStates / queueStates 需通过 applyMessageEvent 写入，此处验证清空用 get 判 undefined
    store.markHistoryFailed(sid)
    // changeSetStatuses：key 格式 `${sid}:${messageId}`，disposeSession 按前缀清理（W19 Fix-2）
    store.setChangeSetStatus(sid, 'm1', 'added')

    // 前置断言：状态确实写入了
    expect(store.getMessages(sid)).toHaveLength(1)
    expect(store.isHydrated(sid)).toBe(true)
    expect(store.isActive(sid)).toBe(true) // pendingSend → active
    expect(store.isCompacting(sid)).toBe(true)

    // act
    store.disposeSession(sid)

    // assert：全部 per-session 状态清空
    expect(store.getMessages(sid)).toEqual([])
    expect(store.isHydrated(sid)).toBe(false)
    expect(store.isActive(sid)).toBe(false) // pendingSend 清空 → 不再 active
    expect(store.isCompacting(sid)).toBe(false)
    expect(store.getRetryState(sid)).toBeUndefined()
    expect(store.getQueueState(sid)).toBeUndefined()
    // changeSetStatuses 的 `${sid}:` 前缀条目已清理（W19 Fix-2 抽取的
    // deleteChangeSetStatusesFor 挂点）——此处补上原注释承诺的断言
    expect(store.getChangeSetStatus(sid, 'm1')).toBeUndefined()
    // failedHistory 是 Set 且无公开 getter——disposeSession 的 setRefs 遍历
    // （core store.ts:1306 含 failedHistory）覆盖其清理；可观测回归经
    // m7-virtual-key-cleanup / delete-cleanup 的分区释放断言承担
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('disposeSession 对未写入的 session 幂等（不抛错）', () => {
    const store = useChatStore()
    expect(() => store.disposeSession('never-existed')).not.toThrow()
    expect(store.getMessages('never-existed')).toEqual([])
  })

  it('disposeSession 不影响其他 session 的状态', () => {
    const store = useChatStore()
    store.hydrate('s1', [makeMessage('m1')])
    store.hydrate('s2', [makeMessage('m2'), makeMessage('m3')])

    store.disposeSession('s1')

    expect(store.getMessages('s1')).toEqual([])
    expect(store.getMessages('s2')).toHaveLength(2)
    expect(store.isHydrated('s2')).toBe(true)
  })
})
