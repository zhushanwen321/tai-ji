/**
 * useSidebar chatPort.hydrate 磁盘重载基线接管点清 turn-expansion 分区的接线测试
 * （chat-flow-consistency C4 两段式契约的「重载重置」侧；store 侧行为见
 * stores/__tests__/turn-expansion.test.ts 两段式契约 describe）。
 *
 * 锁定壳层接线这一件事：切入链步 9 的 hydrate 分支（未 hydrate 会话的走盘重载）在回填前
 * 调 turn-expansion store clearSession——turn 稳定 id 在 live 与盘上两侧不相交（pi 事件不带
 * entry id），重载后键失配本就回落收起，显式清分区把「静默失配」变「可断言重置」。对偶侧
 * （驻留保持）：已 hydrate 会话切回走 refreshHistory → reconcileHistory 增量刷新，不经本
 * 接管点，手动展开保持。
 *
 * mock 策略对齐 useSidebar-reconnect-reconcile.test.ts：真实 useSidebar（effectScope 驱动），
 * mock @/api 域 + useNewTaskFlow / useFileTree，selectSession 走 core 12 步切入链。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/useSidebar-hydrate-turn-expansion.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope } from 'vue'
import { resetAppBootstrap } from '@/composables/features/sidebar/useSidebar'
import { useChatStore } from '@/stores/chat'
import { useTurnExpansionStore } from '@/stores/turn-expansion'

vi.mock('@/api', () => ({
  chat: { getHistory: vi.fn(() => Promise.resolve({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })), streamSubscribe: vi.fn(() => () => {}) },
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
  workspace: { listRecent: vi.fn(() => Promise.resolve([])), defaultSessionDir: vi.fn(() => Promise.resolve('')) },
  project: { load: vi.fn(() => Promise.resolve({ projects: [], activeProjectId: '' })), save: vi.fn(() => Promise.resolve()) },
  file: { tree: vi.fn(() => Promise.resolve([])), expand: vi.fn(() => Promise.resolve([])) },
  git: { status: vi.fn(() => Promise.resolve({ sessionId: 'mock', isRepo: false, files: [] })) },
}))

// 切入链 sessionEntry.preloadFileTree 的文件树加载（本测试不需要树）
vi.mock('@/composables/features/file-tree/useFileTree', () => ({
  useFileTree: () => ({ loadTree: vi.fn(() => Promise.resolve()) }),
}))

// initApp 编排的 landing 入口：no-op 壳（本测试不消费 landing 态）
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

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  resetAppBootstrap()
})

describe('useSidebar chatPort.hydrate 清 turn-expansion 分区接线（C4 重载重置侧）', () => {
  it('未 hydrate 会话切入（走盘重载）→ 展开分区被清（重置侧断言）', async () => {
    const expansion = useTurnExpansionStore()
    // 重载前的展开态（live 期 id；重载后 id 换空间，状态不应存活）
    expansion.expand('s-hydrate-fresh', 'turn-live-id')

    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    await sidebar.selectSession('s-hydrate-fresh')

    expect(expansion.isExpanded('s-hydrate-fresh', 'turn-live-id')).toBe(false)
    scope.stop()
  })

  it('已 hydrate 会话切回（驻留期 reconcile 刷新）→ 展开分区保持（驻留保持侧断言）', async () => {
    const chat = useChatStore()
    const expansion = useTurnExpansionStore()

    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    // 第一次切入：走盘重载（hydrate 分支）
    await sidebar.selectSession('s-hydrate-kept')
    // 驻留期手动展开（重载后用盘侧新 id 展开）
    expansion.expand('s-hydrate-kept', 'turn-reloaded-id')
    // 第二次切入：isHydrated=true → refreshHistory（reconcile），不得清展开
    await sidebar.selectSession('s-hydrate-kept')

    expect(chat.isHydrated('s-hydrate-kept')).toBe(true)
    expect(expansion.isExpanded('s-hydrate-kept', 'turn-reloaded-id')).toBe(true)
    scope.stop()
  })
})
