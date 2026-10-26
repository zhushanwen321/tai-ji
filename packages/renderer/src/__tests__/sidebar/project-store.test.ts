/**
 * 合并测试文件（renderer 测试提速 round5-d 分区 1 簇 1-15）。
 *
 * 本文件由以下 8 个测试文件原样搬运合并（describe/it 零改动，节内按来源分节；
 * 各节 import 已去重上提至文件头）：
 *  - src/__tests__/sidebar/project-store.test.ts（宿主）
 *  - src/__tests__/sidebar/project-ordering.test.ts（原 node 环境）
 *  - src/__tests__/stores/composer-injection.test.ts（原 node 环境）
 *  - src/__tests__/panel/gen-stats-display.test.ts（原 node 环境）
 *  - src/__tests__/types/w3-type-guard.test.ts（原 node 环境）
 *  - src/__tests__/i18n/panel-context-key-existence.test.ts（原 node 环境）
 *  - src/__tests__/mobile-token-mirror-parity.test.ts
 *  - src/__tests__/panel/context-usage-display.test.ts
 *
 * 环境说明：合并文件走默认 happy-dom；原 node 环境节均为纯逻辑 / fs 扫描测试，兼容。
 *
 * vi.mock 说明：'@/api' 门面 mock（project 域 load/save）由 project-store 与
 * project-ordering 两节共享（原两文件工厂逐字相同，各节 beforeEach mockClear 保实现）；
 * 其余六节不消费 '@/api'。[读码] 核实于合并时点。
 *
 * 路径说明：mobile-token 节的 style.css / mobile-renderer 相对路径已随本文件目录
 * （sidebar/）比原文件（__tests__/ 顶层）深一层而同步加一层 ../。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import type { Project, ProjectStoreState, SessionGroup, UpdateErrorPayload, ProxyTestResult } from '@taiji/shared'
import { useProjectStore, STORAGE_KEY, DEFAULT_PROJECT_ID } from '@/stores/project'
import { sessionBelongsToProject } from '@/composables/logic/project-session'
import { composerInjectionStore } from '@/composables/panel/composer-injection-store'
import {
  TTFT_DANGER_THRESHOLD_MS,
  TTFT_WARN_THRESHOLD_MS,
  cacheTierOf,
  formatTtftDuration,
  ttftTier,
} from '@/components/panel/gen-stats-display'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve, relative, sep } from 'node:path'
import zhPanel from '@taiji/ui/locale/zh-CN/panel'
import enPanel from '@taiji/ui/locale/en-US/panel'
import { usageBarClass } from '@/components/panel/context-usage-display'

// ══════════════════════════════════════════════════════════════════════════
// vi.mock 区（hoist 至文件顶部；project-store / project-ordering 两节共享）
// ══════════════════════════════════════════════════════════════════════════
vi.mock('@/api', () => ({
  project: { load: vi.fn(), save: vi.fn().mockResolvedValue(undefined) },
}))

import { project as projectApi } from '@/api'

const mockLoad = projectApi.load as unknown as ReturnType<typeof vi.fn>
const mockSave = projectApi.save as unknown as ReturnType<typeof vi.fn>

/** Project fixture 工厂（project-store / project-ordering 两节原各自定义、逐字相同，去重共享） */
function makeProject(id: string, name: string, lastUsedAt = 0): Project {
  return { id, name, lastUsedAt }
}

// ══════════════════════════════════════════════════════════════════════════
// 节 1/8 — 来源: src/__tests__/sidebar/project-store.test.ts
// ══════════════════════════════════════════════════════════════════════════

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

    // stale id 不再被 SessionList 分组/orderedProjects 高亮消费：回退到 nameless 默认项
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
    // 查「无 nameless 项」会 unshift 第二个 id='proj-default' → 重复 id 被持久化 + orderedProjects
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

// ── 读失败禁回写（RD-3#3 / 审计 M4：读失败被当「可覆写态」→ 整表覆盖 projects.json）──

