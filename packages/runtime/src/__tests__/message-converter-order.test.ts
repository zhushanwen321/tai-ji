/**
 * message-converter contentBlocks 顺序测试（§11 检查点 3：两条填充路径顺序语义统一）。
 *
 * 持久化路径按 pi content array 顺序（= contentIndex 顺序）构建 contentBlocks：
 * - thinking/toolCall/text part 按 parts 下标 i 依次 push，text 单守卫（首次遇到才 push）
 * - contentIndex 字段 = parts 下标，与 streaming 路径（core effects registry 按 contentIndex
 *   有序插入）对称——同一消息内容下两条路径必须产生一致顺序的 contentBlocks。
 *
 * 对应测试：packages/core/src/domain/chat/__tests__/effects.test.ts 的「顺序统一」用例组
 * （streaming 事件序列侧）。本文件断言持久化侧对相同内容产生相同期望序列。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/message-converter-order.test.ts
 */
import { describe, it, expect } from 'vitest'
import { convertSinglePiMessage } from '../infra/pi/message-converter.js'
import type { PiHistoryContentPart } from '../infra/pi/pi-protocol.js'

function toMessage(parts: PiHistoryContentPart[]): { role: 'assistant'; content: PiHistoryContentPart[]; timestamp: number } {
  return { role: 'assistant', content: parts, timestamp: 123 }
}

describe('convertSinglePiMessage —— contentBlocks 顺序（§11 检查点 3 持久化路径）', () => {
  it('text 在 tool 之后：[thinking, toolCall, text] → 与 streaming 路径一致', () => {
    const m = toMessage([
      { type: 'thinking', thinking: 'reasoning' },
      { type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: '/x' } },
      { type: 'text', text: 'answer' },
    ])
    const msg = convertSinglePiMessage(m)
    expect(msg!.contentBlocks).toEqual([
      { type: 'thinking', refId: msg!.thinking![0].id, contentIndex: 0 },
      { type: 'toolCall', refId: 'tc1', contentIndex: 1 },
      { type: 'text', refId: 'text', contentIndex: 2 },
    ])
  })

  it('text 在 tool 之前：[text, toolCall] → 与 streaming 路径一致', () => {
    const m = toMessage([
      { type: 'text', text: 'let me check' },
      { type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: '/x' } },
    ])
    const msg = convertSinglePiMessage(m)
    expect(msg!.contentBlocks).toEqual([
      { type: 'text', refId: 'text', contentIndex: 0 },
      { type: 'toolCall', refId: 'tc1', contentIndex: 1 },
    ])
  })

  it('多 text part 不绕过单 text 守卫（text 块只 push 一次，content 合并）', () => {
    const m = toMessage([
      { type: 'text', text: 'part1 ' },
      { type: 'toolCall', id: 'tc1', name: 'read', arguments: {} },
      { type: 'text', text: 'part2' },
    ])
    const msg = convertSinglePiMessage(m)
    expect(msg!.content).toBe('part1 part2')
    expect(msg!.contentBlocks).toEqual([
      { type: 'text', refId: 'text', contentIndex: 0 },
      { type: 'toolCall', refId: 'tc1', contentIndex: 1 },
    ])
  })

  it('多 tool 交错：[thinking, tool, text, tool] → 与 streaming 路径一致', () => {
    const m = toMessage([
      { type: 'thinking', thinking: 'r' },
      { type: 'toolCall', id: 'tc1', name: 'read', arguments: {} },
      { type: 'text', text: 'mid' },
      { type: 'toolCall', id: 'tc2', name: 'grep', arguments: {} },
    ])
    const msg = convertSinglePiMessage(m)
    expect(msg!.contentBlocks).toEqual([
      { type: 'thinking', refId: msg!.thinking![0].id, contentIndex: 0 },
      { type: 'toolCall', refId: 'tc1', contentIndex: 1 },
      { type: 'text', refId: 'text', contentIndex: 2 },
      { type: 'toolCall', refId: 'tc2', contentIndex: 3 },
    ])
  })
})
