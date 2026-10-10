/**
 * useNarrowWindowCollapse 单测（demo shell spec §3.6 窄窗自动折叠）。
 *
 * 覆盖：
 * - 首屏即窄窗（matches=true）→ 挂载即折叠
 * - 进入断点（change → matches=true）→ 折叠
 * - 离开断点（change → matches=false）→ 不强制展开（尊重手动选择）
 * - 卸载摘除 matchMedia listener（重挂不残留）
 * - matchMedia 缺失环境静默跳过（不抛错、不改状态）
 *
 * matchMedia 用可控假 MQL stub（jsdom/happy-dom 的 MQL 无法在测试中手动派发 change）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'

import { useNarrowWindowCollapse } from '@/composables/shell/useNarrowWindowCollapse'
import { useSidebarStore } from '@/stores/sidebar'

/** 可控假 MQL：matches 可写 + 手动派发 change（事件对象含 matches 字段） */
interface FakeMql { // oe-exempt:20261011:test:matchMedia 测试替身类型（jsdom 无 MQL 实装），单实现即终态非等待变体
  matches: boolean
  listeners: Array<(e: { matches: boolean }) => void>
  addEventListener(type: string, fn: (e: { matches: boolean }) => void): void
  removeEventListener(type: string, fn: (e: { matches: boolean }) => void): void
  dispatch(matches: boolean): void
}

function installFakeMatchMedia(initialMatches: boolean): FakeMql {
  const mql: FakeMql = {
    matches: initialMatches,
    listeners: [],
    addEventListener(_type, fn) {
      this.listeners.push(fn)
    },
    removeEventListener(_type, fn) {
      const i = this.listeners.indexOf(fn)
      if (i >= 0) this.listeners.splice(i, 1)
    },
    dispatch(matches) {
      this.matches = matches
      this.listeners.forEach((fn) => fn({ matches }))
    },
  }
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue(mql as unknown as MediaQueryList),
  )
  return mql
}

/** 挂载宿主组件（composable 需组件实例上下文） */
function mountHost() {
  const Host = defineComponent({
    setup() {
      useNarrowWindowCollapse()
      return () => h('div')
    },
  })
  return mount(Host)
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.unstubAllGlobals()
  localStorage.removeItem('taiji:side-collapsed')
})

describe('useNarrowWindowCollapse（demo shell spec §3.6）', () => {
  it('首屏即窄窗（matches=true）→ 挂载即折叠', () => {
    installFakeMatchMedia(true)
    const wrapper = mountHost()
    expect(useSidebarStore().collapsed).toBe(true)
    wrapper.unmount()
  })

  it('首屏宽窗 → 保持展开；进入断点（change matches=true）→ 折叠', () => {
    const mql = installFakeMatchMedia(false)
    const wrapper = mountHost()
    expect(useSidebarStore().collapsed).toBe(false)

    mql.dispatch(true)
    expect(useSidebarStore().collapsed).toBe(true)
    wrapper.unmount()
  })

  it('离开断点（change matches=false）→ 不强制展开（尊重手动选择）', () => {
    const mql = installFakeMatchMedia(true)
    const sidebar = useSidebarStore()
    const wrapper = mountHost()
    expect(sidebar.collapsed).toBe(true)

    // 用户在窄窗手动展开，随后窗口放大：不回弹折叠态
    sidebar.collapsed = false
    mql.dispatch(false)
    expect(sidebar.collapsed).toBe(false)
    wrapper.unmount()
  })

  it('卸载摘除 matchMedia listener（重挂不残留双监听）', () => {
    const mql = installFakeMatchMedia(false)
    const wrapper = mountHost()
    expect(mql.listeners.length).toBe(1)

    wrapper.unmount()
    expect(mql.listeners.length).toBe(0)

    // 卸载后派发 change 不再触达 store
    mql.dispatch(true)
    expect(useSidebarStore().collapsed).toBe(false)
  })

  it('matchMedia 缺失（老环境）→ 静默跳过，不改折叠态', () => {
    vi.stubGlobal('matchMedia', undefined)
    const wrapper = mountHost()
    expect(useSidebarStore().collapsed).toBe(false)
    wrapper.unmount()
  })
})
