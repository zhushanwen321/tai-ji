/**
 * entryStates 条目级截断测试（crash-resilience §3.3 D6-⑧ / u7-memory-governance）。
 *
 * 覆盖：
 * - truncateEntryToolOutput：64KB 阈值三态（不截 / 截断+标记 / UTF-8 codepoint 边界）
 * - computeToolCallFill：output/outputRaw 双字段截断 + outputTruncated 标记
 * - live ≡ reload 截断层统一（D3 代价 C 根治）：
 *   · reducer 双入口（applyEntry 累积 = live / replayEntries = reload）同一截断函数，
 *     非六类工具（MCP）大结果两路径产物 deep-equal 且都呈截断形态
 *   · live overlay（registry tool_call_end handler）与 reducer 同函数：对同一大 output
 *     的投影逐字节一致
 * - 六类工具 4KB 投影与 64KB 累积截断的层级关系：5KB output 累积态原样保留（投影截断
 *   是 truncate-tool-output.ts 的上层职责，reducer 不越权截到 4KB）
 */
import { describe, it, expect } from 'vitest'
import type { Message } from '@taiji/shared'
import type { PiMessageEntry, ServerMessage } from '@taiji/shared'
import { applyEntry, replayEntries, createInitialChatViewState, normalizePiToolResult } from '../apply-entry'
import { computeToolCallFill } from '../apply-entry-convert'
import { ENTRY_TOOL_OUTPUT_MAX_BYTES, truncateEntryToolOutput } from '../apply-entry-utils'
import { dispatchMessageEvent } from '../effects/registry'
import { makeCtx as sharedMakeCtx, msg as serverMsg } from './helpers/fixtures'
import type { MessageEffectContext } from '../effect-types'

const MARKER = '\n\n[...output truncated...]'

/** 生成指定 UTF-8 字节长的测试串（'a' 单字节，精确控长）。 */
function asciiOfBytes(n: number): string {
  return 'a'.repeat(n)
}

/** CJK 串（每字 3 UTF-8 字节），边界对齐断言用。 */
function cjkOfChars(n: number): string {
  return '中'.repeat(n)
}

function toolResultEntry(toolCallId: string, text: string, toolName = 'mcp__srv__query'): PiMessageEntry {
  return {
    type: 'message',
    id: `entry-${toolCallId}`,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    message: {
      role: 'toolResult',
      toolCallId,
      toolName,
      content: [{ type: 'text', text }],
      isError: false,
      timestamp: 0,
    },
  } as unknown as PiMessageEntry
}

describe('truncateEntryToolOutput（D6-⑧ 64KB 累积截断）', () => {
  it('≤64KB 原样返回（零拷贝语义：text 同引用、truncated=false）', () => {
    const text = asciiOfBytes(ENTRY_TOOL_OUTPUT_MAX_BYTES)
    const r = truncateEntryToolOutput(text)
    expect(r.truncated).toBe(false)
    expect(r.text).toBe(text)
  })

  it('>64KB 截断 + 尾部标记，含标记总字节 ≤ 64KB', () => {
    const text = asciiOfBytes(ENTRY_TOOL_OUTPUT_MAX_BYTES + 1)
    const r = truncateEntryToolOutput(text)
    expect(r.truncated).toBe(true)
    expect(r.text.endsWith(MARKER)).toBe(true)
    expect(Buffer.byteLength(r.text, 'utf8')).toBeLessThanOrEqual(ENTRY_TOOL_OUTPUT_MAX_BYTES)
    // 头部内容保留（截断体 = 原文头部 + 标记）
    expect(r.text.startsWith('a')).toBe(true)
  })

  it('UTF-8 codepoint 边界对齐：CJK 尾部不被切成半个字符（不产生乱码）', () => {
    // 65536 不是 3 的倍数 → naive 按字节切会切开 CJK；对齐后必须以完整字符结尾
    const text = cjkOfChars(30000) // 90000 字节 > 64KB
    const r = truncateEntryToolOutput(text)
    expect(r.truncated).toBe(true)
    const body = r.text.slice(0, r.text.length - MARKER.length)
    // 解码不抛错 + 尾字符完整（正则匹配合法 CJK 尾）
    expect(body.endsWith('中')).toBe(true)
  })
})

