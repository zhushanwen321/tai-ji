import { describe, expect, it } from 'vitest'

import { normalizeZcodeRowId, ZCODE_ROW_ID_WIDTH } from '../zcode-id.js'

describe('normalizeZcodeRowId', () => {
  it('非负整数归一化为固定 8 位零填充小写十六进制', () => {
    expect(ZCODE_ROW_ID_WIDTH).toBe(8)
    expect(normalizeZcodeRowId(1)).toBe('00000001')
    // 设计 D1 最小例子：id '0000000a'
    expect(normalizeZcodeRowId(10)).toBe('0000000a')
    expect(normalizeZcodeRowId(0)).toBe('00000000')
    expect(normalizeZcodeRowId(0xdeadbeef)).toBe('deadbeef')
    expect(normalizeZcodeRowId(0xffff)).toBe('0000ffff')
  })

  it('超 8 位的大 id 不截断（自然扩展位数，保持值可逆）', () => {
    // Number.MAX_SAFE_INTEGER = 0x1fffffffffffff
    expect(normalizeZcodeRowId(Number.MAX_SAFE_INTEGER)).toBe('1fffffffffffff')
  })

  it('负数与非安全整数 fail-fast（RangeError），不产出结构坏 id', () => {
    expect(() => normalizeZcodeRowId(-1)).toThrowError(RangeError)
    expect(() => normalizeZcodeRowId(1.5)).toThrowError(RangeError)
    expect(() => normalizeZcodeRowId(Number.NaN)).toThrowError(RangeError)
  })
})
