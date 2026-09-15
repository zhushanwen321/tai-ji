/**
 * SessionList.vue folder 删除按钮测试（W2TC5）。
 *
 * 验证 folder 标题行删除按钮的两段式确认交互：
 * - 首屏渲染：folder 标题行 + 删除按钮存在
 * - 首次 click：folderConfirmingCwd 变化，按钮 title 变 deleteFolderConfirm 文案，图标变 Check
 * - 第二次 click：emit('deleteFolder', cwd)
 * - Esc / mouseleave：folderConfirmingCwd 重置，再 click 又是首次态
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/session-list-folder-delete.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import type { SessionGroup } from '@taiji/shared'

import SessionList from '@/components/sidebar/SessionList.vue'

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

/**
 * 定位 folder 标题行的删除按钮。
 * S5：用组3 新增的 data-testid="folder-delete-btn" 精确定位，不再依赖 title 匹配——
 * SessionItem 的 session 级删除按钮 title 同为 '删除'（sidebar.sessionItem.delete），
 * 旧实现靠 folder 按钮在 DOM 中靠前的顺序才「碰巧」选对，模板重排会静默点错按钮。
 * folder 按钮单一 testid（初始态/确认态共用），与 SessionItem 的 testid（无 folder-delete-btn）不冲突。
 */
function findFolderDeleteButton(wrapper: ReturnType<typeof mountList>) {
  return wrapper.find('[data-testid="folder-delete-btn"]')
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('SessionList folder 删除按钮首屏渲染', () => {
  it('folder 标题行 + 删除按钮存在于 DOM', () => {
    const wrapper = mountList()
    // cwd 末段渲染在标题行
    expect(wrapper.text()).toContain('p')
    // 删除按钮存在（data-testid 锚定，title 为初始态文案）
    const btn = findFolderDeleteButton(wrapper)
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('title')).toBe('删除')
  })
})

describe('SessionList folder 删除两段式确认（W2TC5）', () => {
  it('首次 click → 确认态（title 变 deleteFolderConfirm）；不 emit deleteFolder', async () => {
    const wrapper = mountList()
    const btn = findFolderDeleteButton(wrapper)!
    expect(btn.attributes('title')).toBe('删除')

    await btn.trigger('click')

    // 确认态：title 变 deleteFolderConfirm 文案
    const confirmBtn = findFolderDeleteButton(wrapper)!
    expect(confirmBtn.attributes('title')).toBe('确认删除此文件夹下所有会话？')
    // 首次点击不 emit
    expect(wrapper.emitted('deleteFolder')).toBeFalsy()
  })

  it('确认态第二次 click → emit deleteFolder(cwd)，folderConfirmingCwd 复位', async () => {
    const wrapper = mountList()
    const btn = findFolderDeleteButton(wrapper)!

    // 第一次进确认态
    await btn.trigger('click')
    // 第二次确认 → emit
    const confirmBtn = findFolderDeleteButton(wrapper)!
    await confirmBtn.trigger('click')

    const emitted = wrapper.emitted('deleteFolder')
    expect(emitted).toBeTruthy()
    expect(emitted![0]).toEqual(['/p'])
    // emit 后 folderConfirmingCwd 复位（title 回到初始态）
    await nextTick()
    const resetBtn = findFolderDeleteButton(wrapper)!
    expect(resetBtn.attributes('title')).toBe('删除')
  })

  it('Esc 重置 folderConfirmingCwd，再 click 仍是首次态（不 emit）', async () => {
    const wrapper = mountList()
    const btn = findFolderDeleteButton(wrapper)!

    // 进确认态
    await btn.trigger('click')
    expect(findFolderDeleteButton(wrapper)!.attributes('title')).toBe('确认删除此文件夹下所有会话？')

    // dispatch Esc keydown（SessionList 监听 window keydown，按 Esc 自增 escCount → watch 复位）
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()

    // 复位回初始态
    expect(findFolderDeleteButton(wrapper)!.attributes('title')).toBe('删除')

    // 再 click 是首次态（不 emit）
    await findFolderDeleteButton(wrapper)!.trigger('click')
    expect(wrapper.emitted('deleteFolder')).toBeFalsy()
    expect(findFolderDeleteButton(wrapper)!.attributes('title')).toBe('确认删除此文件夹下所有会话？')
  })

  it('mouseleave 重置 folderConfirmingCwd（按钮容器 mouseleave 复位确认态）', async () => {
    const wrapper = mountList()
    const btn = findFolderDeleteButton(wrapper)!
    await btn.trigger('click')
    expect(findFolderDeleteButton(wrapper)!.attributes('title')).toBe('确认删除此文件夹下所有会话？')

    // mouseleave 绑定在 ml-auto 容器 div（包裹 Button），对其触发 mouseleave
    // 容器含 ml-auto class
    const container = wrapper.find('.ml-auto')
    expect(container.exists()).toBe(true)
    await container.trigger('mouseleave')

    expect(findFolderDeleteButton(wrapper)!.attributes('title')).toBe('删除')
  })
})