describe('Project store: loadState 读失败禁回写', () => {
  it('init()：RPC reject → loadState=failed + loadError 落位，不阻断启动', async () => {
    mockLoad.mockRejectedValue(new Error('runtime not ready'))
    const store = useProjectStore()
    await expect(store.init()).resolves.toBeUndefined()
    expect(store.loadState).toBe('failed')
    expect(store.loadError).toBe('runtime not ready')
    expect(store.projects).toHaveLength(1) // 默认兜底（UI 永不空态）
  })

  it('failed 态下 state 变化不触发落盘 save（deep watch early-return）', async () => {
    mockLoad.mockRejectedValue(new Error('runtime not ready'))
    const store = useProjectStore()
    await store.init()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    store.addProject('X')
    store.setActiveProject(DEFAULT_PROJECT_ID)
    await nextTick()
    await nextTick()
    expect(mockSave).not.toHaveBeenCalled() // 防整表覆盖 projects.json
    // 「改动不会落盘」warn 一次（含原因与恢复指引）
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(warned).toContain('不会落盘')
    expect(warned).toContain('runtime not ready')
    warnSpy.mockRestore()
  })

  it('failed 态不走 legacy 迁移：localStorage 有旧数据也不 save（迁移 save 同样会覆写）', async () => {
    mockLoad.mockRejectedValue(new Error('runtime not ready'))
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ projects: [{ id: 'p1', name: '旧项目', lastUsedAt: 1 }], activeProjectId: 'p1' }),
    )
    const store = useProjectStore()
    await store.init()

    expect(store.loadState).toBe('failed')
    expect(mockSave).not.toHaveBeenCalled()
    expect(store.projects).toHaveLength(1) // 内存也保持默认兜底，不消费可能过期的 legacy 数据
  })

  it('重试（重新执行 init）成功 → loadState 回 loaded，落盘恢复', async () => {
    mockLoad.mockRejectedValueOnce(new Error('runtime not ready'))
    const store = useProjectStore()
    await store.init()
    expect(store.loadState).toBe('failed')

    mockLoad.mockResolvedValue({
      projects: [makeProject('proj-a', 'Alpha'), makeProject(DEFAULT_PROJECT_ID, '')],
      activeProjectId: 'proj-a',
    })
    await store.init() // 重试 = 重新执行 init
    expect(store.loadState).toBe('loaded')
    expect(store.loadError).toBe('')
    expect(store.projects).toHaveLength(2)

    mockSave.mockClear()
    store.addProject('B') // 落盘恢复
    await nextTick()
    expect(mockSave).toHaveBeenCalled()
    const saved = mockSave.mock.calls[0][0] as ProjectStoreState
    expect(saved.projects.some((p) => p.name === 'B')).toBe(true)
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

  it('setActiveProject：纯锚定切换——不改 lastUsedAt、orderedProjects 顺序不变（R6.2 不置顶）', () => {
    const store = useProjectStore()
    const a = store.addProject('A')
    const b = store.addProject('B')
    // 同毫秒创建 lastUsedAt 相同（tiebreaker = 持久化序）；显式设键锁定倒序断言语义
    store.projects.find((p) => p.id === a)!.lastUsedAt = 100
    store.projects.find((p) => p.id === b)!.lastUsedAt = 200
    store.setActiveProject(a)

    expect(store.activeProjectId).toBe(a)
    // 命名段按 lastUsedAt 倒序（B 较新在前），默认项目固定最后
    expect(store.orderedProjects.map((p) => p.id)).toEqual([b, a, DEFAULT_PROJECT_ID])
  })

  it('setActiveProject 不更新 lastUsedAt（排序键仅创建时写入，shared/project.ts 契约）', () => {
    const store = useProjectStore()
    const a = store.addProject('A')
    const b = store.addProject('B')
    const aBefore = store.projects.find((p) => p.id === a)!.lastUsedAt
    const bBefore = store.projects.find((p) => p.id === b)!.lastUsedAt

    store.setActiveProject(a)

    expect(store.projects.find((p) => p.id === a)!.lastUsedAt).toBe(aBefore) // 不 bump
    expect(store.projects.find((p) => p.id === b)!.lastUsedAt).toBe(bBefore) // 未动
    // addProject 用 Date.now()（同毫秒可能相等，断言不小于创建前时间即可）
    expect(store.projects.find((p) => p.id === b)!.lastUsedAt).toBeGreaterThan(0)
  })

  it('removeProject：默认项目不可删；保底不删最后一个；删活跃项锚定回落默认项目（spec sidebar §3.7）', () => {
    const store = useProjectStore()
    const a = store.addProject('A')
    const b = store.addProject('B')
    store.setActiveProject(a)

    store.removeProject(a)
    expect(store.projects).toHaveLength(2) // 默认 + B
    expect(store.activeProjectId).toBe(DEFAULT_PROJECT_ID) // 回落默认，非首个

    // 默认项目（DEFAULT_PROJECT_ID）不可删除（review MF-1 检查：未归类 session 的兜底聚合）
    store.removeProject(DEFAULT_PROJECT_ID)
    expect(store.projects.map((p) => p.id)).toEqual([DEFAULT_PROJECT_ID, b])

    store.removeProject(b)
    expect(store.projects).toHaveLength(1) // 只剩默认（保底不删最后一个）
    store.removeProject(store.projects[0]!.id)
    expect(store.projects).toHaveLength(1) // 默认项目检查再拦一次
  })

  it('renameProject：命名项目改名生效；默认项目拒改（nameless 身份检查，双保险见组件侧）', () => {
    const store = useProjectStore()
    const id = store.addProject('A')

    store.renameProject(id, 'A2')
    expect(store.projects.find((p) => p.id === id)!.name).toBe('A2')

    store.renameProject(id, '   ') // 空名检查
    expect(store.projects.find((p) => p.id === id)!.name).toBe('A2')

    store.renameProject(DEFAULT_PROJECT_ID, '改默认')
    expect(store.projects.find((p) => p.id === DEFAULT_PROJECT_ID)!.name).toBe('')
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

// ══════════════════════════════════════════════════════════════════════════
// 节 2/8 — 来源: src/__tests__/sidebar/project-ordering.test.ts
// ══════════════════════════════════════════════════════════════════════════

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

// ══════════════════════════════════════════════════════════════════════════
// 节 3/8 — 来源: src/__tests__/stores/composer-injection.test.ts
// ══════════════════════════════════════════════════════════════════════════

/**
 * composer-injection store 单元测试（W2, U5）。
 *
 * 验证 pendingInjection 单值消息槽：覆盖语义 + clearInjection + routeToLanding。
 * 参照 commandStore.pendingSlash 模式。
 */

describe('composer-injection store（W2）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // W4：store 改为模块级单例（composer-injection-store.ts），跨测试需显式清槽
    // （原 pinia wrapper 每次 setActivePinia 重建实例，单例没有该语义）
    composerInjectionStore.clearInjection()
  })

  it('U5: pendingInjection 单值覆盖（后者覆盖前者）', () => {
    const store = composerInjectionStore
    store.requestInjection({ target: 'current', path: 'a.ts', sessionId: 's1' })
    expect(store.pendingInjection.value?.path).toBe('a.ts')
    store.requestInjection({ target: 'current', path: 'b.ts', sessionId: 's1' })
    expect(store.pendingInjection.value?.path).toBe('b.ts')
  })

  it('U5b: requestInjection 内部补 ts', () => {
    const store = composerInjectionStore
    store.requestInjection({ target: 'current', path: 'a.ts', sessionId: 's1' })
    expect(store.pendingInjection.value?.ts).toBeTypeOf('number')
  })

  it('U5c: clearInjection 置 null', () => {
    const store = composerInjectionStore
    store.requestInjection({ target: 'current', path: 'a.ts', sessionId: 's1' })
    store.clearInjection()
    expect(store.pendingInjection.value).toBeNull()
  })

  it('U5d: payload 含 lineStart/lineEnd 时透传', () => {
    const store = composerInjectionStore
    store.requestInjection({
      target: 'current',
      path: 'a.ts',
      lineStart: 10,
      lineEnd: 20,
      sessionId: 's1',
    })
    expect(store.pendingInjection.value?.lineStart).toBe(10)
    expect(store.pendingInjection.value?.lineEnd).toBe(20)
  })

  it('U5e: target=new 时 sessionId 强制 null（新对话落地 landing composer）', () => {
    const store = composerInjectionStore
    store.requestInjection({ target: 'new', path: 'a.ts', sessionId: 's1' })
    expect(store.pendingInjection.value?.target).toBe('new')
    expect(store.pendingInjection.value?.sessionId).toBeNull()
  })

  it('U5f: routeToLanding 把 target 从 new 改 current 并重置 ts', () => {
    const store = composerInjectionStore
    store.requestInjection({ target: 'new', path: 'a.ts', sessionId: 's1' })
    const tsBefore = store.pendingInjection.value!.ts
    store.routeToLanding()
    expect(store.pendingInjection.value?.target).toBe('current')
    expect(store.pendingInjection.value?.sessionId).toBeNull()
    expect(store.pendingInjection.value!.ts).toBeGreaterThanOrEqual(tsBefore)
  })

  it('U5g: routeToLanding 无 pendingInjection 时 no-op', () => {
    const store = composerInjectionStore
    store.routeToLanding()
    expect(store.pendingInjection.value).toBeNull()
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 节 4/8 — 来源: src/__tests__/panel/gen-stats-display.test.ts
// ══════════════════════════════════════════════════════════════════════════

/**
 * gen-stats-display 显示纯函数测试（构建者白盒，直连模块命名导出）。
 *
 * [迁移来源] 原断言在 gen-stats-triggers.test.ts（经 GenStatsTriggers SFC 普通 script 块
 * 再导出直连）——ui-optimize 决策 6 退役平铺触发器形态后组件删除，纯函数本体
 * （gen-stats-display.ts）仍被 GenStatsTtftCard（hover 指标聚合页）消费，断言迁至本文件
 * 直连模块（SFC 再导出层随之消亡）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/gen-stats-display.test.ts
 */

describe('cacheTierOf 缓存命中率档位（demo ComposerBar cacheCls 对齐：≥80 success / ≥50 neutral / <50 warn）', () => {
  it('null / undefined → neutral（无值，显示「—」）', () => {
    expect(cacheTierOf(null)).toBe('neutral')
    expect(cacheTierOf(undefined)).toBe('neutral')
  })

  it('≥80 → success（demo mchip-ok --success）', () => {
    expect(cacheTierOf(100)).toBe('success')
    expect(cacheTierOf(80)).toBe('success')
  })

  it('50–79 → neutral 中性档（demo 无类保持 --dim——正常波动非告警）', () => {
    expect(cacheTierOf(79)).toBe('neutral')
    expect(cacheTierOf(50)).toBe('neutral')
  })

  it('<50 → warn（demo mchip-warn --warn；0 是真实测量值非无值）', () => {
    expect(cacheTierOf(49)).toBe('warn')
    expect(cacheTierOf(0)).toBe('warn')
  })
})

describe('TTFT 纯函数：formatTtftDuration / ttftTier', () => {
  it('formatTtftDuration：<1000 → 整数毫秒（0 是真实测量值显「0ms」，非无值）', () => {
    expect(formatTtftDuration(0)).toBe('0ms')
    expect(formatTtftDuration(820)).toBe('820ms')
    expect(formatTtftDuration(999)).toBe('999ms')
  })

  it('formatTtftDuration：≥1000 → s 1 位小数四舍五入去尾 0', () => {
    expect(formatTtftDuration(1000)).toBe('1s')
    expect(formatTtftDuration(1200)).toBe('1.2s')
    expect(formatTtftDuration(1250)).toBe('1.3s') // Math.round(12.5)=13 → 1.3s（四舍五入）
    expect(formatTtftDuration(1499)).toBe('1.5s')
    expect(formatTtftDuration(3000)).toBe('3s')
    expect(formatTtftDuration(3210)).toBe('3.2s')
  })

  it('ttftTier：阈值边界与 null 恒中性（S5；阈值常量与实现同源导入）', () => {
    expect(TTFT_WARN_THRESHOLD_MS).toBe(1500)
    expect(TTFT_DANGER_THRESHOLD_MS).toBe(3000)
    expect(ttftTier(null)).toBe('neutral')
    expect(ttftTier(0)).toBe('success')
    expect(ttftTier(1499)).toBe('success')
    expect(ttftTier(1500)).toBe('warn')
    expect(ttftTier(3000)).toBe('warn')
    expect(ttftTier(3001)).toBe('danger')
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 节 5/8 — 来源: src/__tests__/types/w3-type-guard.test.ts
// ══════════════════════════════════════════════════════════════════════════

/**
 * W3 验收测试 - 类型守卫
 *
 * 覆盖验收场景：
 * - W3-A8-type-guard-suggestion: UpdateErrorPayload 和 ProxyTestResult 类型存在且包含 suggestion 字段
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/types/w3-type-guard.test.ts
 */

describe('W3-A8-type-guard-suggestion', () => {
  it('W3-A8-type-guard-suggestion: UpdateErrorPayload 类型包含 suggestion 字段', () => {
    // 编译时类型检查：如果 suggestion 字段不存在，TypeScript 会报错
    const payload: UpdateErrorPayload = {
      stage: 'downloading',
      message: 'test',
      errorCode: 'UPDATE_PROXY_UNREACHABLE',
      suggestion: 'test suggestion',
    }
    expect(payload.suggestion).toBe('test suggestion')
  })

  it('W3-A8-type-guard-suggestion: ProxyTestResult 类型包含 suggestion 字段', () => {
    // 编译时类型检查：如果 suggestion 字段不存在，TypeScript 会报错
    const result: ProxyTestResult = {
      success: false,
      message: 'test',
      suggestion: 'test suggestion',
    }
    expect(result.suggestion).toBe('test suggestion')
  })

  it('W3-A8-type-guard-suggestion: UpdateErrorPayload 类型可选字段正确', () => {
    // 验证可选字段
    const payload: UpdateErrorPayload = {
      stage: 'downloading',
      message: 'test',
      // errorCode 和 suggestion 是可选的
    }
    expect(payload.errorCode).toBeUndefined()
    expect(payload.suggestion).toBeUndefined()
  })

  it('W3-A8-type-guard-suggestion: ProxyTestResult 类型可选字段正确', () => {
    // 验证可选字段
    const result: ProxyTestResult = {
      success: true,
      // code, message, suggestion 是可选的
    }
    expect(result.code).toBeUndefined()
    expect(result.message).toBeUndefined()
    expect(result.suggestion).toBeUndefined()
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 节 6/8 — 来源: src/__tests__/i18n/panel-context-key-existence.test.ts
// ══════════════════════════════════════════════════════════════════════════

/**
 * panel.context 命名空间的 i18n key 存在性机器门禁（同款机制见 provider-edit-key-existence.test.ts）。
 *
 * 防的回归：组件把 t('panel.context.x') 新增/改名之后，若 locale 双侧（zh-CN / en-US）
 * 同时缺同一个 key，用户会看到裸 key（渲染出 panel.context.x 字符串）而现有检查仍全绿：
 * - locale-sync-check 只比对双侧 key 集合一致，双侧同时缺同一个 key 抓不到；
 * - locale-key-usage-guard（存在 → 被引用的反向检查）不校验「引用侧必有 locale」；
 * - provider-edit-key-existence 只扫 settings.providerEdit 前缀，不覆盖 panel.context。
 * 本检查补齐 panel.context 这条「UI 引用了 → locale 必须有」的通路。
 *
 * 机制：扫 packages/ui/src 与 packages/renderer/src（排除 locale 文件与测试目录）
 * 中所有 `panel.context.<key>` 字面引用——要求 key 后紧跟引号/反引号收尾，动态拼接
 * `panel.context.${x}` 模板片段不会被误收（也不会假红）。
 * 对每个 key 断言其在 zh-CN / en-US 的 panel locale `context` 节点中都存在且为非空字符串。
 *
 * 自证不空转（防「扫描根写错 → 空集合恒绿」）：扫到的引用 key 数量有下界断言。
 *
 * 测试框架：vitest。运行：cd packages/renderer && npx vitest run src/__tests__/i18n/panel-context-key-existence.test.ts
 */

const REPO_ROOT = resolve(__dirname, '../../../../..')
/** panel.context key 的源码消费根；locale 与测试自身不算消费方 */
const SCAN_ROOTS = [join(REPO_ROOT, 'packages/ui/src'), join(REPO_ROOT, 'packages/renderer/src')]
const SKIP_DIRS = new Set(['node_modules', '__tests__', 'dist'])
const SOURCE_EXT = /\.(vue|ts|js|mjs)$/
/** `panel.context.<key>` 且 key 后紧跟引号/反引号收尾（动态拼接不匹配） */
const KEY_REF = /panel\.context\.([A-Za-z0-9_]+)(?=["'`])/g

/**
 * 扫描通路自证下界（防空集合恒绿）。当前生产源码静态引用 40+ 个 context key
 * （ContextCapacityCard / ContextChipsBar / GenStatsTtftCard / useQuotaDisplay 等），
 * 下界留在明显低于实况的档位，避免正常增删 key 触发假红，又足以在扫描根写错 /
 * 正则失效时立刻暴露。
 */
const MIN_SCANNED_REFS = 30

type FlatLocale = Record<string, string | undefined>

const ZH_CONTEXT = (zhPanel as unknown as { context: FlatLocale }).context
const EN_CONTEXT = (enPanel as unknown as { context: FlatLocale }).context

/** 扫源码收集 `panel.context.<key>` 引用；同 key 只记首个出现文件（用于报错定位） */
function collectSourceRefs(): Map<string, string> {
  const refs = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full)
        continue
      }
      if (!SOURCE_EXT.test(entry.name)) continue
      if (full.includes(`${sep}i18n${sep}locales${sep}`)) continue
      for (const m of readFileSync(full, 'utf-8').matchAll(KEY_REF)) {
        if (!refs.has(m[1])) refs.set(m[1], full)
      }
    }
  }
  for (const root of SCAN_ROOTS) walk(root)
  return refs
}

describe('panel.context i18n key 存在性机器门禁', () => {
  const refs = collectSourceRefs()

  it('源码扫描通路有效（扫到的 key 数量足以证明根路径与正则生效）', () => {
    expect(
      refs.size,
      '未从 packages/ui/src + packages/renderer/src 扫到足量 panel.context key，扫描根/正则可能失效',
    ).toBeGreaterThan(MIN_SCANNED_REFS)
  })

  for (const locale of ['zh-CN', 'en-US'] as const) {
    it(`${locale}: 每个被源码引用的 panel.context key 都存在且非空`, () => {
      const context = locale === 'zh-CN' ? ZH_CONTEXT : EN_CONTEXT
      const problems: string[] = []
      for (const [key, file] of refs) {
        const value = context[key]
        if (typeof value !== 'string' || value.trim().length === 0) {
          problems.push(`panel.context.${key}（引用自 ${relative(REPO_ROOT, file)}）`)
        }
      }
      expect(problems, `${locale} 缺失/空值 key:\n${problems.join('\n')}`).toEqual([])
    })
  }
})

// ══════════════════════════════════════════════════════════════════════════
// 节 7/8 — 来源: src/__tests__/mobile-token-mirror-parity.test.ts
// ══════════════════════════════════════════════════════════════════════════

/**
 * desktop ↔ mobile 令牌镜像一致性单测（ui-signal-density D3 / §5.3 U9，v8 断言范围）。
 *
 * packages/mobile-renderer/src/styles/tokens.css 是 renderer style.css tokens 段的
 * 镜像副本（文件头注释自述「真值源仍是 renderer style.css……改动须同步两处」），
 * 此前同步只有头注释口头约束、无机器检查，e2e-map 的 scope 也无一条覆盖
 * packages/mobile-renderer/**——本测试把人读对账（§4.1 V4⑥）升级为机器断言。
 *
 * 断言范围五组（两文件逐字相等）：
 *  1. :root 玄块 accent 主三值（--accent / --accent-hover / --accent-fg）
 *  2. :root 玄块 color-mix 派生式（--accent-soft / --accent-ring，两文件同为字面）
 *  3. shadcn 映射段（--primary / --ring 两行 var(--accent) 引用）
 *  4. desktop 侧定稿值锚定（防止双侧一起漂移成镜像一致的错值；demo 终态青玉 #7fb89c 族）
 *  5. :root 玄块 --neutral-fg-2 次级正文档（Tailwind text-neutral-fg-2 映射链依赖的镜像令牌）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/mobile-token-mirror-parity.test.ts
 */

const desktopSource = readFileSync(resolve(import.meta.dirname, '../../style.css'), 'utf-8')
const mobileSource = readFileSync(
  resolve(import.meta.dirname, '../../../../mobile-renderer/src/styles/tokens.css'),
  'utf-8',
)

/** 取文件第一个 `:root {` 块文本（玄主题块；[data-theme]/preset 块均在其后，不参与） */
function firstRootBlock(source: string, file: string): string {
  const start = source.indexOf(':root {')
  const end = source.indexOf('\n}', start)
  if (start < 0 || end < 0) throw new Error(`${file} 未找到 :root 块`)
  return source.slice(start, end)
}

/** 取 :root 块内某变量的完整声明行（trim 后，含行尾注释） */
function decl(block: string, name: string, file: string): string {
  const line = block.split('\n').find((l) => l.trimStart().startsWith(`${name}:`))
  if (!line) throw new Error(`${file} :root 块未找到 ${name} 声明`)
  return line.trim()
}

const desktopRoot = firstRootBlock(desktopSource, 'renderer style.css')
const mobileRoot = firstRootBlock(mobileSource, 'mobile-renderer tokens.css')

describe('mobile tokens.css ↔ renderer style.css 令牌镜像逐字一致（D3 / V4⑥ 单测侧）', () => {
  it('组 1：:root 玄块 accent 主三值逐字相等', () => {
    for (const name of ['--accent', '--accent-hover', '--accent-fg']) {
      expect(decl(mobileRoot, name, 'mobile')).toBe(decl(desktopRoot, name, 'desktop'))
    }
  })

  it('组 2：:root 玄块 color-mix 派生式（--accent-soft / --accent-ring）逐字相等', () => {
    for (const name of ['--accent-soft', '--accent-ring']) {
      expect(decl(mobileRoot, name, 'mobile')).toBe(decl(desktopRoot, name, 'desktop'))
    }
  })

  it('组 3：shadcn 映射段 --primary / --ring 两行 var(--accent) 引用逐字相等', () => {
    for (const name of ['--primary', '--ring']) {
      expect(decl(mobileRoot, name, 'mobile')).toBe(decl(desktopRoot, name, 'desktop'))
    }
  })

  it('组 4：desktop 侧定稿值锚定（demo 终态职能分色青玉 #7fb89c 族；防双侧同漂的假一致）', () => {
    expect(decl(desktopRoot, '--accent', 'desktop')).toContain('#7fb89c')
    expect(decl(desktopRoot, '--accent-hover', 'desktop')).toContain('#92c7ae')
    // demo 终态青玉 #7fb89c 对 #152019 对比 7.38:1 ≥ 4.5 AA
    expect(decl(desktopRoot, '--accent-fg', 'desktop')).toContain('#152019')
  })

  it('组 5：:root 玄块 --neutral-fg-2 次级正文档逐字相等 + desktop 值锚定（text-neutral-fg-2 映射链）', () => {
    expect(decl(mobileRoot, '--neutral-fg-2', 'mobile')).toBe(
      decl(desktopRoot, '--neutral-fg-2', 'desktop'),
    )
    expect(decl(desktopRoot, '--neutral-fg-2', 'desktop')).toContain('#d2d2d2')
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 节 8/8 — 来源: src/__tests__/panel/context-usage-display.test.ts
// ══════════════════════════════════════════════════════════════════════════

/**
 * context-usage-display 显示纯函数测试（MF-1-2：usageBarClass 分档边界锚）。
 *
 * usageBarClass 三分支严格大于边界（>90 danger / >70 warn / 默认 accent 渐变）此前零断言，
 * 分档阈值回归无锚。阈值常量未导出（模块内私有），用例以字面量数值锁定行为边界——
 * 常量改名/调档时本测试显式红灯，防静默漂移。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/context-usage-display.test.ts
 */

describe('usageBarClass 分档边界（严格大于）', () => {
  it('90（= danger 阈值）→ bg-warn（严格大于：90 仍属 70–90 warning 档，与模块头注释口径一致）', () => {
    expect(usageBarClass(90)).toBe('bg-warn')
  })

  it('91（> danger 阈值）→ bg-danger', () => {
    expect(usageBarClass(91)).toBe('bg-danger')
  })

  it('70（= warn 阈值）→ 默认渐变档（不严格大于 70）', () => {
    expect(usageBarClass(70)).toBe('bg-gradient-to-r from-accent to-accent-hover')
  })

  it('71（> warn 阈值且 ≤ danger 阈值）→ bg-warn', () => {
    expect(usageBarClass(71)).toBe('bg-warn')
  })
})