describe('computeToolCallFill 截断标记', () => {
  it('大 output 截断 + outputTruncated=true；带 ANSI 的 outputRaw 同步截断', () => {
    const raw = asciiOfBytes(ENTRY_TOOL_OUTPUT_MAX_BYTES + 100)
    // 带 ANSI：normalizePiToolResult 在 stripAnsi 改变文本时才产 outputRaw（含 ANSI 原文）
    const ansiText = `\x1b[31m${raw}\x1b[0m`
    // pi 持久化 content 数组形态（normalizePiToolResult 的 content-array 分支）
    const fill = computeToolCallFill({ role: 'toolResult', toolCallId: 'tc1', content: [{ type: 'text', text: ansiText }], isError: false })
    expect(fill.outputTruncated).toBe(true)
    expect(fill.output.endsWith(MARKER)).toBe(true)
    expect(fill.outputRaw).toBeDefined()
    expect(fill.outputRaw!.endsWith(MARKER)).toBe(true)
    expect(fill.outputRaw).toContain('\x1b[31m')
  })

  it('小 output 不截断不标记', () => {
    const fill = computeToolCallFill({ role: 'toolResult', toolCallId: 'tc1', content: [{ type: 'text', text: 'small' }], isError: false })
    expect(fill.outputTruncated).toBe(false)
    expect(fill.output).toBe('small')
  })
})

describe('live ≡ reload 截断层统一（D3 代价 C 根治）', () => {
  /** 带 64KB+ MCP 大结果的 entry 序列（assistant toolCall + toolResult 回填）。 */
  function makeEntries() {
    const bigOutput = asciiOfBytes(ENTRY_TOOL_OUTPUT_MAX_BYTES + 7)
    const assistantEntry: PiMessageEntry = {
      type: 'message',
      id: 'entry-asst',
      parentId: null,
      timestamp: new Date(0).toISOString(),
      message: {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'tc-mcp-1',
          name: 'mcp__srv__query',
          arguments: { q: 'x' },
        }],
        timestamp: 0,
      },
    } as unknown as PiMessageEntry
    return { assistantEntry, resultEntry: toolResultEntry('tc-mcp-1', bigOutput), bigOutput }
  }

  it('reload（replayEntries）与 live（applyEntry 逐帧累积）产物 deep-equal，均为截断形态', () => {
    const { assistantEntry, resultEntry } = makeEntries()
    const reload = replayEntries([assistantEntry, resultEntry])
    // live = applyEntry 逐帧累积（store.applyEntryFrame 的纯函数内核）
    let live = createInitialChatViewState()
    live = applyEntry(live, assistantEntry)
    live = applyEntry(live, resultEntry)
    expect(live.messages).toEqual(reload.messages)

    const tc = reload.messages[0]!.toolCalls![0]!
    expect(tc.outputTruncated).toBe(true)
    expect(tc.output!.endsWith(MARKER)).toBe(true)
    expect(Buffer.byteLength(tc.output!, 'utf8')).toBeLessThanOrEqual(ENTRY_TOOL_OUTPUT_MAX_BYTES)
  })

  it('幂等去重（deliveredToolResultIds）与截断正交：双帧喂入仍单份截断产物', () => {
    const { assistantEntry, resultEntry } = makeEntries()
    const state = replayEntries([assistantEntry, resultEntry, resultEntry])
    expect(state.messages[0]!.toolCalls![0]!.outputTruncated).toBe(true)
  })

  it('六类工具 5KB output 累积态原样（64KB 累积截断不越权做 4KB 投影的活）', () => {
    const fiveKB = asciiOfBytes(5120)
    const state = replayEntries([
      toolResultEntry('tc-read', fiveKB, 'read') as unknown as PiMessageEntry,
    ])
    // read 无配对 assistant → orphan 收集（累积态无 messages）——改用带 assistant 的序列验证
    const assistantEntry: PiMessageEntry = {
      type: 'message',
      id: 'entry-asst-2',
      parentId: null,
      timestamp: new Date(0).toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc-read', name: 'read', arguments: {} }],
        timestamp: 0,
      },
    } as unknown as PiMessageEntry
    const state2 = replayEntries([assistantEntry, toolResultEntry('tc-read', fiveKB, 'read')])
    expect(state2.messages[0]!.toolCalls![0]!.output).toBe(normalizePiToolResult(fiveKB).output)
    expect(state2.messages[0]!.toolCalls![0]!.outputTruncated).toBeUndefined()
    void state
  })
})

