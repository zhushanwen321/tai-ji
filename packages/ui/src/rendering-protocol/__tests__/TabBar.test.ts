/**
 * TabBar 组件测试（W2 · v6 连体 pill 范式）。
 * v6：bg-bg-input 容器 + active bg-elevated+neutral-fg，去 accent-soft/border-b。
 *
 * 运行：cd packages/ui && npx vitest run src/rendering-protocol/__tests__/TabBar.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import TabBar from '../primitives/TabBar.vue'

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
})
