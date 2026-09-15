/**
 * SessionList.vue 按 activeProject 过滤测试（D14 语义修正 2026-08-04：session.projectId 直接关联）。
 *
 * 用户主诉求回归防护：切换项目时，session 列表必须跟随 activeProject 变化。
 * 过滤粒度是 **session 级**（同一 cwd 组内可混合不同归属，逐 session 过滤后重组分组）。
 *
 * 覆盖（含渲染 gate：断言 DOM 中实际渲染的分组/session）：
 * - 默认项目（未命名）→ 未归类（无 projectId）+ 孤儿（归属已删 project）聚合
 * - 命名 project → 只渲染归属它的 session（同 cwd 组内混合归属时精确过滤）
 * - 命名 project 无归属 → 空态
 * - 切 project → 列表实时变化
 *
 * fixture 语义：sa/sd 归属 proj-a；sc 归属 proj-b；sb 未归类。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/session-list-project-filter.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import type { SessionGroup, SessionSummary } from '@taiji/shared'
import SessionList from '@/components/sidebar/SessionList.vue'
import { useProjectStore } from '@/stores/project'

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

/** 同 cwd 组：sa 归属 proj-a，sb 未归类，sc 归属 proj-b（混合归属验证 session 级过滤） */
function makeGroups(): SessionGroup[] {
  return [
    {
      cwd: '/repo',
      sessions: [
        makeSession('sa', '/repo', { projectId: 'proj-a' }),
        makeSession('sb', '/repo'), // 未归类
        makeSession('sc', '/repo', { projectId: 'proj-b' }),
      ],
    },
    {
      cwd: '/repo2',
      sessions: [makeSession('sd', '/repo2', { projectId: 'proj-a' })],
    },
  ]
}

function mountList(groups: SessionGroup[] = makeGroups()) {
  return mount(SessionList, {
    props: {
      groups,
      activeId: null,
      statusOf: () => 'done' as never,
    },
  })
}

/** 建默认项目 + 命名项目（proj-a/proj-b 均存在，孤儿判定不误伤） */
function setupProjects(activeId: string, names: Array<[string, string]>): ReturnType<typeof useProjectStore> {
  const store = useProjectStore()
  store.projects = [
    { id: 'proj-default', name: '', lastUsedAt: 0 },
    ...names.map(([id, name]) => ({ id, name, lastUsedAt: 0 })),
  ]
  store.activeProjectId = activeId
  return store
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.removeItem('taiji:projects')
})

describe('SessionList: 默认项目 = 未归类 + 孤儿聚合', () => {
  it('默认项目只显示无归属的 session（归属现存命名 project 的隐藏）', () => {
    setupProjects('proj-default', [['proj-a', 'Alpha'], ['proj-b', 'Beta']])
    const wrapper = mountList()
    const text = wrapper.text()
    expect(text).toContain('会话 sb') // 未归类可见
    expect(text).not.toContain('会话 sa') // 归属 proj-a（存在）→ 隐藏
    expect(text).not.toContain('会话 sc') // 归属 proj-b（存在）→ 隐藏
    expect(text).not.toContain('会话 sd') // 归属 proj-a → 隐藏
  })

  it('孤儿 session（归属的 project 已删除）在默认项目可见，不丢失可见性', () => {
    // proj-b 不存在（sc 的归属是孤儿）；proj-a 存在（sa/sd 正常归属）
    setupProjects('proj-default', [['proj-a', 'Alpha']])
    const wrapper = mountList()
    const text = wrapper.text()
    expect(text).toContain('会话 sc') // 孤儿可见（归属已删 project）
    expect(text).toContain('会话 sb') // 未归类可见
    expect(text).not.toContain('会话 sa') // 归属现存项目 → 隐藏
  })
})

