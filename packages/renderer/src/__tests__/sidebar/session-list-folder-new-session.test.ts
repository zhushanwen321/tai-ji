/**
 * SessionList.vue 目录行「+」新建按钮测试。
 *
 * 验证目录标题行的 folder-new-session-btn：
 * - 首屏渲染：每个目录组都有 + 按钮，且位于 folder-delete-btn 之前（删除按钮左侧）
 * - click + → emit('newSessionInFolder', cwd)
 * - 守卫差异：项目过滤隐藏部分 session 时（isFolderDeleteAvailable=false，删除按钮不渲染），
 *   + 按钮仍渲染（新建非破坏性，不受过滤守卫限制）
 * - + 点击不 emit deleteFolder，也不影响删除确认态
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/session-list-folder-new-session.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { SessionGroup } from '@taiji/shared'

import SessionList from '@/components/sidebar/SessionList.vue'
import { useProjectStore } from '@/stores/project'

function makeGroups(): SessionGroup[] {
  return [
    {
      cwd: '/p',
      sessions: [
        // 最小 session fixture（SessionItem 需 id/label/cwd/status）
        { id: 's1', label: '会话 1', cwd: '/p', status: 'idle', lastActiveAt: 1, modelId: 'm', tokenCount: 0 } as SessionGroup['sessions'][number],
      ],
    },
  ]
}

function mountList() {
  return mount(SessionList, {
    props: {
      groups: makeGroups(),
      activeId: 's1',
      statusOf: () => 'done' as never,
    },
  })
}

function findNewSessionButton(wrapper: ReturnType<typeof mountList>) {
  return wrapper.find('[data-testid="folder-new-session-btn"]')
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('SessionList 目录行 + 按钮首屏渲染', () => {
  it('+ 按钮存在于 DOM，title 为 newSessionInFolder 文案', () => {
    const wrapper = mountList()
    const btn = findNewSessionButton(wrapper)
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('title')).toBe('在此目录新建会话')
  })

  it('+ 按钮位于删除按钮左侧（DOM 顺序在前）', () => {
    const wrapper = mountList()
    const plus = findNewSessionButton(wrapper)
    const del = wrapper.find('[data-testid="folder-delete-btn"]')
    expect(del.exists()).toBe(true)
    expect(plus.element.compareDocumentPosition(del.element)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })
})

describe('SessionList 目录行 + 按钮点击交互', () => {
  it('click + → emit newSessionInFolder(cwd)，不 emit deleteFolder', async () => {
    const wrapper = mountList()
    await findNewSessionButton(wrapper)!.trigger('click')

    const emitted = wrapper.emitted('newSessionInFolder')
    expect(emitted).toBeTruthy()
    expect(emitted![0]).toEqual(['/p'])
    expect(wrapper.emitted('deleteFolder')).toBeFalsy()
  })

  it('删除按钮进确认态后点 + → 确认态复位（window pointerdown 收口），不 emit deleteFolder', async () => {
    const wrapper = mountList()
    await wrapper.find('[data-testid="folder-delete-btn"]').trigger('click')
    // 确认态：title 变 deleteFolderConfirm 文案
    expect(wrapper.find('[data-testid="folder-delete-btn"]').attributes('title'))
      .toBe('确认删除此文件夹下所有会话？')

    // pointerdown 先于 click 触发（与真实事件顺序一致）；在按钮元素上 dispatch 冒泡到 window
    // （直接在 window 上 dispatch 时 happy-dom 的 e.target=window 无 closest）
    findNewSessionButton(wrapper)!.element.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true }),
    )
    await findNewSessionButton(wrapper)!.trigger('click')

    expect(wrapper.emitted('newSessionInFolder')).toBeTruthy()
    expect(wrapper.emitted('deleteFolder')).toBeFalsy()
  })
})

describe('SessionList 目录行 + 按钮 vs 删除按钮守卫差异', () => {
  it('项目过滤隐藏部分 session 时：删除按钮不渲染，+ 按钮仍渲染', async () => {
    // 命名 project p1 激活；同 cwd 组内 s1 归 p1（可见）、s2 归 p2（被过滤隐藏）
    const store = useProjectStore()
    store.projects = [
      { id: 'proj-default', name: '', lastUsedAt: 0 },
      { id: 'p1', name: 'P1', lastUsedAt: 1 },
      { id: 'p2', name: 'P2', lastUsedAt: 1 },
    ]
    store.activeProjectId = 'p1'

    const wrapper = mount(SessionList, {
      props: {
        groups: [
          {
            cwd: '/p',
            sessions: [
              { id: 's1', label: '会话 1', cwd: '/p', status: 'idle', lastActiveAt: 1, modelId: 'm', tokenCount: 0, projectId: 'p1' } as SessionGroup['sessions'][number],
              { id: 's2', label: '会话 2', cwd: '/p', status: 'idle', lastActiveAt: 1, modelId: 'm', tokenCount: 0, projectId: 'p2' } as SessionGroup['sessions'][number],
            ],
          },
        ],
        activeId: 's1',
        statusOf: () => 'done' as never,
      },
    })

    // 可见 1 < 全量 2 → 删除按钮隐藏（review MF-2 守卫），+ 按钮不受守卫
    expect(wrapper.find('[data-testid="folder-delete-btn"]').exists()).toBe(false)
    const plus = findNewSessionButton(wrapper)
    expect(plus.exists()).toBe(true)

    await plus.trigger('click')
    expect(wrapper.emitted('newSessionInFolder')![0]).toEqual(['/p'])
  })
})
