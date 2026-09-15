/**
 * normalize-tool-result 单元测试（W1）。
 *
 * 目的：把 event-adapter.handleToolExecutionEnd 和 message-converter toolResult 分支里
 * 重复的「pi tool-result 数据归一」逻辑（三态判定 + stripAnsi + images/details 提取）
 * 提取到一个深模块，本测试覆盖其契约（plan.json U1/U2/U3）。
 *
 * 运行：npx vitest run test/normalize-tool-result.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  normalizePiToolResult,
  stripAnsi,
} from '../src/infra/pi/normalize-tool-result.js'

describe('stripAnsi', () => {
  it('剥离 ANSI 转义序列（来自 event-adapter / message-converter 原共享逻辑）', () => {
    expect(stripAnsi('\x1b[31mhello\x1b[0m')).toBe('hello')
    expect(stripAnsi('\x1b[1;32mgreen bold\x1b[0m')).toBe('green bold')
  })

  it('不含 ANSI 时原样返回', () => {
    expect(stripAnsi('plain text')).toBe('plain text')
    expect(stripAnsi('')).toBe('')
  })
})

describe('normalizePiToolResult — U1: 三种 raw 形态', () => {
  describe('形态 A: string', () => {
    it('含 ANSI → output 已剥离，outputRaw 保留原始', () => {
      const raw = '\x1b[31mhello\x1b[0m world'
      const r = normalizePiToolResult(raw)
      expect(r.output).toBe('hello world')
      expect(r.outputRaw).toBe(raw)
      expect(r.images).toBeUndefined()
      expect(r.details).toBeUndefined()
    })

    it('不含 ANSI → output 等于原文，outputRaw 为 undefined', () => {
      const raw = 'plain output'
      const r = normalizePiToolResult(raw)
      expect(r.output).toBe('plain output')
      expect(r.outputRaw).toBeUndefined()
    })

    it('空字符串 → output 为空，outputRaw 为 undefined', () => {
      const r = normalizePiToolResult('')
      expect(r.output).toBe('')
      expect(r.outputRaw).toBeUndefined()
    })
  })

  describe('形态 B: object 含 content 数组', () => {
    it('单 text 块 → output 为该文本', () => {
      const r = normalizePiToolResult({ content: [{ type: 'text', text: 'foo' }] })
      expect(r.output).toBe('foo')
      expect(r.outputRaw).toBeUndefined()
    })

    it('多 text 块 → output 以 \\n 连接', () => {
      const r = normalizePiToolResult({
        content: [
          { type: 'text', text: 'foo' },
          { type: 'text', text: 'bar' },
        ],
      })
      expect(r.output).toBe('foo\nbar')
    })

    it('text 块含 ANSI → output 剥离，outputRaw 保留原始拼接文本', () => {
      const r = normalizePiToolResult({
        content: [{ type: 'text', text: '\x1b[32mgreen\x1b[0m' }],
      })
      expect(r.output).toBe('green')
      expect(r.outputRaw).toBe('\x1b[32mgreen\x1b[0m')
    })

    it('含 image 块 → images 提取 {data, mimeType}（过滤空 data）', () => {
      const r = normalizePiToolResult({
        content: [
          { type: 'image', data: 'base64data', mimeType: 'image/png' },
          { type: 'image', data: '', mimeType: '' }, // 空 → 被过滤
        ],
      })
      expect(r.images).toEqual([{ data: 'base64data', mimeType: 'image/png' }])
    })

    it('text + image 混合 → 同时产出 output 和 images', () => {
      const r = normalizePiToolResult({
        content: [
          { type: 'text', text: 'screenshot below' },
          { type: 'image', data: 'd1', mimeType: 'image/png' },
        ],
      })
      expect(r.output).toBe('screenshot below')
      expect(r.images).toEqual([{ data: 'd1', mimeType: 'image/png' }])
    })

    it('无 text 块只有 image → output 为空字符串', () => {
      const r = normalizePiToolResult({
        content: [{ type: 'image', data: 'd1', mimeType: 'image/png' }],
      })
      expect(r.output).toBe('')
      expect(r.images).toEqual([{ data: 'd1', mimeType: 'image/png' }])
    })

    it('content 为空数组 → output 为空，images 为 undefined', () => {
      const r = normalizePiToolResult({ content: [] })
      expect(r.output).toBe('')
      expect(r.images).toBeUndefined()
    })

    it('非 text/image 类型的块被忽略', () => {
      const r = normalizePiToolResult({
        content: [
          { type: 'tool_use', name: 'x' },
          { type: 'text', text: 'keep' },
        ],
      })
      expect(r.output).toBe('keep')
    })
  })

  describe('形态 C: 非 null 对象（非 content 形态）', () => {
    it('→ output 为 JSON.stringify', () => {
      const r = normalizePiToolResult({ foo: 'bar', n: 1 })
      expect(r.output).toBe(JSON.stringify({ foo: 'bar', n: 1 }))
      expect(r.outputRaw).toBeUndefined()
    })

    it('数组 → output 为 JSON.stringify', () => {
      const r = normalizePiToolResult([1, 2, 3])
      expect(r.output).toBe('[1,2,3]')
    })
  })

  describe('形态 D: null / undefined', () => {
    it('null → output 为空字符串', () => {
      const r = normalizePiToolResult(null)
      expect(r.output).toBe('')
      expect(r.outputRaw).toBeUndefined()
    })

    it('undefined → output 为空字符串', () => {
      const r = normalizePiToolResult(undefined)
      expect(r.output).toBe('')
      expect(r.outputRaw).toBeUndefined()
    })
  })

  describe('details 提取（raw 内 details，实时路语义）', () => {
    it('raw.details 是对象 → 透传 details', () => {
      const details = { __gui__: { type: 'progress', value: 0.5 } }
      const r = normalizePiToolResult({ content: [{ type: 'text', text: 'x' }], details })
      expect(r.details).toEqual(details)
    })

    it('raw.details 是数组 → 不提取（details 为 undefined）', () => {
      const r = normalizePiToolResult({ content: [], details: [1, 2, 3] })
      expect(r.details).toBeUndefined()
    })

    it('raw.details 是原始值 → 不提取', () => {
      const r = normalizePiToolResult({ content: [], details: 'string-not-object' })
      expect(r.details).toBeUndefined()
    })

    it('raw 是 string → details 为 undefined', () => {
      const r = normalizePiToolResult('hello')
      expect(r.details).toBeUndefined()
    })
  })
})

describe('normalizePiToolResult — U2: 对称回归', () => {
  // 同一 fixture 经 normalizePiToolResult 后，output 与 outputRaw 的关系
  // 必须满足「仅当含 ANSI 时 outputRaw !== output 且 outputRaw 非空」的不变量。
  const fixtures = [
    { name: 'string-no-ansi', raw: 'plain' },
    { name: 'string-ansi', raw: '\x1b[31mred\x1b[0m' },
    { name: 'content-text-no-ansi', raw: { content: [{ type: 'text', text: 'hi' }] } },
    { name: 'content-text-ansi', raw: { content: [{ type: 'text', text: '\x1b[33myellow\x1b[0m' }] } },
    { name: 'content-multi-text', raw: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } },
    { name: 'object', raw: { k: 'v' } },
    { name: 'null', raw: null },
  ]

  for (const f of fixtures) {
    it(`${f.name}: outputRaw 仅在含 ANSI 时出现且 !== output`, () => {
      const r = normalizePiToolResult(f.raw)
      if (r.outputRaw !== undefined) {
        // 含 ANSI 时不变量：outputRaw 必含 ANSI 而 output 已剥离 → 二者必不同
        expect(r.outputRaw).not.toBe(r.output)
        // output 不应再含 ANSI 转义
        expect(r.output).not.toMatch(/\x1b\[/)
      } else {
        // 无 ANSI 时 outputRaw 必为 undefined（而非空串或等于 output）
        expect(r.outputRaw).toBeUndefined()
      }
    })
  }
})

describe('normalizePiToolResult — U3: ANSI_REGEX 单一定义点', () => {
  // ANSI_REGEX / stripAnsi 只应存在于 normalize-tool-result.ts。
  // 这里通过 import 确认 stripAnsi 来自本模块（event-adapter / message-converter 改造后应 re-import）。
  it('stripAnsi 从 normalize-tool-result 导出且为函数', () => {
    expect(typeof stripAnsi).toBe('function')
  })

  it('stripAnsi 与 normalizePiToolResult 行为一致（内部使用同一正则）', () => {
    // 含 ANSI 的 string 走 normalize，output 应等于直接调 stripAnsi 的结果
    const raw = '\x1b[36mcyan\x1b[0m'
    expect(normalizePiToolResult(raw).output).toBe(stripAnsi(raw))
  })
})
