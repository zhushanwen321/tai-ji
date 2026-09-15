/**
 * W1 数据层 —— 流式 chunk 填充 contentBlocks 测试。
 *
 * 背景：contentBlocks 记录 thinking/toolCall/text 的到达顺序，但流式路径从未填充。
 * 本测试覆盖 effect 注册表（dispatchMessageEvent）在 message_start / text_delta /
 * thinking_start / tool_call_start 等 case 下正确 push contentBlocks（幂等 + 到达顺序），
 * 并验证后续 end/delta case 不改顺序。
 *
 * F2 重构后：原 applyChunk(ChunkContext) 已并入 dispatchMessageEvent(MessageEffectContext)，
 * 测试入口随之迁移（行为不变）。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/stores/chat-chunk-content-blocks.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { ref, shallowRef } from 'vue'
import { dispatchMessageEvent } from '@taiji/core'
import type { MessageEffectContext } from '@taiji/core'
import type { Message, ServerMessage } from '@taiji/shared'

const SID = 's-test'

/** 构造 MessageEffectContext：真实 vue ref + 回调 mock（流式 contentBlocks 不走 file_changes） */
function makeCtx(initial: Message[] = []): MessageEffectContext {
  return {
    messages: ref(new Map([[SID, shallowRef(initial)]])),
    retryStates: ref(new Map()),
    queueStates: ref(new Map()),
    applyFileChanges: vi.fn(),
    markChangeSetsSuperseded: vi.fn(),
    finalizeSession: vi.fn(),
    clearPendingSend: vi.fn(),
    armStreamingTimer: vi.fn(),
    // m2→W14：queue_update drain 接线 drainN（计数 FIFO）+ appendUser + 深度对账 reconcilePending
    //（对齐 core __tests__/effects.test.ts 形态；本套用例不触发 queue_update，返回空数组即可）
    drainN: vi.fn(() => []),
    reconcilePending: vi.fn(),
    appendUser: vi.fn(),
    // steer-bubble u1/D2：inflight 确认计数读写（message_start/abort 分支消费，store 注入；
    // 本套用例无计数断言，getInflight 恒 0 + 其余 no-op）
    getInflight: vi.fn(() => 0),
    incrementInflight: vi.fn(),
    decrementInflight: vi.fn(),
    clearInflight: vi.fn(),
    // [premature-timeout §5.2 D2] timeout 打标快照消费/清除（默认无打标 → take 返回空集）
    takePrematureTimeoutIds: vi.fn(() => new Set<string>()),
    clearPrematureTimeoutIds: vi.fn(),
    // w21：entry 载体帧喂 reducer 的接入点
    applyEntryFrame: vi.fn(),
  }
}

function msg(type: string, payload: Record<string, unknown> = {}): ServerMessage {
  return { type, payload: { sessionId: SID, ...payload } } as ServerMessage
}

function getMsgs(ctx: MessageEffectContext): Message[] {
  return ctx.messages.value.get(SID)?.value ?? []
}

/** 取最后一条 assistant message */
function lastAssistant(ctx: MessageEffectContext): Message {
  const list = getMsgs(ctx)
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].role === 'assistant') return list[i]
  }
  throw new Error('no assistant message')
}

