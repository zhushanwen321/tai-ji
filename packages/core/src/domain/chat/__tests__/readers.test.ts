/**
 * domain/chat readers 迁移单测（语义等价锁定，w1 原样迁移）。
 *
 * 锁定 11 个 payload 窄化纯函数：安全读取语义——非法形状一律回退默认值
 * （undefined / {} / [] / 'accumulating'），绝不 throw。
 */
import { describe, it, expect } from 'vitest'
import {
  readString,
  readRecord,
  readNumber,
  readBool,
  readStringArray,
  readDetail,
  readUsage,
  readCompactionSummary,
  readBranchSummary,
  readFileChanges,
  readChangeSetStatus,
} from '../readers'

describe('readString', () => {
  it('字符串字段返回原值', () => {
    expect(readString({ k: 'v' }, 'k')).toBe('v')
  })
  it('非字符串（数字/对象/null/undefined）回退 undefined', () => {
    expect(readString({ a: 1 }, 'a')).toBeUndefined()
    expect(readString({ a: {} }, 'a')).toBeUndefined()
    expect(readString({ a: null }, 'a')).toBeUndefined()
    expect(readString({}, 'a')).toBeUndefined()
  })
})

describe('readRecord', () => {
  it('对象字段返回原引用', () => {
    const obj = { x: 1 }
    expect(readRecord({ k: obj }, 'k')).toBe(obj)
  })
  it('非对象（数组/null/字符串）回退空对象', () => {
    expect(readRecord({ a: [] }, 'a')).toEqual({})
    expect(readRecord({ a: null }, 'a')).toEqual({})
    expect(readRecord({ a: 'str' }, 'a')).toEqual({})
    expect(readRecord({}, 'a')).toEqual({})
  })
})

describe('readNumber', () => {
  it('有限数字返回原值', () => {
    expect(readNumber({ k: 3.14 }, 'k')).toBe(3.14)
  })
  it('非有限数（NaN/Infinity）回退 undefined', () => {
    expect(readNumber({ a: NaN }, 'a')).toBeUndefined()
    expect(readNumber({ a: Infinity }, 'a')).toBeUndefined()
  })
  it('非数字（字符串/对象）回退 undefined', () => {
    expect(readNumber({ a: '5' }, 'a')).toBeUndefined()
    expect(readNumber({}, 'a')).toBeUndefined()
  })
})

describe('readBool', () => {
  it('严格 === true 才返回 true', () => {
    expect(readBool({ k: true }, 'k')).toBe(true)
  })
  it("false/'true' 字符串/1 均返回 false", () => {
    expect(readBool({ a: false }, 'a')).toBe(false)
    expect(readBool({ a: 'true' }, 'a')).toBe(false)
    expect(readBool({ a: 1 }, 'a')).toBe(false)
    expect(readBool({}, 'a')).toBe(false)
  })
})

describe('readStringArray', () => {
  it('全字符串数组返回原数组', () => {
    expect(readStringArray({ k: ['a', 'b'] }, 'k')).toEqual(['a', 'b'])
  })
  it('含非字符串元素回退 undefined', () => {
    expect(readStringArray({ a: ['a', 1] }, 'a')).toBeUndefined()
  })
  it('非数组回退 undefined', () => {
    expect(readStringArray({ a: 'x' }, 'a')).toBeUndefined()
    expect(readStringArray({}, 'a')).toBeUndefined()
  })
})

describe('readDetail', () => {
  it('string 返回原值', () => {
    expect(readDetail({ k: 'detail' }, 'k')).toBe('detail')
  })
  it('object 返回原引用', () => {
    const obj = { partial: true }
    expect(readDetail({ k: obj }, 'k')).toBe(obj)
  })
  it('null/undefined 回退 undefined', () => {
    expect(readDetail({ a: null }, 'a')).toBeUndefined()
    expect(readDetail({}, 'a')).toBeUndefined()
  })
  it('其他类型（数字/布尔/数组）回退 undefined', () => {
    expect(readDetail({ a: 42 }, 'a')).toBeUndefined()
    expect(readDetail({ a: true }, 'a')).toBeUndefined()
    expect(readDetail({ a: [1] }, 'a')).toBeUndefined()
  })
})

