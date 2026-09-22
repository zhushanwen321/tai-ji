/**
 * EventAdapter TTFT 锚点翻译测试（composer-genstats-ttft U2，设计 §3.2）。
 *
 * 锁定：
 * - turn_start 移出 NULL_EVENTS → 翻译为 llm-request-start（TTFT 起算锚点，无前端行为）
 * - text_start / thinking_start / toolcall_start 三子类型追加 llm-first-output（首输出信号，
 *   单点收）；既有行为不变——text/toolcall 原 noop 保留、message.thinking_start 帧行为保留
 * - delta / end / error 子类型不产 llm-first-output（否决表 E：无 delta 兜底钩——adapter 是
 *   唯一信号源，delta 路径零新增开销）
 *
 * translate 是纯函数（event-adapter.ts 头注释），直接调用断言产出消息。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/event-adapter-ttft-anchors.test.ts
 */
import { describe, it, expect } from 'vitest'
import { translate } from '../event-adapter.js'
import type { PiMessageUpdateEvent, PiTurnStartEvent } from '../pi-protocol.js'

/** 构造 message_update 事件（assistantMessageEvent 子事件形状）。 */
function messageUpdate(sub: Record<string, unknown>): PiMessageUpdateEvent {
  return { type: 'message_update', assistantMessageEvent: sub } as unknown as PiMessageUpdateEvent
}

/** 构造 turn_start 事件（wire 无 payload）。 */
function turnStart(): PiTurnStartEvent {
  return { type: 'turn_start' } as unknown as PiTurnStartEvent
}

/** 取产出中的 llm-first-output 个数。 */
function firstOutputCount(events: ReturnType<typeof translate>): number {
  return events.filter((e) => e.kind === 'llm-first-output').length
}

/** 取产出中的 llm-request-start 个数。 */
function requestStartCount(events: ReturnType<typeof translate>): number {
  return events.filter((e) => e.kind === 'llm-request-start').length
}

describe('EventAdapter TTFT 锚点翻译（composer-genstats-ttft U2）', () => {
  it('T1: turn_start → 恰一个 llm-request-start（sessionId 归属，无其他产出）', () => {
    const events = translate(turnStart(), 's1')
    expect(events).toEqual([{ kind: 'llm-request-start', sessionId: 's1' }])
    expect(requestStartCount(events)).toBe(1)
  })

  it('T2: text_start → noop 保留 + 追加 llm-first-output（原 noop 行为不变，仅追加）', () => {
    const events = translate(messageUpdate({ type: 'text_start', contentIndex: 0 }), 's1')
    expect(events).toEqual([
      { kind: 'noop' },
      { kind: 'llm-first-output', sessionId: 's1' },
    ])
  })

  it('T3: toolcall_start → noop 保留 + 追加 llm-first-output（纯 tool_call 响应的唯一首输出子类型）', () => {
    const events = translate(messageUpdate({ type: 'toolcall_start', contentIndex: 3 }), 's1')
    expect(events).toEqual([
      { kind: 'noop' },
      { kind: 'llm-first-output', sessionId: 's1' },
    ])
  })

  it('T4: thinking_start → message.thinking_start 帧行为不变（含 contentIndex 透传）+ 追加 llm-first-output', () => {
    const events = translate(messageUpdate({ type: 'thinking_start', contentIndex: 2 }), 's1')
    expect(events).toEqual([
      {
        kind: 'message',
        message: {
          type: 'message.thinking_start',
          payload: { sessionId: 's1', contentIndex: 2 },
        },
      },
      { kind: 'llm-first-output', sessionId: 's1' },
    ])
  })

  it('T4b: thinking_start 无 contentIndex → payload 省略字段（既有形态不变）', () => {
    const events = translate(messageUpdate({ type: 'thinking_start' }), 's1')
    expect(events[0]).toEqual({
      kind: 'message',
      message: { type: 'message.thinking_start', payload: { sessionId: 's1' } },
    })
    expect(firstOutputCount(events)).toBe(1)
  })

  it('E1 否决表 E 钉：delta 子类型不产 llm-first-output（text/thinking/toolcall delta 零新增）', () => {
    expect(firstOutputCount(translate(messageUpdate({ type: 'text_delta', delta: 'hi' }), 's1'))).toBe(0)
    expect(firstOutputCount(translate(messageUpdate({ type: 'thinking_delta', delta: '思考' }), 's1'))).toBe(0)
    expect(firstOutputCount(translate(messageUpdate({ type: 'toolcall_delta', delta: '{"a"' }), 's1'))).toBe(0)
  })

  it('E2: end 子类型不产 llm-first-output（text_end / thinking_end / toolcall_end）', () => {
    expect(firstOutputCount(translate(messageUpdate({ type: 'text_end' }), 's1'))).toBe(0)
    expect(firstOutputCount(translate(messageUpdate({ type: 'thinking_end' }), 's1'))).toBe(0)
    // toolcall_end 既有产 tool-call-index 顺序锚点行为不变，无 first-output
    const events = translate(
      messageUpdate({ type: 'toolcall_end', contentIndex: 1, toolCall: { id: 'tc-1' } }),
      's1',
    )
    expect(events).toEqual([{ kind: 'tool-call-index', toolCallId: 'tc-1', contentIndex: 1 }])
  })

  it('E3: error 子类型产 message.stream_error 不产 llm-first-output（错误流非输出信号）', () => {
    // wire 真实字段 = {reason, error:{errorMessage}}（PiErrorSubEvent，dev RT-2#2 修复后的读取路径）
    const events = translate(messageUpdate({ type: 'error', reason: 'error', error: { errorMessage: 'boom' } }), 's1')
    expect(events).toEqual([{
      kind: 'message',
      message: { type: 'message.stream_error', payload: { sessionId: 's1', content: 'boom', kind: 'error' } },
    }])
  })

  it('E4 回归：message_update 子事件缺 assistantMessageEvent 仍 noop（防御分支不变）', () => {
    const events = translate({ type: 'message_update' } as unknown as PiMessageUpdateEvent, 's1')
    expect(events).toEqual([{ kind: 'noop' }])
    expect(firstOutputCount(events)).toBe(0)
  })
})
