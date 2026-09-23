/**
 * TabBar 组件测试（W2 · v6 连体 pill 范式 + 协议 v1.1 容器化 sections）。
 * v6：bg-bg-input 容器 + active bg-elevated+neutral-fg，去 accent-soft/border-b。
 * 容器化（设计 §3.3 D5 / §3.5）：渲染 active section、点击只切本地序号不回传、
 * 后续推送不重置本地选择（探针 P5）、sections 非法或渲染器缺位时退化纯展示 + warn。
 * 容器化用例经 GuiComponentRenderer 挂载（= 应用路径：渲染器 provide 自身），
 * 纯展示/降级用例直接挂载 TabBar（旧 extension 消费形态）。
 *
 * 运行：cd packages/ui && npx vitest run src/rendering-protocol/__tests__/TabBar.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import type { GuiComponent, GuiComponentProps } from '@zhushanwen/extension-protocol'
import TabBar from '../primitives/TabBar.vue'
import GuiComponentRenderer from '../GuiComponentRenderer.vue'

/** section 子树用的最小 list-tree（断言渲染归属的文本载体） */
const listTree = (label: string): GuiComponent<'list-tree'> => ({
  type: 'list-tree',
  props: { items: [{ label }] },
})

/** tab-bar guiTree 构造（推送载荷形状；sections 缺省 = 纯展示） */
const tabBarTree = (
  tabs: GuiComponentProps['tab-bar']['tabs'],
  sections?: GuiComponentProps['tab-bar']['sections'],
): GuiComponent<'tab-bar'> => ({
  type: 'tab-bar',
  props: sections === undefined ? { tabs } : { tabs, sections },
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TabBar', () => {
  it('v6: 容器 bg-bg-input + rounded-lg（去 border-b）', () => {
    const wrapper = mount(TabBar, {
      props: { tabs: [{ label: 'a' }] },
    })
    const bar = wrapper.find('[data-testid="gui-tab-bar"]')
    expect(bar.exists()).toBe(true)
    expect(bar.classes()).toContain('bg-bg-input')
    expect(bar.classes()).toContain('rounded-lg')
    // v6: 容器 padding 3px（spec .gtabbar padding:3px）
    expect(bar.classes()).toContain('p-[3px]')
    // v6: 去 border-b border-border
    expect(bar.classes()).not.toContain('border-b')
    expect(bar.classes()).not.toContain('border-border')
  })

  it('渲染 active + done + pending 三态', () => {
    const wrapper = mount(TabBar, {
      props: {
        tabs: [
          { label: 'node20', active: true },
          { label: 'node22', status: 'done' },
          { label: 'bun', status: 'pending' },
        ],
      },
    })
    expect(wrapper.find('[data-testid="gui-tab-bar"]').exists()).toBe(true)
    const tabs = wrapper.findAll('.tab-bar__tab')
    expect(tabs).toHaveLength(3)

    // v6: active tab 用 bg-elevated + text-neutral-fg（去 bg-accent-soft + text-accent）
    expect(tabs[0].classes()).toContain('bg-elevated')
    expect(tabs[0].classes()).toContain('text-neutral-fg')
    expect(tabs[0].classes()).not.toContain('bg-accent-soft')
    // done tab 有绿点
    expect(tabs[1].find('.tab-bar__dot').classes()).toContain('bg-success')
    // pending tab 有灰点
    expect(tabs[2].find('.tab-bar__dot').classes()).toContain('bg-neutral-dim')
  })

  it('v6: tab 项圆角 rounded-sm', () => {
    const wrapper = mount(TabBar, {
      props: { tabs: [{ label: 'a' }] },
    })
    expect(wrapper.find('.tab-bar__tab').classes()).toContain('rounded-sm')
  })

  it('v6: label 无 text-success 条件（done && !active 时 label 不额外着色）', () => {
    const wrapper = mount(TabBar, {
      props: { tabs: [{ label: 'done-tab', status: 'done' }] },
    })
    const label = wrapper.find('.tab-bar__label')
    expect(label.classes()).not.toContain('text-success')
  })

  it('v6: 非 active tab 文字 neutral-dim，hover 升 neutral-fg', () => {
    const wrapper = mount(TabBar, {
      props: { tabs: [{ label: 'idle' }] },
    })
    const tab = wrapper.find('.tab-bar__tab')
    expect(tab.classes()).toContain('text-neutral-dim')
    expect(tab.classes()).toContain('hover:text-neutral-fg')
  })

  it('无 active 无 status 的 tab 只渲染 label 文本', () => {
    const wrapper = mount(TabBar, {
      props: { tabs: [{ label: 'plain' }] },
    })
    expect(wrapper.text()).toContain('plain')
    expect(wrapper.find('.tab-bar__dot').exists()).toBe(false)
  })

  it('空 tabs 不崩', () => {
    const wrapper = mount(TabBar, { props: { tabs: [] } })
    expect(wrapper.find('[data-testid="gui-tab-bar"]').exists()).toBe(true)
    expect(wrapper.findAll('.tab-bar__tab')).toHaveLength(0)
  })

  it('向后兼容：无 sections = 纯展示（推送 active 驱动、无点击态、无 section 节点）', async () => {
    const wrapper = mount(TabBar, {
      props: { tabs: [{ label: 'a' }, { label: 'b', active: true }] },
    })
    const tabs = wrapper.findAll('.tab-bar__tab')
    expect(tabs).toHaveLength(2)
    // active 由推送值单方决定（现状语义）
    expect(tabs[1].classes()).toContain('bg-elevated')
    expect(tabs[0].classes()).not.toContain('bg-elevated')
    // 无点击态样式（旧 extension 的 tab-bar 不可被染上可点视觉）
    expect(tabs[0].classes()).not.toContain('cursor-pointer')
    expect(tabs[1].classes()).not.toContain('cursor-pointer')
    expect(wrapper.find('[data-testid="gui-tab-bar-section"]').exists()).toBe(false)

    // 点击不改写视觉（无本地切换）
    await tabs[0].trigger('click')
    expect(wrapper.findAll('.tab-bar__tab')[1].classes()).toContain('bg-elevated')
    expect(wrapper.findAll('.tab-bar__tab')[0].classes()).not.toContain('bg-elevated')
  })
})

