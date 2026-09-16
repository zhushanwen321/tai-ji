/**
 * dispatchMessageEvent 注册表行为单测（core chat/effects 域，P3 w3 迁移锁定）。
 *
 * 迁自 renderer __tests__/stores/chat-chunk-content-blocks.test.ts 的直接调用模式。
 * [P4 s5 w2] tasks 路由 + openTasksPanelOnFirstData 回调断言随 tasks 域删除移除。
 *
 * 覆盖：
 * - message_start：建 streaming assistant（contentBlocks:[]）
 * - text_delta：append content + push text block（幂等）
 * - thinking_start/end/delta：thinking block 墌量 + endTime
 * - tool_call_start：push toolCall + contentBlocks toolCall 块
 * - tool_call_end：ID 锚定更新 + status/output 填充
 * - sealed guard：finalizeSession 后 text_delta 幂等丢弃（D-010）
 * - customStart：entry 路径喂 applyEntryFrame + display 覆写（W2 entry 化验证）
 * - stream_warn：system 提示行 + liveOnly 标记（W2，pi 无 entry 的 live-only 消息）
 * - compactionSummary：构造 compaction entry 喂 applyEntryFrame（W6 entry 化，最后一条
 *   直插双路径消灭——live 与重开共用 reducer compaction case）
 * - message_end(user) 腿 2 确认制（steer-bubble u1 / D2：inflight 抵消 / includes 兜底
 *   消费 + 剔快照 / 未命中·无快照跳过 / 暂存空纯文本降级）
 * - branchSummary：构造 branch_summary entry 喂 applyEntryFrame（D13 renderer-deepening
 *   entry 化，fallback 与 reducer 收敛一致——live 与重开共用 reducer branch_summary case）
 *
 * 运行：cd packages/core && npx vitest run src/domain/chat/__tests__/effects.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, shallowRef } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { dispatchMessageEvent } from '../effects/registry'
import type { MessageEffectContext } from '../effect-types'
import type { Message, PiBranchSummaryEntry, PiCompactionEntry, PiCustomMessageEntry, Segment, ServerMessage } from '@taiji/shared'

const SID = 's-test'

/** 构造 ctx：真实 vue ref + 回调 mock（D-1 容器：分区值为 ShallowRef<Message[]>） */
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
    drainN: vi.fn(() => []),
    reconcilePending: vi.fn(),
    appendUser: vi.fn(),
    // w21：entry 载体帧喂 reducer 的接入点（store.applyEntryFrame 注入）
    applyEntryFrame: vi.fn(),
    // steer-bubble u1/D2：inflight 确认计数读写（message_end 腿 2 裁决输入，store 注入）
    getInflight: vi.fn(() => 0),
    incrementInflight: vi.fn(),
    decrementInflight: vi.fn(),
    clearInflight: vi.fn(),
    // [premature-timeout §5.2 D2] timeout 打标快照消费/清除（默认无打标 → take 返回空集）
    takePrematureTimeoutIds: vi.fn(() => new Set<string>()),
    clearPrematureTimeoutIds: vi.fn(),
  }
}

function msg(type: string, payload: Record<string, unknown> = {}): ServerMessage {
  return { type, payload: { sessionId: SID, ...payload } } as ServerMessage
}

/** [w21] toolCall entry 形态构造（payload.entry——event-adapter 重构载体） */
function toolCallEntry(fields: { toolCallId: string; toolName: string; arguments: Record<string, unknown>; contentIndex?: number }): Record<string, unknown> {
  return {
    type: 'toolCall',
    toolCallId: fields.toolCallId,
    toolName: fields.toolName,
    arguments: fields.arguments,
    ...(fields.contentIndex !== undefined ? { contentIndex: fields.contentIndex } : {}),
    timestamp: new Date(0).toISOString(),
  }
}

/** [w21] toolResult message entry 形态构造（payload.entry——与 pi 持久化 toolResult entry 同构） */
function toolResultEntry(fields: { toolCallId: string; toolName: string; content: unknown; isError: boolean; details?: Record<string, unknown> }): Record<string, unknown> {
  return {
    type: 'message',
    parentId: null,
    timestamp: new Date(0).toISOString(),
    // content 包 text block 数组（pi 持久化形态，W21 契约）
    message: { role: 'toolResult', toolCallId: fields.toolCallId, toolName: fields.toolName, content: [{ type: 'text', text: String(fields.content) }], isError: fields.isError, ...(fields.details !== undefined ? { details: fields.details } : {}), timestamp: 0 },
  }
}

/**
 * [steer-bubble u1] message_end(user) 帧的 entry 构造（payload.entry——event-adapter
 * 重构形态）。content 用 content parts 数组（P2 探针实证的 pi 投递形态，pi 不 trim）。
 */
function userEndEntry(text: string): Record<string, unknown> {
  return {
    type: 'message',
    parentId: null,
    timestamp: new Date(0).toISOString(),
    message: { role: 'user', content: [{ type: 'text', text }], timestamp: 0 },
  }
}

function getMsgs(ctx: MessageEffectContext): Message[] {
  return ctx.messages.value.get(SID)?.value ?? []
}

function lastAssistant(ctx: MessageEffectContext): Message {
  const list = getMsgs(ctx)
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].role === 'assistant') return list[i]
  }
  throw new Error('no assistant')
}

