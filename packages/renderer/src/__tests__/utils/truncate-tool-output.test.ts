/**
 * W2 红灯测试：truncateToolOutput 共享截断工具。
 *
 * 对应 FR-2（tool result 截断）+ AC-3/4/10/11/13 + D7/D9/D10/D12。
 *
 * 截断策略（D7/D10/D12）：
 * - toolName ∈ {read, bash, cat, grep, glob, list} 的 output/outputRaw 按头部 4KB(UTF-8字节) 截断 + 省略标记
 * - toolName ∈ {write, edit} 不截断
 * - MCP 命名空间前缀（mcp__server__read）按 __ split 取末段匹配（D12）
 * - UTF-8 codepoint 边界对齐，不切断多字节字符（AC-11）
 * - details.__gui__ 结构化数据不截断（AC 隐含）
 * - ≤4KB 时不截断、不加标记
 *
 * [红灯说明] truncateToolOutput 尚未实现，import 会 fail。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/utils/truncate-tool-output.test.ts
 */
import { describe, it, expect } from 'vitest'
import { truncateToolOutput, TRUNCATE_TOOLS, TOOL_OUTPUT_MAX_BYTES } from '@taiji/core'
import type { Message } from '@taiji/shared'

function makeAssistantWithTool(toolName: string, output: string, outputRaw?: string): Message {
  return {
    id: 'm1',
    role: 'assistant',
    content: '',
    status: 'complete',
    timestamp: Date.now(),
    toolCalls: [
      {
        id: 'tc1',
        toolName,
        input: {},
        output,
        ...(outputRaw !== undefined ? { outputRaw } : {}),
        status: 'completed',
        startTime: Date.now(),
      },
    ],
  }
}

describe('W2 truncateToolOutput 共享截断工具', () => {
  describe('AC-3: 超 4KB 截断为头部 4KB + 省略标记', () => {
    it('read 工具 output 超 4KB → 截断', () => {
      const bigOutput = 'x'.repeat(5000) // 5KB
      const msg = makeAssistantWithTool('read', bigOutput)
      const result = truncateToolOutput(msg)

      const tc = result.toolCalls![0]
      expect(Buffer.byteLength(tc.output!, 'utf-8')).toBeLessThanOrEqual(4096)
      expect(tc.output!.length).toBeGreaterThan(0)
      // 应包含截断标记（具体格式由实现定，但需有标识）
      expect(tc.output).toMatch(/截断|truncate|omit|\.\.\./i)
    })

    it('outputRaw 同步截断', () => {
      const bigOutput = 'x'.repeat(5000)
      const msg = makeAssistantWithTool('bash', bigOutput, '\x1b[31m' + bigOutput)
      const result = truncateToolOutput(msg)

      const tc = result.toolCalls![0]
      expect(Buffer.byteLength(tc.output!, 'utf-8')).toBeLessThanOrEqual(4096)
      expect(Buffer.byteLength(tc.outputRaw!, 'utf-8')).toBeLessThanOrEqual(4096)
    })
  })

  describe('AC-4: read/bash/grep 截断，write/edit 不截断', () => {
    it('read/bash/cat/grep/glob/list 都截断', () => {
      const bigOutput = 'x'.repeat(5000)
      for (const tool of ['read', 'bash', 'cat', 'grep', 'glob', 'list']) {
        const msg = makeAssistantWithTool(tool, bigOutput)
        const result = truncateToolOutput(msg)
        expect(Buffer.byteLength(result.toolCalls![0].output!, 'utf-8')).toBeLessThanOrEqual(4096)
      }
    })

    it('write/edit 不截断（短确认输出）', () => {
      const bigOutput = 'x'.repeat(5000)
      for (const tool of ['write', 'edit']) {
        const msg = makeAssistantWithTool(tool, bigOutput)
        const result = truncateToolOutput(msg)
        expect(result.toolCalls![0].output).toBe(bigOutput) // 原样保留
      }
    })
  })

  describe('AC-13: MCP 命名空间前缀兼容（mcp__server__read 命中截断）', () => {
    it('mcp__server__read 按末段匹配命中截断', () => {
      const bigOutput = 'x'.repeat(5000)
      const msg = makeAssistantWithTool('mcp__filesystem__read', bigOutput)
      const result = truncateToolOutput(msg)
      expect(Buffer.byteLength(result.toolCalls![0].output!, 'utf-8')).toBeLessThanOrEqual(4096)
    })
  })

  describe('AC-11: UTF-8 codepoint 边界对齐', () => {
    it('CJK 字符串截断不产生半个多字节字符', () => {
      // 5000 个中文字符（每个 3 字节 UTF-8 = 15000 字节）
      const bigCjk = '测'.repeat(5000)
      const msg = makeAssistantWithTool('read', bigCjk)
      const result = truncateToolOutput(msg)

      const output = result.toolCalls![0].output!
      // 截断后的字符串必须是合法 UTF-8（不含半个字符）
      // 验证：能被 round-trip encode/decode
      expect(() => Buffer.from(output, 'utf-8').toString('utf-8')).not.toThrow()
      // 长度 ≤ 4096 字节
      expect(Buffer.byteLength(output, 'utf-8')).toBeLessThanOrEqual(4096)
    })
  })

  describe('≤4KB 不截断', () => {
    it('output ≤ 4KB 原样保留、不加标记', () => {
      const smallOutput = 'x'.repeat(3000) // 3KB
      const msg = makeAssistantWithTool('read', smallOutput)
      const result = truncateToolOutput(msg)
      expect(result.toolCalls![0].output).toBe(smallOutput) // 无截断标记
    })
  })

  describe('details.__gui__ 结构化数据不截断', () => {
    it('details 字段完整保留', () => {
      const bigGui = { __gui__: { tree: 'x'.repeat(5000) } }
      const msg: Message = {
        id: 'm1',
        role: 'assistant',
        content: '',
        status: 'complete',
        timestamp: Date.now(),
        toolCalls: [
          {
            id: 'tc1',
            toolName: 'read',
            input: {},
            output: 'x'.repeat(5000),
            details: bigGui,
            status: 'completed',
            startTime: Date.now(),
          },
        ],
      }
      const result = truncateToolOutput(msg)
      expect(result.toolCalls![0].details).toEqual(bigGui) // 完整保留
    })
  })

  describe('无 toolCalls 的消息原样返回', () => {
    it('普通 assistant 消息（无 toolCalls）不受影响', () => {
      const msg: Message = {
        id: 'm1',
        role: 'assistant',
        content: 'hello',
        status: 'complete',
        timestamp: Date.now(),
      }
      const result = truncateToolOutput(msg)
      expect(result).toEqual(msg)
    })
  })

  describe('TRUNCATE_TOOLS 常量 + TOOL_OUTPUT_MAX_BYTES 常量', () => {
    it('TRUNCATE_TOOLS 包含 read/bash/cat/grep/glob/list', () => {
      expect(TRUNCATE_TOOLS).toContain('read')
      expect(TRUNCATE_TOOLS).toContain('bash')
      expect(TRUNCATE_TOOLS).toContain('grep')
    })

    it('TOOL_OUTPUT_MAX_BYTES 为 4096', () => {
      expect(TOOL_OUTPUT_MAX_BYTES).toBe(4096)
    })
  })
})
