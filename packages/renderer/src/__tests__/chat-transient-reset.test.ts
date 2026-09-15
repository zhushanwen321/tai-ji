/**
 * Chat store 瞬态状态收口回归测试（W3）。
 *
 * 锁定 W3 改动：断连 / runtime 重启等异常路径下，chat store 的全部瞬态状态
 * （streaming + compacting + retry + queue + pendingSend）应由一个统一收口 helper
 * （resetTransientStates）一次性清理，避免后台 session 的 compaction 指示位、
 * 重试指示位、队列态在断连后永久残留（UI 卡「压缩中 / 重试中」）。
 *
 * 当前实现问题：finalizeAllStreaming 只收 streaming 实体，不收 compacting /
 * retry / queue。断连后这些态会一直挂着，直到下一次相关事件到达才清——
 * 但断连意味着不会再有事件到达，于是永久残留。
 *
 * 预期（W3 后）：finalizeAllStreaming 内部调用 resetTransientStates 全收口，
 * 或直接扩展为清理 compacting / retry / queue。以下断言在 W3 未实现前应全部红灯。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/chat-transient-reset.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'

describe('chat store 瞬态状态收口（W3：finalizeAllStreaming 应全收口）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('断连时 finalizeAllStreaming 清理 compactingSessions（不只 streaming）', () => {
    const store = useChatStore()
    const sid = 's-compacting'

    // 把 session 标为「压缩中」（session.compacting 驱动）
    store.setOccupancy(sid, { turn: 'idle', compacting: true, bash: false })
    expect(store.isCompacting(sid)).toBe(true)

    // 模拟 runtime 重启 / 断连：useConnection 会调 finalizeAllStreaming('restart')
    // W3：finalizeAllStreaming 应同时清掉 compacting（当前实现不清，红灯预期）
    store.finalizeAllStreaming('restart')

    // 关键断言：断连后 compacting 态应被清，否则 UI 永久卡「压缩中」
    expect(store.isCompacting(sid)).toBe(false)
  })

  it('断连时 finalizeAllStreaming 清理 retryStates', () => {
    const store = useChatStore()
    const sid = 's-retry'

    // 把 session 标为「自动重试中」（message.auto_retry_start 驱动）
    store.applyMessageEvent(sid, {
      type: 'message.auto_retry_start',
      payload: { sessionId: sid, attempt: 1, maxAttempts: 3 },
    })
    expect(store.getRetryState(sid)).toBeDefined()
    expect(store.getRetryState(sid)?.attempt).toBe(1)

    // 模拟断连：finalizeAllStreaming('disconnect')
    // W3：应清掉 retryStates（当前实现不清，红灯预期）
    store.finalizeAllStreaming('disconnect')

    // 关键断言：断连后重试指示位应被清
    expect(store.getRetryState(sid)).toBeUndefined()
  })

  it('断连时 finalizeAllStreaming 清理 queueStates', () => {
    const store = useChatStore()
    const sid = 's-queue'

    // 把 session 标为「队列有内容」（message.queue_update 驱动）
    store.applyMessageEvent(sid, {
      type: 'message.queue_update',
      payload: { sessionId: sid, steering: ['补一条'] },
    })
    expect(store.getQueueState(sid)).toBeDefined()
    expect(store.getQueueState(sid)?.steering).toEqual(['补一条'])

    // 模拟断连：finalizeAllStreaming('disconnect')
    // W3：应清掉 queueStates（当前实现不清，红灯预期）
    store.finalizeAllStreaming('disconnect')

    // 关键断言：断连后队列态应被清
    expect(store.getQueueState(sid)).toBeUndefined()
  })

  it('正常 message.complete 不清 compacting（只有 finalizeAllStreaming 全收口）', () => {
    const store = useChatStore()
    const sid = 's-normal'

    // session 正在压缩 + 一条 streaming 消息
    store.setOccupancy(sid, { turn: 'idle', compacting: true, bash: false })
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })

    // 正常收尾：message.complete 收口 streaming 实体
    store.applyMessageEvent(sid, {
      type: 'message.complete',
      payload: { sessionId: sid, stopReason: 'end_turn' },
    })

    // 关键：message.complete 只收 streaming 实体，不应顺手清 compacting
    // （compaction 是独立的 session 级状态，由 session.compacted 事件清，不能被消息收尾误清）
    expect(store.isCompacting(sid)).toBe(true)
    expect(store.isGenerating(sid)).toBe(false)
  })

  it('resetTransientStates helper 存在并清理全部瞬态', () => {
    const store = useChatStore()
    const sid = 's-reset'

    // 置满所有瞬态：streaming + compacting + retry + queue + pendingSend
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.setOccupancy(sid, { turn: 'idle', compacting: true, bash: false })
    store.applyMessageEvent(sid, {
      type: 'message.auto_retry_start',
      payload: { sessionId: sid, attempt: 1 },
    })
    store.applyMessageEvent(sid, {
      type: 'message.queue_update',
      payload: { sessionId: sid, steering: ['x'] },
    })
    store.addPendingSend(sid)

    expect(store.isGenerating(sid)).toBe(true)
    expect(store.isCompacting(sid)).toBe(true)
    expect(store.getRetryState(sid)).toBeDefined()
    expect(store.getQueueState(sid)).toBeDefined()
    expect(store.isActive(sid)).toBe(true)

    // W3：调用统一收口 helper（resetTransientStates 已在 store API 暴露）
    store.resetTransientStates(sid)

    // 关键：全部瞬态一次性清零
    expect(store.isCompacting(sid)).toBe(false)
    expect(store.getRetryState(sid)).toBeUndefined()
    expect(store.getQueueState(sid)).toBeUndefined()
  })
})
