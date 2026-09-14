/**
 * lru-panel-exempt-fix 测试：方案 C — selectSession 在 evictIfNeeded 前刷新当前 session 的 LRU recency。
 *
 * v2 移除 panel split 后恒单 panel：panel 绑定的 session 即当前 active session，
 * selectSession 内 chat.touchLru(id) 在 evictIfNeeded 前刷新 recency，确保切走时当前 session 不被误驱逐。
 * 原双 panel standby 保护（AC-1）/close 后解除保护（AC-4）随 split 一并移除（无第二 panel 可承载 standby）。
 *
 * 锁定的 AC：
 * - AC-2：单 panel 下切 9 个 session，最旧的 session 被驱逐（LRU 基线不退化）
 *
 * [session-reconcile 对齐] b97147c7e 后 selectSession 对已 hydrate 的 session 也会
 * getHistory + reconcileHistory 静默刷新（entry 历史为基线）。测试 harness 必须让
 * getHistory mock 与 hydrateSession 注入的消息一致（fake backend Map），否则切入刷新
 * 会把注入消息替换成空基线——s0「被驱逐」断言空洞通过、s8「保留」断言必红。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/useSidebar-lru-panel-exempt.test.ts
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope } from 'vue'
import type { Message, SessionGroup, SessionSummary } from '@xyz-agent/shared'
import { _resetLruForTest } from '@xyz-agent/core'
import { useSessionStore } from '@/stores/session'

// ── mock 无关 store / composable，减少 selectSession 噪音 ──
const clearSessionMock = vi.hoisted(() => vi.fn())
vi.mock('@/stores/fileTree', () => ({
  useFileTreeStore: () => ({ clearSession: clearSessionMock }),
}))

const useChatDisposeMock = vi.hoisted(() => vi.fn())
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({
    disposeSession: useChatDisposeMock,
  }),
  ensureStreamSubscription: vi.fn(),
}))

const loadSubagentsMock = vi.hoisted(() => vi.fn())
vi.mock('@/stores/subagent', () => ({
  useSubagentStore: () => ({ loadSubagents: loadSubagentsMock }),
  subagentVirtualId: (main: string, sub: string) => `subagent:${main}:${sub}`,
}))

const loadWorkflowsMock = vi.hoisted(() => vi.fn())
vi.mock('@/stores/workflow', () => ({
  useWorkflowStore: () => ({
    loadWorkflows: loadWorkflowsMock,
    // [B9 agentcall LRU 联动] chat store 装配回调在驱逐时调本方法（豁免后返回待释放 vid）。
    // 本测试无 agentcall 登记，恒空——回归而补齐 mock 面，防装配回调 TypeError。
    getAgentCallVirtualIdsByMain: () => [],
  }),
}))

const loadTreeMock = vi.hoisted(() => vi.fn())
vi.mock('@/composables/features/file-tree/useFileTree', () => ({
  useFileTree: () => ({ loadTree: loadTreeMock }),
}))

// ── mock api 域 ──
const switchSessionMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))
const getHistoryMock = vi.hoisted(() => vi.fn(() => Promise.resolve({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })))
const getCommandsMock = vi.hoisted(() => vi.fn(() => Promise.resolve({ commands: [] })))
const getContextMock = vi.hoisted(() => vi.fn(() => Promise.resolve({})))
vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  chat: { getHistory: getHistoryMock, streamSubscribe: vi.fn(() => () => {}) },
  extension: {},
  session: {
    create: vi.fn(() => Promise.resolve(makeSummary('mock'))),
    list: vi.fn(() => Promise.resolve([])),
    switchSession: switchSessionMock,
    rename: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
    getCommands: getCommandsMock,
    getContext: getContextMock,
  },
}))

import { useSidebar } from '@/composables/features/sidebar/useSidebar'
import { useChatStore } from '@/stores/chat'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'

function makeSummary(id: string): SessionSummary {
  return { id, label: id, cwd: '/proj', status: 'idle', lastActiveAt: 1, modelId: 'm1', tokenCount: 0 }
}

function makeMessage(id: string): Message {
  return { id, role: 'assistant', content: `msg-${id}`, status: 'complete', timestamp: Date.now() }
}

// seed pinia session store（ADR-0059：useSessionStore 单例）
function seedSessions(_sidebar: ReturnType<typeof useSidebar>, ids: string[]): void {
  const group: SessionGroup = { cwd: '/proj', sessions: ids.map(makeSummary) }
  useSessionStore().applySnapshot({ groups: [group] })
}

/** fake backend：sessionId → 服务端可返回的历史。getHistory mock 由此取数（对齐真实后端）。 */
const historyBackend = new Map<string, Message[]>()

/**
 * hydrate 指定 session（直接注入消息）。
 * 须同步写 historyBackend：切入 reconcile（b97147c7e）以 getHistory 结果为基线，
 * backend 与注入不一致时刷新会把注入消息替换掉，LRU 断言失去检验对象。
 */
function hydrateSession(id: string, msgs: Message[]): void {
  historyBackend.set(id, msgs)
  useChatStore().hydrate(id, msgs)
}

describe('lru-panel-exempt-fix 方案 C：panel 绑定 session 不被 LRU 误驱逐', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    _resetLruForTest()
    vi.clearAllMocks()
    vi.useFakeTimers()
    historyBackend.clear()
    switchSessionMock.mockResolvedValue(undefined)
    getHistoryMock.mockImplementation((sid: string) =>
      Promise.resolve({ messages: historyBackend.get(sid) ?? [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 }),
    )
    getCommandsMock.mockResolvedValue({ commands: [] })
    getContextMock.mockResolvedValue({})
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('AC-2: 单 panel LRU 基线不退化（最旧被驱逐）', () => {
    it('单 panel 下切 9 个 session，最旧的 session 被驱逐', async () => {
      const scope = effectScope()
      const sidebar = scope.run(() => useSidebar())!
      const ids = Array.from({ length: 9 }, (_, i) => `s${i}`)
      seedSessions(sidebar, ids)

      const panel = usePanelStore()
      // 单 panel（默认 ROOT_PANEL_ID）
      panel.loadSession(ROOT_PANEL_ID, 's0')

      // 依次切 9 个 session（每次都绑到 ROOT_PANEL_ID，单 panel 模式）
      for (let i = 0; i < ids.length; i++) {
        vi.setSystemTime(1000 + i * 10)
        hydrateSession(ids[i], [makeMessage(`msg-${ids[i]}`)])
        await sidebar.selectSession(ids[i])
      }

      // AC-2 断言：最旧的 s0 被驱逐（LRU 基线不退化——方案 C 不能把 LRU 架空）
      expect(useChatStore().getMessages('s0')).toHaveLength(0)
      // 最新的 s8 保留
      expect(useChatStore().getMessages('s8')).toHaveLength(1)

      scope.stop()
    })
  })
})
