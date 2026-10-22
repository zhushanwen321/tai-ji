/**
 * SidebarResizeHandle 行为测试：侧栏宽度拖拽 / 键盘微调 / clamp / 持久化 / 恢复。
 *
 * 覆盖（用户可见 DOM 断言为主）：
 *  - 默认宽度：aside flexBasis = 282px（store 默认值）
 *  - 拖动跟手：pointerdown + pointermove → aside flexBasis 实时更新为指针 x
 *  - clamp：拖过头（<200 / >480）收在边界值
 *  - 持久化时点：拖动中不写 localStorage，pointerup 落盘
 *  - 键盘微调：ArrowRight/ArrowLeft ±16px，越界 clamp，立即持久化
 *  - 恢复：预置 localStorage 宽度 → aside flexBasis 取持久值
 *  - separator 语义：role/aria-orientation/aria-valuenow 随宽联动
 *
 * Mock 策略与 app-shell-topology.test.ts 同款（挂 AppShell 走真实 handle + aside + store；
 * 重组件 stub）。jsdom 无布局：拖动换算 = clientX（aside 贴窗口 x0），无 rect 依赖，天然可测。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/shell/sidebar-resize-handle.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { platformChromeMock } from '@/__tests__/helpers/platform-chrome-mock'

vi.mock('@/composables/shell/useSettingsShell', () => ({
  useSettingsShell: () => {},
}))
vi.mock('@/components/settings/SettingsModal.vue', () => ({
  default: { name: 'SettingsModal', template: '<div data-testid="settings-modal-stub" />' },
}))
vi.mock('@/components/workspace/Workspace.vue', () => ({
  default: { name: 'Workspace', template: '<div />' },
}))
vi.mock('@/components/sidebar/Sidebar.vue', () => ({
  default: { name: 'Sidebar', template: '<div data-testid="sidebar-stub" />' },
}))
vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => ({ syncSessionToPanel: vi.fn() }),
}))
vi.mock('@/composables/effects/usePlatformChrome', async () => {
  const { installPlatformChromeMock } = await import('@/__tests__/helpers/platform-chrome-mock')
  return installPlatformChromeMock('mac')
})

import AppShell from '@/components/shell/AppShell.vue'
import { SIDE_WIDTH_MIN_PX, SIDE_WIDTH_MAX_PX } from '@/stores/sidebar'

/** aside flexBasis 当前值（拖动宽度的用户可见 DOM 形态） */
function asideBasis(wrapper: ReturnType<typeof mount>): string {
  const style = wrapper.find('[data-testid="app-shell-aside"]').attributes('style') ?? ''
  return /flex-basis:\s*([^;]+)/.exec(style)?.[1]?.trim() ?? ''
}

beforeEach(() => {
  setActivePinia(createPinia())
  platformChromeMock.isFullscreen.value = false
  platformChromeMock.detectPlatform.mockReturnValue('mac')
  localStorage.removeItem('taiji:side-collapsed')
  localStorage.removeItem('taiji:side-width')
})

