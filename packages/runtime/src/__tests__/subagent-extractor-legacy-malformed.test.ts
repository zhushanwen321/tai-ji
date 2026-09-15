/**
 * subagent-extractor legacy 路径畸形输入测试（R2-TC S4）。
 *
 * 锁定 legacy 兜底解析（extractSubagentsFromEntriesLegacy）对不可信输入的逐层 shape 守卫：
 * 1. toolCall block action!=='start'（如 list）→ projectSubagentStartArgs 返回 null，块跳过
 * 2. toolResult content[0].text 非 JSON（如错误消息纯文本）→ parse 失败 null，条目跳过
 * 3. assistant content / 顶层 entries 含非 object 元素 → parseLegacyToolCallBlock null，不抛错
 *
 * 三例均不抛异常、坏输入静默跳过、同批好输入正常产出（坏块不污染好块）。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/subagent-extractor-legacy-malformed.test.ts
 */
import { describe, it, expect } from 'vitest'
import { scanSubagentEntries } from '../services/session/subagent-extractor'

/** assistant message entry（content blocks 自由拼装） */
function assistantEntry(content: unknown[]): Record<string, unknown> {
  return { type: 'message', message: { role: 'assistant', content } }
}

/** subagent toolResult message entry（text 为 JSON 字符串） */
function toolResultEntry(toolCallId: string, text: string): Record<string, unknown> {
  return {
    type: 'message',
    message: { role: 'toolResult', toolName: 'subagent', toolCallId, content: [{ type: 'text', text }] },
  }
}

/** 合法 start toolCall block */
function startBlock(id: string, startParam: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'toolCall', name: 'subagent', id, arguments: { action: 'start', startParam } }
}

/** 合法 background start toolResult 文本 */
const BG_START_RESULT = JSON.stringify({
  action: 'start',
  subagentId: 'bg-ok-1',
  sessionFile: null,
  bgResponse: { status: 'running', message: 'detached' },
})

describe('scanSubagentEntries · legacy 路径畸形输入（R2-TC S4）', () => {
  it('toolCall block action!==start（list）→ 跳过该块，不产出 record；同批合法 start 块正常配对', () => {
    const records = scanSubagentEntries([
      assistantEntry([
        // action: 'list' 的 subagent toolCall——非 start，须被 projectSubagentStartArgs 丢弃。
        // 故意带合法 startParam + bgResponse toolResult：若 action 守卫缺失，该块会通过
        // startParam 形状检查（重叠防护穿透）凭空产出 ghost record——此构造使 action 守卫独立可观测。
        {
          type: 'toolCall',
          name: 'subagent',
          id: 'tc-list',
          arguments: { action: 'list', startParam: { agent: 'worker', task: 'List tasks', slug: 'ls' } },
        },
        startBlock('tc-ok', { agent: 'worker', task: 'Do work', slug: 'work' }),
      ]),
      // tc-list 的 toolResult 带 bgResponse（若 toolCall 未被丢弃即可配对成 record）
      toolResultEntry('tc-list', JSON.stringify({ action: 'list', subagentId: 'bg-ghost', sessionFile: null, bgResponse: { status: 'running', message: 'detached' } })),
      toolResultEntry('tc-ok', BG_START_RESULT),
    ])

    // 只产出合法 start 配对的 1 条；list 块被跳过（无 bg-ghost）
    expect(records).toHaveLength(1)
    expect(records[0].subagentId).toBe('bg-ok-1')
    expect(records[0].task).toBe('Do work')
    expect(records.some((r) => r.subagentId === 'bg-ghost')).toBe(false)
  })

  it('toolResult text 非 JSON（错误消息纯文本）/ 空 content / 无 text block → 条目跳过，不抛错', () => {
    const records = scanSubagentEntries([
      assistantEntry([startBlock('tc-1', { task: 'T1' })]),
      // 非 JSON：pi 工具错误消息（如 "startParam is required"），JSON.parse 抛 → null
      toolResultEntry('tc-1', 'startParam is required'),
      // 空 content 数组 → null
      { type: 'message', message: { role: 'toolResult', toolName: 'subagent', toolCallId: 'tc-1', content: [] } },
      // 首块非 text → null
      {
        type: 'message',
        message: { role: 'toolResult', toolName: 'subagent', toolCallId: 'tc-1', content: [{ type: 'image', url: 'x' }] },
      },
    ])

    expect(records).toEqual([])
  })

  it('toolResult text 合法 JSON 但非 object（string/array）→ 整条丢弃；不产出 record', () => {
    // JSON.parse 成功 ≠ 形状正确：'"just a string"' / '[1,2]' 都是合法 JSON
    const records = scanSubagentEntries([
      assistantEntry([startBlock('tc-s', { task: 'S' })]),
      toolResultEntry('tc-s', '"just a string"'),
      assistantEntry([startBlock('tc-a', { task: 'A' })]),
      toolResultEntry('tc-a', '[1,2,3]'),
    ])

    expect(records).toEqual([])
  })

  it('assistant content / 顶层 entries 含非 object 元素（string/number/null/数组 arguments）→ 不抛错，全跳过', () => {
    const records = scanSubagentEntries([
      // 顶层非 object entry
      42,
      'not-an-entry',
      null,
      // content 混入非 object block + arguments 非 plain object（string/数组）
      assistantEntry([
        'plain string block',
        42,
        null,
        { type: 'toolCall', name: 'subagent', id: 'tc-args-str', arguments: 'not-an-object' },
        { type: 'toolCall', name: 'subagent', id: 'tc-args-arr', arguments: ['action', 'start'] },
        { type: 'text', text: 'assistant 说的话' },
      ]),
    ])

    expect(records).toEqual([])
  })
})
