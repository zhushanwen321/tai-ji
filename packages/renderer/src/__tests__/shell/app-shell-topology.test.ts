/**
 * AppShell 拓扑渲染 gate（review MF-5）：D-6 拓扑回填的回归防线。
 *
 * 覆盖（v6-spec-shell SSOT）：
 *  - 三个拓扑 testid 存在：app-shell / app-shell-aside / app-shell-main
 *  - 关键类：AppShell p-1（4px 四周统一）、aside pt-11（44px traffic-light 安全区，恒定）、
 *    MainPanel rounded-[10px]（float-panel 圆角与窗口共线）
 *  - 折叠态 !gap-0（强制覆盖 gap-3），展开态无
 *  - TrafficLight 挂载在 AsideRegion 内（2026-08 二次裁决：恢复刻意调整形态——trafficLightPosition {8,8}、
 *    aside 顶 y=4，left-0/top-4 = 窗口 (4,8)：y8 与 mac 同位；x4 与 mac x8 有 4px 预期差（§11:883））
 *  - 平台两态成对（跨平台窗口外壳 u-shell-chrome）：非 mac 根节点无 rounded-[10px]（修复证明面：方形窗口下
 *    应用内圆角只会产生四角色差方块）+ 渲染 aside-drag-strip 拖拽条带；mac 根节点保留 rounded-[10px]
 *    （零变化面）+ 不渲染条带（mac 拖拽由系统提供）
 *
 * Mock 策略（沿用 sidebar-layout / session-status-icons 既有模式，避免全局副作用）：
 *  - useSettingsShell 置空（AppShell 壳副作用，非拓扑被测面）
 *  - SettingsModal / Workspace / Sidebar stub（重组件依赖树，非拓扑被测面）
 *  - useSidebar stub（AppShell 仅消费 syncSessionToPanel）
 *  - 其余（AsideRegion / AppNavControls / TrafficLight / MainPanel + stores）走真实实现
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/shell/app-shell-topology.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { platformChromeMock, expectFullscreenChromePairing } from '@/__tests__/helpers/platform-chrome-mock'

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

/** usePlatformChrome mock：共享态在 helpers/platform-chrome-mock（isFullscreen 换装真 ref + detectPlatform 可切换；
 *  TrafficLight.test.ts 同范式）。本文件默认平台 mac（jsdom 下真实模块也回退 'mac'，行为一致）。 */
vi.mock('@/composables/effects/usePlatformChrome', async () => {
  const { installPlatformChromeMock } = await import('@/__tests__/helpers/platform-chrome-mock')
  return installPlatformChromeMock('mac')
})

import AppShell from '@/components/shell/AppShell.vue'
import { useSidebarStore } from '@/stores/sidebar'

beforeEach(() => {
  setActivePinia(createPinia())
  platformChromeMock.isFullscreen.value = false
  platformChromeMock.detectPlatform.mockReturnValue('mac')
})

describe('AppShell 拓扑渲染 gate（刻意调整形态回归防线）', () => {
  it('展开态：三个拓扑 testid 存在 + 关键类（p-1 / aside pt-11 / main rounded-[10px]）', () => {
    const wrapper = mount(AppShell)

    // ① app-shell 根容器：p-1(4px) 四周统一 + relative 定位基准
    const shell = wrapper.find('[data-testid="app-shell"]')
    expect(shell.exists()).toBe(true)
    expect(shell.classes()).toContain('p-1')
    expect(shell.classes()).toContain('relative')

    // ② aside：pt-11(44px) traffic-light 安全区恒定
    const aside = wrapper.find('[data-testid="app-shell-aside"]')
    expect(aside.exists()).toBe(true)
    expect(aside.classes()).toContain('pt-11')

    // ③ main float-panel：rounded-[10px]（与窗口圆角共线）
    const main = wrapper.find('[data-testid="app-shell-main"]')
    expect(main.exists()).toBe(true)
    expect(main.classes()).toContain('rounded-[10px]')

    // 展开态无 !gap-0（gap-3 生效）
    expect(shell.classes()).not.toContain('!gap-0')
  })

  it('折叠态：AppShell 根容器加 !gap-0（强制覆盖 gap-3，aside 归零）', async () => {
    const sidebar = useSidebarStore()
    const wrapper = mount(AppShell)
    expect(wrapper.find('[data-testid="app-shell"]').classes()).not.toContain('!gap-0')

    sidebar.collapsed = true
    await nextTick()
    expect(wrapper.find('[data-testid="app-shell"]').classes()).toContain('!gap-0')
  })

  it('TrafficLight 挂载在 AsideRegion 内：left-0/top-4 相对 aside 顶 y=4 = 窗口 (4,8)，y8 与 mac 同位；x4 与 mac x8 有 4px 预期差（§11:883）', () => {
    const wrapper = mount(AppShell)

    // traffic-light 在 aside 内（刻意调整形态：aside 是 offset parent，left-0/top-4 → 窗口 (4,8)）
    const tl = wrapper.find('.traffic-light')
    expect(tl.exists()).toBe(true)
    expect(tl.element.parentElement).toBe(
      wrapper.find('[data-testid="app-shell-aside"]').element,
    )
  })

  it('TrafficLight 全屏态 opacity-0 + pointer-events-none 成对（review MF-1）', async () => {
    const wrapper = mount(AppShell)
    expect(wrapper.find('.traffic-light').exists()).toBe(true)
    await expectFullscreenChromePairing(wrapper.find('.traffic-light'), async (v) => {
      platformChromeMock.isFullscreen.value = v
      await nextTick()
    })
  })
})

describe('AppShell 平台两态成对（跨平台窗口外壳 u-shell-chrome）', () => {
  it.each(['win', 'linux'] as const)(
    '%s 态：根节点无 rounded-[10px]（修复证明面）+ 渲染 aside-drag-strip 拖拽条带',
    (platform) => {
      platformChromeMock.detectPlatform.mockReturnValue(platform)
      const wrapper = mount(AppShell)

      // 修复证明面：win/linux 是不透明方形窗口，应用内圆角只会产生四角色差小方块——
      // DOM 上必须无 rounded-[10px] 类（类绑定分支，设计 §6.2）
      const shell = wrapper.find('[data-testid="app-shell"]')
      expect(shell.classes()).not.toContain('rounded-[10px]')

      // 拖拽条带仅非 mac 渲染：44px（h-11）drag 面（设计 §6.3）
      const strip = wrapper.find('[data-testid="aside-drag-strip"]')
      expect(strip.exists()).toBe(true)
      expect(strip.classes()).toContain('h-11')
      expect(strip.classes()).toContain('[-webkit-app-region:drag]')

      // 既有拓扑在非 mac 态不回归：p-1 / aside pt-11 恒定
      expect(shell.classes()).toContain('p-1')
      expect(wrapper.find('[data-testid="app-shell-aside"]').classes()).toContain('pt-11')
    },
  )

  it('mac 态：根节点保留 rounded-[10px]（零变化面）+ 不渲染 aside-drag-strip', () => {
    platformChromeMock.detectPlatform.mockReturnValue('mac')
    const wrapper = mount(AppShell)

    const shell = wrapper.find('[data-testid="app-shell"]')
    expect(shell.classes()).toContain('rounded-[10px]')
    // mac 顶部拖拽由系统提供，条带 v-if 不渲染（A6 mac 回归剧本断言面）
    expect(wrapper.find('[data-testid="aside-drag-strip"]').exists()).toBe(false)
  })
})