describe('dispatchMessageEvent 流式 contentBlocks 填充', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('message_start → 新 streaming assistant（contentBlocks:[]）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    const list = getMsgs(ctx)
    expect(list).toHaveLength(1)
    expect(list[0].role).toBe('assistant')
    expect(list[0].status).toBe('streaming')
    expect(list[0].contentBlocks).toEqual([])
  })

  it('text_delta append content + 首次 push text 块（幂等不重复）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: 'hel' }))
    dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: 'lo' }))
    const a = lastAssistant(ctx)
    expect(a.content).toBe('hello')
    expect(a.contentBlocks).toEqual([{ type: 'text', refId: 'text' }])
  })

  it('thinking_start/delta/end：thinking block 墌量 + endTime', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.thinking_start', { thinkingId: 'th1' }))
    dispatchMessageEvent(ctx, SID, msg('message.thinking_delta', { delta: 'reasoning' }))
    dispatchMessageEvent(ctx, SID, msg('message.thinking_end'))
    const a = lastAssistant(ctx)
    expect(a.thinking).toHaveLength(1)
    expect(a.thinking![0].content).toBe('reasoning')
    expect(a.thinking![0].endTime).toBeDefined()
    expect(a.contentBlocks).toContainEqual({ type: 'thinking', refId: 'th1' })
  })

  it('tool_call_start/end：ID 锚定更新 status + output', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc1', toolName: 'read', arguments: { path: '/x' } }) }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_end', { entry: toolResultEntry({ toolCallId: 'tc1', toolName: 'read', content: 'data', isError: false }) }))
    const a = lastAssistant(ctx)
    expect(a.toolCalls).toHaveLength(1)
    expect(a.toolCalls![0].status).toBe('completed')
    expect(a.toolCalls![0].output).toBe('data')
  })

  it('tool_call_update：ID 锚定更新 detail；缺 toolCallId 静默丢弃（W05-A）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc1', toolName: 'bash', arguments: { command: 'npm test' } }) }))

    // 进度更新：detail 写到 ID 锚定的 toolCall 上
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_update', { toolCallId: 'tc1', detail: 'running 3/10' }))
    expect(lastAssistant(ctx).toolCalls![0].detail).toBe('running 3/10')

    // 缺 toolCallId 的坏帧：不抛错、不改既有 toolCalls
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_update', { detail: 'orphan' }))
    expect(lastAssistant(ctx).toolCalls).toHaveLength(1)
    expect(lastAssistant(ctx).toolCalls![0].detail).toBe('running 3/10')
  })

  // ── [bash-running-stream-output U2] output/outputRaw 条件写入 ──
  it('tool_call_update：output/outputRaw 条件写入；字段缺省不触碰既有值', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc1', toolName: 'bash', arguments: { command: 'npm test' } }) }))

    dispatchMessageEvent(ctx, SID, msg('message.tool_call_update', { toolCallId: 'tc1', detail: 'running', output: 'step-1\n', outputRaw: '\x1b[32mstep-1\x1b[0m\n' }))
    const tc = lastAssistant(ctx).toolCalls![0]
    expect(tc.output).toBe('step-1\n')
    expect(tc.outputRaw).toBe('\x1b[32mstep-1\x1b[0m\n')

    // 缺 output/outputRaw 的帧（mock string detail）：条件写入不触发，既有值保留
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_update', { toolCallId: 'tc1', detail: 'running 3/10' }))
    const tc2 = lastAssistant(ctx).toolCalls![0]
    expect(tc2.output).toBe('step-1\n')
    expect(tc2.outputRaw).toBe('\x1b[32mstep-1\x1b[0m\n')
    expect(tc2.detail).toBe('running 3/10')

    // 畸形 payload（output 非字符串）：readString 降级 undefined → 不写
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_update', { toolCallId: 'tc1', output: 123, outputRaw: { bad: true } }))
    const tc3 = lastAssistant(ctx).toolCalls![0]
    expect(tc3.output).toBe('step-1\n')
    expect(tc3.outputRaw).toBe('\x1b[32mstep-1\x1b[0m\n')
  })

  it('tool_call_update：detail 保持现状无条件覆盖语义（缺 detail 帧清空旧值）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc1', toolName: 'bash', arguments: { command: 'ls' } }) }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_update', { toolCallId: 'tc1', detail: 'old detail' }))
    expect(lastAssistant(ctx).toolCalls![0].detail).toBe('old detail')
    // 缺 detail 的帧：无条件 spread 写 undefined（清空），与改动前现状一致
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_update', { toolCallId: 'tc1', output: 'x' }))
    const tc = lastAssistant(ctx).toolCalls![0]
    expect(tc.detail).toBeUndefined()
    expect(tc.output).toBe('x')
  })

  it('tool_call_update → tool_call_end：end 无条件覆盖 output（running output 不影响终态）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc1', toolName: 'bash', arguments: { command: 'npm test' } }) }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_update', { toolCallId: 'tc1', detail: 'running', output: 'partial output', outputRaw: 'partial raw' }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_end', { entry: toolResultEntry({ toolCallId: 'tc1', toolName: 'bash', content: 'final full output', isError: false }) }))
    const tc = lastAssistant(ctx).toolCalls![0]
    expect(tc.status).toBe('completed')
    expect(tc.output).toBe('final full output')
  })

  // [bash-running-stream-output U2 fix] end 无 ANSI 时清空 running outputRaw
  it('tool_call_update → tool_call_end：end 无 ANSI 清空 running outputRaw（live ≡ reload）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc1', toolName: 'bash', arguments: { command: 'npm test' } }) }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_update', { toolCallId: 'tc1', detail: 'running', output: 'partial\n', outputRaw: '\x1b[31mred\x1b[0m\n' }))
    // end 文本无 ANSI：normalizePiToolResult 不产出 outputRaw，但 end 有 content 须显式清空残留
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_end', { entry: toolResultEntry({ toolCallId: 'tc1', toolName: 'bash', content: 'Error: command failed', isError: true }) }))
    const tc = lastAssistant(ctx).toolCalls![0]
    expect(tc.outputRaw).toBeUndefined()
    expect(tc.output).toBe('Error: command failed')
  })

  it('tool_call_update → tool_call_end：end 带 ANSI 时 outputRaw 正常写入', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc1', toolName: 'bash', arguments: { command: 'npm test' } }) }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_update', { toolCallId: 'tc1', detail: 'running', output: 'partial\n', outputRaw: '\x1b[31mred\x1b[0m\n' }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_end', { entry: toolResultEntry({ toolCallId: 'tc1', toolName: 'bash', content: '\x1b[32mok done\x1b[0m\n', isError: false }) }))
    const tc = lastAssistant(ctx).toolCalls![0]
    expect(tc.outputRaw).toBe('\x1b[32mok done\x1b[0m\n')
    expect(tc.output).toBe('ok done\n')
  })

  it('sealed guard：finalizeSession 收口后 text_delta 幂等丢弃（D-010）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: 'before' }))
    // 模拟 finalizeSession 把 assistant 改为 complete（sealed）——同 sid 走内层 ref 数组替换
    const list = getMsgs(ctx)
    ctx.messages.value.get(SID)!.value = list.map(m => m.role === 'assistant' ? { ...m, status: 'complete' as const } : m)
    dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: 'AFTER' }))
    // 收口后 delta 被丢弃，content 不变
    expect(lastAssistant(ctx).content).toBe('before')
  })

  // ── §11 检查点 3：两条 contentBlocks 填充路径顺序语义统一 ──
  // streaming 事件序列（本文件）与持久化 content array（runtime message-converter 测试）
  // 对同一消息内容必须产生一致顺序。真实 pi 事件流：模型输出 tool_use 时发 toolcall_start
  // （带 contentIndex），text_delta 实时到达，tool_execution_start（工具执行）最后到——
  // 故「text 在 tool 之后」时事件到达顺序是 [thinking, text, tool]，但 contentIndex 顺序是
  // [thinking(0), toolCall(1), text(2)]。前端按 contentIndex 有序插入，结果与持久化路径一致。

  it('顺序统一：text 在 tool 之后时按 contentIndex 插入（与持久化路径一致）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    // 事件到达顺序：thinking → text（模型先输出 thinking，再输出 tool_use，turn 结束后才执行工具）
    dispatchMessageEvent(ctx, SID, msg('message.thinking_start', { thinkingId: 'th1', contentIndex: 0 }))
    dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: 'answer', contentIndex: 2 }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc1', toolName: 'read', arguments: { path: '/x' }, contentIndex: 1 }) }))
    const a = lastAssistant(ctx)
    expect(a.contentBlocks).toEqual([
      { type: 'thinking', refId: 'th1', contentIndex: 0 },
      { type: 'toolCall', refId: 'tc1', contentIndex: 1 },
      { type: 'text', refId: 'text', contentIndex: 2 },
    ])
  })

  it('顺序统一：text 在 tool 之前时按 contentIndex 插入（append 等价，行为不变）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: 'let me check', contentIndex: 0 }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc1', toolName: 'read', arguments: { path: '/x' }, contentIndex: 1 }) }))
    const a = lastAssistant(ctx)
    expect(a.contentBlocks).toEqual([
      { type: 'text', refId: 'text', contentIndex: 0 },
      { type: 'toolCall', refId: 'tc1', contentIndex: 1 },
    ])
  })

  it('顺序统一：无 contentIndex 时退化为 append（旧事件兼容）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.thinking_start', { thinkingId: 'th1' }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc1', toolName: 'read', arguments: {} }) }))
    dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: 'text' }))
    const a = lastAssistant(ctx)
    expect(a.contentBlocks).toEqual([
      { type: 'thinking', refId: 'th1' },
      { type: 'toolCall', refId: 'tc1' },
      { type: 'text', refId: 'text' },
    ])
  })

  it('顺序统一：多 tool 交错的 contentIndex 插入（thinking0/tool1/text2/tool3）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.thinking_start', { thinkingId: 'th1', contentIndex: 0 }))
    dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: 'mid', contentIndex: 2 }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc1', toolName: 'read', arguments: {}, contentIndex: 1 }) }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc2', toolName: 'grep', arguments: {}, contentIndex: 3 }) }))
    const a = lastAssistant(ctx)
    expect(a.contentBlocks).toEqual([
      { type: 'thinking', refId: 'th1', contentIndex: 0 },
      { type: 'toolCall', refId: 'tc1', contentIndex: 1 },
      { type: 'text', refId: 'text', contentIndex: 2 },
      { type: 'toolCall', refId: 'tc2', contentIndex: 3 },
    ])
  })
})

