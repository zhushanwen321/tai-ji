/**
 * streaming-state-machine 独立单测（B6 深模块）。
 *
 * 直接调 createStreamingStateMachine 工厂：refs 用 vue 原语构造，commitMessages /
 * findLastAssistantIndex 走真实实现（mutations / chunk-processor），clearOccupancy /
 * setHandingOff 用 vi.fn()——不 mock 被测模块内部依赖，避免假绿。
 * store.test.ts 保留为 createChatStore 委托后的集成回归（行为等价锁定）。
 */
import { describe, it, expect, vi } from 'vitest'
import type { ShallowRef } from 'vue'
import { ref, shallowRef } from 'vue'
import type { Message } from '@taiji/shared'
import type { SessionOccupancyState } from '../store'
import { createStreamingStateMachine } from '../streaming-state-machine'

/** 构造 streaming assistant 消息（可选 overrides） */
function streamingAssistant(id: string, overrides: Partial<Message> = {}): Message {
  return { id, role: 'assistant', content: '', status: 'streaming', timestamp: 1, ...overrides }
}

/** 构造 bash 消息（role:'system' + bashExecution，生命周期独立管理） */
function bashMsg(id: string): Message {
  return { id, role: 'system', content: '', status: 'streaming', timestamp: 1, bashExecution: {} as Message['bashExecution'] }
}

/** 构造 running toolCall */
function runningToolCall(id: string) {
  return { id, toolName: 'read', input: {}, status: 'running' as const, startTime: 1 }
}

function makeMachine() {
  // W10 D-1 容器范式：外层 Map 恒等稳定，每 sid 分区是独立 ShallowRef
  const messages = shallowRef<Map<string, ShallowRef<Message[]>>>(new Map())
  const occupancies = ref<Map<string, SessionOccupancyState>>(new Map())
  const handingOffSessions = ref<Set<string>>(new Set())
  const retryStates = ref<Map<string, unknown>>(new Map())
  const queueStates = ref<Map<string, unknown>>(new Map())
  const pendingSend = ref<Set<string>>(new Set())
  const clearOccupancy = vi.fn<(sessionId: string) => void>()
  const setHandingOff = vi.fn<(sessionId: string, value: boolean) => void>()
  const sm = createStreamingStateMachine({
    messages,
    occupancies,
    handingOffSessions,
    retryStates,
    queueStates,
    pendingSend,
    clearOccupancy,
    setHandingOff,
  })
  return { sm, messages, retryStates, queueStates, clearOccupancy, setHandingOff }
}

describe('applySubagentStreamDelta', () => {
  it('TC1 替换路径：已有 streaming assistant 时替换 content，text block 幂等不重复 push', () => {
    const { sm, messages } = makeMachine()
    const existing = streamingAssistant('a1', { content: 'old', contentBlocks: [{ type: 'text', refId: 'text' }] })
    messages.value = new Map([['subagent:x', shallowRef([existing])]])

    sm.applySubagentStreamDelta('subagent:x', ['line1', 'line2'])

    const after = messages.value.get('subagent:x')!.value
    expect(after).toHaveLength(1) // 不新增消息
    expect(after[0].id).toBe('a1') // 同一消息
    expect(after[0].content).toBe('line1\nline2') // 替换非追加
    expect(after[0].contentBlocks?.filter((b) => b.type === 'text')).toHaveLength(1) // text 块幂等
    expect(after[0].status).toBe('streaming')
  })

  it('TC2 新建路径：无 streaming assistant 时 push sa- 新消息', () => {
    const { sm, messages } = makeMachine()
    messages.value = new Map([['subagent:x', shallowRef([streamingAssistant('a1', { status: 'complete' })])]]) // 最后 assistant 已 complete

    sm.applySubagentStreamDelta('subagent:x', ['hello'])

    const after = messages.value.get('subagent:x')!.value
    expect(after).toHaveLength(2)
    const pushed = after[1]
    expect(pushed.role).toBe('assistant')
    expect(pushed.status).toBe('streaming')
    expect(pushed.id.startsWith('sa-')).toBe(true)
    expect(pushed.content).toBe('hello')
    expect(pushed.contentBlocks).toEqual([{ type: 'text', refId: 'text' }])
  })

  it('TC2b 空 session 时同样新建', () => {
    const { sm, messages } = makeMachine()

    sm.applySubagentStreamDelta('subagent:empty', ['x'])

    const after = messages.value.get('subagent:empty')!.value
    expect(after).toHaveLength(1)
    expect(after[0].id.startsWith('sa-')).toBe(true)
  })
})

