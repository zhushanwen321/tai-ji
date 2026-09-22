/**
 * parseJsonl 单测 — 覆盖契约「跳过空行与畸形行、按行序返回成功解析项」。
 *
 * 被 session-file-utils / session-history 两处共用，回归影响面大。
 *
 * parseJsonlWarnOnMalformed（RT-8#13）补 warn-once 观测契约：畸形行丢 1 次 warn 恰一次
 * 且文案含 filePath，零畸形不出声——回归即退回「半损坏文件静默丢字段、零丢弃计数」。
 *
 * 运行：pnpm --filter @taiji/runtime run test -- test/jsonl.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parseJsonl, parseJsonlWarnOnMalformed } from '../src/utils/jsonl.js'
import { _resetWarnOnceForTest } from '../src/utils/warn-once.js'

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

describe('parseJsonlWarnOnMalformed（RT-8#13 可观测性）', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    _resetWarnOnceForTest()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
    _resetWarnOnceForTest()
  })

  it('畸形行 → warn 恰一次，文案含 filePath 与丢弃计数；合法行按序保留', () => {
    const fp = '/tmp/fake/sessions/s1.jsonl'
    const raw = ['{"a":1}', 'not json', '{bad', '{"b":2}'].join('\n')
    expect(parseJsonlWarnOnMalformed(raw, fp)).toEqual([{ a: 1 }, { b: 2 }])
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const msg = String(warnSpy.mock.calls[0]?.[0])
    expect(msg).toContain(fp)
    expect(msg).toContain('2 行畸形 JSON')
  })

  it('无畸形行（含空行/空白行）→ 不 warn', () => {
    const raw = ['{"a":1}', '', '   ', '{"b":2}'].join('\n')
    expect(parseJsonlWarnOnMalformed(raw, '/tmp/fake/clean.jsonl')).toEqual([{ a: 1 }, { b: 2 }])
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('同一 filePath 重复解析 → warn-once 去重，仍只出声一次', () => {
    const fp = '/tmp/fake/dup.jsonl'
    parseJsonlWarnOnMalformed('bad line', fp)
    parseJsonlWarnOnMalformed('bad line', fp)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('不同 filePath 各自出声一次（去重键 = jsonl:<filePath>）', () => {
    parseJsonlWarnOnMalformed('bad', '/tmp/fake/a.jsonl')
    parseJsonlWarnOnMalformed('bad', '/tmp/fake/b.jsonl')
    expect(warnSpy).toHaveBeenCalledTimes(2)
  })
})
