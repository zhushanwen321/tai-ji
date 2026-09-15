/**
 * 导入 fresh「导入」徽标渲染测试（import-session u7，SessionItem 消费侧）。
 *
 * 三视角（TEST-STRATEGY §3）：
 *  - 构建者白盒：isImportedFresh(session.id) 驱动徽标 v-if 与 fading class 分支
 *  - 使用者黑盒：导入成功后侧边栏该会话条目标「导入」徽标，数秒后淡出消失（设计 §3.1）
 *  - 观察者形态：accent 低饱和小标签（bg-accent-soft + text-accent，与 agent badge 同源），
 *    fade 阶段 opacity 过渡降维而非瞬间消失
 *
 * 状态机在 useImportSession 模块级（Sidebar 写 / SessionItem 读，isUnread 同款范式），
 * 此处直接驱动 markImportedFresh 验证渲染链路；Sidebar 接线（imported 事件 → 标记）
 * 见 sidebar-import-entry.test.ts TC4。
 *
 * fake timers 控制 3.2s 实显 / 200ms 淡出两段计时。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/session-item-import-fresh.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

import SessionItem from '@/components/sidebar/SessionItem.vue'
import {
  markImportedFresh,
  __resetImportedFreshForTest,
  IMPORT_FRESH_VISIBLE_MS,
  IMPORT_FRESH_FADE_MS,
} from '@/composables/features/sidebar/useImportSession'

const SESSION = {
  id: 'imported-session-1',
  label: '刚导入的会话',
  cwd: '/p',
  lastActiveAt: 0,
}

function mountItem(id: string = SESSION.id) {
  return mount(SessionItem, {
    attachTo: document.body,
    props: {
      session: { ...SESSION, id },
      active: false,
      status: 'done' as never,
    },
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  setActivePinia(createPinia())
  localStorage.removeItem('taiji:session-markers')
  __resetImportedFreshForTest()
})

afterEach(() => {
  document.body.innerHTML = ''
  __resetImportedFreshForTest()
  vi.useRealTimers()
})

describe('fresh「导入」徽标渲染（SessionItem × useImportSession fresh 状态机）', () => {
  it('标记后徽标可见：文案「导入」+ accent 低饱和形态（使用者黑盒 + 观察者形态）', async () => {
    const wrapper = mountItem()
    expect(wrapper.find('[data-testid="session-imported-fresh"]').exists()).toBe(false)

    markImportedFresh(SESSION.id)
    await nextTick()

    const badge = wrapper.find('[data-testid="session-imported-fresh"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('导入')
    // accent 低饱和配对（与 agent badge / ForkGroup fresh 同源 token）
    expect(badge.classes()).toContain('bg-accent-soft')
    expect(badge.classes()).toContain('text-accent')
  })

  it('淡出时序（demo doImport）：3.2s 实显 → fading 加 opacity-0 → 200ms 后移除', async () => {
    const wrapper = mountItem()
    markImportedFresh(SESSION.id)
    await nextTick()

    vi.advanceTimersByTime(IMPORT_FRESH_VISIBLE_MS)
    await nextTick()
    let badge = wrapper.find('[data-testid="session-imported-fresh"]')
    expect(badge.exists()).toBe(true)
    // 观察者：淡出阶段走 opacity 过渡类，非瞬间卸载
    expect(badge.classes()).toContain('opacity-0')
    expect(badge.classes()).toContain('transition-opacity')

    vi.advanceTimersByTime(IMPORT_FRESH_FADE_MS)
    await nextTick()
    badge = wrapper.find('[data-testid="session-imported-fresh"]')
    expect(badge.exists()).toBe(false)
  })

  it('未标记的 session 不渲染徽标（构建者白盒：per-session 隔离）', async () => {
    const wrapper = mountItem('other-session-2')
    markImportedFresh(SESSION.id)
    await nextTick()

    expect(wrapper.find('[data-testid="session-imported-fresh"]').exists()).toBe(false)
  })

  it('mount 后才标记也生效（响应式链路：isImportedFresh 订阅模块级集合）', async () => {
    const wrapper = mountItem()
    expect(wrapper.find('[data-testid="session-imported-fresh"]').exists()).toBe(false)

    markImportedFresh(SESSION.id)
    await nextTick()

    expect(wrapper.find('[data-testid="session-imported-fresh"]').exists()).toBe(true)
  })
})
