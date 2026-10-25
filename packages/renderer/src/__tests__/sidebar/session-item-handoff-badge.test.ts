/**
 * 已交接徽标组件测试（chat-flow-consistency U9 / 特殊流程 S8）。
 *
 * 三视角（TEST-STRATEGY §3）：
 *  - 构建者白盒：handedOffTo 驱动徽标条件渲染分支（handoffTargetLabel 注入与否驱动 title）
 *  - 使用者黑盒：已交接会话行可见「已交接」徽标；未交接会话无徽标
 *  - 观察者形态：中性 dim 描边小标签（不占 accent——accent 已被 [AI] 来源徽标占用）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/session-item-handoff-badge.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import SessionItem from '@/components/sidebar/SessionItem.vue'

const BASE_SESSION = {
  id: 'src-1',
  label: '源会话',
  cwd: '/p',
  lastActiveAt: 0,
}

function mountItem(sessionOverrides: Record<string, unknown> = {}, props: Record<string, unknown> = {}) {
  return mount(SessionItem, {
    attachTo: document.body,
    props: {
      session: { ...BASE_SESSION, ...sessionOverrides },
      active: false,
      status: 'done' as never,
      ...props,
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ''
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('S8 已交接徽标渲染（SessionItemDisplay）', () => {
  it('handedOffTo 非空 → session-handoff-badge 存在，徽标文本「已交接」', () => {
    const wrapper = mountItem({ handedOffTo: 'target-abc' })
    const badge = wrapper.find('[data-testid="session-handoff-badge"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('已交接')
  })

  it('未交接（无 handedOffTo）→ 徽标不渲染', () => {
    const wrapper = mountItem()
    expect(wrapper.find('[data-testid="session-handoff-badge"]').exists()).toBe(false)
  })

  it('title 显目标名（容器反查注入 handoffTargetLabel）；目标已删回退 id 前缀', () => {
    const withLabel = mountItem(
      { handedOffTo: 'target-abc' },
      { handoffTargetLabel: '交接后的新会话' },
    )
    expect(withLabel.find('[data-testid="session-handoff-badge"]').attributes('title')).toBe(
      '已交接至 交接后的新会话',
    )
    const withoutLabel = mountItem({ handedOffTo: 'target-abc12345' })
    expect(withoutLabel.find('[data-testid="session-handoff-badge"]').attributes('title')).toBe(
      '已交接至 target-a',
    )
  })

  it('观察者形态：徽标为中性描边小标签（border 描边 + dim 字，不占 accent）', () => {
    const wrapper = mountItem({ handedOffTo: 't' })
    const cls = wrapper.find('[data-testid="session-handoff-badge"]').attributes('class') ?? ''
    expect(cls).toContain('border-border-strong')
    expect(cls).toContain('text-neutral-dim')
    expect(cls).not.toContain('accent')
  })
})
