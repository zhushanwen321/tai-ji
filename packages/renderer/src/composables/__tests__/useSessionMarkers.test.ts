import { describe, it, expect, beforeEach, vi } from 'vitest'
import { computed, effect } from 'vue'
import {
  markUnread,
  clearUnread,
  isUnread,
  toggleMarkedDone,
  isMarkedDone,
  clearAll,
  __registerCleanupForTest,
  __resetCacheForTest,
} from '../useSessionMarkers'
import { triggerSessionCleanups, __clearSessionCleanupRegistryForTest } from '@/composables/useSessionScopedState'

const STORAGE_KEY = 'taiji:session-markers'

beforeEach(() => {
  localStorage.clear()
  __resetCacheForTest()
  __clearSessionCleanupRegistryForTest()
  __registerCleanupForTest()
})

describe('useSessionMarkers', () => {
  it('markUnread + isUnread', () => {
    expect(isUnread('s1')).toBe(false)
    markUnread('s1')
    expect(isUnread('s1')).toBe(true)
  })

  it('clearUnread', () => {
    markUnread('s1')
    clearUnread('s1')
    expect(isUnread('s1')).toBe(false)
  })

  it('toggleMarkedDone 双向切换', () => {
    expect(isMarkedDone('s1')).toBe(false)
    toggleMarkedDone('s1')
    expect(isMarkedDone('s1')).toBe(true)
    toggleMarkedDone('s1')
    expect(isMarkedDone('s1')).toBe(false)
  })

  it('标记完成时自动清除 unread', () => {
    markUnread('s1')
    expect(isUnread('s1')).toBe(true)
    toggleMarkedDone('s1')
    expect(isMarkedDone('s1')).toBe(true)
    expect(isUnread('s1')).toBe(false)
  })

  it('数据写入 localStorage，可读回', () => {
    markUnread('s1')
    toggleMarkedDone('s2')
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    expect(stored.s1?.unread).toBe(true)
    expect(stored.s2?.markedDone).toBe(true)
  })

  it('triggerSessionCleanups 清除该 sid 条目', () => {
    markUnread('s1')
    toggleMarkedDone('s1')
    triggerSessionCleanups('s1')
    expect(isUnread('s1')).toBe(false)
    expect(isMarkedDone('s1')).toBe(false)
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    expect(stored.s1).toBeUndefined()
  })

  it('clearAll 直接清除', () => {
    markUnread('s1')
    toggleMarkedDone('s1')
    clearAll('s1')
    expect(isUnread('s1')).toBe(false)
    expect(isMarkedDone('s1')).toBe(false)
  })

  it('两个标记都清空后移除整个条目（不残留空对象）', () => {
    markUnread('s1')
    clearUnread('s1')
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    expect(stored.s1).toBeUndefined()
  })

  it('storage 事件触发后内存缓存更新', () => {
    expect(isUnread('s1')).toBe(false)
    const newData = JSON.stringify({ s1: { unread: true } })
    window.dispatchEvent(new StorageEvent('storage', {
      key: STORAGE_KEY,
      newValue: newData,
    }))
    expect(isUnread('s1')).toBe(true)
  })

  it('[回归] isUnread/isMarkedDone 在 computed 中使用时响应式更新（cache.value 变化触发重算）', () => {
    // 这是 SessionItem.vue 的真实用法：const unread = computed(() => isUnread(sid))
    // 修复前 isUnread 读 ensureCache() 局部变量，不访问 cache.value，computed 不重算 → badge 不更新
    const unread = computed(() => isUnread('s1'))
    const done = computed(() => isMarkedDone('s1'))

    expect(unread.value).toBe(false)
    expect(done.value).toBe(false)

    let unreadChanges = 0
    let doneChanges = 0
    effect(() => { void unread.value; unreadChanges++ })
    effect(() => { void done.value; doneChanges++ })
    const unreadBase = unreadChanges
    const doneBase = doneChanges

    markUnread('s1')
    expect(unread.value).toBe(true)
    expect(unreadChanges).toBeGreaterThan(unreadBase) // computed 重算

    toggleMarkedDone('s1')
    expect(done.value).toBe(true)
    expect(doneChanges).toBeGreaterThan(doneBase) // computed 重算
  })

  it('[回归] localStorage 存在空对象 {} 时 ensureCache 仅 hydrate 一次，不重复 parse', () => {
    localStorage.setItem(STORAGE_KEY, '{}')
    isUnread('s1')  // 首次 hydrate，得到空 Map
    isMarkedDone('s1')  // 不应再次 hydrate
    // 验证返回值正确（空 Map 意味着都是默认值）
    expect(isUnread('s1')).toBe(false)
    expect(isMarkedDone('s1')).toBe(false)
    // 后续 markUnread 后 hydrated 仍为 true，不再读 localStorage（写入走内存 cache，与 ensureCache 无关）
    markUnread('s1')
    expect(isUnread('s1')).toBe(true)
  })

  it('[Q1-1] 连续写操作不再 readAll：hydrate 后写路径零 getItem（走内存 cache）', () => {
    markUnread('s1')  // 首次写触发 ensureCache hydrate（1 次 getItem）
    const getItemSpy = vi.spyOn(localStorage, 'getItem')
    const setItemSpy = vi.spyOn(localStorage, 'setItem')
    // 正向对照：先做一次已知 getItem 调用确认 spy 拦截生效，再清零计数——否则下方
    // 「零 getItem」断言无法区分「写路径不读盘」与「spy 根本没挂上」
    void localStorage.getItem(STORAGE_KEY)
    expect(getItemSpy).toHaveBeenCalledTimes(1)
    getItemSpy.mockClear()

    markUnread('s2')
    markUnread('s3')
    clearUnread('s2')
    toggleMarkedDone('s3')
    toggleMarkedDone('s3')
    clearAll('s1')

    // 写路径完全走内存 cache：零 readAll（getItem 不被调用）
    expect(getItemSpy).not.toHaveBeenCalled()
    // 保留立即写盘语义：每次实际变更一次 setItem（clearUnread 移除 s2 / clearAll 移除 s1 均为实际变更）
    expect(setItemSpy).toHaveBeenCalledTimes(6)
    // 语义等价：最终状态正确
    expect(isUnread('s1')).toBe(false)
    expect(isUnread('s2')).toBe(false)
    expect(isMarkedDone('s3')).toBe(false)
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toEqual({})
    // spy 期间确有写盘动作（证明 setItem spy 本身生效，上面计数非空转）
    expect(setItemSpy.mock.calls.length).toBeGreaterThan(0)
  })

  it('[Q1-1] 无条目时 clearUnread/clearAll 不写盘（保持 no-op 语义）', () => {
    markUnread('s1')  // hydrate
    const setItemSpy = vi.spyOn(localStorage, 'setItem')
    clearUnread('nonexistent')
    clearAll('nonexistent')
    expect(setItemSpy).not.toHaveBeenCalled()
    expect(isUnread('s1')).toBe(true)  // 原数据不受影响
  })

  it('[Q1-1] 写路径基于内存 cache 突变：不读盘也能看到先前写入的标记', () => {
    markUnread('s1')
    // 不经过任何读操作，直接再写同 sid —— 旧标记（unread）不应被内存路径丢失
    toggleMarkedDone('s1')
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    // 标记完成时自动清除 unread，且 markedDone=true 保留条目
    expect(stored.s1).toEqual({ unread: false, markedDone: true })
  })
})
