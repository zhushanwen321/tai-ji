/**
 * session 拖拽移动归属测试（需求：拖动 session 移动到不同项目）。
 *
 * 链：SessionItem dragstart（写 SESSION_DRAG_MIME）→ ProjectGroup 组头 / DefaultProjectHead
 *     drop（useSessionDropTarget 识别）→ SessionList assignDropped（同归属 no-op 守卫）→
 *     emit setProject（既有事件链，Sidebar → assignSessionToProject → RPC）。
 *
 * 覆盖：
 * - dragstart 写入 sessionId（落点按 types 识别的依据）
 * - 组头 dragover 高亮（types 命中）+ drop → emit setProject {sessionId, projectId: 组id}
 * - 默认头行 drop → projectId 空串（归回未归类聚合）
 * - 同归属 drop no-op（不 emit，防自拖自落 + 省 RPC）
 * - 落折叠组后强制展开（会话不消失在折叠组里）
 * - 无 session MIME 的拖拽（文件拖入等）不高亮、不触发 drop
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/sidebar-session-dnd.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import type { SessionGroup, SessionSummary } from '@taiji/shared'
import SessionList from '@/components/sidebar/SessionList.vue'
import { SESSION_DRAG_MIME } from '@/components/sidebar/session-drag'
import { useProjectStore, DEFAULT_PROJECT_ID } from '@/stores/project'

/** jsdom 无 DragEvent/DataTransfer，trigger 的 extra props 合成事件用最小替身 */
class FakeDataTransfer {
  private data = new Map<string, string>()
  types: string[] = []
  dropEffect = 'none'
  effectAllowed = 'none'
  setData(type: string, value: string): void {
    this.data.set(type, value)
    if (!this.types.includes(type)) this.types.push(type)
  }
  getData(type: string): string {
    return this.data.get(type) ?? ''
  }
}

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

describe('SessionItem dragstart（拖拽数据写入）', () => {
  it('dragstart 写入 SESSION_DRAG_MIME = sessionId，effectAllowed = move', async () => {
    setupProjects(DEFAULT_PROJECT_ID)
    const wrapper = mountList()
    const dt = new FakeDataTransfer()
    // 默认区置顶（第一个 .session-item 是未归类的 sb），按 label 定位 proj-a 组内的 sa
    const row = wrapper.findAll('.session-item').find((w) => w.text().includes('会话 sa'))!

    await row.trigger('dragstart', { dataTransfer: dt })

    expect(dt.getData(SESSION_DRAG_MIME)).toBe('sa')
    expect(dt.effectAllowed).toBe('move')
    wrapper.unmount()
  })
})

describe('组头 drop（拖到项目 = 移动归属）', () => {
  it('dragover 高亮（types 命中）→ drop emit setProject 指向该组', async () => {
    setupProjects(DEFAULT_PROJECT_ID)
    const wrapper = mountList()
    const dt = new FakeDataTransfer()
    dt.setData(SESSION_DRAG_MIME, 'sb')
    const head = groupOf(wrapper, 'proj-a').find('[data-testid="project-group-head"]')

    await head.trigger('dragover', { dataTransfer: dt })
    expect(head.attributes('data-dragover')).toBe('true')

    await head.trigger('drop', { dataTransfer: dt })
    await nextTick()

    expect(wrapper.emitted('setProject')).toEqual([[{ sessionId: 'sb', projectId: 'proj-a' }]])
    // drop 后高亮清除
    expect(head.attributes('data-dragover')).toBeUndefined()
    wrapper.unmount()
  })

  it('落折叠组 → 归属移动 + 目标组强制展开（会话不消失在折叠组里）', async () => {
    const store = setupProjects('proj-a', [['proj-a', 'Alpha']])
    const wrapper = mountList()
    const toggleA = () => groupOf(wrapper, 'proj-a').find('[data-testid="project-group-toggle"]')

    // 折叠锚定组 proj-a
    await toggleA().trigger('click')
    expect(toggleA().attributes('aria-expanded')).toBe('false')

    const dt = new FakeDataTransfer()
    dt.setData(SESSION_DRAG_MIME, 'sb')
    await groupOf(wrapper, 'proj-a').find('[data-testid="project-group-head"]').trigger('drop', { dataTransfer: dt })
    await nextTick()

    expect(wrapper.emitted('setProject')).toEqual([[{ sessionId: 'sb', projectId: 'proj-a' }]])
    expect(toggleA().attributes('aria-expanded')).toBe('true')
    wrapper.unmount()
  })

  it('同归属 drop no-op（不 emit setProject）', async () => {
    setupProjects(DEFAULT_PROJECT_ID)
    const wrapper = mountList()
    const dt = new FakeDataTransfer()
    dt.setData(SESSION_DRAG_MIME, 'sa') // sa 已归属 proj-a

    await groupOf(wrapper, 'proj-a').find('[data-testid="project-group-head"]').trigger('drop', { dataTransfer: dt })
    await nextTick()

    expect(wrapper.emitted('setProject')).toBeUndefined()
    wrapper.unmount()
  })

  it('无 session MIME 的拖拽（文件拖入等）：不高亮、不 emit', async () => {
    setupProjects(DEFAULT_PROJECT_ID)
    const wrapper = mountList()
    const dt = new FakeDataTransfer() // 未 setData 任何 session MIME
    const head = groupOf(wrapper, 'proj-a').find('[data-testid="project-group-head"]')

    await head.trigger('dragover', { dataTransfer: dt })
    expect(head.attributes('data-dragover')).toBeUndefined()

    await head.trigger('drop', { dataTransfer: dt })
    await nextTick()
    expect(wrapper.emitted('setProject')).toBeUndefined()
    wrapper.unmount()
  })
})

describe('默认头行 drop（拖到默认项目 = 归回未归类聚合）', () => {
  it('drop → emit setProject projectId 空串', async () => {
    setupProjects(DEFAULT_PROJECT_ID)
    const wrapper = mountList()
    const dt = new FakeDataTransfer()
    dt.setData(SESSION_DRAG_MIME, 'sa') // sa 归属 proj-a

    await wrapper.find('[data-testid="default-project-head"]').trigger('drop', { dataTransfer: dt })
    await nextTick()

    expect(wrapper.emitted('setProject')).toEqual([[{ sessionId: 'sa', projectId: '' }]])
    wrapper.unmount()
  })

  it('未归类 session drop 到默认行 no-op（projectId undefined 与空串同口径）', async () => {
    setupProjects(DEFAULT_PROJECT_ID)
    const wrapper = mountList()
    const dt = new FakeDataTransfer()
    dt.setData(SESSION_DRAG_MIME, 'sb') // sb 无 projectId（未归类）

    await wrapper.find('[data-testid="default-project-head"]').trigger('drop', { dataTransfer: dt })
    await nextTick()

    expect(wrapper.emitted('setProject')).toBeUndefined()
    wrapper.unmount()
  })
})
