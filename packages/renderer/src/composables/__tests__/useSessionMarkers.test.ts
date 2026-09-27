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

  // ── 损坏保护（RD-1#2 / 审计 M4 族：损坏数据读回空骨架 → 全量覆写）──

  it('[RD-1#2] localStorage 值损坏时 mutateMarker 拒绝写盘：原始（可人工恢复）数据不被空表覆写', () => {
    const corruptRaw = '{"s1":{"unread":true},"s2":{"markedDone":true},BROKEN'
    localStorage.setItem(STORAGE_KEY, corruptRaw)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    markUnread('s3') // ensureCache hydrate → 解析失败 → corrupt → 拒绝写
    expect(localStorage.getItem(STORAGE_KEY)).toBe(corruptRaw) // 原值原样保留
    expect(warnSpy).toHaveBeenCalled()
    // warn 含 key 与恢复动作指引（可行动错误消息）
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(warned).toContain(STORAGE_KEY)
    expect(warned).toContain('恢复动作')

    // 读侧降级但不写：多次标记操作后原值仍不被覆写
    toggleMarkedDone('s3')
    clearAll('s1')
    expect(localStorage.getItem(STORAGE_KEY)).toBe(corruptRaw)
    warnSpy.mockRestore()
  })

  it('[RD-1#2] 损坏 warn 去重：连续多次操作只提示一次，不刷屏', () => {
    localStorage.setItem(STORAGE_KEY, 'NOT-JSON{')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    markUnread('s1')
    markUnread('s2')
    toggleMarkedDone('s3')
    expect(warnSpy).toHaveBeenCalledTimes(2) // 损坏发生 1 次 + 拒绝写 1 次
    warnSpy.mockRestore()
  })

  it('[RD-1#2] storage 事件推送损坏 newValue：内存缓存保留旧值不被清空，后续写被拒', () => {
    markUnread('s1') // 正常 hydrate + 写入
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: 'BROKEN{' }))
    expect(isUnread('s1')).toBe(true) // 旧缓存保留，不被清空

    markUnread('s2') // corrupt 态 → 拒绝写
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toEqual({ s1: { unread: true } })
    warnSpy.mockRestore()
  })

  it('[RD-1#2] 损坏后另一窗口写入合法值（storage 事件）→ 解除保护，写入恢复', () => {
    localStorage.setItem(STORAGE_KEY, 'BROKEN{')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    markUnread('s1') // corrupt → 拒绝
    expect(localStorage.getItem(STORAGE_KEY)).toBe('BROKEN{')

    // 另一窗口修复了该值
    const fixed = JSON.stringify({ s1: { unread: true } })
    localStorage.setItem(STORAGE_KEY, fixed)
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: fixed }))

    markUnread('s2') // 保护解除 → 正常写
    expect(isUnread('s1')).toBe(true)
    expect(isUnread('s2')).toBe(true)
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toEqual({
      s1: { unread: true },
      s2: { unread: true },
    })
    warnSpy.mockRestore()
  })

  // ── 形状守卫（合法 JSON 但结构漂移不进 cache）──

  it('[形状守卫] 顶层非对象 JSON（数组等形状漂移）与解析失败同走 corrupt 通道', () => {
    const arrayRaw = '[{"s1":{"unread":true}}]'
    localStorage.setItem(STORAGE_KEY, arrayRaw)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    markUnread('s2') // hydrate → 顶层形状守卫失败 → corrupt → 拒写
    expect(warnSpy).toHaveBeenCalled()
    expect(localStorage.getItem(STORAGE_KEY)).toBe(arrayRaw) // 原值保留不覆写
    expect(isUnread('s1')).toBe(false) // 错误形状未进 cache

    // 与解析失败同一恢复路径：合法值经 storage 事件写入后解除保护
    const fixed = JSON.stringify({ s1: { unread: true } })
    localStorage.setItem(STORAGE_KEY, fixed)
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: fixed }))
    markUnread('s2')
    expect(isUnread('s2')).toBe(true)
    warnSpy.mockRestore()
  })

  it('[形状守卫] 条目形状漂移被丢弃并 warn-once，合法条目与合法字段照常加载', () => {
    const raw = JSON.stringify({
      s1: { unread: true }, // 合法
      s2: 'junk', // 非对象 → 丢弃
      s3: { unread: 'yes' }, // 字段漂移且无合法字段 → 丢弃
      s4: { unread: 'yes', markedDone: true }, // 部分漂移 → 剔除漂移字段，保留 markedDone
    })
    localStorage.setItem(STORAGE_KEY, raw)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(isUnread('s1')).toBe(true)
    expect(isUnread('s2')).toBe(false)
    expect(isUnread('s3')).toBe(false)
    expect(isMarkedDone('s3')).toBe(false)
    expect(isUnread('s4')).toBe(false)
    expect(isMarkedDone('s4')).toBe(true)
    expect(warnSpy).toHaveBeenCalledTimes(1) // 丢弃只提示一次，不刷屏

    // 丢弃不置 corrupt：写盘正常，坏条目随下次写盘被清理
    markUnread('s5')
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toEqual({
      s1: { unread: true },
      s4: { markedDone: true },
      s5: { unread: true },
    })

    // warn 去重跨读取生效：再次读入含坏条目的值不重复提示
    localStorage.setItem(STORAGE_KEY, raw)
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: raw }))
    expect(warnSpy).toHaveBeenCalledTimes(1)
    warnSpy.mockRestore()
  })
})
