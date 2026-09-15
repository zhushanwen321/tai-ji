/**
 * createFileSearchStore 单测（IF1）。
 *
 * 覆盖 plan TC-7：get/set/invalidate 语义 + per-session 分区隔离 + invalidate 幂等。
 * node 环境实测 vue reactivity（ref）。
 */
import { describe, expect, it } from 'vitest'
import type { FileNode } from '@taiji/shared'
import { createFileSearchStore } from '../file-search-store'

function node(path: string, type: 'dir' | 'file' = 'file'): FileNode {
  return { path, name: path.split('/').pop() ?? path, type }
}

describe('createFileSearchStore', () => {
  it('TC-7: get/set/invalidate 语义', () => {
    const store = createFileSearchStore()
    const nodes = [node('src/a.ts'), node('src/b.ts')]

    // 未写入时 get 返回 undefined
    expect(store.get('s1')).toBeUndefined()

    store.set('s1', nodes)
    expect(store.get('s1')).toEqual(nodes)

    store.invalidate('s1')
    expect(store.get('s1')).toBeUndefined()
    expect(store.files.value.has('s1')).toBe(false)
  })

  it('TC-7b: per-session 分区隔离', () => {
    const store = createFileSearchStore()
    store.set('s1', [node('a.ts')])
    store.set('s2', [node('b.ts'), node('c.ts')])

    expect(store.get('s1')).toHaveLength(1)
    expect(store.get('s2')).toHaveLength(2)
    // 互不干扰
    store.invalidate('s1')
    expect(store.get('s2')).toHaveLength(2)
  })

  it('TC-7c: invalidate 对不存在 session 幂等', () => {
    const store = createFileSearchStore()
    expect(() => store.invalidate('nope')).not.toThrow()
    expect(store.files.value.size).toBe(0)
  })
})
