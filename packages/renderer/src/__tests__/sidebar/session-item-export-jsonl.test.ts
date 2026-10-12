/**
 * sidebar 导出 JSONL（export JSONL）前端链路测试。
 *
 * 三视角（TEST-STRATEGY §3）：
 *  - 构建者白盒：sessionFile prop 驱动菜单项禁用分支（pi 延迟写入窗口 → data-disabled）
 *  - 使用者黑盒：右键 session → 「导出 JSONL」菜单项出现；单击即 emit（无破坏性，
 *    不进两段式确认）
 *  - 观察者形态：禁用态 title 提示存在（「会话尚未产生记录文件」），可用态无该提示
 *
 * 菜单经 reka ContextMenuPortal teleport 到 body（同 session-item-force-quit.test.ts 的
 * attachTo: document.body + body 查询范式）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/session-item-export-jsonl.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import type { SessionGroup } from '@taiji/shared'

import SessionItem from '@/components/sidebar/SessionItem.vue'
import SessionList from '@/components/sidebar/SessionList.vue'

/** 带 sessionFile 的普通 session fixture */
const SESSION_WITH_FILE = {
  id: 'exp-1',
  label: '我的会话',
  cwd: '/p',
  lastActiveAt: 0,
  sessionFile: '/data/agent/sessions/c-p/exp-1.jsonl',
}

function mountItem(sessionOverrides: Record<string, unknown> = {}) {
  return mount(SessionItem, {
    attachTo: document.body,
    props: {
      session: { ...SESSION_WITH_FILE, ...sessionOverrides },
      active: false,
      status: 'done' as never,
    },
  })
}

/** 挂载含一条 session 的 SessionList（转发链路用） */
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

function findExportItem(): HTMLElement | null {
  return document.body.querySelector('[data-testid="session-export-jsonl-item"]')
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.removeItem('taiji:session-markers')
})

afterEach(() => {
  document.body.innerHTML = ''
})


/** 断言「导出 JSONL」菜单项渲染 + 文案单源（返回该 item 供可用态差异断言）。 */
function expectExportItemRendered(): HTMLElement | null {
  const item = findExportItem()
  expect(item).not.toBeNull()
  expect(item!.textContent).toContain('导出 JSONL')
  return item
}

describe('导出 JSONL 菜单项渲染（SessionItem）', () => {
  it('右键 session → 「导出 JSONL」菜单项出现且可用（使用者黑盒）', async () => {
    const wrapper = mountItem()
    await openContextMenu(wrapper)

    const item = expectExportItemRendered()
    expect(item!.hasAttribute('data-disabled')).toBe(false)
    expect(item!.getAttribute('title')).toBeNull()
  })

  it('sessionFile 缺失（pi 延迟写入窗口）→ 菜单项禁用 + title 提示（构建者白盒 + 观察者形态）', async () => {
    const wrapper = mountItem({ sessionFile: undefined })
    await openContextMenu(wrapper)

    const item = expectExportItemRendered()
    expect(item!.hasAttribute('data-disabled')).toBe(true)
    expect(item!.getAttribute('title')).toContain('会话尚未产生记录文件')
  })
})

describe('导出 JSONL 单击 emit（SessionItem）', () => {
  it('单击即 emit exportJsonl，payload = main 侧 IPC 请求体（sessionId + sessionFile + suggestedName=label.jsonl）', async () => {
    const wrapper = mountItem()
    await openContextMenu(wrapper)

    findExportItem()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(wrapper.emitted('exportJsonl')).toEqual([[
      {
        sessionId: 'exp-1',
        sessionFile: '/data/agent/sessions/c-p/exp-1.jsonl',
        suggestedName: '我的会话.jsonl',
      },
    ]])
  })

  it('禁用态点击不 emit（sessionFile 缺失时入口不可用）', async () => {
    const wrapper = mountItem({ sessionFile: undefined })
    await openContextMenu(wrapper)

    findExportItem()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(wrapper.emitted('exportJsonl')).toBeUndefined()
  })
})

describe('exportJsonl 事件链（SessionItem → SessionList）', () => {
  it('SessionList 层收到 exportJsonl 且 payload 原样透传（全链路）', async () => {
    const wrapper = mountList([{ ...SESSION_WITH_FILE }])
    await openContextMenu(wrapper)

    findExportItem()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(wrapper.emitted('exportJsonl')).toEqual([[
      {
        sessionId: 'exp-1',
        sessionFile: '/data/agent/sessions/c-p/exp-1.jsonl',
        suggestedName: '我的会话.jsonl',
      },
    ]])
  })
})