describe('dispatchMessageEvent contentBlocks 填充（流式路径）', () => {
  // U1：message_start 初始化 contentBlocks: []
  it('U1: message_start（prev 空）→ 新 message 含 contentBlocks: []（空数组）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    const a = lastAssistant(ctx)
    expect(a.contentBlocks).toEqual([])
  })

  // U2：首个 text_delta push text 块
  it('U2: content="" + contentBlocks=[]，收首个 text_delta "h" → content="h" 且 contentBlocks=[{type:text,refId:text}]', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: 'h' }))
    const a = lastAssistant(ctx)
    expect(a.content).toBe('h')
    expect(a.contentBlocks).toEqual([{ type: 'text', refId: 'text' }])
  })

  // U3：已含 text 块，再收 text_delta 不重复 push
  it('U3: contentBlocks 已含 text 块，再收 text_delta "i" → content="hi"，contentBlocks 仍仅 1 个 text 块', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: 'h' }))
    dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: 'i' }))
    const a = lastAssistant(ctx)
    expect(a.content).toBe('hi')
    expect(a.contentBlocks).toEqual([{ type: 'text', refId: 'text' }])
  })

  // U4：thinking_start push thinking 块
  it('U4: 收 thinking_start(thinkingId="th1") → thinking 含 th1 且 contentBlocks 尾部 push {type:thinking,refId:th1}', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.thinking_start', { thinkingId: 'th1' }))
    const a = lastAssistant(ctx)
    expect(a.thinking?.[0].id).toBe('th1')
    expect(a.contentBlocks).toEqual([{ type: 'thinking', refId: 'th1' }])
  })

  // U5：tool_call_start push toolCall 块
  it('U5: 收 tool_call_start(toolCallId="tc1") → toolCalls 含 tc1 且 contentBlocks 尾部 push {type:toolCall,refId:tc1}', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: { type: 'toolCall', toolCallId: 'tc1', toolName: 'read', arguments: {}, timestamp: new Date(0).toISOString() } }))
    const a = lastAssistant(ctx)
    expect(a.toolCalls?.[0].id).toBe('tc1')
    expect(a.contentBlocks).toEqual([{ type: 'toolCall', refId: 'tc1' }])
  })

  // U6：多类型块严格按首次到达顺序
  it('U6: message_start→thinking(th1)→text_delta→tool_call(tc1)→thinking(th2) → contentBlocks 顺序=[thinking:th1, text, toolCall:tc1, thinking:th2]', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.thinking_start', { thinkingId: 'th1' }))
    dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: 'hi' }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: { type: 'toolCall', toolCallId: 'tc1', toolName: 'read', arguments: {}, timestamp: new Date(0).toISOString() } }))
    dispatchMessageEvent(ctx, SID, msg('message.thinking_start', { thinkingId: 'th2' }))
    const a = lastAssistant(ctx)
    expect(a.contentBlocks).toEqual([
      { type: 'thinking', refId: 'th1' },
      { type: 'text', refId: 'text' },
      { type: 'toolCall', refId: 'tc1' },
      { type: 'thinking', refId: 'th2' },
    ])
  })

  // U7：thinking_end + thinking_delta 不改 contentBlocks
  it('U7: contentBlocks 已定，收 thinking_end + thinking_delta → contentBlocks 数组不变（仅 thinking 内容更新）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.thinking_start', { thinkingId: 'th1' }))
    const before = lastAssistant(ctx).contentBlocks
    dispatchMessageEvent(ctx, SID, msg('message.thinking_delta', { delta: '推理' }))
    dispatchMessageEvent(ctx, SID, msg('message.thinking_end'))
    const a = lastAssistant(ctx)
    expect(a.contentBlocks).toEqual(before)
    expect(a.thinking?.[0].content).toBe('推理')
    expect(a.thinking?.[0].endTime).toBeTypeOf('number')
  })

  // U8：prev 无 assistant，收 text_delta 不抛错
  it('U8: prev 无 assistant，收 text_delta → 不抛错（return early）', () => {
    const ctx = makeCtx([{ id: 'u1', role: 'user', content: 'hi', status: 'complete', timestamp: 0 }])
    expect(() => dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: 'x' }))).not.toThrow()
    // user 消息不变
    expect(getMsgs(ctx)).toHaveLength(1)
  })

  // U11：message_start 起新 assistant，旧 assistant 的 contentBlocks 原样保留
  it('U11: a1 已有 contentBlocks，message_start(a2)→text_delta → a1.contentBlocks 原样；text 写入 a2', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: 'first' }))
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a2' }))
    dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: 'second' }))
    const list = getMsgs(ctx)
    // a1 不被改
    expect(list[0].contentBlocks).toEqual([{ type: 'text', refId: 'text' }])
    expect(list[0].content).toBe('first')
    // a2 收到 text
    expect(list[1].content).toBe('second')
    expect(list[1].contentBlocks).toEqual([{ type: 'text', refId: 'text' }])
  })

  // U11b：thinking_start 无 thinkingId → fallback blockId 同时用于 thinking[].id 与 contentBlocks[].refId
  it('U11b: thinking_start 无 thinkingId → fallback id 在 thinking[].id 与 contentBlocks[].refId 一致', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.thinking_start')) // 无 thinkingId
    const a = lastAssistant(ctx)
    const thkId = a.thinking?.[0].id
    expect(thkId).toBeTruthy()
    const refId = a.contentBlocks?.[0].refId
    expect(refId).toBe(thkId)
  })

  // U11c：tool_call_start 无 toolCallId → fallback UUID 在 toolCalls[].id 与 contentBlocks[].refId 一致
  it('U11c: tool_call_start 无 toolCallId → fallback id 在 toolCalls[].id 与 contentBlocks[].refId 一致', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: { type: 'toolCall', toolName: 'read', arguments: {}, timestamp: new Date(0).toISOString() } })) // 无 toolCallId
    const a = lastAssistant(ctx)
    const tcId = a.toolCalls?.[0].id
    expect(tcId).toBeTruthy()
    const refId = a.contentBlocks?.[0].refId
    expect(refId).toBe(tcId)
  })

  // U11d：tool_call_end 不改 contentBlocks
  it('U11d: contentBlocks 已定，收 tool_call_end → contentBlocks 不变，仅 toolCalls[].status 更新', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: { type: 'toolCall', toolCallId: 'tc1', toolName: 'read', arguments: {}, timestamp: new Date(0).toISOString() } }))
    const before = lastAssistant(ctx).contentBlocks
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_end', { entry: { type: 'message', parentId: null, timestamp: new Date(0).toISOString(), message: { role: 'toolResult', toolCallId: 'tc1', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 0 } } }))
    const a = lastAssistant(ctx)
    expect(a.contentBlocks).toEqual(before)
    expect(a.toolCalls?.[0].status).toBe('completed')
    expect(a.toolCalls?.[0].output).toBe('ok')
  })
})
