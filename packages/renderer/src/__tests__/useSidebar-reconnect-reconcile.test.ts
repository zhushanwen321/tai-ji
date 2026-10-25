/**
 * useSidebar onConnected 重连分支的对话流历史对账接线（U8，design-session-lifecycle
 * 缺陷 2——桌面壳向移动壳 connected-reconcile 既有模式对齐）。
 *
 * 锁定壳层接线这一件事：hasConnectedBefore 置位后的 onConnected（重连边沿）对聚焦 session
 * 经 core refreshHistory 单一编排点触发对话流对账（已 hydrate → chat.getHistory RPC 直读）。
 * 对账编排本体（窗口归一 + 图片落盘 + 未 hydrate no-op + 失败静默）在 core
 * use-session-refresh-history 测试族覆盖；本文件只锁接线（对齐移动壳 connected-reconcile
 * 形态）：漏接形态下真机因「无独立可观测锚点」假通过，防线必须落在本接线单测。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/useSidebar-reconnect-reconcile.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope } from 'vue'
import { resetAppBootstrap } from '@/composables/features/sidebar/useSidebar'
import { useChatStore } from '@/stores/chat'
import { usePanelStore } from '@/stores/panel'

const mockGetHistory = vi.fn(() => Promise.resolve({
  messages: [],
  truncated: false,
  loadedTurns: 0,
  totalTurnsEstimate: 0,
}))

// api 域 mock：chat.getHistory 是断言目标（core refreshHistory 的 RPC 出口）；其余为
// onConnected 链路（workspace.load / extension.scan / subagent/workflow 列表 / initApp
// 编排）的 no-op 壳，防 unhandled rejection。
vi.mock('@/api', () => ({
  chat: { getHistory: (...args: unknown[]) => mockGetHistory(...(args as [])), streamSubscribe: vi.fn(() => () => {}) },
  session: {
    list: vi.fn(() => Promise.resolve([])),
    create: vi.fn(() => Promise.resolve({ id: 'mock', label: 'mock', cwd: '/proj', status: 'idle', lastActiveAt: 1, modelId: 'm1', tokenCount: 0 })),
    switchSession: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
    removeByCwd: vi.fn(() => Promise.resolve({ cwd: '/proj', deleted: [], failed: [] })),
    rename: vi.fn(() => Promise.resolve()),
    restoreSession: vi.fn(() => Promise.resolve({ id: 'mock', label: 'mock', cwd: '/proj', status: 'idle', lastActiveAt: 1, modelId: 'm1', tokenCount: 0 })),
    getCommands: vi.fn(() => Promise.resolve({ sessionId: 'mock', commands: [] })),
    getContext: vi.fn(() => Promise.resolve({ inputTokens: 0, contextLimit: 0, usagePercent: 0 })),
    getSubagents: vi.fn(() => Promise.resolve({ subagents: [], oversize: false, found: true })),
    getWorkflows: vi.fn(() => Promise.resolve({ workflows: [], oversize: false, found: true })),
    setProject: vi.fn(() => Promise.resolve()),
    setThinkingLevel: vi.fn(() => Promise.resolve()),
    unsubscribe: vi.fn(() => Promise.resolve()),
  },
  extension: { scan: vi.fn(() => Promise.resolve({ extensions: [] })) },
  workspace: {
    listRecent: vi.fn(() => Promise.resolve([])),
    defaultSessionDir: vi.fn(() => Promise.resolve('')),
  },
  project: { load: vi.fn(() => Promise.resolve({ projects: [], activeProjectId: '' })), save: vi.fn(() => Promise.resolve()) },
  file: { tree: vi.fn(() => Promise.resolve([])), expand: vi.fn(() => Promise.resolve([])) },
  git: { status: vi.fn(() => Promise.resolve({ sessionId: 'mock', isRepo: false, files: [] })) },
}))

// initApp 编排的 landing 入口（newSession → startFlow）：no-op 壳（本测试不消费 landing 态）
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => ({
  useNewTaskFlow: () => ({
    isActive: { value: false },
    currentSession: { value: null },
    currentCwd: { value: null },
    currentModel: { value: null },
    startFlow: vi.fn(() => Promise.resolve()),
    presetCwd: vi.fn(),
    cancelFlow: vi.fn(),
  }),
  resetNewTaskFlow: vi.fn(),
}))

import { useSidebar } from '@/composables/features/sidebar/useSidebar'

/** 最小 user 消息（hydrate 分区置位用） */
function userMsg(id: string): Parameters<ReturnType<typeof useChatStore>['hydrate']>[1][number] {
  return { id, role: 'user', content: '历史消息', status: 'complete', timestamp: 0 }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  resetAppBootstrap()
})

describe('useSidebar onConnected 重连对账接线（U8）', () => {
  it('重连边沿：已 hydrate 的聚焦 session 经 core refreshHistory 触发 chat.getHistory 对账', async () => {
    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    // 首连：走 initApp 分支（hasConnectedBefore 置位；此阶段不产生对账拉取）
    await sidebar.onConnected()
    expect(mockGetHistory).not.toHaveBeenCalled()

    // 准备已 hydrate 的聚焦 session（refreshHistory 的 no-op 保护对未 hydrate 会话短路）
    const chat = useChatStore()
    chat.hydrate('rc-sid', [userMsg('u1')])
    usePanelStore().loadSession(usePanelStore().activePanelId, 'rc-sid')

    // 重连边沿：refreshHistory 接线生效（getHistory RPC 直读 = 对账执行的可观测锚点）
    await sidebar.onConnected()
    expect(mockGetHistory).toHaveBeenCalledTimes(1)
    expect(mockGetHistory).toHaveBeenCalledWith('rc-sid')
    scope.stop()
  })

  it('重连边沿 + 未 hydrate 聚焦 session：refreshHistory 内部 no-op，不产生拉取（射程保护）', async () => {
    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    await sidebar.onConnected()
    usePanelStore().loadSession(usePanelStore().activePanelId, 'fresh-sid')

    await sidebar.onConnected()
    expect(mockGetHistory).not.toHaveBeenCalled()
    scope.stop()
  })

  it('首连（hasConnectedBefore 未置位）：走 initApp，不触发对账拉取', async () => {
    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    const chat = useChatStore()
    chat.hydrate('rc-sid', [userMsg('u1')])
    usePanelStore().loadSession(usePanelStore().activePanelId, 'rc-sid')

    await sidebar.onConnected()
    expect(mockGetHistory).not.toHaveBeenCalled()
    scope.stop()
  })
})
