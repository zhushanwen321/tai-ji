/**
 * delta-coalescer 单测（W12，perf 07 §3.3.1 (7) + 裁决 R-18）。
 *
 * 对照 07 文档探针 P6-P8 与 W12 验收 4 条：
 * ① 同 microtask 内 N 条同 sid text_delta 只触发一次 dispatch（P6 合并率）；
 * ② 合成对象 delta 文本有序拼接 + contentIndex 取首条（R-18 透传）+ 首条 id 透传；
 * ③ 终态（非 delta）消息到达时缓冲同步立即 flush，先 delta 后终态有序（P7 终态即时）；
 * ④ 异 sid 各自独立缓冲，互不阻塞（A 的缓冲不因 B 的终态被提前 flush）。
 *
 * dispatch 用 vi.fn() 直测（纯模块级测试，不 mount store）；useChat 接线正确性
 * 见 useChat.test.ts 的 D-2 集成用例。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ServerMessage } from '@taiji/shared'
import { createMessageCoalescer } from '../delta-coalescer'

/** 构造 ServerMessage（payload 默认带 sessionId，对齐 useChat.test.ts 的 msg helper） */
function msg(sid: string, type: string, payload: Record<string, unknown> = {}): ServerMessage {
  return { type, payload: { sessionId: sid, ...payload } } as ServerMessage
}

/**
 * 排一个在「coalescer 的 flush-microtask 之后」resolve 的 microtask：
 * enqueue 内的 queueMicrotask 先入队，本 helper 后入队 → resolve 时 flush 必已执行。
 */
function afterMicrotask(): Promise<void> {
  return new Promise((resolve) => {
    queueMicrotask(() => resolve())
  })
}

function readPayload(m: ServerMessage): Record<string, unknown> {
  return m.payload as Record<string, unknown>
}