describe('SidebarResizeHandle 侧栏宽度拖拽', () => {
  it('默认宽度 282px：aside flexBasis 初始取 store 默认值', () => {
    const wrapper = mount(AppShell)
    expect(asideBasis(wrapper)).toBe('282px')
  })

  it('拖动跟手：pointermove 实时更新 aside flexBasis，拖动中不写 localStorage', async () => {
    const wrapper = mount(AppShell)
    const handle = wrapper.find('[data-testid="sidebar-resize-handle"]')

    await handle.trigger('pointerdown', { pointerId: 1 })
    await handle.trigger('pointermove', { pointerId: 1, clientX: 360 })
    expect(asideBasis(wrapper)).toBe('360px')
    // 持久化时点 = 拖动结束：拖动中不落盘（对齐 drawer handle 范式）
    expect(localStorage.getItem('taiji:side-width')).toBeNull()

    await handle.trigger('pointermove', { pointerId: 1, clientX: 320 })
    expect(asideBasis(wrapper)).toBe('320px')
    expect(localStorage.getItem('taiji:side-width')).toBeNull()
  })

  it('拖动 clamp：指针越界（<200 / >480）收在边界值', async () => {
    const wrapper = mount(AppShell)
    const handle = wrapper.find('[data-testid="sidebar-resize-handle"]')

    await handle.trigger('pointerdown', { pointerId: 1 })
    await handle.trigger('pointermove', { pointerId: 1, clientX: 9999 })
    expect(asideBasis(wrapper)).toBe(`${SIDE_WIDTH_MAX_PX}px`)

    await handle.trigger('pointermove', { pointerId: 1, clientX: 10 })
    expect(asideBasis(wrapper)).toBe(`${SIDE_WIDTH_MIN_PX}px`)

    await handle.trigger('pointerup', { pointerId: 1 })
    expect(localStorage.getItem('taiji:side-width')).toBe(String(SIDE_WIDTH_MIN_PX))
  })

  it('pointerup 持久化最后一次拖动值；松开后 move 不再改宽', async () => {
    const wrapper = mount(AppShell)
    const handle = wrapper.find('[data-testid="sidebar-resize-handle"]')

    await handle.trigger('pointerdown', { pointerId: 1 })
    await handle.trigger('pointermove', { pointerId: 1, clientX: 300 })
    await handle.trigger('pointerup', { pointerId: 1 })
    expect(localStorage.getItem('taiji:side-width')).toBe('300')

    await handle.trigger('pointermove', { pointerId: 1, clientX: 420 })
    expect(asideBasis(wrapper)).toBe('300px')
  })

  it('键盘微调：ArrowRight/ArrowLeft ±16px 立即持久化，越界 clamp；非方向键不动', async () => {
    const wrapper = mount(AppShell)
    const handle = wrapper.find('[data-testid="sidebar-resize-handle"]')

    await handle.trigger('keydown', { key: 'ArrowRight' })
    expect(asideBasis(wrapper)).toBe('298px')
    expect(localStorage.getItem('taiji:side-width')).toBe('298')

    await handle.trigger('keydown', { key: 'ArrowLeft' })
    expect(asideBasis(wrapper)).toBe('282px')

    // 越界 clamp：连续变窄压到下限
    for (let i = 0; i < 10; i++) await handle.trigger('keydown', { key: 'ArrowLeft' })
    expect(asideBasis(wrapper)).toBe(`${SIDE_WIDTH_MIN_PX}px`)
    expect(localStorage.getItem('taiji:side-width')).toBe(String(SIDE_WIDTH_MIN_PX))

    // 非方向键不写状态
    await handle.trigger('keydown', { key: 'Enter' })
    expect(asideBasis(wrapper)).toBe(`${SIDE_WIDTH_MIN_PX}px`)
  })

  it('恢复：预置合法持久化宽度 → aside flexBasis 取持久值', () => {
    localStorage.setItem('taiji:side-width', '400')
    const wrapper = mount(AppShell)
    expect(asideBasis(wrapper)).toBe('400px')
  })

  it('恢复：越界持久值 clamp 后采信', () => {
    localStorage.setItem('taiji:side-width', '9999')
    const wrapper = mount(AppShell)
    expect(asideBasis(wrapper)).toBe(`${SIDE_WIDTH_MAX_PX}px`)
  })

  it('恢复：非数字持久值回落默认 282', () => {
    localStorage.setItem('taiji:side-width', 'not-a-number')
    const wrapper = mount(AppShell)
    expect(asideBasis(wrapper)).toBe('282px')
  })

  it('separator 语义：aria 边界常量 + aria-valuenow 随宽联动', async () => {
    const wrapper = mount(AppShell)
    const handle = wrapper.find('[data-testid="sidebar-resize-handle"]')
    expect(handle.attributes('aria-orientation')).toBe('vertical')
    expect(handle.attributes('aria-valuemin')).toBe(String(SIDE_WIDTH_MIN_PX))
    expect(handle.attributes('aria-valuemax')).toBe(String(SIDE_WIDTH_MAX_PX))
    expect(handle.attributes('aria-valuenow')).toBe('282')

    await handle.trigger('pointerdown', { pointerId: 1 })
    await handle.trigger('pointermove', { pointerId: 1, clientX: 350 })
    await nextTick()
    expect(handle.attributes('aria-valuenow')).toBe('350')
  })
})
