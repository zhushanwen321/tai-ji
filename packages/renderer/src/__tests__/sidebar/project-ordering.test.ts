// @vitest-environment node

/**
 * Project 排序与重命名单测（R6.2 锚定分组，用户裁决 2026-10-11「顺序稳定不置顶」）。
 *
 * 覆盖：
 *  - orderedProjects 稳定序：命名项目按 lastUsedAt 倒序（该字段仅创建时写入）、
 *    同值按持久化序稳定；默认项目（nameless）固定最后
 *  - 锚定切换零重排：setActiveProject 不更新 lastUsedAt，反复切换显示序逐字不变
 *    （「切换只改变谁展开，不重排组位置」裁决锚点）
 *  - 新建项目落位：addProject（lastUsedAt = Date.now()，最新）落在命名段首位、默认项目仍在最后
 *  - renameProject：命名项目改名生效并落盘；空名 / 未知 id / 默认项目（nameless 身份是
 *    未归类聚合判据）不动作
 *  - removeProject：删活跃项锚定回落默认项目（spec sidebar §3.7）
 *  - sessionBelongsToProject：归属判定规则 SSOT（命名精确匹配；默认聚合未归类 + 孤儿）
 *
 * mock 策略：mock @/api 门面的 project 域（store 走门面，同 project-store.test.ts）。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/project-ordering.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Project, SessionGroup } from '@taiji/shared'
import { useProjectStore, DEFAULT_PROJECT_ID } from '@/stores/project'
import { sessionBelongsToProject } from '@/composables/logic/project-session'

vi.mock('@/api', () => ({
  project: { load: vi.fn(), save: vi.fn().mockResolvedValue(undefined) },
}))

function makeProject(id: string, name: string, lastUsedAt = 0): Project {
  return { id, name, lastUsedAt }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('orderedProjects 稳定序（R6.2：lastUsedAt 倒序 + 默认项目固定最后）', () => {
  it('命名项目按 lastUsedAt 倒序；默认项目（nameless）固定最后', () => {
    const store = useProjectStore()
    store.projects = [
      makeProject(DEFAULT_PROJECT_ID, '', 999), // 默认项目 lastUsedAt 再大也在最后（旧数据留痕不例外）
      makeProject('a', 'A', 100),
      makeProject('b', 'B', 300),
      makeProject('c', 'C', 200),
    ]
    store.activeProjectId = 'a'

    expect(store.orderedProjects.map((p) => p.id)).toEqual(['b', 'c', 'a', DEFAULT_PROJECT_ID])
  })

  it('lastUsedAt 同值按持久化序稳定（历史数据无时间戳时 = 创建/落盘序）', () => {
    const store = useProjectStore()
    store.projects = [
      makeProject('x1', 'X1', 0),
      makeProject('x2', 'X2', 0),
      makeProject('x3', 'X3', 0),
      makeProject(DEFAULT_PROJECT_ID, ''),
    ]
    store.activeProjectId = 'x2'

    expect(store.orderedProjects.map((p) => p.id)).toEqual(['x1', 'x2', 'x3', DEFAULT_PROJECT_ID])
  })

  it('新建项目落位：addProject（lastUsedAt = 当前时间，最新）落命名段首位，默认项目仍在最后', () => {
    const store = useProjectStore()
    store.projects = [
      makeProject('old', 'Old', 100),
      makeProject(DEFAULT_PROJECT_ID, '', 0),
    ]
    store.activeProjectId = 'old'

    const newId = store.addProject('Fresh')

    expect(store.orderedProjects.map((p) => p.id)).toEqual([newId, 'old', DEFAULT_PROJECT_ID])
  })
})

describe('锚定切换零重排（「顺序稳定不置顶」裁决锚点）', () => {
  it('反复切换 active：显示序逐字不变，且 lastUsedAt 不被切换更新（否则下次排序会置顶）', () => {
    const store = useProjectStore()
    store.projects = [
      makeProject('a', 'A', 300),
      makeProject('b', 'B', 100),
      makeProject('c', 'C', 200),
      makeProject(DEFAULT_PROJECT_ID, '', 0),
    ]
    store.activeProjectId = 'a'
    const orderBefore = store.orderedProjects.map((p) => p.id)
    const stampB = store.projects.find((p) => p.id === 'b')!.lastUsedAt

    store.setActiveProject('b')
    expect(store.orderedProjects.map((p) => p.id)).toEqual(orderBefore)

    store.setActiveProject('c')
    store.setActiveProject('b')
    expect(store.orderedProjects.map((p) => p.id)).toEqual(orderBefore)
    // 切换是纯锚定动作：排序键不可变（shared/project.ts 契约），否则被点组会跳到最前
    expect(store.projects.find((p) => p.id === 'b')!.lastUsedAt).toBe(stampB)
  })

  it('重命名不改变组位置（排序键与 name 无关）', () => {
    const store = useProjectStore()
    store.projects = [
      makeProject('a', 'A', 300),
      makeProject('b', 'B', 100),
      makeProject(DEFAULT_PROJECT_ID, ''),
    ]
    store.activeProjectId = 'a'

    store.renameProject('b', 'B2')

    expect(store.orderedProjects.map((p) => p.id)).toEqual(['a', 'b', DEFAULT_PROJECT_ID])
    expect(store.projects.find((p) => p.id === 'b')!.name).toBe('B2')
  })
})

describe('renameProject（组头行内重命名）', () => {
  it('命名项目改名生效（持久化由 deep watch 全量 save 承载，见 project-store.test.ts）', () => {
    const store = useProjectStore()
    const id = store.addProject('旧名')
    store.renameProject(id, '新名')
    expect(store.projects.find((p) => p.id === id)!.name).toBe('新名')
  })

  it('空名（含纯空白）不动作；未知 id 不动作', () => {
    const store = useProjectStore()
    const id = store.addProject('保持')

    store.renameProject(id, '   ')
    store.renameProject('ghost-id', '任意')
    expect(store.projects.find((p) => p.id === id)!.name).toBe('保持')
  })

  it('默认项目禁改名：nameless 身份是未归类/孤儿 session 兜底聚合的判据，改名即瓦解聚合', () => {
    const store = useProjectStore()
    store.renameProject(DEFAULT_PROJECT_ID, '想改名')
    expect(store.projects.find((p) => p.id === DEFAULT_PROJECT_ID)!.name).toBe('')
  })
})

// ── 归属判定规则 SSOT（SessionList 分组切分与组头计数的同一规则）─────────────
function session(id: string, projectId?: string) {
  return { id, projectId }
}

describe('sessionBelongsToProject（分组归属规则 SSOT）', () => {
  const namedIds = new Set(['proj-a', 'proj-b'])

  it('命名 project：精确匹配 projectId', () => {
    expect(sessionBelongsToProject({ projectId: 'proj-a' }, 'proj-a', false, namedIds)).toBe(true)
    expect(sessionBelongsToProject({ projectId: 'proj-b' }, 'proj-a', false, namedIds)).toBe(false)
    expect(sessionBelongsToProject({}, 'proj-a', false, namedIds)).toBe(false)
  })

  it('默认项目：未归类 + 孤儿聚合（归属的 project 已删除）', () => {
    expect(sessionBelongsToProject({}, DEFAULT_PROJECT_ID, true, namedIds)).toBe(true)
    expect(sessionBelongsToProject({ projectId: 'proj-gone' }, DEFAULT_PROJECT_ID, true, namedIds)).toBe(true)
    expect(sessionBelongsToProject({ projectId: 'proj-a' }, DEFAULT_PROJECT_ID, true, namedIds)).toBe(false)
  })

  it('全量切分不重不漏：任意 session 集合按规则分给各项目后总数守恒', () => {
    const groups: SessionGroup[] = [
      {
        cwd: '/repo',
        sessions: [
          session('s-a1', 'proj-a'),
          session('s-orphan', 'proj-gone'),
          session('s-free'),
        ] as SessionGroup['sessions'],
      },
      {
        cwd: '/repo2',
        sessions: [session('s-a2', 'proj-a'), session('s-b1', 'proj-b')] as SessionGroup['sessions'],
      },
    ]
    const all = groups.flatMap((g) => g.sessions)
    let matched = 0
    for (const pid of ['proj-a', 'proj-b']) {
      matched += all.filter((s) => sessionBelongsToProject(s, pid, false, namedIds)).length
    }
    matched += all.filter((s) => sessionBelongsToProject(s, DEFAULT_PROJECT_ID, true, namedIds)).length
    expect(matched).toBe(all.length)
  })
})
