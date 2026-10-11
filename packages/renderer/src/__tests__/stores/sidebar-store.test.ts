/**
 * sidebar store 单测：折叠态两事实源合成 + 持久化（demo shell spec §3.6/§3.8 tj:sideCollapsed 同语义）。
 *
 * 覆盖：
 * - 默认展开（无持久化值）
 * - toggleCollapsed（用户意图）→ localStorage 写入（key = taiji:side-collapsed）
 * - 重新创建 store（模拟刷新）→ 恢复持久化用户意图
 * - localStorage 写入抛错（隐私模式）→ 不崩、状态照常翻转
 * - 持久化值损坏 → 静默回落展开态
 * - collapsed = userCollapsed || viewportNarrow 只读合成：视口强制独立生效、不落盘
 * - 窄窗强制态下 toggle 写意图位不写最终态（放宽后弹回/保持由派生裁决）
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

import { useSidebarStore } from '@/stores/sidebar'

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.removeItem('taiji:side-collapsed')
})

describe('sidebar store 折叠态持久化（用户意图位）', () => {
  it('无持久化值 → 默认展开', () => {
    expect(useSidebarStore().collapsed).toBe(false)
  })

  it('toggleCollapsed → localStorage 写入新折叠态（watch pre-flush，nextTick 后落盘）', async () => {
    const sidebar = useSidebarStore()
    sidebar.toggleCollapsed()
    await nextTick()
    expect(sidebar.collapsed).toBe(true)
    expect(sidebar.userCollapsed).toBe(true)
    expect(localStorage.getItem('taiji:side-collapsed')).toBe('true')

    sidebar.toggleCollapsed()
    await nextTick()
    expect(sidebar.collapsed).toBe(false)
    expect(sidebar.userCollapsed).toBe(false)
    expect(localStorage.getItem('taiji:side-collapsed')).toBe('false')
  })

  it('刷新（重新创建 store）→ 恢复持久化折叠态', async () => {
    useSidebarStore().toggleCollapsed()
    await nextTick()

    setActivePinia(createPinia())
    expect(useSidebarStore().collapsed).toBe(true)
    expect(useSidebarStore().userCollapsed).toBe(true)
  })

  it('localStorage 写入抛错（隐私模式）→ 不崩、状态照常翻转', async () => {
    const setItem = localStorage.setItem
    localStorage.setItem = () => {
      throw new Error('quota exceeded')
    }
    try {
      const sidebar = useSidebarStore()
      sidebar.toggleCollapsed()
      await nextTick()
      expect(sidebar.collapsed).toBe(true)
    } finally {
      localStorage.setItem = setItem
    }
  })

  it('持久化值损坏（非布尔字面量）→ 静默回落展开态', () => {
    localStorage.setItem('taiji:side-collapsed', '{{{corrupt')
    setActivePinia(createPinia())
    expect(useSidebarStore().collapsed).toBe(false)
  })
})

describe('sidebar store 两事实源合成（userCollapsed || viewportNarrow）', () => {
  it('视口强制独立生效：userCollapsed=false + viewportNarrow=true → 折叠，且不落盘', async () => {
    const sidebar = useSidebarStore()
    sidebar.viewportNarrow = true
    expect(sidebar.collapsed).toBe(true)
    await nextTick()
    expect(localStorage.getItem('taiji:side-collapsed')).toBe(null)
  })

  it('窄窗强制态下 toggle → 意图=展开，仍折叠；意图无变化不写盘；强制解除后弹回', async () => {
    const sidebar = useSidebarStore()
    sidebar.viewportNarrow = true
    sidebar.toggleCollapsed()
    await nextTick()

    expect(sidebar.userCollapsed).toBe(false)
    expect(sidebar.collapsed).toBe(true)
    // 意图位无实际变化（false→false）不触发持久化：盘上无值与读侧回落 false 一致
    expect(localStorage.getItem('taiji:side-collapsed')).toBe(null)

    sidebar.viewportNarrow = false
    expect(sidebar.collapsed).toBe(false)
  })

  it('窄窗强制态下重复 toggle → 意图位保持展开（按钮可见形态恒为展开语义）；强制解除后弹回', async () => {
    const sidebar = useSidebarStore()
    sidebar.viewportNarrow = true
    sidebar.toggleCollapsed()
    sidebar.toggleCollapsed()
    await nextTick()

    // 窄窗强制收起态下按钮图标恒为「展开」，每次点击都在表达展开意图
    expect(sidebar.userCollapsed).toBe(false)
    sidebar.viewportNarrow = false
    expect(sidebar.collapsed).toBe(false)
  })

  it('viewportNarrow 不持久化：强制收起后重建 store（模拟刷新）不恢复视口位', async () => {
    const sidebar = useSidebarStore()
    sidebar.viewportNarrow = true
    await nextTick()

    setActivePinia(createPinia())
    const fresh = useSidebarStore()
    expect(fresh.viewportNarrow).toBe(false)
    expect(fresh.collapsed).toBe(false)
  })
})
