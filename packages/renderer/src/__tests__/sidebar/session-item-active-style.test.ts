/**
 * 会话条目激活态样式测试（用户裁决 2026-10-06：对齐 demo .sess.is-active 形态）。
 *
 * 三视角（TEST-STRATEGY §3）：
 *  - 构建者白盒：active prop 驱动根节点激活类分支（bg-accent-soft + inset 竖条）
 *  - 使用者黑盒：激活条目标题文字可见且为中性色
 *  - 观察者形态：激活态 = accent 浅底（bg-accent-soft）+ 左侧 2px accent 竖条
 *    （inset shadow，不占布局）+ 标题中性色（不再 text-accent）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/session-item-active-style.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import SessionItem from '@/components/sidebar/SessionItem.vue'

const BASE_SESSION = {
  id: 'active-style-1',
  label: 'Active Session',
  cwd: '/p',
  lastActiveAt: 0,
}

function mountItem(active: boolean) {
  return mount(SessionItem, {
    props: {
      session: { ...BASE_SESSION },
      active,
      status: 'done' as never,
    },
  })
}

beforeEach(() => {
  // SessionItem setup 内 useProjectStore（D14 归入项目菜单），mount 需激活 pinia
  setActivePinia(createPinia())
})

describe('会话条目激活态样式（用户裁决 2026-10-06，对齐 demo .sess.is-active）', () => {
  it('激活条目：根节点带 accent 浅底（bg-accent-soft）与左侧 2px accent 竖条（inset shadow，不占布局）', () => {
    const wrapper = mountItem(true)
    const root = wrapper.find('.session-item')
    expect(root.classes()).toContain('bg-accent-soft')
    expect(root.classes()).toContain('shadow-[inset_2px_0_0_var(--accent)]')
    expect(root.classes()).not.toContain('hover:bg-surface-hover')
  })

  it('激活条目标题文字为中性色 text-neutral-fg，不再染 accent（使用者黑盒，用户可见 DOM）', () => {
    const wrapper = mountItem(true)
    const title = wrapper.findAll('span').find((s) => s.text() === 'Active Session')
    expect(title).toBeTruthy()
    const titleRow = title!.element.parentElement as HTMLElement
    expect(titleRow.className).toContain('text-neutral-fg')
    expect(titleRow.className).not.toContain('text-accent')
  })

  it('非激活条目无 accent 浅底（hover 底生效路径不变）', () => {
    const wrapper = mountItem(false)
    const root = wrapper.find('.session-item')
    expect(root.classes()).not.toContain('bg-accent-soft')
    expect(root.classes()).toContain('hover:bg-surface-hover')
  })
})