describe('message.queue_update handler 退役（投递所有权内核 u3b / D7）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  // queue_update 帧降级为内核内部回执（runtime 侧消费），不再直驱 renderer UI：
  // 前身计数腿（countDrained 差集 → drainN 计数 FIFO → appendUser + inflight +m）与
  // queueStates 快照写入整体退役；队列区数据源 = session.delivery 状态帧（内核 state
  // topic 快照，useChat.handleSessionDelivery 消费）。未注册 type 经 dispatchMessageEvent
  // 直接 no-op——本 describe 锁定「零消费」的退役终态。

  it('RET-1: queue_update 帧零消费（drainN/appendUser/inflight/reconcilePending 全不触）', () => {
    const ctx = makeCtx()
    ctx.queueStates.value = new Map([[SID, { steering: ['adjust plan'] }]])

    dispatchMessageEvent(ctx, SID, msg('message.queue_update', { steering: [] }))

    expect(ctx.drainN).not.toHaveBeenCalled()
    expect(ctx.appendUser).not.toHaveBeenCalled()
    expect(ctx.incrementInflight).not.toHaveBeenCalled()
    expect(ctx.reconcilePending).not.toHaveBeenCalled()
  })

  it('RET-2: queueStates 快照不再被写入/删除（快照分区已无生产写方，store 侧退役归 u5）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.queue_update', { steering: ['a', 'b'] }))
    expect(ctx.queueStates.value.has(SID)).toBe(false)
  })
})