describe('finalizeSubagentStream', () => {
  it('TC3 收口 + sealed 幂等：streaming 翻 complete，重复调 no-op', () => {
    const { sm, messages } = makeMachine()
    messages.value = new Map([['subagent:x', shallowRef([streamingAssistant('a1')])]])

    sm.finalizeSubagentStream('subagent:x')
    expect(messages.value.get('subagent:x')!.value[0].status).toBe('complete')

    // 重复收口：sealed 守卫，不再变化（引用稳定）
    const snapshot = messages.value.get('subagent:x')!.value[0]
    sm.finalizeSubagentStream('subagent:x')
    expect(messages.value.get('subagent:x')!.value[0]).toBe(snapshot)
  })

  it('TC3b 无 streaming 实体时幂等 no-op（complete 消息不翻）', () => {
    const { sm, messages } = makeMachine()
    messages.value = new Map([['subagent:x', shallowRef([streamingAssistant('a1', { status: 'complete' })])]])

    sm.finalizeSubagentStream('subagent:x')

    expect(messages.value.get('subagent:x')!.value[0].status).toBe('complete')
  })

  it('TC3c 收口写入产出结束时刻 endedAt（turn 聚合口径时间轴右端）；已有值不覆写', () => {
    const { sm, messages } = makeMachine()
    messages.value = new Map([['subagent:x', shallowRef([streamingAssistant('a1')])]])

    sm.finalizeSubagentStream('subagent:x')
    expect(messages.value.get('subagent:x')!.value[0].endedAt).toBeTypeOf('number')

    // 已有值不覆写（迟到收口不覆写真实终点）
    const second = makeMachine()
    second.messages.value = new Map([['subagent:y', shallowRef([streamingAssistant('a1', { endedAt: 1234 })])]])
    second.sm.finalizeSubagentStream('subagent:y')
    expect(second.messages.value.get('subagent:y')!.value[0].endedAt).toBe(1234)
  })
})

