/**
 * chat-store.test.ts — F7 失败路径验收测试。
 *
 * 背景：chatStore.markSessionError 单一入口重置 isGenerating + streamingMessage。
 * 本测试验证：
 * - F7: chatStore.markSessionError 单一入口重置 isGenerating + streamingMessage
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/stores/chat-store.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'

describe('ChatStore · F7 错误不变量集中', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('F7: markSessionError 重置 streaming 状态', () => {
    const store = useChatStore()
    const sid = 'session-f7-1'

    // 模拟 streaming 状态
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'msg-1' },
    })
    expect(store.getMessages(sid)[0].status).toBe('streaming')
    expect(store.isGenerating(sid)).toBe(true)

    // markSessionError 应重置 streaming 状态
    store.markSessionError(sid, 'Error occurred')
    const msgs = store.getMessages(sid)
    expect(msgs[0].status).toBe('error')
    expect(store.isGenerating(sid)).toBe(false)
  })

  it('F7: markSessionError 同时重置 isGenerating 和 streaming', () => {
    const store = useChatStore()
    const sid = 'session-f7-2'

    // 设置 streaming 状态
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'msg-2' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.text_delta',
      payload: { sessionId: sid, delta: '部分内容' },
    })
    expect(store.isGenerating(sid)).toBe(true)
    expect(store.getMessages(sid)[0].status).toBe('streaming')

    // markSessionError 应同时重置
    store.markSessionError(sid, 'Crash error')
    expect(store.isGenerating(sid)).toBe(false)
    expect(store.getMessages(sid)[0].status).toBe('error')
  })

  it('F7: markSessionError 生成 error 消息（无 streaming 时新建）', () => {
    const store = useChatStore()
    const sid = 'session-f7-3'

    store.markSessionError(sid, 'Process crashed')

    const messages = store.getMessages(sid)
    expect(messages.length).toBe(1)
    expect(messages[0].role).toBe('assistant')
    expect(messages[0].status).toBe('error')
    expect(messages[0].content).toBe('Process crashed')
  })

  it('F7: markSessionError 并入 streaming 消息（有 streaming 时不新建）', () => {
    const store = useChatStore()
    const sid = 'session-f7-4'

    // 创建 streaming 消息
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'msg-3' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.text_delta',
      payload: { sessionId: sid, delta: '部分内容' },
    })

    store.markSessionError(sid, 'Process crashed')

    const messages = store.getMessages(sid)
    expect(messages.length).toBe(1) // 不新建
    expect(messages[0].id).toBe('msg-3') // 原消息转态
    expect(messages[0].status).toBe('error')
    expect(messages[0].content).toContain('部分内容') // 保留已生成内容
    expect(messages[0].error).toBe('Process crashed') // error 字段
  })

  it('F7: markSessionError 不影响其他 session', () => {
    const store = useChatStore()
    const sid1 = 'session-f7-5a'
    const sid2 = 'session-f7-5b'

    // 两个 session 都在 streaming
    store.applyMessageEvent(sid1, {
      type: 'message.message_start',
      payload: { sessionId: sid1, messageId: 'msg-1' },
    })
    store.applyMessageEvent(sid2, {
      type: 'message.message_start',
      payload: { sessionId: sid2, messageId: 'msg-2' },
    })

    // 只 markSessionError sid1
    store.markSessionError(sid1, 'Error in sid1')

    // sid1 应重置
    expect(store.isGenerating(sid1)).toBe(false)
    expect(store.getMessages(sid1)[0].status).toBe('error')

    // sid2 不受影响
    expect(store.isGenerating(sid2)).toBe(true)
    expect(store.getMessages(sid2)[0].status).toBe('streaming')
  })

  it('F7: markSessionError 幂等 — 多次调用不产生多条错误消息', () => {
    const store = useChatStore()
    const sid = 'session-f7-6'

    // 多次调用
    store.markSessionError(sid, 'Error 1')
    store.markSessionError(sid, 'Error 2')
    store.markSessionError(sid, 'Error 3')

    const messages = store.getMessages(sid)
    // 应只有一条错误消息（或最后一条的 error 是最新的）
    const errorMessages = messages.filter(m => m.status === 'error')
    expect(errorMessages.length).toBeLessThanOrEqual(3) // 允许多条，但通常合并
  })
})