describe('readUsage', () => {
  it('inputTokens/outputTokens 齐全返回窄化对象（totalTokens 舍弃）', () => {
    expect(readUsage({ usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } })).toEqual({
      inputTokens: 10,
      outputTokens: 20,
    })
  })
  it('缺任一 token 字段回退 undefined', () => {
    expect(readUsage({ usage: { inputTokens: 10 } })).toBeUndefined()
    expect(readUsage({ usage: { outputTokens: 20 } })).toBeUndefined()
  })
  it('usage 空对象/缺失回退 undefined', () => {
    expect(readUsage({ usage: {} })).toBeUndefined()
    expect(readUsage({})).toBeUndefined()
  })
})

describe('readCompactionSummary', () => {
  it('全字段构建 summary', () => {
    expect(readCompactionSummary({ summary: 's', tokensBefore: 100, timestamp: 123 })).toEqual({
      summary: 's',
      tokensBefore: 100,
      timestamp: 123,
    })
  })
  it("空串 summary 透传保留（MF-1——pi 落盘 '' 时 replay 保留空行，live 链不得丢成 undefined 走 fallback）", () => {
    expect(readCompactionSummary({ summary: '', tokensBefore: 100 })).toEqual({ summary: '', tokensBefore: 100 })
  })
  it('部分字段仅构建存在项（非法值跳过）', () => {
    expect(readCompactionSummary({})).toEqual({})
    expect(readCompactionSummary({ tokensBefore: 100 })).toEqual({ tokensBefore: 100 })
    expect(readCompactionSummary({ summary: 'x', tokensBefore: 'bad' })).toEqual({ summary: 'x' })
  })
})

describe('readBranchSummary', () => {
  it('全字段构建 summary', () => {
    expect(readBranchSummary({ summary: 's', fromId: 'f', timestamp: 123 })).toEqual({
      summary: 's',
      fromId: 'f',
      timestamp: 123,
    })
  })
  it("空串 summary 透传保留（MF-1 同族预防——与 readCompactionSummary 同型门）", () => {
    expect(readBranchSummary({ summary: '', fromId: 'f' })).toEqual({ summary: '', fromId: 'f' })
  })
  it('部分字段仅构建存在项', () => {
    expect(readBranchSummary({})).toEqual({})
    expect(readBranchSummary({ fromId: 'f' })).toEqual({ fromId: 'f' })
  })
})

describe('readFileChanges', () => {
  it('合法 FileChange 形状通过过滤返回', () => {
    const fc = { filePath: 'a.ts', status: 'modified' }
    expect(readFileChanges({ fileChanges: [fc] })).toEqual([fc])
  })
  it('非数组回退 []', () => {
    expect(readFileChanges({ fileChanges: 'x' })).toEqual([])
    expect(readFileChanges({})).toEqual([])
  })
  it('非法元素（缺 filePath/非对象/null）被过滤', () => {
    expect(readFileChanges({ fileChanges: [{ status: 'added' }, null, 42] })).toEqual([])
    expect(
      readFileChanges({ fileChanges: [{ filePath: 'a.ts', status: 'added' }, { status: 'deleted' }] }),
    ).toHaveLength(1)
  })
})

describe('readChangeSetStatus', () => {
  it('合法状态原样返回', () => {
    expect(readChangeSetStatus({ changeSetStatus: 'ready' })).toBe('ready')
    expect(readChangeSetStatus({ changeSetStatus: 'resolved' })).toBe('resolved')
  })
  it('非法值回退 accumulating（默认态）', () => {
    expect(readChangeSetStatus({ changeSetStatus: 'bogus' })).toBe('accumulating')
    expect(readChangeSetStatus({})).toBe('accumulating')
  })
})