describe('finalizeMessages', () => {
  it('TC4 error 收口：streaming assistant → error + errorText 写 msg.error（content 不动）；running toolCall → error + endTime；bash 跳过', () => {
    const { sm, messages } = makeMachine()
    const assistant = streamingAssistant('a1', { content: 'partial', toolCalls: [runningToolCall('tc1')] })
    const bash = bashMsg('b1')
    messages.value = new Map([['s1', shallowRef([assistant, bash])]])

    sm.finalizeMessages('s1', 'error', 'boom')

    const after = messages.value.get('s1')!.value
    expect(after[0].status).toBe('error')
    // [M2 error-visibility] 追加形态双通道：content 保持崩溃前正文不动，errorText 写 msg.error（不拼 \n\n）
    expect(after[0].content).toBe('partial')
    expect(after[0].error).toBe('boom')
    expect(after[0].toolCalls![0].status).toBe('error')
    expect(after[0].toolCalls![0].endTime).toBeTypeOf('number') // 非 normal/aborted 设 endTime
    expect(after[1]).toBe(bash) // bash 消息原样跳过（引用不变）
  })

  it('TC2 追加形态空 content：errorText 仍写 msg.error，content 保持空（不兜底拼进 content）', () => {
    const { sm, messages } = makeMachine()
    // 流刚开始就崩（content 为空）：errorText 不兜底进 content，独立 error 字段承载
    messages.value = new Map([['s1', shallowRef([streamingAssistant('a1')])]])

    sm.finalizeMessages('s1', 'error', 'boom')

    const after = messages.value.get('s1')!.value[0]
    expect(after.status).toBe('error')
    expect(after.content).toBe('')
    expect(after.error).toBe('boom')
  })

  it('TC2b 非 assistant 消息不写 error 字段（user 提问不受 errorText 影响）', () => {
    const { sm, messages } = makeMachine()
    messages.value = new Map([['s1', shallowRef([{ id: 'u1', role: 'user' as const, content: '提问', status: 'complete' as const, timestamp: 1 }])]])

    sm.finalizeMessages('s1', 'error', 'boom')

    const after = messages.value.get('s1')!.value[0]
    expect(after.content).toBe('提问')
    expect(after.error).toBeUndefined()
  })

  it('TC4b 已终态 message 只收口 toolCall；无 running toolCall 引用稳定', () => {
    const { sm, messages } = makeMachine()
    const completeWithRunningTc = streamingAssistant('a1', { status: 'complete', toolCalls: [runningToolCall('tc1')] })
    const completeNoTc = streamingAssistant('a2', { status: 'complete' })
    messages.value = new Map([['s1', shallowRef([completeWithRunningTc, completeNoTc])]])

    sm.finalizeMessages('s1', 'disconnect')

    const after = messages.value.get('s1')!.value
    expect(after[0].toolCalls![0].status).toBe('end_not_received') // 非 error reason → end_not_received
    expect(after[0].toolCalls![0].endTime).toBeTypeOf('number')
    expect(after[1]).toBe(completeNoTc) // 无 running toolCall 保持引用稳定
  })

  it('TC4c stream_error 收口：streaming → error；toolCall → error + endTime', () => {
    const { sm, messages } = makeMachine()
    const assistant = streamingAssistant('a1', { content: 'partial', toolCalls: [runningToolCall('tc1')] })
    messages.value = new Map([['s1', shallowRef([assistant])]])

    sm.finalizeMessages('s1', 'stream_error')

    const after = messages.value.get('s1')!.value[0]
    expect(after.status).toBe('error') // stream_error ∈ isErrorReason
    expect(after.toolCalls![0].status).toBe('error') // stream_error ∈ tcIsError
    expect(after.toolCalls![0].endTime).toBeTypeOf('number') // 非 normal/aborted 设 endTime
  })

  it('TC4d timeout 收口：streaming → error；toolCall → end_not_received + endTime（restart 同族）', () => {
    const { sm, messages } = makeMachine()
    const assistant = streamingAssistant('a1', { content: 'partial', toolCalls: [runningToolCall('tc1')] })
    messages.value = new Map([['s1', shallowRef([assistant])]])

    sm.finalizeMessages('s1', 'timeout')

    const after = messages.value.get('s1')!.value[0]
    expect(after.status).toBe('error') // timeout ∈ isErrorReason（restart 同分支）
    expect(after.toolCalls![0].status).toBe('end_not_received') // 非 error/stream_error → end_not_received
    expect(after.toolCalls![0].endTime).toBeTypeOf('number')
  })

  // [M2 error-visibility 不变量] 凡 streaming 收口产出 error 终态的 assistant 消息，
  // error 字段必非空——渲染层以「error 有无」区分纯 error（整条 danger）与追加形态
  // （正文原色 + error 独立 danger 行）。errorText 缺失路径（断连 / 超时 / 重启收口
  // 不带文案）若无兜底，崩溃前正常正文会被误判纯 error 整条染红。
  it('TC4e errorText 缺失的 error 类收口：error 字段写 reason 兜底文案（追加形态不变量）', () => {
    const { sm, messages } = makeMachine()
    const assistant = streamingAssistant('a1', { content: 'partial' })
    messages.value = new Map([['s1', shallowRef([assistant])]])

    for (const reason of ['disconnect', 'timeout', 'restart'] as const) {
      // 重置回 streaming 再收口（sealed 守卫：终态消息二次 finalize 不重写）
      messages.value = new Map([['s1', shallowRef([streamingAssistant('a1', { content: 'partial' })])]])
      sm.finalizeMessages('s1', reason)
      const after = messages.value.get('s1')!.value[0]
      expect(after.status).toBe('error')
      expect(after.content).toBe('partial') // 崩溃前正文不动
      expect(typeof after.error).toBe('string')
      expect(after.error!.length).toBeGreaterThan(0) // 兜底文案非空——不会误判纯 error
    }
  })

  it('TC4f errorText 空串视同缺失：error 字段走兜底（空 error 同样破坏形态判定信号）', () => {
    const { sm, messages } = makeMachine()
    messages.value = new Map([['s1', shallowRef([streamingAssistant('a1', { content: 'partial' })])]])

    sm.finalizeMessages('s1', 'error', '')

    const after = messages.value.get('s1')!.value[0]
    expect(after.status).toBe('error')
    expect(after.error).toBe('会话出错，回复已中断。')
  })

  it('TC4g 非 error reason 不写兜底：normal 收口 error 字段保持 undefined', () => {
    const { sm, messages } = makeMachine()
    messages.value = new Map([['s1', shallowRef([streamingAssistant('a1', { content: 'full' })])]])

    sm.finalizeMessages('s1', 'normal')

    const after = messages.value.get('s1')!.value[0]
    expect(after.status).toBe('complete')
    expect(after.error).toBeUndefined()
  })

  it('TC4h 收口写入产出结束时刻 endedAt（turn 聚合时间轴右端）；已有值不覆写（不迟到覆写真实终点）', () => {
    const { sm, messages } = makeMachine()
    messages.value = new Map([['s1', shallowRef([
      streamingAssistant('a1'),
      streamingAssistant('a2', { endedAt: 777 }),
    ])]])

    sm.finalizeMessages('s1', 'aborted')

    const after = messages.value.get('s1')!.value
    expect(after[0].endedAt).toBeTypeOf('number')
    expect(after[1].endedAt).toBe(777)
  })

  it('TC5 normal 收口：streaming → complete；toolCall → end_not_received 且不设 endTime；无 errorText 不追加', () => {
    const { sm, messages } = makeMachine()
    const assistant = streamingAssistant('a1', { content: 'full', toolCalls: [runningToolCall('tc1')] })
    messages.value = new Map([['s1', shallowRef([assistant])]])

    sm.finalizeMessages('s1', 'normal')

    const after = messages.value.get('s1')!.value[0]
    expect(after.status).toBe('complete')
    expect(after.content).toBe('full') // 无 errorText 不写 error 字段
    expect(after.error).toBeUndefined()
    expect(after.toolCalls![0].status).toBe('end_not_received')
    expect(after.toolCalls![0].endTime).toBeUndefined() // normal/aborted 不设 endTime
  })

  it('TC5b 空 session no-op（不抛错不写）', () => {
    const { sm, messages } = makeMachine()
    sm.finalizeMessages('ghost', 'error')
    expect(messages.value.has('ghost')).toBe(false)
  })
})

