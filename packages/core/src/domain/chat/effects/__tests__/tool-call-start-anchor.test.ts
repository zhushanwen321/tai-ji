/**
 * tool_call_start 三级定位与幂等单测（chat-flow-consistency C1 + D3 规则 3）。
 *
 * 缺陷：interpreter 的 tool-call hook 是异步的——tool_call_start 帧可后置于下一回合
 * message_start（唯一乱序源），纯位置定位（findLastAssistantIndex）会把迟到帧错挂新回合
 * 气泡。修复（design-stream-presentation C1 方案）= 定位三级：
 * ① findToolCallOwner 全局 ID 锚定（条目已在场 → 幂等更新，含 D3 定稿重建补建的 running 条目）
 * ② entry.messageId 精确命中（锚点 = interpreter 在 hook await 前捕获的到达时归属；
 *    属主已终态且 ① 未命中 → 丢弃 + dev warn）
 * ③ findLastAssistantIndex 位置回退（锚点缺失的兼容路径，行为与升级前一致）
 *
 * 覆盖：
 * - A1 ① 级：D3 重建已补建 running 条目 + 新气泡在场 + 迟到 start → 命中旧气泡不重插
 * - A2 ② 级：条目不在场 + 锚点命中旧 streaming 气泡 → 挂旧气泡
 * - A3 ② 级防御：锚点属主已终态且条目不在场 → 丢弃 + dev warn（不给终态气泡复活 running 块）
 * - A4 ③ 级：锚点缺失 → 末条命中（现状行为逐字不变）
 * - A5 同气泡幂等：同 callId 重复 start 不重复追加（toolCalls 与 contentBlocks）
 * - A6 已收尾条目不倒退：tool_call_end 已回填终态后迟到 start → 保持终态
 *
 * 运行：pnpm -C packages/core exec vitest run src/domain/chat/effects/__tests__/tool-call-start-anchor.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { dispatchMessageEvent } from '../registry'
import { makeCtx, msg } from '../../__tests__/helpers/fixtures'
import type { MessageEffectContext } from '../../effect-types'
import type { Message, ServerMessage } from '@taiji/shared'
import { provideDevMode, __resetDevModeForTesting } from '../../../../platform/dev-mode'

const SID = 's-test'

function listOf(ctx: MessageEffectContext): Message[] {
  return ctx.messages.value.get(SID)?.value ?? []
}

function assistantAt(ctx: MessageEffectContext, id: string): Message {
  const found = listOf(ctx).find((m) => m.id === id)
  if (!found) throw new Error(`no assistant ${id}`)
  return found
}

/** tool_call_start 帧（entry 形态，messageId 锚点可选）。 */
function startFrame(toolCallId: string, opts: { messageId?: string; contentIndex?: number } = {}): ServerMessage {
  return msg(SID, 'message.tool_call_start', {
    entry: {
      type: 'toolCall',
      toolCallId,
      toolName: 'bash',
      arguments: { cmd: 'ls' },
      ...(opts.contentIndex !== undefined ? { contentIndex: opts.contentIndex } : {}),
      ...(opts.messageId !== undefined ? { messageId: opts.messageId } : {}),
    },
  })
}

afterEach(() => {
  __resetDevModeForTesting()
})