describe('dispatchMessageEvent message.customStart 完成通知 display 覆写（M2 display 前置）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  /** customStart 追加消息的便捷断言：返回最后一条 system 消息 */
  function lastSystem(ctx: MessageEffectContext): Message {
    const list = getMsgs(ctx)
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].role === 'system') return list[i]
    }
    throw new Error('no system message')
  }

  it('TC1: subagent-bg-notify（完成通知）→ display 覆写为 false（即使 pi 扩展透传 display:true）', () => {
    const ctx = makeCtx()
    // pi-subagent-workflow notifier 生产端写 display:true（pi 原生语义）——消费端必须覆写
    dispatchMessageEvent(ctx, SID, msg('message.customStart', {
      customType: 'subagent-bg-notify',
      content: '子代理完成',
      display: true,
      details: { id: 'job-1', status: 'done', agent: 'coder', startedAt: 1000, endedAt: 2000 },
    }))

    const m = lastSystem(ctx)
    expect(m.customType).toBe('subagent-bg-notify')
    expect(m.display).toBe(false)
    // details 原始字段仍保留（消息进 store 供 fork/compact/replay 等其他消费）
    expect(m.details).toEqual({ id: 'job-1', status: 'done', agent: 'coder', startedAt: 1000, endedAt: 2000 })
  })

  it('TC2: workflow-result（完成通知）→ display 覆写为 false', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.customStart', {
      customType: 'workflow-result',
      content: 'run done',
      display: true,
    }))

    const m = lastSystem(ctx)
    expect(m.customType).toBe('workflow-result')
    expect(m.display).toBe(false)
  })

  it('TC3: 非完成通知 customType → display 原样透传（三态保留，undefined 安全显示）', () => {
    const ctx = makeCtx()
    // goal/todo context 类：pi 扩展声明 display:false → 透传隐藏
    dispatchMessageEvent(ctx, SID, msg('message.customStart', {
      customType: 'goal-context',
      content: '<goal_context>...',
      display: false,
    }))
    // 普通通知：display:true → 透传显示
    dispatchMessageEvent(ctx, SID, msg('message.customStart', {
      customType: 'future-extension-notify',
      content: '显示',
      display: true,
    }))
    // 无 display 字段 → undefined（!== false 即显示）
    dispatchMessageEvent(ctx, SID, msg('message.customStart', {
      customType: 'legacy-notify',
      content: 'legacy',
    }))

    const list = getMsgs(ctx)
    const sys = list.filter((m) => m.role === 'system')
    expect(sys[0].display).toBe(false)
    expect(sys[1].display).toBe(true)
    expect(sys[2].display).toBeUndefined()
  })

  it('TC4: entry 路径——customStart 构造 custom_message entry 喂 applyEntryFrame（与重开重放同构）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.customStart', {
      customType: 'subagent-bg-notify',
      content: 'x',
      display: true,
      details: { id: 'job-9' },
    }))
    // 喂入点：与文件重放（get_entries → replayEntries）同一个 applyEntry reducer
    expect(ctx.applyEntryFrame).toHaveBeenCalledTimes(1)
    const entry = vi.mocked(ctx.applyEntryFrame).mock.calls[0][1] as PiCustomMessageEntry
    expect(entry.type).toBe('custom_message')
    expect(entry.customType).toBe('subagent-bg-notify')
    expect(entry.content).toBe('x')
    expect(entry.display).toBe(true)
    expect(entry.details).toEqual({ id: 'job-9' })
    // ref 消息来自同一 entry 的 applyEntry 派生（display:false 覆写在 reducer 单点生效——
    // live ≡ reload 等价由 custom-start-equivalence.test.ts 全量锁定）
    expect(lastSystem(ctx).display).toBe(false)
  })
})

