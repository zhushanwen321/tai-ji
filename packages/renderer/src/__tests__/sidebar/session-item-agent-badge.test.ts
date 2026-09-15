/**
 * agent-managed-session U8 前端 badge + 「查看父 session」右键菜单测试。
 *
 * 三视角（TEST-STRATEGY §3）：
 *  - 构建者白盒：spawnSource / parentAgentSessionId 驱动 badge 与菜单的条件渲染分支
 *  - 使用者黑盒：右键 session → 菜单项出现 / 不出现；点菜单项 → navigateParent 事件链到 SessionList
 *  - 观察者形态：badge 为 accent 低饱和小标签（bg-accent-soft + text-accent + 10px），不抢左侧状态 icon 焦点
 *
 * 菜单经 reka ContextMenuPortal teleport 到 body（同 session-item-assign-project 的
 * attachTo: document.body + document.body 查询范式）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/session-item-agent-badge.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import type { SessionGroup } from '@taiji/shared'

import SessionItem from '@/components/sidebar/SessionItem.vue'
import SessionList from '@/components/sidebar/SessionList.vue'

/** agent 创建的 session fixture（spawnSource + 父 id，U8 新字段） */
const AGENT_SESSION = {
  id: 'u8-agent-1',
  label: 'agent 创建的会话',
  cwd: '/p',
  lastActiveAt: 0,
  spawnSource: 'agent' as const,
  parentAgentSessionId: 'u8-parent-1',
}

function mountItem(sessionOverrides: Record<string, unknown> = {}) {
  return mount(SessionItem, {
    attachTo: document.body,
    props: {
      session: { ...AGENT_SESSION, ...sessionOverrides },
      active: false,
      status: 'done' as never,
    },
  })
}

/** 挂载含一个 agent session + 一个 user session 的 SessionList（U8-B3 事件链用） */
function mountList(sessions: Array<Record<string, unknown>>) {
  return mount(SessionList, {
    attachTo: document.body,
    props: {
      groups: [{ cwd: '/p', sessions }] as unknown as SessionGroup[],
      activeId: null,
      statusOf: () => 'done' as never,
    },
  })
}

/** 对 session item 根节点触发 contextmenu（reka ContextMenuTrigger 监听该事件）并等内容渲染。
 *  Trigger 内部先 await nextTick 再 open，故多等一帧保证 Portal 内容落 body。 */
async function openContextMenu(wrapper: { find: (sel: string) => { trigger: (ev: string) => Promise<void> } }) {
  await wrapper.find('.session-item').trigger('contextmenu')
  await nextTick()
  await nextTick()
}

/** body 中的「查看父 session」菜单项元素（无则 null） */
function findViewParentItem(): HTMLElement | null {
  return document.body.querySelector('[data-testid="session-view-parent-item"]')
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.removeItem('taiji:session-markers')
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('U8-B1 agent badge 渲染（SessionItem）', () => {
  it('U8-B1 spawnSource=agent → session-agent-badge 存在且可见文本为 AI（使用者黑盒）', () => {
    const wrapper = mountItem()
    const badge = wrapper.find('[data-testid="session-agent-badge"]')
    expect(badge.exists()).toBe(true)
    // 用户可见 DOM：badge 文本就是 'AI' 标记
    expect(badge.text()).toBe('AI')
  })

  it('U8-B1 spawnSource=user 与 undefined → 均不渲染 badge（构建者白盒条件分支）', () => {
    const userWrapper = mountItem({ id: 'u8-user-1', spawnSource: 'user' })
    expect(userWrapper.find('[data-testid="session-agent-badge"]').exists()).toBe(false)

    // spawnSource 未写（旧数据/普通用户 session）同样无 badge
    const unsetWrapper = mountItem({ id: 'u8-unset-1', spawnSource: undefined, parentAgentSessionId: undefined })
    expect(unsetWrapper.find('[data-testid="session-agent-badge"]').exists()).toBe(false)
  })

  it('U8-B1 badge 形态：accent 低饱和小标签（bg-accent-soft + text-accent + 10px），不抢左侧状态 icon（观察者形态）', () => {
    const wrapper = mountItem()
    const badge = wrapper.find('[data-testid="session-agent-badge"]')
    // 对齐项目 accent 低饱和配对（popover-styles SELECTED_ITEM_CLASS 同源）
    expect(badge.classes()).toContain('bg-accent-soft')
    expect(badge.classes()).toContain('text-accent')
    // 克制尺寸：10px 小标签，与标题 12px 拉开层级
    expect(badge.classes()).toContain('text-[length:var(--text-3xs)]')
    // 状态信号焦点仍在左侧 7px 单一 icon（badge 不替代它）
    expect(wrapper.find('[data-testid="session-icon"]').exists()).toBe(true)
  })
})

describe('U8-B2 右键「查看父 session」菜单（SessionItem）', () => {
  it('U8-B2 agent session（有 parentAgentSessionId）右键 → 出现「查看父 session」菜单项（使用者黑盒）', async () => {
    const wrapper = mountItem()
    await openContextMenu(wrapper)

    const item = findViewParentItem()
    expect(item).not.toBeNull()
    // 用户可见 DOM：菜单项文案
    expect(item!.textContent).toContain('查看父 session')
  })

  it('U8-B2 user session 右键 → 无「查看父 session」项（force-quit 功能上线后 user session 有强制退出项，菜单容器会渲染）', async () => {
    const wrapper = mountItem({ id: 'u8-user-2', spawnSource: 'user' })
    await openContextMenu(wrapper)

    expect(findViewParentItem()).toBeNull()
    // [更新 2026-XX force-quit] 原断言「整块菜单不渲染」已失效：非 dead session 现在始终挂
    // 「强制退出」菜单项（sidebar 强制退出逃生入口），菜单容器随之渲染。此处锁定新行为：
    // 容器存在但仅含 forceQuit 一项，无 viewParent。
    expect(document.body.querySelector('[data-testid="session-context-menu"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="session-force-quit-item"]')).not.toBeNull()
  })

  it('U8-B2 agent session 但无 parentAgentSessionId → 右键无菜单项（有 badge 无导航目标，构建者白盒）', async () => {
    const wrapper = mountItem({ id: 'u8-agent-no-parent', parentAgentSessionId: undefined })
    // badge 仍显示（标记来源）
    expect(wrapper.find('[data-testid="session-agent-badge"]').exists()).toBe(true)
    await openContextMenu(wrapper)
    expect(findViewParentItem()).toBeNull()
  })
})

describe('U8-B3 navigateParent 事件链（SessionItem → SessionList）', () => {
  it('U8-B3 点菜单项 → SessionItem emit navigateParent 携带 parentAgentSessionId（构建者白盒）', async () => {
    const wrapper = mountItem()
    await openContextMenu(wrapper)

    findViewParentItem()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(wrapper.emitted('navigateParent')).toEqual([['u8-parent-1']])
  })

  it('U8-B3 SessionList 层：点菜单项后收到 navigateParent 且 payload 含 parentAgentSessionId（使用者黑盒全链路）', async () => {
    const wrapper = mountList([
      { ...AGENT_SESSION },
      { id: 'u8-user-3', label: '用户会话', cwd: '/p', lastActiveAt: 0, spawnSource: 'user' },
    ])
    await openContextMenu(wrapper)

    const item = findViewParentItem()
    expect(item).not.toBeNull()
    item!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    // SessionList 转发链路：payload 单字符串 = parentAgentSessionId
    const emitted = wrapper.emitted('navigateParent')
    expect(emitted).toBeTruthy()
    expect(emitted![0]).toEqual(['u8-parent-1'])
  })
})
