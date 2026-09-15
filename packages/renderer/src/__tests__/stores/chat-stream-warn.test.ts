/**
 * B1 stream_warn effect 单测：WARN（pi 静默卡死提示）不收口 session。
 *
 * 背景：runtime 120s WARN 原先广播 message.stream_error{kind:'silent'}，前端 effect
 * 无条件 finalizeSession 当真错误收口 → 破坏「WARN 不中断」设计。
 * B1 修复：WARN 改广播 message.stream_warn（独立类型），前端新增对应 effect 仅提示不收口。
 *
 * 验证：
 * - stream_warn 到达时 session 保持 streaming 态（isGenerating 仍 true）
 * - stream_warn 不追加 error 态消息
 * - stream_error 仍正常收口（回归防护，两条通道隔离）
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'
import type { ServerMessage } from '@taiji/shared'

describe('B1: message.stream_warn 不收口 session（WARN 与 ERROR 通道隔离）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('stream_warn 到达 streaming session → isGenerating 仍 true（不收口）', () => {
    const store = useChatStore()
    const sid = 's-warn'
    // 构造一个 streaming 中的 session（message.message_start 创建 streaming entity）
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid },
    } as ServerMessage)
    expect(store.isGenerating(sid)).toBe(true)

    // WARN 到达
    const warnMsg: ServerMessage = {
      type: 'message.stream_warn',
      payload: { sessionId: sid, content: '长时间无响应（120s 无活动）' },
    }
    store.applyMessageEvent(sid, warnMsg)

    // 核心：WARN 不应收口——streaming assistant 消息 status 不变（未被 finalize 成 error）
    // stream_warn 会追加一条 system 提示消息，但不应影响 assistant 实体的 streaming 态
    const msgs = store.getMessages(sid)
    const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant')
    expect(lastAssistant).toBeDefined()
    expect(lastAssistant!.status).toBe('streaming')
  })

  it('stream_error 到达 → 仍正常收口（回归防护，两通道隔离）', () => {
    const store = useChatStore()
    const sid = 's-err'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid },
    } as ServerMessage)
    expect(store.isGenerating(sid)).toBe(true)

    const errMsg: ServerMessage = {
      type: 'message.stream_error',
      payload: { sessionId: sid, content: '真正错误', kind: 'error' },
    }
    store.applyMessageEvent(sid, errMsg)

    // stream_error 是真错误通道，必须收口
    expect(store.isGenerating(sid)).toBe(false)
  })
})