describe('delta-coalescer（D-2 token 合帧）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('同 microtask 窗口内 N 条同 sid text_delta 只 dispatch 一次：拼接有序 + contentIndex 取首条（R-18）', async () => {
    const c = createMessageCoalescer()
    const dispatch = vi.fn()
    c.enqueue('s1', msg('s1', 'message.text_delta', { delta: 'He', contentIndex: 2 }), dispatch)
    c.enqueue('s1', msg('s1', 'message.text_delta', { delta: 'll', contentIndex: 2 }), dispatch)
    c.enqueue('s1', msg('s1', 'message.text_delta', { delta: 'o', contentIndex: 3 }), dispatch)
    // microtask 前：全部缓冲中，零 dispatch
    expect(dispatch).not.toHaveBeenCalled()
    await afterMicrotask()
    expect(dispatch).toHaveBeenCalledTimes(1)
    const m = dispatch.mock.calls[0][0]
    expect(m.type).toBe('message.text_delta')
    expect(readPayload(m).delta).toBe('Hello')
    // 首条 contentIndex 是定位依据（registry insertContentBlockByIndex），后续条（含不同的 3）不参与
    expect(readPayload(m).contentIndex).toBe(2)
  })

  it('合成对象透传首条 id 与 payload 伴随字段（R-18：完整 ServerMessage 形状；seq 不合成）', async () => {
    const c = createMessageCoalescer()
    const dispatch = vi.fn()
    c.enqueue(
      's2',
      { type: 'message.text_delta', id: 'mid-1', payload: { sessionId: 's2', delta: 'a', extra: 'keep-me' } },
      dispatch,
    )
    c.enqueue('s2', msg('s2', 'message.text_delta', { delta: 'b' }), dispatch)
    await afterMicrotask()
    expect(dispatch).toHaveBeenCalledTimes(1)
    const m = dispatch.mock.calls[0][0]
    expect(m.id).toBe('mid-1')
    expect(readPayload(m).extra).toBe('keep-me')
    expect(m.seq).toBeUndefined()
  })

  it('首条无 contentIndex 时合成对象不带 contentIndex（首条即定位依据，undefined 不冒充）', async () => {
    const c = createMessageCoalescer()
    const dispatch = vi.fn()
    c.enqueue('s3', msg('s3', 'message.text_delta', { delta: 'x' }), dispatch)
    c.enqueue('s3', msg('s3', 'message.text_delta', { delta: 'y', contentIndex: 5 }), dispatch)
    await afterMicrotask()
    const m = dispatch.mock.calls[0][0]
    expect(readPayload(m).delta).toBe('xy')
    expect(readPayload(m).contentIndex).toBeUndefined()
  })

  it('同 sid 的 text 与 thinking delta 分 key 缓冲，互不合并', async () => {
    const c = createMessageCoalescer()
    const dispatch = vi.fn()
    c.enqueue('s4', msg('s4', 'message.text_delta', { delta: 't1' }), dispatch)
    c.enqueue('s4', msg('s4', 'message.thinking_delta', { delta: 'k1' }), dispatch)
    c.enqueue('s4', msg('s4', 'message.text_delta', { delta: 't2' }), dispatch)
    await afterMicrotask()
    expect(dispatch).toHaveBeenCalledTimes(2)
    const types = dispatch.mock.calls.map((call) => call[0].type)
    expect(types).toContain('message.text_delta')
    expect(types).toContain('message.thinking_delta')
    const text = dispatch.mock.calls.find((call) => call[0].type === 'message.text_delta')![0]
    const thinking = dispatch.mock.calls.find((call) => call[0].type === 'message.thinking_delta')![0]
    expect(readPayload(text).delta).toBe('t1t2')
    expect(readPayload(thinking).delta).toBe('k1')
  })

  it('非 delta 消息到达：缓冲同步立即 flush，先合成 delta 后原消息（终态即时，不等 microtask）', () => {
    const c = createMessageCoalescer()
    const dispatch = vi.fn()
    c.enqueue('s5', msg('s5', 'message.text_delta', { delta: 'par' }), dispatch)
    c.enqueue('s5', msg('s5', 'message.text_delta', { delta: 'tial' }), dispatch)
    const complete = msg('s5', 'message.complete', { stopReason: 'end_turn' })
    c.enqueue('s5', complete, dispatch)
    // 同步断言（不 await）：终态消息处理时缓冲已 flush——先 delta 后终态的顺序保证
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(dispatch.mock.calls[0][0].type).toBe('message.text_delta')
    expect(readPayload(dispatch.mock.calls[0][0]).delta).toBe('partial')
    // 非 delta 原消息直传（引用恒等，不合成）
    expect(dispatch.mock.calls[1][0]).toBe(complete)
  })

  it('tool_call_start 插入时同样先 flush 缓冲（message.* 全类非 delta 均走即时路径）', () => {
    const c = createMessageCoalescer()
    const dispatch = vi.fn()
    c.enqueue('s6', msg('s6', 'message.thinking_delta', { delta: 'th' }), dispatch)
    c.enqueue('s6', msg('s6', 'message.tool_call_start', { toolCallId: 'tc1', toolName: 'read' }), dispatch)
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(dispatch.mock.calls[0][0].type).toBe('message.thinking_delta')
    expect(readPayload(dispatch.mock.calls[0][0]).delta).toBe('th')
    expect(dispatch.mock.calls[1][0].type).toBe('message.tool_call_start')
  })

  it('异 sid 各自独立缓冲：B 的终态只 flush B，A 不受影响（异 sid 不互相阻塞）', async () => {
    const c = createMessageCoalescer()
    const dispatchA = vi.fn()
    const dispatchB = vi.fn()
    c.enqueue('A', msg('A', 'message.text_delta', { delta: 'a1' }), dispatchA)
    c.enqueue('B', msg('B', 'message.text_delta', { delta: 'b1' }), dispatchB)
    // B 到达终态 → 同步只 flush B（B 合成 delta + B complete）
    c.enqueue('B', msg('B', 'message.complete', { stopReason: 'end_turn' }), dispatchB)
    expect(dispatchB).toHaveBeenCalledTimes(2)
    // A 仍缓冲中（未被 B 的终态提前打断合并窗口）
    expect(dispatchA).not.toHaveBeenCalled()
    await afterMicrotask()
    expect(dispatchA).toHaveBeenCalledTimes(1)
    expect(readPayload(dispatchA.mock.calls[0][0]).delta).toBe('a1')
    // B 的缓冲已被同步 flush 清掉，microtask 不重复 dispatch
    expect(dispatchB).toHaveBeenCalledTimes(2)
  })

  it('跨 microtask 窗口：第二轮 delta 重新合并（scheduled 复位）', async () => {
    const c = createMessageCoalescer()
    const dispatch = vi.fn()
    c.enqueue('s7', msg('s7', 'message.text_delta', { delta: 'a' }), dispatch)
    await afterMicrotask()
    c.enqueue('s7', msg('s7', 'message.text_delta', { delta: 'b' }), dispatch)
    c.enqueue('s7', msg('s7', 'message.text_delta', { delta: 'c' }), dispatch)
    await afterMicrotask()
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(readPayload(dispatch.mock.calls[0][0]).delta).toBe('a')
    expect(readPayload(dispatch.mock.calls[1][0]).delta).toBe('bc')
  })

  it('flush 逐 buffer 错误隔离：一个 sid 抛错不阻塞其余缓冲，且不向上 throw', async () => {
    const c = createMessageCoalescer()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bad = vi.fn(() => {
      throw new Error('apply boom')
    })
    const good = vi.fn()
    c.enqueue('bad', msg('bad', 'message.text_delta', { delta: 'x' }), bad)
    c.enqueue('good', msg('good', 'message.text_delta', { delta: 'y' }), good)
    await afterMicrotask() // 不 throw（错误被隔离为 warn）
    expect(bad).toHaveBeenCalledTimes(1)
    expect(good).toHaveBeenCalledTimes(1)
    expect(readPayload(good.mock.calls[0][0]).delta).toBe('y')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('flush(sid) 只 flush 目标 sid（disposeSession 收口兜底），flush() 清全部', () => {
    const c = createMessageCoalescer()
    const dispatchA = vi.fn()
    const dispatchB = vi.fn()
    c.enqueue('A', msg('A', 'message.text_delta', { delta: 'a' }), dispatchA)
    c.enqueue('B', msg('B', 'message.text_delta', { delta: 'b' }), dispatchB)
    c.flush('A')
    expect(dispatchA).toHaveBeenCalledTimes(1)
    expect(dispatchB).not.toHaveBeenCalled()
    c.flush()
    expect(dispatchB).toHaveBeenCalledTimes(1)
    // 全部清空后再次 flush 幂等
    c.flush()
    expect(dispatchA).toHaveBeenCalledTimes(1)
    expect(dispatchB).toHaveBeenCalledTimes(1)
  })

  it('clear() 丢弃全部缓冲（测试隔离）：残留 delta 不再 dispatch，后续 enqueue 正常工作', async () => {
    const c = createMessageCoalescer()
    const dispatch = vi.fn()
    c.enqueue('s8', msg('s8', 'message.text_delta', { delta: 'stale' }), dispatch)
    c.clear()
    await afterMicrotask()
    expect(dispatch).not.toHaveBeenCalled()
    // clear 后功能未损坏
    c.enqueue('s8', msg('s8', 'message.text_delta', { delta: 'fresh' }), dispatch)
    await afterMicrotask()
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(readPayload(dispatch.mock.calls[0][0]).delta).toBe('fresh')
  })
})
