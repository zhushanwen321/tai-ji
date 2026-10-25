/**
 * message_end(assistant) 定稿权威重建单测（chat-flow-consistency D3 + C2）。
 *
 * 权威语义（设计 §3.3 D3 六规则 + §6 呈报 1 id 锚定升级）：entry 载荷是该消息内容的权威，
 * message_end(assistant) 当下按载荷整条重建气泡的 contentBlocks / thinking / toolCalls /
 * content / usage / endedAt，与重开路径共用 collectContentParts（live ≡ reload 构造性保持）。
 * 重复思考在定稿时刻消除；textFinalized 标记与重建共用同一次定位（C2 统一）。
 *
 * 覆盖：
 * - R1 基础重建：正文全文 / contentBlocks / usage / endedAt / textFinalized / status 保持 streaming
 * - R2 交错多段块序重建（probe-P2 F5 形态：thinking>text>thinking>text 按 parts 下标保序）
 * - R3 重复思考定稿消除（GLM P3a 形态：实时多块 → 载荷单块）
 * - R4 id 锚定定位：锚点命中旧气泡（多气泡在场）
 * - R5 C2 顺序不变量 dev 断言：锚定命中 ≠ 末条 streaming → dev warn 不阻断
 * - R6 中断态复原：已收尾气泡（error 文案）按载荷覆写，status 复原 complete、error 退役
 * - R7 工具补建置 running + 关联不变量 + 与 tool_call_start 幂等衔接
 * - R8 join 复用：保实时 thinking 的折叠态与起止时刻，content 为载荷权威全文
 * - R9 载荷无 thinking → 重建清空（权威整条覆写）
 * - R10 无 streaming 气泡且无锚点 → no-op 不崩
 *
 * 运行：pnpm -C packages/core exec vitest run src/domain/chat/effects/__tests__/finalized-rebuild.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { dispatchMessageEvent } from '../registry'
import { makeCtx, msg } from '../../__tests__/helpers/fixtures'
import type { MessageEffectContext } from '../../effect-types'
import type { Message, PiMessageEntry, ServerMessage } from '@taiji/shared'
import { provideDevMode, __resetDevModeForTesting } from '../../../../platform/dev-mode'

const SID = 's-test'
const T_LOAD = 1_700_000_000_000

function listOf(ctx: MessageEffectContext): Message[] {
  return ctx.messages.value.get(SID)?.value ?? []
}

/** message_end(assistant) 帧（载荷 = probe-P2 实测的 pi entry 形态：content parts + usage + timestamp）。 */
function assistantEndFrame(
  parts: Array<Record<string, unknown>>,
  over: { messageId?: string; usage?: Record<string, unknown>; timestampMs?: number } = {},
): ServerMessage {
  const tsMs = over.timestampMs ?? T_LOAD
  const entry: PiMessageEntry = {
    type: 'message',
    parentId: null,
    timestamp: new Date(tsMs).toISOString(),
    message: {
      role: 'assistant',
      content: parts,
      timestamp: tsMs,
      ...(over.usage !== undefined ? { usage: over.usage } : {}),
    },
  } as PiMessageEntry
  return msg(SID, 'message.message_end', {
    entry,
    ...(over.messageId !== undefined ? { messageId: over.messageId } : {}),
  })
}

/** thinking part 载荷形态（probe-P2 键集合：thinking,type）。 */
const thinkPart = (text: string): Record<string, unknown> => ({ type: 'thinking', thinking: text })
/** text part 载荷形态（键集合：text,type）。 */
const textPart = (text: string): Record<string, unknown> => ({ type: 'text', text })
/** toolCall part 载荷形态（键集合：arguments,id,name,type）。 */
const toolPart = (id: string, name: string): Record<string, unknown> => ({ type: 'toolCall', id, name, arguments: {} })

afterEach(() => {
  __resetDevModeForTesting()
})

