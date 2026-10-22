/**
 * SessionItem 悬停归档钮测试（session-archive 设计 D6/D12/D13，u-renderer-entry）。
 *
 * 覆盖验收条款：
 * - 两段确认 accent 态：首击进确认态（accent 类 + Check 图标 + title「再次点击确认归档」，
 *   不 emit）；再击 emit archive + 确认态复位
 * - 生成中禁用 + title（D13 renderer 拦截层）：DerivedStatus 六瞬态 → disabled +
 *   title「生成中不可归档」；点击不 emit
 * - 完成态可归档：title「归档」，两段确认链路可走通
 * - 图标语义（D12，2026-10-21 裁决改归档箱）：非确认态 Archive、确认态 Check
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/session-item-archive-button.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SessionItem from '@/components/sidebar/SessionItem.vue'

function mountItem(status: string, id = 's1') {
  return mount(SessionItem, {
    attachTo: document.body,
    props: {
      session: { id, label: `会话 ${id}`, cwd: '/p', lastActiveAt: 0 },
      active: false,
      status: status as never,
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.removeItem('taiji:session-markers')
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('SessionItem 归档钮两段确认（D6 accent 轻确认）', () => {
  it('首击 → 确认态（accent 类 + Check 图标 + title 提示），不 emit archive', async () => {
    const wrapper = mountItem('done')
    const btn = wrapper.find('[data-testid="session-archive-btn"]')

    await btn.trigger('click')

    expect(btn.classes()).toContain('bg-accent-soft')
    expect(btn.classes()).toContain('text-accent')
    // 确认态非 danger（归档非破坏性——区别于原删除钮红底）
    expect(btn.classes()).not.toContain('bg-danger')
    expect(btn.attributes('title')).toBe('再次点击确认归档')
    expect(btn.find('svg.lucide-check').exists()).toBe(true)
    expect(wrapper.emitted('archive')).toBeUndefined()
    wrapper.unmount()
  })

  it('确认态再击 → emit archive(sessionId) + 确认态复位（Archive 图标回归）', async () => {
    const wrapper = mountItem('done')
    const btn = wrapper.find('[data-testid="session-archive-btn"]')

    await btn.trigger('click')
    await btn.trigger('click')

    expect(wrapper.emitted('archive')).toEqual([['s1']])
    expect(btn.classes()).not.toContain('bg-accent-soft')
    expect(btn.find('svg.lucide-archive').exists()).toBe(true)
    wrapper.unmount()
  })

  it('默认态：title「归档」+ Archive 图标（与归档域入口/空态同族，区别于标记完成的 CircleCheck）', () => {
    const wrapper = mountItem('done')
    const btn = wrapper.find('[data-testid="session-archive-btn"]')
    expect(btn.attributes('title')).toBe('归档')
    // done 终态不禁用（生成中六瞬态才禁用）
    expect(btn.attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })
})

describe('SessionItem 归档钮生成中禁用（D13 renderer 拦截层）', () => {
  it.each(['streaming', 'pending', 'compacting', 'waiting', 'retrying', 'working'] as const)(
    'status=%s → disabled + title「生成中不可归档」，点击不 emit',
    async (status) => {
      const wrapper = mountItem(status)
      const btn = wrapper.find('[data-testid="session-archive-btn"]')

      expect(btn.attributes('disabled')).toBeDefined()
      expect(btn.attributes('title')).toBe('生成中不可归档')

      await btn.trigger('click')
      expect(wrapper.emitted('archive')).toBeUndefined()
      expect(wrapper.emitted('update:confirming')).toBeUndefined()
      wrapper.unmount()
    },
  )

  it.each(['done', 'stopped', 'error'] as const)('终态 status=%s → 可点击（非禁用）', (status) => {
    const wrapper = mountItem(status)
    expect(wrapper.find('[data-testid="session-archive-btn"]').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })
})
