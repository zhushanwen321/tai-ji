/**
 * StatusDot 原语测试（remote-use-mobile-v2 §6.9 / spec §6.5）。
 *
 * 覆盖：状态 → 语义色映射（accent 脉冲 / warn / danger / success / dim / faint 全档）、
 * aria-label（spec「无文字的纯点必须带 aria-label」）、尺寸档。
 * 断言口径 = 类名与 DOM 属性（用户可见样式载体；happy-dom 无 CSS 引擎，类存在即契约）。
 *
 * 运行：cd packages/ui && npx vitest run src/primitives/__tests__/status-dot.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import StatusDot from '../status-dot/StatusDot.vue'

describe('StatusDot（spec §6.5 状态色点）', () => {
  it('进行族（streaming/pending/compacting/working）= accent 底 + 脉冲类', () => {
    for (const status of ['streaming', 'pending', 'compacting', 'working'] as const) {
      const w = mount(StatusDot, { props: { status, label: '进行中' } })
      expect(w.classes(), status).toContain('bg-accent')
      expect(w.classes(), status).toContain('status-dot--pulse')
    }
  })

  it('等待族（waiting/retrying）= warn；error = danger；done = success', () => {
    expect(mount(StatusDot, { props: { status: 'waiting', label: 'x' } }).classes()).toContain('bg-warn')
    expect(mount(StatusDot, { props: { status: 'retrying', label: 'x' } }).classes()).toContain('bg-warn')
    expect(mount(StatusDot, { props: { status: 'error', label: 'x' } }).classes()).toContain('bg-danger')
    expect(mount(StatusDot, { props: { status: 'done', label: 'x' } }).classes()).toContain('bg-success')
  })

  it('stopped = dim；dead = faint（两者不脉冲）', () => {
    const stopped = mount(StatusDot, { props: { status: 'stopped', label: 'x' } })
    const dead = mount(StatusDot, { props: { status: 'dead', label: 'x' } })
    expect(stopped.classes()).toContain('bg-neutral-dim')
    expect(dead.classes()).toContain('bg-neutral-faint')
    expect(stopped.classes()).not.toContain('status-dot--pulse')
    expect(dead.classes()).not.toContain('status-dot--pulse')
  })

  it('无文字纯点：label 上 aria-label（spec「颜色 + 文字双通道；无文字的纯点必须带 aria-label」）', () => {
    const w = mount(StatusDot, { props: { status: 'error', label: '会话出错' } })
    expect(w.attributes('aria-label')).toBe('会话出错')
    expect(w.attributes('role')).toBe('img')
  })

  it('尺寸档：缺省 8px（size-2），sm = 6px（size-1.5）', () => {
    expect(mount(StatusDot, { props: { status: 'done', label: 'x' } }).classes()).toContain('size-2')
    expect(mount(StatusDot, { props: { status: 'done', label: 'x', size: 'sm' } }).classes()).toContain('size-1.5')
  })
})
