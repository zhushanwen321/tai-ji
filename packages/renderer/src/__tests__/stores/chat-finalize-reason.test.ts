/**
 * fix-state-tearing 收口契约套件（finalizeSession reason→终态映射 + sealed guard 防污染；
 * 原 chat-sealed-guard.test.ts 已并入本文件——同一契约域、零 mock 差异）。
 *
 * finalizeSession reason→终态映射（D-011 诚实态 + D-013 errorText 合并）：
 * 锁定 7 种 FinalizeReason 各应产出正确的 message.status + toolCall.status + content 合并。
 *
 * 覆盖：
 * - normal/aborted → message:complete, toolCall:end_not_received
 * - error/stream_error/timeout/disconnect/restart → message:error, toolCall:error
 * - errorText 合并到 streaming assistant content（D-013）
 * - 非 streaming entity 不受影响
 * - running toolCall 级联终态（D-011 诚实态）
 * - 非 running toolCall 不被修改
 *
 * sealed guard（D-010）：finalizeSession 后晚到 delta/start/update 幂等丢弃；
 * 特殊边界 tool_call_end 不 sealed——允许迟到 end 覆盖 end_not_received→completed。
 *
 * 运行：npx vitest run src/__tests__/stores/chat-finalize-reason.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'
import type { Message } from '@xyz-agent/shared'

function seedStreamingAssistant(sid: string, overrides: Partial<Message> = {}): Message {
  return {
    id: 'a1',
    role: 'assistant',
    content: '已生成内容',
    status: 'streaming',
    timestamp: Date.now(),
    ...overrides,
  }
}

describe('finalizeSession reason→终态映射', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('normal: streaming assistant → complete，running toolCall → end_not_received', () => {
    const store = useChatStore()
    const sid = 's-normal'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.tool_call_start',
      payload: { sessionId: sid, entry: { type: 'toolCall', toolCallId: 'tc1', toolName: 'bash', arguments: {}, timestamp: new Date(0).toISOString() } },
    })
    store.finalizeSession(sid, 'normal')
    const msgs = store.getMessages(sid)
    expect(msgs[0].status).toBe('complete')
    expect(msgs[0].toolCalls![0].status).toBe('end_not_received')
  })

  it('aborted: streaming assistant → complete，running toolCall → end_not_received', () => {
    const store = useChatStore()
    const sid = 's-aborted'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.tool_call_start',
      payload: { sessionId: sid, entry: { type: 'toolCall', toolCallId: 'tc1', toolName: 'bash', arguments: {}, timestamp: new Date(0).toISOString() } },
    })
    store.finalizeSession(sid, 'aborted')
    const msgs = store.getMessages(sid)
    expect(msgs[0].status).toBe('complete')
    expect(msgs[0].toolCalls![0].status).toBe('end_not_received')
  })

  it('error: streaming assistant → error，running toolCall → error', () => {
    const store = useChatStore()
    const sid = 's-error'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.tool_call_start',
      payload: { sessionId: sid, entry: { type: 'toolCall', toolCallId: 'tc1', toolName: 'bash', arguments: {}, timestamp: new Date(0).toISOString() } },
    })
    store.finalizeSession(sid, 'error', '进程崩溃')
    const msgs = store.getMessages(sid)
    expect(msgs[0].status).toBe('error')
    expect(msgs[0].toolCalls![0].status).toBe('error')
  })

  it('stream_error: streaming assistant → error，running toolCall → error', () => {
    const store = useChatStore()
    const sid = 's-stream-err'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.tool_call_start',
      payload: { sessionId: sid, entry: { type: 'toolCall', toolCallId: 'tc1', toolName: 'bash', arguments: {}, timestamp: new Date(0).toISOString() } },
    })
    store.finalizeSession(sid, 'stream_error', '流错误')
    const msgs = store.getMessages(sid)
    expect(msgs[0].status).toBe('error')
    expect(msgs[0].toolCalls![0].status).toBe('error')
  })

  it('timeout: streaming assistant → error，running toolCall → error', () => {
    const store = useChatStore()
    const sid = 's-timeout'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.finalizeSession(sid, 'timeout')
    const msgs = store.getMessages(sid)
    expect(msgs[0].status).toBe('error')
  })

  it('disconnect: streaming assistant → error，running toolCall → error', () => {
    const store = useChatStore()
    const sid = 's-disconnect'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.finalizeSession(sid, 'disconnect')
    const msgs = store.getMessages(sid)
    expect(msgs[0].status).toBe('error')
  })

  it('restart: streaming assistant → error（runtime 重启收口）', () => {
    const store = useChatStore()
    const sid = 's-restart'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.finalizeSession(sid, 'restart')
    const msgs = store.getMessages(sid)
    expect(msgs[0].status).toBe('error')
  })

  it('errorText 写 msg.error 字段（D-013 双通道，content 不动）', () => {
    const store = useChatStore()
    const sid = 's-errtext'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.text_delta',
      payload: { sessionId: sid, delta: '部分回答' },
    })
    store.finalizeSession(sid, 'error', '[错误] 连接断开')
    const msgs = store.getMessages(sid)
    expect(msgs[0].content).toContain('部分回答')
    // [M2 error-visibility] 追加形态双通道：errorText 写 msg.error，content 保持正文
    expect(msgs[0].error).toBe('[错误] 连接断开')
    expect(msgs[0].content).not.toContain('[错误] 连接断开')
  })

  it('errorText 不合并到非 assistant 消息', () => {
    const store = useChatStore()
    const sid = 's-no-merge'
    store.appendUser(sid, '用户提问')
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.finalizeSession(sid, 'error', '错误文本')
    const msgs = store.getMessages(sid)
    expect(msgs[0].role).toBe('user')
    expect(msgs[0].content).toBe('用户提问') // user 消息不受 errorText 影响
  })

  it('非 streaming 的历史 assistant 不受 finalizeSession 影响', () => {
    const store = useChatStore()
    const sid = 's-historical'
    // 注入一条已 complete 的历史 assistant
    store.hydrate(sid, [
      { id: 'old', role: 'assistant', content: '历史', status: 'complete', timestamp: 1 },
    ])
    store.finalizeSession(sid, 'error', '新错误')
    const msgs = store.getMessages(sid)
    expect(msgs[0].status).toBe('complete') // 不回写
    expect(msgs[0].content).toBe('历史') // 不合并 errorText
  })

  it('已 completed 的 toolCall 不被 finalizeSession 修改', () => {
    const store = useChatStore()
    const sid = 's-completed-tc'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.tool_call_start',
      payload: { sessionId: sid, entry: { type: 'toolCall', toolCallId: 'tc1', toolName: 'bash', arguments: {}, timestamp: new Date(0).toISOString() } },
    })
    // 正常结束 toolCall
    store.applyMessageEvent(sid, {
      type: 'message.tool_call_end',
      payload: { sessionId: sid, entry: { type: 'message', parentId: null, timestamp: new Date(0).toISOString(), message: { role: 'toolResult', toolCallId: 'tc1', content: [{ type: 'text', text: 'done' }], isError: false, timestamp: 0 } } },
    })
    expect(store.getMessages(sid)[0].toolCalls![0].status).toBe('completed')
    // finalizeSession 不应回写已 completed 的 toolCall
    store.finalizeSession(sid, 'timeout')
    expect(store.getMessages(sid)[0].toolCalls![0].status).toBe('completed')
  })
})

describe('sealed guard（D-010：finalizeSession 后晚到事件幂等丢弃）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('message.complete 后迟到 text_delta 被丢弃（content 不变）', () => {
    const store = useChatStore()
    const sid = 's1'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.text_delta',
      payload: { sessionId: sid, delta: '正常内容' },
    })
    // 收口
    store.applyMessageEvent(sid, {
      type: 'message.complete',
      payload: { sessionId: sid, stopReason: 'end_turn' },
    })
    const contentBefore = store.getMessages(sid)[0].content
    // 晚到 delta
    store.applyMessageEvent(sid, {
      type: 'message.text_delta',
      payload: { sessionId: sid, delta: '迟到内容' },
    })
    expect(store.getMessages(sid)[0].content).toBe(contentBefore)
  })

  it('message.complete 后迟到 thinking_delta 被丢弃', () => {
    const store = useChatStore()
    const sid = 's2'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.thinking_start',
      payload: { sessionId: sid, thinkingId: 'th1' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.thinking_delta',
      payload: { sessionId: sid, delta: '正常思考' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.complete',
      payload: { sessionId: sid, stopReason: 'end_turn' },
    })
    const thinkingBefore = store.getMessages(sid)[0].thinking![0].content
    // 晚到 thinking_delta
    store.applyMessageEvent(sid, {
      type: 'message.thinking_delta',
      payload: { sessionId: sid, delta: '迟到思考' },
    })
    expect(store.getMessages(sid)[0].thinking![0].content).toBe(thinkingBefore)
  })

  it('message.complete 后迟到 tool_call_start 被丢弃（不新增 toolCall）', () => {
    const store = useChatStore()
    const sid = 's3'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.tool_call_start',
      payload: { sessionId: sid, entry: { type: 'toolCall', toolCallId: 'tc1', toolName: 'bash', arguments: {}, timestamp: new Date(0).toISOString() } },
    })
    store.applyMessageEvent(sid, {
      type: 'message.complete',
      payload: { sessionId: sid, stopReason: 'end_turn' },
    })
    const tcCount = store.getMessages(sid)[0].toolCalls!.length
    expect(tcCount).toBe(1)
    // 晚到 tool_call_start
    store.applyMessageEvent(sid, {
      type: 'message.tool_call_start',
      payload: { sessionId: sid, entry: { type: 'toolCall', toolCallId: 'tc-late', toolName: 'read', arguments: {}, timestamp: new Date(0).toISOString() } },
    })
    expect(store.getMessages(sid)[0].toolCalls!.length).toBe(1) // 不新增
  })

  it('message.complete 后迟到 tool_call_update 被丢弃', () => {
    const store = useChatStore()
    const sid = 's4'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.tool_call_start',
      payload: { sessionId: sid, entry: { type: 'toolCall', toolCallId: 'tc1', toolName: 'bash', arguments: {}, timestamp: new Date(0).toISOString() } },
    })
    store.applyMessageEvent(sid, {
      type: 'message.complete',
      payload: { sessionId: sid, stopReason: 'end_turn' },
    })
    // 晚到 tool_call_update
    store.applyMessageEvent(sid, {
      type: 'message.tool_call_update',
      payload: { sessionId: sid, toolCallId: 'tc1', detail: '进度' },
    })
    // end_not_received 收口态不被 update 覆盖（update handler sealed）
    expect(store.getMessages(sid)[0].toolCalls![0].status).toBe('end_not_received')
  })

  it('message.error 后迟到 text_delta 被丢弃', () => {
    const store = useChatStore()
    const sid = 's5'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.text_delta',
      payload: { sessionId: sid, delta: '部分' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.error',
      payload: { sessionId: sid, message: '崩溃' },
    })
    const contentBefore = store.getMessages(sid)[0].content
    // 晚到 delta
    store.applyMessageEvent(sid, {
      type: 'message.text_delta',
      payload: { sessionId: sid, delta: '迟到' },
    })
    expect(store.getMessages(sid)[0].content).toBe(contentBefore)
  })

  it('message.stream_error 后迟到 text_delta 被丢弃', () => {
    const store = useChatStore()
    const sid = 's6'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.text_delta',
      payload: { sessionId: sid, delta: '部分' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.stream_error',
      payload: { sessionId: sid, content: '流中断' },
    })
    const contentBefore = store.getMessages(sid)[0].content
    store.applyMessageEvent(sid, {
      type: 'message.text_delta',
      payload: { sessionId: sid, delta: '迟到' },
    })
    expect(store.getMessages(sid)[0].content).toBe(contentBefore)
  })

  it('tool_call_end 不 sealed：complete 后迟到 tool_call_end 可覆盖 end_not_received→completed', () => {
    const store = useChatStore()
    const sid = 's7'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.tool_call_start',
      payload: { sessionId: sid, entry: { type: 'toolCall', toolCallId: 'tc1', toolName: 'bash', arguments: {}, timestamp: new Date(0).toISOString() } },
    })
    // complete 收口：running toolCall → end_not_received
    store.applyMessageEvent(sid, {
      type: 'message.complete',
      payload: { sessionId: sid, stopReason: 'end_turn' },
    })
    expect(store.getMessages(sid)[0].toolCalls![0].status).toBe('end_not_received')
    // 迟到的真实 tool_call_end（D-010 边界：不 sealed，允许覆盖）
    store.applyMessageEvent(sid, {
      type: 'message.tool_call_end',
      payload: {
        sessionId: sid,
        // [w21] toolResult message entry 形态
        entry: {
          type: 'message',
          parentId: null,
          timestamp: new Date(0).toISOString(),
          message: { role: 'toolResult', toolCallId: 'tc1', content: [{ type: 'text', text: '实际输出' }], isError: false, timestamp: 0 },
        },
      },
    })
    expect(store.getMessages(sid)[0].toolCalls![0].status).toBe('completed')
    expect(store.getMessages(sid)[0].toolCalls![0].output).toBe('实际输出')
  })
})
