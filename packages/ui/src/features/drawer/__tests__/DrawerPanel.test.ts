/**
 * DrawerPanel 测试（W3 · p3-strangler-domains::drawer，AC9/AC12 冒烟载体）。
 *
 * 三视角：
 * - 使用者（黑盒）：mount DrawerPanel（isOpen:true）断言 5 基础 tab 按钮 + 展开态内容区
 *   在 DOM 中存在；点关闭按钮触发 close emit（父组件消费 → isOpen=false → 收起）
 * - 构建者（白盒）：无内容面板 slot → 空态占位（icon + emptyText/emptyHint）；
 *   内容面板 slot 注入替换（无 fallback 双渲染）
 * - 观察者（形态）：isOpen=false 时 aside 不渲染；5 基础 tab 常驻（[P4 s5 w2] tasks 条件 tab 已随 tasks 域删除）
 *
 * [P4 s5 drawer-widget-removal] widget 三态（gui/lines/空态）+ status footer 用例已删：
 * 旧 extension:widget/widgetGui/status 通道由 PluginViewContainer 承接，DrawerPanel 不再接收
 * widget props，仅保留空态（slot fallback）+ slot 注入替换断言。
 *
 * mock 策略（design-review mockStrategyNote）：零真 store——vitest.setup 已 mock vue-i18n
 * useI18n（t 返回 key，断言 DOM 结构不依赖文案）；slot 注入用 template #default
 * 放 testid 占位 div。
 *
 * 运行：cd packages/ui && npx vitest run src/features/drawer/
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { DrawerPanel } from '../index'
import type { SideDrawerTab } from '@taiji/core/domain/drawer'

/** 展开态基础 props（控制态四字段，widget 数据走默认空 → 空态分支） */
function baseProps<T extends object>(overrides: T = {} as T) {
  return {
    isOpen: true as boolean,
    activeTab: 'terminal' as SideDrawerTab,
    docked: false as boolean,
    sessionId: 's1',
    ...overrides,
  }
}

