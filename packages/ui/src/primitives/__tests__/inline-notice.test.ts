/**
 * InlineNotice 原语测试（remote-use-mobile-v2 §6.9 / spec §6.8）。
 *
 * 覆盖：五档 tone 的配色 + 图标 + role（danger=alert / 其余=status）、文案渲染、
 * 行动插槽（错误常驻可重试的行动入口由消费方放）。
 *
 * 运行：cd packages/ui && npx vitest run src/primitives/__tests__/inline-notice.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import InlineNotice from '../inline-notice/InlineNotice.vue'

describe('InlineNotice（spec §6.8 内联反馈条）', () => {
  it('danger 档：danger-soft 底 + danger-text 字 + role=alert（打断读屏）', () => {
    const w = mount(InlineNotice, { props: { tone: 'danger', text: '未送达，检查网络后重试' } })
    expect(w.classes()).toContain('bg-danger-soft')
    expect(w.classes()).toContain('text-[color:var(--danger-text)]')
    expect(w.attributes('role')).toBe('alert')
    expect(w.find('[data-testid="inline-notice-text"]').text()).toBe('未送达，检查网络后重试')
    expect(w.find('svg').exists()).toBe(true)
  })

  it('success/warn/offline/neutral 档：各自配色，role=status（播报不打断）', () => {
    const cases = [
      { tone: 'success', cls: 'bg-success-soft' },
      { tone: 'warn', cls: 'bg-warn-soft' },
      { tone: 'offline', cls: 'bg-warn-soft' },
      { tone: 'neutral', cls: 'bg-surface' },
    ] as const
    for (const c of cases) {
      const w = mount(InlineNotice, { props: { tone: c.tone, text: 'x' } })
      expect(w.classes(), c.tone).toContain(c.cls)
      expect(w.attributes('role'), c.tone).toBe('status')
    }
  })

  it('行动插槽：错误可重试的行动入口经消费方放置并可达', () => {
    const w = mount(InlineNotice, {
      props: { tone: 'danger', text: '未送达' },
      slots: { default: '<button type="button">重试</button>' },
    })
    expect(w.find('[data-testid="inline-notice-action"] button').text()).toBe('重试')
  })

  it('tone 缺省 = neutral（soft 底 + 中性字）', () => {
    const w = mount(InlineNotice, { props: { text: 'x' } })
    expect(w.classes()).toContain('bg-surface')
  })
})
