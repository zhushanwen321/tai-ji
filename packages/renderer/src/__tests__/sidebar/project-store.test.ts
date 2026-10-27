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
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import type { Project, SessionGroup, SessionSummary, UpdateErrorPayload, ProxyTestResult } from '@taiji/shared'
import SessionList from '@/components/sidebar/SessionList.vue'
import { useProjectStore, DEFAULT_PROJECT_ID } from '@/stores/project'
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
  project: {
    load: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined), // legacy 通道（u6b 拆除），现行用例不再断言
    createProject: vi.fn(),
    renameProject: vi.fn(),
    removeProject: vi.fn(),
    setActiveProject: vi.fn(),
  },
}))

// 呈现组件测试的失败状态条重试钮断言源：partial mock 只覆写 requestDomainSync
// （useProjectGroups 的重试入口），其余 '@taiji/core' 导出保留真实实现。
vi.mock('@taiji/core', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestDomainSync: vi.fn(),
}))

import { project as projectApi } from '@/api'
import { requestDomainSync } from '@taiji/core'

const mockLoad = projectApi.load as unknown as ReturnType<typeof vi.fn>
const mockCreate = projectApi.createProject as unknown as ReturnType<typeof vi.fn>
const mockRename = projectApi.renameProject as unknown as ReturnType<typeof vi.fn>
const mockRemove = projectApi.removeProject as unknown as ReturnType<typeof vi.fn>
const mockSetActive = projectApi.setActiveProject as unknown as ReturnType<typeof vi.fn>
const mockRequestSync = requestDomainSync as unknown as ReturnType<typeof vi.fn>

/** Project fixture 工厂（project-store / project-ordering 两节共享） */
function makeProject(id: string, name: string, lastUsedAt = 0): Project {
  return { id, name, lastUsedAt }
}

/** load 回执 fixture（ProjectLoadReply：整表 + revision 水位，u6a runtime 契约） */
function makeLoadReply(
  projects: Project[],
  activeProjectId: string,
  revision = 0,
): { projects: Project[]; activeProjectId: string; revision: number } {
  return { projects, activeProjectId, revision }
}

/** 命令回执 fixture（ProjectCommandReply：执行后的完整新状态 + revision 新值） */
function makeCommandReply(
  projects: Project[],
  activeProjectId: string,
  revision: number,
): { state: { projects: Project[]; activeProjectId: string }; revision: number } {
  return { state: { projects, activeProjectId }, revision }
}

// ══════════════════════════════════════════════════════════════════════════
// 节 1/8 — 来源: src/__tests__/sidebar/project-store.test.ts
// ══════════════════════════════════════════════════════════════════════════

/**
 * Project store 测试（connection-datasync-ssot §6.5/§6.6/§6.9 改造后重写）。
 *
 * 覆盖：
 * - 状态机转移全表（§6.5）：idle→loading→loaded/failed、failed→loading（重试）、
 *   loaded→loading（重拉，不丢已持有数据）、loaded 态命令失败不改状态机、
 *   loading 态 syncLoad 重入 fail-fast（表外转移拒绝）
 * - 命令化（§6.6）：命令携带最近读到的 revision、回执提交整表 + revision 推进、
 *   同窗口命令串行排队（受控 promise）、无有效数据形态命令拒绝（§6.9）、本地语义守卫
 * - revision 跟随回执 + isStaleLoadReceipt 交错判据（§6.4）
 * - 三形态呈现（§6.7 组件测试，用户可见 DOM 断言）：无数据加载占位 / 失败状态条
 *   （原因 + 重试钮触发 project 域同步）/ 重拉子形态保留最后已知分组 + 编辑入口不禁用
 *
 * mock 策略：mock @/api 门面的 project 域（load + 4 命令）；mock @taiji/core 的
 * requestDomainSync（重试钮断言源）。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/project-store.test.ts
 */