describe('DrawerPanel (AC9/AC12 首屏冒烟)', () => {
  it('展开态：5 基础 tab 按钮 + 展开态内容区 DOM 存在', () => {
    const wrapper = mount(DrawerPanel, { props: baseProps() })
    for (const key of ['terminal', 'browser', 'git', 'doc', 'detail']) {
      expect(wrapper.find(`[data-testid="drawer-tab-${key}"]`).exists()).toBe(true)
    }
    expect(wrapper.find('[data-testid="drawer-content"]').exists()).toBe(true)
  })

  it('关闭 emit 触发收起：点关闭按钮 → emitted close；isOpen=false 重渲染 → 收起不渲染', async () => {
    const wrapper = mount(DrawerPanel, { props: baseProps() })
    await wrapper.find('[data-testid="drawer-close"]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
    // 父组件消费 close → isOpen 置 false → drawer 收起（观察者视角，fresh mount 断言收起态）
    const collapsed = mount(DrawerPanel, { props: baseProps({ isOpen: false }) })
    expect(collapsed.find('[data-testid="drawer-panel"]').exists()).toBe(false)
  })

  it('收起态：isOpen=false 时 aside 不渲染', () => {
    const wrapper = mount(DrawerPanel, { props: baseProps({ isOpen: false }) })
    expect(wrapper.find('[data-testid="drawer-panel"]').exists()).toBe(false)
  })
})


describe('DrawerPanel (内容区 slot + 空态 fallback)', () => {
  it('均无内容 → 空态占位（icon + emptyText/emptyHint 文案）', () => {
    const wrapper = mount(DrawerPanel, { props: baseProps() })
    expect(wrapper.find('[data-testid="drawer-widget-empty"]').exists()).toBe(true)
    // t mock 返回 key，断言空态文案 slot 存在（DOM 结构不依赖中文）
    expect(wrapper.find('[data-testid="drawer-widget-empty"] p').exists()).toBe(true)
  })

  it('内容面板 slot 注入：slot 内容替换空态（无 fallback 双渲染）', () => {
    const wrapper = mount(DrawerPanel, {
      props: baseProps(),
      slots: { default: '<div data-testid="panel-slot" />' },
    })
    expect(wrapper.find('[data-testid="panel-slot"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="drawer-widget-empty"]').exists()).toBe(false)
  })

  it('无 slot 时空态作为 fallback 渲染', () => {
    const wrapper = mount(DrawerPanel, { props: baseProps() })
    expect(wrapper.find('[data-testid="drawer-widget-empty"]').exists()).toBe(true)
  })
})

describe('DrawerPanel (tab 交互)', () => {
  it('tab 点击 emit set-tab', async () => {
    const wrapper = mount(DrawerPanel, { props: baseProps() })
    await wrapper.find('[data-testid="drawer-tab-browser"]').trigger('click')
    expect(wrapper.emitted('set-tab')).toEqual([['browser']])
  })

  it('钉住按钮 emit toggle-dock', async () => {
    const wrapper = mount(DrawerPanel, { props: baseProps() })
    await wrapper.find('[data-testid="drawer-pin"]').trigger('click')
    expect(wrapper.emitted('toggle-dock')).toHaveLength(1)
  })

  it('activeTab 高亮：当前 tab 应用选中样式（bg-surface-hover）', () => {
    const wrapper = mount(DrawerPanel, { props: baseProps({ activeTab: 'git' }) })
    const gitTab = wrapper.find('[data-testid="drawer-tab-git"]')
    expect(gitTab.classes()).toContain('bg-surface-hover')
  })
})

describe('DrawerPanel (header-extra slot，W4 壳层挂载点)', () => {
  it('有 header-extra slot：header 内渲染注入内容（unread badge 等壳状态）', () => {
    const wrapper = mount(DrawerPanel, {
      props: baseProps(),
      slots: { 'header-extra': '<div data-testid="drawer-unread-badge">2</div>' },
    })
    expect(wrapper.find('[data-testid="drawer-unread-badge"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="drawer-unread-badge"]').text()).toBe('2')
  })

  it('无 header-extra slot：不渲染（向后兼容，存量用例零改动）', () => {
    const wrapper = mount(DrawerPanel, { props: baseProps() })
    expect(wrapper.find('[data-testid="drawer-unread-badge"]').exists()).toBe(false)
  })
})

// bashTask tab（2026-09 background-task-sidebar-view D5②）：tabs 加第 8 个 TabMeta。
// 内容面板由壳层（PanelContainer）slot 注入，本组件只负责 tab 元信息与空态 fallback。
describe('DrawerPanel (bashTask tab，background-task-sidebar-view D5②)', () => {
  it('bashTask tab 按钮 DOM 存在（8 tab 常驻）', () => {
    const wrapper = mount(DrawerPanel, { props: baseProps() })
    expect(wrapper.find('[data-testid="drawer-tab-bashTask"]').exists()).toBe(true)
    // 既有 7 tab 不回退（终端/浏览器/Git/文档/详情/子代理/工作流 + 后台命令）
    for (const key of ['terminal', 'browser', 'git', 'doc', 'detail', 'subagent', 'workflow']) {
      expect(wrapper.find(`[data-testid="drawer-tab-${key}"]`).exists()).toBe(true)
    }
  })

  it('bashTask tab 点击 emit set-tab bashTask', async () => {
    const wrapper = mount(DrawerPanel, { props: baseProps() })
    await wrapper.find('[data-testid="drawer-tab-bashTask"]').trigger('click')
    expect(wrapper.emitted('set-tab')).toEqual([['bashTask']])
  })

  it('activeTab=bashTask：应用选中样式（bg-surface-hover）', () => {
    const wrapper = mount(DrawerPanel, { props: baseProps({ activeTab: 'bashTask' }) })
    expect(wrapper.find('[data-testid="drawer-tab-bashTask"]').classes()).toContain('bg-surface-hover')
  })

  it('bashTask 无内容面板 slot：空态 fallback 渲染 i18n key（t mock 返回 key，断言 key 引用）', () => {
    const wrapper = mount(DrawerPanel, { props: baseProps({ activeTab: 'bashTask' }) })
    const empty = wrapper.find('[data-testid="drawer-widget-empty"]')
    expect(empty.exists()).toBe(true)
    // emptyText/emptyHint 引用 panel.sideDrawer.noBashTask / bashTaskHint（文案由 u-i18n-docs 落地）
    expect(empty.text()).toContain('panel.sideDrawer.noBashTask')
    expect(empty.text()).toContain('panel.sideDrawer.bashTaskHint')
  })
})

// plan tab（plan 模式重设计 u1-drawer-tab）：tabs 加第 9 个 TabMeta（key='plan'，i18n key
// 落 plan 域文件 plan.drawer.*，icon 与 PlanModeBanner 同源 SquareCheckBig）。内容面板由壳层
// （PanelContainer）slot 注入空骨架（PlanDocsPanel 归 u1-docs-panel），本组件只负责 tab 元信息。
describe('DrawerPanel (plan tab，plan 模式重设计 u1-drawer-tab)', () => {
  it('plan tab 按钮 DOM 存在（9 tab 常驻，既有 8 tab 无回归）', () => {
    const wrapper = mount(DrawerPanel, { props: baseProps() })
    expect(wrapper.find('[data-testid="drawer-tab-plan"]').exists()).toBe(true)
    for (const key of ['terminal', 'browser', 'git', 'doc', 'detail', 'subagent', 'workflow', 'bashTask']) {
      expect(wrapper.find(`[data-testid="drawer-tab-${key}"]`).exists()).toBe(true)
    }
  })

  it('plan tab 标题引用 plan 域 i18n key（title 属性 = tab.label）', () => {
    const wrapper = mount(DrawerPanel, { props: baseProps() })
    // ui 包测试环境的 vue-i18n mock 返回 key 本身（DrawerPanel.test 文件头 mock 策略），
    // title 属性断言即「label 引用了 plan.drawer.tabPlan key」
    expect(wrapper.find('[data-testid="drawer-tab-plan"]').attributes('title')).toBe('plan.drawer.tabPlan')
  })

  it('plan tab icon 为 SquareCheckBig（与 PlanModeBanner 同源 icon 体系，svg 在按钮内渲染）', () => {
    const wrapper = mount(DrawerPanel, { props: baseProps() })
    // icon 经 <component :is> 渲染为 svg（lucide 组件根元素），存在性断言注册生效
    expect(wrapper.find('[data-testid="drawer-tab-plan"] svg').exists()).toBe(true)
  })

  it('plan tab 点击 emit set-tab plan', async () => {
    const wrapper = mount(DrawerPanel, { props: baseProps() })
    await wrapper.find('[data-testid="drawer-tab-plan"]').trigger('click')
    expect(wrapper.emitted('set-tab')).toEqual([['plan']])
  })

  it('activeTab=plan：应用选中样式（bg-surface-hover）', () => {
    const wrapper = mount(DrawerPanel, { props: baseProps({ activeTab: 'plan' }) })
    expect(wrapper.find('[data-testid="drawer-tab-plan"]').classes()).toContain('bg-surface-hover')
  })

  it('plan 无内容面板 slot：空态 fallback 渲染 plan 域 i18n key（t mock 返回 key，断言 key 引用）', () => {
    const wrapper = mount(DrawerPanel, { props: baseProps({ activeTab: 'plan' }) })
    const empty = wrapper.find('[data-testid="drawer-widget-empty"]')
    expect(empty.exists()).toBe(true)
    // emptyText/emptyHint 引用 plan.drawer.noPlan / planHint（文案由 u1-docs-panel 阶段消费）
    expect(empty.text()).toContain('plan.drawer.noPlan')
    expect(empty.text()).toContain('plan.drawer.planHint')
  })
})
