// @vitest-environment node
/**
 * chat store 单文件多源合并（round5-d 分区 4 簇 4-8 的 node 环境子集）。
 *
 * 为什么单文件：vitest 按测试文件隔离模块图——本簇 4 个 node 环境文件共同装载
 * vue / shared / extension-protocol / zh-CN locale / core chat domain 等重模块，
 * 单文件共享一份装载；拆文件会让每个文件各付一次全树装载（每份秒级 CPU）。
 *
 * 来源文件（describe/it 块原样搬运，测试名零改动；四文件全零 vi.mock、
 * 全部 beforeEach/afterEach 原本就在 describe 节内，无顶层 hook 冲突）：
 *  - chat-finalize-reason.test.ts（finalizeSession reason→终态映射 + sealed guard，主体）
 *  - chat-isgenerating-scan.test.ts（isGenerating 派生 scan + finalizeAllStreaming）
 *  - chat-message-effects-bash.test.ts（bashStart/bashResult effect）
 *  - chat-dispose-session.test.ts（disposeSession per-session 清理）
 *
 * 环境注：同簇的 btw-replay.test.ts 与 chat-interrupted-window.test.ts 为
 * happy-dom（默认）环境，与 node 异类，不并入（保持原文件原样）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/stores/chat-finalize-reason.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'
import { getExecutingBash } from '@taiji/core'
import type { Message, ServerMessage } from '@taiji/shared'

// ══════════ 主体：原 chat-finalize-reason.test.ts 全部 ══════════

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

  // [ADR-0122] 原 timeout 映射用例随 pendingSend 30s 空窗 timer 退役删除（FinalizeReason 已无该成员）。

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

  it('restart: streaming assistant → error（runtime 重启收尾）', () => {
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
    store.finalizeSession(sid, 'disconnect')
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
    // 收尾
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
    // end_not_received 收尾态不被 update 覆盖（update handler sealed）
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
    // complete 收尾：running toolCall → end_not_received
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

// ══════════ 来源：chat-isgenerating-scan.test.ts（isGenerating 派生 scan + finalizeAllStreaming） ══════════

describe('isGenerating 派生 scan（D-005）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('空 session（无消息）isGenerating=false', () => {
    const store = useChatStore()
    expect(store.isGenerating('empty')).toBe(false)
  })

  it('有 streaming assistant → isGenerating=true', () => {
    const store = useChatStore()
    const sid = 's1'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    expect(store.isGenerating(sid)).toBe(true)
  })

  it('assistant complete 后 isGenerating=false', () => {
    const store = useChatStore()
    const sid = 's2'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    expect(store.isGenerating(sid)).toBe(true)
    store.applyMessageEvent(sid, {
      type: 'message.complete',
      payload: { sessionId: sid, stopReason: 'end_turn' },
    })
    expect(store.isGenerating(sid)).toBe(false)
  })

  it('只有 user 消息（无 streaming）isGenerating=false', () => {
    const store = useChatStore()
    const sid = 's3'
    store.appendUser(sid, 'hi')
    expect(store.isGenerating(sid)).toBe(false)
  })

  it('多条 message，只要有 1 条 streaming 就 isGenerating=true', () => {
    const store = useChatStore()
    const sid = 's4'
    store.appendUser(sid, 'q1')
    store.hydrate(sid, [
      ...(store.getMessages(sid)),
      { id: 'old', role: 'assistant', content: 'done', status: 'complete', timestamp: 1 },
    ])
    // 再注一条 streaming
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a2' },
    })
    expect(store.isGenerating(sid)).toBe(true)
  })

  it('scan 限定 per-session：大分区（500 complete）不影响其他 session 的判定（原 perf-scan 并入）', () => {
    const store = useChatStore()
    // session A 有 500 条 complete
    const msgsA: Message[] = []
    for (let i = 0; i < 500; i++) {
      msgsA.push({ id: `pa-${i}`, role: 'assistant', content: '', status: 'complete', timestamp: i })
    }
    store.hydrate('ps-largeA', msgsA)
    // session B 有 1 条 streaming
    store.applyMessageEvent('ps-streamB', {
      type: 'message.message_start',
      payload: { sessionId: 'ps-streamB', messageId: 'b1' },
    })
    // scan sA 不受 sB 影响
    expect(store.isGenerating('ps-largeA')).toBe(false)
    expect(store.isGenerating('ps-streamB')).toBe(true)
  })

  it('per-session 隔离：session A streaming，session B 不受影响', () => {
    const store = useChatStore()
    const sidA = 'sA'
    const sidB = 'sB'
    store.applyMessageEvent(sidA, {
      type: 'message.message_start',
      payload: { sessionId: sidA, messageId: 'a1' },
    })
    expect(store.isGenerating(sidA)).toBe(true)
    expect(store.isGenerating(sidB)).toBe(false)
  })
})

describe('错误事件派生复位 isGenerating（项目规则 #3 核心路径）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('message.error 事件 → isGenerating 派生回 false（无需手动 finalize）', () => {
    const store = useChatStore()
    const sid = 's-err'
    // 先进入 streaming 态
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    expect(store.isGenerating(sid)).toBe(true)
    // message.error 触发 finalizeSession('error') → 派生复位
    store.applyMessageEvent(sid, {
      type: 'message.error',
      payload: { sessionId: sid, message: 'test error' },
    })
    // 关键断言：派生回 false（不依赖手动 setStreaming(false)）
    expect(store.isGenerating(sid)).toBe(false)
  })

  it('message.stream_error 事件 → isGenerating 派生回 false', () => {
    const store = useChatStore()
    const sid = 's-streamerr'
    // 先进入 streaming 态
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    expect(store.isGenerating(sid)).toBe(true)
    // message.stream_error 触发 finalizeSession('stream_error') → 派生复位
    // payload content 字段（chat-message-effects.ts handler 读 readString(payload,'content')）
    store.applyMessageEvent(sid, {
      type: 'message.stream_error',
      payload: { sessionId: sid, content: 'stream broken' },
    })
    // 关键断言：派生回 false
    expect(store.isGenerating(sid)).toBe(false)
  })
})

describe('isActive（isGenerating ∨ pendingSend）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('非 streaming 且无 pendingSend → isActive=false', () => {
    const store = useChatStore()
    expect(store.isActive('s1')).toBe(false)
  })

  it('有 pendingSend 但无 streaming → isActive=true', () => {
    const store = useChatStore()
    store.addPendingSend('s1')
    expect(store.isGenerating('s1')).toBe(false)
    expect(store.isActive('s1')).toBe(true)
  })

  it('streaming 且有 pendingSend → isActive=true', () => {
    const store = useChatStore()
    const sid = 's3'
    store.addPendingSend(sid)
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    expect(store.isActive(sid)).toBe(true)
  })

  it('clearPendingSend 后无 streaming → isActive=false', () => {
    const store = useChatStore()
    const sid = 's4'
    store.addPendingSend(sid)
    store.clearPendingSend(sid)
    expect(store.isActive(sid)).toBe(false)
  })
})

describe('finalizeAllStreaming（F1 修正：多 session 收尾）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('2 个 session 同时 streaming → 全部收尾', () => {
    const store = useChatStore()
    const sidA = 'sA'
    const sidB = 'sB'
    // 两个 session 都在 streaming
    store.applyMessageEvent(sidA, {
      type: 'message.message_start',
      payload: { sessionId: sidA, messageId: 'a1' },
    })
    store.applyMessageEvent(sidB, {
      type: 'message.message_start',
      payload: { sessionId: sidB, messageId: 'b1' },
    })
    expect(store.isGenerating(sidA)).toBe(true)
    expect(store.isGenerating(sidB)).toBe(true)
    // runtime 重启 → 全部收尾
    store.finalizeAllStreaming('restart')
    expect(store.isGenerating(sidA)).toBe(false)
    expect(store.isGenerating(sidB)).toBe(false)
    expect(store.getMessages(sidA)[0].status).toBe('error')
    expect(store.getMessages(sidB)[0].status).toBe('error')
  })

  it('非 streaming session 不受 finalizeAllStreaming 影响', () => {
    const store = useChatStore()
    const sidActive = 'sActive'
    const sidIdle = 'sIdle'
    store.applyMessageEvent(sidActive, {
      type: 'message.message_start',
      payload: { sessionId: sidActive, messageId: 'a1' },
    })
    // sidIdle 有 complete 的历史消息
    store.hydrate(sidIdle, [
      { id: 'done', role: 'assistant', content: 'ok', status: 'complete', timestamp: 1 },
    ])
    store.finalizeAllStreaming('disconnect')
    // active 收尾
    expect(store.isGenerating(sidActive)).toBe(false)
    // idle 不受影响
    expect(store.getMessages(sidIdle)[0].status).toBe('complete')
  })

  it('3+ session 同时 streaming → 全部收尾', () => {
    const store = useChatStore()
    const sids = ['m1', 'm2', 'm3']
    for (const sid of sids) {
      store.applyMessageEvent(sid, {
        type: 'message.message_start',
        payload: { sessionId: sid, messageId: `a-${sid}` },
      })
    }
    sids.forEach((sid) => expect(store.isGenerating(sid)).toBe(true))
    store.finalizeAllStreaming('restart')
    sids.forEach((sid) => {
      expect(store.isGenerating(sid)).toBe(false)
      expect(store.getMessages(sid)[0].status).toBe('error')
    })
  })

  it('无任何 streaming session 时 finalizeAllStreaming 无副作用', () => {
    const store = useChatStore()
    store.hydrate('idle', [
      { id: 'd', role: 'assistant', content: 'ok', status: 'complete', timestamp: 1 },
    ])
    store.finalizeAllStreaming('restart')
    expect(store.getMessages('idle')[0].status).toBe('complete')
  })
})

// ══════════ 来源：chat-message-effects-bash.test.ts（bashStart/bashResult effect） ══════════

describe('bash effect（message.bashStart / message.bashResult）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('T1: bashStart → 不建 messages 项，executingBash 置位（执行中 ephemeral 反馈）', () => {
    const store = useChatStore()
    const sid = 's-bash-1'
    store.applyMessageEvent(sid, {
      type: 'message.bashStart',
      payload: { sessionId: sid, command: 'echo hello', excludeFromContext: false, timestamp: 1000 },
    } as ServerMessage)

    expect(store.getMessages(sid)).toHaveLength(0)
    expect(getExecutingBash(sid)).toEqual({ command: 'echo hello', startedAt: 1000 })
  })

  it('T2: bashStart 后 bashResult → 末尾 complete 态 bashExecution 消息（entry 入流），执行态清除', () => {
    const store = useChatStore()
    const sid = 's-bash-2'
    store.applyMessageEvent(sid, {
      type: 'message.bashStart',
      payload: { sessionId: sid, command: 'ls', excludeFromContext: false, timestamp: 1000 },
    } as ServerMessage)
    store.applyMessageEvent(sid, {
      type: 'message.bashResult',
      payload: {
        sessionId: sid,
        command: 'ls',
        output: 'file1\nfile2',
        exitCode: 0,
        cancelled: false,
        truncated: false,
        excludeFromContext: false,
        timestamp: 2000,
      },
    } as ServerMessage)

    const msgs = store.getMessages(sid)
    expect(msgs).toHaveLength(1)
    const m = msgs[0]
    expect(m.role).toBe('system')
    expect(m.status).toBe('complete')
    expect(m.bashExecution?.command).toBe('ls')
    expect(m.bashExecution?.output).toBe('file1\nfile2')
    expect(m.bashExecution?.exitCode).toBe(0)
    expect(m.bashExecution?.cancelled).toBe(false)
    expect(getExecutingBash(sid)).toBeUndefined()
  })

  it('T3: bashResult cancelled=true（真实命令）→ entry 入流 cancelled=true', () => {
    const store = useChatStore()
    const sid = 's-bash-3'
    store.applyMessageEvent(sid, {
      type: 'message.bashResult',
      payload: {
        sessionId: sid,
        command: 'sleep 5',
        output: '',
        exitCode: null,
        cancelled: true,
        truncated: false,
        excludeFromContext: false,
        timestamp: 2000,
      },
    } as ServerMessage)

    const msgs = store.getMessages(sid)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].status).toBe('complete')
    expect(msgs[0].bashExecution?.cancelled).toBe(true)
  })

  it('T4: abortBash 兜底终态 message.bashAborted（D4-3 独立帧）→ 不建消息，executingBash 清（UI 中止态）', () => {
    const store = useChatStore()
    const sid = 's-bash-4'
    store.applyMessageEvent(sid, {
      type: 'message.bashStart',
      payload: { sessionId: sid, command: 'sleep 5', excludeFromContext: false, timestamp: 1000 },
    } as ServerMessage)
    // wire 载荷与 runtime BashDispatcher.abortBash 广播形态一致（shared
    // ServerMessageMap['message.bashAborted']）；经 store.applyMessageEvent 全链
    //（registry effect 表 → bashAbortedEffect）驱动。
    store.applyMessageEvent(sid, {
      type: 'message.bashAborted',
      payload: { sessionId: sid, timestamp: 2000 },
    } as ServerMessage)

    expect(store.getMessages(sid)).toHaveLength(0)
    expect(getExecutingBash(sid)).toBeUndefined()
  })

  it('T5: excludeFromContext 透传（探针①：该类 bash 仍写 entry，与普通 bash 同路径 entry 化）', () => {
    const store = useChatStore()
    const sid = 's-bash-5'
    store.applyMessageEvent(sid, {
      type: 'message.bashResult',
      payload: {
        sessionId: sid,
        command: 'secret',
        output: 'ok',
        exitCode: 0,
        cancelled: false,
        truncated: false,
        excludeFromContext: true,
        timestamp: 2000,
      },
    } as ServerMessage)
    expect(store.getMessages(sid)[0].bashExecution?.excludeFromContext).toBe(true)
  })

  it('T6: streaming 中 bash（延迟帧在 turn 收尾后到达）→ bash 记录位于 assistant 之后（与文件位置一致，G2）', () => {
    const store = useChatStore()
    const sid = 's-bash-6'
    // run 级联：assistant streaming 中用户执行 `!` bash（bashStart 即时反馈）
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a-1' },
    } as ServerMessage)
    store.applyMessageEvent(sid, {
      type: 'message.text_delta',
      payload: { sessionId: sid, delta: 'partial answer' },
    } as ServerMessage)
    store.applyMessageEvent(sid, {
      type: 'message.bashStart',
      payload: { sessionId: sid, command: 'ls -la', excludeFromContext: false, timestamp: 1500 },
    } as ServerMessage)
    // 级联结束：assistant 收尾在前，bash 延迟帧（flush）在后——bash 落在 turn 末尾而非执行时刻
    store.applyMessageEvent(sid, {
      type: 'message.complete',
      payload: { sessionId: sid, stopReason: 'end_turn' },
    } as ServerMessage)
    store.applyMessageEvent(sid, {
      type: 'message.bashResult',
      payload: {
        sessionId: sid,
        command: 'ls -la',
        output: 'total 0',
        exitCode: 0,
        cancelled: false,
        truncated: false,
        excludeFromContext: false,
        timestamp: 3000,
      },
    } as ServerMessage)

    const msgs = store.getMessages(sid)
    expect(msgs).toHaveLength(2)
    expect(msgs[0].role).toBe('assistant')
    expect(msgs[0].status).toBe('complete')
    expect(msgs[1].bashExecution?.command).toBe('ls -la')
    expect(msgs[1].status).toBe('complete')
  })
})

// ══════════ 来源：chat-dispose-session.test.ts（disposeSession per-session 清理） ══════════

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
    // failedHistory 无公开读取器，经行为派生视图断言：Panel.vue 重试出口判据即
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
