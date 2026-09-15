/**
 * SessionItem「引用到输入区」写入侧测试（四符号体系 §3.1.2 侧边栏直引，U2d）。
 *
 * 覆盖：
 *  - 有活跃 session：点击 hover 引用按钮 → pendingInjection 写入
 *    { target:'current', sessionId:<活跃 id>, refSessionId:<本条 id>, label:<本条 label> }
 *    （目标 = 当前 composer 所在 session，被引用 = sidebar 点的那条，两者独立）
 *  - landing 态（无活跃 session）：target='new' + sessionId 强制 null（landing composer 消费）
 *  - 引用自身（active === 本条 id）：正常注入，无特判
 *
 * 消费侧（Composer watch → insertSessionChip → chip DOM）见
 * __tests__/panel/composer-session-injection.test.ts。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/session-item-quote.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

// sessionStore mock：SessionItem 读 active 决定注入目标路由（可变 active 覆盖两场景）
const sessionState = vi.hoisted(() => ({
  active: undefined as { id: string; cwd: string } | undefined,
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ active: sessionState.active, list: [], applySnapshot: vi.fn() }),
}))

import SessionItem from '@/components/sidebar/SessionItem.vue'
import { composerInjectionStore } from '@/composables/panel/composer-injection-store'

/** 本条被引用 session 的 fixture（sidebar 列表项） */
const ITEM = { id: 's-item', label: '会话条目', cwd: '/p', lastActiveAt: 0 }

function mountItem(): ReturnType<typeof mount> {
  return mount(SessionItem, {
    attachTo: document.body,
    props: { session: ITEM, active: false, status: 'done' as never },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.removeItem('taiji:session-markers')
  composerInjectionStore.clearInjection()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('SessionItem 引用到输入区（写入侧）', () => {
  it('有活跃 session → target=current：目标 = 活跃 session，被引用 = 本条 session', async () => {
    sessionState.active = { id: 's-cur', cwd: '/p' }
    const wrapper = mountItem()
    const btn = wrapper.find('[data-testid="quote-to-composer-btn"]')
    expect(btn.exists()).toBe(true)
    await btn.trigger('click')

    const store = composerInjectionStore
    expect(store.pendingInjection.value).toMatchObject({
      target: 'current',
      sessionId: 's-cur',
      refSessionId: 's-item',
      label: '会话条目',
    })
  })

  it('landing 态（无活跃 session）→ target=new + sessionId null（landing composer 消费）', async () => {
    sessionState.active = undefined
    const wrapper = mountItem()
    await wrapper.find('[data-testid="quote-to-composer-btn"]').trigger('click')

    const store = composerInjectionStore
    expect(store.pendingInjection.value).toMatchObject({
      target: 'new',
      sessionId: null,
      refSessionId: 's-item',
      label: '会话条目',
    })
  })

  it('引用自身（活跃 session 即本条）→ 正常注入无特判', async () => {
    sessionState.active = { id: 's-item', cwd: '/p' }
    const wrapper = mountItem()
    await wrapper.find('[data-testid="quote-to-composer-btn"]').trigger('click')

    const store = composerInjectionStore
    expect(store.pendingInjection.value).toMatchObject({
      target: 'current',
      sessionId: 's-item',
      refSessionId: 's-item',
    })
  })
})