describe('TabBar 容器化（sections，协议 v1.1）', () => {
  it('sections 与 tabs 等长 → 渲染 active tab 对应子树（应用路径经渲染器递归）', () => {
    const wrapper = mount(GuiComponentRenderer, {
      props: {
        component: tabBarTree(
          [{ label: '待办' }, { label: '已完成' }],
          [[listTree('t1')], [listTree('t2')]],
        ),
      },
    })
    const section = wrapper.find('[data-testid="gui-tab-bar-section"]')
    expect(section.exists()).toBe(true)
    expect(section.find('[data-testid="gui-list-tree"]').exists()).toBe(true)
    expect(section.text()).toContain('t1')
    expect(section.text()).not.toContain('t2')
    // 容器化态 tab 可点（cursor-pointer 只在 sections 合法时出现）
    expect(wrapper.findAll('.tab-bar__tab')[0].classes()).toContain('cursor-pointer')
  })

  it('首挂载取推送 tabs[i].active（无 active 取 0）', () => {
    const pushedSecond = mount(GuiComponentRenderer, {
      props: {
        component: tabBarTree(
          [{ label: '待办' }, { label: '已完成', active: true }],
          [[listTree('t1')], [listTree('t2')]],
        ),
      },
    })
    expect(pushedSecond.findAll('.tab-bar__tab')[1].classes()).toContain('bg-elevated')
    expect(pushedSecond.find('[data-testid="gui-tab-bar-section"]').text()).toContain('t2')

    const noActive = mount(GuiComponentRenderer, {
      props: {
        component: tabBarTree(
          [{ label: '待办' }, { label: '已完成' }],
          [[listTree('t1')], [listTree('t2')]],
        ),
      },
    })
    expect(noActive.findAll('.tab-bar__tab')[0].classes()).toContain('bg-elevated')
    expect(noActive.find('[data-testid="gui-tab-bar-section"]').text()).toContain('t1')
  })

  it('点击 tab 只切本地 active（切换 section + active 视觉），不回传 extension', async () => {
    const wrapper = mount(GuiComponentRenderer, {
      props: {
        component: tabBarTree(
          [{ label: '待办' }, { label: '已完成' }],
          [[listTree('t1')], [listTree('t2')]],
        ),
      },
    })
    await wrapper.findAll('.tab-bar__tab')[1].trigger('click')

    const tabs = wrapper.findAll('.tab-bar__tab')
    expect(tabs[1].classes()).toContain('bg-elevated')
    expect(tabs[0].classes()).not.toContain('bg-elevated')
    const section = wrapper.find('[data-testid="gui-tab-bar-section"]')
    expect(section.text()).toContain('t2')
    expect(section.text()).not.toContain('t1')
    // 不回传：TabBar 无 emit（协议无 UI→extension 回传通道）
    expect(wrapper.findComponent(TabBar).emitted()).toEqual({})
  })

  it('探针 P5：后续推送新 tabs/sections 不重置本地选择（组件未重建）', async () => {
    const wrapper = mount(GuiComponentRenderer, {
      props: {
        component: tabBarTree(
          [{ label: '待办' }, { label: '已完成' }],
          [[listTree('t1')], [listTree('t2')]],
        ),
      },
    })
    await wrapper.findAll('.tab-bar__tab')[1].trigger('click')
    const barElement = wrapper.find('[data-testid="gui-tab-bar"]').element

    // 推送更新内容（含新 tabs/sections 对象）
    await wrapper.setProps({
      component: tabBarTree(
        [{ label: '待办' }, { label: '已完成' }],
        [[listTree('t1-new')], [listTree('t2-new')]],
      ),
    })

    // 组件未重建（同一 DOM 元素）→ 本地选择保持（仍渲染第二段新内容）
    expect(wrapper.find('[data-testid="gui-tab-bar"]').element).toBe(barElement)
    expect(wrapper.findAll('.tab-bar__tab')[1].classes()).toContain('bg-elevated')
    const section = wrapper.find('[data-testid="gui-tab-bar-section"]')
    expect(section.text()).toContain('t2-new')
    expect(section.text()).not.toContain('t1-new')
  })

  it('tabs 缩短 → 本地序号 clamp（不越界，不重置为推送值）', async () => {
    const wrapper = mount(GuiComponentRenderer, {
      props: {
        component: tabBarTree(
          [{ label: 'a' }, { label: 'b' }, { label: 'c' }],
          [[listTree('t1')], [listTree('t2')], [listTree('t3')]],
        ),
      },
    })
    await wrapper.findAll('.tab-bar__tab')[2].trigger('click')
    expect(wrapper.find('[data-testid="gui-tab-bar-section"]').text()).toContain('t3')

    await wrapper.setProps({
      component: tabBarTree([{ label: 'a' }, { label: 'b' }], [[listTree('t1x')], [listTree('t2x')]]),
    })

    const tabs = wrapper.findAll('.tab-bar__tab')
    expect(tabs).toHaveLength(2)
    expect(tabs[1].classes()).toContain('bg-elevated')
    expect(wrapper.find('[data-testid="gui-tab-bar-section"]').text()).toContain('t2x')
  })

  it('section 子树经渲染入口递归（容器原语嵌套可用）', () => {
    const wrapper = mount(GuiComponentRenderer, {
      props: {
        component: tabBarTree(
          [{ label: '待办' }, { label: '已完成' }],
          [
            [{ type: 'group', props: { children: [listTree('nested')] } }],
            [listTree('t2')],
          ],
        ),
      },
    })
    const section = wrapper.find('[data-testid="gui-tab-bar-section"]')
    expect(section.find('[data-testid="gui-group"]').exists()).toBe(true)
    expect(section.text()).toContain('nested')
  })

  it('sections 与 tabs 长度不等 → 忽略 sections 退化纯展示 + warn（§3.5）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const wrapper = mount(GuiComponentRenderer, {
      props: {
        component: tabBarTree([{ label: 'a' }, { label: 'b' }], [[listTree('t1')]]),
      },
    })

    expect(wrapper.find('[data-testid="gui-tab-bar-section"]').exists()).toBe(false)
    const tabs = wrapper.findAll('.tab-bar__tab')
    expect(tabs).toHaveLength(2)
    // 退化纯展示：无点击态
    expect(tabs[0].classes()).not.toContain('cursor-pointer')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('长度不等')

    // 点击不产生本地切换（退化态无本地 active）
    await tabs[1].trigger('click')
    expect(wrapper.findAll('.tab-bar__tab')[1].classes()).not.toContain('bg-elevated')

    // 同形态重复推送不重复出声（防 warn 刷屏）
    await wrapper.setProps({
      component: tabBarTree([{ label: 'a' }, { label: 'b' }], [[listTree('t1')]]),
    })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('无渲染器上下文（standalone 直接挂载）→ 忽略 sections 退化纯展示 + warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const wrapper = mount(TabBar, {
      props: {
        tabs: [{ label: 'a' }, { label: 'b' }],
        sections: [[listTree('t1')], [listTree('t2')]],
      },
    })

    expect(wrapper.find('[data-testid="gui-tab-bar-section"]').exists()).toBe(false)
    expect(wrapper.findAll('.tab-bar__tab')[0].classes()).not.toContain('cursor-pointer')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('PRIMITIVE_RENDER_KEY')
  })
})