describe('dispatchMessageEvent message.stream_warn（W2 liveOnly 标记）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('stream_warn → system 提示行入消息流 + liveOnly:true（pi 无 entry、重开即消失）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.stream_warn', { content: 'pi 静默卡死预警' }))
    const list = getMsgs(ctx)
    expect(list).toHaveLength(1)
    expect(list[0].role).toBe('system')
    expect(list[0].content).toBe('pi 静默卡死预警')
    expect(list[0].status).toBe('complete')
    // liveOnly（全仓唯一写入点）：分组层据此归 turn 内 notice（W3 消费），不参与
    // live≡reload 等价性断言——pi 无对应 entry，直插即本类消息的正确入流路径
    expect(list[0].liveOnly).toBe(true)
  })

  it('payload 无 content → 兜底文案；liveOnly 仍置位', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.stream_warn'))
    const list = getMsgs(ctx)
    expect(list).toHaveLength(1)
    expect(list[0].content).toBe('长时间无响应')
    expect(list[0].liveOnly).toBe(true)
  })
})

describe('dispatchMessageEvent message.compactionSummary（W6 entry 化——消灭最后一条直插双路径）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('帧 → 构造 compaction entry 喂 applyEntryFrame（与重开 compaction entry 同构）+ overlay system 行', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.compactionSummary', {
      summary: '压缩摘要',
      tokensBefore: 12345,
      timestamp: 8000,
    }))
    // 喂入点：与文件重放（get_entries → replayEntries）同一个 applyEntry reducer
    expect(ctx.applyEntryFrame).toHaveBeenCalledTimes(1)
    const entry = vi.mocked(ctx.applyEntryFrame).mock.calls[0][1] as PiCompactionEntry
    expect(entry.type).toBe('compaction')
    expect(entry.id).toMatch(/^cmp-/)
    expect(entry.summary).toBe('压缩摘要')
    expect(entry.tokensBefore).toBe(12345)
    // 帧 timestamp（ms）→ entry ISO（reducer compaction case toMs 往返）
    expect(entry.timestamp).toBe(new Date(8000).toISOString())
    // overlay 投影：system 压缩行（用户可见行为——live 与重开同款，live≡reload 归一
    // deep-equal 由 apply-entry-equivalence E4 锁定）
    const list = getMsgs(ctx)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      role: 'system',
      content: '压缩摘要',
      status: 'complete',
      timestamp: 8000,
      compactionSummary: { summary: '压缩摘要', tokensBefore: 12345 },
    })
  })

  it('帧缺 summary/tokensBefore → entry 不含可选字段，overlay 走 reducer 中文 fallback（W6 由英文占位收敛，与重开一致）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.compactionSummary', {}))
    expect(ctx.applyEntryFrame).toHaveBeenCalledTimes(1)
    const entry = vi.mocked(ctx.applyEntryFrame).mock.calls[0][1] as PiCompactionEntry
    expect(entry.type).toBe('compaction')
    expect(entry.summary).toBeUndefined()
    expect(entry.tokensBefore).toBeUndefined()
    // reducer compaction case 的 fallback：'上下文已压缩'（旧直插路径为英文占位
    // 'Context compacted'——entry 化后两路径共用 reducer，文案归一）
    const list = getMsgs(ctx)
    expect(list[0].content).toBe('上下文已压缩')
    expect(list[0].compactionSummary).toMatchObject({ summary: undefined, tokensBefore: undefined })
  })
})

describe('dispatchMessageEvent message.branchSummary（D13 renderer-deepening entry 化——fallback 与 reducer 收敛一致）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('帧 → 构造 branch_summary entry 喂 applyEntryFrame（与重开 branch_summary entry 同构）+ overlay system 行', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.branchSummary', {
      summary: '分支摘要',
      fromId: 'msg-9',
      timestamp: 6000,
    }))
    // 喂入点：与文件重放（get_entries → replayEntries）同一个 applyEntry reducer
    expect(ctx.applyEntryFrame).toHaveBeenCalledTimes(1)
    const entry = vi.mocked(ctx.applyEntryFrame).mock.calls[0][1] as PiBranchSummaryEntry
    expect(entry.type).toBe('branch_summary')
    expect(entry.id).toMatch(/^br-/)
    expect(entry.summary).toBe('分支摘要')
    expect(entry.fromId).toBe('msg-9')
    // 帧 timestamp（ms）→ entry ISO（reducer branch_summary case toMs 往返）
    expect(entry.timestamp).toBe(new Date(6000).toISOString())
    // overlay 投影：system 分支行（用户可见行为——live 与重开同款，live≡reload 归一
    // deep-equal 由 branch-summary-equivalence.test.ts 全量锁定）
    const list = getMsgs(ctx)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      role: 'system',
      content: '分支摘要',
      status: 'complete',
      timestamp: 6000,
      branchSummary: { summary: '分支摘要', fromId: 'msg-9', timestamp: 6000 },
    })
  })

  it('帧缺 summary → entry 不含可选字段，overlay 走 reducer fallback 空串（旧直插路径英文占位 Branched 由 D13 声明收敛，live ≡ reload）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.branchSummary', { fromId: 'n-1' }))
    expect(ctx.applyEntryFrame).toHaveBeenCalledTimes(1)
    const entry = vi.mocked(ctx.applyEntryFrame).mock.calls[0][1] as PiBranchSummaryEntry
    expect(entry.type).toBe('branch_summary')
    expect(entry.summary).toBeUndefined()
    // reducer branch_summary case 的 fallback：空串（与重开 `rawSummary ?? ''` 一致）
    const list = getMsgs(ctx)
    expect(list).toHaveLength(1)
    expect(list[0].content).toBe('')
    expect(list[0].branchSummary).toMatchObject({ summary: undefined, fromId: 'n-1' })
  })

  it('空串 summary 透传（readBranchSummary 空串门）→ content 保留空行（compaction E4c 同族分叉预防）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.branchSummary', { summary: '', timestamp: 7000 }))
    const entry = vi.mocked(ctx.applyEntryFrame).mock.calls[0][1] as PiBranchSummaryEntry
    expect(entry.summary).toBe('')
    const list = getMsgs(ctx)
    expect(list[0].content).toBe('')
    expect(list[0].branchSummary).toMatchObject({ summary: '' })
  })
})