describe('tool_call_start 三级定位（C1）', () => {
  it('A1: ① 级——D3 重建补建的 running 条目 + 新气泡在场 + 迟到 start → 幂等不重插、落旧气泡', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'm-1' }))
    // 定稿重建补建 tc-1（工具执行严格晚于 message_end，补建置 running）
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_end', {
      messageId: 'm-1',
      entry: {
        type: 'message', parentId: null, timestamp: new Date(1700000000000).toISOString(),
        message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tc-1', name: 'bash', arguments: {} }], timestamp: 1700000000000 },
      },
    }))
    // 下一回合新气泡开（迟到窗口）：末条 assistant 已是 m-2
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'm-2' }))
    // 迟到的 tool_call_start（锚点 = m-1）：① findToolCallOwner 命中 m-1 已建条目
    dispatchMessageEvent(ctx, SID, startFrame('tc-1', { messageId: 'm-1' }))
    expect(assistantAt(ctx, 'm-1').toolCalls).toHaveLength(1)
    expect(assistantAt(ctx, 'm-1').toolCalls![0]).toMatchObject({ id: 'tc-1', status: 'running' })
    // 不挂新气泡
    expect(assistantAt(ctx, 'm-2').toolCalls).toBeUndefined()
    expect(assistantAt(ctx, 'm-2').contentBlocks).toEqual([])
  })

  it('A2: ② 级——条目不在场 + 锚点命中旧 streaming 气泡 → 挂旧气泡', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'm-1' }))
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'm-2' }))
    dispatchMessageEvent(ctx, SID, startFrame('tc-2', { messageId: 'm-1', contentIndex: 1 }))
    expect(assistantAt(ctx, 'm-1').toolCalls).toHaveLength(1)
    expect(assistantAt(ctx, 'm-1').toolCalls![0]).toMatchObject({ id: 'tc-2' })
    expect(assistantAt(ctx, 'm-1').contentBlocks).toEqual([{ type: 'toolCall', refId: 'tc-2', contentIndex: 1 }])
    expect(assistantAt(ctx, 'm-2').toolCalls).toBeUndefined()
  })

  it('A3: ② 级防御——锚点属主已终态且条目不在场 → 丢弃 + dev warn', () => {
    provideDevMode(true)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = makeCtx([
      { id: 'm-1', role: 'assistant', content: 'done', status: 'complete', timestamp: 1000 },
      { id: 'm-2', role: 'assistant', content: '', status: 'streaming', timestamp: 2000, contentBlocks: [] },
    ])
    dispatchMessageEvent(ctx, SID, startFrame('tc-late', { messageId: 'm-1' }))
    // 终态气泡不复活 running 块、streaming 新气泡不误挂
    expect(assistantAt(ctx, 'm-1').toolCalls).toBeUndefined()
    expect(assistantAt(ctx, 'm-2').toolCalls).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('refusing to revive running block')
    warnSpy.mockRestore()
  })

  it('A4: ③ 级——锚点缺失 → 末条命中（现状行为逐字不变）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'm-1' }))
    dispatchMessageEvent(ctx, SID, startFrame('tc-1'))
    expect(assistantAt(ctx, 'm-1').toolCalls).toHaveLength(1)
    expect(assistantAt(ctx, 'm-1').toolCalls![0]).toMatchObject({ id: 'tc-1', status: 'running' })
  })

  it('A5: 同气泡幂等——同 callId 重复 start 不重复追加（toolCalls 与 contentBlocks）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'm-1' }))
    dispatchMessageEvent(ctx, SID, startFrame('tc-1', { contentIndex: 0 }))
    dispatchMessageEvent(ctx, SID, startFrame('tc-1', { contentIndex: 0 }))
    const m = assistantAt(ctx, 'm-1')
    expect(m.toolCalls).toHaveLength(1)
    expect(m.contentBlocks).toHaveLength(1)
  })

  it('A6: 已收尾条目不倒退——tool_call_end 终态回填后迟到 start → 保持终态', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'm-1' }))
    dispatchMessageEvent(ctx, SID, startFrame('tc-1'))
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.tool_call_end', {
      entry: {
        type: 'message', parentId: null, timestamp: new Date(0).toISOString(),
        message: { role: 'toolResult', toolCallId: 'tc-1', toolName: 'bash', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 0 },
      },
    }))
    expect(assistantAt(ctx, 'm-1').toolCalls![0]).toMatchObject({ status: 'completed', output: 'ok' })
    // 迟到的重复 start：① 命中已终态条目 → 幂等 no-op，不倒退回 running
    dispatchMessageEvent(ctx, SID, startFrame('tc-1', { messageId: 'm-1' }))
    expect(assistantAt(ctx, 'm-1').toolCalls).toHaveLength(1)
    expect(assistantAt(ctx, 'm-1').toolCalls![0]).toMatchObject({ status: 'completed', output: 'ok' })
  })
})
