/**
 * trace-blocks 单测：content block 归一化解析（真实 corpus 字段口径：
 * thinking.thinking / toolCall.id+name+arguments(对象) / toolResult 的 text+image）。
 * fixture 文件的 thinking 块是脱敏时改写过的字段（text/signature），与本单元无关，
 * 故用内联对象按真实格式构造。
 */
import { describe, expect, it } from 'vitest'
import { blockHeadline, extractContentBlocks } from '../trace-blocks'

describe('extractContentBlocks（assistant / toolResult content 归一化）', () => {
  it('assistant 三种 block：字段按真实 pi 口径提取（thinking.thinking / toolCall.id+name+arguments）', () => {
    const blocks = extractContentBlocks([
      { type: 'thinking', thinking: '用户想要分析项目源码', thinkingSignature: 'reasoning_content' },
      { type: 'text', text: '回答正文' },
      { type: 'toolCall', id: 'call_efd9', name: 'bash', arguments: { command: 'ls -la' } },
    ])
    expect(blocks).toEqual([
      { kind: 'thinking', text: '用户想要分析项目源码', redacted: false },
      { kind: 'text', text: '回答正文' },
      { kind: 'toolCall', name: 'bash', callId: 'call_efd9', arguments: { command: 'ls -la' } },
    ])
  })

  it('redacted thinking：标志保留、正文可为空', () => {
    const blocks = extractContentBlocks([{ type: 'thinking', thinking: '', redacted: true }])
    expect(blocks).toEqual([{ kind: 'thinking', text: '', redacted: true }])
  })

  it('toolResult content：text + image（mimeType 可缺）', () => {
    const blocks = extractContentBlocks([
      { type: 'text', text: 'total 232' },
      { type: 'image', data: 'base64…', mimeType: 'image/png' },
      { type: 'image', data: 'base64…' },
    ])
    expect(blocks).toEqual([
      { kind: 'text', text: 'total 232' },
      { kind: 'image', mimeType: 'image/png' },
      { kind: 'image', mimeType: undefined },
    ])
  })

  it('未知 block 类型 / 非对象元素：unknown 兜底不丢失', () => {
    const blocks = extractContentBlocks([{ type: 'futureBlock', x: 1 }, 'junk', null])
    expect(blocks).toEqual([
      { kind: 'unknown', type: 'futureBlock', raw: { type: 'futureBlock', x: 1 } },
      { kind: 'unknown', type: '?', raw: 'junk' },
      { kind: 'unknown', type: '?', raw: null },
    ])
  })

  it('非数组 content（user 的 string 等）：空数组，调用方走文本路径', () => {
    expect(extractContentBlocks('纯文本')).toEqual([])
    expect(extractContentBlocks(undefined)).toEqual([])
  })
})

describe('blockHeadline（子行/清单首行摘要）', () => {
  it('thinking/text：取首行', () => {
    expect(blockHeadline({ kind: 'thinking', text: '第一行\n第二行', redacted: false })).toBe('第一行')
    expect(blockHeadline({ kind: 'text', text: 'a\nb' })).toBe('a')
  })

  it('thinking/text：超长单行截断到 160 + 省略号', () => {
    const long = 'x'.repeat(200)
    const h = blockHeadline({ kind: 'text', text: long })
    expect(h).toHaveLength(161)
    expect(h.endsWith('…')).toBe(true)
  })

  it('toolCall：name + arguments 单行紧凑摘要', () => {
    expect(blockHeadline({ kind: 'toolCall', name: 'bash', callId: 'c1', arguments: { command: 'ls' } })).toBe(
      'bash {"command":"ls"}',
    )
    // 多行 arguments 压平
    expect(
      blockHeadline({ kind: 'toolCall', name: 'write', callId: 'c2', arguments: { path: 'a', content: 'l1\nl2' } }),
    ).toBe('write {"path":"a","content":"l1 l2"}')
    // 无 arguments
    expect(blockHeadline({ kind: 'toolCall', name: 'ping', callId: 'c3', arguments: undefined })).toBe('ping')
  })

  it('image / unknown：mimeType 或 raw 摘要', () => {
    expect(blockHeadline({ kind: 'image', mimeType: 'image/png' })).toBe('image/png')
    expect(blockHeadline({ kind: 'image', mimeType: undefined })).toBe('image')
    expect(blockHeadline({ kind: 'unknown', type: 'future', raw: { a: 1 } })).toBe('{"a":1}')
  })
})
