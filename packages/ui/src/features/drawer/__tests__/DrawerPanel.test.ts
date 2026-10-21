/**
 * DrawerPanel 测试（W3 · p3-strangler-domains::drawer，AC9/AC12 冒烟载体）。
 *
 * 三视角：
 * - 使用者（黑盒）：mount DrawerPanel（isOpen:true）断言注册表派生视图的 8 个 L1 tab 按钮 + 展开态内容区
 *   在 DOM 中存在；点关闭按钮触发 close emit（父组件消费 → isOpen=false → 收起）
 * - 构建者（白盒）：无内容面板 slot → 空态占位（icon + emptyText/emptyHint）；
 *   内容面板 slot 注入替换（无 fallback 双渲染）
 * - 观察者（形态）：isOpen=false 时 aside 不渲染；L1 tab = 右抽屉容器声明（display-containers
 *   §7.2 单一权威——u-w1-layout 起 terminal 迁底抽屉、u-w2-browser-mount 起 browser 走浮层，tab 10→8）
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
import type { RightDrawerTab } from '@taiji/core/domain/drawer'

/** 展开态基础 props（控制态三字段，widget 数据走默认空 → 空态分支；display-containers
 *  §6.6③ W0：docked 死状态删除，props 面同步收窄；默认 activeTab = 'git'（§7.1）） */
function baseProps<T extends object>(overrides: T = {} as T) {
  return {
    isOpen: true as boolean,
    activeTab: 'git' as RightDrawerTab,
    sessionId: 's1',
    ...overrides,
  }
}