describe('collectFinalizeCandidates', () => {
  it('TC6 并集：messages ∪ compacting ∪ handingOff ∪ retry ∪ queue ∪ pendingSend', () => {
    // 6 源各贡献一个独有 sid，验证并集不漏
    const messages = shallowRef<Map<string, ShallowRef<Message[]>>>(new Map([['a', shallowRef([streamingAssistant('a1')])]]))
    const occupancies = ref<Map<string, SessionOccupancyState>>(new Map([['b', { turn: 'idle', compacting: true, bash: false }]]))
    const handingOff = ref<Set<string>>(new Set(['c']))
    const retryStates = ref<Map<string, unknown>>(new Map([['d', {}]]))
    const queueStates = ref<Map<string, unknown>>(new Map([['e', {}]]))
    const pendingSend = ref<Set<string>>(new Set(['f']))
    const sm = createStreamingStateMachine({
      messages,
      occupancies,
      handingOffSessions: handingOff,
      retryStates,
      queueStates,
      pendingSend,
      clearOccupancy: vi.fn(),
      setHandingOff: vi.fn(),
    })

    const candidates = sm.collectFinalizeCandidates()
    expect([...candidates].sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  })
})

describe('clearIndependentTransient', () => {
  it('TC7 清 compacting/handingOff 置位 + retry/queue 删除；无 sid 时 no-op', () => {
    const { sm, retryStates, queueStates, clearOccupancy, setHandingOff } = makeMachine()
    retryStates.value = new Map([['s1', { attempt: 1 }]])
    queueStates.value = new Map([['s1', { queued: true }]])

    sm.clearIndependentTransient('s1')

    expect(clearOccupancy).toHaveBeenCalledWith('s1')
    expect(setHandingOff).toHaveBeenCalledWith('s1', false)
    expect(retryStates.value.has('s1')).toBe(false)
    expect(queueStates.value.has('s1')).toBe(false)

    // 无该 sid 的态：不再清（no-op 幂等）
    const retrySnapshot = retryStates.value
    const queueSnapshot = queueStates.value
    sm.clearIndependentTransient('ghost')
    expect(retryStates.value).toBe(retrySnapshot)
    expect(queueStates.value).toBe(queueSnapshot)
  })
})
