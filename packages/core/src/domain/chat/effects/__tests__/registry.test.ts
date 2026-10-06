/**
 * message_start 幂等查重单测（remote-use-shell-unification D1 / U1）。
 *
 * 设计锚点 = tech-design §3.3 D1：message.message_start handler 增加查重——同 id 气泡
 * 已存在则复用该气泡不 append。查重命中仅跳过 append：不改已有气泡 status（已终结保持
 * 终态——sealed guard 使后续 delta 幂等丢弃，内容不丢；流式中保持 streaming，delta 由
 * 「最后一条 streaming assistant」定位继续累积到原气泡），clearPendingSend 照常执行——
 * 以早返回实现会跳过 clear，把乐观态卡在 pending 窗口。防御射程 = 同源重复帧（重订
 * 全量回放 / 重连回拉重叠段，两次投递同 messageId）；跨源重复归 D2 链时序对齐，不归
 * 本查重。
 *
 * 覆盖（验收条款三用例 + 正常路径回归锚）：
 * - AC1 同 messageId 双投只产一气泡
 * - AC2a 查重命中·已终结形态 status 不变（complete 保持终态，内容/终态字段不动）
 * - AC2b 查重命中·流式中形态 status 不变（streaming 保持，后续 delta 继续累积到原气泡）
 * - AC3 pendingSend 未清窗口：同 messageId 双投 clearPendingSend 照常执行（不卡乐观态）
 * - 回归锚：未命中（新 messageId）照常 append + clearPendingSend（正常路径行为不变）
 *
 * 运行：pnpm -C packages/core test src/domain/chat/effects/__tests__/registry.test.ts
 */
import { describe, it, expect } from 'vitest'
import { dispatchMessageEvent } from '../registry'
import { makeCtx, msg } from '../../__tests__/helpers/fixtures'
import type { MessageEffectContext } from '../../effect-types'
import type { Message } from '@taiji/shared'

const SID = 's-test'

const startFrame = (messageId: string) => msg(SID, 'message.message_start', { messageId })

/** 构造既有 assistant 气泡（预置分区用；默认 streaming 形态，字段与 handler 新建气泡同构）。 */
function assistantBubble(over: Partial<Message> = {}): Message {
  return {
    id: 'm-1',
    role: 'assistant',
    content: '',
    status: 'streaming',
    timestamp: 1000,
    contentBlocks: [],
    ...over,
  }
}

function listOf(ctx: MessageEffectContext): Message[] {
  return ctx.messages.value.get(SID)?.value ?? []
}

describe('message_start 幂等查重（D1：同源重复帧复用不 append）', () => {
  it('AC1: 同 messageId 双投只产一气泡（第二条复用已有气泡）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, startFrame('m-1'))
    dispatchMessageEvent(ctx, SID, startFrame('m-1'))
    const list = listOf(ctx)
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('m-1')
    expect(list[0].status).toBe('streaming')
  })

  it('AC2a: 查重命中·已终结形态——complete 气泡保持终态（status/内容/终态字段逐项不动）', () => {
    const sealedBubble = assistantBubble({ content: '已完成回复', status: 'complete', endedAt: 2000 })
    const ctx = makeCtx([sealedBubble])
    dispatchMessageEvent(ctx, SID, startFrame('m-1'))
    const list = listOf(ctx)
    expect(list).toHaveLength(1)
    expect(list[0]).toEqual(sealedBubble)
    expect(list[0].status).toBe('complete')
    expect(list[0].content).toBe('已完成回复')
    expect(list[0].endedAt).toBe(2000)
  })

  it('AC2b: 查重命中·流式中形态——保持 streaming，后续 delta 继续累积到原气泡', () => {
    const ctx = makeCtx([assistantBubble({ content: 'partial' })])
    dispatchMessageEvent(ctx, SID, startFrame('m-1'))
    let list = listOf(ctx)
    expect(list).toHaveLength(1)
    expect(list[0].status).toBe('streaming')
    // start 帧复用不清空既有累积内容（不重置气泡）
    expect(list[0].content).toBe('partial')
    // delta 累积目标由「最后一条 streaming assistant」定位——复用后自然落到原气泡
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.text_delta', { delta: ' more' }))
    list = listOf(ctx)
    expect(list).toHaveLength(1)
    expect(list[0].content).toBe('partial more')
  })

  it('AC3: pendingSend 未清窗口——查重命中帧 clearPendingSend 照常执行（不卡乐观态）', () => {
    // 场景：重订回放/重叠段双投，分区已有同 id 气泡（首轮投递或基线已建），乐观气泡
    // pending 窗口尚未清——查重命中仍必须执行 clear（早返回实现会跳过 clear 卡住乐观态）
    const ctx = makeCtx([assistantBubble({ status: 'complete' })])
    dispatchMessageEvent(ctx, SID, startFrame('m-1'))
    expect(ctx.clearPendingSend).toHaveBeenCalledTimes(1)
    expect(ctx.clearPendingSend).toHaveBeenCalledWith(SID)
    // 第二帧（同 messageId 重复帧）查重命中同样不早返回，clear 照常
    dispatchMessageEvent(ctx, SID, startFrame('m-1'))
    expect(ctx.clearPendingSend).toHaveBeenCalledTimes(2)
  })

  it('回归锚: 未命中（新 messageId）照常 append 新 streaming 气泡 + clearPendingSend', () => {
    const ctx = makeCtx([assistantBubble({ id: 'm-0', status: 'complete' })])
    dispatchMessageEvent(ctx, SID, startFrame('m-1'))
    const list = listOf(ctx)
    expect(list).toHaveLength(2)
    expect(list[1].id).toBe('m-1')
    expect(list[1].status).toBe('streaming')
    expect(ctx.clearPendingSend).toHaveBeenCalledWith(SID)
  })
})