describe('SessionList: 命名 project 按 projectId 过滤', () => {
  it('命名 project → 只渲染归属它的 session（同 cwd 组内混合归属精确过滤）', () => {
    setupProjects('proj-a', [['proj-a', 'Alpha'], ['proj-b', 'Beta']])
    const wrapper = mountList()
    const text = wrapper.text()
    expect(text).toContain('会话 sa') // proj-a 归属
    expect(text).toContain('会话 sd') // proj-a 归属（另一 cwd 组）
    expect(text).not.toContain('会话 sb') // 未归类
    expect(text).not.toContain('会话 sc') // proj-b 归属
  })

  it('命名 project 无任何归属 session → 空态（暂无会话 + 新建按钮）', () => {
    setupProjects('proj-empty', [['proj-empty', 'Empty']])
    const wrapper = mountList()
    expect(wrapper.text()).not.toContain('会话 sa')
    expect(wrapper.text()).toContain('暂无会话')
  })
})

describe('SessionList: 切换 project 列表实时变化（用户主诉求回归防护）', () => {
  it('切 project（a → b）→ 列表从 a 的 session 变为 b 的 session', async () => {
    setupProjects('proj-a', [['proj-a', 'Alpha'], ['proj-b', 'Beta']])
    const wrapper = mountList()
    expect(wrapper.text()).toContain('会话 sa')
    expect(wrapper.text()).not.toContain('会话 sc')

    useProjectStore().setActiveProject('proj-b')
    await nextTick()

    expect(wrapper.text()).toContain('会话 sc')
    expect(wrapper.text()).not.toContain('会话 sa')
  })

  it('切回默认项目 → 未归类 + 孤儿聚合视图（归属现存项目的隐藏）', async () => {
    setupProjects('proj-a', [['proj-a', 'Alpha'], ['proj-b', 'Beta']])
    const wrapper = mountList()
    expect(wrapper.text()).not.toContain('会话 sb')

    useProjectStore().setActiveProject('proj-default')
    await nextTick()

    expect(wrapper.text()).toContain('会话 sb') // 未归类可见
    expect(wrapper.text()).not.toContain('会话 sa') // 归属 proj-a（存在）→ 隐藏
    expect(wrapper.text()).not.toContain('会话 sc') // 归属 proj-b（存在）→ 隐藏
  })
})

describe('SessionList: folder 删除按钮随过滤状态隐藏（review MF-2 防护）', () => {
  it('命名 project 过滤态（/repo 可见 1/3）→ folder-delete-btn 不存在（防误删不可见 session）', () => {
    // 仅 /repo 单组：sa 归属 proj-a 可见，sb 未归类 / sc 归属 proj-b 被过滤 → visible(1) < total(3)。
    // 不能用默认 makeGroups（其 /repo2 组 sd 归属 proj-a 全量可见会渲染按钮，污染计数断言）。
    setupProjects('proj-a', [['proj-a', 'Alpha'], ['proj-b', 'Beta']])
    const wrapper = mountList([{
      cwd: '/repo',
      sessions: [
        makeSession('sa', '/repo', { projectId: 'proj-a' }),
        makeSession('sb', '/repo'),
        makeSession('sc', '/repo', { projectId: 'proj-b' }),
      ],
    }])
    // removeByCwd 是 cwd 全量删除（项目无关），过滤态下删除会连带删掉不可见的 session → 按钮必须隐藏
    expect(wrapper.findAll('[data-testid="folder-delete-btn"]')).toHaveLength(0)
  })

  it('默认项目全量视图（无过滤）→ folder-delete-btn 存在', () => {
    // 全部 session 未归类：默认项目视图无过滤（visible === total），删除按钮可安全渲染
    setupProjects('proj-default', [['proj-a', 'Alpha']])
    const wrapper = mountList([{
      cwd: '/repo',
      sessions: [makeSession('sa', '/repo'), makeSession('sb', '/repo')],
    }])
    const btns = wrapper.findAll('[data-testid="folder-delete-btn"]')
    expect(btns.length).toBeGreaterThan(0)
  })
})
