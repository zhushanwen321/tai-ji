/**
 * EventAdapter delta 透传测试（wave:perf-w07 微项 1）。
 *
 * 锁定：message_update 翻译出的 delta 帧对 contentIndex 的透传契约——
 * text_delta / thinking_delta / thinking_start 均透传 pi 的 contentIndex，
 * 为 W12（D-2 token coalescing，DeltaBuffer 合帧保留首条 contentIndex）保住
 * thinking 块的有序插入锚点。renderer 现状 handler 未消费该字段，多余字段无害。
 *
 * translate 是纯函数（event-adapter.ts 头注释），直接调用断言产出消息。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/event-adapter-delta.test.ts
 */
import { describe, it, expect } from 'vitest'
import { translate } from '../event-adapter.js'
import type { PiMessageUpdateEvent } from '../pi-protocol.js'

/** 构造 message_update 事件（assistantMessageEvent 子事件形状）。 */
function messageUpdate(sub: Record<string, unknown>): PiMessageUpdateEvent {
  return { type: 'message_update', assistantMessageEvent: sub } as unknown as PiMessageUpdateEvent
}

/** 从 translate 产出中取出唯一 message（断言前收窄 kind 联合）。 */
function soleMessage(events: ReturnType<typeof translate>) {
  expect(events).toHaveLength(1)
  const [ev] = events
  if (!ev || ev.kind !== 'message') {
    throw new Error(`expected single message event, got: ${JSON.stringify(ev)}`)
  }
  return ev.message
}

describe('EventAdapter delta contentIndex 透传（wave:perf-w07 微项 1）', () => {
  it('W07-5: thinking_delta 透传 contentIndex（对齐 text_delta 契约）', () => {
    const msg = soleMessage(
      translate(messageUpdate({ type: 'thinking_delta', delta: '思考中', contentIndex: 2 }), 's1'),
    )
    expect(msg.type).toBe('message.thinking_delta')
    expect(msg.payload).toEqual({ sessionId: 's1', delta: '思考中', contentIndex: 2 })
  })

  it('W07-5b: thinking_delta 无 contentIndex 时省略字段（向后兼容旧 pi）', () => {
    const msg = soleMessage(translate(messageUpdate({ type: 'thinking_delta', delta: 'x' }), 's1'))
    expect(msg.payload).toEqual({ sessionId: 's1', delta: 'x' })
  })

  it('W07-5c: text_delta 对照组——既有 contentIndex 透传不回归', () => {
    const msg = soleMessage(
      translate(messageUpdate({ type: 'text_delta', delta: 'hi', contentIndex: 0 }), 's1'),
    )
    expect(msg.type).toBe('message.text_delta')
    expect(msg.payload).toEqual({ sessionId: 's1', delta: 'hi', contentIndex: 0 })
  })

  // [HISTORICAL] W07-5d「translate 纯函数同输入同输出」用例已删（2026-09 测试舰队审查 r2-22）：
  // 对任意纯函数恒真，不锁任何 delta 特有行为；纯函数性由全文件 toEqual 精确断言隐式承担。
})
