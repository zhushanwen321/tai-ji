/**
 * SegmentedControl 原语测试（remote-use-mobile-v2 §6.9 / spec §6.6）。
 *
 * 覆盖：tablist/tab 语义（role + aria-selected）、选中态类（bg-elevated + shadow-1）、
 * 44px 触控档（--m-tap）、点击切换 emit update:modelValue。
 *
 * 运行：cd packages/ui && npx vitest run src/primitives/__tests__/segmented-control.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SegmentedControl from '../segmented-control/SegmentedControl.vue'

const OPTIONS = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
]

describe('SegmentedControl（spec §6.6 段控）', () => {
  it('tablist 语义 + 选中段 aria-selected（spec「role=tablist + aria-selected」）', () => {
    const w = mount(SegmentedControl, { props: { modelValue: 'medium', options: OPTIONS, label: '思考档' } })
    expect(w.attributes('role')).toBe('tablist')
    expect(w.attributes('aria-label')).toBe('思考档')
    const tabs = w.findAll('[role="tab"]')
    expect(tabs).toHaveLength(3)
    expect(tabs[1].attributes('aria-selected')).toBe('true')
    expect(tabs[0].attributes('aria-selected')).toBe('false')
  })

  it('选中段 = bg-elevated + shadow-1，未选段无选中底（spec 选中态「tab 型」）', () => {
    const w = mount(SegmentedControl, { props: { modelValue: 'medium', options: OPTIONS, label: '思考档' } })
    const tabs = w.findAll('[role="tab"]')
    expect(tabs[1].classes()).toContain('bg-bg-elevated')
    expect(tabs[1].classes()).toContain('shadow-1')
    expect(tabs[0].classes()).not.toContain('bg-bg-elevated')
    // 每段 ≥44px 触控
    for (const tab of tabs) expect(tab.classes()).toContain('min-h-[var(--m-tap)]')
  })

  it('点击未选段 emit update:modelValue 携带目标 value', async () => {
    const w = mount(SegmentedControl, { props: { modelValue: 'low', options: OPTIONS, label: '思考档' } })
    await w.find('[data-testid="segmented-option-high"]').trigger('click')
    expect(w.emitted('update:modelValue')).toEqual([['high']])
  })
})
