/**
 * thinking_start 同 id 幂等单测（chat-flow-consistency D3 规则 6）。
 *
 * 缺陷（P3a 三缺陷之二）：thinking_start 无幂等——重复 start 建出第二段逐字相同思考
 * （GLM 生产实例：同回合两段 404 字重复思考）。修复 = 同 thinkingId 已在场则跳过重复
 * 建块（thinking 数组与 contentBlocks 均不重复追加）；定稿前的残余窗口（不同 id 的空
 * 思考条目轮）由 D3 定稿重建收敛——本条只缩小窗口，正确性不依赖它。
 *
 * 覆盖：
 * - I1 同 thinkingId 重复 start：单块
 * - I2 不同 thinkingId：各建一块（幂等不误伤正常多段思考）
 * - I3 缺 thinkingId（fallback 随机 id）：重复帧照建（随机 id 恒不在场，查重不影响缺省分支）
 * - I4 幂等后 delta 累积不受影响
 *
 * 运行：pnpm -C packages/core exec vitest run src/domain/chat/effects/__tests__/thinking-start-idempotent.test.ts
 */
import { describe, it, expect } from 'vitest'
import { dispatchMessageEvent } from '../registry'
import { makeCtx, msg } from '../../__tests__/helpers/fixtures'
import type { MessageEffectContext } from '../../effect-types'
import type { Message } from '@taiji/shared'

const SID = 's-test'

function lastAssistant(ctx: MessageEffectContext): Message {
  const list = ctx.messages.value.get(SID)?.value ?? []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].role === 'assistant') return list[i]
  }
  throw new Error('no assistant')
}

describe('thinking_start 同 id 幂等（D3 规则 6）', () => {
  it('I1: 同 thinkingId 重复 start → 单块（thinking 与 contentBlocks 均不重复）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_start', { thinkingId: 'th1', contentIndex: 0 }))
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_delta', { delta: '思考中' }))
    // 重复投递的 start（同 id）：跳过建块
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_start', { thinkingId: 'th1', contentIndex: 0 }))
    const a = lastAssistant(ctx)
    expect(a.thinking).toHaveLength(1)
    expect(a.thinking![0]).toMatchObject({ id: 'th1', content: '思考中' })
    expect(a.contentBlocks).toEqual([{ type: 'thinking', refId: 'th1', contentIndex: 0 }])
  })

  it('I2: 不同 thinkingId → 各建一块（正常多段思考不受幂等影响）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_start', { thinkingId: 'th1', contentIndex: 0 }))
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_start', { thinkingId: 'th2', contentIndex: 2 }))
    const a = lastAssistant(ctx)
    expect(a.thinking).toHaveLength(2)
    expect(a.thinking!.map((t) => t.id)).toEqual(['th1', 'th2'])
    expect(a.contentBlocks).toHaveLength(2)
  })

  it('I3: 缺 thinkingId（fallback 随机 id）→ 重复帧照建（查重不影响缺省分支）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_start', {}))
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_start', {}))
    expect(lastAssistant(ctx).thinking).toHaveLength(2)
  })

  it('I4: 幂等命中后 delta 累积照常进原块', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'a1' }))
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_start', { thinkingId: 'th1' }))
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_start', { thinkingId: 'th1' }))
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_delta', { delta: 'A' }))
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_delta', { delta: 'B' }))
    const a = lastAssistant(ctx)
    expect(a.thinking).toHaveLength(1)
    expect(a.thinking![0].content).toBe('AB')
  })
})
