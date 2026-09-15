/**
 * LruSet 条数 LRU 语义单测（dedupe 底层）。
 *
 * LruSet 非包导出 API（index.ts 只导出 createDelivery + types），是 delivery.ts
 * dedupe 的内部实现——此处直接按内部路径单测其淘汰/触达/清空语义，锁 LRU 行为
 * 不随重构漂移。
 */
import { describe, expect, it } from 'vitest'
import { LruSet } from '../src/lru.js'

describe('LruSet 条数 LRU', () => {
  it('容量满淘汰最旧（Map 迭代序首键）', () => {
    const set = new LruSet(2)
    set.add('a')
    set.add('b')
    set.add('c') // 淘汰 a
    expect(set.has('a')).toBe(false)
    expect(set.has('b')).toBe(true)
    expect(set.has('c')).toBe(true)
  })

  it('has 触达刷新 LRU 位置（被访问的 key 不被淘汰）', () => {
    const set = new LruSet(2)
    set.add('a')
    set.add('b')
    expect(set.has('a')).toBe(true) // 触达 a → a 移到末尾，b 成最旧
    set.add('c') // 淘汰 b（非 a）
    expect(set.has('b')).toBe(false)
    expect(set.has('a')).toBe(true)
    expect(set.has('c')).toBe(true)
  })

  it('add 重复 key 刷新位置且不淘汰他人', () => {
    const set = new LruSet(2)
    set.add('a')
    set.add('b')
    set.add('a') // 重复 add：a 移到末尾，不触发淘汰
    set.add('c') // 淘汰 b
    expect(set.has('a')).toBe(true)
    expect(set.has('b')).toBe(false)
    expect(set.has('c')).toBe(true)
  })

  it('clear 清空全部 key', () => {
    const set = new LruSet(3)
    set.add('a')
    set.add('b')
    set.clear()
    expect(set.has('a')).toBe(false)
    expect(set.has('b')).toBe(false)
    set.add('a') // clear 后容量重新可用
    expect(set.has('a')).toBe(true)
  })
})
