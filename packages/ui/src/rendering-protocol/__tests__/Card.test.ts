/**
 * Card 组件测试（W2 · v6 视觉改造）。
 * v6：去 border 靠 bg 层级，danger/success 靠 header dot+badge，header bg 浮起。
 *
 * 运行：cd packages/ui && npx vitest run src/rendering-protocol/__tests__/Card.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Card from '../primitives/Card.vue'
import type { GuiComponent } from '@zhushanwen/extension-protocol'

describe('Card', () => {
  it('header=string + body 嵌套 stats-line 子组件（variant=elevated）', () => {
    const body: GuiComponent[] = [
      { type: 'stats-line', props: { items: [{ value: '15' }] } },
    ]
    const wrapper = mount(Card, {
      props: { variant: 'elevated', header: 'CI Pipeline', body },
    })
    const card = wrapper.find('[data-testid="gui-card"]')
    expect(card.exists()).toBe(true)
    expect(wrapper.text()).toContain('CI Pipeline')
    // body 内嵌 GuiComponentRenderer 渲染出 stats-line
    expect(wrapper.find('[data-testid="gui-stats-line"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('15')
    // v6: elevated → bg-surface-2（去 border-border-strong）
    expect(card.classes()).toContain('bg-surface-2')
    expect(card.classes()).not.toContain('border-border-strong')
    // v6: header bg 浮起（elevated → bg-elevated）
    const header = wrapper.find('[data-testid="gui-card"] > div:first-child')
    expect(header.classes()).toContain('bg-elevated')
  })

  it('variant=danger → bg-surface + header dot(bg-danger) + badge(失败/b-danger)', () => {
    const wrapper = mount(Card, {
      props: { variant: 'danger', header: 'Run', body: [] },
    })
    const card = wrapper.find('[data-testid="gui-card"]')
    // v6: danger → bg-surface（去 border-danger）
    expect(card.classes()).toContain('bg-surface')
    expect(card.classes()).not.toContain('border-danger')
    // v6: header dot 用 bg-danger
    const dot = wrapper.find('[data-testid="gui-card-dot"]')
    expect(dot.exists()).toBe(true)
    expect(dot.classes()).toContain('bg-danger')
    // v6: badge 显示「失败」+ bg-danger-soft/text-danger
    const badge = wrapper.find('[data-testid="gui-card-badge"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('失败')
    expect(badge.classes()).toContain('bg-danger-soft')
    expect(badge.classes()).toContain('text-danger')
  })

  it('variant=success → bg-surface + header dot(bg-success) + badge(完成/b-success)', () => {
    const wrapper = mount(Card, {
      props: { variant: 'success', header: 'Deploy', body: [] },
    })
    const card = wrapper.find('[data-testid="gui-card"]')
    // v6: success → bg-surface（去 border-success）
    expect(card.classes()).toContain('bg-surface')
    expect(card.classes()).not.toContain('border-success')
    const dot = wrapper.find('[data-testid="gui-card-dot"]')
    expect(dot.classes()).toContain('bg-success')
    const badge = wrapper.find('[data-testid="gui-card-badge"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('完成')
    expect(badge.classes()).toContain('bg-success-soft')
    expect(badge.classes()).toContain('text-success')
  })

  it('variant 未传 → default（bg-surface，无 border-border）', () => {
    const wrapper = mount(Card, {
      props: { body: [] },
    })
    const card = wrapper.find('[data-testid="gui-card"]')
    // v6: default → bg-surface（去 border-border）
    expect(card.classes()).toContain('bg-surface')
    expect(card.classes()).not.toContain('border-border')
  })

  it('v6: default/elevated 无 badge，danger/success 有 badge（header 存在时）', () => {
    const defaultCard = mount(Card, { props: { variant: 'default', header: 'h', body: [] } })
    expect(defaultCard.find('[data-testid="gui-card-badge"]').exists()).toBe(false)

    const elevatedCard = mount(Card, { props: { variant: 'elevated', header: 'h', body: [] } })
    expect(elevatedCard.find('[data-testid="gui-card-badge"]').exists()).toBe(false)

    const dangerCard = mount(Card, { props: { variant: 'danger', header: 'h', body: [] } })
    expect(dangerCard.find('[data-testid="gui-card-badge"]').exists()).toBe(true)

    const successCard = mount(Card, { props: { variant: 'success', header: 'h', body: [] } })
    expect(successCard.find('[data-testid="gui-card-badge"]').exists()).toBe(true)
  })

  it('v6: 无 header 时 dot/badge 均不渲染（header 容器整体不挂载）', () => {
    const wrapper = mount(Card, { props: { variant: 'danger', body: [] } })
    expect(wrapper.find('[data-testid="gui-card-dot"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="gui-card-badge"]').exists()).toBe(false)
  })

  it('v6: dot 全 variant 显示（default/elevated=neutral-ico，danger/success=对应色，header 存在时）', () => {
    const defaultCard = mount(Card, { props: { variant: 'default', header: 'h', body: [] } })
    expect(defaultCard.find('[data-testid="gui-card-dot"]').classes()).toContain('bg-neutral-ico')

    const elevatedCard = mount(Card, { props: { variant: 'elevated', header: 'h', body: [] } })
    expect(elevatedCard.find('[data-testid="gui-card-dot"]').classes()).toContain('bg-neutral-ico')

    const dangerCard = mount(Card, { props: { variant: 'danger', header: 'h', body: [] } })
    expect(dangerCard.find('[data-testid="gui-card-dot"]').classes()).toContain('bg-danger')

    const successCard = mount(Card, { props: { variant: 'success', header: 'h', body: [] } })
    expect(successCard.find('[data-testid="gui-card-dot"]').classes()).toContain('bg-success')
  })

  it('v6: header bg 浮起（default/danger/success→bg-surface-2，elevated→bg-elevated）', () => {
    const defaultCard = mount(Card, { props: { variant: 'default', header: 'h', body: [] } })
    expect(defaultCard.find('[data-testid="gui-card"] > div:first-child').classes()).toContain('bg-surface-2')

    const elevatedCard = mount(Card, { props: { variant: 'elevated', header: 'h', body: [] } })
    expect(elevatedCard.find('[data-testid="gui-card"] > div:first-child').classes()).toContain('bg-elevated')
  })

  it('header 为 GuiComponent 时递归渲染（dot + badge 仍在 header 容器）', () => {
    const headerComp: GuiComponent = {
      type: 'stats-line',
      props: { items: [{ label: 'x', value: '42' }] },
    }
    const wrapper = mount(Card, {
      props: { variant: 'danger', header: headerComp, body: [] },
    })
    // component header 递归渲染出 stats-line
    expect(wrapper.find('[data-testid="gui-stats-line"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('42')
    // v6: dot + badge 仍在 header 容器（component 模式不丢失）
    expect(wrapper.find('[data-testid="gui-card-dot"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="gui-card-badge"]').exists()).toBe(true)
  })

  it('根容器圆角 8px（spec .gcard border-radius: 8px，rounded-md 标准 scale）', () => {
    const wrapper = mount(Card, { props: { body: [] } })
    expect(wrapper.find('[data-testid="gui-card"]').classes()).toContain('rounded-md')
    expect(wrapper.find('[data-testid="gui-card"]').classes()).not.toContain('rounded-card')
  })
})
