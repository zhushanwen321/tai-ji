/**
 * 嵌套工具调用产块事件过滤测试（codemode u5 / 设计 D4，live ≡ reload 对齐）。
 *
 * 判据来源（pi 1.0.0 dist 实证；非 codemode 专属逻辑——本注释防止未来被误判为
 * codemode 专属而错误放行）：工具经 ctx.executeTool() 发起的嵌套调用，其
 * tool_execution_start / tool_execution_update / tool_execution_end 事件一律携带
 * parentToolCallId（pi dist/core/nested-tool-calls.js 三处 emit 点，嵌套 id 形态
 * `${parentToolCallId}/${n}`），且嵌套调用不落独立 transcript 条目
 * （pi dist/core/extensions/types.d.ts executeTool 契约「It does not appear in the
 * transcript」——仅外层 result message 的 nestedCalls 保留有界记录）。
 * 过滤语义 = 与 transcript 投影对齐：reload 后嵌套调用只有外层一个
 * 工具块，live 期放行 start/end 会各产独立工具块 → 「live ≡ reload」破缺
 * （AGENTS.md 关键规则 9 / codemode 设计 §3.3 D4）。
 *
 * 本层（runtime event-adapter）表驱动覆盖：
 *   - 嵌套 start / 嵌套 end → 过滤（零产出）；
 *   - 嵌套 update → 豁免（照常映射 message.tool_call_update——它是 subagent 翻译层
 *     活性信号载体，U-A6 无进展守护刷新通道，丢弃会复发守护误杀）；
 *   - 非嵌套 start / end / update → 零影响；
 *   - parentToolCallId 空串按非嵌套放行（'' 属畸形值：误滤顶层块是数据损失，
 *     误放行至多多一个重复块，两害取轻）。
 *
 * translate 是纯函数（event-adapter.ts 头注释），直接调用断言产出。
 * 运行：cd packages/runtime && pnpm test event-adapter-nested
 */
import { describe, expect, it } from 'vitest'
import { translate } from '../event-adapter.js'
import type { PiEvent } from '../pi-protocol.js'

const NESTED_PARENT_ID = 'call_outer_1'

/** 构造 tool_execution_start 事件（parentToolCallId 缺省 = 顶层调用）。 */
function startEvent(parentToolCallId?: string): PiEvent {
  return {
    type: 'tool_execution_start',
    toolCallId: parentToolCallId !== undefined ? `${NESTED_PARENT_ID}/1` : 'call_top',
    toolName: 'bash',
    args: { script: 'await tools.read({ path: "a" })' },
    ...(parentToolCallId !== undefined && { parentToolCallId }),
  }
}

/** 构造 tool_execution_end 事件（result 形态对齐 pi AgentToolResult）。 */
function endEvent(parentToolCallId?: string): PiEvent {
  return {
    type: 'tool_execution_end',
    toolCallId: parentToolCallId !== undefined ? `${NESTED_PARENT_ID}/1` : 'call_top',
    toolName: 'bash',
    result: { content: [{ type: 'text', text: 'ok' }], details: null },
    isError: false,
    ...(parentToolCallId !== undefined && { parentToolCallId }),
  }
}

/** 构造 tool_execution_update 事件（嵌套 id 形态对齐 pi nested-tool-calls.js）。 */
function updateEvent(toolCallId: string, parentToolCallId?: string): PiEvent {
  return {
    type: 'tool_execution_update',
    toolCallId,
    toolName: 'bash',
    partialResult: { content: [{ type: 'text', text: 'partial' }], details: null },
    ...(parentToolCallId !== undefined && { parentToolCallId }),
  }
}

/** 行期望：filtered = 零产出；其余 = 产出的判别形态。 */
type RowExpectation =
  | { out: 'filtered' }
  | { out: 'tool-call-start'; toolCallId: string }
  | { out: 'tool-call-end'; toolCallId: string }
  | { out: 'tool-call-update'; toolCallId: string }

const ROWS: Array<{ name: string; event: PiEvent; expected: RowExpectation }> = [
  {
    name: '嵌套 start（parentToolCallId 在场）→ 过滤，零产出',
    event: startEvent(NESTED_PARENT_ID),
    expected: { out: 'filtered' },
  },
  {
    name: '嵌套 end → 过滤，零产出',
    event: endEvent(NESTED_PARENT_ID),
    expected: { out: 'filtered' },
  },
  {
    name: '嵌套 update → 豁免（不产块事件，照常映射 message.tool_call_update）',
    event: updateEvent(`${NESTED_PARENT_ID}/1`, NESTED_PARENT_ID),
    expected: { out: 'tool-call-update', toolCallId: `${NESTED_PARENT_ID}/1` },
  },
  {
    name: '非嵌套 start → 零影响（tool-call-start 照常产出）',
    event: startEvent(),
    expected: { out: 'tool-call-start', toolCallId: 'call_top' },
  },
  {
    name: '非嵌套 end → 零影响（tool-call-end 照常产出）',
    event: endEvent(),
    expected: { out: 'tool-call-end', toolCallId: 'call_top' },
  },
  {
    name: '非嵌套 update → 零影响（message.tool_call_update 照常产出）',
    event: updateEvent('call_top'),
    expected: { out: 'tool-call-update', toolCallId: 'call_top' },
  },
  {
    name: '边界：parentToolCallId 空串按非嵌套放行（畸形值宁放行不误丢顶层块）',
    event: startEvent(''),
    expected: { out: 'tool-call-start', toolCallId: `${NESTED_PARENT_ID}/1` },
  },
]

describe('嵌套工具调用产块事件过滤（codemode u5 / D4，表驱动）', () => {
  for (const row of ROWS) {
    it(row.name, () => {
      const events = translate(row.event, 's1')
      if (row.expected.out === 'filtered') {
        expect(events).toEqual([])
        return
      }
      expect(events).toHaveLength(1)
      const ev = events[0]
      switch (row.expected.out) {
        case 'tool-call-start':
          expect(ev?.kind).toBe('tool-call-start')
          expect(ev?.kind === 'tool-call-start' && ev.toolCallId).toBe(row.expected.toolCallId)
          break
        case 'tool-call-end':
          expect(ev?.kind).toBe('tool-call-end')
          expect(ev?.kind === 'tool-call-end' && ev.toolCallId).toBe(row.expected.toolCallId)
          break
        case 'tool-call-update':
          expect(ev?.kind).toBe('message')
          if (ev?.kind === 'message') {
            expect(ev.message.type).toBe('message.tool_call_update')
            expect((ev.message.payload as Record<string, unknown>).toolCallId).toBe(row.expected.toolCallId)
          }
          break
      }
    })
  }

  it('混合序列：外层产块与嵌套过滤逐事件独立——外层两块照常、嵌套零产出', () => {
    const events = [
      ...translate(startEvent(), 's1'),
      ...translate(startEvent(NESTED_PARENT_ID), 's1'),
      ...translate(endEvent(NESTED_PARENT_ID), 's1'),
      ...translate(endEvent(), 's1'),
    ]
    expect(events.map((e) => e.kind)).toEqual(['tool-call-start', 'tool-call-end'])
  })
})
