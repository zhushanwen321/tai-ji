/**
 * sidebar 强制退出（force quit）前端链路测试。
 *
 * 三视角（TEST-STRATEGY §3）：
 *  - 构建者白盒：canForceQuit（非 dead）/ hasAgentParent 驱动菜单条件渲染分支；
 *    confirmingQuit 两段式确认状态机
 *  - 使用者黑盒：右键 session → 「强制退出」菜单项出现/不出现；首击进确认态、再击才 emit
 *  - 观察者形态：确认态 danger 底色（bg-danger），与非破坏性菜单项视觉分层
 *
 * 菜单经 reka ContextMenuPortal teleport 到 body（同 session-item-agent-badge 的
 * attachTo: document.body + body 查询范式）。两段确认依赖 reka ContextMenuItem select
 * event cancelable —— handler preventDefault 阻止菜单自动关闭。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/session-item-force-quit.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import type { SessionGroup } from '@taiji/shared'

import SessionItem from '@/components/sidebar/SessionItem.vue'
import SessionList from '@/components/sidebar/SessionList.vue'

/** 普通 user session fixture（无 agent 血缘） */
const USER_SESSION = {
  id: 'fq-user-1',
  label: '卡死的会话',
  cwd: '/p',
  lastActiveAt: 0,
  spawnSource: 'user' as const,
}

function mountItem(sessionOverrides: Record<string, unknown> = {}) {
  return mount(SessionItem, {
    attachTo: document.body,
    props: {
      session: { ...USER_SESSION, ...sessionOverrides },
      active: false,
      status: 'done' as never,
    },
  })
}

/** 挂载含一条 user session 的 SessionList（转发链路用） */
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

async function openContextMenu(wrapper: { find: (sel: string) => { trigger: (ev: string) => Promise<void> } }) {
  await wrapper.find('.session-item').trigger('contextmenu')
  await nextTick()
  await nextTick()
}

function findForceQuitItem(): HTMLElement | null {
  return document.body.querySelector('[data-testid="session-force-quit-item"]')
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.removeItem('taiji:session-markers')
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('强制退出菜单条件渲染（SessionItem）', () => {
  it('user session 右键 → 出现「强制退出」菜单项（此前 user session 无任何菜单项，现在有逃生入口）（使用者黑盒）', async () => {
    const wrapper = mountItem()
    await openContextMenu(wrapper)

    const item = findForceQuitItem()
    expect(item).not.toBeNull()
    expect(item!.textContent).toContain('强制退出')
    // 初始为非确认态文案（不含「确认」前缀）
    expect(item!.textContent).not.toContain('确认')
  })

  it('dead session 右键 → 不出现「强制退出」（进程已退出无需强杀，点击走 restore）（构建者白盒）', async () => {
    const wrapper = mountItem({ status: 'dead' })
    await openContextMenu(wrapper)

    expect(findForceQuitItem()).toBeNull()
    // Portal 整块不渲染（非 agent session 且不可强退时无任何菜单项）
    expect(document.body.querySelector('[data-testid="session-context-menu"]')).toBeNull()
  })

  it('agent-spawned session（有父 id）→ 「查看父 session」与「强制退出」两项并存（条件组合）', async () => {
    const wrapper = mountItem({
      id: 'fq-agent-1',
      spawnSource: 'agent',
      parentAgentSessionId: 'fq-parent-1',
    })
    await openContextMenu(wrapper)

    expect(document.body.querySelector('[data-testid="session-view-parent-item"]')).not.toBeNull()
    expect(findForceQuitItem()).not.toBeNull()
  })
})

describe('强制退出两段式确认（SessionItem）', () => {
  it('首击进入确认态（文案变「确认强制退出？」+ danger 底色）且菜单保持打开；再击才 emit forceQuit（使用者黑盒 + 观察者形态）', async () => {
    const wrapper = mountItem()
    await openContextMenu(wrapper)

    // 首击：进入确认态，preventDefault 阻止 reka 自动关闭菜单
    findForceQuitItem()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    const confirmed = findForceQuitItem()
    expect(confirmed).not.toBeNull() // 菜单未关闭
    expect(confirmed!.textContent).toContain('确认强制退出？')
    expect(confirmed!.className).toContain('bg-danger')
    // 未 emit（两段式：首击不触发）
    expect(wrapper.emitted('forceQuit')).toBeUndefined()

    // 再击：emit 并复位
    confirmed!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(wrapper.emitted('forceQuit')).toEqual([['fq-user-1']])
  })
})

describe('forceQuit 事件链（SessionItem → SessionList）', () => {
  it('SessionList 层：两段确认后收到 forceQuit 且 payload 为 sessionId（全链路）', async () => {
    const wrapper = mountList([{ ...USER_SESSION }])
    await openContextMenu(wrapper)

    findForceQuitItem()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    findForceQuitItem()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(wrapper.emitted('forceQuit')).toEqual([['fq-user-1']])
  })

  it('SessionList 层：SessionItem 上透传监听已接线（vi 断言模板绑定存在性由上条用例覆盖，此处锁 dead 不渲染）', async () => {
    const wrapper = mountList([
      { ...USER_SESSION, status: 'dead', id: 'fq-dead-1' },
    ])
    await openContextMenu(wrapper)

    expect(findForceQuitItem()).toBeNull()
    expect(wrapper.emitted('forceQuit')).toBeUndefined()
  })
})
