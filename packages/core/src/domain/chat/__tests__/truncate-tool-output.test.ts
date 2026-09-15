/**
 * truncate-tool-output 单测（W2 H3 共享截断工具，归位 core 后的 core 侧锁定）。
 *
 * 覆盖：
 * - truncateToolCall 超限截断（含标记总字节 ≤ 4KB、codepoint 边界对齐、确定性——
 *   判定与截断共用一次编码的重构回归锁定：截断结果与长度不变）
 * - 未超限 / 非 truncate 工具原样返回（引用不变）
 * - truncateToolOutputBatchCached 产物复用（applySubagentEntries 基线投影路径：
 *   已见引用复用上次产物输出不变，新消息照常截断，输入源不被污染）
 *
 * 运行：cd packages/core && npx vitest run src/domain/chat/__tests__/truncate-tool-output.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  truncateToBytes,
  truncateToolCall,
  truncateToolOutput,
  truncateToolOutputBatch,
  truncateToolOutputBatchCached,
  shouldTruncate,
  TOOL_OUTPUT_MAX_BYTES,
} from '../truncate-tool-output'
import type { Message, ToolCall } from '@taiji/shared'

const TRUNCATION_MARKER = '\n\n[...output truncated...]'

/** UTF-8 字节长度（测试内自建 encoder，不依赖实现内单例——锁定的是行为不是实现） */
function byteLen(s: string): number {
  return new TextEncoder().encode(s).length
}

function makeToolCall(toolName: string, fields: Partial<ToolCall>): ToolCall {
  return { id: 'tc-1', toolName, input: {}, status: 'completed', startTime: 1000, ...fields }
}

function makeMessage(toolCalls: ToolCall[]): Message {
  return { id: 'm-1', role: 'assistant', content: '', status: 'complete', timestamp: 1000, toolCalls }
}

describe('truncateToolCall（超限截断，性能重构回归锁定）', () => {
  it('超限 output → 截断为头部 + 省略标记，含标记总字节 = TOOL_OUTPUT_MAX_BYTES', () => {
    const tc = makeToolCall('read', { output: 'x'.repeat(10_000) })
    const result = truncateToolCall(tc)

    expect(result).not.toBe(tc)
    expect(result.output!.endsWith(TRUNCATION_MARKER)).toBe(true)
    expect(byteLen(result.output!)).toBe(TOOL_OUTPUT_MAX_BYTES)
    // 头部保留原文前缀（截断体预算内、marker 之前的段与原文逐字节一致）
    expect(result.output!.startsWith('x'.repeat(TOOL_OUTPUT_MAX_BYTES - byteLen(TRUNCATION_MARKER)))).toBe(true)
  })

  it('超限 outputRaw 同步截断', () => {
    const tc = makeToolCall('bash', { output: 'ok', outputRaw: 'y'.repeat(5000) })
    const result = truncateToolCall(tc)

    expect(result.output).toBe('ok')
    expect(result.outputRaw!.endsWith(TRUNCATION_MARKER)).toBe(true)
    expect(byteLen(result.outputRaw!)).toBe(TOOL_OUTPUT_MAX_BYTES)
  })

  it('超限 CJK 输入 → codepoint 边界对齐，不产生半个多字节字符', () => {
    const tc = makeToolCall('read', { output: '中'.repeat(3000) }) // 9000 bytes
    const result = truncateToolCall(tc)

    expect(byteLen(result.output!)).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_BYTES)
    expect(result.output!.endsWith(TRUNCATION_MARKER)).toBe(true)
    // 边界对齐：解码后不含 replacement char（多字节字符未被切断）
    expect(result.output!.includes('\uFFFD')).toBe(false)
    // marker 前的截断体全部是完整 '中'
    expect(result.output!.replace(TRUNCATION_MARKER, '')).toBe('中'.repeat((byteLen(result.output!) - byteLen(TRUNCATION_MARKER)) / 3))
  })

  it('确定性：同一超限输入多次调用截断结果逐值一致（encode 复用重构不改变输出）', () => {
    const tc = makeToolCall('grep', { output: 'ab中'.repeat(2000) })
    const a = truncateToolCall(tc)
    const b = truncateToolCall(tc)

    expect(a.output).toBe(b.output)
    expect(a.output).not.toBe(tc.output)
  })

  it('未超限 output → 原样返回同一引用（不复制、不加标记）', () => {
    const tc = makeToolCall('read', { output: 'small' })
    const result = truncateToolCall(tc)

    expect(result).toBe(tc)
  })

  it('非 truncate 工具（write/edit）→ 原样返回同一引用', () => {
    const tc = makeToolCall('write', { output: 'x'.repeat(10_000) })
    expect(truncateToolCall(tc)).toBe(tc)
  })

  it('MCP 命名空间工具（mcp__fs__read）按末段匹配截断（D12）', () => {
    const tc = makeToolCall('mcp__fs__read', { output: 'z'.repeat(5000) })
    const result = truncateToolCall(tc)

    expect(result).not.toBe(tc)
    expect(result.output!.endsWith(TRUNCATION_MARKER)).toBe(true)
  })

  it('truncateToBytes：CJK 边界回退不切断多字节字符', () => {
    // 4 字节 = '中' + 1 字节 → 回退到 3 字节（1 个完整 '中'）
    expect(truncateToBytes('中中', 4)).toBe('中')
    expect(truncateToBytes('abc', 2)).toBe('ab')
  })
})

