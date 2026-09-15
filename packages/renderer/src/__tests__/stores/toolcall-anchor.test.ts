/**
 * ToolCall ID 锚定 + 流结束收口测试。
 *
 * 根因：event-adapter 并行处理 pi 事件（void this.handleEvent 不 await），
 * tool_execution_end 的 async handler（含 hook + git 对账）可能晚于下一个
 * message_start 发送。旧实现用 findLastAssistantIndex（位置定位）会被乱序干扰——
 * end 命中错误的空 assistant message，更新静默失败，toolCall 永久卡 running。
 *
 * 修复：tool_call_end/update 用 findToolCallOwner（按 toolCallId 全局查找）锚定；
 * message.complete 把残留 running 收口为 end_not_received（正常 stop）/ error（error stop）。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/stores/toolcall-anchor.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'
import { findToolCallOwner } from '@taiji/core'
import { assistantToMarkdown } from '@/composables/logic/messageFormat'
import { deriveStatus } from '@/composables/logic/sessionStatus'
import type { Message, ToolCall } from '@taiji/shared'

describe('findToolCallOwner — ID 锚定查找', () => {
  it('按 toolCallId 精确命中所属 assistant message（跨多 message）', () => {
    const list = [
      { id: 'a1', role: 'assistant', toolCalls: [{ id: 'tc-old', toolName: 'read', input: {}, status: 'completed', startTime: 0 }] },
      { id: 'a2', role: 'assistant', toolCalls: [{ id: 'tc-1', toolName: 'edit', input: {}, status: 'running', startTime: 0 }] },
    ] as never
    expect(findToolCallOwner(list, 'tc-1')).toBe(1)
    expect(findToolCallOwner(list, 'tc-old')).toBe(0)
  })

  it('从后往前扫，命中最新含该 toolCall 的 message', () => {
    const list = [
      { id: 'a1', role: 'assistant', toolCalls: [{ id: 'tc-dup', toolName: 'read', input: {}, status: 'completed', startTime: 0 }] },
      { id: 'a2', role: 'assistant', toolCalls: [{ id: 'tc-dup', toolName: 'read', input: {}, status: 'running', startTime: 0 }] },
    ] as never
    expect(findToolCallOwner(list, 'tc-dup')).toBe(1)
  })

  it('未命中返回 -1（含非 assistant message 跳过）', () => {
    const list = [
      { id: 'u1', role: 'user', toolCalls: [{ id: 'tc-x', toolName: 'read', input: {}, status: 'running', startTime: 0 }] },
      { id: 'a1', role: 'assistant', toolCalls: [] },
    ] as never
    expect(findToolCallOwner(list, 'tc-x')).toBe(-1)
    expect(findToolCallOwner(list, 'nope')).toBe(-1)
  })
})

describe('tool_call_end/update — ID 锚定（乱序免疫）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('U5: tool_call_end 命中正确 toolCall（即使空 assistant message 插在后面）', () => {
    const store = useChatStore()
    const sid = 's5'
    // assistant#0 建 tc-1(running)
    store.applyMessageEvent(sid, { type: 'message.message_start', payload: { sessionId: sid, messageId: 'a0' } })
    store.applyMessageEvent(sid, { type: 'message.tool_call_start', payload: { sessionId: sid, entry: { type: 'toolCall', toolCallId: 'tc-1', toolName: 'read', arguments: { path: '/f' }, timestamp: new Date(0).toISOString() } } })

    // 模拟 toolResult 噪声：空 assistant#1 插在后面（虽然 W1 已在 runtime 侧过滤，
    // 但防御：万一漏网，前端 ID 锚定仍应正确命中）
    store.applyMessageEvent(sid, { type: 'message.message_start', payload: { sessionId: sid, messageId: 'a1' } })

    // tool_call_end(tc-1) 必须命中 assistant#0（ID 锚定），不能落在空 assistant#1
    store.applyMessageEvent(sid, { type: 'message.tool_call_end', payload: { sessionId: sid, entry: { type: 'message', parentId: null, timestamp: new Date(0).toISOString(), message: { role: 'toolResult', toolCallId: 'tc-1', content: [{ type: 'text', text: 'done' }], isError: false, timestamp: 0 } } } })

    const msgs = store.getMessages(sid)
    const owner = msgs[0] // assistant#0
    expect(owner.id).toBe('a0')
    expect(owner.toolCalls![0].status).toBe('completed')
    expect(owner.toolCalls![0].output).toBe('done')
    // 空 assistant#1 无 toolCalls
    expect(msgs[1].toolCalls).toBeUndefined()
  })

  it('U8: tool_call_update 命中正确 toolCall（ID 锚定，非位置）', () => {
    const store = useChatStore()
    const sid = 's8'
    store.applyMessageEvent(sid, { type: 'message.message_start', payload: { sessionId: sid, messageId: 'a0' } })
    store.applyMessageEvent(sid, { type: 'message.tool_call_start', payload: { sessionId: sid, entry: { type: 'toolCall', toolCallId: 'tc-1', toolName: 'bash', arguments: {}, timestamp: new Date(0).toISOString() } } })
    store.applyMessageEvent(sid, { type: 'message.message_start', payload: { sessionId: sid, messageId: 'a1' } })

    store.applyMessageEvent(sid, { type: 'message.tool_call_update', payload: { sessionId: sid, toolCallId: 'tc-1', detail: '读取中' } })

    const msgs = store.getMessages(sid)
    expect(msgs[0].toolCalls![0].detail).toBe('读取中')
    expect(msgs[1].toolCalls).toBeUndefined()
  })

  it('U9: toolCallId 未命中任何 message 时安全 return（不崩溃、不误改其它 toolCall）', () => {
    const store = useChatStore()
    const sid = 's9'
    store.applyMessageEvent(sid, { type: 'message.message_start', payload: { sessionId: sid, messageId: 'a0' } })
    store.applyMessageEvent(sid, { type: 'message.tool_call_start', payload: { sessionId: sid, entry: { type: 'toolCall', toolCallId: 'tc-1', toolName: 'read', arguments: {}, timestamp: new Date(0).toISOString() } } })

    // toolCallId 'tc-ghost' 不存在任何 message（历史消息无索引 / 已归档场景）
    store.applyMessageEvent(sid, { type: 'message.tool_call_end', payload: { sessionId: sid, entry: { type: 'message', parentId: null, timestamp: new Date(0).toISOString(), message: { role: 'toolResult', toolCallId: 'tc-ghost', content: [{ type: 'text', text: 'ghost' }], isError: false, timestamp: 0 } } } })

    const msgs = store.getMessages(sid)
    // tc-1 不被误改（仍 running，未被 ghost 的 end 污染）
    expect(msgs[0].toolCalls![0].id).toBe('tc-1')
    expect(msgs[0].toolCalls![0].status).toBe('running')
  })
})

describe('message.complete — 残留 running toolCall 收口', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('U6: 正常 stopReason，残留 running 收口为 end_not_received', () => {
    const store = useChatStore()
    const sid = 's6'
    store.applyMessageEvent(sid, { type: 'message.message_start', payload: { sessionId: sid, messageId: 'a0' } })
    store.applyMessageEvent(sid, { type: 'message.tool_call_start', payload: { sessionId: sid, entry: { type: 'toolCall', toolCallId: 'tc-1', toolName: 'read', arguments: {}, timestamp: new Date(0).toISOString() } } })
    // 跳过 tool_call_end（模拟丢失），直接 complete
    store.applyMessageEvent(sid, { type: 'message.complete', payload: { sessionId: sid, stopReason: 'end_turn' } })

    const msgs = store.getMessages(sid)
    expect(msgs[0].status).toBe('complete')
    expect(msgs[0].toolCalls![0].status).toBe('end_not_received')
  })

  it('U7: error stopReason，残留 running 收口为 error', () => {
    const store = useChatStore()
    const sid = 's7'
    store.applyMessageEvent(sid, { type: 'message.message_start', payload: { sessionId: sid, messageId: 'a0' } })
    store.applyMessageEvent(sid, { type: 'message.tool_call_start', payload: { sessionId: sid, entry: { type: 'toolCall', toolCallId: 'tc-1', toolName: 'read', arguments: {}, timestamp: new Date(0).toISOString() } } })
    store.applyMessageEvent(sid, { type: 'message.complete', payload: { sessionId: sid, stopReason: 'error' } })

    const msgs = store.getMessages(sid)
    expect(msgs[0].status).toBe('error')
    expect(msgs[0].toolCalls![0].status).toBe('error')
  })

  it('U11: 正常到达的 tool_call_end 不被收口覆盖（仍是 completed）', () => {
    const store = useChatStore()
    const sid = 's11'
    store.applyMessageEvent(sid, { type: 'message.message_start', payload: { sessionId: sid, messageId: 'a0' } })
    store.applyMessageEvent(sid, { type: 'message.tool_call_start', payload: { sessionId: sid, entry: { type: 'toolCall', toolCallId: 'tc-1', toolName: 'read', arguments: {}, timestamp: new Date(0).toISOString() } } })
    store.applyMessageEvent(sid, { type: 'message.tool_call_end', payload: { sessionId: sid, entry: { type: 'message', parentId: null, timestamp: new Date(0).toISOString(), message: { role: 'toolResult', toolCallId: 'tc-1', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 0 } } } })
    store.applyMessageEvent(sid, { type: 'message.complete', payload: { sessionId: sid, stopReason: 'end_turn' } })

    const msgs = store.getMessages(sid)
    expect(msgs[0].toolCalls![0].status).toBe('completed') // 未被收口覆盖
    expect(msgs[0].toolCalls![0].output).toBe('ok')
  })
})

describe('end_not_received — 下游消费点', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('U14: messageFormat 复制为 MD 时 end_not_received 加「（未收到结果）」标注', () => {
    const tc: ToolCall = { id: 'tc-1', toolName: 'read', input: {}, status: 'end_not_received', startTime: 0 }
    const msg: Message = { id: 'a1', role: 'assistant', content: '', status: 'complete', toolCalls: [tc], timestamp: 0 }
    const md = assistantToMarkdown(msg)
    expect(md).toContain('未收到结果')
  })

  it('U15: deriveStatus 遇 end_not_received 不返回 waiting（已结束，非进行中）', () => {
    const store = useChatStore()
    const sid = 's15'
    // 最后一条 toolCall 是 end_not_received（已收口，非 running）
    store.hydrate(sid, [{
      id: 'a1', role: 'assistant', content: 'done', status: 'complete',
      toolCalls: [{ id: 'tc-1', toolName: 'read', input: {}, status: 'end_not_received', startTime: 0 }],
      timestamp: Date.now(),
    }])
    // isActive=false（流已结束）
    const status = deriveStatus(sid, store, false)
    expect(status).not.toBe('waiting') // end_not_received 不当 waiting
  })
})

describe('W1: isActive 作为 UI 层 SSOT — deriveStatus 消费 isActive（含 pendingSend 空窗）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('pendingSend 空窗期 deriveStatus 应返回 pending（isActive=true）', () => {
    const store = useChatStore()
    const sid = 's-pending'
    // 用户已提交但 message_start 未到（空窗期）
    store.addPendingSend(sid)
    expect(store.isActive(sid)).toBe(true)
    // deriveStatus 消费 isActive 应返回 pending（已提交待确认，8 态 SSOT）
    const status = deriveStatus(sid, store, true)
    expect(status).toBe('pending')
  })

  it('isActive 不再受 activeId 限定：非活跃 session 的 pendingSend 也应驱动状态', () => {
    // 这个测试验证：即使 session 不是 activeId，只要有 pendingSend，
    // deriveStatus 也应该返回 pending（通过 isActive）
    const store = useChatStore()
    const sid = 's-other'
    // 模拟非活跃 session 有 pendingSend
    store.addPendingSend(sid)
    expect(store.isActive(sid)).toBe(true)
    // 关键：deriveStatus 的第三个参数应该用 isActive，而不是 isGenerating && activeId
    // 修复后：调用方应该传入 isActive，而不是手动计算 isStreaming
    const status = deriveStatus(sid, store, store.isActive(sid))
    // 预期：应返回 pending（因为 isActive=true）
    expect(status).toBe('pending')
  })

  it('isCompacting 独立于 deriveStatus：compact 期间 isActive 仍可驱动 pending', () => {
    const store = useChatStore()
    const sid = 's-compact'
    // 设置 compacting 态
    store.setOccupancy(sid, { turn: 'idle', compacting: true, bash: false })
    expect(store.isCompacting(sid)).toBe(true)
    // 同时有 pendingSend（用户在 compact 期间提交了新消息）
    store.addPendingSend(sid)
    expect(store.isActive(sid)).toBe(true)
    // deriveStatus 第三参数 isActive=true（isCompacting 默认 false 未透传）→ 返回 pending
    const status = deriveStatus(sid, store, true)
    expect(status).toBe('pending')
  })
})
