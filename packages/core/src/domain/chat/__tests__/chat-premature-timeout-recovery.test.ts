/**
 * premature-timeout 误判收口自愈单测（[premature-timeout] docs/design/timeout-streaming-ui-idle.md §5.2 D2 / §4.2 / §7 S3）。
 *
 * 锁定「timeout 打标 → message.complete 自愈」恢复链（单测层；S3 实跑探针 P-G 归 Gate B）：
 * - timeout 打标：idle 到期 finalize('timeout') 给被收口 assistant 写 prematureTimeout:true
 *   （不写 errorText——超时文案由 renderer 据标记渲染，core headless）
 * - complete 恢复分支：谓词 = complete 到达 ∧ 打标 id 快照非空 ∧ 实体仍处 timeout error 态；
 *   stopReason 全集映射（end_turn/max_tokens/tool_use/content_filter→complete 恢复 + 权威
 *   content 覆盖 + usage 回填 + 清标；error→error+errorMessage；aborted→complete+清标）
 * - 清除时机全集：① 恢复命中（take 消费）② 非 timeout finalizeSession ③ 下一条 message_start
 *   （防跨 turn 错配，v1.1 反例重演）④ resetTransientStates
 * - P-C 现状不回归：complete 对无打标已终态气泡 no-op
 *
 * 运行：cd packages/core && npx vitest run src/domain/chat/__tests__/chat-premature-timeout-recovery.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { effectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createChatStore } from '../store'
import type { ChatStoreInstance } from '../store'
import type { Message } from '@xyz-agent/shared'

/** 默认 idle 阈值：30min（DEFAULT_STREAMING_IDLE_TIMEOUT_MS）。 */
const IDLE_MS = 1_800_000
const sid = 's-premature'

function makeStore(): { store: ChatStoreInstance; dispose: () => void } {
  const scope = effectScope(true)
  const store = scope.run(() => createChatStore())!
  return { store, dispose: () => scope.stop() }
}

/** 开一个 streaming turn（message_start） */
function startTurn(store: ChatStoreInstance, messageId = 'a1'): void {
  store.applyMessageEvent(sid, { type: 'message.message_start', payload: { sessionId: sid, messageId } })
}

/** 推进零帧至 idle 到期，触发 timeout 收口（打标） */
function expireIdle(store: ChatStoreInstance): void {
  vi.advanceTimersByTime(IDLE_MS)
  expect(store.isGenerating(sid)).toBe(false)
}

function messages(store: ChatStoreInstance): Message[] {
  return store.getMessages(sid)
}

/** 迟到的 message.complete 帧（timer 已被 finalize 清掉，无需推进 fake timers，直达 registry） */
function lateComplete(payload: Record<string, unknown>): void {
  current!.applyMessageEvent(sid, { type: 'message.complete', payload: { sessionId: sid, ...payload } })
}

/** 当前测试的 store 引用（lateComplete 辅助用） */
let current: ChatStoreInstance | undefined

describe('premature-timeout — timeout 打标（finalizeMessages）', () => {
  let sut: { store: ChatStoreInstance; dispose: () => void }

  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    sut = makeStore()
    current = sut.store
    startTurn(sut.store)
    sut.store.applyMessageEvent(sid, { type: 'message.text_delta', payload: { sessionId: sid, delta: '截断正文' } })
  })
  afterEach(() => {
    sut.dispose()
    current = undefined
    vi.useRealTimers()
  })

  it('idle 到期收口：assistant error 态 + prematureTimeout:true + 不写 error（core headless）', () => {
    expireIdle(sut.store)
    const m = messages(sut.store)[0]
    expect(m.status).toBe('error')
    expect(m.prematureTimeout).toBe(true)
    expect(m.error).toBeUndefined()
    expect(m.content).toBe('截断正文')
  })

  it('正常 complete 收口不打标（标记专属 timeout 收口）', () => {
    sut.store.applyMessageEvent(sid, { type: 'message.complete', payload: { sessionId: sid, stopReason: 'end_turn', content: '完整正文' } })
    const m = messages(sut.store)[0]
    expect(m.status).toBe('complete')
    expect(m.prematureTimeout).toBeUndefined()
  })
})

