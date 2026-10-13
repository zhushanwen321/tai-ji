/**
 * 会话条目激活态样式测试（用户裁决 2026-10-13 demo 选型：选中 = 悬停同色实底 bg-surface-hover
 * + 行文字提亮 fg，无竖条无描边——选中强度 ≥ hover，同底靠字色拉开）。
 *
 * 三视角（TEST-STRATEGY §3）：
 *  - 构建者白盒：active prop 驱动根节点类分支（激活挂 bg-surface-hover）
 *  - 使用者黑盒：激活条目标题文字可见且为提亮的中性色
 *  - 观察者形态：激活态 = 无 accent 竖条/描边/elevated 底 + bg-surface-hover + text-neutral-fg
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

describe('会话条目激活态样式（选中 = 悬停同色实底 + 文字提亮）', () => {
  it('激活条目：根节点挂 bg-surface-hover（与 hover 同色实底），无竖条/elevated 底，保留行文字提亮', () => {
    const wrapper = mountItem(true)
    const root = wrapper.find('.session-item')
    expect(root.classes()).toContain('bg-surface-hover')
    expect(root.classes()).not.toContain('bg-bg-elevated')
    expect(root.classes()).not.toContain('bg-accent-soft')
    expect(root.classes()).not.toContain('shadow-[inset_2px_0_0_var(--accent)]')
    expect(root.classes()).toContain('text-neutral-fg')
  })

  it('激活条目标题文字为提亮中性色 text-neutral-fg（使用者黑盒，用户可见 DOM）', () => {
    const wrapper = mountItem(true)
    const title = wrapper.findAll('span').find((s) => s.text() === 'Active Session')
    expect(title).toBeTruthy()
    const titleRow = title!.element.parentElement as HTMLElement
    expect(titleRow.className).toContain('text-neutral-fg')
    expect(titleRow.className).not.toContain('text-accent')
  })

  it('非激活条目：无选中文字提亮，行根恒挂 hover 底（demo .si:hover 恒有背景）', () => {
    const wrapper = mountItem(false)
    const root = wrapper.find('.session-item')
    expect(root.classes()).toContain('hover:bg-surface-hover')
  })
})
