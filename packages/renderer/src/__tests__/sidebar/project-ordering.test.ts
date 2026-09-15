/**
 * Project 排序与 reorder 单测（ProjectSwitcher 3A，D7 用户控制序 + drop 密集重排）。
 *
 * 覆盖（u5 验收①四类 + badge 共享计数规则；2026-09-02 排序语义修正后）：
 *  - 用户控制序：有 userOrder 升序排前段；无 userOrder 按原数组序（创建/持久化序）
 *    稳定排后段——active 置顶 / lastUsedAt 已移除，点击任何项目顺序均不变
 *  - 新建项目落位：addProject 的新项目（无 userOrder）落在列表末尾
 *  - drop 密集重排：reorderProject 提交后整表密集重编号 0..n-1，
 *    消除稀疏（拖到首位即首位 / 中间即中间 / 删除遗留空洞被重编）
 *  - 默认项目同卡同权：可获 userOrder、参与排序
 *  - 切换 active 不改顺序：setActiveProject 只更新 lastUsedAt，显示顺序完全不变
 *  - sessionBelongsToProject / computeProjectSessionCounts：badge 计数与 SessionList
 *    过滤同一规则（命名精确匹配；默认聚合未归类 + 孤儿）
 *
 * mock 策略：mock @/api 门面的 project 域（store 走门面，同 project-store.test.ts）。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/project-ordering.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Project, SessionGroup } from '@taiji/shared'
import { useProjectStore, DEFAULT_PROJECT_ID } from '@/stores/project'
import {
  sessionBelongsToProject,
  computeProjectSessionCounts,
} from '@/composables/logic/project-session'

vi.mock('@/api', () => ({
  project: { load: vi.fn(), save: vi.fn().mockResolvedValue(undefined) },
}))

function makeProject(id: string, name: string, lastUsedAt = 0, userOrder?: number): Project {
  return userOrder === undefined ? { id, name, lastUsedAt } : { id, name, lastUsedAt, userOrder }
}

/** 断言 userOrder 按给定 id 顺序密集编号 0..n-1 */
function expectDenseOrder(store: ReturnType<typeof useProjectStore>, ids: string[]) {
  ids.forEach((id, expected) => {
    expect(store.projects.find((p) => p.id === id)!.userOrder).toBe(expected)
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('recentProjects 用户控制序（D7，2026-09-02 语义修正）', () => {
  it('有 userOrder 升序排前段；无 userOrder 按原数组序稳定排后段，active 位置无关', () => {
    const store = useProjectStore()
    store.projects = [
      makeProject('a', 'A', 300, 1),
      makeProject('b', 'B', 100, 0),
      makeProject('c', 'C', 300),
      makeProject('d', 'D', 100),
    ]
    // active 是无序段的 d——若残留 active 置顶旧规则会显示 [b, a, d, c]
    store.activeProjectId = 'd'

    // 有序段 [B(0), A(1)] 在前；无序段按原数组序 [C, D]
    expect(store.recentProjects.map((p) => p.id)).toEqual(['b', 'a', 'c', 'd'])
  })

  it('activeProject 落在有序段时其 userOrder 位次即显示位次', () => {
    const store = useProjectStore()
    store.projects = [
      makeProject('x1', 'X1', 0, 0),
      makeProject('x2', 'X2', 0, 1),
      makeProject('z', 'Z', 999),
    ]
    store.activeProjectId = 'x2'

    expect(store.recentProjects.map((p) => p.id)).toEqual(['x1', 'x2', 'z'])
  })

  it('点击不改顺序：全无 userOrder 时显示序 = 原数组序，active 不置顶、lastUsedAt 无关', () => {
    const store = useProjectStore()
    // lastUsedAt 故意与数组序逆序；active 是 b——旧自动序规则会显示 [b, a, c]
    store.projects = [
      makeProject('a', 'A', 300),
      makeProject('b', 'B', 100),
      makeProject('c', 'C', 200),
    ]
    store.activeProjectId = 'b'
    expect(store.recentProjects.map((p) => p.id)).toEqual(['a', 'b', 'c'])
  })

  it('新建项目落位：无有序卡时 addProject 的新项目落在列表末尾（不因 active 置顶）', () => {
    const store = useProjectStore()
    store.projects = [makeProject(DEFAULT_PROJECT_ID, '', 0)]
    store.activeProjectId = DEFAULT_PROJECT_ID

    const newId = store.addProject('Fresh')

    // 新项目无 userOrder，push 数组尾 → 落无序段末尾
    expect(store.recentProjects.map((p) => p.id)).toEqual([DEFAULT_PROJECT_ID, newId])
  })

  it('新建项目落位：有有序卡时新项目位于有序段之后的无序段末尾', () => {
    const store = useProjectStore()
    store.projects = [
      makeProject('x1', 'X1', 0, 0),
      makeProject('x2', 'X2', 0, 1),
      makeProject(DEFAULT_PROJECT_ID, '', 100),
    ]
    store.activeProjectId = 'x1'

    const newId = store.addProject('Fresh')

    // 有序段在前；无序段按原数组序 [DEFAULT, newId]
    expect(store.recentProjects.map((p) => p.id)).toEqual(['x1', 'x2', DEFAULT_PROJECT_ID, newId])
  })
})

describe('reorderProject：drop 位置密集重排（D7 赋号语义）', () => {
  it('用户序段内拖动：段内换位后整段密集重编号 0..n-1', () => {
    const store = useProjectStore()
    store.projects = [
      makeProject('x1', 'X1', 0, 0),
      makeProject('x2', 'X2', 0, 1),
      makeProject('x3', 'X3', 0, 2),
    ]
    store.activeProjectId = 'x1'

    // 把末位拖到首位（拖到首位即首位，非尾部——D7 被否方案的反例锚点）
    store.reorderProject('x3', 'x1')

    expect(store.recentProjects.map((p) => p.id)).toEqual(['x3', 'x1', 'x2'])
    expectDenseOrder(store, ['x3', 'x1', 'x2'])
  })

  it('无序卡首次拖到有序段首位：插入落点、整表一起密集编号', () => {
    const store = useProjectStore()
    store.projects = [
      makeProject('x1', 'X1', 0, 0),
      makeProject('x2', 'X2', 0, 1),
      makeProject('a', 'A', 500),
    ]
    store.activeProjectId = 'x1'

    store.reorderProject('a', 'x1')

    expect(store.recentProjects.map((p) => p.id)).toEqual(['a', 'x1', 'x2'])
    expectDenseOrder(store, ['a', 'x1', 'x2'])
  })

  it('无序卡拖到有序段中间位置：落点即位次（A5 中间位置场景）', () => {
    const store = useProjectStore()
    store.projects = [
      makeProject('x1', 'X1', 0, 0),
      makeProject('x2', 'X2', 0, 1),
      makeProject('a', 'A', 500),
    ]
    store.activeProjectId = 'x1'

    store.reorderProject('a', 'x2')

    expect(store.recentProjects.map((p) => p.id)).toEqual(['x1', 'a', 'x2'])
    expectDenseOrder(store, ['x1', 'a', 'x2'])
  })

  it('稀疏 userOrder（删除项目遗留空洞）被下一次 reorder 消除为 0..n-1', () => {
    const store = useProjectStore()
    // 模拟删除 x2 后遗留 userOrder [0, 2] 的稀疏段
    store.projects = [makeProject('x1', 'X1', 0, 0), makeProject('x3', 'X3', 0, 2)]
    store.activeProjectId = 'x1'

    store.reorderProject('x3', 'x1')

    expectDenseOrder(store, ['x3', 'x1'])
    expect(store.recentProjects.map((p) => p.id)).toEqual(['x3', 'x1'])
  })

  it('全量定序（review MF-12）：reorder 后完整显示序固化为用户序，auto 卡不再瞬移', () => {
    const store = useProjectStore()
    store.projects = [
      makeProject('x1', 'X1', 0, 0),
      makeProject('a', 'A', 500),
      makeProject('b', 'B', 400),
    ]
    store.activeProjectId = 'x1'

    // 把 auto 卡 a 拖到首位：旧语义只 pin 被拖卡（a.userOrder=0 瞬移到段首，
    // b 仍 auto 落段尾 → 显示 [a, x1, b] 与拖拽落点 [a, x1, b]…但键盘/auto 段内
    // 拖动会瞬移到网格边缘）。新语义全量定序：显示序 ≡ splice 结果。
    store.reorderProject('a', 'x1')

    expect(store.recentProjects.map((p) => p.id)).toEqual(['a', 'x1', 'b'])
    expectDenseOrder(store, ['a', 'x1', 'b'])
  })

  // [review MF-12] 键盘 ↑/↓ 相邻交换双向回归：auto 段卡片（旧语义会瞬移到段首）
  it('全 auto 卡上移（D→C）：显示序 = 相邻交换 [A,B,D,C,E]，非瞬移 [D,A,B,C,E]', () => {
    const store = useProjectStore()
    store.projects = [
      makeProject('A', 'A', 500),
      makeProject('B', 'B', 400),
      makeProject('C', 'C', 300),
      makeProject('D', 'D', 200),
      makeProject('E', 'E', 100),
    ]
    store.activeProjectId = 'A'
    // 显示序 = 原数组序 = [A,B,C,D,E]；键盘 ↑ 等价于
    // reorderProject(D, C)（moveCard 邻居目标）
    store.reorderProject('D', 'C')
    expect(store.recentProjects.map((p) => p.id)).toEqual(['A', 'B', 'D', 'C', 'E'])
    expectDenseOrder(store, ['A', 'B', 'D', 'C', 'E'])
  })

  it('全 auto 卡下移（D→E）：显示序 = 相邻交换 [A,B,C,E,D]，非 no-op 也非瞬移', () => {
    const store = useProjectStore()
    store.projects = [
      makeProject('A', 'A', 500),
      makeProject('B', 'B', 400),
      makeProject('C', 'C', 300),
      makeProject('D', 'D', 200),
      makeProject('E', 'E', 100),
    ]
    store.activeProjectId = 'A'
    // 键盘 ↓ 等价于 reorderProject(D, E)
    store.reorderProject('D', 'E')
    expect(store.recentProjects.map((p) => p.id)).toEqual(['A', 'B', 'C', 'E', 'D'])
    expectDenseOrder(store, ['A', 'B', 'C', 'E', 'D'])
  })

  it('守卫：同卡拖到自身 / 未知 id 不产生任何变更', () => {    const store = useProjectStore()
    store.projects = [makeProject('x1', 'X1', 0, 0), makeProject('a', 'A', 1)]
    store.activeProjectId = 'x1'

    store.reorderProject('x1', 'x1')
    store.reorderProject('x1', 'ghost-id')
    expect(store.recentProjects.map((p) => p.id)).toEqual(['x1', 'a'])
    expectDenseOrder(store, ['x1'])
  })
})

describe('默认项目同卡同权（D7）', () => {
  it('默认项目可被拖拽赋 userOrder，与命名项目同规则参与排序', () => {
    const store = useProjectStore()
    store.projects = [
      makeProject(DEFAULT_PROJECT_ID, '', 0),
      makeProject('x1', 'X1', 0, 0),
      makeProject('a', 'A', 500),
    ]
    store.activeProjectId = 'x1'

    // 默认项目拖到用户序段首位
    store.reorderProject(DEFAULT_PROJECT_ID, 'x1')

    expect(store.recentProjects.map((p) => p.id)).toEqual([DEFAULT_PROJECT_ID, 'x1', 'a'])
    expect(store.projects.find((p) => p.id === DEFAULT_PROJECT_ID)!.userOrder).toBe(0)
    expectDenseOrder(store, [DEFAULT_PROJECT_ID, 'x1'])
  })

  it('无 userOrder 时默认项目按原数组序排列（active 不置顶）', () => {
    const store = useProjectStore()
    store.projects = [
      makeProject(DEFAULT_PROJECT_ID, '', 100),
      makeProject('a', 'A', 300),
    ]
    store.activeProjectId = 'a'

    expect(store.recentProjects.map((p) => p.id)).toEqual([DEFAULT_PROJECT_ID, 'a'])
  })
})

describe('切换 active 不改顺序（D7：切换 ≠ 排序意图，需求锚点 2026-09-02）', () => {
  it('在有序段内来回切换 active，显示顺序保持 userOrder 不变', () => {
    const store = useProjectStore()
    store.projects = [
      makeProject('x1', 'X1', 0, 0),
      makeProject('x2', 'X2', 0, 1),
      makeProject('x3', 'X3', 0, 2),
      makeProject('z', 'Z', 999),
    ]
    store.activeProjectId = 'x1'

    store.setActiveProject('x3')
    expect(store.recentProjects.map((p) => p.id)).toEqual(['x1', 'x2', 'x3', 'z'])

    store.setActiveProject('x2')
    expect(store.recentProjects.map((p) => p.id)).toEqual(['x1', 'x2', 'x3', 'z'])

    // lastUsedAt 被更新，但排序与 lastUsedAt 无关
    expect(store.projects.find((p) => p.id === 'x2')!.lastUsedAt).toBeGreaterThan(0)
    expectDenseOrder(store, ['x1', 'x2', 'x3'])
  })

  it('切换到无 userOrder 项目：整个列表顺序完全不变（点击不改顺序）', () => {
    const store = useProjectStore()
    store.projects = [
      makeProject('x1', 'X1', 0, 0),
      makeProject('a', 'A', 500),
      makeProject('b', 'B', 100),
    ]
    store.activeProjectId = 'x1'

    store.setActiveProject('b')
    expect(store.recentProjects.map((p) => p.id)).toEqual(['x1', 'a', 'b'])

    // 再切到 a，顺序依然不动（旧规则会 b 置顶）
    store.setActiveProject('a')
    expect(store.recentProjects.map((p) => p.id)).toEqual(['x1', 'a', 'b'])
  })
})

// ── badge 共享计数规则（与 SessionList 过滤同一 SSOT）─────────────
function session(id: string, projectId?: string) {
  return { id, projectId }
}

describe('sessionBelongsToProject / computeProjectSessionCounts（badge 规则 SSOT）', () => {
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
  const projects = [
    makeProject('proj-default', ''),
    makeProject('proj-a', 'Alpha'),
    makeProject('proj-b', 'Beta'),
  ]
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

  it('computeProjectSessionCounts：每卡计数 = 点击后 SessionList 过滤显示数', () => {
    const counts = computeProjectSessionCounts(groups, projects)
    expect(counts.get('proj-a')).toBe(2)
    expect(counts.get('proj-b')).toBe(1)
    expect(counts.get('proj-default')).toBe(2) // s-orphan + s-free
  })
})
