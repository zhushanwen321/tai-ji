/**
 * useSidebar deleteSession 跨 store 清理 + fallback 测试（W1 / S3+S4）。
 *
 * 锁定 deleteSession 的两个修复：
 * - S3：删除时调 fileTree.clearSession(id) + useChat.disposeSession(id)
 * - S4：删 active 后 selectSession(next) 失败时 fallback 到 navigation.push({ view: 'chat' })
 * - [G1 / 2026-09-14 内存审计 §3.4] U-G1：三 Map 分区（terminal 写队列 / slash 命令历史 /
 *   fork 通知 feed）在 cleanupSessionState 后清理（真实例行为断言）
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

// ── mock useChat composable：捕获 disposeSession ──
const useChatDisposeMock = vi.hoisted(() => vi.fn())
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({ disposeSession: useChatDisposeMock }),
}))

// ── mock lib/ipc：捕获 browserDestroy（B4 接线断言）；其余导出透传真实模块 ──
const browserDestroyMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock('@/lib/ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc')>()),
  browserDestroy: browserDestroyMock,
}))

// ── mock api 域 ──
const removeMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))
const switchSessionMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  chat: { getHistory: vi.fn(() => Promise.resolve([])) },
  session: {
    create: vi.fn(() => Promise.resolve(makeSummary('mock'))),
    list: vi.fn(() => Promise.resolve([])),
    switchSession: switchSessionMock,
    rename: vi.fn(() => Promise.resolve()),
    remove: removeMock,
    getCommands: vi.fn(() => Promise.resolve({ commands: [] })),
  },
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

import { useSidebar } from '@/composables/features/sidebar/useSidebar'
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
function seedSessions(_sidebar: ReturnType<typeof useSidebar>, ids: string[]): void {
  const group: SessionGroup = { cwd: '/proj', sessions: ids.map(makeSummary) }
  useSessionStore().applySnapshot({ groups: [group] })
}

beforeEach(() => {
  // 模块级 cleanup registry 跨测试可能残留（本文件断言 cleanup 调用次数）→ 显式清空防 flaky
  __clearSessionCleanupRegistryForTest()
  setActivePinia(createPinia())
  vi.clearAllMocks()
  removeMock.mockResolvedValue(undefined)
  switchSessionMock.mockResolvedValue(undefined)
  // G1：fork feed 模块级状态隔离（同 use-fork-branch-notify.test.ts 范式）
  resetForkNoticeFeed()
})

describe('useSidebar deleteSession 跨 store 清理（W1 / S3）', () => {
  it('U3: deleteSession 调用 fileTree.clearSession + useChat.disposeSession', async () => {
    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    seedSessions(sidebar, ['s1', 's2'])
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
    seedSessions(sidebar, ['s1', 's2'])

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
      seedSessions(sidebar, ['s1', 's2'])

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

describe('useSidebar deleteSession 删 active 后 fallback（W1 / S4）', () => {
  it('U4: 删 active session 后 selectSession(next) reject → navigation.push({ view: chat })', async () => {
    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    seedSessions(sidebar, ['s1', 's2'])
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
    // 跨 store 清理仍执行（不受 selectSession 失败影响）
    expect(clearSessionMock).toHaveBeenCalledWith('s1')
    expect(useChatDisposeMock).toHaveBeenCalledWith('s1')

    scope.stop()
  })

  it('删 active session 后 list 为空 → navigation.push({ view: chat })', async () => {
    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    seedSessions(sidebar, ['s1'])
    useSessionStore().setActiveId('s1')

    const navigation = useNavigationStore()
    const pushSpy = vi.spyOn(navigation, 'push')

    await sidebar.deleteSession('s1')

    expect(pushSpy).toHaveBeenCalledWith({ view: 'chat' })

    scope.stop()
  })
})

describe('useSidebar deleteSession 触发 session-scoped cleanup（W5 / ADR-0049）', () => {
  it('U5: deleteSession 调 triggerSessionCleanups(id)，注册的 cleanup 被执行', async () => {
    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    seedSessions(sidebar, ['s1'])

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
