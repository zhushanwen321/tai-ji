/**
 * 会话条目激活态样式测试（demo .si.on 终态：workbench.css 文件尾「选中态两级范式」Tier B——
 * 无底无框，仅行文字提亮 fg；hover 底恒在（demo .si:hover 恒有背景，与激活态不排他））。
 *
 * 三视角（TEST-STRATEGY §3）：
 *  - 构建者白盒：active prop 驱动根节点类分支（激活无选中底/框）
 *  - 使用者黑盒：激活条目标题文字可见且为提亮的中性色
 *  - 观察者形态：激活态 = 无 bg-bg-elevated、无 accent 竖条/描边 + 行文字 text-neutral-fg
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

describe('会话条目激活态样式（demo .si.on Tier B：无底无框仅文字提亮）', () => {
  it('激活条目：根节点无选中底与竖条（行类不画选中框），保留行文字提亮', () => {
    const wrapper = mountItem(true)
    const root = wrapper.find('.session-item')
    expect(root.classes()).not.toContain('bg-bg-elevated')
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
