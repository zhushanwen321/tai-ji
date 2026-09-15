/**
 * session-scoped-map.test.ts —— createSessionScopedMap 契约（TC-4，DM2）。
 *
 * 惰性 init 每 sid 单次 / update 自动建分区 / cleanup 后重 init / 分区互不污染。
 */
import { describe, it, expect, vi } from 'vitest'
import { createSessionScopedMap } from '../utils/session-scoped-map'

describe('createSessionScopedMap', () => {
  it('TC-4a: getOrDefault 惰性 init，每 sid 仅一次', () => {
    const init = vi.fn(() => ({ count: 0 }))
    const map = createSessionScopedMap(init)
    const a = map.getOrDefault('s1')
    const b = map.getOrDefault('s1')
    expect(a).toBe(b) // 同分区同实例
    expect(init).toHaveBeenCalledTimes(1)
    map.getOrDefault('s2')
    expect(init).toHaveBeenCalledTimes(2) // 新 sid 再 init
  })

  it('TC-4b: get 不存在的 sid 返回 undefined 且不建分区', () => {
    const init = vi.fn(() => ({ count: 0 }))
    const map = createSessionScopedMap(init)
    expect(map.get('s1')).toBeUndefined()
    expect(init).not.toHaveBeenCalled()
    expect(map.has('s1')).toBe(false)
  })

  it('TC-4c: update 自动建分区并生效', () => {
    const map = createSessionScopedMap(() => ({ count: 0 }))
    map.update('s1', (t) => { t.count += 1 })
    map.update('s1', (t) => { t.count += 1 })
    expect(map.get('s1')?.count).toBe(2)
    expect(map.has('s1')).toBe(true)
  })

  it('TC-4d: cleanup 后 has=false，再访问重新 init（新实例）', () => {
    const map = createSessionScopedMap(() => ({ count: 0 }))
    map.update('s1', (t) => { t.count = 99 })
    map.cleanup('s1')
    expect(map.has('s1')).toBe(false)
    expect(map.get('s1')).toBeUndefined()
    const fresh = map.getOrDefault('s1')
    expect(fresh.count).toBe(0) // 重新 init，旧数据不残留
  })

  it('TC-4e: 不同 sid 分区互不污染', () => {
    const map = createSessionScopedMap(() => ({ count: 0 }))
    map.update('s1', (t) => { t.count = 1 })
    map.update('s2', (t) => { t.count = 2 })
    expect(map.get('s1')?.count).toBe(1)
    expect(map.get('s2')?.count).toBe(2)
    map.cleanup('s1')
    expect(map.get('s2')?.count).toBe(2) // s1 清理不影响 s2
  })
})
