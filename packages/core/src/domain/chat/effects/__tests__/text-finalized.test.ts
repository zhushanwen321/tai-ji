/**
 * message_end 文本定稿标记单测（chat-flow-text-color D1）。
 *
 * 设计锚点 = shared.Message.textFinalized 注释 + registry.ts markStreamingAssistantTextFinalized：
 * pi 回合 =「assistant 消息 → 工具 → assistant 消息 → …」循环，live 气泡 status 要到回合级
 * message.complete 才整体收口；message_end（assistant role）当下按位置给末条 streaming
 * 气泡打 textFinalized，UI（Turn.unitBlockProps）据此逐消息派生正文颜色——长工具回合中
 * 已写完的正文不再滞留 streaming 灰。
 *
 * 覆盖：
 * - AC1 assistant end：末条 streaming 气泡被打标（textFinalized=true），status 保持
 *   streaming（sealed guard isLastAssistantStreaming 依赖 streaming 态定位工具事件属主，
 *   提前翻 complete 会丢 tool_execution_* 帧）
 * - AC2 序列形态：两条消息各自在自己的 end 时刻被打标（互不串扰）
 * - AC3 user role end 不打标
 * - AC4 toolResult role end 不打标（tool_execution_end + message_end 双帧，reducer 喂入
 *   走本 handler，但非 assistant role）
 * - AC5 无 streaming 气泡（已全部终态 / 空分区）→ no-op 不崩
 * - AC6 已打标气泡不被二次触碰（幂等，不新增帧副作用）
 *
 * 运行：pnpm -C packages/core test src/domain/chat/effects/__tests__/text-finalized.test.ts
 */
import { describe, it, expect } from 'vitest'
import { dispatchMessageEvent } from '../registry'
import { makeCtx, msg, msgEntry } from '../../__tests__/helpers/fixtures'
import type { MessageEffectContext } from '../../effect-types'
import type { Message, ServerMessage } from '@taiji/shared'

const SID = 's-test'

function listOf(ctx: MessageEffectContext): Message[] {
  return ctx.messages.value.get(SID)?.value ?? []
}

/** 预置 streaming assistant 气泡（字段与 message_start handler 新建气泡同构）。 */
function streamingBubble(id: string, over: Partial<Message> = {}): Message {
  return {
    id,
    role: 'assistant',
    content: '',
    status: 'streaming',
    timestamp: 1000,
    contentBlocks: [],
    ...over,
  }
}

/** message_end 帧（assistant/user/toolResult role，content 落盘形态）。 */
function endFrame(role: string, text: string): ServerMessage {
  return msg(SID, 'message.message_end', {
    entry: msgEntry(`entry-${role}-${Math.random().toString(36).slice(2, 8)}`, {
      role,
      content: text ? [{ type: 'text', text }] : [],
      timestamp: Date.now(),
    }),
  })
}

describe('message_end 文本定稿标记（chat-flow-text-color D1）', () => {
  it('AC1: assistant end 打标末条 streaming 气泡，status 保持 streaming（sealed guard 依赖）', () => {
    const ctx = makeCtx([streamingBubble('m-1', { content: '已写完的分析' })])
    dispatchMessageEvent(ctx, SID, endFrame('assistant', '已写完的分析'))
    const list = listOf(ctx)
    expect(list).toHaveLength(1)
    expect(list[0].textFinalized).toBe(true)
    expect(list[0].status).toBe('streaming')
  })

  it('AC2: 两条消息序列——各自在自己的 end 时刻被打标', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'm-1' }))
    dispatchMessageEvent(ctx, SID, endFrame('assistant', '第一段'))
    expect(listOf(ctx)[0]).toMatchObject({ id: 'm-1', textFinalized: true, status: 'streaming' })

    dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'm-2' }))
    // m-2 start 后、m-2 end 前：m-1 已定稿，m-2 未定稿（无 textFinalized 键）
    expect(listOf(ctx)[1].id).toBe('m-2')
    expect(listOf(ctx)[1]).not.toHaveProperty('textFinalized')
    dispatchMessageEvent(ctx, SID, endFrame('assistant', '第二段'))
    expect(listOf(ctx)[1]).toMatchObject({ id: 'm-2', textFinalized: true, status: 'streaming' })
  })

  it('AC3: user role end 不打标', () => {
    const ctx = makeCtx([streamingBubble('m-1')])
    dispatchMessageEvent(ctx, SID, endFrame('user', '用户消息'))
    expect(listOf(ctx)[0].textFinalized).toBeUndefined()
  })

  it('AC4: toolResult role end 不打标', () => {
    const ctx = makeCtx([streamingBubble('m-1')])
    dispatchMessageEvent(ctx, SID, endFrame('toolResult', '工具结果'))
    expect(listOf(ctx)[0].textFinalized).toBeUndefined()
  })

  it('AC5: 无 streaming 气泡（终态/空分区）→ no-op 不崩', () => {
    const settled = makeCtx([streamingBubble('m-1', { status: 'complete', content: 'done' })])
    expect(() => dispatchMessageEvent(settled, SID, endFrame('assistant', 'x'))).not.toThrow()
    expect(listOf(settled)[0].textFinalized).toBeUndefined()

    const empty = makeCtx([])
    expect(() => dispatchMessageEvent(empty, SID, endFrame('assistant', 'x'))).not.toThrow()
    expect(listOf(empty)).toHaveLength(0)
  })

  it('AC6: 已打标气泡幂等——重复 assistant end 不再改动列表', () => {
    const ctx = makeCtx([streamingBubble('m-1')])
    dispatchMessageEvent(ctx, SID, endFrame('assistant', '正文'))
    const after = listOf(ctx)
    dispatchMessageEvent(ctx, SID, endFrame('assistant', '正文'))
    expect(listOf(ctx)).toEqual(after)
  })
})