describe('premature-timeout — S3 全链：打标 → complete 自愈恢复', () => {
  let sut: { store: ChatStoreInstance; dispose: () => void }

  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    sut = makeStore()
    current = sut.store
    startTurn(sut.store)
    sut.store.applyMessageEvent(sid, { type: 'message.text_delta', payload: { sessionId: sid, delta: '截断正文' } })
    expireIdle(sut.store)
  })
  afterEach(() => {
    sut.dispose()
    current = undefined
    vi.useRealTimers()
  })

  it('end_turn：status 恢复 complete、权威 content 覆盖截断正文、usage 回填、标记清除（不依赖重开 session）', () => {
    lateComplete({ stopReason: 'end_turn', content: '权威完整正文', usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 } })
    const m = messages(sut.store)[0]
    expect(m.status).toBe('complete')
    expect(m.content).toBe('权威完整正文')
    expect(m.usage).toEqual({ inputTokens: 100, outputTokens: 200 })
    expect(m.prematureTimeout).toBeUndefined()
  })

  it('恢复后二次 complete no-op（快照 take 消费语义，P-C 现状保持）', () => {
    lateComplete({ stopReason: 'end_turn', content: '权威完整正文' })
    lateComplete({ stopReason: 'end_turn', content: '二次覆盖不应生效', usage: { inputTokens: 9, outputTokens: 9, totalTokens: 18 } })
    const m = messages(sut.store)[0]
    expect(m.content).toBe('权威完整正文')
    expect(m.usage).toBeUndefined()
  })

  it('误判期间运行中的 toolCall：timeout 收口 end_not_received → 迟到 tool_call_end 覆盖 completed（P-D 既有行为）', () => {
    // 重开场景：turn 带 toolCall，timeout 收口后迟到 tool_call_end + complete
    sut.dispose()
    setActivePinia(createPinia())
    sut = makeStore()
    current = sut.store
    startTurn(sut.store, 'a1')
    sut.store.applyMessageEvent(sid, {
      type: 'message.tool_call_start',
      payload: { sessionId: sid, entry: { type: 'toolCall', toolCallId: 'tc1', toolName: 'bash', arguments: { command: 'sleep 90' } } },
    })
    expireIdle(sut.store)
    // timeout 收口把 running toolCall 推 end_not_received
    expect(messages(sut.store)[0].toolCalls?.[0].status).toBe('end_not_received')
    // 迟到 tool_call_end（既有行为：ID 锚定覆盖收口值）
    sut.store.applyMessageEvent(sid, {
      type: 'message.tool_call_end',
      payload: { sessionId: sid, entry: { type: 'message', parentId: null, timestamp: new Date(0).toISOString(), message: { role: 'toolResult', toolCallId: 'tc1', toolName: 'bash', content: [{ type: 'text', text: 'done' }], isError: false, timestamp: 0 } } },
    })
    expect(messages(sut.store)[0].toolCalls?.[0].status).toBe('completed')
    // complete 自愈恢复气泡
    lateComplete({ stopReason: 'end_turn', content: '权威完整正文' })
    const m = messages(sut.store)[0]
    expect(m.status).toBe('complete')
    expect(m.prematureTimeout).toBeUndefined()
  })
})

describe('premature-timeout — stopReason 全集映射（对齐 event-adapter STOP_REASON_MAP 值域）', () => {
  let sut: { store: ChatStoreInstance; dispose: () => void }

  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    sut = makeStore()
    current = sut.store
    startTurn(sut.store)
    sut.store.applyMessageEvent(sid, { type: 'message.text_delta', payload: { sessionId: sid, delta: '截断正文' } })
    expireIdle(sut.store)
  })
  afterEach(() => {
    sut.dispose()
    current = undefined
    vi.useRealTimers()
  })

  it.each(['max_tokens', 'tool_use', 'content_filter'])('%s → complete 恢复 + 权威覆盖 + 清标', (stopReason) => {
    lateComplete({ stopReason, content: `权威正文-${stopReason}` })
    const m = messages(sut.store)[0]
    expect(m.status).toBe('complete')
    expect(m.content).toBe(`权威正文-${stopReason}`)
    expect(m.prematureTimeout).toBeUndefined()
  })

  it('error → 保持 error 终态 + errorMessage 写 Message.error + 清标 + 不追加重复气泡', () => {
    lateComplete({ stopReason: 'error', errorMessage: 'provider 500' })
    const list = messages(sut.store)
    expect(list).toHaveLength(1)
    const m = list[0]
    expect(m.status).toBe('error')
    expect(m.error).toBe('provider 500')
    expect(m.prematureTimeout).toBeUndefined()
  })

  it('aborted → complete 终态 + 清标（用户主动停；无权威 content 保留截断累积值）', () => {
    lateComplete({ stopReason: 'aborted' })
    const m = messages(sut.store)[0]
    expect(m.status).toBe('complete')
    expect(m.content).toBe('截断正文')
    expect(m.prematureTimeout).toBeUndefined()
  })

  it('stopReason 缺失（未识别值）→ 兜底 complete 恢复（对齐现有 isErrorStop 判定）', () => {
    lateComplete({ content: '权威正文' })
    const m = messages(sut.store)[0]
    expect(m.status).toBe('complete')
    expect(m.prematureTimeout).toBeUndefined()
  })
})