describe('DrawerPanel (AC9/AC12 首屏冒烟)', () => {
  it('展开态：注册表派生视图的 8 个 L1 tab 按钮（terminal 迁底抽屉、browser 走浮层、workflow 走浮层主入口）+ 展开态内容区 DOM 存在', () => {
    const wrapper = mount(DrawerPanel, { props: baseProps() })
    for (const key of ['git', 'doc', 'detail', 'subagent', 'bashTask', 'plan', 'btw', 'trace']) {
      expect(wrapper.find(`[data-testid="drawer-tab-${key}"]`).exists()).toBe(true)
    }
    expect(wrapper.find('[data-testid="drawer-tab-terminal"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="drawer-tab-browser"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="drawer-tab-workflow"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid^="drawer-tab-"]')).toHaveLength(8)
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
    await wrapper.find('[data-testid="drawer-tab-doc"]').trigger('click')
    expect(wrapper.emitted('set-tab')).toEqual([['doc']])
  })

  it('docked 死状态删除（display-containers §6.6③）：pin 按钮不存在、无 toggle-dock emit（UI 行为零变化——改前按钮仅图标变色无行为）', () => {
    const wrapper = mount(DrawerPanel, { props: baseProps() })
    expect(wrapper.find('[data-testid="drawer-pin"]').exists()).toBe(false)
    expect(wrapper.emitted('toggle-dock')).toBeUndefined()
    // 关闭按钮仍常驻（唯一收起通道不回退）
    expect(wrapper.find('[data-testid="drawer-close"]').exists()).toBe(true)
  })

  it('activeTab 高亮：当前 tab 应用选中样式（bg-surface-hover solid hover tone）', () => {
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

// R3 抽屉域焦点收敛（ui-replica MF-1-51）：aside 根持 input 聚焦零框作用域，双属性同压——
// MF-1-71 后全局 Input 聚焦走 outline 通道，shadow-none（压 ring/box-shadow 通道）单独
// 压不住 outline，漏一即穿。class 存在性断言 = 作用域契约断言（jsdom 不加载 Tailwind CSS，
// 计算样式不可验；作用域的定义面就是 aside 类串本身）。
describe('DrawerPanel (R3 抽屉域焦点作用域，MF-1-51)', () => {
  it('input 聚焦零边界：aside 根双属性类在位（outline-none 压 outline 通道 + shadow-none 压 ring/box-shadow 通道）', () => {
    const wrapper = mount(DrawerPanel, { props: baseProps() })
    const aside = wrapper.find('[data-testid="drawer-panel"]')
    expect(aside.classes()).toContain('[&_input:focus-visible]:outline-none')
    expect(aside.classes()).toContain('[&_input:focus-visible]:shadow-none')
  })

  it('[tabindex] 键盘聚焦双压：inset shadow 通道 + outline-none 同在（漏 outline-none 时 UA 默认焦点环与 inset 框叠双框）', () => {
    const wrapper = mount(DrawerPanel, { props: baseProps() })
    const aside = wrapper.find('[data-testid="drawer-panel"]')
    expect(aside.classes()).toContain('[&_[tabindex]:focus-visible]:shadow-[inset_0_0_0_1px_var(--border-strong)]')
    expect(aside.classes()).toContain('[&_[tabindex]:focus-visible]:outline-none')
  })
})

// 面板方向滑入（demo drawers.css 裁决 10B，spec §3.3）：tab 切换后内容 wrapper 挂方向动画类
// （目标 tab 序更大 = 自右滑入 from-r，更小 = 自左 from-l）；首次挂载不挂动画类（抽屉首开
// 不叠面板动画）。类存在性断言 = 动画契约断言（jsdom 不执行 CSS animation，同 R3 作用域
// 断言口径——契约的定义面就是类串本身）。wrapper 挂在「有内容」分支（v-if），故注入 slot。
describe('DrawerPanel (面板方向滑入，裁决 10B)', () => {
  const slotStubs = { default: '<div data-testid="panel-slot" />' }

  it('首次挂载：内容 wrapper 存在但不挂方向动画类（首开不叠面板动画）', () => {
    const wrapper = mount(DrawerPanel, { props: baseProps(), slots: slotStubs })
    const slotWrap = wrapper.find('[data-testid="drawer-panel-slot"]')
    expect(slotWrap.exists()).toBe(true)
    expect(slotWrap.classes()).not.toContain('drawer-panel-slide-r')
    expect(slotWrap.classes()).not.toContain('drawer-panel-slide-l')
  })

  it('tab 序增大（git→doc）：挂自右滑入类 drawer-panel-slide-r', async () => {
    const wrapper = mount(DrawerPanel, { props: baseProps(), slots: slotStubs })
    await wrapper.setProps({ activeTab: 'doc' })
    expect(wrapper.find('[data-testid="drawer-panel-slot"]').classes()).toContain('drawer-panel-slide-r')
  })

  it('tab 序减小（btw→git）：挂自左滑入类 drawer-panel-slide-l', async () => {
    const wrapper = mount(DrawerPanel, { props: baseProps({ activeTab: 'btw' }), slots: slotStubs })
    await wrapper.setProps({ activeTab: 'git' })
    expect(wrapper.find('[data-testid="drawer-panel-slot"]').classes()).toContain('drawer-panel-slide-l')
  })
})

// bashTask tab（2026-09 background-task-sidebar-view D5②）：tabs 加第 8 个 TabMeta。
// 内容面板由壳层（PanelContainer）slot 注入，本组件只负责 tab 元信息与空态 fallback。
describe('DrawerPanel (bashTask tab，background-task-sidebar-view D5②)', () => {
  it('bashTask tab 按钮 DOM 存在（terminal 迁出后其余 tab 无回归）', () => {
    const wrapper = mount(DrawerPanel, { props: baseProps() })
    expect(wrapper.find('[data-testid="drawer-tab-bashTask"]').exists()).toBe(true)
    // 既有 tab 不回退（浏览器/Git/文档/详情/子代理/工作流 + 后台命令）
    for (const key of ['git', 'doc', 'detail', 'subagent']) {
      expect(wrapper.find(`[data-testid="drawer-tab-${key}"]`).exists()).toBe(true)
    }
  })

  it('bashTask tab 点击 emit set-tab bashTask', async () => {
    const wrapper = mount(DrawerPanel, { props: baseProps() })
    await wrapper.find('[data-testid="drawer-tab-bashTask"]').trigger('click')
    expect(wrapper.emitted('set-tab')).toEqual([['bashTask']])
  })

  it('activeTab=bashTask：应用选中样式（bg-surface-hover solid hover tone）', () => {
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
// 落 plan 域文件 plan.drawer.*，icon 与 PlanModeBar 同源 SquareCheckBig）。内容面板由壳层
// （PanelContainer）slot 注入空骨架（PlanDocsPanel 归 u1-docs-panel），本组件只负责 tab 元信息。
describe('DrawerPanel (plan tab，plan 模式重设计 u1-drawer-tab)', () => {
  it('plan tab 按钮 DOM 存在（既有 tab 无回归）', () => {
    const wrapper = mount(DrawerPanel, { props: baseProps() })
    expect(wrapper.find('[data-testid="drawer-tab-plan"]').exists()).toBe(true)
    for (const key of ['git', 'doc', 'detail', 'subagent', 'bashTask']) {
      expect(wrapper.find(`[data-testid="drawer-tab-${key}"]`).exists()).toBe(true)
    }
  })

  it('plan tab 标题引用 plan 域 i18n key（title 属性 = tab.label）', () => {
    const wrapper = mount(DrawerPanel, { props: baseProps() })
    // ui 包测试环境的 vue-i18n mock 返回 key 本身（DrawerPanel.test 文件头 mock 策略），
    // title 属性断言即「label 引用了 plan.drawer.tabPlan key」
    expect(wrapper.find('[data-testid="drawer-tab-plan"]').attributes('title')).toBe('plan.drawer.tabPlan')
  })

  it('plan tab icon 为 SquareCheckBig（与 PlanModeBar 同源 icon 体系，svg 在按钮内渲染）', () => {
    const wrapper = mount(DrawerPanel, { props: baseProps() })
    // icon 经 <component :is> 渲染为 svg（lucide 组件根元素），存在性断言注册生效
    expect(wrapper.find('[data-testid="drawer-tab-plan"] svg').exists()).toBe(true)
  })

  it('plan tab 点击 emit set-tab plan', async () => {
    const wrapper = mount(DrawerPanel, { props: baseProps() })
    await wrapper.find('[data-testid="drawer-tab-plan"]').trigger('click')
    expect(wrapper.emitted('set-tab')).toEqual([['plan']])
  })

  it('activeTab=plan：应用选中样式（bg-surface-hover solid hover tone）', () => {
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

// btw tab（btw-question D7，M3-a 第 10 员）：tabs 加第 10 个 TabMeta（key='btw'，i18n key
// 落 btw 域文件 btw.drawer.*，icon 用 MessagesSquare）。内容面板由壳层（PanelContainer）
// slot 注入 BtwPanel（面板单元落地前本组件空态 fallback 承载），延续留壳 slot 模式。
describe('DrawerPanel (btw tab，btw-question D7 M3-a)', () => {
  it('btw tab 按钮 DOM 存在（既有 tab 无回归）', () => {
    const wrapper = mount(DrawerPanel, { props: baseProps() })
    expect(wrapper.find('[data-testid="drawer-tab-btw"]').exists()).toBe(true)
    for (const key of ['git', 'doc', 'detail', 'subagent', 'bashTask', 'plan']) {
      expect(wrapper.find(`[data-testid="drawer-tab-${key}"]`).exists()).toBe(true)
    }
  })

  it('btw tab 标题引用 btw 域 i18n key（title 属性 = tab.label）', () => {
    const wrapper = mount(DrawerPanel, { props: baseProps() })
    // ui 包测试环境的 vue-i18n mock 返回 key 本身（DrawerPanel.test 文件头 mock 策略），
    // title 断言即「label 引用了 btw.drawer.tabBtw key」（双侧 key 对齐归 locale-sync-check）
    expect(wrapper.find('[data-testid="drawer-tab-btw"]').attributes('title')).toBe('btw.drawer.tabBtw')
  })

  it('btw tab icon 为 MessagesSquare（svg 在按钮内渲染，icon 体系注册生效）', () => {
    const wrapper = mount(DrawerPanel, { props: baseProps() })
    expect(wrapper.find('[data-testid="drawer-tab-btw"] svg').exists()).toBe(true)
  })

  it('btw tab 点击 emit set-tab btw', async () => {
    const wrapper = mount(DrawerPanel, { props: baseProps() })
    await wrapper.find('[data-testid="drawer-tab-btw"]').trigger('click')
    expect(wrapper.emitted('set-tab')).toEqual([['btw']])
  })

  it('activeTab=btw：应用选中样式（bg-surface-hover solid hover tone，§3.4 标准 tab 型——三卡化后 L1 例外前提消失）', () => {
    const wrapper = mount(DrawerPanel, { props: baseProps({ activeTab: 'btw' }) })
    expect(wrapper.find('[data-testid="drawer-tab-btw"]').classes()).toContain('bg-surface-hover')
  })

  it('btw 无内容面板 slot：空态 fallback 渲染 btw 域 i18n key（t mock 返回 key，断言 key 引用）', () => {
    const wrapper = mount(DrawerPanel, { props: baseProps({ activeTab: 'btw' }) })
    const empty = wrapper.find('[data-testid="drawer-widget-empty"]')
    expect(empty.exists()).toBe(true)
    expect(empty.text()).toContain('btw.drawer.noThread')
    expect(empty.text()).toContain('btw.drawer.threadHint')
  })

  it('btw tab 有内容 slot 注入 → 替换空态（C2 合同：BtwPanel 注入后不双渲染）', () => {
    const wrapper = mount(DrawerPanel, {
      props: baseProps({ activeTab: 'btw' }),
      slots: { default: '<div data-testid="btw-panel-stub" />' },
    })
    expect(wrapper.find('[data-testid="btw-panel-stub"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="drawer-widget-empty"]').exists()).toBe(false)
  })
})
