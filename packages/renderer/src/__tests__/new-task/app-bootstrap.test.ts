/**
 * App 启动编排集成测试（connection-datasync-ssot §6.4 终态语义；原「一次性编排 + 重连分支
 * 手写刷新」两套编排已被域同步器收敛，本文件锁定新语义）。
 *
 * 关键约束：**不 mock useNewTaskFlow / useSidebar 编排本体**（真实 useNewTaskFlow 状态机 +
 * useSidebar.initApp 编排 + core 域同步器登记跑通）。只 mock 最外层 @/api 与外围命令注册。
 *
 * 锁定的新语义（任一回归立刻红）：
 * - 启动编排只跑一次：initApp 幂等（appBootstrapped），重连不重跑编排（不重复 startFlow）
 * - initApp 等 project 域首次同步落定（成功或失败均落定）后才进落地页——归属预填时序约束
 *   （createSessionFlow 读 activeProjectId）由域同步器落定 promise 承载（impl-plan u4 验收 5）
 * - 重连边沿走域同步器：三数据域重拉 + 辅助刷新由 notifyConnectedEdge（connected 边沿）触发，
 *   不经 initApp（重连时 initApp 幂等跳过）
 * - 域同步失败不阻断启动：sessions 域失败留痕（重试型），landing 照常进入
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/new-task/app-bootstrap.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { SessionSummary, SessionGroup } from '@taiji/shared'
import { notifyConnectedEdge } from '@taiji/core'

// 可控依赖：project.load（project 域同步）、session.list/create/switchSession/remove
const projectCtrl = vi.hoisted(() => ({
  load: vi.fn<() => Promise<{ projects: unknown[]; activeProjectId: string }>>(),
}))
const sessionCtrl = vi.hoisted(() => ({
  list: vi.fn<() => Promise<SessionGroup[]>>(),
  create: vi.fn<(cwd?: string) => Promise<SessionSummary>>(),
  switchSession: vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined),
  remove: vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined),
}))
const chatCtrl = vi.hoisted(() => ({
  // 返回空历史（首次启动无消息；非首启动 loadSessions 全量 hydrate 用空数组占位）
  getHistory: vi.fn<(id: string) => Promise<unknown[]>>().mockResolvedValue([]),
}))

vi.mock('@/api', () => ({
  project: { load: projectCtrl.load },
  session: {
    list: sessionCtrl.list,
    create: sessionCtrl.create,
    switchSession: sessionCtrl.switchSession,
    remove: sessionCtrl.remove,
  },
  chat: { getHistory: chatCtrl.getHistory },
  // 重连边沿辅助刷新（extension-scan）经域同步器触发（fire-and-forget）→ 给 resolve
  extension: { scan: vi.fn().mockResolvedValue(undefined) },
  // 预填/切入链外围（fire-and-forget，补 mock 避免 unhandled rejection）
  file: { tree: vi.fn().mockResolvedValue([]), expand: vi.fn().mockResolvedValue([]) },
  git: { status: vi.fn().mockResolvedValue({ isRepo: false }) },
  workspace: { detect: vi.fn().mockResolvedValue({ mode: 'not-repo', isBareMode: false, wsRoot: '', repoRoot: '' }) },
  worktree: { list: vi.fn().mockResolvedValue([]) },
}))

// 命令注册 mock 成 no-op vi.fn：用例 9 经 mockImplementation 验证 initApp 自身编排错误
// 的复位通道（真实实现非本文件被测对象）。
vi.mock('@/composables/features/command/useAppCommands', () => ({
  registerAppCommands: vi.fn(),
}))

// W3: mock workspaceStore 让 initApp 能正确预填 cwd（workspace 域同步函数经它驱动）
const workspaceStoreMock = vi.hoisted(() => ({
  records: [] as Array<{ cwd: string; lastUsedAt: number; label: string }>,
  defaultCwd: undefined as string | undefined,
  load: vi.fn(),
  // workspace 域同步函数内 await（§6.4③：loadDefaultSessionDir 纳入 workspace 域）
  loadDefaultSessionDir: vi.fn(),
  defaultSessionDir: '' as string,
  setPinned: vi.fn(async () => true),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: vi.fn(() => workspaceStoreMock),
}))

// useNewTaskFlow / useSidebar 均用真实实现（不 mock）——这是本测试的核心价值
import { useSidebar, resetAppBootstrap } from '@/composables/features/sidebar/useSidebar'
import { useNewTaskFlow, resetNewTaskFlow, __testing } from '@/composables/features/new-task/useNewTaskFlow'
import { useSessionStore } from '@/stores/session'
import { registerAppCommands } from '@/composables/features/command/useAppCommands'

beforeEach(() => {
  setActivePinia(createPinia())
  resetNewTaskFlow()
  resetAppBootstrap()
  // 壳层 cachedFlow 单例重置：cachedFlow 闭包捕获构造时的 pinia store 实例，setActivePinia
  // 重建后旧引用漂移（clearActiveSession 清的是旧 store）——每个用例前强制重建。
  __testing.__resetNewTaskFlowForTesting()
  vi.clearAllMocks()
  projectCtrl.load.mockResolvedValue({ projects: [], activeProjectId: '' })
  // sessions 域同步默认空表：initApp 预填链在两域落定后读 sessionStore.getList()，
  // 未实现 mock 会让 applySnapshot(undefined) 写穿 store（unhandled rejection）
  sessionCtrl.list.mockResolvedValue([])
  sessionCtrl.switchSession.mockResolvedValue(undefined)
  sessionCtrl.remove.mockResolvedValue(undefined)
  chatCtrl.getHistory.mockResolvedValue([])
  // 重置 workspaceStore mock
  workspaceStoreMock.records = []
  workspaceStoreMock.defaultCwd = undefined
})

/** 排空启动链微任务（域同步器 settle → 预填 then 回调的就绪等待）。 */
async function flushBootstrap(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function mkSession(over: Partial<SessionSummary>): SessionSummary {
  return {
    id: over.id ?? 's',
    label: over.label ?? 'label',
    cwd: over.cwd ?? '/repo',
    status: 'idle',
    lastActiveAt: over.lastActiveAt ?? 0,
    ...over,
  }
}

describe('App 启动编排（initApp：等 project 域首次落定后进 landing 落地页）', () => {
  it('验收 5：initApp 等 project 域首次同步落定后才进落地页（落定前 state=idle，不提前 startFlow）', async () => {
    let resolveProjectLoad!: (v: { projects: unknown[]; activeProjectId: string }) => void
    projectCtrl.load.mockReturnValue(
      new Promise<{ projects: unknown[]; activeProjectId: string }>((resolve) => {
        resolveProjectLoad = resolve
      }),
    )
    const initPromise = useSidebar().initApp()
    await flushBootstrap()
    // project 域在途：whenSettled 未 settle → 编排停在落地页进入前（state 停 idle）
    expect(useNewTaskFlow().state.value).toBe('idle')

    // project 域首次落定（成功）→ 编排继续 → 进 landing
    resolveProjectLoad({ projects: [], activeProjectId: '' })
    await initPromise
    const flow = useNewTaskFlow()
    expect(flow.state.value).toBe('landing')
    // chip 可点（问题 3 回归防护：landing 态 transition 合法不抛错）
    expect(() => flow.openDirPopover()).not.toThrow()
    expect(flow.state.value).toBe('dir-popover')
  })

  it('project 域首次落定（失败也落定）：load reject → landing 照常进入（失败呈现走 project store 状态机）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      projectCtrl.load.mockRejectedValue(new Error('runtime not ready'))
      await useSidebar().initApp()
      const flow = useNewTaskFlow()
      // 失败也算落定 → 不死等；landing 照常进入
      expect(flow.state.value).toBe('landing')
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('首次启动（无 session）：initApp → startFlow 延迟 create → state=landing → chip 可点', async () => {
    sessionCtrl.list.mockResolvedValue([]) // 无历史 → 延迟 create
    await useSidebar().initApp()
    await flushBootstrap()

    const flow = useNewTaskFlow()
    expect(flow.state.value).toBe('landing')
    expect(flow.currentSessionId.value).toBeNull() // 延迟 create，无绑定 session（AC-1.7）
    expect(sessionCtrl.create).not.toHaveBeenCalled() // 首次启动不 create

    // 问题3 防护：state=landing 时 directory chip 的 transition('dir-popover') 合法，不抛错回 idle
    expect(() => flow.openDirPopover()).not.toThrow()
    expect(flow.state.value).toBe('dir-popover')
  })

  it('首次启动：非 git 目录下 branch chip 检查生效（gitInfo=null → openBranchPopover 抛检查错，非 state 死锁）', async () => {
    sessionCtrl.list.mockResolvedValue([])
    await useSidebar().initApp()
    await flushBootstrap()

    const flow = useNewTaskFlow()
    expect(flow.state.value).toBe('landing')
    expect(flow.gitInfo.value).toBeNull()
    // openBranchPopover 命中「非 git 目录」检查抛错（AC-3.7），这是设计检查，不是 idle 死锁的非法转换
    expect(() => flow.openBranchPopover()).toThrow('非 git 目录')
    expect(flow.state.value).toBe('idle')
  })

  it('启动窗口：project 域落定即进 landing（sessions 域同步在途不阻塞）→ 点 chip 不崩', async () => {
    // project 域立即落定；sessions 域（session.list）受控挂起——域数据加载已从启动编排
    // 分离（域同步器承载），落地页只等 project 域（§6.4③）。
    let resolveList!: (g: SessionGroup[]) => void
    sessionCtrl.list.mockReturnValue(
      new Promise<SessionGroup[]>((resolve) => {
        resolveList = resolve
      }),
    )
    await useSidebar().initApp()
    const flow = useNewTaskFlow()
    // project 已落定 → landing 已进；sessions 域仍在途不阻塞（chip 可点不抛错）
    expect(flow.state.value).toBe('landing')
    expect(() => flow.openDirPopover()).not.toThrow()
    expect(flow.state.value).toBe('dir-popover')

    // 放行 deferred，让域同步正常结束（避免挂起 / unhandledRejection）
    resolveList([])
    await flushBootstrap()
  })

  it('sessions 域同步失败 → 失败留痕（listLoadError 置位，重试型）且 landing 照常进入', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      sessionCtrl.list.mockRejectedValue(new Error('runtime not ready'))
      await useSidebar().initApp()
      await flushBootstrap()
      const flow = useNewTaskFlow()
      // sessions 域失败不阻断启动（landing 正常）；失败经 session store 的重试型呈现通道
      expect(flow.state.value).toBe('landing')
      expect(useSessionStore().listLoadError).toBe('runtime not ready')
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('initApp 自身编排错误 → appBootstrapped 复位保留显式重试通道（catch 兜底回归）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const registerMock = vi.mocked(registerAppCommands)
    try {
      registerMock.mockImplementationOnce(() => {
        throw new Error('command registry unavailable')
      })
      await useSidebar().initApp() // 首次：catch → 复位
      const flow = useNewTaskFlow()
      expect(flow.state.value).toBe('idle') // 编排在注册命令步失败，未进 landing

      await useSidebar().initApp() // 复位生效：重调重新编排
      expect(registerMock).toHaveBeenCalledTimes(2)
      expect(useNewTaskFlow().state.value).toBe('landing')
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('启动编排只跑一次 + 重连走域同步器（§6.4 新语义）', () => {
  it('initApp 幂等：重复调用不重复编排（project.load / session.list 各只 1 次）', async () => {
    sessionCtrl.list.mockResolvedValue([])
    await useSidebar().initApp()
    await flushBootstrap()
    await useSidebar().initApp()
    await flushBootstrap()
    // 编排幂等：project 域首轮只在首次 initApp 经 whenSettled 发起
    expect(projectCtrl.load).toHaveBeenCalledTimes(1)
    expect(sessionCtrl.list).toHaveBeenCalledTimes(1)
    expect(sessionCtrl.create).not.toHaveBeenCalled()
  })

  it('重连边沿（notifyConnectedEdge）走域同步器：三数据域重拉 + 辅助刷新触发，编排不重跑', async () => {
    sessionCtrl.list.mockResolvedValue([])
    await useSidebar().initApp()
    await flushBootstrap()
    // 首轮基线：域同步各 1 次（initApp 的 whenSettled 驱动）
    expect(projectCtrl.load).toHaveBeenCalledTimes(1)
    expect(sessionCtrl.list).toHaveBeenCalledTimes(1)
    expect(workspaceStoreMock.load).toHaveBeenCalledTimes(1)

    notifyConnectedEdge() // 模拟重连 connected 边沿
    await flushBootstrap()

    // 三数据域重拉（whenToSync 恒真：任何重连边沿都重拉）
    expect(projectCtrl.load).toHaveBeenCalledTimes(2)
    expect(sessionCtrl.list).toHaveBeenCalledTimes(2)
    expect(workspaceStoreMock.load).toHaveBeenCalledTimes(2)
    // 辅助刷新随边沿触发（首连直调 initApp 不触发——仅边沿触发；首连时无焦点 session，
    // 聚焦四项跳过，此处断言无焦点的 extension-scan）
    // workspace 域同步函数内的默认目录拉取同批重拉
    expect(workspaceStoreMock.loadDefaultSessionDir).toHaveBeenCalledTimes(2)
    // 编排不重跑：不重复 startFlow / 不 create
    expect(useNewTaskFlow().state.value).toBe('landing')
    expect(sessionCtrl.create).not.toHaveBeenCalled()
  })

  it('重连边沿不翻动 flow 状态（landing 保持，不重复进入落地页编排）', async () => {
    sessionCtrl.list.mockResolvedValue([])
    await useSidebar().initApp()
    const flow = useNewTaskFlow()
    expect(flow.state.value).toBe('landing')
    notifyConnectedEdge()
    await flushBootstrap()
    expect(flow.state.value).toBe('landing')
  })
})

describe('initApp presetCwd（挂 sessions+workspace 两域首次落定之后，§6.4③）', () => {
  it('IC-1: 有历史 session → 预填用 lastActiveAt 最大 session 的 cwd（非 workspaceStore.defaultCwd）', async () => {
    // /a（lastActiveAt=100）较旧，/b（lastActiveAt=200）最新 → 预填 /b
    sessionCtrl.list.mockResolvedValue([
      { cwd: '/a', sessions: [mkSession({ id: 'a', cwd: '/a', lastActiveAt: 100 })] },
      { cwd: '/b', sessions: [mkSession({ id: 'recent', cwd: '/b', lastActiveAt: 200 })] },
    ])
    // 故意把 defaultCwd 设成与最大 session 不同的值，证明预设源是 session 而非 workspace
    workspaceStoreMock.defaultCwd = '/fallback-from-workspace'

    await useSidebar().initApp()
    await flushBootstrap() // 预填挂两域首次落定 promise 之后（晚到回灌）

    const flow = useNewTaskFlow()
    expect(flow.state.value).toBe('landing')
    expect(flow.currentCwd.value).toBe('/b')
    expect(flow.currentCwd.value).not.toBe('/fallback-from-workspace')
  })

  it('IC-2: 无 session（sessionStore 空）→ 回退 workspaceStore.defaultCwd', async () => {
    sessionCtrl.list.mockResolvedValue([])
    workspaceStoreMock.defaultCwd = '/workspace-default'

    await useSidebar().initApp()
    await flushBootstrap()

    const flow = useNewTaskFlow()
    expect(flow.state.value).toBe('landing')
    expect(flow.currentCwd.value).toBe('/workspace-default')
  })

  it('新建任务预填链（用户裁决 2026-10-22）：选中 session 后 newSession → 默认 cwd = 选中 session 的 cwd', async () => {
    sessionCtrl.list.mockResolvedValue([
      { cwd: '/b', sessions: [mkSession({ id: 'recent', cwd: '/b', lastActiveAt: 900 })] },
    ])
    workspaceStoreMock.defaultCwd = '/zzz-default'
    await useSidebar().initApp()
    await flushBootstrap()

    // 模拟用户在侧栏选中 session「recent」（initApp 的 landing 不变量清过 activeId，此处重新置位）
    useSessionStore().activeId = 'recent'

    // 点「新建任务」（无显式 cwd）→ 预填 = 选中 session 的 cwd
    await useSidebar().newSession()
    const flow = useNewTaskFlow()
    expect(flow.state.value).toBe('landing')
    expect(flow.currentCwd.value).toBe('/b')

    // 对照：无选中 session（activeId 已被 startFlow 不变量清空）→ 回落 defaultCwd
    await useSidebar().newSession()
    expect(useNewTaskFlow().currentCwd.value).toBe('/zzz-default')
  })
})
