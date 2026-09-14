/**
 * useSidebar deleteSession/deleteFolder 跨 store 清理 + 空态出口测试
 * （W1 / S3+S4 / D7；原 useSidebar-delete-empty-state.test.ts 已并入本文件，同 SUT 同 mock 面）。
 *
 * 锁定 deleteSession / deleteFolder 的修复面：
 * - S3：删除时调 fileTree.clearSession(id) + useChat.disposeSession(id)
 * - S4：删 active 后 selectSession(next) 失败时 fallback 到 navigation.push({ view: 'chat' })
 * - [G1 / 2026-09-14 内存审计 §3.4] U-G1：三 Map 分区（terminal 写队列 / slash 命令历史 /
 *   fork 通知 feed）在 cleanupSessionState 后清理（真实例行为断言）
 * - [D7 合并终态] 空态出口 = core enterEmptyChatState()：push chat + startFlow 进 landing
 *   （D7 空态承接修复 flow=idle 死态；初版锁「只 push 不 startFlow」的语义已被
 *   main af96fa94c 的 D7 修复取代，2026-08-31 dev-merge 裁决采纳 main 语义）
 * - 排除保护：newSession 延迟 create 分支不调无参 startFlow——fallback cwd 保留不被清
 *
 * mock 策略：真实 useSidebar + 真实 useNewTaskFlow（app-bootstrap.test.ts 先例：不 mock
 * flow 状态机，防「组件层绿但 state 停 idle」盲区）；mock @/api 域并集 + workspaceStore
 * + fileTree store + useChat + lib/ipc(browserDestroy) + useCommandStore（内存 KV 真实例）。
 *
 * 运行：npx vitest run src/__tests__/useSidebar-delete-cleanup.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope } from 'vue'
import type { SessionGroup, SessionSummary } from '@xyz-agent/shared'

// ── mock fileTree store：捕获 clearSession ──
const clearSessionMock = vi.hoisted(() => vi.fn())
vi.mock('@/stores/fileTree', () => ({
  useFileTreeStore: () => ({ clearSession: clearSessionMock }),
}))
// ── mock useFileTree composable：D7 空态出口的 selectSession 回退链会走
//    preloadFileTree → loadTree → 真实 fileTree store（被上面的 mock 收窄后无 getTree），
//    且真实 loadTree 会发 file.tree RPC——编排断言不需要树加载，拦截之。 ──
const loadTreeMock = vi.hoisted(() => vi.fn())
vi.mock('@/composables/features/file-tree/useFileTree', () => ({
  useFileTree: () => ({ loadTree: loadTreeMock }),
}))

// ── mock useChat composable：捕获 disposeSession；send/sendBash + ensureStreamSubscription
//    隔离（空态出口用例走真实 useNewTaskFlow 的 chat ports，fire-and-forget WS 订阅不需要）──
const useChatDisposeMock = vi.hoisted(() => vi.fn())
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({
    disposeSession: useChatDisposeMock,
    send: vi.fn(),
    sendBash: vi.fn(),
  }),
  ensureStreamSubscription: vi.fn(),
}))

// ── mock lib/ipc：捕获 browserDestroy（B4 接线断言）；其余导出透传真实模块 ──
const browserDestroyMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock('@/lib/ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc')>()),
  browserDestroy: browserDestroyMock,
}))

// ── mock api 域（deleteSession/deleteFolder/newSession + useNewTaskFlow ports 的并集）──
const removeMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))
const removeByCwdMock = vi.hoisted(() => vi.fn(() =>
  Promise.resolve({ cwd: '/proj', deleted: [] as string[], failed: [] })))
const switchSessionMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  chat: { getHistory: vi.fn(() => Promise.resolve({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })), streamSubscribe: vi.fn(() => () => {}) },
  extension: {},
  session: {
    create: vi.fn(() => Promise.resolve(makeSummary('mock'))),
    list: vi.fn(() => Promise.resolve([])),
    switchSession: switchSessionMock,
    rename: vi.fn(() => Promise.resolve()),
    remove: removeMock,
    removeByCwd: removeByCwdMock,
    migrateImage: vi.fn(() => Promise.resolve({ migrated: [], failed: [] })),
    getCommands: vi.fn(() => Promise.resolve({ commands: [] })),
  },
  file: { tree: vi.fn().mockResolvedValue([]), expand: vi.fn().mockResolvedValue([]) },
  git: { status: vi.fn().mockResolvedValue({ isRepo: false }), checkout: vi.fn(), checkoutByCwd: vi.fn(), createBranch: vi.fn() },
  workspace: { detect: vi.fn().mockResolvedValue({ mode: 'not-repo', isBareMode: false, wsRoot: '', repoRoot: '' }) },
  worktree: { list: vi.fn().mockResolvedValue([]) },
}))

// ── mock workspaceStore：defaultCwd 可控（newSession fallback / useNewTaskFlow ports 共用）──
const workspaceStoreMock = vi.hoisted(() => ({
  records: [] as Array<{ cwd: string; lastUsedAt: number; label: string }>,
  defaultCwd: undefined as string | undefined,
  load: vi.fn(),
}))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: vi.fn(() => workspaceStoreMock),
}))

// ── mock useCommandStore 壳单例：真实 core createCommandStore + 内存 KV（G1 断言需要真实
//    Map 分区行为；不走真实壳单例——其 getPlatform() 依赖 AppShell providePlatform 时序，
//    测试环境未注入会 fail-fast 抛错）──
vi.mock('@/composables/features/command/useCommandStore', async () => {
  const { createCommandStore } = await import('@xyz-agent/core')
  const kv = new Map<string, string>()
  const storage = {
    get: async (key: string) => kv.get(key) ?? null,
    set: async (key: string, value: string) => { kv.set(key, value) },
  }
  let instance: ReturnType<typeof createCommandStore> | null = null
  return {
    useCommandStore: () => {
      if (!instance) instance = createCommandStore(storage)
      return instance
    },
    __resetCommandStoreForTesting: () => { instance = null },
  }
})

import { useSidebar, resetAppBootstrap } from '@/composables/features/sidebar/useSidebar'
import { useNewTaskFlow, resetNewTaskFlow, __resetNewTaskFlowForTesting } from '@/composables/features/new-task/useNewTaskFlow'
import { useNavigationStore } from '@/stores/navigation'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import { useSessionStore } from '@/stores/session'
import { useTerminalWriteQueueStore } from '@/stores/terminal-write-queue'
import { useCommandStore } from '@/composables/features/command/useCommandStore'
import { useForkNoticeFeed, pushForkNoticeAsk, resetForkNoticeFeed } from '@/composables/effects/useForkNoticeEffect'
import { registerSessionCleanup, __clearSessionCleanupRegistryForTest } from '@/composables/useSessionScopedState'

function makeSummary(id: string): SessionSummary {
  return { id, label: id, cwd: '/proj', status: 'idle', lastActiveAt: 1, modelId: 'm1', tokenCount: 0 }
}

// seed pinia session store（ADR-0059：useSessionStore 单例）
function seedSessions(groups: Array<{ cwd: string; ids: string[] }>): void {
  const sessionGroups: SessionGroup[] = groups.map((g) => ({
    cwd: g.cwd,
    sessions: g.ids.map(makeSummary),
  }))
  useSessionStore().applySnapshot({ groups: sessionGroups })
}

beforeEach(() => {
  // 模块级 cleanup registry 跨测试可能残留（本文件断言 cleanup 调用次数）→ 显式清空防 flaky
  __clearSessionCleanupRegistryForTest()
  setActivePinia(createPinia())
  resetNewTaskFlow()
  __resetNewTaskFlowForTesting()
  resetAppBootstrap()
  vi.clearAllMocks()
  removeMock.mockResolvedValue(undefined)
  removeByCwdMock.mockResolvedValue({ cwd: '/proj', deleted: [], failed: [] })
  switchSessionMock.mockResolvedValue(undefined)
  workspaceStoreMock.records = []
  workspaceStoreMock.defaultCwd = undefined
  // G1：fork feed 模块级状态隔离（同 use-fork-branch-notify.test.ts 范式）
  resetForkNoticeFeed()
})

describe('useSidebar deleteSession 跨 store 清理（W1 / S3）', () => {
  it('U3: deleteSession 调用 fileTree.clearSession + useChat.disposeSession', async () => {
    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    seedSessions([{ cwd: '/proj', ids: ['s1', 's2'] }])
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 's1')

    await sidebar.deleteSession('s1')

    expect(removeMock).toHaveBeenCalledWith('s1')
    expect(clearSessionMock).toHaveBeenCalledWith('s1')
    expect(useChatDisposeMock).toHaveBeenCalledWith('s1')

    scope.stop()
  })

  it('U-G1: deleteSession 释放三 Map 分区——terminal 写队列 / slash 命令历史 / fork 通知 feed（真实例）', async () => {
    // [G1 / 2026-09-14 内存审计 §3.4] 三个清理 API 此前全仓零调用——已删 session 的
    // per-session Map 分区永久残留。本用例用真实模块实例（terminal 队列 pinia store /
    // core command store / fork feed 模块单例）锁定 deleteSession → cleanupSessionState
    // → 三 hook 接线的端到端分区释放，且相邻 session 分区不受误伤。
    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    seedSessions([{ cwd: '/proj', ids: ['s1', 's2'] }])

    // seed 三分区（s1 + 相邻 s2 对照）
    const terminalQueue = useTerminalWriteQueueStore()
    terminalQueue.markAlive('s1')
    terminalQueue.markAlive('s2')
    const commands = useCommandStore()
    commands.applyCommands('s1', [{ name: '/compact', source: 'builtin' }])
    commands.applyCommands('s2', [{ name: '/goal', source: 'builtin' }])
    pushForkNoticeAsk('s1', 'n1', '提问预览')
    pushForkNoticeAsk('s2', 'n2', '相邻分支预览')
    const feed = useForkNoticeFeed()
    // 前置：seed 生效（防假绿——断言前确认三分区非空）
    expect(terminalQueue.isPtyAlive('s1')).toBe(true)
    expect(commands.getCommands('s1')).toHaveLength(1)
    expect(feed.notices('s1')).toHaveLength(1)

    await sidebar.deleteSession('s1')

    // s1 三分区归零：terminal 写队列（removeSession——isPtyAlive 回落 false 佐证条目已删）、
    // slash 命令历史（clearCommands）、fork 通知 feed（clearSession）
    expect(terminalQueue.isPtyAlive('s1')).toBe(false)
    expect(commands.getCommands('s1')).toHaveLength(0)
    expect(feed.notices('s1')).toHaveLength(0)
    // 相邻 session 分区不受误伤
    expect(terminalQueue.isPtyAlive('s2')).toBe(true)
    expect(commands.getCommands('s2')).toHaveLength(1)
    expect(feed.notices('s2')).toHaveLength(1)

    scope.stop()
  })

  it('U-B4: deleteSession 触发 browserDestroy IPC；rejection 被 .catch 消化（无 unhandledrejection）', async () => {
    // [B4 / 2026-09-14 内存审计 §2.1]：browserDestroy 此前是全仓零调用死 API——
    // 已删 session 的 WebContentsView 驻留至 LRU 挤出。本用例锁定接线 + 错误消化契约
    // （preload invoke 透传 rejection，不 catch 会成 unhandledrejection 上报 error-reporter）。
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      browserDestroyMock.mockRejectedValueOnce(new Error('ipc down'))
      const scope = effectScope()
      const sidebar = scope.run(() => useSidebar())!
      seedSessions([{ cwd: '/proj', ids: ['s1', 's2'] }])

      await sidebar.deleteSession('s1')

      expect(browserDestroyMock).toHaveBeenCalledWith('s1')
      // 微任务排空一个周期后无 unhandledrejection（.catch 消化契约）
      await new Promise((resolve) => setImmediate(resolve))
      expect(unhandled).toEqual([])

      scope.stop()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

describe('useSidebar deleteSession 删 active 后 fallback + 空态出口（W1 / S4 + D7）', () => {
  it('U4/D7-U2: 删 active 后 selectSession(next) reject（S4 兜底）→ push chat 空态 + startFlow 进 landing；跨 store 清理仍执行', async () => {
    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    seedSessions([{ cwd: '/proj', ids: ['s1', 's2'] }])
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 's1')
    // 让 s1 成为 active（接缝本地 raw store，C-W5-5）
    useSessionStore().setActiveId('s1')
    // switchSession reject 模拟网络抖动
    switchSessionMock.mockRejectedValue(new Error('network'))

    const navigation = useNavigationStore()
    const pushSpy = vi.spyOn(navigation, 'push')

    await sidebar.deleteSession('s1')

    // removeFromList 把 activeId 回退到 s2（list[0]），selectSession('s2') 失败 → fallback
    expect(pushSpy).toHaveBeenCalledWith({ view: 'chat' })
    // 空态承接：push + startFlow（D7；flow=idle 死态修复，main af96fa94c 语义）
    expect(useNewTaskFlow().state.value).toBe('landing')
    // 跨 store 清理仍执行（不受 selectSession 失败影响）
    expect(clearSessionMock).toHaveBeenCalledWith('s1')
    expect(useChatDisposeMock).toHaveBeenCalledWith('s1')

    scope.stop()
  })

  it('D7-U1: 删唯一 session（删空分支）→ push chat 空态 + startFlow 进 landing', async () => {
    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    seedSessions([{ cwd: '/proj', ids: ['s1'] }])
    useSessionStore().setActiveId('s1')

    const navigation = useNavigationStore()
    const pushSpy = vi.spyOn(navigation, 'push')

    await sidebar.deleteSession('s1')

    expect(pushSpy).toHaveBeenCalledWith({ view: 'chat' })
    expect(useNewTaskFlow().state.value).toBe('landing')

    scope.stop()
  })

  it('D7-U3: 删 active 后 selectSession(next) 成功回退 → 不触发空态出口（flow 停 idle）', async () => {
    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    seedSessions([{ cwd: '/proj', ids: ['s1', 's2'] }])
    useSessionStore().setActiveId('s1')

    await sidebar.deleteSession('s1')

    // 成功回退路径无空态出口：flow 不被编排（state 停 idle，非 landing）
    expect(useNewTaskFlow().state.value).toBe('idle')

    scope.stop()
  })
})

describe('useSidebar deleteFolder 空态出口（合并终态，enterEmptyChatState 承接）', () => {
  it('D7-U4: 删文件夹后列表空（删空分支）→ push chat 空态 + startFlow 进 landing', async () => {
    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    seedSessions([{ cwd: '/proj', ids: ['s1'] }])
    useSessionStore().setActiveId('s1')
    removeByCwdMock.mockResolvedValue({ cwd: '/proj', deleted: ['s1'], failed: [] })

    const navigation = useNavigationStore()
    const pushSpy = vi.spyOn(navigation, 'push')

    await sidebar.deleteFolder('/proj')

    expect(pushSpy).toHaveBeenCalledWith({ view: 'chat' })
    expect(useNewTaskFlow().state.value).toBe('landing')

    scope.stop()
  })

  it('D7-U5: 删文件夹后 selectSession(next) reject（S4 兜底分支）→ push chat 空态 + startFlow 进 landing', async () => {
    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    seedSessions([
      { cwd: '/proj', ids: ['s1'] },
      { cwd: '/other', ids: ['s2'] },
    ])
    useSessionStore().setActiveId('s1')
    removeByCwdMock.mockResolvedValue({ cwd: '/proj', deleted: ['s1'], failed: [] })
    switchSessionMock.mockRejectedValue(new Error('network'))

    const navigation = useNavigationStore()
    const pushSpy = vi.spyOn(navigation, 'push')

    await sidebar.deleteFolder('/proj')

    expect(pushSpy).toHaveBeenCalledWith({ view: 'chat' })
    expect(useNewTaskFlow().state.value).toBe('landing')

    scope.stop()
  })
})

describe('newSession 延迟 create 分支排除保护（D7 排除说明）', () => {
  it('D7-U6: newSession 延迟 create 分支不调无参 startFlow——fallback cwd 保留不被清', async () => {
    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    workspaceStoreMock.defaultCwd = '/repo'

    const navigation = useNavigationStore()
    const pushSpy = vi.spyOn(navigation, 'push')

    const created = await sidebar.newSession()

    expect(created).toBeNull() // 延迟 create，无 session
    expect(pushSpy).toHaveBeenCalledWith({ view: 'chat' })
    const flow = useNewTaskFlow()
    expect(flow.state.value).toBe('landing')
    // 排除保护核心：newSession 延迟 create 分支只 push 不重复 startFlow。若误用无参
    // startFlow 二次触发，pendingCwd 会被置 null，刚回灌的 fallback cwd 丢失。
    // landing 态无绑定 session，公开面 currentCwd 即 pendingCwd 的派生视图
    expect(flow.currentCwd.value).toBe('/repo')

    scope.stop()
  })
})

describe('useSidebar deleteSession 触发 session-scoped cleanup（W5 / ADR-0049）', () => {
  it('U5: deleteSession 调 triggerSessionCleanups(id)，注册的 cleanup 被执行', async () => {
    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    seedSessions([{ cwd: '/proj', ids: ['s1'] }])

    // 注册 sentinel cleanup，捕获 deleteSession 是否编排了 triggerSessionCleanups。
    // 不 mock 模块——保留真实模块级注册表行为，验证端到端通路。
    let cleanupArg: string | null = null
    const unregister = registerSessionCleanup((sid) => { cleanupArg = sid })

    try {
      await sidebar.deleteSession('s1')
      expect(cleanupArg).toBe('s1')
    } finally {
      unregister()
    }

    scope.stop()
  })
})
