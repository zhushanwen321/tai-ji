/**
 * Project store 测试（D14 语义修正 + 2026-08-04 持久化迁 runtime projects.json）。
 *
 * 覆盖：
 * - 同步初始态：默认 project 兜底（UI 永不空态）
 * - init()：RPC load 权威数据；RPC 失败降级默认；localStorage 一次性迁移（有旧数据 → 用之 + save 回 runtime）
 * - addProject / setActiveProject / removeProject CRUD + lastUsedAt 排序
 * - isDefaultProject 判定（name 空）
 * - deep watch 变化 → RPC save 被调
 *
 * mock 策略：mock @/api 门面的 project 域（store 走门面）。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/project-store.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import type { Project, ProjectStoreState } from '@taiji/shared'
import { useProjectStore, STORAGE_KEY, DEFAULT_PROJECT_ID } from '@/stores/project'

vi.mock('@/api', () => ({
  project: { load: vi.fn(), save: vi.fn().mockResolvedValue(undefined) },
}))

import { project as projectApi } from '@/api'

const mockLoad = projectApi.load as unknown as ReturnType<typeof vi.fn>
const mockSave = projectApi.save as unknown as ReturnType<typeof vi.fn>

function makeProject(id: string, name: string, lastUsedAt = 0): Project {
  return { id, name, lastUsedAt }
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.removeItem(STORAGE_KEY)
  // mockClear 而非 mockReset：mockReset 会清掉 mockResolvedValue 实现（save 返回 undefined → .catch 崩）
  mockLoad.mockClear()
  mockSave.mockClear()
})

describe('Project store: 初始态与 init()', () => {
  it('同步初始态：默认 project 兜底（RPC 未返回前 UI 不空）', () => {
    const store = useProjectStore()
    expect(store.projects).toHaveLength(1)
    expect(store.activeProject!.name).toBe('')
    expect(store.isDefaultProject).toBe(true)
  })

  it('init()：RPC load 权威数据替换默认态（含 activeProjectId）', async () => {
    mockLoad.mockResolvedValue({
      projects: [makeProject('proj-a', 'Alpha'), makeProject('proj-default', '', 0)],
      activeProjectId: 'proj-a',
    })
    const store = useProjectStore()
    await store.init()

    expect(store.projects).toHaveLength(2)
    expect(store.activeProjectId).toBe('proj-a')
    expect(store.isDefaultProject).toBe(false)
  })

  it('init()：RPC reject 降级默认（不抛，不阻断启动）', async () => {
    mockLoad.mockRejectedValue(new Error('runtime not ready'))
    const store = useProjectStore()
    await expect(store.init()).resolves.toBeUndefined()
    expect(store.projects).toHaveLength(1)
    expect(store.activeProject!.name).toBe('')
  })

  it('init()：runtime 空 + localStorage 有旧数据 → 一次性迁移（用之 + save 回 runtime）', async () => {
    mockLoad.mockResolvedValue({ projects: [], activeProjectId: '' })
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        projects: [{ id: 'p1', name: '旧项目', workspaces: [{ id: 'w1', cwd: '/x', dir: 'x', repo: '', isMain: false }], lastUsedAt: 100 }],
        activeProjectId: 'p1',
      }),
    )
    const store = useProjectStore()
    await store.init()

    // 归一化补插 nameless 默认项（[review MF-2]）：默认聚合视图保持可达，命名项顺延到 index 1
    expect(store.projects).toHaveLength(2)
    expect(store.projects[0]!.name).toBe('')
    expect(store.projects[1]!.name).toBe('旧项目')
    // 旧 workspaces 字段被剥离
    expect('workspaces' in store.projects[1]!).toBe(false)
    // 迁移写回 runtime（归一化后状态：默认项在前）
    expect(mockSave).toHaveBeenCalled()
    const saved = mockSave.mock.calls[0][0] as ProjectStoreState
    expect(saved.projects[1]!.id).toBe('p1')
  })

  it('init()：activeProjectId 失配（stale id）→ 归一化回退默认项（review MF-2）', async () => {
    mockLoad.mockResolvedValue({
      projects: [makeProject('proj-a', 'Alpha')],
      activeProjectId: 'ghost-project',
    })
    const store = useProjectStore()
    await store.init()

    // stale id 不再被 SessionList 过滤/recentProjects 高亮消费：回退到 nameless 默认项
    expect(store.activeProjectId).toBe(DEFAULT_PROJECT_ID)
    expect(store.isDefaultProject).toBe(true)
    // 归一化状态被 deep watch 持久化（重启不再复现 stale id）
    await nextTick()
    const saved = mockSave.mock.calls[mockSave.mock.calls.length - 1][0] as ProjectStoreState
    expect(saved.activeProjectId).toBe(DEFAULT_PROJECT_ID)
  })

  it('init()：projects 缺 nameless 默认项 → 补插；合法 activeProjectId 不被覆盖（review MF-2）', async () => {
    mockLoad.mockResolvedValue({
      projects: [makeProject('proj-a', 'Alpha')],
      activeProjectId: 'proj-a',
    })
    const store = useProjectStore()
    await store.init()

    // 默认聚合视图可达（补插不依赖初始态 makeDefaultProject）
    expect(store.projects.map((p) => p.id)).toContain(DEFAULT_PROJECT_ID)
    // 合法数据保留（runtime 权威不被 clobber）
    expect(store.activeProjectId).toBe('proj-a')
    expect(store.isDefaultProject).toBe(false)
  })

  it('init()：默认项被外部改名（id 占用但 name 非空）→ 不补插第二个同 id 项（review S-1）', async () => {
    // 触发类与 MF-2 相同（projects.json 被外部编辑）：默认项改名 'General'，旧补插条件
    // 查「无 nameless 项」会 unshift 第二个 id='proj-default' → 重复 id 被持久化 + recentProjects
    // 的 filter/find 语义错乱。修复：按 id 占用判默认项存在。
    mockLoad.mockResolvedValue({
      projects: [makeProject('proj-default', 'General'), makeProject('proj-a', 'Alpha')],
      activeProjectId: 'proj-a',
    })
    const store = useProjectStore()
    await store.init()

    // 只保留一个 proj-default（不因 nameless 检查缺失而 unshift 重复 id）
    const defaultIds = store.projects.filter((p) => p.id === DEFAULT_PROJECT_ID)
    expect(defaultIds).toHaveLength(1)
    // 合法 activeProjectId 原样保留（runtime 权威不 clobber，改动不破坏首启/权威语义）
    expect(store.activeProjectId).toBe('proj-a')
  })

  it('init()：runtime 空 + localStorage 无数据 → 保持默认 project', async () => {
    mockLoad.mockResolvedValue({ projects: [], activeProjectId: '' })
    const store = useProjectStore()
    await store.init()
    expect(store.projects).toHaveLength(1)
    expect(store.activeProject!.name).toBe('')
  })
})

describe('Project store: CRUD + 持久化', () => {
  it('addProject：新建 + 设为活跃 + 返回 id；空名不创建', () => {
    const store = useProjectStore()
    const id = store.addProject('测试项目')
    expect(id).toBeTruthy()
    expect(store.projects).toHaveLength(2)
    expect(store.activeProjectId).toBe(id)
    expect(store.isDefaultProject).toBe(false)

    store.addProject('   ')
    expect(store.projects).toHaveLength(2)
  })

  it('setActiveProject：切换 + lastUsedAt 更新；recentProjects 顺序不变（点击不改顺序）', () => {
    const store = useProjectStore()
    const a = store.addProject('A')
    const b = store.addProject('B')
    store.setActiveProject(a)

    expect(store.activeProjectId).toBe(a)
    // 全员无 userOrder：显示序 = 数组序 [DEFAULT, A, B]，active a 不置顶
    expect(store.recentProjects.map((p) => p.id)).toEqual([DEFAULT_PROJECT_ID, a, b])
  })

  it('setActiveProject 更新目标 lastUsedAt，不动其他项；addProject 新建时 lastUsedAt = 当前时间', () => {
    const store = useProjectStore()
    const a = store.addProject('A')
    const b = store.addProject('B')
    const aBefore = store.projects.find((p) => p.id === a)!.lastUsedAt
    const bBefore = store.projects.find((p) => p.id === b)!.lastUsedAt

    store.setActiveProject(a)

    expect(store.projects.find((p) => p.id === a)!.lastUsedAt).toBeGreaterThanOrEqual(aBefore)
    expect(store.projects.find((p) => p.id === b)!.lastUsedAt).toBe(bBefore) // 未动
    // addProject 用 Date.now()（同毫秒可能相等，断言不小于创建前时间即可）
    expect(store.projects.find((p) => p.id === b)!.lastUsedAt).toBeGreaterThan(0)
  })

  it('removeProject：默认项目不可删；保底不删最后一个；删活跃项自动切首个', () => {
    const store = useProjectStore()
    const a = store.addProject('A')
    const b = store.addProject('B')
    store.setActiveProject(a)

    store.removeProject(a)
    expect(store.projects).toHaveLength(2) // 默认 + B
    expect(store.activeProjectId).not.toBe(a)

    // 默认项目（DEFAULT_PROJECT_ID）不可删除（review MF-1 守卫：未归类 session 的兜底聚合）
    store.removeProject(DEFAULT_PROJECT_ID)
    expect(store.projects.map((p) => p.id)).toEqual([DEFAULT_PROJECT_ID, b])

    store.removeProject(b)
    expect(store.projects).toHaveLength(1) // 只剩默认（保底不删最后一个）
    store.removeProject(store.projects[0]!.id)
    expect(store.projects).toHaveLength(1) // 默认项目守卫再拦一次
  })

  it('isDefaultProject：命名 project 非默认；默认 project（name 空）是默认', () => {
    const store = useProjectStore()
    expect(store.isDefaultProject).toBe(true)
    store.addProject('Alpha')
    expect(store.isDefaultProject).toBe(false)
  })

  it('deep watch 变化 → RPC save 全量调用', async () => {
    const store = useProjectStore()
    store.addProject('Alpha')
    await nextTick()

    expect(mockSave).toHaveBeenCalled()
    const saved = mockSave.mock.calls[0][0] as ProjectStoreState
    expect(saved.projects.some((p) => p.name === 'Alpha')).toBe(true)
    expect(saved.activeProjectId).toBe(store.activeProjectId)
  })
})
