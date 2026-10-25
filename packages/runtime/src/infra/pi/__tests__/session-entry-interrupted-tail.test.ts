/**
 * isInterruptedTail 尾部形态判定单测（U8 重启中断标记·方向 A，design-session-lifecycle
 * 缺陷 4，用户已裁决）。
 *
 * 证据链（pi 落盘时序）：pi 只在 message_end 时把整条消息同步落盘，流式输出期间零落盘。
 * 正常完成回合尾部必为无 toolCall 的 assistant；中断三形态可判定（user 尾 / 带 toolCall
 * assistant 尾 / toolResult 尾）；零损失窗口不标；非回合 entry（custom/client-msg-id 映射、
 * label、usage、compaction）从尾向前跳过找最后 message entry。
 *
 * 联合判定的「会话未附着」半边由调用方限定（doGetHistory 离线分支），本文件只锁形态判定。
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/session-entry-interrupted-tail.test.ts
 */
import { describe, it, expect } from 'vitest'
import { isInterruptedTail } from '../session-entry-mapper.js'
import type { PiSessionEntry } from '../pi-session-data.js'

/** 最小 message entry 构造（判定只读 type/message.role/content[].type） */
function msgEntry(role: 'user' | 'assistant' | 'toolResult' | 'system', content: Array<Record<string, unknown>> = []): PiSessionEntry {
  return {
    type: 'message',
    id: `e-${Math.random().toString(36).slice(2, 8)}`,
    parentId: null,
    timestamp: '2026-10-24T00:00:00.000Z',
    message: { role, content, timestamp: 0 },
  } as unknown as PiSessionEntry
}

/** 非回合 entry（custom entry，taiji.client-msg-id 映射形态） */
function customEntry(): PiSessionEntry {
  return {
    type: 'custom',
    id: `c-${Math.random().toString(36).slice(2, 8)}`,
    parentId: null,
    timestamp: '2026-10-24T00:00:00.000Z',
    customType: 'taiji.client-msg-id',
    data: { clientUuid: 'u1', userEntryId: 'e1' },
  } as unknown as PiSessionEntry
}

const assistantText = () => msgEntry('assistant', [{ type: 'text', text: '终稿回复' }])
const assistantToolCall = () => msgEntry('assistant', [
  { type: 'toolCall', id: 'tc1', name: 'read_file', arguments: {} },
])
const toolResult = () => msgEntry('toolResult', [{ type: 'text', text: '工具输出' }])

describe('isInterruptedTail 中断三形态（true）', () => {
  it('形态 1：尾部 = user entry（assistant 未产出，内容损失最大）', () => {
    expect(isInterruptedTail([msgEntry('user', [{ type: 'text', text: 'hi' }])])).toBe(true)
  })

  it('形态 2：尾部 = 带 toolCall 的 assistant entry（工具结果丢失）', () => {
    expect(isInterruptedTail([assistantToolCall()])).toBe(true)
  })

  it('形态 3：尾部 = toolResult entry（下一轮 assistant 丢失）', () => {
    expect(isInterruptedTail([assistantToolCall(), toolResult()])).toBe(true)
  })
})

describe('isInterruptedTail 正常/零损失形态（false）', () => {
  it('正常完成：尾部 = 无 toolCall 的 assistant entry', () => {
    expect(isInterruptedTail([
      msgEntry('user', [{ type: 'text', text: 'hi' }]),
      assistantText(),
    ])).toBe(false)
  })

  it('主动 abort：落盘 stopReason=aborted 的完整 assistant entry，同形态不触发', () => {
    const aborted = msgEntry('assistant', [{ type: 'text', text: '半截回复' }])
    ;(aborted as { message: { stopReason?: string } }).message.stopReason = 'aborted'
    expect(isInterruptedTail([msgEntry('user'), aborted])).toBe(false)
  })

  it('空数组 / 仅 header 无 message entry：无回合不标', () => {
    expect(isInterruptedTail([])).toBe(false)
    expect(isInterruptedTail([customEntry()])).toBe(false)
  })

  it('system 尾部（pi 1.0.0 系统消息）：非回合产出尾部，不标', () => {
    expect(isInterruptedTail([msgEntry('system', [{ type: 'text', text: 'system prompt' }])])).toBe(false)
  })
})

describe('isInterruptedTail 非回合尾部 entry 跳过（从尾向前找最后 message entry）', () => {
  it('client-msg-id custom entry 盖在 user 尾上（每次发消息的常态序列）：仍判中断', () => {
    // 高频路径：pi 发消息落 user entry 后，msg-id-mapper extension 紧跟写 custom entry
    expect(isInterruptedTail([
      assistantText(),
      msgEntry('user', [{ type: 'text', text: '新消息' }]),
      customEntry(),
    ])).toBe(true)
  })

  it('custom entry 盖在完整 assistant 尾上：不误标', () => {
    expect(isInterruptedTail([
      msgEntry('user'),
      assistantText(),
      customEntry(),
    ])).toBe(false)
  })
})
