// @vitest-environment node

/**
 * Chat store 复位回归测试（合并自 chat-streaming-reset + chat-transient-reset——
 * 同为 useChatStore 复位语义、import 集与 describe 内 beforeEach 结构完全一致，
 * 合并以减少测试文件的 fork/装载固定开销；describe 与用例名保持原样）。
 *
 * - 流式状态复位（AGENTS.md 规则 #3）：message.error 到达时的 streaming assistant 转态
 * - 瞬态状态收尾（W3）：断连 / runtime 重启下 compacting/retry/queue 由 resetTransientStates 全清
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
    expect(msgs[1].content).toBe('') // [M2] 错误文本不拼进 content
    expect(msgs[1].error).toBe('hook 拒绝')
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
    expect(after[1].content).toBe('') // [M2] 错误文本不拼进 content
    expect(after[1].error).toBe('后置错误')
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

describe('chat store message.complete 多 assistant 气泡收尾', () => {
  beforeEach(() => setActivePinia(createPinia()))

  // [HISTORICAL] handoff 2026-07-04 L3：一个 turn 可能产生多个 streaming assistant 气泡
  // （如工具调用气泡 + 文字总结气泡，或历史/fork 路径残留）。旧实现用 findLastAssistantIndex
  // 只收尾最后一条，前面的 toolCall 气泡永远 streaming——内部状态机不一致，影响后续定位逻辑。
  // 修复后 message.complete 收尾所有 status==='streaming' 的 assistant。usage 不由 complete
  // 回填（chat-flow-consistency D3 规则 5 退役回合级覆盖），per-message usage 由
  // message_end(assistant) 帧载荷承担（同款锚见 fg5-message-stream.test.ts）。
  it('message.complete 收尾所有 streaming assistant 气泡（不只最后一条）', () => {
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
    // 关键：两条 assistant 都收尾（旧行为只收最后一条，前一条卡 streaming）
    expect(after[0].status).toBe('complete')
    expect(after[1].status).toBe('complete')
  })

  it('complete.usage 不再回填任何 assistant（D3 规则 5 退役）；per-message usage 由 message_end 载荷承担', () => {
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

    // 回合级 complete.usage 不再覆盖末位 assistant（定稿重建按每条消息的 entry 载荷写入，
    // 覆盖会把 turn 聚合值错误摊到单条消息——规则 5 退役锚）
    const afterComplete = store.getMessages(sid)
    expect(afterComplete[0].usage).toBeUndefined()
    expect(afterComplete[1].usage).toBeUndefined()

    // message_end(assistant) 帧载荷回填各条消息自己的 usage（live 与 reload 同源同值）
    store.applyMessageEvent(sid, {
      type: 'message.message_end',
      payload: {
        sessionId: sid,
        messageId: 'bubble-a',
        entry: {
          type: 'message',
          parentId: null,
          timestamp: new Date(0).toISOString(),
          message: { role: 'assistant', content: [{ type: 'text', text: 'a' }], usage: { input: 10, output: 5 }, stopReason: 'stop', timestamp: 0 },
        },
      },
    } as never)
    store.applyMessageEvent(sid, {
      type: 'message.message_end',
      payload: {
        sessionId: sid,
        messageId: 'bubble-b',
        entry: {
          type: 'message',
          parentId: null,
          timestamp: new Date(0).toISOString(),
          message: { role: 'assistant', content: [{ type: 'text', text: 'b' }], usage: { input: 100, output: 50 }, stopReason: 'stop', timestamp: 0 },
        },
      },
    } as never)

    const after = store.getMessages(sid)
    expect(after[0].usage).toEqual({ inputTokens: 10, outputTokens: 5 })
    expect(after[1].usage).toEqual({ inputTokens: 100, outputTokens: 50 })
  })

  it('message.complete stopReason error 时所有 streaming assistant 收尾为 error', () => {
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
    expect(msgs[1].content).toBe('') // [M2] 错误文本不拼进 content
    expect(msgs[1].error).toBe('进程退出')
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

  it('finalizeSession 收尾所有活跃态：streaming entity + pendingSend', () => {
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
    expect(msgs[0].content).toBe('') // [M2] 错误文本不拼进 content
    expect(msgs[0].error).toBe('extension 加载失败')
  })
})

describe('chat store 瞬态状态收尾（W3：finalizeAllStreaming 应全收尾）', () => {
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

  it('[u3c/u5a 退役] queue_update 帧零落点——瞬态收尾点收敛为 occupancy/retry/streaming', () => {
    // [HISTORICAL] 前身「断连时 finalizeAllStreaming 清理 queueStates」用例：queue_update 帧
    // 已随投递所有权内核降级为内核内部回执（u3b 退役 queueStates 写入路径；u5a 结清分区与
    // 读写 API 本身），本用例前提（queue_update 能置 queueStates）结构性不成立。
    // 断言范围保留「帧到达不产生任何瞬态」：messages 与 retry 分区零写入。
    // 替代覆盖：内核派生视图随 session 销毁/disposeSession 清理（core clearDeliveryProjection，
    // 见 core chat __tests__/effects-delivery-receipt.test.ts）+ 本文件其余瞬态收尾用例。
    const store = useChatStore()
    const sid = 's-queue'
    store.applyMessageEvent(sid, {
      type: 'message.queue_update',
      payload: { sessionId: sid, steering: ['补一条'] },
    })
    expect(store.getMessages(sid)).toHaveLength(0)
    expect(store.getRetryState(sid)).toBeUndefined()
  })

  it('正常 message.complete 不清 compacting（只有 finalizeAllStreaming 全收尾）', () => {
    const store = useChatStore()
    const sid = 's-normal'

    // session 正在压缩 + 一条 streaming 消息
    store.setOccupancy(sid, { turn: 'idle', compacting: true, bash: false })
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })

    // 正常收尾：message.complete 收尾 streaming 实体
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

    // 置满所有瞬态：streaming + compacting + retry + pendingSend
    // （[u3c] queueStates 置位路径已随 queue_update 退役，不再计入瞬态面）
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    store.setOccupancy(sid, { turn: 'idle', compacting: true, bash: false })
    store.applyMessageEvent(sid, {
      type: 'message.auto_retry_start',
      payload: { sessionId: sid, attempt: 1 },
    })
    store.addPendingSend(sid)

    expect(store.isGenerating(sid)).toBe(true)
    expect(store.isCompacting(sid)).toBe(true)
    expect(store.getRetryState(sid)).toBeDefined()
    expect(store.isActive(sid)).toBe(true)

    // W3：调用统一收尾 helper（resetTransientStates 已在 store API 暴露）
    store.resetTransientStates(sid)

    // 关键：全部瞬态一次性清零
    expect(store.isCompacting(sid)).toBe(false)
    expect(store.getRetryState(sid)).toBeUndefined()
  })
})