describe('premature-timeout — 清除时机全集（防误恢复）', () => {
  let sut: { store: ChatStoreInstance; dispose: () => void }

  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    sut = makeStore()
    current = sut.store
    startTurn(sut.store)
    sut.store.applyMessageEvent(sid, { type: 'message.text_delta', payload: { sessionId: sid, delta: '截断正文' } })
    expireIdle(sut.store)
  })
  afterEach(() => {
    sut.dispose()
    current = undefined
    vi.useRealTimers()
  })

  it('时机③：下一条 message_start（新 turn）清旧标——旧 turn 的 complete 不恢复旧气泡（v1.1 反例重演）', () => {
    // 新 turn 开始（用户发新 prompt）→ 时机③清快照 + 新 streaming 实体
    sut.store.applyMessageEvent(sid, { type: 'message.message_start', payload: { sessionId: sid, messageId: 'a2' } })
    // turn B 正常完成：其 complete 不得把权威 content 覆盖到 turn A 旧气泡
    sut.store.applyMessageEvent(sid, { type: 'message.complete', payload: { sessionId: sid, stopReason: 'end_turn', content: 'turn B 权威正文', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } })
    const list = messages(sut.store)
    expect(list).toHaveLength(2)
    const turnA = list.find((m) => m.id === 'a1')!
    const turnB = list.find((m) => m.id === 'a2')!
    // 旧气泡保持 timeout error 态 + 标记已被时机③清除（不残留过时 UI 提示）
    expect(turnA.status).toBe('error')
    expect(turnA.content).toBe('截断正文')
    expect(turnA.prematureTimeout).toBeUndefined()
    // 新气泡正常定稿且独占权威 content/usage
    expect(turnB.status).toBe('complete')
    expect(turnB.content).toBe('turn B 权威正文')
    expect(turnB.usage).toEqual({ inputTokens: 1, outputTokens: 1 })
  })

  it('时机②：非 timeout finalizeSession（message.error 真实终态覆盖）清标——complete 不再恢复', () => {
    sut.store.applyMessageEvent(sid, { type: 'message.error', payload: { sessionId: sid, message: 'pi crashed' } })
    // a1 已 timeout error 终态（finalize 对终态实体 no-op）→ handler 手动追加纯 error 气泡
    const list = messages(sut.store)
    expect(list).toHaveLength(2)
    expect(list[0].id).toBe('a1')
    expect(list[1].content).toBe('pi crashed')
    lateComplete({ stopReason: 'end_turn', content: '不应恢复' })
    const after = messages(sut.store)
    expect(after).toHaveLength(2)
    const m = after[0]
    expect(m.status).toBe('error')
    expect(m.content).toBe('截断正文')
    // 时机②实体侧落实：真实 error 终态覆盖后残留打标作废（UI 恢复指引消失）
    expect(m.prematureTimeout).toBeUndefined()
  })

  it('时机④：resetTransientStates（disconnect 断连清理）清标——complete 不再恢复', () => {
    sut.store.resetTransientStates(sid, 'disconnect')
    lateComplete({ stopReason: 'end_turn', content: '不应恢复' })
    const m = messages(sut.store)[0]
    expect(m.status).toBe('error')
    expect(m.content).toBe('截断正文')
    expect(m.prematureTimeout).toBeUndefined()
  })

  it('时机⑤：disposeSession（session 删除）回收打标快照——分区销毁后无残留（u10/G4 dispose 补面）', () => {
    // 活跃期四时机全部依赖后续事件；session 删除后无事件到达，快照条目由 disposeSession
    // 显式回收（testInternals 只读视图断言——实体侧分区已删，实体断言不适用）。
    expect(sut.store.testInternals._prematureTimeoutIdsForTest.has(sid)).toBe(true)
    sut.store.disposeSession(sid)
    expect(sut.store.testInternals._prematureTimeoutIdsForTest.has(sid)).toBe(false)
  })
})

describe('premature-timeout — P-C 现状回归：complete 对无打标终态气泡 no-op', () => {
  let sut: { store: ChatStoreInstance; dispose: () => void }

  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    sut = makeStore()
    current = sut.store
  })
  afterEach(() => {
    sut.dispose()
    current = undefined
    vi.useRealTimers()
  })

  it('disconnect 收口的 error 气泡（无标）收到 complete：不改状态、不回填 usage、不覆盖内容', () => {
    startTurn(sut.store)
    sut.store.applyMessageEvent(sid, { type: 'message.text_delta', payload: { sessionId: sid, delta: '断连前正文' } })
    sut.store.resetTransientStates(sid, 'disconnect')
    const before = messages(sut.store)[0]
    expect(before.status).toBe('error')
    expect(before.prematureTimeout).toBeUndefined()
    lateComplete({ stopReason: 'end_turn', content: '迟到权威', usage: { inputTokens: 7, outputTokens: 7, totalTokens: 14 } })
    const m = messages(sut.store)[0]
    expect(m.status).toBe('error')
    expect(m.content).toBe('断连前正文')
    expect(m.usage).toBeUndefined()
  })

  it('已 complete 气泡再次收到 complete：幂等不变（终态 sealed）', () => {
    startTurn(sut.store)
    sut.store.applyMessageEvent(sid, { type: 'message.complete', payload: { sessionId: sid, stopReason: 'end_turn', content: '首次正文' } })
    lateComplete({ stopReason: 'end_turn', content: '二次正文', usage: { inputTokens: 8, outputTokens: 8, totalTokens: 16 } })
    const m = messages(sut.store)[0]
    expect(m.status).toBe('complete')
    expect(m.content).toBe('首次正文')
    expect(m.usage).toBeUndefined()
  })
})
