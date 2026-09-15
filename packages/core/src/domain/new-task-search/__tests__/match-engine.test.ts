/**
 * match-engine 下沉回归单测（plan TC-8）。
 *
 * 覆盖 matchFilter/segments 边界：空查询 / 大小写不敏感 / 连续命中 / text='' /
 * 纯函数（不修改原数组）。用例与 renderer __tests__/lib/match-engine.test.ts 对齐
 * （core 版回归防护：原样下沉不得行为漂移）。
 */
import { describe, expect, it } from 'vitest'
import { matchFilter, segments, type MatchSegment } from '../match-engine'

describe('segments —— 高亮切分', () => {
  it('TC-8a: 空查询 → 单元素 hit:false（保留原 text）', () => {
    expect(segments('hello world', '')).toEqual([{ text: 'hello world', hit: false }])
  })

  it('TC-8b: text 为空 → 单元素 {text:"", hit:false}', () => {
    expect(segments('', 'abc')).toEqual([{ text: '', hit: false }])
    expect(segments('', '')).toEqual([{ text: '', hit: false }])
  })

  it('TC-8c: 单次命中：前后未命中段 + 命中段（保留原大小写）', () => {
    const out = segments('auth/session.ts', 'session')
    expect(out).toEqual<MatchSegment[]>([
      { text: 'auth/', hit: false },
      { text: 'session', hit: true },
      { text: '.ts', hit: false },
    ])
  })

  it('TC-8d: 大小写不敏感：命中段保留原 text 大小写', () => {
    expect(segments('Hello World', 'world')).toEqual<MatchSegment[]>([
      { text: 'Hello ', hit: false },
      { text: 'World', hit: true },
    ])
  })

  it('TC-8e: 多次命中：每个命中点独立 hit:true 段', () => {
    const out = segments('abcabc', 'b')
    expect(out).toEqual<MatchSegment[]>([
      { text: 'a', hit: false },
      { text: 'b', hit: true },
      { text: 'ca', hit: false },
      { text: 'b', hit: true },
      { text: 'c', hit: false },
    ])
    expect(out.filter((s) => s.hit)).toHaveLength(2)
  })

  it('TC-8f: 无命中 → 整段单元素 hit:false', () => {
    expect(segments('no match here', 'taiji')).toEqual([{ text: 'no match here', hit: false }])
  })
})

describe('matchFilter —— 子串过滤', () => {
  const items = [
    { title: 'auth/session.ts', sub: 'user authentication' },
    { title: 'settings.ts', sub: 'session timeout config' },
    { title: 'README.md', sub: 'project intro' },
  ]

  it('TC-8g: 空查询 → 返回全部（不过滤，同一引用）', () => {
    expect(matchFilter(items, '')).toEqual(items)
    expect(matchFilter(items, '')).toBe(items)
  })

  it('TC-8h: 空 items → 空数组', () => {
    expect(matchFilter([], 'abc')).toEqual([])
  })

  it('TC-8i: title 命中 / sub 命中 / 任一命中均保留', () => {
    expect(matchFilter(items, 'settings')).toEqual([items[1]])
    expect(matchFilter(items, 'timeout')).toEqual([items[1]])
    const out = matchFilter(items, 'session')
    expect(out.map((it) => it.title).sort()).toEqual(['auth/session.ts', 'settings.ts'])
  })

  it('TC-8j: 都不命中 → 空数组；纯函数不改原数组', () => {
    expect(matchFilter(items, 'zzz')).toEqual([])
    const before = items.slice()
    matchFilter(items, 'session')
    expect(items).toEqual(before)
  })
})
