/**
 * Sidebar SessionList 加载失败态 DOM 渲染测试（W2 / S5 / E1）。
 *
 * 验证 sessionApi.list 失败后，Sidebar 的 sessions tab 显示加载失败提示 + 重试按钮。
 *
 * 运行：npx vitest run src/__tests__/components/sidebar-list-error-state.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { shallowMount } from '@vue/test-utils'

vi.stubGlobal('__APP_VERSION__', '0.0.0-test')

// ── mock useSidebar：loadSessions 可控制 reject ──
const loadSessionsMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))
const sidebarMocks = vi.hoisted(() => ({
  selectSession: vi.fn(),
  deleteSession: vi.fn(),
  renameSession: vi.fn(),
  newSession: vi.fn(),
  focusedSessionId: { value: null },
  focusedSession: { value: null },
  goOverview: vi.fn(),
  loadSessions: loadSessionsMock,
  syncSessionToPanel: vi.fn(),
}))
vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => sidebarMocks,
  deriveStatus: () => ({ value: 'done' }),
}))

// ── mock session store：listLoadError 可控（用闭包变量模拟 ref 解包）──
const sessionState = vi.hoisted(() => ({ listLoadError: null as string | null }))
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({
    groups: [],
    list: [],
    activeId: null,
    get listLoadError() { return sessionState.listLoadError },
    applySnapshot: vi.fn(),
    setListLoadError: vi.fn((msg: string | null) => { sessionState.listLoadError = msg }),
  }),
}))

vi.mock('@/stores/sidebar', () => ({
  useSidebarStore: () => ({ collapsed: false, activeTab: 'sessions', toggleCollapsed: vi.fn() }),
}))
vi.mock('@/stores/fileTree', () => ({
  useFileTreeStore: () => ({ fileCount: 0, getTree: () => null, getNodeState: () => 'idle', setNodeState: vi.fn() }),
}))
vi.mock('@/stores/panel', () => ({
  usePanelStore: () => ({
    currentLeaf: { id: 'panel-root', sessionId: null },
    activePanelId: 'panel-root',
    focusedSessionId: { value: null },
    layout: { value: { id: 'panel-root', sessionId: null } },
    findPanelBySession: () => null,
    loadSession: vi.fn(),
  }),
}))
vi.mock('@/stores/subagent', () => ({
  useSubagentStore: () => ({ recordsOf: () => ({ value: [] }), getRecordsBySession: () => [], hasRunning: () => false, isLoading: false, loadError: null }),
}))
vi.mock('@/stores/workflow', () => ({
  useWorkflowStore: () => ({
    recordsOf: () => ({ value: [] }), getRecordsBySession: () => [], hasRunningOrPaused: () => false,
    isLoading: false, loadError: null,
    workflowCount: () => 0, getCurrentWorkflow: () => null,
    selectWorkflow: vi.fn(), backToWorkflowList: vi.fn(),
    loadWorkflows: vi.fn(() => Promise.resolve()),
    selectAgentCall: vi.fn(() => Promise.resolve()), backFromAgentCall: vi.fn(),
  }),
}))
vi.mock('@/stores/navigation', () => ({
  useNavigationStore: () => ({ push: vi.fn(), current: { value: { view: 'chat' } }, stack: [] }),
}))
vi.mock('@/composables/features/command/useCommandStore', () => ({
  useCommandStore: () => ({
    appCommands: { value: [] },
    shortcutOverrides: { value: {} },
    pendingSlash: { value: null },
    clearPendingSlash: vi.fn(),
  }),
}))
vi.mock('@/composables/features/chat/useSessionDerivations', () => ({
  useSessionDerivations: () => ({ derivedStatus: () => ({ value: 'done' }) }),
}))
vi.mock('@/composables/features/chat/useListSync', () => ({ useListSync: vi.fn() }))
vi.mock('@xyz-agent/core/transport/api', () => ({
  onGlobalType: vi.fn(() => () => {}),
  dispatchSession: vi.fn(),
  dispatchGlobal: vi.fn(),
}))
vi.mock('@xyz-agent/core/transport/api/domains/session', () => ({
  list: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: vi.fn() }),
}))

import Sidebar from '@/components/sidebar/Sidebar.vue'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  sessionState.listLoadError = null
  loadSessionsMock.mockResolvedValue(undefined)
})

describe('E1: Sidebar SessionList 加载失败态（W2 / S5）', () => {
  it('listLoadError 非空时 DOM 含加载失败提示 + 重试按钮', async () => {
    // 模拟 loadSessions 失败后设了 listLoadError
    sessionState.listLoadError = 'server down'

    const wrapper = shallowMount(Sidebar)
    await wrapper.vm.$nextTick()

    // 失败态 DOM 存在
    const errorBlock = wrapper.find('[data-testid="session-list-error"]')
    expect(errorBlock.exists()).toBe(true)
    // 重试按钮存在
    const retryBtn = wrapper.find('[data-testid="session-list-retry"]')
    expect(retryBtn.exists()).toBe(true)
    // 错误消息含 'server down'
    expect(errorBlock.text()).toContain('server down')
  })

  it('listLoadError 为 null 时正常显示 SessionList（无失败态）', async () => {
    sessionState.listLoadError = null
    const wrapper = shallowMount(Sidebar)
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="session-list-error"]').exists()).toBe(false)
    // SessionList stub 存在（shallowMount 下被 stub）
    expect(wrapper.findComponent({ name: 'SessionList' }).exists()).toBe(true)
  })

  it('点击重试按钮触发 loadSessions', async () => {
    sessionState.listLoadError = 'server down'
    const wrapper = shallowMount(Sidebar)
    await wrapper.vm.$nextTick()

    // clearAllMocks 清掉 onMounted 的 loadSessions 调用，只测点击触发的
    loadSessionsMock.mockClear()
    const retryBtn = wrapper.find('[data-testid="session-list-retry"]')
    await retryBtn.trigger('click')

    expect(loadSessionsMock).toHaveBeenCalledTimes(1)
  })
})
