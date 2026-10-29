/**
 * StatusPill 原语测试（remote-use-mobile-v2 §6.9 / spec §6.5）。
 *
 * 覆盖：六类白名单（待确认/待回答/出错/重试中/后台/已退出）渲染与配色、
 * 白名单外常态不渲染、缺 label 不渲染、22px/12px 规格。
 *
 * 运行：cd packages/ui && npx vitest run src/primitives/__tests__/status-pill.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import StatusPill from '../status-pill/StatusPill.vue'

describe('StatusPill（spec §6.5 状态胶囊，六类白名单）', () => {
  it('六类各自渲染 label 与对应语义配色（用户可见文案 + 色双通道）', () => {
    const cases = [
      { status: 'pending', label: '待确认', cls: 'bg-warn-soft' },
      { status: 'waiting', label: '待回答', cls: 'bg-warn-soft' },
      { status: 'error', label: '出错', cls: 'bg-danger-soft' },
      { status: 'retrying', label: '重试中', cls: 'bg-warn-soft' },
      { status: 'working', label: '后台', cls: 'bg-accent-soft' },
      { status: 'dead', label: '已退出', cls: 'bg-surface-2' },
    ] as const
    for (const c of cases) {
      const w = mount(StatusPill, { props: { status: c.status, label: c.label } })
      expect(w.text(), c.status).toBe(c.label)
      expect(w.classes(), c.status).toContain(c.cls)
      // 规格：22px 高 + 12px 字（--m-text-cap）
      expect(w.classes(), c.status).toContain('h-[22px]')
      expect(w.classes(), c.status).toContain('text-[length:var(--m-text-cap)]')
    }
  })

  it('白名单外常态（streaming/done/stopped 等）不渲染——常态交状态点与页头状态行', () => {
    for (const status of ['streaming', 'done', 'stopped', 'compacting'] as const) {
      const w = mount(StatusPill, { props: { status, label: '任意' } })
      expect(w.find('span').exists(), status).toBe(false)
    }
  })

  it('命中六类但未传 label：不渲染（本原语不放死中文，文案由壳层 i18n 提供）', () => {
    const w = mount(StatusPill, { props: { status: 'waiting' } })
    expect(w.find('span').exists()).toBe(false)
  })
})
