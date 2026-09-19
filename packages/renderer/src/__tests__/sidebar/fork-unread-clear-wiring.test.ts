/**
 * R5 最后一跳闭合测试：core select 链 step 4 → `sessionEntry.clearUnread` 的端到端接线。
 *
 * 背景（设计 `.tmp/tech-design/mode-system-composer-density.md` §8.2 S9 ②）：后台完成或被停止
 * 时未读点亮起，且**点开后消失**。fork-group.test.ts 的 R5 只做纯函数级断言（直接调
 * `clearSessionUnread`，注释自述「清除点在编排层，组件层只 emit select，无法从 DOM 观测清除
 * 动作本身」）——「点开（select）→ 清未读」这一跳无自动回归防线。本文件在 useSidebar 集成层
 * 补上：真实 `selectSession(branchId)` 走 core 12 步链，观测两源（session 标记 + fork 分支角标）
 * 同点清空。
 *
 * 判据取行为而非实现形态（(a) 优先）：selectSession 后 `isUnread(id) === false` 且
 * `unreadByBranch` 不再含该 id——两源同清。端口接线若断（`sessionEntry.clearUnread` 非
 * `clearSessionUnread`），两源至少一源残留，本测试即红。
 *
 * mock 骨架与 `__tests__/composables/useSidebar.test.ts` 同源（真实 useSidebar + 域名 api stub），
 * 因该文件与 `__tests__/sidebar/` 分属不同测试目录、vitest 文件级模块图隔离，故在此重述最小集。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/fork-unread-clear-wiring.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { SessionGroup, SessionSummary } from '@taiji/shared'

const mocks = vi.hoisted(() => ({
  switchSession: vi.fn().mockResolvedValue(undefined),
}))

// ── api 层 mock（selectSession 步 2 switchSession + 步 9 getHistory 需可控 stub）──
vi.mock('@taiji/core/transport/api/domains/session', () => ({
  switchSession: mocks.switchSession,
  list: vi.fn().mockResolvedValue([]),
  remove: vi.fn(),
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
vi.mock('@taiji/core/transport/api/domains/chat', () => ({
  getHistory: vi
    .fn()
    .mockResolvedValue({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 }),
  send: vi.fn(),
  streamSubscribe: vi.fn(),
}))
vi.mock('@taiji/core/transport/api', () => ({
  on: vi.fn(() => () => {}),
  onGlobalType: vi.fn(() => () => {}),
  dispatchSession: vi.fn(),
}))
vi.mock('@taiji/core/transport/api/domains/file', () => ({ tree: vi.fn().mockResolvedValue({}) }))
vi.mock('@taiji/core/transport/api/domains/git', () => ({ status: vi.fn().mockResolvedValue({}) }))
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  const session = await import('@taiji/core/transport/api/domains/session')
  const chat = await import('@taiji/core/transport/api/domains/chat')
  return { ...actual, session, chat }
})
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: vi.fn(() => ({ disposeSession: vi.fn() })),
  ensureStreamSubscription: vi.fn(),
}))
vi.mock('@/composables/features/file-tree/useFileTree', () => ({
  useFileTree: vi.fn(() => ({ loadTree: vi.fn() })),
}))
vi.mock('@/composables/features/command/useCommandStore', () => ({
  useCommandStore: () => ({
    appCommands: { value: [] },
    shortcutOverrides: { value: {} },
    clearCommands: vi.fn(),
  }),
}))
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => ({
  useNewTaskFlow: vi.fn(() => ({
    isActive: { value: false },
    cancelFlow: vi.fn(),
    startFlow: vi.fn().mockResolvedValue(undefined),
    currentSession: { value: null },
    presetCwd: vi.fn(),
  })),
}))
// fork/handoff 编排与 select 链正交，stub 掉避免触真实 api/store 链
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

import { useSidebar, resetAppBootstrap } from '@/composables/features/sidebar/useSidebar'
import { useSessionStore } from '@/stores/session'
import {
  isUnread,
  markUnread,
  __resetCacheForTest,
} from '@/composables/useSessionMarkers'
import {
  registerFork,
  resetForkBranchState,
  syncForkBranches,
  unreadByBranch,
} from '@/composables/features/fork-handoff/useForkBranchNotify'

const CWD = '/p'
const PARENT_FILE = '/p/src.jsonl'

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'sess-parent',
    label: '主分支会话',
    cwd: CWD,
    status: 'idle',
    lastActiveAt: Date.now(),
    modelId: 'gpt-4',
    tokenCount: 1000,
    ...overrides,
  } as SessionSummary
}

function group(sessions: SessionSummary[]): SessionGroup {
  return { cwd: CWD, label: CWD, sessions }
}

beforeEach(() => {
  setActivePinia(createPinia())
  resetAppBootstrap()
  localStorage.removeItem('taiji:session-markers')
  __resetCacheForTest()
  resetForkBranchState()
  vi.clearAllMocks()
})

describe('R5 接线：selectSession（点开）→ core 链 step 4 清两源未读', () => {
  it('后台完成 + 后台被停止两源都点亮后，selectSession(branchId) 一次清空两源（S9 ②）', async () => {
    const sid = 'b-select'
    // 两源均置位：① session 标记（后台完成 markUnread）② fork 分支角标（后台 stopped）
    markUnread(sid)
    registerFork('sess-parent', sid, '分支')
    syncForkBranches(
      [
        {
          cwd: CWD,
          sessions: [makeSession({ id: sid, parentSession: PARENT_FILE, status: 'stopped' })],
        } as SessionGroup,
      ],
      () => {},
    )
    // 前置：两源都点亮（未读点可见的充分条件）
    expect(isUnread(sid)).toBe(true)
    expect(unreadByBranch.value.get(sid)).toBe(true)

    const sidebar = useSidebar()
    useSessionStore().applySnapshot({ groups: [group([makeSession({ id: sid })])] })

    // 点开 = 真实走 core select 链（步 4 经 sessionEntry.clearUnread 端口）
    await sidebar.selectSession(sid)

    // 最后一跳闭合：两源同点清空（清点若非 clearSessionUnread，至少一源残留 → 红）
    expect(isUnread(sid)).toBe(false)
    expect(unreadByBranch.value.has(sid)).toBe(false)
  })
})
