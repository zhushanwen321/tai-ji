/**
 * Chat store 流式状态复位回归测试（CLAUDE.md 规则 #3）。
 *
 * 锁定 MUST_FIX #1 的修复：message.error 到达时，若最后一条 assistant 仍
 * status:'streaming'（流中途错误 / 进程崩溃），必须将其转为 error 并并入 errorText，
 * 而非总新建消息导致流式气泡卡「生成中」。
 *
 * 覆盖：
 * - 流中途 message.error：最后 streaming assistant → status:error + 并入 errorText（不新建）
 * - prompt 级 message.error（无 streaming assistant）：新建独立 error 消息，不改写历史
 * - 已 complete 的历史 assistant 遇 message.error：不回写，新建独立 error 消息
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/chat-streaming-reset.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'

describe('chat store message.error 流式状态复位（规则 #3）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('流中途 message.error：最后 streaming assistant 转为 error 并并入 errorText', () => {
    const store = useChatStore()
    const sid = 'sx'
    // 建一条 streaming assistant（流中途）
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.text_delta',
      payload: { sessionId: sid, delta: '部分内容' },
    })
    const before = store.getMessages(sid)
    expect(before[0].status).toBe('streaming')

    // 流中途错误（event-adapter error / 进程崩溃）
    store.applyMessageEvent(sid, {
      type: 'message.error',
      payload: { sessionId: sid, message: '进程崩溃' },
    })

    const after = store.getMessages(sid)
    expect(after).toHaveLength(1) // 不新建气泡
    expect(after[0].id).toBe('a1') // 原流式消息被转态
    expect(after[0].status).toBe('error') // 关键：复位 streaming
    expect(after[0].content).toContain('部分内容') // 保留已生成内容
    // [M2 error-visibility] 追加形态双通道：errorText 写 msg.error，不拼进 content
    expect(after[0].error).toBe('进程崩溃')
    expect(after[0].content).not.toContain('进程崩溃')
  })

  it('prompt 级 message.error（无 streaming assistant）：新建独立 error 消息', () => {
    const store = useChatStore()
    const sid = 'sy'
    store.appendUser(sid, 'hi')
    // 无 assistant 流，直接 error
    store.applyMessageEvent(sid, {
      type: 'message.error',
      payload: { sessionId: sid, message: 'hook 拒绝' },
    })
    const msgs = store.getMessages(sid)
    expect(msgs).toHaveLength(2) // user + 新建 error
    expect(msgs[1].role).toBe('assistant')
    expect(msgs[1].status).toBe('error')
    expect(msgs[1].content).toBe('hook 拒绝')
  })

  it('已 complete 的历史 assistant 遇 message.error：不回写历史，新建独立 error 消息', () => {
    const store = useChatStore()
    const sid = 'sz'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a-old' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.complete',
      payload: { sessionId: sid },
    })
    const before = store.getMessages(sid)
    expect(before[0].status).toBe('complete')

    // 后续错误到达，历史 complete 消息不应被改写
    store.applyMessageEvent(sid, {
      type: 'message.error',
      payload: { sessionId: sid, message: '后置错误' },
    })

    const after = store.getMessages(sid)
    expect(after).toHaveLength(2)
    expect(after[0].status).toBe('complete') // 历史消息保持
    expect(after[0].content).toBe('') // 未被并入 errorText
    expect(after[1].status).toBe('error') // 新建 error 消息
    expect(after[1].content).toBe('后置错误')
  })

  it(`errorText 缺省时落 'Unknown error'（流中途仍复位 streaming）`, () => {
    const store = useChatStore()
    const sid = 'sw'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a2' },
    })
    // payload 无 message 字段
    store.applyMessageEvent(sid, { type: 'message.error', payload: { sessionId: sid } })
    const after = store.getMessages(sid)
    expect(after).toHaveLength(1)
    expect(after[0].status).toBe('error')
    expect(after[0].error).toBe('Unknown error') // 缺省文案落 msg.error 字段（不拼 content）
    expect(after[0].content).toBe('')
  })
})

describe('chat store message.complete 多 assistant 气泡收口', () => {
  beforeEach(() => setActivePinia(createPinia()))

  // [HISTORICAL] handoff 2026-07-04 L3：一个 turn 可能产生多个 streaming assistant 气泡
  // （如工具调用气泡 + 文字总结气泡，或历史/fork 路径残留）。旧实现用 findLastAssistantIndex
  // 只收口最后一条，前面的 toolCall 气泡永远 streaming——内部状态机不一致，影响后续定位逻辑。
  // 修复后 message.complete 收口所有 status==='streaming' 的 assistant，usage 只回填最后一条。
  it('message.complete 收口所有 streaming assistant 气泡（不只最后一条）', () => {
    const store = useChatStore()
    const sid = 'multi'
    // 模拟一个 turn 产生两条 streaming assistant（如 toolCall 气泡 + 文字气泡）
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'tool-bubble' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'text-bubble' },
    })
    const before = store.getMessages(sid)
    expect(before).toHaveLength(2)
    expect(before[0].status).toBe('streaming')
    expect(before[1].status).toBe('streaming')

    store.applyMessageEvent(sid, {
      type: 'message.complete',
      payload: { sessionId: sid, stopReason: 'end_turn' },
    })

    const after = store.getMessages(sid)
    // 关键：两条 assistant 都收口（旧行为只收最后一条，前一条卡 streaming）
    expect(after[0].status).toBe('complete')
    expect(after[1].status).toBe('complete')
  })

  it('message.complete usage 只回填最后一条 assistant（turn 级聚合，非末回填会语义错位）', () => {
    const store = useChatStore()
    const sid = 'usage'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'bubble-a' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'bubble-b' },
    })

    store.applyMessageEvent(sid, {
      type: 'message.complete',
      payload: {
        sessionId: sid,
        stopReason: 'end_turn',
        usage: { inputTokens: 100, outputTokens: 50 },
      },
    })

    const after = store.getMessages(sid)
    expect(after[0].usage).toBeUndefined() // 非末不回填
    expect(after[1].usage).toMatchObject({ inputTokens: 100, outputTokens: 50 })
  })

  it('message.complete stopReason error 时所有 streaming assistant 收口为 error', () => {
    const store = useChatStore()
    const sid = 'err-multi'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'e-a' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'e-b' },
    })

    store.applyMessageEvent(sid, {
      type: 'message.complete',
      payload: { sessionId: sid, stopReason: 'error' },
    })

    const after = store.getMessages(sid)
    expect(after[0].status).toBe('error')
    expect(after[1].status).toBe('error')
  })
})

describe('chat store markSessionError —— session 级错误统一入口', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('无 streaming assistant 时：新建独立 error 消息', () => {
    const store = useChatStore()
    const sid = 'me-1'
    store.appendUser(sid, 'hi')
    store.markSessionError(sid, '进程退出')

    const msgs = store.getMessages(sid)
    expect(msgs).toHaveLength(2) // user + 新建 error
    expect(msgs[1].role).toBe('assistant')
    expect(msgs[1].status).toBe('error')
    expect(msgs[1].content).toBe('进程退出')
  })

  it('有 streaming assistant 时：并入该消息并转 error 态（不新建气泡）', () => {
    const store = useChatStore()
    const sid = 'me-2'
    // 建一条 streaming assistant
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a-me' },
    })
    store.applyMessageEvent(sid, {
      type: 'message.text_delta',
      payload: { sessionId: sid, delta: '流中内容' },
    })
    expect(store.getMessages(sid)[0].status).toBe('streaming')

    store.markSessionError(sid, '进程崩溃')

    const msgs = store.getMessages(sid)
    expect(msgs).toHaveLength(1) // 不新建气泡，原消息转态
    expect(msgs[0].id).toBe('a-me')
    expect(msgs[0].status).toBe('error')
    expect(msgs[0].content).toContain('流中内容') // 保留已生成内容
    // [M2 error-visibility] 追加形态双通道：errorText 写 msg.error，不拼进 content
    expect(msgs[0].error).toBe('进程崩溃')
    expect(msgs[0].content).not.toContain('进程崩溃')
  })

  it('finalizeSession 收口所有活跃态：streaming entity + pendingSend', () => {
    const store = useChatStore()
    const sid = 'me-3'

    // 先设为 streaming + pendingSend 态（模拟流式中进程崩溃）
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a-me3' },
    })
    store.addPendingSend(sid)
    expect(store.isGenerating(sid)).toBe(true)
    expect(store.isActive(sid)).toBe(true)

    store.markSessionError(sid, '崩溃')

    // 关键：所有活跃态复位（规则 #3），避免 UI 卡「思考中」
    expect(store.isGenerating(sid)).toBe(false)
    expect(store.isActive(sid)).toBe(false)
  })

  it('空 messages 的 session：新建首条 error 消息', () => {
    const store = useChatStore()
    const sid = 'me-4'
    // 进程在首条消息前就退出（如 extension 加载失败）
    store.markSessionError(sid, 'extension 加载失败')

    const msgs = store.getMessages(sid)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('assistant')
    expect(msgs[0].status).toBe('error')
    expect(msgs[0].content).toBe('extension 加载失败')
  })
})
