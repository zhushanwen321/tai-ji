/**
 * SessionList 默认项目区（2026-10-13 方案 A）事件接线与目录模式渲染补测。
 *
 * 背景：coverage gate 指出分支新增可执行行未触达，本文件补齐两类缺口：
 * - 平铺默认区 SessionItem 的 @select/@rename/@delete 透传（模板事件绑定行）：
 *   既有 session-list-project-filter 只断渲染归属，未断事件透传
 * - 目录模式默认区（模板默认项目目录段）：默认项目目录标签（SessionDirLabel）+
 *   会话行 + folder 行操作（+ 新建 / 两段式批量删除）此前只在命名项目组语境下有覆盖，
 *   默认区语境（无组框、置顶）从未渲染过
 *
 * 行为断言（用户可见 DOM 优先）：
 * - 点默认区会话行 → emit('select', id)（真实 click 链路，非 stub 注入）
 * - rename/delete 事件自 SessionItem 原样透传（SessionList 接线契约，payload 逐字相等）
 * - 目录模式默认区：目录标签置顶（DOM 序先于任何 project-group）、无 ProjectGroup 包裹；
 *   点「+」→ emit('newSessionInFolder', cwd)；两段式删除首击进确认态（title 翻转）、
 *   再击 emit('deleteFolder', cwd)
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/session-list-default-zone.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import type { SessionGroup, SessionSummary } from '@taiji/shared'
import SessionList from '@/components/sidebar/SessionList.vue'
import SessionItem from '@/components/sidebar/SessionItem.vue'
import { useProjectStore, DEFAULT_PROJECT_ID } from '@/stores/project'

function makeSession(id: string, cwd: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    label: `会话 ${id}`,
    cwd,
    status: 'idle',
    lastActiveAt: 1,
    modelId: 'm',
    tokenCount: 0,
    ...over,
  }
}

function mountList(groups: SessionGroup[]) {
  return mount(SessionList, {
    props: {
      groups,
      activeId: null,
      statusOf: () => 'done' as never,
    },
  })
}

/** 建默认项目 + 命名项目（proj-a 存在，孤儿判定不误伤） */
function setupProjects(activeId: string): ReturnType<typeof useProjectStore> {
  const store = useProjectStore()
  store.projects = [
    { id: 'proj-default', name: '', lastUsedAt: 0 },
    { id: 'proj-a', name: 'Alpha', lastUsedAt: 0 },
  ]
  store.activeProjectId = activeId
  return store
}

/** 定位某项目的分组容器（仅适用命名项目；默认项目不渲染 ProjectGroup） */
function groupOf(wrapper: ReturnType<typeof mountList>, projectId: string) {
  return wrapper.find(`[data-testid="project-group"][data-project-id="${projectId}"]`)
}

/** 定位默认项目平铺区（置顶、无组框） */
function defaultZoneOf(wrapper: ReturnType<typeof mountList>) {
  return wrapper.find('[data-testid="default-project-flat-zone"]')
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.removeItem('taiji:projects')
  localStorage.removeItem('taiji:sidebar-session-mode')
})

describe('SessionList: 平铺默认区事件透传', () => {
  it('点默认区会话行 → emit select(会话 id)（真实 click 链路）；行渲染在无组框平铺区', async () => {
    setupProjects(DEFAULT_PROJECT_ID)
    // sa 归属 proj-a（命名组），sb 未归类（默认区）
    const wrapper = mountList([
      { cwd: '/repo', sessions: [makeSession('sa', '/repo', { projectId: 'proj-a' }), makeSession('sb', '/repo')] },
    ])

    const zone = defaultZoneOf(wrapper)
    expect(zone.exists()).toBe(true)
    expect(zone.text()).toContain('会话 sb')
    expect(zone.text()).not.toContain('会话 sa')

    // 真实用户点击：会话行（role=button）click → SessionItem emit select → 默认区透传
    await zone.find('.session-item').trigger('click')
    expect(wrapper.emitted('select')).toEqual([['sb']])
  })

  it('默认区 SessionItem 的 rename / delete 事件原样透传（SessionList 接线契约，payload 逐字相等）', async () => {
    setupProjects(DEFAULT_PROJECT_ID)
    const wrapper = mountList([
      { cwd: '/repo', sessions: [makeSession('sb', '/repo')] },
    ])

    const item = defaultZoneOf(wrapper).findComponent(SessionItem)
    expect(item.exists()).toBe(true)
    item.vm.$emit('rename', 'sb')
    item.vm.$emit('delete', 'sb')
    await nextTick()

    expect(wrapper.emitted('rename')).toEqual([['sb']])
    expect(wrapper.emitted('delete')).toEqual([['sb']])
  })
})

