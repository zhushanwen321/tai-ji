/**
 * 默认项目轻量头行（DefaultProjectHead）+ 平铺模式多开交互测试。
 *
 * 覆盖：
 * - 需求「新会话进不了默认项目」修复（DefaultProjectHead 锚定/新建入口）：默认区有会话
 *   时头行渲染（平铺 + 目录两模式）；点行主体 = 锚定切回默认项目（「当前」chip 跟随）；
 *   点「+」= 先锚定默认项目再 emit newSession（emit 时刻采样落点，防「先 emit 后锚定」
 *   落错项目的 bug 形态）；默认区无会话时头行不渲染（空区不渲染一致）
 * - 多开细节补充：点锚定组头折叠只影响本组（其余组开合不动）；再点恢复展开
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/session-list-default-head.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import type { SessionGroup, SessionSummary } from '@taiji/shared'
import SessionList from '@/components/sidebar/SessionList.vue'
import { useProjectStore, DEFAULT_PROJECT_ID } from '@/stores/project'

function makeSession(id: string, cwd: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    label: `会话 ${id}`,
    cwd,
    status: 'idle',
    lastActiveAt: 1,
    ...over,
  }
}

function makeGroups(): SessionGroup[] {
  return [
    { cwd: '/repo', sessions: [makeSession('sa', '/repo', { projectId: 'proj-a' })] },
    { cwd: '/free', sessions: [makeSession('sb', '/free')] },
  ]
}

function mountList(groups: SessionGroup[] = makeGroups()) {
  return mount(SessionList, {
    attachTo: document.body,
    props: {
      groups,
      activeId: null,
      statusOf: () => 'done' as never,
    },
  })
}

function setupProjects(activeId: string, names: Array<[string, string]> = [['proj-a', 'Alpha']]) {
  const store = useProjectStore()
  store.projects = [
    { id: DEFAULT_PROJECT_ID, name: '', lastUsedAt: 0 },
    ...names.map(([id, name]) => ({ id, name, lastUsedAt: 0 })),
  ]
  store.activeProjectId = activeId
  return store
}

function groupOf(wrapper: ReturnType<typeof mountList>, projectId: string) {
  return wrapper.find(`[data-testid="project-group"][data-project-id="${projectId}"]`)
}

beforeEach(async () => {
  setActivePinia(createPinia())
  localStorage.removeItem('taiji:projects')
  localStorage.removeItem('taiji:sidebar-session-mode')
  document.body.innerHTML = ''
})

describe('DefaultProjectHead：锚定/新建入口（修复锚定切走后新会话进不了默认区）', () => {
  it('平铺模式：默认区有会话 → 头行渲染；锚定命名项目时无「当前」chip', () => {
    setupProjects('proj-a')
    const wrapper = mountList()

    const head = wrapper.find('[data-testid="default-project-head"]')
    expect(head.exists()).toBe(true)
    expect(head.text()).toContain('默认项目')
    expect(wrapper.find('[data-testid="default-project-current-chip"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('点行主体 → 锚定切回默认项目，「当前」chip 出现', async () => {
    const store = setupProjects('proj-a')
    const wrapper = mountList()

    await wrapper.find('[data-testid="default-project-anchor"]').trigger('click')

    expect(store.activeProjectId).toBe(DEFAULT_PROJECT_ID)
    await nextTick()
    expect(wrapper.find('[data-testid="default-project-current-chip"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('点「+」→ emit 时刻锚定已在默认项目（先锚定后建），并 emit newSession', async () => {
    const store = setupProjects('proj-a')
    let activeAtEmit: string | null = null
    const wrapper = mount(SessionList, {
      attachTo: document.body,
      props: {
        groups: makeGroups(),
        activeId: null,
        statusOf: () => 'done' as never,
        onNewSession: () => {
          activeAtEmit = store.activeProjectId
        },
      },
    })

    await wrapper.find('[data-testid="default-project-new-task"]').trigger('click')

    expect(activeAtEmit).toBe(DEFAULT_PROJECT_ID)
    expect(store.activeProjectId).toBe(DEFAULT_PROJECT_ID)
    expect(wrapper.emitted('newSession')).toBeTruthy()
    wrapper.unmount()
  })

  it('目录模式：头行同样渲染（目录标签序列之前）', () => {
    localStorage.setItem('taiji:sidebar-session-mode', 'groups')
    setupProjects('proj-a')
    const wrapper = mountList()

    expect(wrapper.find('[data-testid="default-project-head"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('默认区无会话 → 头行不渲染（空区不渲染一致）', () => {
    setupProjects('proj-a')
    const wrapper = mountList([{ cwd: '/repo', sessions: [makeSession('sa', '/repo', { projectId: 'proj-a' })] }])

    expect(wrapper.find('[data-testid="default-project-head"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('平铺模式多开细节（开合按组独立记忆）', () => {
  it('点锚定组头折叠只收本组，其余组保持展开；再点恢复', async () => {
    setupProjects('proj-a', [['proj-a', 'Alpha'], ['proj-b', 'Beta']])
    const wrapper = mountList()
    const toggleA = () => groupOf(wrapper, 'proj-a').find('[data-testid="project-group-toggle"]')
    const toggleB = () => groupOf(wrapper, 'proj-b').find('[data-testid="project-group-toggle"]')

    await toggleA().trigger('click')
    expect(toggleA().attributes('aria-expanded')).toBe('false')
    // 多开：proj-b 开合不受 proj-a 折叠影响
    expect(toggleB().attributes('aria-expanded')).toBe('true')

    await toggleA().trigger('click')
    expect(toggleA().attributes('aria-expanded')).toBe('true')
    expect(toggleB().attributes('aria-expanded')).toBe('true')
    wrapper.unmount()
  })

  it('折叠非锚定组后，点它切锚定仍强制展开', async () => {
    const store = setupProjects('proj-a', [['proj-a', 'Alpha'], ['proj-b', 'Beta']])
    const wrapper = mountList()
    const toggleA = () => groupOf(wrapper, 'proj-a').find('[data-testid="project-group-toggle"]')
    const toggleB = () => groupOf(wrapper, 'proj-b').find('[data-testid="project-group-toggle"]')

    // 折叠 proj-b：先切锚定到它（首次点击非锚定组 = 切锚定，保持展开）再点一次翻转折叠
    await toggleB().trigger('click')
    expect(store.activeProjectId).toBe('proj-b')
    expect(toggleB().attributes('aria-expanded')).toBe('true')
    await toggleB().trigger('click')
    expect(toggleB().attributes('aria-expanded')).toBe('false')

    // 锚定切回 proj-a（proj-b 折叠记忆保留），再点折叠的 proj-b（非锚定）→ 切锚定 + 强制展开
    await toggleA().trigger('click')
    expect(store.activeProjectId).toBe('proj-a')
    expect(toggleB().attributes('aria-expanded')).toBe('false')
    await toggleB().trigger('click')
    expect(store.activeProjectId).toBe('proj-b')
    expect(toggleB().attributes('aria-expanded')).toBe('true')
    wrapper.unmount()
  })
})
