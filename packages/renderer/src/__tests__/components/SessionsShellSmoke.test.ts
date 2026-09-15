/**
 * TC-6：首屏冒烟（渲染 gate）—— mount 临时壳组件包 useSidebar，断言 session-list DOM 存在
 * + 切换 session 后 focusedSessionId 变化（AC6 语义 / AGENTS.md 测试规范 §8 渲染 gate）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/SessionsShellSmoke.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import type { SessionGroup, SessionSummary } from '@taiji/shared'

const mocks = vi.hoisted(() => ({
  switchSession: vi.fn().mockResolvedValue(undefined),
  list: vi.fn().mockResolvedValue([]),
  remove: vi.fn().mockResolvedValue(undefined),
  getHistory: vi.fn().mockResolvedValue({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 }),
  ensureStreamSub: vi.fn(),
  loadTree: vi.fn(),
  cancelFlow: vi.fn(),
  startFlow: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@taiji/core/transport/api/domains/session', () => ({
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
vi.mock('@taiji/core/transport/api/domains/chat', () => ({
  getHistory: mocks.getHistory,
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
  ensureStreamSubscription: mocks.ensureStreamSub,
}))
vi.mock('@/composables/features/file-tree/useFileTree', () => ({ useFileTree: vi.fn(() => ({ loadTree: mocks.loadTree })) }))
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => ({
  useNewTaskFlow: vi.fn(() => ({
    isActive: { value: false },
    cancelFlow: mocks.cancelFlow,
    startFlow: mocks.startFlow,
    currentSession: { value: null },
    presetCwd: vi.fn(),
  })),
}))
vi.mock('@/composables/features/fork-handoff/useForkActions', () => ({
  useForkActions: () => ({ forkSession: vi.fn(), forkSessionAsk: vi.fn(), forkFromLastAssistant: vi.fn(), enterForkModeFromLastAssistant: vi.fn() }),
}))
vi.mock('@/composables/features/fork-handoff/useHandoffActions', () => ({
  useHandoffActions: () => ({ handoff: vi.fn(), abortHandoff: vi.fn(), handoffFromLastAssistant: vi.fn(), enterHandoffModeFromLastAssistant: vi.fn() }),
}))

import SessionsShellSm from './SessionsShellSm.vue'
import { resetAppBootstrap } from '@/composables/features/sidebar/useSidebar'
import { useSessionStore } from '@/stores/session'

function summary(id: string, label: string, cwd = '/a'): SessionSummary {
  return { id, label, cwd, status: 'idle', lastActiveAt: 1, modelId: '' }
}

describe('SessionsShellSm 首屏冒烟（TC-6 / 渲染 gate）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetAppBootstrap()
    vi.clearAllMocks()
  })

  it('session-list DOM 存在 + 渲染 seeded session 项；初始 focusedSessionId===null', async () => {
    const wrapper = mount(SessionsShellSm)
    useSessionStore().applySnapshot({ groups: [
      { cwd: '/a', label: '/a', sessions: [summary('s1', '任务一'), summary('s2', '任务二'), summary('s3', '任务三')] },
    ] })
    await wrapper.vm.$nextTick()

    // 渲染 gate（§8）：session-list DOM 存在 + 含 3 个 session-item
    expect(wrapper.find('[data-testid=session-list]').exists()).toBe(true)
    const items = wrapper.findAll('[data-testid=session-item]')
    expect(items.length).toBe(3)
    expect(items[0].text()).toContain('任务一')

    // 初始 focusedSessionId===null（(no focus) chip）
    expect(wrapper.find('[data-testid=focused-chip]').text()).toContain('(no focus)')
  })

  it('切换 session 后 focused chip 更新 + focusedSessionId 变化（AC6 语义）', async () => {
    const wrapper = mount(SessionsShellSm)
    const sidebar = (wrapper.vm as unknown as { sidebar: { focusedSessionId: { value: string | null }, selectSession: (id: string) => Promise<void> } }).sidebar
    useSessionStore().applySnapshot({ groups: [
      { cwd: '/a', label: '/a', sessions: [summary('s1', '任务一'), summary('s2', '任务二')] },
    ] })
    await wrapper.vm.$nextTick()

    expect(sidebar.focusedSessionId.value).toBeNull()

    // 点击 session-item s2 → selectSession(s2)
    await wrapper.find('[data-testid=session-item][data-id="s2"]').trigger('click')
    await wrapper.vm.$nextTick()

    // focusedSessionId 变化为 s2 + focused chip 显示 s2 label
    expect(sidebar.focusedSessionId.value).toBe('s2')
    expect(wrapper.find('[data-testid=focused-chip]').text()).toContain('任务二')
  })
})