describe('message.complete error 路径的 errorMessage 可见性（模型 400 秒败回归）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('streaming 气泡收口：errorMessage 写入最后一条 assistant 的 error 字段（追加形态）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: '部分正文' }))
    dispatchMessageEvent(ctx, SID, msg('message.complete', {
      stopReason: 'error',
      errorMessage: '400: {"code":"400","message":"Unsupported model mimo-v2-pro"}',
    }))
    const a = lastAssistant(ctx)
    expect(a.status).toBe('error')
    expect(a.content).toBe('部分正文')
    expect(a.error).toBe('400: {"code":"400","message":"Unsupported model mimo-v2-pro"}')
  })

  it('无 streaming 气泡（message_start 丢失）：errorMessage 追加为纯 error 气泡', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.complete', {
      stopReason: 'error',
      errorMessage: '400: Unsupported model mimo-v2-pro',
    }))
    const list = getMsgs(ctx)
    expect(list).toHaveLength(1)
    expect(list[0].role).toBe('assistant')
    expect(list[0].status).toBe('error')
    expect(list[0].content).toBe('400: Unsupported model mimo-v2-pro')
  })

  it('非 error stopReason 不消费 errorMessage 字段（正常完成不受影响）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: 'ok' }))
    dispatchMessageEvent(ctx, SID, msg('message.complete', {
      stopReason: 'stop',
      content: 'ok',
      errorMessage: undefined,
    }))
    const a = lastAssistant(ctx)
    expect(a.status).toBe('complete')
    expect(a.error).toBeUndefined()
  })
})

// ── message.complete 收口矩阵（registry next 回调靶子：多气泡收口 / usage·content 末条定位）──
//
// [HISTORICAL] 一个 turn 可产出多个 streaming assistant 气泡（工具调用气泡 + 文字总结气泡）：
// handler 的 map 回调必须收口**所有** status==='streaming' 的 assistant，而 usage / 权威
// content / errorMessage 只回填最后一条（turn 级聚合）。只收最后一条的历史形态会让前面的
// toolCall 气泡永远 streaming；把 usage 回填到非末 assistant 则语义错位。

describe('message.complete 收口矩阵：多 streaming 气泡全收口 + turn 级聚合字段只落末条', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('多 streaming 气泡（toolCall 气泡 + 文字气泡）全部收口；usage 只回填最后一条 assistant', () => {
    const ctx = makeCtx()
    // 气泡 1：含 running toolCall 的 assistant（工具调用气泡）
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc1', toolName: 'read', arguments: { path: '/x' } }) }))
    // 气泡 2：文字总结气泡（同 turn 第二个 assistant）
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a2' }))
    dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: '总结' }))

    dispatchMessageEvent(ctx, SID, msg('message.complete', {
      stopReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 50 },
    }))

    const list = getMsgs(ctx)
    expect(list).toHaveLength(2)
    // 两个气泡都收口（历史 bug：只收最后一条 → toolCall 气泡永远 streaming）
    expect(list[0].status).toBe('complete')
    expect(list[1].status).toBe('complete')
    // usage 是 turn 级聚合：只回填最后一条 assistant（回填到非末条语义错位）
    expect(list[0].usage).toBeUndefined()
    expect(list[1].usage).toEqual({ inputTokens: 100, outputTokens: 50 })
  })

  it('权威 content 覆盖最后一条 assistant（末 delta 异步渲染竞态防线）；非末气泡 content 不动', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: '部分正文未闭合' }))
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a2' }))
    dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: '流式累积' }))

    dispatchMessageEvent(ctx, SID, msg('message.complete', {
      stopReason: 'stop',
      content: '权威完整正文 **已闭合**',
    }))

    const list = getMsgs(ctx)
    // 末条被权威源覆盖（强制 MarkdownRenderer watch 重新渲染）
    expect(list[1].content).toBe('权威完整正文 **已闭合**')
    // 非末条不在覆盖范围（finalContent 只定位 lastAssistantIdx）
    expect(list[0].content).toBe('部分正文未闭合')
  })

  it('abort 路径 payload 无 content → 保留客户端流式累积值（空串不覆盖）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.text_delta', { delta: '中断前正文' }))
    // abort：runtime 不带 content（权威覆盖仅在非空时生效）
    dispatchMessageEvent(ctx, SID, msg('message.complete', { stopReason: 'aborted', content: '' }))
    const a = lastAssistant(ctx)
    expect(a.content).toBe('中断前正文')
    expect(a.status).toBe('complete')
  })
})