beforeEach(() => {
  setActivePinia(createPinia())
  for (const m of [mockLoad, mockCreate, mockRename, mockRemove, mockSetActive, mockRequestSync]) {
    m.mockClear()
  }
  mockCreate.mockResolvedValue(makeCommandReply([makeProject(DEFAULT_PROJECT_ID, '')], DEFAULT_PROJECT_ID, 1))
  mockRename.mockResolvedValue(makeCommandReply([makeProject(DEFAULT_PROJECT_ID, '')], DEFAULT_PROJECT_ID, 1))
  mockRemove.mockResolvedValue(makeCommandReply([makeProject(DEFAULT_PROJECT_ID, '')], DEFAULT_PROJECT_ID, 1))
  mockSetActive.mockResolvedValue(makeCommandReply([makeProject(DEFAULT_PROJECT_ID, '')], DEFAULT_PROJECT_ID, 1))
})

describe('Project store: 状态机转移全表（§6.5）', () => {
  it('idle→loading→loaded：syncLoad + applyLoadReceipt 提交整表与 revision 水位', async () => {
    mockLoad.mockResolvedValue(
      makeLoadReply([makeProject(DEFAULT_PROJECT_ID, ''), makeProject('proj-a', 'Alpha')], 'proj-a', 7),
    )
    const store = useProjectStore()
    expect(store.loadState).toBe('idle')

    const loadPromise = store.syncLoad()
    expect(store.loadState).toBe('loading') // 转移先行（拉取在途即 loading）
    store.applyLoadReceipt(await loadPromise)

    expect(store.loadState).toBe('loaded')
    expect(store.loadError).toBe('')
    expect(store.projects.map((p) => p.id)).toEqual([DEFAULT_PROJECT_ID, 'proj-a'])
    expect(store.activeProjectId).toBe('proj-a')
    expect(store.revision).toBe(7)
  })

  it('idle→loading→failed：load reject → failed + loadError 落位，内存保持兜底不抛出链外', async () => {
    mockLoad.mockRejectedValue(new Error('runtime not ready'))
    const store = useProjectStore()

    await expect(store.syncLoad()).rejects.toThrow('runtime not ready')
    expect(store.loadState).toBe('failed')
    expect(store.loadError).toBe('runtime not ready')
    expect(store.projects).toHaveLength(1) // 兜底默认表（failed 态不渲染分组，见组件测试）
    expect(store.revision).toBeNull() // 从未读过：无期望 revision
  })

  it('failed→loading（重试）→loaded：再次 syncLoad 成功即恢复，loadError 清空', async () => {
    mockLoad.mockRejectedValueOnce(new Error('runtime not ready'))
    const store = useProjectStore()
    await expect(store.syncLoad()).rejects.toThrow()
    expect(store.loadState).toBe('failed')

    mockLoad.mockResolvedValue(makeLoadReply([makeProject(DEFAULT_PROJECT_ID, ''), makeProject('proj-a', 'Alpha')], 'proj-a', 2))
    store.applyLoadReceipt(await store.syncLoad())
    expect(store.loadState).toBe('loaded')
    expect(store.loadError).toBe('')
    expect(store.projects).toHaveLength(2)
  })

  it('loaded→loading（重拉）：在途回执未到期间不丢已持有数据（§6.7 重拉子形态的数据前提）', async () => {
    mockLoad.mockResolvedValue(makeLoadReply([makeProject(DEFAULT_PROJECT_ID, ''), makeProject('proj-a', 'Alpha')], 'proj-a', 1))
    const store = useProjectStore()
    store.applyLoadReceipt(await store.syncLoad())
    expect(store.loadState).toBe('loaded')

    // 重连边沿触发重拉：回执受控挂起
    let resolveReload!: (v: ReturnType<typeof makeLoadReply>) => void
    mockLoad.mockReturnValue(new Promise((resolve) => { resolveReload = resolve }))
    const reloadPromise = store.syncLoad()
    expect(store.loadState).toBe('loading')
    // 已持有数据原样保留（重拉子形态「保留最后已知分组」的 store 侧依据）
    expect(store.projects.map((p) => p.id)).toEqual([DEFAULT_PROJECT_ID, 'proj-a'])
    expect(store.activeProjectId).toBe('proj-a')
    expect(store.hasReceivedReceipt).toBe(true)

    resolveReload(makeLoadReply([makeProject(DEFAULT_PROJECT_ID, ''), makeProject('proj-b', 'Beta')], 'proj-b', 2))
    store.applyLoadReceipt(await reloadPromise)
    expect(store.loadState).toBe('loaded')
    expect(store.projects.map((p) => p.id)).toEqual([DEFAULT_PROJECT_ID, 'proj-b'])
  })

  it('loaded 态单条命令失败不改状态机：loadState 保持 loaded、内存保持命令前状态、错误 toast 出声', async () => {
    mockLoad.mockResolvedValue(makeLoadReply([makeProject(DEFAULT_PROJECT_ID, ''), makeProject('proj-a', 'Alpha')], 'proj-a', 1))
    const store = useProjectStore()
    store.applyLoadReceipt(await store.syncLoad())

    mockCreate.mockRejectedValue(new Error('revision mismatch'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(store.addProject('X')).rejects.toThrow('revision mismatch')
    expect(store.loadState).toBe('loaded') // 命令失败不进加载状态机
    expect(store.projects.some((p) => p.name === 'X')).toBe(false) // 内存保持命令前状态
    expect(store.activeProjectId).toBe('proj-a')
    expect(store.revision).toBe(1) // 水位不推进
    warnSpy.mockRestore()
  })

  it('loading 态 syncLoad 重入 = 表外转移 fail-fast（拒绝拉取，防绕过合流的重复在途）', async () => {
    let resolveLoad!: (v: ReturnType<typeof makeLoadReply>) => void
    mockLoad.mockReturnValue(new Promise((resolve) => { resolveLoad = resolve }))
    const store = useProjectStore()
    const first = store.syncLoad()
    expect(store.loadState).toBe('loading')

    await expect(store.syncLoad()).rejects.toThrow('re-entered')
    expect(mockLoad).toHaveBeenCalledTimes(1) // 重入未触发第二次拉取
    resolveLoad(makeLoadReply([makeProject(DEFAULT_PROJECT_ID, '')], DEFAULT_PROJECT_ID, 0))
    store.applyLoadReceipt(await first)
    expect(store.loadState).toBe('loaded')
  })

  it('被丢弃尝试的残留 loading：回执落定未提交（域同步器判旧丢弃形态）→ 下轮 syncLoad 放弃在途后重拉收敛', async () => {
    // F1-27 锁定：域同步器判旧丢弃路径不经 store（applyLoadReceipt / loadFailed 均不调用），
    // loading 残留而本 store 的 RPC 已落定；下轮 syncLoad（丢弃点补发轮）必须区分
    // 「真重入」（RPC 在途 → 拒绝）与「残留 loading」（RPC 已落定 → 放弃在途回滚后重拉），
    // 否则补发轮恒被重入守卫拒绝 → project 域重拉能力永久失效直至刷新页面。
    let resolveLoad!: (v: ReturnType<typeof makeLoadReply>) => void
    mockLoad.mockReturnValueOnce(new Promise((resolve) => { resolveLoad = resolve }))
    const store = useProjectStore()
    const first = store.syncLoad()
    expect(store.loadState).toBe('loading')
    resolveLoad(makeLoadReply([makeProject(DEFAULT_PROJECT_ID, '')], DEFAULT_PROJECT_ID, 5))
    await first
    // 丢弃形态：回执已返回但 applyLoadReceipt 未被调用 → loading 残留、RPC 不再在途
    expect(store.loadState).toBe('loading')
    expect(mockLoad).toHaveBeenCalledTimes(1)

    // 丢弃点补发轮：不撞重入守卫，放弃在途后重新拉取并提交收敛
    // （第二发用 base 实现——用例中途失败时不残留未消费的 once 实现污染后续用例）
    mockLoad.mockResolvedValue(
      makeLoadReply([makeProject(DEFAULT_PROJECT_ID, ''), makeProject('proj-a', 'Alpha')], 'proj-a', 6),
    )
    store.applyLoadReceipt(await store.syncLoad())
    expect(mockLoad).toHaveBeenCalledTimes(2)
    expect(store.loadState).toBe('loaded')
    expect(store.loadError).toBe('')
    expect(store.revision).toBe(6)
    expect(store.projects.map((p) => p.id)).toEqual([DEFAULT_PROJECT_ID, 'proj-a'])
  })
})

// ── 命令化（§6.6）：发命令、以回执更新；同窗口命令串行排队 ──────────────────

describe('Project store: 编辑动作命令化（§6.6）', () => {
  /** 装载到 loaded 态的 helper（回执链路真实走 syncLoad+apply，非直写状态） */
  async function loadTo(projects: Project[], activeProjectId: string, revision: number) {
    const store = useProjectStore()
    mockLoad.mockResolvedValue(makeLoadReply(projects, activeProjectId, revision))
    store.applyLoadReceipt(await store.syncLoad())
    return store
  }

  it('命令携带最近一次读到的 revision；回执提交整表并推进水位', async () => {
    const projects = [makeProject(DEFAULT_PROJECT_ID, ''), makeProject('proj-a', 'Alpha')]
    const store = await loadTo(projects, 'proj-a', 5)

    const created = [...projects, makeProject('proj-new', 'New', 100)]
    mockCreate.mockResolvedValue(makeCommandReply(created, 'proj-new', 6))
    await store.addProject('New')

    expect(mockCreate).toHaveBeenCalledWith('New', 5) // 期望 revision = load 回执学得的水位
    expect(store.projects.map((p) => p.id)).toEqual([DEFAULT_PROJECT_ID, 'proj-a', 'proj-new'])
    expect(store.activeProjectId).toBe('proj-new') // 回执驱动（非本地预写）
    expect(store.revision).toBe(6) // 水位推进到回执值

    // 下一条命令携带推进后的水位
    mockSetActive.mockResolvedValue(makeCommandReply(created, DEFAULT_PROJECT_ID, 7))
    await store.setActiveProject(DEFAULT_PROJECT_ID)
    expect(mockSetActive).toHaveBeenCalledWith(DEFAULT_PROJECT_ID, 6)
  })

  it('同窗口命令串行排队：上一条回执未到，下一条命令不发出（受控 promise）', async () => {
    const projects = [makeProject(DEFAULT_PROJECT_ID, ''), makeProject('proj-a', 'Alpha')]
    const store = await loadTo(projects, 'proj-a', 1)

    let resolveFirst!: (v: ReturnType<typeof makeCommandReply>) => void
    mockCreate.mockReturnValue(new Promise((resolve) => { resolveFirst = resolve }))
    const first = store.addProject('First')
    const second = store.setActiveProject(DEFAULT_PROJECT_ID)

    expect(mockSetActive).not.toHaveBeenCalled() // 第一条在途：第二条排队未发

    resolveFirst(makeCommandReply([...projects, makeProject('proj-first', 'First')], 'proj-first', 2))
    await first
    await second
    expect(mockSetActive).toHaveBeenCalledTimes(1) // 第一条 settle 后才发
    expect(mockSetActive).toHaveBeenCalledWith(DEFAULT_PROJECT_ID, 2) // 携带第一条回执推进的水位
  })

  it('无有效数据形态命令拒绝（§6.9 store 层保底）：未 loaded 不发命令、reject 出声', async () => {
    const store = useProjectStore()
    await expect(store.addProject('X')).rejects.toThrow('not loaded')
    expect(mockCreate).not.toHaveBeenCalled()

    // 从未成功的 loading 同样拒绝（无回执则期望 revision 缺失）
    let resolveLoad!: (v: ReturnType<typeof makeLoadReply>) => void
    mockLoad.mockReturnValue(new Promise((resolve) => { resolveLoad = resolve }))
    void store.syncLoad()
    await expect(store.addProject('Y')).rejects.toThrow('not loaded')
    expect(mockCreate).not.toHaveBeenCalled()
    resolveLoad(makeLoadReply([makeProject(DEFAULT_PROJECT_ID, '')], DEFAULT_PROJECT_ID, 0))
  })

  it('本地语义守卫：空名不创建；默认项目禁删禁改名；保底不删最后一个；未知 id 不动作', async () => {
    const projects = [makeProject(DEFAULT_PROJECT_ID, ''), makeProject('proj-a', 'Alpha')]
    const store = await loadTo(projects, DEFAULT_PROJECT_ID, 1)

    await store.addProject('   ')
    expect(mockCreate).not.toHaveBeenCalled()

    await store.removeProject(DEFAULT_PROJECT_ID) // review MF-1：兜底聚合无重建路径
    expect(mockRemove).not.toHaveBeenCalled()

    await store.renameProject(DEFAULT_PROJECT_ID, '改默认') // nameless 身份 = 聚合判据
    expect(mockRename).not.toHaveBeenCalled()

    await store.renameProject('proj-a', '   ')
    expect(mockRename).not.toHaveBeenCalled()

    await store.renameProject('ghost-id', '任意')
    expect(mockRename).not.toHaveBeenCalled()

    await store.setActiveProject('ghost-id')
    expect(mockSetActive).not.toHaveBeenCalled()

    // 只剩默认项时删除被保底拦截
    const single = await loadTo([makeProject(DEFAULT_PROJECT_ID, '')], DEFAULT_PROJECT_ID, 1)
    await single.removeProject(DEFAULT_PROJECT_ID)
    expect(mockRemove).not.toHaveBeenCalled()
  })
})

// ── revision 跟随回执 + 命令×同步交错判据（§6.4/§6.5⑤）──────────────────────

describe('Project store: revision 跟随与 isStaleLoadReceipt 判据（§6.4）', () => {
  it('未读过任何回执（revision null）恒不判旧', () => {
    const store = useProjectStore()
    expect(store.isStaleLoadReceipt(makeLoadReply([], DEFAULT_PROJECT_ID, 0))).toBe(false)
    expect(store.isStaleLoadReceipt(makeLoadReply([], DEFAULT_PROJECT_ID, 99))).toBe(false)
  })

  it('load 回执学得水位后：更早 revision 的快照判旧（期间有命令回执提交），不早于则不判旧', async () => {
    mockLoad.mockResolvedValue(makeLoadReply([makeProject(DEFAULT_PROJECT_ID, '')], DEFAULT_PROJECT_ID, 5))
    const store = useProjectStore()
    store.applyLoadReceipt(await store.syncLoad())

    expect(store.isStaleLoadReceipt(makeLoadReply([], DEFAULT_PROJECT_ID, 4))).toBe(true) // 旧快照
    expect(store.isStaleLoadReceipt(makeLoadReply([], DEFAULT_PROJECT_ID, 5))).toBe(false) // 当前水位
    expect(store.isStaleLoadReceipt(makeLoadReply([], DEFAULT_PROJECT_ID, 6))).toBe(false) // 更新快照
  })

  it('命令回执推进水位后，在途 load 的旧快照按新水位判旧（交错规则判据输入）', async () => {
    const projects = [makeProject(DEFAULT_PROJECT_ID, ''), makeProject('proj-a', 'Alpha')]
    mockLoad.mockResolvedValue(makeLoadReply(projects, 'proj-a', 3))
    const store = useProjectStore()
    store.applyLoadReceipt(await store.syncLoad())

    mockSetActive.mockResolvedValue(makeCommandReply(projects, DEFAULT_PROJECT_ID, 4))
    await store.setActiveProject(DEFAULT_PROJECT_ID)
    expect(store.revision).toBe(4)

    // 命令前发起、命令后到达的 load 回执（携带 revision=3）→ 判旧 → 域同步器丢弃 + 补发
    expect(store.isStaleLoadReceipt(makeLoadReply(projects, 'proj-a', 3))).toBe(true)
    expect(store.isStaleLoadReceipt(makeLoadReply(projects, 'proj-b', 4))).toBe(false)
  })
})

// ── 查询派生（缓存视图消费面）───────────────────────────────────────────────

describe('Project store: 查询派生', () => {
  it('同步初始态：默认 project 兜底（idle 窗口的 orderedProjects 消费方不空）', () => {
    const store = useProjectStore()
    expect(store.projects).toHaveLength(1)
    expect(store.activeProject!.name).toBe('')
    expect(store.isDefaultProject).toBe(true)
    expect(store.loadState).toBe('idle')
    expect(store.editingEnabled).toBe(false) // 无有效数据形态
  })

  it('editingEnabled：loaded 恒可用；重拉子形态（loading+已持有回执）不禁用；无数据 loading/failed 禁用', async () => {
    let resolveLoad!: (v: ReturnType<typeof makeLoadReply>) => void
    mockLoad.mockReturnValue(new Promise((resolve) => { resolveLoad = resolve }))
    const store = useProjectStore()
    const first = store.syncLoad()
    expect(store.editingEnabled).toBe(false) // 从未成功的 loading

    resolveLoad(makeLoadReply([makeProject(DEFAULT_PROJECT_ID, ''), makeProject('proj-a', 'Alpha')], 'proj-a', 1))
    store.applyLoadReceipt(await first)
    expect(store.editingEnabled).toBe(true) // loaded

    let resolveReload!: (v: ReturnType<typeof makeLoadReply>) => void
    mockLoad.mockReturnValue(new Promise((resolve) => { resolveReload = resolve }))
    const reload = store.syncLoad()
    expect(store.loadState).toBe('loading')
    expect(store.editingEnabled).toBe(true) // 重拉子形态（§6.9 不禁用）

    resolveReload(makeLoadReply([], DEFAULT_PROJECT_ID, 2))
    store.applyLoadReceipt(await reload)

    mockLoad.mockRejectedValue(new Error('down'))
    await expect(store.syncLoad()).rejects.toThrow()
    expect(store.editingEnabled).toBe(false) // failed
  })

  it('isDefaultProject：命名 project 非默认；默认 project（name 空）是默认', async () => {
    const store = useProjectStore()
    expect(store.isDefaultProject).toBe(true)
    mockLoad.mockResolvedValue(makeLoadReply([makeProject(DEFAULT_PROJECT_ID, ''), makeProject('proj-a', 'Alpha')], 'proj-a', 1))
    store.applyLoadReceipt(await store.syncLoad())
    expect(store.isDefaultProject).toBe(false)
  })
})

// ── 三形态呈现（§6.7 组件测试，用户可见 DOM 断言；§6.9 编辑入口禁用）──────────

describe('SessionList 项目分组区三形态呈现（§6.7）+ 编辑入口禁用（§6.9）', () => {
  function mountList(groups: SessionGroup[] = [
    { cwd: '/repo', sessions: [{ id: 'sa', label: '会话 sa', cwd: '/repo', status: 'idle', lastActiveAt: 1, projectId: 'proj-a' } as SessionSummary] },
  ]) {
    return mount(SessionList, {
      attachTo: document.body,
      props: {
        groups,
        activeId: null,
        statusOf: () => 'done' as never,
      },
    })
  }

  /** 直写缓存视图装载 loaded 态（呈现测试关注渲染分支，不经命令链） */
  function seedLoaded(store: ReturnType<typeof useProjectStore>, activeProjectId = DEFAULT_PROJECT_ID): void {
    store.projects = [makeProject(DEFAULT_PROJECT_ID, ''), makeProject('proj-a', 'Alpha')]
    store.activeProjectId = activeProjectId
    store.revision = 3
    store.loadState = 'loaded'
  }

  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('无数据形态（idle）：分组区渲染加载占位行，不渲染项目组；会话本体照常呈现（§6.7）', () => {
    useProjectStore() // idle 初态（未 load）
    const wrapper = mountList()

    expect(wrapper.find('[data-testid="project-group-loading-placeholder"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="project-group-loading-placeholder"]').text()).toContain('加载')
    // §6.7：会话列表本体（cwd 结构来自 runtime 会话清单）不受影响，正常显示
    expect(wrapper.find('[data-testid="session-body-flat"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="session-body-flat"]').findAll('.session-item')).toHaveLength(1)
    // 无数据形态不派生项目分组概念（不渲染兜底默认表 / 默认项目头行）
    expect(wrapper.find('[data-testid="default-project-flat-zone"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="default-project-head"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="project-group"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="project-load-failed-bar"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('failed：失败状态条（原因 + 重试钮）替代分组区；点重试触发 project 域同步；区头「+」禁用并带原因提示', async () => {
    const store = useProjectStore()
    store.loadState = 'failed'
    store.loadError = 'runtime not ready'
    const wrapper = mountList()

    const bar = wrapper.find('[data-testid="project-load-failed-bar"]')
    expect(bar.exists()).toBe(true)
    expect(bar.text()).toContain('项目数据加载失败')
    expect(bar.text()).toContain('runtime not ready') // 原因可见

    const retryBtn = wrapper.find('[data-testid="project-load-retry-btn"]')
    expect(retryBtn.exists()).toBe(true)
    await retryBtn.trigger('click')
    expect(mockRequestSync).toHaveBeenCalledWith('project') // 重试 = 触发 project 域同步

    // 编辑入口禁用（§6.9 无有效数据形态）+ 原因提示（title）
    const addBtn = wrapper.find('[data-testid="project-add-btn"]')
    expect(addBtn.attributes('disabled')).toBeDefined()
    expect(addBtn.attributes('title')).toContain('不可用')
    // 项目分组区不渲染（失败形态不渲染兜底默认表 / 默认项目头行）
    expect(wrapper.find('[data-testid="project-group"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="default-project-head"]').exists()).toBe(false)
    // §6.7 / §5.2：失败窗口会话列表本体照常呈现（失败窗口 65-90s 用户仍看得到会话）
    expect(wrapper.find('[data-testid="session-body-flat"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="session-body-flat"]').findAll('.session-item')).toHaveLength(1)
    wrapper.unmount()
  })

  it('目录模式 failed：失败状态条照常替换分组区；会话本体按 cwd 目录标签序列照常呈现、无默认项目头行（§5.2 会话列表本体（目录分组视图）+ §6.7）', () => {
    localStorage.setItem('taiji:sidebar-session-mode', 'groups')
    const store = useProjectStore()
    store.loadState = 'failed'
    store.loadError = 'runtime not ready'
    const wrapper = mountList([
      { cwd: '/repo', sessions: [{ id: 'sa', label: '会话 sa', cwd: '/repo', status: 'idle', lastActiveAt: 1, projectId: 'proj-a' } as SessionSummary] },
      { cwd: '/lib', sessions: [{ id: 'sb', label: '会话 sb', cwd: '/lib', status: 'idle', lastActiveAt: 2 } as SessionSummary] },
    ])

    // 失败状态条（§5.2）的渲染判据是 projectAreaMode，与侧栏 flat/groups 模式无关
    expect(wrapper.find('[data-testid="project-load-failed-bar"]').exists()).toBe(true)
    // §6.7 会话本体不受影响（目录形态）：降级渲染不经项目切分，目录标签序列（每 cwd 一行
    // SessionDirLabel）+ 会话行照常呈现——degradedZone.dirs 渲染路径（SessionList 目录分支）
    expect(wrapper.findAll('[data-testid="folder-actions"]')).toHaveLength(2)
    expect(wrapper.findAll('.session-item')).toHaveLength(2)
    // 降级形态不派生「默认项目」展示概念：无默认项目头行、无项目组（与平铺态 failed 断言同型）
    expect(wrapper.find('[data-testid="default-project-head"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="project-group"]').exists()).toBe(false)
    wrapper.unmount()
    localStorage.removeItem('taiji:sidebar-session-mode')
  })

  it('重拉子形态（loading + 已持有回执）：保留最后已知分组渲染、不闪占位；编辑入口不禁用（§6.9）', async () => {
    const store = useProjectStore()
    seedLoaded(store, 'proj-a')
    const wrapper = mountList()
    expect(wrapper.find('[data-testid="project-group"][data-project-id="proj-a"]').exists()).toBe(true)

    // 模拟重连边沿重拉在途：loadState → loading，缓存视图未替换（最后已知数据仍在）
    store.loadState = 'loading'
    await nextTick()

    expect(wrapper.find('[data-testid="project-group-loading-placeholder"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="project-load-failed-bar"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="project-group"][data-project-id="proj-a"]').exists()).toBe(true)
    // 编辑入口不禁用（§6.9：重拉是读操作，命令 revision 恒匹配）
    expect(wrapper.find('[data-testid="project-add-btn"]').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('loaded：分组正常渲染，编辑入口可用', () => {
    const store = useProjectStore()
    seedLoaded(store, 'proj-a')
    const wrapper = mountList()

    expect(wrapper.find('[data-testid="project-group-loading-placeholder"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="project-load-failed-bar"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="project-group"][data-project-id="proj-a"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="project-add-btn"]').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 节 2/8 — 来源: src/__tests__/sidebar/project-ordering.test.ts
// ══════════════════════════════════════════════════════════════════════════

/**
 * Project 排序单测（R6.2 锚定分组，用户裁决 2026-10-11「顺序稳定不置顶」）。
 *
 * 覆盖（数据装载均为直写缓存视图——命令化后排序派生测试不经命令链）：
 *  - orderedProjects 稳定序：命名项目按 lastUsedAt 倒序（该字段仅创建时写入）、
 *    同值按持久化序稳定；默认项目（nameless）固定最后
 *  - 锚定切换零重排：反复切换显示序逐字不变（「切换只改变谁展开，不重排组位置」裁决锚点）
 *  - 新建项目落位：最新 lastUsedAt 落在命名段首位、默认项目仍在最后
 *  - sessionBelongsToProject：归属判定规则 SSOT（命名精确匹配；默认聚合未归类 + 孤儿）
 * （renameProject/removeProject 行为断言随命令化重写并入节 1「编辑动作命令化」。）
 *
 * mock 策略：mock @/api 门面的 project 域（store 走门面，同 project-store.test.ts）。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/project-store.test.ts
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

  it('新建项目落位：最新 lastUsedAt 落命名段首位，默认项目仍在最后', () => {
    const store = useProjectStore()
    store.projects = [
      makeProject('old', 'Old', 100),
      makeProject(DEFAULT_PROJECT_ID, '', 0),
    ]
    store.activeProjectId = 'old'

    // 直写缓存视图模拟已加载回执（connection-datasync-ssot §6.6：addProject 已命令化，
    // 排序派生测试不经命令链——新项目由回执写入，lastUsedAt 由 runtime 生成）
    const newId = 'proj-fresh'
    store.projects = [...store.projects, makeProject(newId, 'Fresh', Date.now())]
    store.activeProjectId = newId

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

    // 直写锚定（setActiveProject 已命令化——排序派生测试不经命令链；回执提交同为直写形态）
    store.activeProjectId = 'b'
    expect(store.orderedProjects.map((p) => p.id)).toEqual(orderBefore)

    store.activeProjectId = 'c'
    store.activeProjectId = 'b'
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

    // 直写缓存视图模拟改名回执（renameProject 已命令化——排序派生测试不经命令链）
    store.projects = store.projects.map((p) => (p.id === 'b' ? { ...p, name: 'B2' } : p))

    expect(store.orderedProjects.map((p) => p.id)).toEqual(['a', 'b', DEFAULT_PROJECT_ID])
    expect(store.projects.find((p) => p.id === 'b')!.name).toBe('B2')
  })
})

// renameProject 行为断言（生效 / 空名 / 未知 id / 默认项目禁改名）已随命令化重写并入
// 节 1「编辑动作命令化」的「本地语义守卫」与「命令携带 revision」两用例，此处不再重复。

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

