/**
 * useNarrowWindowCollapse + sidebar store 折叠合成单测（demo shell spec §3.6 窄窗自动折叠）。
 *
 * 折叠 = 用户意图（userCollapsed，toggle 写、持久化）|| 视口强制（viewportNarrow，本 composable 写、
 * 不持久化）的纯派生，无任何时间补偿。本文件只守护 composable 自身契约（matchMedia 接线层）：
 * - 首屏即窄窗（matches=true）→ 挂载即折叠
 * - 宽窗进入断点 → 折叠；放宽（无用户意图）→ 自动弹回（修复点：视口驱动的临时形态）
 * - 宽窗手动收起 → 缩窗 → 放宽 → 保持收起（用户显式意图优先于视口恢复）
 * - 卸载摘除 matchMedia listener；matchMedia 缺失环境静默跳过
 * toggle 语义与持久化纪律（窄窗强制态 toggle、幂等、落盘）归属 sidebar-store.test.ts（实现在 store）。
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

describe('useNarrowWindowCollapse（demo shell spec §3.6，两事实源合成）', () => {
  it('首屏即窄窗（matches=true）→ 挂载即折叠（视口强制位生效）', () => {
    installFakeMatchMedia(true)
    const wrapper = mountHost()
    const sidebar = useSidebarStore()
    expect(sidebar.viewportNarrow).toBe(true)
    expect(sidebar.collapsed).toBe(true)
    expect(sidebar.userCollapsed).toBe(false)
    wrapper.unmount()
  })

  it('宽窗进入断点 → 折叠；放宽（无用户意图）→ 自动弹回', () => {
    const mql = installFakeMatchMedia(false)
    const wrapper = mountHost()
    const sidebar = useSidebarStore()
    expect(sidebar.collapsed).toBe(false)

    mql.dispatch(true)
    expect(sidebar.viewportNarrow).toBe(true)
    expect(sidebar.collapsed).toBe(true)

    mql.dispatch(false)
    expect(sidebar.viewportNarrow).toBe(false)
    expect(sidebar.collapsed).toBe(false)
    wrapper.unmount()
  })

  it('宽窗手动收起（用户显式意图）→ 缩窗 → 放宽 → 保持收起', () => {
    const mql = installFakeMatchMedia(false)
    const wrapper = mountHost()
    const sidebar = useSidebarStore()

    sidebar.toggleCollapsed()
    expect(sidebar.collapsed).toBe(true)

    mql.dispatch(true)
    expect(sidebar.collapsed).toBe(true)

    mql.dispatch(false)
    expect(sidebar.viewportNarrow).toBe(false)
    expect(sidebar.userCollapsed).toBe(true)
    expect(sidebar.collapsed).toBe(true)
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

  it('matchMedia 缺失（老环境）→ 静默跳过，视口位保持 false', () => {
    vi.stubGlobal('matchMedia', undefined)
    const wrapper = mountHost()
    const sidebar = useSidebarStore()
    expect(sidebar.viewportNarrow).toBe(false)
    expect(sidebar.collapsed).toBe(false)
    wrapper.unmount()
  })
})
