/**
 * useCommandRegistry 单测（IF6，core 版）。
 *
 * 覆盖 plan TC-15：list 聚合 appCommands + slash（activeSessionId 非 null）、
 * activeSessionId null → slash 空（AC-4.8）、appCommands 物理隔离（session 切换不重算）、
 * registerApp 幂等覆盖（AC-2.4）。
 * 真实 createCommandStore（slash 分区 + appCommands 独立 ref）。
 * 环境：vitest node。
 */
import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import type { KVStorage } from '../../../platform/port'
import { createCommandStore } from '../command-store'
import { useCommandRegistry } from '../command-registry'

function makeMockStorage(): KVStorage {
  const store = new Map<string, string>()
  return {
    async get(key: string) {
      return store.get(key) ?? null
    },
    async set(key: string, value: string) {
      store.set(key, value)
    },
    async remove(key: string) {
      store.delete(key)
    },
  }
}

describe('TC-15: commandRegistry 聚合', () => {
  it('list 聚合 appCommands + slash（activeSessionId 非 null）', () => {
    const store = createCommandStore(makeMockStorage())
    store.registerApp([{ id: 'n', name: '新建', action: () => {} }])
    store.applyCommands('s1', [{ name: 'review', source: 'skill' }])

    const registry = useCommandRegistry(ref<string | null>('s1'), store)
    const names = registry.list().value.map((c) => c.name)
    expect(names).toEqual(['新建', 'review'])
  })

  it('activeSessionId null → slash 空，仅 appCommands（AC-4.8）', () => {
    const store = createCommandStore(makeMockStorage())
    store.registerApp([{ id: 'n', name: '新建', action: () => {} }])
    store.applyCommands('s1', [{ name: 'review', source: 'skill' }])

    const registry = useCommandRegistry(ref<string | null>(null), store)
    const names = registry.list().value.map((c) => c.name)
    expect(names).toEqual(['新建'])
  })

  it('appCommands 物理隔离：session 切换不重算 app 区（AC-2.2）', () => {
    const store = createCommandStore(makeMockStorage())
    store.registerApp([{ id: 'n', name: '新建', action: () => {} }])
    store.applyCommands('s1', [{ name: 'goal', source: 'extension' }])
    store.applyCommands('s2', [{ name: 'todo', source: 'extension' }])

    const sid = ref<string | null>('s1')
    const registry = useCommandRegistry(sid, store)
    expect(registry.list().value.map((c) => c.name)).toEqual(['新建', 'goal'])

    sid.value = 's2'
    expect(registry.list().value.map((c) => c.name)).toEqual(['新建', 'todo'])
    // app 区独立 ref（D-016 物理隔离），未随 session 切换重算
    expect(store.appCommands.value).toHaveLength(1)
  })

  it('registerApp 幂等覆盖（AC-2.4）', () => {
    const store = createCommandStore(makeMockStorage())
    const registry = useCommandRegistry(ref<string | null>(null), store)
    registry.registerApp([{ id: 'a', name: 'A', action: () => {} }])
    registry.registerApp([{ id: 'b', name: 'B', action: () => {} }])

    expect(store.appCommands.value).toHaveLength(1) // 覆盖非累加
    expect(store.appCommands.value[0].name).toBe('B')
  })
})