describe('SessionList: 目录模式默认区（置顶目录标签 + folder 行操作）', () => {
  beforeEach(() => {
    // 目录模式（与组件 localStorage 持久化键一致，同 session-list-folder-delete 范式）
    localStorage.setItem('taiji:sidebar-session-mode', 'groups')
  })

  it('默认项目目录标签置顶渲染（DOM 序先于任何命名组，无 ProjectGroup 包裹）；会话行随标签可见', () => {
    setupProjects(DEFAULT_PROJECT_ID)
    const wrapper = mountList([
      { cwd: '/repo', sessions: [makeSession('s1', '/repo'), makeSession('s2', '/repo')] },
      { cwd: '/repo2', sessions: [makeSession('s3', '/repo2', { projectId: 'proj-a' })] },
    ])

    // 默认区无 ProjectGroup（方案 A：不展示项目框）
    expect(groupOf(wrapper, DEFAULT_PROJECT_ID).exists()).toBe(false)
    // 会话可见：默认区 s1/s2，命名组 s3
    expect(wrapper.text()).toContain('会话 s1')
    expect(wrapper.text()).toContain('会话 s2')
    expect(groupOf(wrapper, 'proj-a').text()).toContain('会话 s3')
    // 默认区目录标签置顶：首个 folder 操作区在 DOM 序上先于首个命名组
    const firstLabel = wrapper.find('[data-testid="folder-actions"]').element
    const firstGroup = wrapper.find('[data-testid="project-group"]').element
    const all = Array.from(wrapper.element.querySelectorAll('*'))
    expect(all.indexOf(firstLabel)).toBeGreaterThan(-1)
    expect(all.indexOf(firstLabel)).toBeLessThan(all.indexOf(firstGroup))
  })

  it('点默认区目录标签「+」→ emit newSessionInFolder(cwd)（以该目录预选新建）', async () => {
    setupProjects(DEFAULT_PROJECT_ID)
    const wrapper = mountList([
      { cwd: '/repo', sessions: [makeSession('s1', '/repo'), makeSession('s2', '/repo')] },
      { cwd: '/repo2', sessions: [makeSession('s3', '/repo2', { projectId: 'proj-a' })] },
    ])

    // 首个「+」即默认区标签行（置顶）；命名组内标签行不受本断言约束
    const plusBtns = wrapper.findAll('[data-testid="folder-new-session-btn"]')
    expect(plusBtns.length).toBe(2) // 默认区 /repo + 命名组 /repo2
    await plusBtns[0]!.trigger('click')
    expect(wrapper.emitted('newSessionInFolder')).toEqual([['/repo']])
  })

  it('默认区 SessionItem 全部事件原样透传（select/rename/delete/setProject/navigateParent/abort/forceQuit/exportJsonl）', async () => {
    setupProjects(DEFAULT_PROJECT_ID)
    const wrapper = mountList([
      { cwd: '/repo', sessions: [makeSession('s1', '/repo')] },
    ])

    // 目录模式默认区的会话行（.gi 缩进层内）
    const item = wrapper.find('.gi').findComponent(SessionItem)
    expect(item.exists()).toBe(true)
    expect(wrapper.text()).toContain('会话 s1')

    item.vm.$emit('select', 's1')
    item.vm.$emit('rename', 's1')
    item.vm.$emit('delete', 's1')
    item.vm.$emit('setProject', { sessionId: 's1', projectId: 'proj-a' })
    item.vm.$emit('navigateParent', 'parent-1')
    item.vm.$emit('abort', 's1')
    item.vm.$emit('forceQuit', 's1')
    item.vm.$emit('exportJsonl', { sessionId: 's1' })
    await nextTick()

    expect(wrapper.emitted('select')).toEqual([['s1']])
    expect(wrapper.emitted('rename')).toEqual([['s1']])
    expect(wrapper.emitted('delete')).toEqual([['s1']])
    expect(wrapper.emitted('setProject')).toEqual([[{ sessionId: 's1', projectId: 'proj-a' }]])
    expect(wrapper.emitted('navigateParent')).toEqual([['parent-1']])
    expect(wrapper.emitted('abort')).toEqual([['s1']])
    expect(wrapper.emitted('forceQuit')).toEqual([['s1']])
    expect(wrapper.emitted('exportJsonl')).toEqual([[{ sessionId: 's1' }]])
  })

  it('默认区批量删除检查放行（cwd 全量会话都在默认区）→ 两段式确认 → emit deleteFolder(cwd)', async () => {
    setupProjects(DEFAULT_PROJECT_ID)
    // /repo 两条会话全部未归类 → 默认区包含该 cwd 全量 → 删除按钮放行（MF-2 检查）
    const wrapper = mountList([
      { cwd: '/repo', sessions: [makeSession('s1', '/repo'), makeSession('s2', '/repo')] },
    ])

    const btn = wrapper.find('[data-testid="folder-delete-btn"]')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('title')).toBe('删除')

    // 首击进确认态（用户可见：title 翻转为确认文案），不 emit
    await btn.trigger('click')
    const confirmBtn = wrapper.find('[data-testid="folder-delete-btn"]')
    expect(confirmBtn.attributes('title')).toBe('确认删除此文件夹下所有会话？')
    expect(wrapper.emitted('deleteFolder')).toBeFalsy()

    // 再击确认 → emit deleteFolder(cwd)，确认态复位
    await confirmBtn.trigger('click')
    expect(wrapper.emitted('deleteFolder')).toEqual([['/repo']])
    await nextTick()
    expect(wrapper.find('[data-testid="folder-delete-btn"]').attributes('title')).toBe('删除')
  })
})
