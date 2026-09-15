/**
 * domain/chat chunk-processor 迁移单测（语义等价锁定，w2 原样迁移）。
 *
 * 锁定纯查找辅助函数语义：
 * - findLastAssistantIndex：从后往前找最后一条 assistant，无则 -1
 * - findToolCallOwner：按 toolCallId 锚定（不靠位置），从后往前扫命中最新含该 id 的 assistant
 */
import { describe, it, expect } from 'vitest'
import type { Message } from '@taiji/shared'
import { findLastAssistantIndex, findToolCallOwner } from '../chunk-processor'

function msg(role: Message['role'], extra: Partial<Message> = {}): Message {
  return { id: `id-${Math.random().toString(36).slice(2)}`, role, content: '', ...extra } as Message
}

describe('findLastAssistantIndex', () => {
  it('空列表返回 -1', () => {
    expect(findLastAssistantIndex([])).toBe(-1)
  })

  it('无 assistant 返回 -1', () => {
    const list = [msg('user'), msg('system'), msg('user')]
    expect(findLastAssistantIndex(list)).toBe(-1)
  })

  it('多 assistant 取最后一条下标', () => {
    const list = [msg('assistant'), msg('user'), msg('assistant'), msg('assistant')]
    expect(findLastAssistantIndex(list)).toBe(3)
  })

  it('只有一条 assistant 返回其下标', () => {
    const list = [msg('user'), msg('assistant'), msg('user')]
    expect(findLastAssistantIndex(list)).toBe(1)
  })
})

describe('findToolCallOwner', () => {
  it('ID 锚定：命中含该 toolCallId 的 assistant', () => {
    const list: Message[] = [
      msg('assistant', { toolCalls: [{ id: 'tc-1', toolName: 'fn', input: {}, status: 'completed' as const, startTime: 0 }] }),
      msg('user'),
      msg('assistant', { toolCalls: [{ id: 'tc-2', toolName: 'fn', input: {}, status: 'completed' as const, startTime: 0 }] }),
    ]
    expect(findToolCallOwner(list, 'tc-1')).toBe(0)
    expect(findToolCallOwner(list, 'tc-2')).toBe(2)
  })

  it('ID 不存在返回 -1', () => {
    const list: Message[] = [
      msg('assistant', { toolCalls: [{ id: 'tc-1', toolName: 'fn', input: {}, status: 'completed' as const, startTime: 0 }] }),
    ]
    expect(findToolCallOwner(list, 'nope')).toBe(-1)
  })

  it('无 toolCalls 的 assistant 不命中', () => {
    const list: Message[] = [msg('assistant')]
    expect(findToolCallOwner(list, 'tc-1')).toBe(-1)
  })

  it('多 assistant 含同一 ID 时从后往前命中最新（乱序无害化）', () => {
    // 模拟事件乱序：理论上同一 toolCallId 不应跨 message，但 findToolCallOwner 从后扫
    // 保证即便数据异常也命中最新（最新的 turn 覆盖旧定义）
    const shared = { id: 'tc-x', toolName: 'fn', input: {}, status: 'completed' as const, startTime: 0 }
    const list: Message[] = [
      msg('assistant', { toolCalls: [shared] }),
      msg('assistant', { toolCalls: [shared] }),
    ]
    expect(findToolCallOwner(list, 'tc-x')).toBe(1) // 最新（最后）的那条
  })

  it('toolCalls 为 undefined 的 assistant 被跳过（可选链安全）', () => {
    const list: Message[] = [
      msg('assistant'), // 无 toolCalls
      msg('assistant', { toolCalls: [{ id: 'tc-1', toolName: 'fn', input: {}, status: 'completed' as const, startTime: 0 }] }),
    ]
    expect(findToolCallOwner(list, 'tc-1')).toBe(1)
  })
})
