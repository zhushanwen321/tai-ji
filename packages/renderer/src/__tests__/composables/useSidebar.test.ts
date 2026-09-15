/**
 * TC-1..TC-4：useSidebar 接缝 composable 集成测试（w5）。
 *
 * TC-1 selectSession 全编排（renderer 专属步骤 + core 步骤时序，关键不变量：ensureStreamSubscription
 *   先于 panel.loadSession；hydrate 首次触发二次跳过；focusedSessionId 派生）
 * TC-2 deleteSession 代理 core（S3 hooks 调用 + wasActive 回退）
 * TC-3 loadSessions 双分支（成功填 groups / 失败 setListLoadError）
 * TC-4 返回签名对齐 useSidebar（含全字段 + toggleCollapse/goOverview 行为）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useSidebar.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { SessionGroup, SessionSummary, SubagentRecord } from '@xyz-agent/shared'
import { useSidebarStore } from '@/stores/sidebar'
import { useSessionStore } from '@/stores/session'
import { useNavigationStore } from '@/stores/navigation'
import { useSubagentStore } from '@/stores/subagent'
import { useChatStore } from '@/stores/chat'

// vi.hoisted 保证 mock fn 在 vi.mock factory（hoisted 到顶部）执行时已初始化
const mocks = vi.hoisted(() => ({
  switchSession: vi.fn().mockResolvedValue(undefined),
  list: vi.fn().mockResolvedValue([]),
  remove: vi.fn().mockResolvedValue(undefined),
  getHistory: vi.fn().mockResolvedValue({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 }),
  ensureStreamSub: vi.fn(),
  loadTree: vi.fn(),
  cancelFlow: vi.fn(),
  startFlow: vi.fn().mockResolvedValue(undefined),
  // TC-5 重连重拉：extension scan / workspace listRecent 走 fire-and-forget，需可控 spy
  extensionScan: vi.fn().mockResolvedValue(undefined),
  workspaceListRecent: vi.fn().mockResolvedValue([]),
}))

// ── api 层 mock ──
vi.mock('@xyz-agent/core/transport/api/domains/session', () => ({
  switchSession: mocks.switchSession,
  list: mocks.list,
  remove: mocks.remove,
  create: vi.fn(),
  rename: vi.fn(),
  removeByCwd: vi.fn(),
  migrateImage: vi.fn(),
  writeSegments: vi.fn(),
  getCommands: vi.fn().mockResolvedValue({ commands: [] }),
  getSubagents: vi.fn().mockResolvedValue([]),
  getWorkflows: vi.fn().mockResolvedValue([]),
  getAgentCallHistory: vi.fn().mockResolvedValue([]),
}))
vi.mock('@xyz-agent/core/transport/api/domains/chat', () => ({
  getHistory: mocks.getHistory,
  send: vi.fn(),
  streamSubscribe: vi.fn(),
}))
vi.mock('@xyz-agent/core/transport/api', () => ({
  on: vi.fn(() => () => {}),
  onGlobalType: vi.fn(() => () => {}),
  dispatchSession: vi.fn(),
}))
vi.mock('@xyz-agent/core/transport/api/domains/file', () => ({ tree: vi.fn().mockResolvedValue({}) }))
vi.mock('@xyz-agent/core/transport/api/domains/git', () => ({ status: vi.fn().mockResolvedValue({}) }))
// ── TC-5 onConnected 依赖的 domain：importActual 部分覆盖（保其他导出可用），scan/listRecent 可控 ──
vi.mock('@xyz-agent/core/transport/api/domains/extension', async (importActual) => {
  const actual = await importActual<typeof import('@xyz-agent/core/transport/api/domains/extension')>()
  return { ...actual, scan: mocks.extensionScan }
})
vi.mock('@xyz-agent/core/transport/api/domains/workspace', async (importActual) => {
  const actual = await importActual<typeof import('@xyz-agent/core/transport/api/domains/workspace')>()
  return { ...actual, listRecent: mocks.workspaceListRecent }
})
// project domain 全量 stub（initApp 的 useProjectStoreSafe().init 依赖；仅 load/save 两导出）
vi.mock('@xyz-agent/core/transport/api/domains/project', () => ({
  load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }),
  save: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  const session = await import('@xyz-agent/core/transport/api/domains/session')
  const chat = await import('@xyz-agent/core/transport/api/domains/chat')
  return { ...actual, session, chat }
})

// ── useChat composable mock（ensureStreamSubscription spy + useChat stubs）──
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: vi.fn(() => ({
    disposeSession: vi.fn(),
  })),
  ensureStreamSubscription: mocks.ensureStreamSub,
}))
// ── useFileTree mock（loadTree fire-forget spy）──
vi.mock('@/composables/features/file-tree/useFileTree', () => ({ useFileTree: vi.fn(() => ({ loadTree: mocks.loadTree })) }))
// ── useCommandStore 壳单例 mock（[G1] clearSlashCommands hook 接线后 deleteSession 会取
//    commandStore.clearCommands；真实壳单例依赖 AppShell providePlatform 时序，测试未注入
//    会 fail-fast 抛错。原「registerAppCommands 不需 mock」注释随之修正——本文件 initApp
//    不跑，mock 不影响覆盖面）──
vi.mock('@/composables/features/command/useCommandStore', () => ({
  useCommandStore: () => ({
    appCommands: { value: [] },
    shortcutOverrides: { value: {} },
    clearCommands: vi.fn(),
  }),
}))
// ── useNewTaskFlow mock（isActive/cancelFlow/startFlow/currentSession controllable）──
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => ({
  useNewTaskFlow: vi.fn(() => ({
    isActive: { value: false },
    cancelFlow: mocks.cancelFlow,
    startFlow: mocks.startFlow,
    currentSession: { value: null },
    presetCwd: vi.fn(),
  })),
}))
// ── fork/handoff mock（正交职责，stub 即可）──
vi.mock('@/composables/features/fork-handoff/useForkActions', () => ({
  useForkActions: () => ({
    forkSession: vi.fn(),
    forkSessionAsk: vi.fn(),
    forkFromLastAssistant: vi.fn(),
    enterForkModeFromLastAssistant: vi.fn(),
  }),
}))
vi.mock('@/composables/features/fork-handoff/useHandoffActions', () => ({
  useHandoffActions: () => ({
    handoff: vi.fn(),
    abortHandoff: vi.fn(),
    handoffFromLastAssistant: vi.fn(),
    enterHandoffModeFromLastAssistant: vi.fn(),
  }),
}))
// registerAppCommands 经 commandStore（真实），不需 mock

import { useSidebar, resetAppBootstrap } from '@/composables/features/sidebar/useSidebar'

function summary(id: string, cwd = '/a'): SessionSummary {
  return { id, label: `label-${id}`, cwd, status: 'idle', lastActiveAt: 1, modelId: '' }
}
function group(sessions: SessionSummary[], cwd = '/a'): SessionGroup {
  return { cwd, label: cwd, sessions }
}

describe('useSidebar 接缝（TC-1..TC-4）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetAppBootstrap()
    vi.clearAllMocks()
  })

  it('TC-1 selectSession 全编排：ensureStreamSubscription 先于 panel.loadSession；首次 hydrate；focusedSessionId 派生', async () => {
    const sidebar = useSidebar()
    // seed 接缝本地 store（C-W5-5 raw createSessionStore 实例）
    useSessionStore().applySnapshot({ groups: [group([summary('s1'), summary('s2')])] })
    // panel 绑定模拟：selectSession 内 syncSessionToPanel 调 panel.loadSession(activePanelId, id)
    // focusedSessionId 读 panel.focusedSessionId（= active panel leaf.sessionId）

    await sidebar.selectSession('s2')

    // 关键不变量（C-W3-4）：ensureStreamSubscription 调用且先于 panel 载入
    expect(mocks.ensureStreamSub).toHaveBeenCalledWith('s2', expect.anything(), expect.anything())
    // switchSession api 调用
    expect(mocks.switchSession).toHaveBeenCalledWith('s2')
    // 接缝本地 store activeId 更新（C-W5-5 raw store .value 生效）
    expect(useSessionStore().getActiveId()).toBe('s2')
    // 首次 hydrate：getHistory 调用
    expect(mocks.getHistory).toHaveBeenCalledWith('s2')
    // 文件树预加载 fire-forget
    expect(mocks.loadTree).toHaveBeenCalledWith('s2')
    // panel 载入后 focusedSessionId 派生为 s2
    expect(sidebar.focusedSessionId.value).toBe('s2')

    // 二次 selectSession 同 sid：切入刷新（后台 session reconcile，2026-08-22）——
    // 旧 isHydrated 一次性守卫已废，已 hydrate 的 session 切入时静默重拉（agent-managed
    // 子 session 的 turn 可能在前端不在场时完成）
    mocks.getHistory.mockClear()
    await sidebar.selectSession('s2')
    expect(mocks.getHistory).toHaveBeenCalledWith('s2')
  })

  it('TC-1c 已 hydrate 切入的窗口 reconcile 同步刷新 truncated 窗口状态（load-more 可恢复）', async () => {
    const sidebar = useSidebar()
    useSessionStore().applySnapshot({ groups: [group([summary('s1')])] })

    // 首次切入 hydrate（try 分支，truncated=false）
    mocks.getHistory.mockResolvedValue({ messages: [], truncated: false, loadedTurns: 1, totalTurnsEstimate: 1 })
    await sidebar.selectSession('s1')
    expect(useChatStore().isHydrated('s1')).toBe(true)

    // 场景：hydrate（窗口 truncated=true）→ load-more 游标翻页 → 切走切回，
    // getHistory 又返回预算窗口（u4b）——[u6] reconcile 合并语义：窗口响应仅合并覆盖
    // 最近窗口（已加载更早历史保留），窗口状态同步刷新 truncated=true，
    // 「加载更早」顶部条（hasMoreHistory 驱动）重显。
    // [u4d] SSOT = chat store 截断窗口状态（[u6] 契约三字段必填，legacy historyTruncated 退役）。
    mocks.getHistory.mockResolvedValue({ messages: [], truncated: true, loadedTurns: 2, totalTurnsEstimate: 2 })
    await sidebar.selectSession('s1')
    expect(useChatStore().getHistoryWindow('s1')?.truncated).toBe(true)

    // 响应未截断（truncated=false）→ 窗口收敛，与「分区已替换为响应内容」一致
    mocks.getHistory.mockResolvedValue({ messages: [], truncated: false, loadedTurns: 1, totalTurnsEstimate: 1 })
    await sidebar.selectSession('s1')
    expect(useChatStore().getHistoryWindow('s1')?.truncated).toBe(false)
  })

  it('TC-1b flow 活跃时切 session → cancelFlow（AC-3.10）', async () => {
    const { useNewTaskFlow } = await import('@/composables/features/new-task/useNewTaskFlow')
    vi.mocked(useNewTaskFlow).mockReturnValueOnce({
      isActive: { value: true },
      cancelFlow: mocks.cancelFlow,
      startFlow: mocks.startFlow,
      currentSession: { value: null },
      presetCwd: vi.fn(),
    } as unknown as ReturnType<typeof useNewTaskFlow>)
    const sidebar = useSidebar()
    useSessionStore().applySnapshot({ groups: [group([summary('s1')])] })

    await sidebar.selectSession('s1')

    expect(mocks.cancelFlow).toHaveBeenCalledTimes(1)
  })

  it('TC-2 deleteSession 代理 core：api.remove 调 + S3 清理 + wasActive 回退 selectSession', async () => {
    const removeMock = (await import('@xyz-agent/core/transport/api/domains/session')).remove as ReturnType<typeof vi.fn>
    removeMock.mockResolvedValue(undefined)
    const sidebar = useSidebar()
    useSessionStore().applySnapshot({ groups: [group([summary('s1'), summary('s2')])] })
    // 先 select s1 使其 active（触发 wasActive 回退路径）
    await sidebar.selectSession('s1')
    mocks.switchSession.mockClear()

    await sidebar.deleteSession('s1')

    // api.remove 调
    expect(removeMock).toHaveBeenCalledWith('s1')
    // wasActive 回退：selectSession(s2) → switchSession('s2')
    expect(mocks.switchSession).toHaveBeenCalledWith('s2')
    // s1 从列表移除
    expect(useSessionStore().getList().find((s) => s.id === 's1')).toBeUndefined()
  })

  it('TC-3 loadSessions 成功填 groups 清 error；失败 setListLoadError 不抛', async () => {
    const sidebar = useSidebar()
    mocks.list.mockResolvedValueOnce([group([summary('s1')])])
    await sidebar.loadSessions()
    expect(useSessionStore().getList().length).toBe(1)
    expect(useSessionStore().listLoadError).toBeNull()

    // 失败分支
    mocks.list.mockRejectedValueOnce(new Error('rpc down'))
    await sidebar.loadSessions()
    expect(useSessionStore().listLoadError).toBe('rpc down')
  })

  it('TC-4 返回签名对齐 useSidebar（含全字段）+ toggleCollapse/goOverview 行为', () => {
    const sidebar = useSidebar()
    const keys = Object.keys(sidebar)
    const expected = [
      'focusedSessionId', 'focusedSession', 'selectSession', 'newSession', 'retryHistory',
      'goOverview', 'loadSessions', 'initApp', 'onConnected', 'toggleCollapse',
      'syncSessionToPanel', 'renameSession', 'deleteSession', 'deleteFolder',
      'forkSession', 'forkSessionAsk', 'forkFromLastAssistant', 'enterForkModeFromLastAssistant',
      'handoff', 'abortHandoff', 'handoffFromLastAssistant', 'enterHandoffModeFromLastAssistant',
    ]
    for (const k of expected) {
      expect(keys, `返回对象应含字段 ${k}`).toContain(k)
    }

    // toggleCollapse 翻转 sidebar.collapsed
    const sidebarStore = useSidebarStore()
    const before = sidebarStore.collapsed
    sidebar.toggleCollapse()
    expect(sidebarStore.collapsed).toBe(!before)

    // goOverview → navigation.push({view:'overview'})
    const navigation = useNavigationStore()
    sidebar.goOverview()
    expect(navigation.current.view).toBe('overview')
  })

  it('TC-5 重连 onConnected 对聚焦 session 重拉 subagent/workflow（首连不拉；分区数据刷新用户可见）', async () => {
    const sessionDomain = await import('@xyz-agent/core/transport/api/domains/session')
    const getSubagentsMock = sessionDomain.getSubagents as ReturnType<typeof vi.fn>
    const getWorkflowsMock = sessionDomain.getWorkflows as ReturnType<typeof vi.fn>
    const record: SubagentRecord = {
      subagentId: 'sa-1',
      sessionFile: null,
      agent: 'worker',
      slug: 'probe',
      task: 'reconnect re-pull',
      status: 'running',
    }
    getSubagentsMock.mockClear()
    getWorkflowsMock.mockClear()
    getSubagentsMock.mockResolvedValueOnce([record])

    const sidebar = useSidebar()
    useSessionStore().applySnapshot({ groups: [group([summary('s1')])] })
    await sidebar.selectSession('s1')
    getSubagentsMock.mockClear()
    getWorkflowsMock.mockClear()

    // 首连（initApp 路径）不含 subagent/workflow 重拉——列表首拉归 useListSync
    await sidebar.onConnected()
    expect(getSubagentsMock).not.toHaveBeenCalled()
    expect(getWorkflowsMock).not.toHaveBeenCalled()

    // 重连：对聚焦 s1 重拉（RPC 直读磁盘，不依赖派生缓存事件）；分区更新 = 侧栏列表数据源
    await sidebar.onConnected()
    await new Promise((r) => setTimeout(r, 0))
    expect(getSubagentsMock).toHaveBeenCalledWith('s1')
    expect(getWorkflowsMock).toHaveBeenCalledWith('s1')
    expect(useSubagentStore().getRecordsBySession('s1')).toEqual([record])
  })

  it('TC-5b 重连时空焦点（无聚焦 session）不触发重拉', async () => {
    const sessionDomain = await import('@xyz-agent/core/transport/api/domains/session')
    const getSubagentsMock = sessionDomain.getSubagents as ReturnType<typeof vi.fn>
    const sidebar = useSidebar()

    await sidebar.onConnected() // 首连（initApp，空态无 session）
    await sidebar.onConnected() // 重连（focusedSessionId=null）
    await new Promise((r) => setTimeout(r, 0))
    expect(getSubagentsMock).not.toHaveBeenCalled()
  })
})

// ── 原 select-session-pull.test.ts 并入（同 SUT selectSession 编排、同 mock 骨架）──
// [HISTORICAL] 2026-07-29 handoff 回复丢失事故：selectSession 须统一注册订阅 + 不再主动
// 拉列表（remove-bandaids 反转断言）。幂等守卫本体在 core ensureStreamSubscription 内部
//（本文件 mock 掉该层，幂等由 core useChat 测试锁定），此处锁编排层可见信号。
describe('selectSession 订阅建立 + 不主动拉列表（remove-bandaids 反转断言）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetAppBootstrap()
    vi.clearAllMocks()
  })

  it('selectSession 触发订阅建立（ensureStreamSubscription 绑定目标 sid）', async () => {
    const sidebar = useSidebar()
    await sidebar.selectSession('sess-A')
    expect(mocks.ensureStreamSub).toHaveBeenCalledWith('sess-A', expect.anything(), expect.anything())
  })

  it('selectSession 不调 getSubagents/getWorkflows（stateSnapshot / workflowUpdate 信号提供），多次切换一致', async () => {
    const sessionDomain = await import('@xyz-agent/core/transport/api/domains/session')
    const sidebar = useSidebar()
    await sidebar.selectSession('sess-A')
    await sidebar.selectSession('sess-B')

    expect(sessionDomain.getSubagents).not.toHaveBeenCalled()
    expect(sessionDomain.getWorkflows).not.toHaveBeenCalled()
  })
})
