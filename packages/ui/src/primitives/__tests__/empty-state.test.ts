/**
 * EmptyState 原语测试（remote-use-mobile-v2 §6.9 / spec §6.7）。
 *
 * 覆盖：三要素（图标 + 一句说明 + 主行动插槽）渲染结构；description 缺省省略；
 * 用户可见 DOM 断言（图标 svg / 标题文本 / 行动区）。
 *
 * 运行：cd packages/ui && npx vitest run src/primitives/__tests__/empty-state.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { Inbox } from '@lucide/vue'
import EmptyState from '../empty-state/EmptyState.vue'

describe('EmptyState（spec §6.7 空态三要素）', () => {
  it('图标 + 标题 + 说明 + 主行动插槽全渲染（三要素缺一不可的结构载体）', () => {
    const w = mount(EmptyState, {
      props: { icon: Inbox, title: '没有进行中的会话', description: '新建一个任务开始' },
      slots: { default: '<button type="button">新建任务</button>' },
    })
    expect(w.find('svg').exists()).toBe(true)
    expect(w.find('[data-testid="empty-state-title"]').text()).toBe('没有进行中的会话')
    expect(w.find('[data-testid="empty-state-description"]').text()).toBe('新建一个任务开始')
    expect(w.find('[data-testid="empty-state-action"] button').text()).toBe('新建任务')
  })

  it('description 缺省：说明行不渲染，主行动仍可用', () => {
    const w = mount(EmptyState, {
      props: { icon: Inbox, title: '没有进行中的会话' },
      slots: { default: '<button type="button">新建任务</button>' },
    })
    expect(w.find('[data-testid="empty-state-description"]').exists()).toBe(false)
    expect(w.find('[data-testid="empty-state-title"]').text()).toBe('没有进行中的会话')
    expect(w.find('[data-testid="empty-state-action"]').exists()).toBe(true)
  })
})
