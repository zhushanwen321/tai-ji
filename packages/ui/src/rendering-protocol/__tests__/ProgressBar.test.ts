/**
 * ProgressBar 组件测试（W2 · v6 fill 柔化）。
 * v6：显式 severity → color-mix 柔化；推断 ok(ratio≥0.8) → neutral-dim(done 语义)。
 *
 * 运行：cd packages/ui && npx vitest run src/rendering-protocol/__tests__/ProgressBar.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ProgressBar from '../primitives/ProgressBar.vue'

describe('ProgressBar', () => {
  it('v6: severity=ok 时 fill 背景用 color-mix 柔化 success，按比例填充 width', () => {
    const wrapper = mount(ProgressBar, {
      props: { label: 'build', current: 7, total: 8, severity: 'ok' },
    })
    expect(wrapper.find('[data-testid="gui-progress-bar"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('build')
    expect(wrapper.text()).toContain('7')
    expect(wrapper.text()).toContain('8')
    const fill = wrapper.find('.progress-bar__fill')
    expect(fill.exists()).toBe(true)
    // v6: 显式 ok → color-mix + success（去 bg-success class）
    const style = fill.attributes('style') ?? ''
    expect(style).toContain('color-mix')
    expect(style).toContain('success')
    expect(fill.classes()).not.toContain('bg-success')
    // 7/8 = 87.5%
    expect(style).toContain('width: 87.5%')
  })

  it('v6: severity=warn/danger → color-mix 对应色', () => {
    const w1 = mount(ProgressBar, { props: { current: 3, total: 4, severity: 'warn' } })
    const s1 = w1.find('.progress-bar__fill').attributes('style') ?? ''
    expect(s1).toContain('color-mix')
    expect(s1).toContain('warn')

    const w2 = mount(ProgressBar, { props: { current: 1, total: 4, severity: 'danger' } })
    const s2 = w2.find('.progress-bar__fill').attributes('style') ?? ''
    expect(s2).toContain('color-mix')
    expect(s2).toContain('danger')
  })

  it('v6: 推断 ok(ratio≥0.8) → neutral-dim（done 语义，非绿色 color-mix）', () => {
    const wrapper = mount(ProgressBar, { props: { current: 9, total: 10 } })
    const style = wrapper.find('.progress-bar__fill').attributes('style') ?? ''
    // v6: 推断 ok → neutral-dim（已完成弱化视觉权重）
    expect(style).toContain('neutral-dim')
    expect(style).not.toContain('color-mix')
  })

  it('v6: 推断 warn(0.5≤ratio<0.8) → color-mix warn', () => {
    const wrapper = mount(ProgressBar, { props: { current: 6, total: 10 } })
    const style = wrapper.find('.progress-bar__fill').attributes('style') ?? ''
    expect(style).toContain('color-mix')
    expect(style).toContain('warn')
  })

  it('v6: 推断 danger(ratio<0.5) → color-mix danger', () => {
    const wrapper = mount(ProgressBar, { props: { current: 3, total: 10 } })
    const style = wrapper.find('.progress-bar__fill').attributes('style') ?? ''
    expect(style).toContain('color-mix')
    expect(style).toContain('danger')
  })

  it('total=0 时不崩，width=0%', () => {
    const wrapper = mount(ProgressBar, { props: { current: 0, total: 0 } })
    expect(wrapper.find('[data-testid="gui-progress-bar"]').exists()).toBe(true)
    expect(wrapper.find('.progress-bar__fill').attributes('style')).toContain('width: 0.0%')
  })

  it('current > total 时不崩（溢出场景）', () => {
    const wrapper = mount(ProgressBar, { props: { current: 10, total: 8 } })
    expect(wrapper.find('[data-testid="gui-progress-bar"]').exists()).toBe(true)
    // 10/8 = 125%，fill width 超过 100%（track overflow-hidden 裁剪视觉溢出，但不崩渲染）
    expect(wrapper.find('.progress-bar__fill').attributes('style')).toContain('width: 125.0%')
  })

  it('v6: track/fill 圆角 rounded-sm', () => {
    const wrapper = mount(ProgressBar, { props: { current: 1, total: 2 } })
    expect(wrapper.find('.progress-bar__track').classes()).toContain('rounded-sm')
    expect(wrapper.find('.progress-bar__fill').classes()).toContain('rounded-sm')
  })
})
