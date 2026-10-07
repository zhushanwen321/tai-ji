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
import { subagentVirtualId } from '@taiji/shared'
import type { SessionOccupancyState } from '../store'
import { createStreamingStateMachine, type SubagentStreamStateSnapshot } from '../streaming-state-machine'

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

function makeMachine(opts: { subagentStreamPull?: (virtualId: string, recordId: string) => Promise<SubagentStreamStateSnapshot> } = {}) {
  // W10 D-1 容器范式：外层 Map 恒等稳定，每 sid 分区是独立 ShallowRef
  const messages = shallowRef<Map<string, ShallowRef<Message[]>>>(new Map())
  const occupancies = ref<Map<string, SessionOccupancyState>>(new Map())
  const handingOffSessions = ref<Set<string>>(new Set())
  const retryStates = ref<Map<string, unknown>>(new Map())
  const pendingSend = ref<Set<string>>(new Set())
  const clearOccupancy = vi.fn<(sessionId: string) => void>()
  const setHandingOff = vi.fn<(sessionId: string, value: boolean) => void>()
  const sm = createStreamingStateMachine({
    messages,
    occupancies,
    handingOffSessions,
    retryStates,
    pendingSend,
    clearOccupancy,
    setHandingOff,
    subagentStreamPull: opts.subagentStreamPull,
  })
  return { sm, messages, retryStates, clearOccupancy, setHandingOff }
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

  it('TC4d disconnect 收口：streaming → error；toolCall → end_not_received + endTime（restart 同族）', () => {
    const { sm, messages } = makeMachine()
    const assistant = streamingAssistant('a1', { content: 'partial', toolCalls: [runningToolCall('tc1')] })
    messages.value = new Map([['s1', shallowRef([assistant])]])

    sm.finalizeMessages('s1', 'disconnect')

    const after = messages.value.get('s1')!.value[0]
    expect(after.status).toBe('error') // disconnect ∈ isErrorReason（restart 同分支）
    expect(after.toolCalls![0].status).toBe('end_not_received') // 非 error/stream_error → end_not_received
    expect(after.toolCalls![0].endTime).toBeTypeOf('number')
  })

  // [M2 error-visibility 不变量] 凡 streaming 收口产出 error 终态的 assistant 消息，
  // error 字段必非空——渲染层以「error 有无」区分纯 error（整条 danger）与追加形态
  // （正文原色 + error 独立 danger 行）。errorText 缺失路径（断连 / 重启收口
  // 不带文案）若无兜底，崩溃前正常正文会被误判纯 error 整条染红。
  it('TC4e errorText 缺失的 error 类收口：error 字段写 reason 兜底文案（追加形态不变量）', () => {
    const { sm, messages } = makeMachine()
    const assistant = streamingAssistant('a1', { content: 'partial' })
    messages.value = new Map([['s1', shallowRef([assistant])]])

    for (const reason of ['disconnect', 'restart'] as const) {
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
  it('TC6 并集：messages ∪ compacting ∪ handingOff ∪ retry ∪ pendingSend（[u5a] queue 源已退役）', () => {
    // 5 源各贡献一个独有 sid，验证并集不漏
    const messages = shallowRef<Map<string, ShallowRef<Message[]>>>(new Map([['a', shallowRef([streamingAssistant('a1')])]]))
    const occupancies = ref<Map<string, SessionOccupancyState>>(new Map([['b', { turn: 'idle', compacting: true, bash: false }]]))
    const handingOff = ref<Set<string>>(new Set(['c']))
    const retryStates = ref<Map<string, unknown>>(new Map([['d', {}]]))
    const pendingSend = ref<Set<string>>(new Set(['e']))
    const sm = createStreamingStateMachine({
      messages,
      occupancies,
      handingOffSessions: handingOff,
      retryStates,
      pendingSend,
      clearOccupancy: vi.fn(),
      setHandingOff: vi.fn(),
    })

    const candidates = sm.collectFinalizeCandidates()
    expect([...candidates].sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

describe('clearIndependentTransient', () => {
  it('TC7 清 compacting/handingOff 置位 + retry 删除；无 sid 时 no-op（[u5a] queue 维度已退役）', () => {
    const { sm, retryStates, clearOccupancy, setHandingOff } = makeMachine()
    retryStates.value = new Map([['s1', { attempt: 1 }]])

    sm.clearIndependentTransient('s1')

    expect(clearOccupancy).toHaveBeenCalledWith('s1')
    expect(setHandingOff).toHaveBeenCalledWith('s1', false)
    expect(retryStates.value.has('s1')).toBe(false)

    // 无该 sid 的态：不再清（no-op 幂等）
    const retrySnapshot = retryStates.value
    sm.clearIndependentTransient('ghost')
    expect(retryStates.value).toBe(retrySnapshot)
  })
})

// ── [B2 subagent-stream-chunk §4.3] 增量 chunk 消费状态机 ──────────────────────────
// 契约权威 = 设计文档 §4.3：chunk 处理优先序四步 / 拉取响应按序判定四分支 /
// 跨消息边界（推进重置 + 丢旧 buffer）/ 水位回放 / sealedMsgSeq 单调水位 /
// 在途拉取 settle 即清（pullDedup factory，C-data-18）。分区状态经 _chunkPartitionsForTest
// 只读断言、在途态经 _pullDedupForTest.has(key) 断言（行为断言为主，buffer / 在途槽
// 无消息投影，状态读口是唯一观测点）。

/** chunk 状态机测试夹具：注入受控拉取执行器（deferred 手动 resolve/reject 控制时序） */
function makeChunkMachine() {
  const pullCalls: Array<{ virtualId: string; recordId: string; response: Promise<SubagentStreamStateSnapshot> }> = []
  let resolvePull: ((response: SubagentStreamStateSnapshot) => void) | undefined
  let rejectPull: ((reason: unknown) => void) | undefined
  const { sm, messages } = makeMachine({
    subagentStreamPull: (virtualId: string, recordId: string) => {
      const response = new Promise<SubagentStreamStateSnapshot>((resolve, reject) => {
        resolvePull = resolve
        rejectPull = reject
      })
      pullCalls.push({ virtualId, recordId, response })
      return response
    },
  })
  const VID = subagentVirtualId('s1', 'bg-1')
  const RID = 'bg-1'
  /** 分区状态只读断言口（buffer / sealedMsgSeq 无消息投影，唯一观测点） */
  const partition = () => sm._chunkPartitionsForTest.get(VID)!.get(RID)!
  /** (VID, RID) 在途拉取观测口（等价原分区 pullInFlight 字段：settle 即清由 factory 承接） */
  const pullInFlight = () => sm._pullDedupForTest.has(`${VID}::${RID}`)
  /** 拉取执行器全部在微任务中续跑（.then/.catch），flush 两拍保证响应应用完成 */
  const flush = async () => {
    await Promise.resolve()
    await Promise.resolve()
  }
  return { sm, messages, VID, RID, partition, pullInFlight, pullCalls, flush, resolvePull: () => resolvePull, rejectPull: () => rejectPull }
}

describe('applySubagentStreamChunk（§4.3 chunk 处理优先序）', () => {
  it('TC-C1+2 干净起步（新建分区 + deltaSeq=0）与顺序追加（== expected，O(1) 拼接非全量替换）', () => {
    const { sm, messages, VID, RID, partition } = makeChunkMachine()

    sm.applySubagentStreamChunk(VID, RID, 1, 0, 'a')
    let after = messages.value.get(VID)!.value
    expect(after).toHaveLength(1)
    expect(after[0].id.startsWith('sa-')).toBe(true)
    expect(after[0].status).toBe('streaming')
    expect(after[0].content).toBe('a')

    sm.applySubagentStreamChunk(VID, RID, 1, 1, 'b')
    after = messages.value.get(VID)!.value
    expect(after).toHaveLength(1) // 追加不新建
    expect(after[0].content).toBe('ab')

    expect(partition().msgSeq).toBe(1)
    expect(partition().expectedDeltaSeq).toBe(2)
    expect(partition().sealedMsgSeq).toBe(0) // 干净起步不拉取（无在途、无缓冲）
    expect(partition().buffer).toHaveLength(0)
  })

  it('TC-C3+4 失步（> expected）入 buffer 并触发拉取；在途去重（同 record 至多一个在途拉取）', () => {
    const { sm, messages, VID, RID, partition, pullInFlight, pullCalls } = makeChunkMachine()

    sm.applySubagentStreamChunk(VID, RID, 1, 0, 'a')
    sm.applySubagentStreamChunk(VID, RID, 1, 2, 'x') // 跳过 deltaSeq=1 → 失步
    expect(partition().buffer).toEqual([{ msgSeq: 1, deltaSeq: 2, delta: 'x' }])
    expect(pullInFlight()).toBe(true)
    expect(pullCalls).toHaveLength(1)
    expect(pullCalls[0]).toMatchObject({ virtualId: VID, recordId: RID })

    sm.applySubagentStreamChunk(VID, RID, 1, 3, 'y') // 在途拉取未归：只入 buffer 不再拉
    expect(partition().buffer).toHaveLength(2)
    expect(pullCalls).toHaveLength(1)
    expect(messages.value.get(VID)!.value[0].content).toBe('a') // 失步 chunk 不上屏
  })

  it('TC-C4b 丢弃（< expected）：已含于拉取结果的 chunk 丢弃，不上屏不触发拉取', async () => {
    const { sm, messages, VID, RID, partition, pullCalls, resolvePull, flush } = makeChunkMachine()

    sm.applySubagentStreamChunk(VID, RID, 1, 0, 'a')
    sm.applySubagentStreamChunk(VID, RID, 1, 2, 'x') // 失步 → 拉取
    resolvePull()!({ found: true, msgSeq: 1, lastDeltaSeq: 3, lines: ['a', 'm1', 'm2', 'm3'] })
    await flush()

    // 响应已含 deltaSeq ≤ 3 的全部内容；expected = 4
    expect(partition().expectedDeltaSeq).toBe(4)
    expect(messages.value.get(VID)!.value[0].content).toBe('a\nm1\nm2\nm3')
    expect(pullCalls).toHaveLength(1)

    const before = messages.value.get(VID)!.value[0]
    sm.applySubagentStreamChunk(VID, RID, 1, 1, 'late') // < expected → 丢弃
    expect(messages.value.get(VID)!.value[0]).toBe(before) // 引用稳定（零变化）
    expect(pullCalls).toHaveLength(1)
  })

  it('TC-C6 跨消息边界（msgSeq 推进）：开新 streaming 消息 + expectedDeltaSeq 重置 + 丢旧 buffer', () => {
    const { sm, messages, VID, RID, partition } = makeChunkMachine()

    sm.applySubagentStreamChunk(VID, RID, 1, 0, 'a')
    sm.applySubagentStreamChunk(VID, RID, 1, 2, 'x') // 失步入 buffer + 拉取在途
    sm.applySubagentStreamChunk(VID, RID, 2, 0, 'b') // 边界推进：旧 buffer 丢弃、expected 重置

    const after = messages.value.get(VID)!.value
    expect(after).toHaveLength(2)
    expect(after[0].status).toBe('complete') // 旧消息实体就地收口（终态由 entry 链权威覆盖）
    expect(after[0].content).toBe('a')
    expect(after[1].status).toBe('streaming')
    expect(after[1].content).toBe('b') // 新消息增量并入新实体

    expect(partition().msgSeq).toBe(2)
    expect(partition().expectedDeltaSeq).toBe(1) // 重置 0 后被 (2,0) 推进
    expect(partition().buffer).toHaveLength(0) // 旧 buffer 丢弃（旧消息已定稿，残留无意义）
  })

  it('TC-C6b 边界推进不重置 sealedMsgSeq（单调水位）；后续消息正常追加', () => {
    const { sm, VID, RID, partition } = makeChunkMachine()
    sm.sealSubagentStream(VID, RID, 1)
    sm.applySubagentStreamChunk(VID, RID, 1, 0, 'a')
    sm.applySubagentStreamChunk(VID, RID, 2, 0, 'b')

    expect(partition().msgSeq).toBe(2)
    expect(partition().sealedMsgSeq).toBe(1) // 边界推进不触碰水位
  })

  it('TC-C7 跨多条消息前向跳号：一次推进到目标 msgSeq（中间消息全文由 entry 权威链承载）', () => {
    const { sm, messages, VID, RID, partition } = makeChunkMachine()
    sm.applySubagentStreamChunk(VID, RID, 1, 0, 'a')
    sm.applySubagentStreamChunk(VID, RID, 3, 0, 'c') // 1 → 3 跨一条

    const after = messages.value.get(VID)!.value
    expect(partition().msgSeq).toBe(3)
    expect(after).toHaveLength(2)
    expect(after[1].content).toBe('c')
  })

  it('TC-C8 陈旧 chunk（msgSeq < 当前）丢弃：不改状态不上屏不拉取（契约收窄，见实现注记）', () => {
    const { sm, messages, VID, RID, partition, pullCalls } = makeChunkMachine()
    sm.applySubagentStreamChunk(VID, RID, 2, 0, 'b')
    const before = messages.value.get(VID)!.value

    sm.applySubagentStreamChunk(VID, RID, 1, 9, 'stale')

    expect(messages.value.get(VID)!.value).toBe(before)
    expect(partition().msgSeq).toBe(2)
    expect(partition().expectedDeltaSeq).toBe(1)
    expect(partition().buffer).toHaveLength(0)
    expect(pullCalls).toHaveLength(0)
  })

  it('TC-N1 未注入拉取执行器：失步入 buffer、不抛错、无在途标记（core 单测缺省形态）', () => {
    const { sm } = makeMachine() // 无 subagentStreamPull
    const VID2 = subagentVirtualId('s1', 'bg-2')
    const RID2 = 'bg-2'

    expect(() => sm.applySubagentStreamChunk(VID2, RID2, 1, 5, 'x')).not.toThrow()
    expect(sm._chunkPartitionsForTest.get(VID2)!.get(RID2)!.buffer).toEqual([{ msgSeq: 1, deltaSeq: 5, delta: 'x' }])
    expect(sm._pullDedupForTest.has(`${VID2}::${RID2}`)).toBe(false)
  })
})

describe('applySubagentStreamState（§4.3 拉取响应按序判定四分支）', () => {
  it('TC-R1 分支 1（≤ sealedMsgSeq → 已定稿丢弃）：晚到响应不复活定稿消息，出口清在途槽', async () => {
    const { sm, messages, VID, RID, partition, pullInFlight, resolvePull, flush } = makeChunkMachine()
    sm.sealSubagentStream(VID, RID, 1)
    sm.applySubagentStreamChunk(VID, RID, 1, 0, 'a') // 常规流式（expected=1）
    sm.applySubagentStreamChunk(VID, RID, 1, 3, 'x') // 失步 → 拉取在途
    expect(pullInFlight()).toBe(true)
    const before = messages.value.get(VID)!.value

    resolvePull()!({ found: true, msgSeq: 1, lastDeltaSeq: 5, lines: ['final', 'text'] })
    await flush()

    expect(messages.value.get(VID)!.value).toBe(before) // 零写入：定稿消息的全文响应不复活内容
    expect(pullInFlight()).toBe(false) // settle 即清（factory）
  })

  it('TC-R2 分支 2（< 当前 msgSeq → 陈旧响应丢弃）：RPC 应答与广播推进交错窗口防护', async () => {
    const { sm, messages, VID, RID, partition, pullInFlight, resolvePull, flush } = makeChunkMachine()
    sm.applySubagentStreamChunk(VID, RID, 1, 5, 'x') // 失步 → 拉取在途
    sm.applySubagentStreamChunk(VID, RID, 2, 0, 'b') // 广播先推进边界（buffer 丢弃）
    resolvePull()!({ found: true, msgSeq: 1, lastDeltaSeq: 9, lines: ['stale'] })
    await flush()

    const after = messages.value.get(VID)!.value
    expect(after).toHaveLength(2) // 陈旧响应未产生任何消息写
    expect(after[1].content).toBe('b')
    expect(partition().msgSeq).toBe(2)
    expect(partition().expectedDeltaSeq).toBe(1) // 未被响应重置
    expect(pullInFlight()).toBe(false)
  })

  it('TC-R3 found:false（协议形态 msgSeq=0）→ 零写入出口清在途槽：经分支 1 等效拦截（设计注记「判定 1 通常已拦截」）', async () => {
    const { sm, messages, VID, RID, partition, pullInFlight, resolvePull, flush } = makeChunkMachine()
    sm.applySubagentStreamChunk(VID, RID, 1, 0, 'a')
    sm.applySubagentStreamChunk(VID, RID, 1, 2, 'x') // 失步 → 拉取在途
    // 线上回执形态：found=false 时 msgSeq 无流式语义恒 0（shared 协议注释）——
    // 0 <= sealedMsgSeq(0) 在分支 1 即拦截，与分支 3 同一出口（不动作 + 清在途槽）
    resolvePull()!({ found: false, msgSeq: 0, lastDeltaSeq: 0, lines: [] })
    await flush()

    expect(messages.value.get(VID)!.value[0].content).toBe('a') // 内容不动
    expect(partition().msgSeq).toBe(1) // 水位状态不动（含 lastDeltaSeq 未应用）
    expect(partition().expectedDeltaSeq).toBe(1)
    expect(pullInFlight()).toBe(false)
  })

  it('TC-R3b 分支 3 本体（found:false 且 msgSeq 超前，白盒覆盖分支臂）→ 不动作，出口清在途槽', async () => {
    const { sm, messages, VID, RID, partition, pullInFlight, resolvePull, flush } = makeChunkMachine()
    sm.applySubagentStreamChunk(VID, RID, 2, 0, 'b') // msgSeq=2, expected=1
    sm.applySubagentStreamChunk(VID, RID, 2, 3, 'x') // 失步 → 拉取在途
    // 非线上形态（found=false 恒 msgSeq=0）：msgSeq 超前的 found:false 仅可达分支 3 本体
    resolvePull()!({ found: false, msgSeq: 5, lastDeltaSeq: 0, lines: [] })
    await flush()

    expect(messages.value.get(VID)!.value[0].content).toBe('b') // 不动作
    expect(partition().msgSeq).toBe(2) // 状态未被响应重置
    expect(partition().expectedDeltaSeq).toBe(1)
    expect(pullInFlight()).toBe(false)
  })

  it('TC-R4 分支 4（判定通过，含跨边界恢复）：全量替换 + 状态按响应重置（重置即边界推进）', async () => {
    const { sm, messages, VID, RID, partition, pullInFlight, resolvePull, flush } = makeChunkMachine()
    // 接入拉取（触发点 ①）：无任何 chunk 时经 requestSubagentStreamState 主动拉
    sm.requestSubagentStreamState(VID, RID)
    expect(pullInFlight()).toBe(true)

    resolvePull()!({ found: true, msgSeq: 3, lastDeltaSeq: 1, lines: ['l0', 'l1'] })
    await flush()

    const after = messages.value.get(VID)!.value
    expect(after).toHaveLength(1)
    expect(after[0].status).toBe('streaming')
    expect(after[0].content).toBe('l0\nl1') // 复用 applySubagentStreamDelta 全量替换
    expect(partition().msgSeq).toBe(3) // 按响应重置（超前当前 0 = 跨边界恢复）
    expect(partition().expectedDeltaSeq).toBe(2) // lastDeltaSeq + 1
    expect(partition().sealedMsgSeq).toBe(0) // 水位不受响应影响
    expect(pullInFlight()).toBe(false)
  })

  it('TC-R4b requestSubagentStreamState 在途去重：并发触发合并为单次拉取', () => {
    const { sm, VID, RID, pullCalls } = makeChunkMachine()
    sm.requestSubagentStreamState(VID, RID)
    sm.requestSubagentStreamState(VID, RID)
    sm.requestSubagentStreamState(VID, RID)
    expect(pullCalls).toHaveLength(1)
  })
})

describe('水位回放（buffer replay，§4.3 分支 4 + 去重即水位）', () => {
  it('TC-P1 > 水位按序回放：回放 chunk 走同一管线追加，回放后 expected 对齐续传', async () => {
    const { sm, messages, VID, RID, partition, resolvePull, flush } = makeChunkMachine()
    sm.applySubagentStreamChunk(VID, RID, 1, 0, 'a')
    sm.applySubagentStreamChunk(VID, RID, 1, 2, 'c2') // 失步入 buffer（跳过 1）

    resolvePull()!({ found: true, msgSeq: 1, lastDeltaSeq: 1, lines: ['a', 'mid'] })
    await flush()

    // 全文替换为水位处全文 + 回放 buffer 中 (1,2)（> 水位 expected=2）
    expect(messages.value.get(VID)!.value[0].content).toBe('a\nmidc2')
    expect(partition().expectedDeltaSeq).toBe(3)

    sm.applySubagentStreamChunk(VID, RID, 1, 3, 'd3') // 回放后对齐，续传追加
    expect(messages.value.get(VID)!.value[0].content).toBe('a\nmidc2d3')
  })

  it('TC-P2 ≤ 水位回放丢弃：响应已含的失步 chunk 回放时被水位过滤，不重复不缺段', async () => {
    const { sm, messages, VID, RID, partition, pullCalls, resolvePull, flush } = makeChunkMachine()
    sm.applySubagentStreamChunk(VID, RID, 1, 0, 'a') // expected → 1
    sm.applySubagentStreamChunk(VID, RID, 1, 2, 'c2') // 跳过 1 → 失步入 buffer + 拉取
    expect(pullCalls).toHaveLength(1)

    // 响应含到 deltaSeq=2（水位=2）：(1,2) 的内容已在全文内
    resolvePull()!({ found: true, msgSeq: 1, lastDeltaSeq: 2, lines: ['a', 'b', 'c'] })
    await flush()

    // 回放 (1,2)：deltaSeq 2 < expected 3 → 丢弃（≤ 水位），全文不重复追加
    expect(messages.value.get(VID)!.value[0].content).toBe('a\nb\nc')
    expect(partition().expectedDeltaSeq).toBe(3)
    expect(partition().buffer).toHaveLength(0)
    expect(pullCalls).toHaveLength(1)
  })

  it('TC-P2b 回放中再遇跳号 → 再次拉取（在途槽已随响应 settle 清，再触发 run 新槽）', async () => {
    const { sm, messages, VID, RID, partition, pullInFlight, pullCalls, resolvePull, flush } = makeChunkMachine()
    sm.applySubagentStreamChunk(VID, RID, 1, 2, 'c2') // 失步（跳过 0/1）
    sm.applySubagentStreamChunk(VID, RID, 1, 5, 'f5') // 继续失步（同 record 单在途）
    expect(pullCalls).toHaveLength(1)

    resolvePull()!({ found: true, msgSeq: 1, lastDeltaSeq: 1, lines: ['a', 'mid'] })
    await flush()

    // 回放：(1,2) == expected 追加；(1,5) 仍跳号（expected=3）→ 入 buffer 并再次拉取
    expect(messages.value.get(VID)!.value[0].content).toBe('a\nmidc2')
    expect(partition().buffer).toEqual([{ msgSeq: 1, deltaSeq: 5, delta: 'f5' }])
    expect(pullCalls).toHaveLength(2)
    expect(pullInFlight()).toBe(true) // 回放触发的拉取 run 新在途槽
  })

  it('TC-F1 拉取失败（executor reject）→ settle 清在途槽、保持失步态，下一条 chunk 重新触发（事件驱动无定时器）', async () => {
    const { sm, VID, RID, partition, pullInFlight, pullCalls, rejectPull, flush } = makeChunkMachine()
    sm.applySubagentStreamChunk(VID, RID, 1, 0, 'a')
    sm.applySubagentStreamChunk(VID, RID, 1, 2, 'x') // 失步 → 拉取
    rejectPull()!(new Error('connection closed'))
    await flush()

    expect(pullInFlight()).toBe(false)
    expect(partition().buffer).toHaveLength(1) // 保持失步态（缓冲保留）

    sm.applySubagentStreamChunk(VID, RID, 1, 3, 'y') // 下一条失步 chunk → 重新触发
    expect(pullCalls).toHaveLength(2)
    expect(pullInFlight()).toBe(true)
  })
})

describe('sealedMsgSeq 单调水位（§4.3）', () => {
  it('TC-S1 单调推进不回退：小额 msgSeq 置位不改水位，分支 1 判定按最高已定稿', async () => {
    const { sm, VID, RID, partition, resolvePull, flush } = makeChunkMachine()
    sm.sealSubagentStream(VID, RID, 3)
    sm.sealSubagentStream(VID, RID, 1) // 迟到的低序号清除消息
    expect(partition().sealedMsgSeq).toBe(3)

    sm.applySubagentStreamState(VID, RID, { found: true, msgSeq: 3, lastDeltaSeq: 0, lines: ['old'] })
    await flush()
    expect(partition().msgSeq).toBe(0) // 分支 1 丢弃：状态未被响应推进
  })

  it('TC-S3 无分区清除消息（缺前缀晚接入）先落水位：后续接入拉取响应被分支 1 拦截', async () => {
    const { sm, messages, VID, RID, partition, pullInFlight, pullCalls, resolvePull, flush } = makeChunkMachine()
    sm.sealSubagentStream(VID, RID, 5) // 清除消息先于任何 chunk 到达（分区据置位创建）
    expect(partition().sealedMsgSeq).toBe(5)

    sm.requestSubagentStreamState(VID, RID) // 接入拉取（触发点 ①）
    resolvePull()!({ found: true, msgSeq: 5, lastDeltaSeq: 9, lines: ['sealed'] })
    await flush()

    expect(messages.value.has(VID)).toBe(false) // 已定稿内容不复活
    expect(pullInFlight()).toBe(false)
    expect(pullCalls).toHaveLength(1)
  })

  it('TC-S4 clearSubagentChunkState / clearSubagentChunkStateForSession 分区生命周期清除', () => {
    const { sm, VID, RID } = makeChunkMachine()
    const VID2 = subagentVirtualId('s1', 'bg-2')
    const VID_OTHER = subagentVirtualId('s2', 'bg-9')
    sm.applySubagentStreamChunk(VID, RID, 1, 0, 'a')
    sm.applySubagentStreamChunk(VID2, RID, 1, 0, 'a')
    sm.applySubagentStreamChunk(VID_OTHER, RID, 1, 0, 'a')

    sm.clearSubagentChunkState(VID) // record/分区级：整 vid 名下
    expect(sm._chunkPartitionsForTest.has(VID)).toBe(false)

    sm.clearSubagentChunkStateForSession('s1') // session 级：按三段式中段归属
    expect(sm._chunkPartitionsForTest.has(VID2)).toBe(false)
    expect(sm._chunkPartitionsForTest.has(VID_OTHER)).toBe(true) // 其他 session 分区不受影响

    // 清除后同键 chunk 从干净状态重建（msgSeq 回 0，边界推进正常）
    sm.applySubagentStreamChunk(VID_OTHER, RID, 1, 0, 'fresh')
    expect(sm._chunkPartitionsForTest.get(VID_OTHER)!.get(RID)!.msgSeq).toBe(1)
  })
})