// ── tool_call_end 降级与错误形态（registry message.tool_call_end 靶子）──

describe('dispatchMessageEvent tool_call_end 异常帧降级与错误收口', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('entry 缺失 / type 非 message → 整帧降级丢弃（reducer 不喂、消息流不动）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc1', toolName: 'read', arguments: {} }) }))

    dispatchMessageEvent(ctx, SID, msg('message.tool_call_end', {}))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_end', { entry: { type: 'compaction', summary: 'x' } }))

    // 两帧都静默丢弃：reducer 未喂、toolCall 保持 running
    expect(ctx.applyEntryFrame).not.toHaveBeenCalled()
    expect(lastAssistant(ctx).toolCalls![0].status).toBe('running')
  })

  it('isError toolResult → status:"error" + error 字段（实时失败必须可见，Block.vue isFailed 判定输入）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc1', toolName: 'bash', arguments: { command: 'exit 1' } }) }))

    dispatchMessageEvent(ctx, SID, msg('message.tool_call_end', { entry: toolResultEntry({ toolCallId: 'tc1', toolName: 'bash', content: 'command failed', isError: true }) }))

    const tc = lastAssistant(ctx).toolCalls![0]
    // [HISTORICAL] 实时失败的 tool call 必须带 status:'error'（与重放路径 reducer 一致），
    // 否则前端 isFailed 恒 false（恒显示成功）；error 字段承载失败正文
    expect(tc.status).toBe('error')
    expect(tc.output).toBe('command failed')
    expect(tc.error).toBe('command failed')
  })

  it('entry.message.content 缺失 → 保留 running 期间旧 output（异常帧不抹掉已见数据）', () => {
    // 预置：带过程 output 的 running toolCall（progress/前序 update 场景的既有形态）
    const initial: Message[] = [{
      id: 'a1',
      role: 'assistant',
      content: '',
      status: 'streaming',
      timestamp: 0,
      toolCalls: [{ id: 'tc1', toolName: 'read', input: {}, status: 'running', startTime: 0, output: 'progress-1' }],
    }]
    const ctx = makeCtx(initial)

    const noContentEntry = {
      type: 'message',
      parentId: null,
      timestamp: new Date(0).toISOString(),
      message: { role: 'toolResult', toolCallId: 'tc1', toolName: 'read', isError: false, timestamp: 0 },
    }
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_end', { entry: noContentEntry }))

    const tc = lastAssistant(ctx).toolCalls![0]
    // content undefined（mock/异常帧）→ 不覆盖已有 output，但 status 照常收口
    expect(tc.status).toBe('completed')
    expect(tc.output).toBe('progress-1')
  })

  it('toolCallId 缺失 → 降级定位最后一条 assistant 回填（防御：兼容异常事件不断流）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_start', { entry: toolCallEntry({ toolCallId: 'tc1', toolName: 'read', arguments: {} }) }))

    // 异常帧：toolCallId 缺失（无 ID 锚点）→ fallback findLastAssistantIndex 定位
    const noCallIdEntry = {
      type: 'message',
      parentId: null,
      timestamp: new Date(0).toISOString(),
      message: { role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: 'data' }], isError: false, timestamp: 0 },
    }
    dispatchMessageEvent(ctx, SID, msg('message.tool_call_end', { entry: noCallIdEntry }))

    // toolCall 气泡本身收口为 complete（callId 匹配分支不命中则 status 不变——
    // 降级路径只保证不崩、reducer 照常喂入；此处锚定「不抛 + 帧被消费」的用户可见行为）
    expect(ctx.applyEntryFrame).toHaveBeenCalledTimes(1)
    expect(getMsgs(ctx)).toHaveLength(1)
  })
})

// ── [投递所有权内核 u3b] message_end(user) 投递确认收敛（原三分支 → 两分支）──
// ① 内核送达回执（标记 id 匹配投影条目）→ ② 纯计数兜底。① 的正测在
// effects-delivery-receipt.test.ts（含投影/morph 段/inflight 回收/幂等），此处锁定
// ② 计数兜底与「③ includes 兜底/drainN 消费已退役」的零消费终态。

