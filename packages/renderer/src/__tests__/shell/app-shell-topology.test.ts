/**
 * AppShell 拓扑渲染 gate（review MF-5）：D-6 拓扑回填的回归防线。
 *
 * 覆盖（ui-replica M2：demo Workbench.vue .app 为窗口 frame 视觉权威）：
 *  - 三个拓扑 testid 存在：app-shell / app-shell-aside / app-shell-main
 *  - 关键类：AppShell py-1 pr-1（demo .app padding 4px 4px 4px 0：上/右/下 4、左 0 透明融合）、
 *    gap-1（2026-10-11 用户裁决：侧栏-main 缝 4px，与窗口右缘 pr-1 同节奏）、aside pt-11（44px traffic-light 安全区，恒定）、
 *    MainPanel 为透明布局容器（三卡化 2026-10-04：float-panel 壳下沉到三块内容卡）
 *  - 折叠态 !gap-0（强制覆盖 gap-2），展开态无
 *  - TrafficLight 挂载在 AsideRegion 内（ui-replica M2：AppShell 左边距 0 后 aside 左缘 = 窗口 x0，
 *    left-2/top-[12px] = 窗口 (8,16)，x/y 与 mac trafficLightPosition {8,16} 完全同位）
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
  // 折叠态持久化跨测试隔离：上一用例写入的折叠态不得泄漏进下一用例的 store 初始化
  localStorage.removeItem('taiji:side-collapsed')
})

describe('AppShell 拓扑渲染 gate（刻意调整形态回归防线）', () => {
  it('展开态：三个拓扑 testid 存在 + 关键类（py-1 pr-1 / gap-1 / aside pt-11 / main 透明布局容器）', () => {
    const wrapper = mount(AppShell)

    // ① app-shell 根容器：demo .app padding 4px 4px 4px 0（py-1 pr-1，左 0 侧栏透明融合贴边）+ relative 定位基准
    const shell = wrapper.find('[data-testid="app-shell"]')
    expect(shell.exists()).toBe(true)
    expect(shell.classes()).toContain('py-1')
    expect(shell.classes()).toContain('pr-1')
    expect(shell.classes()).toContain('gap-1')
    expect(shell.classes()).toContain('relative')

    // ② aside：pt-11(44px) traffic-light 安全区恒定
    const aside = wrapper.find('[data-testid="app-shell-aside"]')
    expect(aside.exists()).toBe(true)
    expect(aside.classes()).toContain('pt-11')

    // ③ main 布局容器：三卡化后壳样式（rounded/border/bg）下沉到内容卡，本体透明
    const main = wrapper.find('[data-testid="app-shell-main"]')
    expect(main.exists()).toBe(true)
    expect(main.classes()).not.toContain('rounded-[10px]')
    expect(main.classes()).not.toContain('border')
    expect(main.classes()).not.toContain('bg-surface')

    // 展开态无 !gap-0（gap-1 生效）
    expect(shell.classes()).not.toContain('!gap-0')
  })

  it('折叠态：AppShell 根容器加 !gap-0（强制覆盖 gap-2，aside 归零）', async () => {
    const sidebar = useSidebarStore()
    const wrapper = mount(AppShell)
    expect(wrapper.find('[data-testid="app-shell"]').classes()).not.toContain('!gap-0')

    sidebar.userCollapsed = true
    await nextTick()
    expect(wrapper.find('[data-testid="app-shell"]').classes()).toContain('!gap-0')
  })

  it('TrafficLight 挂载在 AsideRegion 内：left-2/top-[12px] 相对 aside 左缘 x0/顶 y4 = 窗口 (8,16)，x/y 与 mac 同位（ui-replica M2）', () => {
    const wrapper = mount(AppShell)

    // traffic-light 在 aside 内（aside 左缘 x0 后 left-2 → 窗口 x8 = mac trafficLightPosition.x）
    const tl = wrapper.find('.traffic-light')
    expect(tl.exists()).toBe(true)
    expect(tl.classes()).toContain('left-2')
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

      // 既有拓扑在非 mac 态不回归：py-1 pr-1 / aside pt-11 恒定
      expect(shell.classes()).toContain('py-1')
      expect(shell.classes()).toContain('pr-1')
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
