/**
 * useNarrowWindowCollapse + sidebar store 折叠合成单测（demo shell spec §3.6 窄窗自动折叠）。
 *
 * 折叠 = 用户意图（userCollapsed，toggle 写、持久化）|| 视口强制（viewportNarrow，本 composable 写、
 * 不持久化）的纯派生，无任何时间补偿。行为矩阵：
 * - 首屏即窄窗（matches=true）→ 挂载即折叠
 * - 宽窗进入断点 → 折叠；放宽（无用户意图）→ 自动弹回（修复点：视口驱动的临时形态）
 * - 窄窗强制收起态下点 toggle → 意图=展开、仍收起（视口强制）；放宽 → 弹回
 * - 窄窗下 toggle 两次（意图回到收起）→ 放宽 → 保持收起
 * - 宽窗手动收起 → 缩窗 → 放宽 → 保持收起（用户显式意图优先于视口恢复）
 * - 窄窗自动收起不落盘（视口态不污染用户偏好持久化）
 * - 卸载摘除 matchMedia listener；matchMedia 缺失环境静默跳过
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

  it('窄窗强制收起态下点 toggle（意图=展开）→ 仍收起（视口强制）；放宽 → 弹回', () => {
    const mql = installFakeMatchMedia(true)
    const wrapper = mountHost()
    const sidebar = useSidebarStore()
    expect(sidebar.collapsed).toBe(true)

    // 用户在窄窗点展开钮：意图位=false，但视口强制收起，可见形态不变
    sidebar.toggleCollapsed()
    expect(sidebar.userCollapsed).toBe(false)
    expect(sidebar.collapsed).toBe(true)

    mql.dispatch(false)
    expect(sidebar.collapsed).toBe(false)
    wrapper.unmount()
  })

  it('窄窗强制态下重复 toggle → 意图位保持展开（按钮可见形态恒为展开语义）；放宽 → 弹回', () => {
    const mql = installFakeMatchMedia(true)
    const wrapper = mountHost()
    const sidebar = useSidebarStore()

    // 窄窗强制收起态下按钮图标恒为「展开」，每次点击都在表达展开意图，意图位不翻转回收起
    sidebar.toggleCollapsed()
    sidebar.toggleCollapsed()
    expect(sidebar.userCollapsed).toBe(false)
    expect(sidebar.collapsed).toBe(true)

    mql.dispatch(false)
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

  it('窄窗自动收起不落盘（视口态不污染用户偏好持久化）；意图位实际变化才落盘', async () => {
    const { nextTick } = await import('vue')
    const mql = installFakeMatchMedia(false)
    const wrapper = mountHost()

    mql.dispatch(true)
    await nextTick()
    expect(localStorage.getItem('taiji:side-collapsed')).toBe(null)

    // 放宽后用户点收起钮 → 意图位实际变化（false→true）→ 落盘
    mql.dispatch(false)
    useSidebarStore().toggleCollapsed()
    await nextTick()
    expect(localStorage.getItem('taiji:side-collapsed')).toBe('true')
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