describe('message_end(assistant) 定稿权威重建（D3）', () => {
  it('R1: 基础重建——载荷全文/usage/endedAt 覆写 delta 累积，status 保持 streaming，textFinalized 打标', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'a-1' }))
    // delta 累积不完整（模拟丢 delta——权威载荷随后校正）
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.text_delta', { delta: 'hel' }))
    dispatchMessageEvent(ctx, SID, assistantEndFrame(
      [textPart('hello 完整正文')],
      { usage: { input: 400, output: 500, totalTokens: 900 } },
    ))
    const list = listOf(ctx)
    expect(list).toHaveLength(1)
    const m = list[0]
    expect(m.id).toBe('a-1')
    expect(m.content).toBe('hello 完整正文')
    expect(m.contentBlocks).toEqual([{ type: 'text', refId: 'text', contentIndex: 0 }])
    expect(m.usage).toEqual({ inputTokens: 400, outputTokens: 500 })
    expect(m.endedAt).toBe(T_LOAD)
    expect(m.textFinalized).toBe(true)
    // status 不动（规则 2）：sealed guard 与后续消息定位依赖 streaming 态
    expect(m.status).toBe('streaming')
  })

  it('R2: 交错多段块序按 parts 下标重建（probe-P2 F5 形态）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'a-1' }))
    dispatchMessageEvent(ctx, SID, assistantEndFrame([
      thinkPart('第一段思考'),
      textPart('第一段正文'),
      thinkPart('第二段思考'),
      textPart('第二段正文'),
    ]))
    const m = listOf(ctx)[0]
    expect(m.content).toBe('第一段正文第二段正文')
    // text 块单块哨兵是 collectContentParts 权威语义（多次 text part 累加合并、contentIndex
    // 取首个 text 下标）——与 reload 侧同构
    expect(m.contentBlocks).toEqual([
      { type: 'thinking', refId: 'a-1-th0', contentIndex: 0 },
      { type: 'text', refId: 'text', contentIndex: 1 },
      { type: 'thinking', refId: 'a-1-th2', contentIndex: 2 },
    ])
    // 关联不变量（规则 4）：contentBlocks 引用 id 与思考对象 id 一一对应
    expect(m.thinking).toEqual([
      { id: 'a-1-th0', content: '第一段思考', collapsed: true },
      { id: 'a-1-th2', content: '第二段思考', collapsed: true },
    ])
  })

  it('R3: 重复思考定稿消除（GLM P3a）——实时多块，载荷单 thinking part → 重建后单块', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'a-1' }))
    // 实时通道：首段正常产出 + GLM 重复/空条目轮（不同 thinkingId 的空块——幂等只拦同 id）
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_start', { thinkingId: 'th-real', contentIndex: 0 }))
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_delta', { delta: '真思考内容' }))
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_end'))
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_start', { thinkingId: 'th-echo-1', contentIndex: 0 }))
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_end'))
    expect(listOf(ctx)[0].thinking).toHaveLength(2)
    // 定稿：载荷只有一份思考条目 → 重建后单块（重复消除；join 复用保留实时起止时刻）
    dispatchMessageEvent(ctx, SID, assistantEndFrame([thinkPart('真思考内容'), textPart('正文')]))
    const m = listOf(ctx)[0]
    expect(m.thinking).toEqual([
      { id: 'a-1-th0', content: '真思考内容', collapsed: true, startTime: expect.any(Number), endTime: expect.any(Number) },
    ])
    expect(m.contentBlocks).toEqual([
      { type: 'thinking', refId: 'a-1-th0', contentIndex: 0 },
      { type: 'text', refId: 'text', contentIndex: 1 },
    ])
  })

  it('R4: id 锚定定位——多气泡在场时锚点命中目标气泡（末条非锚点）', () => {
    const ctx = makeCtx()
    // 旧气泡（mid-turn 已定稿、保持 streaming）+ 新气泡
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'm-1' }))
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'm-2' }))
    // 迟到的旧 message_end 帧带锚点（interpreter 附加 currentMessageId）
    dispatchMessageEvent(ctx, SID, assistantEndFrame([textPart('旧消息全文')], { messageId: 'm-1' }))
    const list = listOf(ctx)
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ id: 'm-1', content: '旧消息全文', textFinalized: true })
    // 未定稿气泡不携带标记（键不存在）
    expect(list[1].id).toBe('m-2')
    expect(list[1]).not.toHaveProperty('textFinalized')
  })

  it('R5: C2 顺序不变量 dev 断言——锚定命中 ≠ 末条 streaming 时 dev warn 不阻断', () => {
    provideDevMode(true)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'm-1' }))
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'm-2' }))
    dispatchMessageEvent(ctx, SID, assistantEndFrame([textPart('旧消息全文')], { messageId: 'm-1' }))
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('anchor/position mismatch')
    // 不阻断：重建照常落锚点气泡
    expect(listOf(ctx)[0]).toMatchObject({ id: 'm-1', content: '旧消息全文' })
    warnSpy.mockRestore()
  })

  it('R6: 中断态复原——已收尾气泡（error 文案在场）按载荷覆写，status 复原 complete、error 退役、isInterrupted 保留', () => {
    // C2 断言只针对「末条 streaming 在场时锚定 ≠ 它」的真错挂：本场景（断连收尾后无
    // streaming 气泡的合法迟到定稿覆写，D3 规则 1）不触发 anchor/position mismatch warn。
    provideDevMode(true)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = makeCtx([
      {
        id: 'm-1', role: 'assistant', content: '', status: 'error', timestamp: 1000,
        error: '与运行时的连接已断开，回复已中断。重新连接后可继续。', isInterrupted: true,
      },
    ])
    // 断连收尾后的权威载荷到达（带锚点）：不做 sealed 丢弃（规则 1）
    dispatchMessageEvent(ctx, SID, assistantEndFrame([textPart('完整正文')], { messageId: 'm-1' }))
    const m = listOf(ctx)[0]
    expect(m.status).toBe('complete')
    expect(m.error).toBeUndefined()
    expect(m.content).toBe('完整正文')
    expect(m.isInterrupted).toBe(true)
    expect(m.textFinalized).toBe(true)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('R7: 工具补建置 running + 关联不变量 + tool_call_start 幂等衔接（规则 3）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'a-1' }))
    // pi 事件序：工具执行严格晚于所属 message_end——重建时刻 tool_call_start 帧未到
    dispatchMessageEvent(ctx, SID, assistantEndFrame(
      [toolPart('tc-1', 'bash')],
      { usage: { input: 10, output: 20 } },
    ))
    let m = listOf(ctx)[0]
    // 补建置 running（非 reload 侧终态 completed）
    expect(m.toolCalls).toEqual([{ id: 'tc-1', toolName: 'bash', input: {}, status: 'running', startTime: expect.any(Number) }])
    expect(m.contentBlocks).toEqual([{ type: 'toolCall', refId: 'tc-1', contentIndex: 0 }])
    // 随后 tool_call_start 到达：同 id 幂等不重插、不倒退 running
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.tool_call_start', {
      entry: { type: 'toolCall', toolCallId: 'tc-1', toolName: 'bash', arguments: { cmd: 'ls' }, messageId: 'a-1' },
    }))
    m = listOf(ctx)[0]
    expect(m.toolCalls).toHaveLength(1)
    expect(m.toolCalls![0]).toMatchObject({ id: 'tc-1', status: 'running', input: { cmd: 'ls' } })
    expect(m.contentBlocks ?? []).toHaveLength(1)
  })

  it('R8: join 复用保实时 live 状态（thinking 起止时刻），content 为载荷权威全文', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'a-1' }))
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_start', { thinkingId: 'th-live', contentIndex: 0 }))
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_delta', { delta: '实时累积（可能不完整）' }))
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_end'))
    const liveStart = listOf(ctx)[0].thinking![0].startTime
    dispatchMessageEvent(ctx, SID, assistantEndFrame([thinkPart('载荷权威全文'), textPart('正文')]))
    const m = listOf(ctx)[0]
    // 序位兜底 join：id 重写为载荷派生 id、content 换载荷全文；collapsed/startTime/endTime 保留实时值
    expect(m.thinking).toEqual([
      { id: 'a-1-th0', content: '载荷权威全文', collapsed: true, startTime: liveStart, endTime: expect.any(Number) },
    ])
    expect(m.contentBlocks?.[0]).toEqual({ type: 'thinking', refId: 'a-1-th0', contentIndex: 0 })
  })

  it('R9: 载荷无 thinking/toolCall → 重建清空 delta 阶段残留（权威整条覆写）', () => {
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'a-1' }))
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.thinking_start', { thinkingId: 'th-x' }))
    dispatchMessageEvent(ctx, SID, assistantEndFrame([textPart('纯正文')]))
    const m = listOf(ctx)[0]
    expect(m.thinking).toBeUndefined()
    expect(m.toolCalls).toBeUndefined()
    expect(m.contentBlocks).toEqual([{ type: 'text', refId: 'text', contentIndex: 0 }])
  })

  it('R10: 无 streaming 气泡且无锚点 → no-op 不崩（空态行为与升级前一致）', () => {
    const settled = makeCtx([{ id: 'm-1', role: 'assistant', content: 'done', status: 'complete', timestamp: 1000 }])
    expect(() => dispatchMessageEvent(settled, SID, assistantEndFrame([textPart('x')]))).not.toThrow()
    expect(listOf(settled)[0].content).toBe('done')
    expect(listOf(settled)[0]).not.toHaveProperty('textFinalized')

    const empty = makeCtx([])
    expect(() => dispatchMessageEvent(empty, SID, assistantEndFrame([textPart('x')]))).not.toThrow()
    expect(listOf(empty)).toHaveLength(0)
  })

  it('R11: D3 补建留痕 dev warn——载荷条目无实时对象时 warn 一次', () => {
    provideDevMode(true)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = makeCtx()
    dispatchMessageEvent(ctx, SID, msg(SID, 'message.message_start', { messageId: 'a-1' }))
    dispatchMessageEvent(ctx, SID, assistantEndFrame([toolPart('tc-9', 'read')]))
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('backfilled')
    warnSpy.mockRestore()
  })
})