describe('dispatchMessageEvent message_end(user) 投递确认收敛（u3b：①回执 + ②计数兜底）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('无标记帧 + inflight > 0 → ② 纯计数 decrement（乐观气泡已显示，防重复入流）', () => {
    const ctx = makeCtx()
    vi.mocked(ctx.getInflight).mockReturnValue(1)
    ctx.queueStates.value = new Map([[SID, { steering: ['T'] }]])

    dispatchMessageEvent(ctx, SID, msg('message.message_end', { entry: userEndEntry('T') }))

    expect(ctx.decrementInflight).toHaveBeenCalledWith(SID, 1)
    expect(ctx.appendUser).not.toHaveBeenCalled()
    // 快照分区已无生产写方（queue_update 退役），本 handler 也不再读它
    expect(ctx.queueStates.value.get(SID)).toEqual({ steering: ['T'] })
    // 权威 reducer 喂入无条件保留
    expect(ctx.applyEntryFrame).toHaveBeenCalledTimes(1)
  })

  it('无标记帧 + inflight == 0 → 零消费（外来/历史帧静默终止）', () => {
    const ctx = makeCtx()

    dispatchMessageEvent(ctx, SID, msg('message.message_end', { entry: userEndEntry('any') }))

    expect(ctx.drainN).not.toHaveBeenCalled()
    expect(ctx.appendUser).not.toHaveBeenCalled()
    expect(ctx.decrementInflight).not.toHaveBeenCalled()
    expect(ctx.applyEntryFrame).toHaveBeenCalledTimes(1)
  })

  it('RET: ③ includes 兜底/drainN 消费已退役——queueStates 快照内容不再驱动任何入流', () => {
    const ctx = makeCtx()
    const segs: Segment[] = [{ type: 'text', text: 'T' }]
    vi.mocked(ctx.drainN).mockReturnValue([segs])
    ctx.queueStates.value = new Map([[SID, { steering: ['T', 'T'] }]])
    vi.mocked(ctx.getInflight).mockReturnValue(0)

    dispatchMessageEvent(ctx, SID, msg('message.message_end', { entry: userEndEntry('T') }))

    // 前身：includes 命中 → drainN(1) + appendUser + 剔快照——整体退役（计数腿 D7）
    expect(ctx.drainN).not.toHaveBeenCalled()
    expect(ctx.appendUser).not.toHaveBeenCalled()
    expect(ctx.queueStates.value.get(SID)).toEqual({ steering: ['T', 'T'] })
  })
})

// ── [投递所有权内核 u3b 退役] message_start 的 G-023 条件清 + reconcilePending 僵尸清理 ──
// queueStates 快照与 pendingBuffer 计数腿已随内核退役（队列区数据源 = session.delivery
// 状态帧）；message_start 只保留 streaming assistant 建立 + clearPendingSend + armStreamingTimer。

describe('dispatchMessageEvent message_start（u3b：快照/僵尸清理腿退役，streaming 链路不变）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('RET: 不再读/写/删 queueStates，不再调 reconcilePending', () => {
    const ctx = makeCtx()
    ctx.queueStates.value = new Map([[SID, { followUp: ['f1'] }]])

    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))

    expect(ctx.queueStates.value.get(SID)).toEqual({ followUp: ['f1'] })
    expect(ctx.reconcilePending).not.toHaveBeenCalled()
  })

  it('streaming assistant 照常建立（contentBlocks:[]）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg('message.message_start', { messageId: 'a1' }))
    expect(getMsgs(ctx)).toHaveLength(1)
    expect(lastAssistant(ctx).status).toBe('streaming')
    expect(lastAssistant(ctx).contentBlocks).toEqual([])
  })
})

describe('dispatchMessageEvent message.complete abort 清理（u3b：确认基线复位，D10 队列不取消）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('stopReason=aborted → 只 clearInflight；pendingBuffer/queueStates 保留（pi 队列跨 abort 存活）', () => {
    const ctx = makeCtx()
    ctx.queueStates.value = new Map([[SID, { followUp: ['f1'] }]])

    dispatchMessageEvent(ctx, SID, msg('message.complete', { stopReason: 'aborted' }))

    // D4 修订（Gate B 实测 2026-08-30）：pi abort() 不清队列，残余在下一 prompt 投递——
    // buffer 与快照是 pi 存活队列的前端镜像，保留供两腿消费；只清确认计数（已显示未
    // 确认条目不会再有 message_end，残留会吞掉后续确认配额）。
    expect(ctx.reconcilePending).not.toHaveBeenCalled()
    expect(ctx.clearInflight).toHaveBeenCalledWith(SID)
    expect(ctx.queueStates.value.get(SID)).toEqual({ followUp: ['f1'] })
    // 通用收口照常（清理在 finalizeSession 之外显式做，不替代收口）
    expect(ctx.finalizeSession).toHaveBeenCalledWith(SID, 'aborted')
  })

  it('aborted 且快照无条目 → clearInflight 幂等无副作用', () => {
    const ctx = makeCtx()

    dispatchMessageEvent(ctx, SID, msg('message.complete', { stopReason: 'aborted' }))

    expect(ctx.clearInflight).toHaveBeenCalledWith(SID)
    expect(ctx.reconcilePending).not.toHaveBeenCalled()
    expect(ctx.queueStates.value.has(SID)).toBe(false)
  })

  it('normal（stopReason=stop）不触发清理（finalizeSession 是通用收口，normal/error 不清）', () => {
    const ctx = makeCtx()
    ctx.queueStates.value = new Map([[SID, { followUp: ['f1'] }]])

    dispatchMessageEvent(ctx, SID, msg('message.complete', { stopReason: 'stop' }))

    expect(ctx.reconcilePending).not.toHaveBeenCalled()
    expect(ctx.clearInflight).not.toHaveBeenCalled()
    expect(ctx.queueStates.value.get(SID)).toEqual({ followUp: ['f1'] })
  })

  it('error stopReason 同样不清（abort 是唯一清理出口）', () => {
    const ctx = makeCtx()
    ctx.queueStates.value = new Map([[SID, { followUp: ['f1'] }]])

    dispatchMessageEvent(ctx, SID, msg('message.complete', { stopReason: 'error', errorMessage: 'x' }))

    expect(ctx.reconcilePending).not.toHaveBeenCalled()
    expect(ctx.clearInflight).not.toHaveBeenCalled()
    expect(ctx.queueStates.value.get(SID)).toEqual({ followUp: ['f1'] })
  })
})