describe('live overlay（registry tool_call_end）与 reducer 同函数一致性', () => {
  // sid 固定 's1'；构造实现收敛到 helpers/fixtures.ts（原内联版逐字同构，
  // initial 放宽 unknown[] 的文件内便捷签名保留，转发时窄化）
  function makeCtx(initial: unknown[]): MessageEffectContext {
    return sharedMakeCtx(initial as Message[], 's1')
  }

  function msg(type: string, payload: Record<string, unknown>): ServerMessage {
    return serverMsg('s1', type, payload)
  }

  it('非六类工具大结果：overlay 回填 output ≡ truncateEntryToolOutput 产物 + outputTruncated + images 回填', () => {
    const bigOutput = asciiOfBytes(ENTRY_TOOL_OUTPUT_MAX_BYTES + 3)
    const host = {
      id: 'm1', role: 'assistant' as const, content: '', status: 'streaming' as const, timestamp: 0,
      toolCalls: [{ id: 'tc-x', toolName: 'mcp__srv__render', input: {}, status: 'running' as const, startTime: 0 }],
    }
    const ctx = makeCtx([host])
    const entry = {
      type: 'message',
      timestamp: new Date(0).toISOString(),
      message: {
        role: 'toolResult', toolCallId: 'tc-x',
        // content 数组含 image block（D6-⑨ live 图片可见性的数据源）
        content: [{ type: 'text', text: bigOutput }, { type: 'image', data: 'QUJD', mimeType: 'image/png' }],
        isError: false, timestamp: 0,
      },
    }
    dispatchMessageEvent(ctx, 's1', msg('message.tool_call_end', { entry }))
    const tc = ctx.messages.value.get('s1')!.value[0]!.toolCalls![0]!
    const expected = truncateEntryToolOutput(bigOutput)
    expect(tc.output).toBe(expected.text)
    expect(tc.outputTruncated).toBe(true)
    // [D6-⑨] live images 回填（缺失则 live 期图片无数据源、设计「live 期即写」不成立）
    expect(tc.images).toEqual([{ data: 'QUJD', mimeType: 'image/png' }])
  })

  it('小结果 overlay 不加 outputTruncated（与 reducer 缺省语义一致）', () => {
    const host = {
      id: 'm1', role: 'assistant' as const, content: '', status: 'streaming' as const, timestamp: 0,
      toolCalls: [{ id: 'tc-y', toolName: 'write', input: {}, status: 'running' as const, startTime: 0 }],
    }
    const ctx = makeCtx([host])
    dispatchMessageEvent(ctx, 's1', msg('message.tool_call_end', {
      // content 数组形态（W21 契约：adapter 归一为数组）
      entry: { type: 'message', timestamp: new Date(0).toISOString(), message: { role: 'toolResult', toolCallId: 'tc-y', content: [{ type: 'text', text: 'tiny' }], isError: false, timestamp: 0 } },
    }))
    const tc = ctx.messages.value.get('s1')!.value[0]!.toolCalls![0]!
    expect(tc.output).toBe('tiny')
    expect(tc.outputTruncated).toBeUndefined()
  })
})
