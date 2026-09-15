/**
 * StatsLine 组件测试（W2 · v6 severity 收窄）。
 * v6：danger 保留 text-danger，ok/warn 降 text-neutral-fg。
 *
 * 运行：cd packages/ui && npx vitest run src/rendering-protocol/__tests__/StatsLine.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import StatsLine from '../primitives/StatsLine.vue'

describe('StatsLine', () => {
  it('v6: severity 收窄——danger 保留，ok/warn 降 neutral-fg', () => {
    const wrapper = mount(StatsLine, {
      props: {
        items: [
          { label: 'changes', value: '+142', severity: 'ok' },
          { label: 'warns', value: '3', severity: 'warn' },
          { label: 'fails', value: '1', severity: 'danger' },
        ],
      },
    })
    expect(wrapper.find('[data-testid="gui-stats-line"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('+142')
    expect(wrapper.text()).toContain('3')
    expect(wrapper.text()).toContain('1')
    const values = wrapper.findAll('.stats-line__value')
    expect(values).toHaveLength(3)
    // v6: ok → text-neutral-fg（原 text-success）
    expect(values[0].classes()).toContain('text-neutral-fg')
    expect(values[0].classes()).not.toContain('text-success')
    // v6: warn → text-neutral-fg（原 text-warn）
    expect(values[1].classes()).toContain('text-neutral-fg')
    expect(values[1].classes()).not.toContain('text-warn')
    // v6: danger → text-danger（保留）
    expect(values[2].classes()).toContain('text-danger')
  })

  it('v6: 无 severity → text-neutral-fg', () => {
    const wrapper = mount(StatsLine, {
      props: { items: [{ value: '42' }] },
    })
    const value = wrapper.find('.stats-line__value')
    expect(value.classes()).toContain('text-neutral-fg')
  })

  it('item 间用 border-l 分隔（首项无分隔线，hairline 保留）', () => {
    const wrapper = mount(StatsLine, {
      props: { items: [{ value: 'a' }, { value: 'b' }, { value: 'c' }] },
    })
    const items = wrapper.findAll('.stats-line__item')
    expect(items).toHaveLength(3)
    // 首项无左边框
    expect(items[0].classes()).not.toContain('border-l')
    // 后续项有左边框（v6 hairline 保留）
    expect(items[1].classes()).toContain('border-l')
    expect(items[2].classes()).toContain('border-l')
  })

  it('label 可选，无 label 时只渲染 value', () => {
    const wrapper = mount(StatsLine, {
      props: { items: [{ value: '42' }] },
    })
    expect(wrapper.text()).toContain('42')
    expect(wrapper.find('.stats-line__label').exists()).toBe(false)
  })

  it('空 items 不崩', () => {
    const wrapper = mount(StatsLine, { props: { items: [] } })
    expect(wrapper.find('[data-testid="gui-stats-line"]').exists()).toBe(true)
    expect(wrapper.findAll('.stats-line__item')).toHaveLength(0)
  })
})
