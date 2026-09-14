/**
 * App 启动编排集成测试（#1/#3，问题1+3 同源回归防护）。
 *
 * 关键约束：**不 mock useNewTaskFlow**（之前的盲区就在这——组件层 83 测试绿但真实运行时
 * 暴露 state 停 idle）。本测试只 mock 最外层 @/api（session/chat）+ 间接依赖，
 * 让真实 useNewTaskFlow 状态机 + useSidebar.initApp 编排跑通，验证启动后 state 真正进 landing。
 *
 * 防护对象（任一回归立刻红）：
 * - 问题1：首次打开 APP 不是新建任务页（App 启动未自动 startFlow → state 停 idle）
 * - 问题3：目录/分支 chip 点击不生效（state=idle 时 transition('dir-popover') 非法抛错回 idle）
 * 两问题同源：state 从未离开 idle。本测试断言 state==='landing'（不是 idle）。
 *
 * 触发链路模拟：App.vue watch connectionState==='connected' → useSidebar.initApp()。
 * 测试直接调 initApp()（等价于 connected 后），绕过 ws-client 真实握手。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/new-task/app-bootstrap.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { SessionSummary, SessionGroup } from '@xyz-agent/shared'

// 可控依赖：session.list/create/switchSession/remove + chat.getHistory（initApp 编排路径触达）
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

vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  session: {
    list: sessionCtrl.list,
    create: sessionCtrl.create,
    switchSession: sessionCtrl.switchSession,
    remove: sessionCtrl.remove,
  },
  chat: { getHistory: chatCtrl.getHistory },
  // onConnected 重连分支调 extensionApi.scan()（fire-and-forget）→ 给 resolve
  extension: { scan: vi.fn().mockResolvedValue(undefined) },
  // 重连 → useNewTaskFlow.submitFirstMessage → useFileTree.loadTree 调 file.tree / git.status
  // （fire-and-forget，补 mock 避免 unhandled rejection）
  file: { tree: vi.fn().mockResolvedValue([]), expand: vi.fn().mockResolvedValue([]) },
  git: { status: vi.fn().mockResolvedValue({ isRepo: false }) },
  workspace: { detect: vi.fn().mockResolvedValue({ mode: 'not-repo', isBareMode: false, wsRoot: '', repoRoot: '' }) },
  worktree: { list: vi.fn().mockResolvedValue([]) },
}))

// W3: mock workspaceStore 让 initApp 能正确预填 cwd
const workspaceStoreMock = vi.hoisted(() => ({
  records: [] as Array<{ cwd: string; lastUsedAt: number; label: string }>,
  defaultCwd: undefined as string | undefined,
  load: vi.fn(),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: vi.fn(() => workspaceStoreMock),
}))

// useNewTaskFlow / useSidebar 均用真实实现（不 mock）——这是本测试的核心价值
import { useSidebar, resetAppBootstrap } from '@/composables/features/sidebar/useSidebar'
import { useNewTaskFlow, resetNewTaskFlow } from '@/composables/features/new-task/useNewTaskFlow'
import { useSessionStore } from '@/stores/session'

beforeEach(() => {
  setActivePinia(createPinia())
  resetNewTaskFlow()
  resetAppBootstrap()
  vi.clearAllMocks()
  sessionCtrl.switchSession.mockResolvedValue(undefined)
  sessionCtrl.remove.mockResolvedValue(undefined)
  chatCtrl.getHistory.mockResolvedValue([])
  // 重置 workspaceStore mock
  workspaceStoreMock.records = []
  workspaceStoreMock.defaultCwd = undefined
})

function mkSession(over: Partial<SessionSummary>): SessionSummary {
  return {
    id: over.id ?? 's',
    label: over.label ?? 'label',
    cwd: over.cwd ?? '/repo',
    status: 'idle',
    lastActiveAt: over.lastActiveAt ?? 0,
    modelId: 'm',
    tokenCount: 0,
    ...over,
  }
}

describe('App 启动编排（initApp：连接建立后始终进 landing 落地页）', () => {
  it('首次启动（无 session）：initApp → startFlow 延迟 create → state=landing（不是 idle）→ chip 可点', async () => {
    sessionCtrl.list.mockResolvedValue([]) // 无历史 → resolveDefaultCwd=undefined → 延迟 create
    await useSidebar().initApp()

    const flow = useNewTaskFlow()
    // 问题1+3 回归防护核心：state 必须离开 idle 进 landing（state 停 idle = 两 bug 同时复现）
    expect(flow.state.value).toBe('landing')
    expect(flow.currentSessionId.value).toBeNull() // 延迟 create，无绑定 session（AC-1.7）
    expect(sessionCtrl.create).not.toHaveBeenCalled() // 首次启动不 create

    // 问题3 防护：state=landing 时 directory chip 的 transition('dir-popover') 合法，不抛错回 idle
    expect(() => flow.openDirPopover()).not.toThrow()
    expect(flow.state.value).toBe('dir-popover')
  })

  it('首次启动：非 git 目录下 branch chip 守卫生效（gitInfo=null → openBranchPopover 抛守卫错，非 state 死锁）', async () => {
    sessionCtrl.list.mockResolvedValue([])
    await useSidebar().initApp()

    const flow = useNewTaskFlow()
    expect(flow.state.value).toBe('landing')
    // 首次启动 currentSession=null → session.active=null → gitInfo=null
    // openBranchPopover 命中「非 git 目录」守卫抛错（AC-3.7），这是设计守卫，不是 idle 死锁的非法转换
    expect(flow.gitInfo.value).toBeNull()
    expect(() => flow.openBranchPopover()).toThrow('非 git 目录')
    // 守卫抛错后 state 被 reset 回 idle（AC-3.7 设计），区别于 landing→branch-popover 的合法路径
    expect(flow.state.value).toBe('idle')
  })

  it('非首次启动（有历史 session）：initApp → 仍进落地页，cwd 预填最近 session 目录（G1.1「沿用目录做新任务」）', async () => {
    sessionCtrl.list.mockResolvedValue([
      { cwd: '/a', sessions: [mkSession({ id: 'a', cwd: '/a', lastActiveAt: 100 })] },
      { cwd: '/b', sessions: [mkSession({ id: 'recent', cwd: '/b', lastActiveAt: 900 })] },
    ])
    // W3: 设置 workspaceStore.defaultCwd 模拟工作区记录
    workspaceStoreMock.defaultCwd = '/b'
    await useSidebar().initApp()

    const flow = useNewTaskFlow()
    // G1.1 字面意：有历史也进新任务落地页（不恢复整个会话对话）
    expect(flow.state.value).toBe('landing')
    // 不 create 新 session（落地页延迟 create，首发提交才建）
    expect(sessionCtrl.create).not.toHaveBeenCalled()
    // 不 switchSession（不恢复历史会话）
    expect(sessionCtrl.switchSession).not.toHaveBeenCalled()
    // cwd 预填最近活跃 session 的目录（chip 所见即所得；landing 态 currentCwd 取自 pendingCwd）
    expect(flow.currentCwd.value).toBe('/b')
    // activeId 被清空（landing 态无 session 绑定，不变量强制）
    expect(useSessionStore().activeId).toBeNull()
  })

  it('HMR/重连幂等：appBootstrapped 守卫，第二次 initApp 直接 return 不重复编排', async () => {
    sessionCtrl.list.mockResolvedValue([])
    await useSidebar().initApp()
    expect(sessionCtrl.list).toHaveBeenCalledTimes(1)

    // 模拟 HMR 重连 / 断线重连后 state 再次变 connected → App.vue 再次触发 initApp
    await useSidebar().initApp()
    expect(sessionCtrl.list).toHaveBeenCalledTimes(1) // 幂等，未重复 loadSessions
  })

  it('启动失败（list reject）→ state 留 landing（不回 idle）+ appBootstrapped 重置允许重试', async () => {
    // startFlow 先于 loadSessions 同步进 landing → 即使 loadSessions reject，state 仍 landing
    // （landing 页可用，比回 idle 死锁更好）。appBootstrapped 在 catch 重置，下次 connected 可重试。
    sessionCtrl.list.mockRejectedValueOnce(new Error('runtime not ready'))
    await useSidebar().initApp() // 首次失败（newSession 先进 landing，loadSessions reject）
    const flow = useNewTaskFlow()
    expect(flow.state.value).toBe('landing') // 留 landing（startFlow 已跑），不回 idle

    sessionCtrl.list.mockResolvedValue([]) // 重连后 list 可用
    await useSidebar().initApp() // 重试（startFlow 幂等：已 landing 不翻 state，只刷新）
    expect(useNewTaskFlow().state.value).toBe('landing') // 重试后仍 landing
  })

  it('启动窗口（loadSessions 未完成）：startFlow 已先同步进 landing → state≠idle → 点 chip 不崩', async () => {
    // 回归防护：真实 runtime 下 App.vue watch connected → void initApp()（异步未 await）→ Vue
    // 同步重渲染挂载 Landing（sessionId===null）。initApp 内 startFlow 必须先于 await loadSessions()，
    // 否则「渲染 Landing」与「state 进 landing」之间存在 state=idle 的窗口，点 directory chip 触发
    // idle→dir-popover 非法转换抛错（用户报「新建任务页面点击选择目录报错」即此）。
    // 用可控 deferred 模拟 loadSessions 在途：startFlow 已跑完进 landing，list 尚未 resolve。
    let resolveList!: (g: SessionGroup[]) => void
    sessionCtrl.list.mockReturnValue(
      new Promise<SessionGroup[]>((r) => {
        resolveList = r
      }),
    )
    const initPromise = useSidebar().initApp()
    // 让 newSession()（同步进 landing）前的编排微任务跑完（useSidebar.initApp 在 newSession 前
    // 多一个 await projectStore.init()——D14 归属透传时序，多 flush 数轮），但 loadSessions() 仍
    // pending（deferred list 未 resolve，await 未返回）
    for (let i = 0; i < 10; i++) await Promise.resolve()

    const flow = useNewTaskFlow()
    // 核心：loadSessions 仍在途，但 state 已离开 idle 进 landing → chip 可点不抛错
    expect(flow.state.value).toBe('landing')
    expect(() => flow.openDirPopover()).not.toThrow()
    expect(flow.state.value).toBe('dir-popover')

    // 放行 deferred，让 initApp 正常结束（避免挂起 / unhandledRejection）
    resolveList([])
    await initPromise
  })
})

describe('onConnected：首次 vs 重连 connected 的 workspace 刷新（W8）', () => {
  it('首次 connected（hasConnectedBefore=false）→ 调 initApp（含 load），load 仅经 initApp 调 1 次', async () => {
    sessionCtrl.list.mockResolvedValue([])
    await useSidebar().onConnected()
    // initApp 内部调了 load（INV-6 时序）
    expect(workspaceStoreMock.load).toHaveBeenCalledTimes(1)
    // state 进 landing（initApp 正常执行）
    expect(useNewTaskFlow().state.value).toBe('landing')
  })

  it('重连 connected（hasConnectedBefore=true）→ initApp 被守卫跳过，额外调 load 刷新 stale records', async () => {
    sessionCtrl.list.mockResolvedValue([])
    // 首次
    await useSidebar().onConnected()
    expect(workspaceStoreMock.load).toHaveBeenCalledTimes(1)
    // 重连
    await useSidebar().onConnected()
    // 重连后再调一次 load（刷新 stale），共 2 次
    expect(workspaceStoreMock.load).toHaveBeenCalledTimes(2)
    // 核心（must_fix 断言）：重连时 sessionCtrl.list 不再被调（initApp 被 appBootstrapped 守卫跳过）
    expect(sessionCtrl.list).toHaveBeenCalledTimes(1)
  })

  it('重连 connected 不重复 startFlow（state 保持 landing，不翻动）', async () => {
    sessionCtrl.list.mockResolvedValue([])
    await useSidebar().onConnected()
    const flow = useNewTaskFlow()
    expect(flow.state.value).toBe('landing')
    // 重连
    await useSidebar().onConnected()
    // state 仍 landing（initApp 守卫跳过，未重复编排）
    expect(flow.state.value).toBe('landing')
  })
})

// ── 原 initapp-default-cwd-session.test.ts 并入（同 initApp 编排、逐字相同 mock 脚手架；
//    保留 IC-1/IC-2 两条核心来源断言——IC-1b/IC-3 与 IC-1 同语义变体、IC-5 与本文件非首启
//    loadSessions 用例重叠、IC-6 锁 reduce 实现细节，均不再重复）──
describe('initApp presetCwd：默认选中上次 session 目录（W3，原 initapp-default-cwd-session 并入）', () => {
  it('IC-1: 有历史 session → presetCwd 用 lastActiveAt 最大 session 的 cwd（非 workspaceStore.defaultCwd）', async () => {
    // /a（lastActiveAt=100）较旧，/b（lastActiveAt=200）最新 → 预填 /b
    sessionCtrl.list.mockResolvedValue([
      { cwd: '/a', sessions: [mkSession({ id: 'a', cwd: '/a', lastActiveAt: 100 })] },
      { cwd: '/b', sessions: [mkSession({ id: 'recent', cwd: '/b', lastActiveAt: 200 })] },
    ])
    // 故意把 defaultCwd 设成与最大 session 不同的值，证明预设源是 session 而非 workspace
    workspaceStoreMock.defaultCwd = '/fallback-from-workspace'

    await useSidebar().initApp()

    const flow = useNewTaskFlow()
    expect(flow.state.value).toBe('landing')
    // 核心：currentCwd（pendingCwd 派生）= 最大 lastActiveAt session 的 cwd，不是 defaultCwd
    expect(flow.currentCwd.value).toBe('/b')
    expect(flow.currentCwd.value).not.toBe('/fallback-from-workspace')
  })

  it('IC-2: 无 session（sessionStore 空）→ 回退 workspaceStore.defaultCwd', async () => {
    sessionCtrl.list.mockResolvedValue([])
    workspaceStoreMock.defaultCwd = '/workspace-default'

    await useSidebar().initApp()

    const flow = useNewTaskFlow()
    expect(flow.state.value).toBe('landing')
    // 无 session 时回退 defaultCwd
    expect(flow.currentCwd.value).toBe('/workspace-default')
  })
})
