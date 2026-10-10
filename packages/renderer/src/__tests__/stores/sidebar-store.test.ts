/**
 * sidebar store 单测：折叠态持久化（demo shell spec §3.6/§3.8 tj:sideCollapsed 同语义）。
 *
 * 覆盖：
 * - 默认展开（无持久化值）
 * - 切换折叠 → localStorage 写入（key = taiji:side-collapsed）
 * - 重新创建 store（模拟刷新）→ 恢复持久化折叠态
 * - localStorage 写入抛错（隐私模式）→ 不崩、状态照常翻转
 * - 持久化值损坏 → 静默回落展开态
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

import { useSidebarStore } from '@/stores/sidebar'

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.removeItem('taiji:side-collapsed')
})

describe('sidebar store 折叠态持久化', () => {
  it('无持久化值 → 默认展开', () => {
    expect(useSidebarStore().collapsed).toBe(false)
  })

  it('toggleCollapsed → localStorage 写入新折叠态（watch pre-flush，nextTick 后落盘）', async () => {
    const sidebar = useSidebarStore()
    sidebar.toggleCollapsed()
    await nextTick()
    expect(sidebar.collapsed).toBe(true)
    expect(localStorage.getItem('taiji:side-collapsed')).toBe('true')

    sidebar.toggleCollapsed()
    await nextTick()
    expect(sidebar.collapsed).toBe(false)
    expect(localStorage.getItem('taiji:side-collapsed')).toBe('false')
  })

  it('刷新（重新创建 store）→ 恢复持久化折叠态', async () => {
    useSidebarStore().toggleCollapsed()
    await nextTick()

    setActivePinia(createPinia())
    expect(useSidebarStore().collapsed).toBe(true)
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
