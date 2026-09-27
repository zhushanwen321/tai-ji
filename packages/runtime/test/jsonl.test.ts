/**
 * parseJsonl 单测 — 覆盖契约「跳过空行与畸形行、按行序返回成功解析项」。
 *
 * 被 session-file-utils / session-history 两处共用，回归影响面大。
 *
 * 运行：pnpm --filter @taiji/runtime run test -- test/jsonl.test.ts
 */
import { describe, it, expect } from 'vitest'
import { parseJsonl } from '../src/utils/jsonl.js'

describe('parseJsonl', () => {
  it('空字符串返回空数组', () => {
    expect(parseJsonl('')).toEqual([])
  })

  it('单行合法 JSON 返回单元素数组', () => {
    expect(parseJsonl('{"type":"user"}')).toEqual([{ type: 'user' }])
  })

  it('跳过空行与空白行，保留合法行顺序', () => {
    const raw = ['{"a":1}', '', '   ', '{"b":2}', ''].join('\n')
    expect(parseJsonl(raw)).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('跳过畸形行，不中断后续合法行解析', () => {
    const raw = ['{"a":1}', 'not json', '{bad', '{"b":2}', '}'].join('\n')
    expect(parseJsonl(raw)).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('保留 Unicode 与转义字符', () => {
    const raw = '{"text":"你好\\n世界","q":"含\\"引号"}'
    expect(parseJsonl(raw)).toEqual([{ text: '你好\n世界', q: '含"引号' }])
  })

  it('trim 后解析（行首尾空白不影响）', () => {
    expect(parseJsonl('  {"x":1}  ')).toEqual([{ x: 1 }])
  })

  it('全畸形行返回空数组', () => {
    expect(parseJsonl(['foo', 'bar', '{'].join('\n'))).toEqual([])
  })
})
