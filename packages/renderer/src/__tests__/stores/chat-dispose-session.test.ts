// @vitest-environment node

/**
 * chat store disposeSession 测试（W1 / S3）。
 *
 * 锁定 deleteSession 跨 store 清理的核心：chat store 提供按 sessionId 清理全部
 * per-session 状态的入口，deleteSession 调用之，避免频繁建删 session 后内存单调增长。
 *
 * 覆盖（U1）：
 * - disposeSession 清理 messages / hydrated / pendingSend / compactingSessions /
 *   retryStates / failedHistory 全部 per-session ref（[u5a] queueStates 分区已退役删除）
 * - disposeSession 清理 streamingTimers 模块级 timer（pendingSend 空窗 timer 已按
 *   ADR-0112 时间平抑红线整体退役，见 core chat store 退役登记）
 *
 * 运行：npx vitest run src/__tests__/stores/chat-dispose-session.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'
import type { Message } from '@taiji/shared'

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
  // fake timers 统一恢复：放用例尾部会在断言失败时跳过恢复 → 向后续用例泄漏 fake timers
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('U1: disposeSession 后 per-session 状态全部清空', () => {
    vi.useFakeTimers()
    const store = useChatStore()
    const sid = 's1'

    // 写入各类 per-session 状态
    store.hydrate(sid, [makeMessage('m1')])
    store.addPendingSend(sid)
    store.setOccupancy(sid, { turn: 'idle', compacting: true, bash: false })
    // retryStates 经 applyMessageEvent 写入（message.auto_retry_start，同 chat-transient-reset 播种形态）
    store.applyMessageEvent(sid, {
      type: 'message.auto_retry_start',
      payload: { sessionId: sid, attempt: 1, maxAttempts: 3 },
    })
    store.markHistoryFailed(sid)
    // changeSetStatuses：key 格式 `${sid}:${messageId}`，disposeSession 按前缀清理（W19 Fix-2）
    store.setChangeSetStatus(sid, 'm1', 'added')

    // 前置断言：状态确实写入了
    expect(store.getMessages(sid)).toHaveLength(1)
    expect(store.isHydrated(sid)).toBe(true)
    expect(store.isActive(sid)).toBe(true) // pendingSend → active
    expect(store.isCompacting(sid)).toBe(true)
    expect(store.getRetryState(sid)).toBeDefined()

    // act
    store.disposeSession(sid)

    // assert：全部 per-session 状态清空
    expect(store.getMessages(sid)).toEqual([])
    expect(store.isHydrated(sid)).toBe(false)
    expect(store.isActive(sid)).toBe(false) // pendingSend 清空 → 不再 active
    expect(store.isCompacting(sid)).toBe(false)
    // auto_retry_start 播种后的清空断言（不 dispose 则恒 defined，与 disposeSession 有因果）
    expect(store.getRetryState(sid)).toBeUndefined()
    // changeSetStatuses 的 `${sid}:` 前缀条目已清理（W19 Fix-2 抽取的
    // deleteChangeSetStatusesFor 挂点）——此处补上原注释承诺的断言
    expect(store.getChangeSetStatus(sid, 'm1')).toBeUndefined()
    // failedHistory 无公开读取器，经行为投影断言：Panel.vue 重试出口判据即
    // `chat.failedHistory.has(sessionId)`，dispose 后为 false = 分区已清
    // （disposeSession 的 setRefs 遍历含 failedHistory，见 core domain/chat/store.ts:1108）
    expect(store.failedHistory.has(sid)).toBe(false)
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