describe('truncateToolOutput / truncateToolOutputBatch（R7 不可变）', () => {
  it('无 toolCalls / 无截断 → 原样返回同一引用', () => {
    const noTools: Message = { id: 'm-1', role: 'assistant', content: '', status: 'complete', timestamp: 1000 }
    expect(truncateToolOutput(noTools)).toBe(noTools)

    const small = makeMessage([makeToolCall('read', { output: 'tiny' })])
    expect(truncateToolOutput(small)).toBe(small)
  })

  it('有截断 → 返回新对象，原 msg.toolCalls 与原 toolCall 不被 mutate（R7）', () => {
    const tc = makeToolCall('read', { output: 'x'.repeat(5000) })
    const msg = makeMessage([tc])
    const result = truncateToolOutput(msg)

    expect(result).not.toBe(msg)
    expect(result.toolCalls![0]).not.toBe(tc)
    expect(tc.output).toBe('x'.repeat(5000)) // 原 toolCall 未被改写
    expect(msg.toolCalls![0]!.output).toBe('x'.repeat(5000))
  })

  it('truncateToolOutputBatch：无截断时返回原数组引用；有截断时新数组、未截断消息保留原引用', () => {
    const smallMsg = makeMessage([makeToolCall('read', { output: 'tiny' })])
    const allSmall = [smallMsg, smallMsg]
    expect(truncateToolOutputBatch(allSmall)).toBe(allSmall)

    const bigMsg = makeMessage([makeToolCall('bash', { output: 'x'.repeat(5000) })])
    const mixed = [smallMsg, bigMsg]
    const result = truncateToolOutputBatch(mixed)
    expect(result).not.toBe(mixed)
    expect(result[0]).toBe(smallMsg) // 无截断消息原引用透传
    expect(result[1]).not.toBe(bigMsg)
    expect(result[1]!.toolCalls![0]!.output!.endsWith(TRUNCATION_MARKER)).toBe(true)
  })
})

describe('truncateToolOutputBatchCached（产物复用，applySubagentEntries 投影路径）', () => {
  it('首次投影：与 truncateToolOutputBatch(浅拷贝 map) 输出逐值一致；二次投影复用产物输出不变', () => {
    const bigMsg = makeMessage([makeToolCall('read', { output: 'x'.repeat(5000) })])
    const smallMsg = makeMessage([makeToolCall('bash', { output: 'tiny' })])
    const cache = new WeakMap<Message, Message>()

    const first = truncateToolOutputBatchCached([bigMsg, smallMsg], cache)
    // 基线对照：同输入走既有 truncateToolOutputBatch(浅拷贝 map) 链路
    const baseline = truncateToolOutputBatch([bigMsg, smallMsg].map((m) => ({ ...m })))
    expect(first.map((m) => m.toolCalls![0]!.output)).toEqual(baseline.map((m) => m.toolCalls![0]!.output))
    expect(first[1]).not.toBe(smallMsg) // 未命中消息仍是浅拷贝新对象（形态对齐既有链路）
    expect(first[0]!.toolCalls![0]!.output!.endsWith(TRUNCATION_MARKER)).toBe(true)

    // 二次投影（同引用输入 = reducer 未变更的历史消息）：复用产物，逐值且逐引用一致
    const second = truncateToolOutputBatchCached([bigMsg, smallMsg], cache)
    expect(second).not.toBe(first) // 恒返回新数组（对齐既有链路的每帧新数组）
    expect(second[0]).toBe(first[0]) // 命中消息产物原引用复用
    expect(second).toEqual(first)
  })

  it('新消息（未见过引用）照常截断，已见消息输出值稳定不二次截断', () => {
    const cache = new WeakMap<Message, Message>()
    const bigMsg = makeMessage([makeToolCall('read', { output: 'x'.repeat(5000) })])
    const first = truncateToolOutputBatchCached([bigMsg], cache)
    const truncatedOutput = first[0]!.toolCalls![0]!.output!
    expect(truncatedOutput.endsWith(TRUNCATION_MARKER)).toBe(true)

    // 新增消息后再投影：旧消息值逐字节稳定（marker 不叠加），新消息正确截断
    const nextMsg = makeMessage([makeToolCall('grep', { output: 'y'.repeat(6000) })])
    const second = truncateToolOutputBatchCached([bigMsg, nextMsg], cache)
    expect(second[0]!.toolCalls![0]!.output).toBe(truncatedOutput)
    expect(second[1]!.toolCalls![0]!.output!.endsWith(TRUNCATION_MARKER)).toBe(true)

    // reducer 替换该消息（新引用）→ 缓存不命中，照常判定
    const replaced = { ...bigMsg, toolCalls: [makeToolCall('read', { output: 'w'.repeat(5000) })] }
    const third = truncateToolOutputBatchCached([replaced], cache)
    expect(third[0]).not.toBe(replaced)
    expect(third[0]!.toolCalls![0]!.output!.endsWith(TRUNCATION_MARKER)).toBe(true)
  })

  it('输入源不被污染：截断产物只进缓存与输出，原消息 toolCall 保持全量原文', () => {
    const cache = new WeakMap<Message, Message>()
    const bigMsg = makeMessage([makeToolCall('read', { output: 'x'.repeat(5000) })])
    const originalOutput = bigMsg.toolCalls![0]!.output
    truncateToolOutputBatchCached([bigMsg], cache)
    // reducer state.messages 是全量原文权威镜像（截断只发生在投影输出侧）
    expect(bigMsg.toolCalls![0]!.output).toBe(originalOutput)
    expect(cache.get(bigMsg)!.toolCalls![0]!.output).not.toBe(originalOutput)
  })
})
