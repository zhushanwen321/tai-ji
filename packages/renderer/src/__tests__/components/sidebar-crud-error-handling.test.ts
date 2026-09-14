/**
 * Sidebar CRUD handler 异常处理测试（W3 / S2）。
 *
 * 验证 onSelectSession / onDeleteSession / onConfirmRename / onNewSession 四个
 * async handler 在底层 reject 时 catch + toastError，不产生 unhandled rejection。
 * 对齐同组件已有的 onSelectAgentCall / onWorkflowAction 模式。
 *
 * 策略：mount Sidebar 前把 useSidebar 返回的方法 mock 成 reject，mock useToast 捕获
 * toastError 调用。mount 后通过 DOM 事件或直接调 handler 触发。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/components/sidebar-crud-error-handling.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { shallowMount } from '@vue/test-utils'

// __APP_VERSION__ 是 vite define 注入的全局常量，vitest 下不存在，stub 之
vi.stubGlobal('__APP_VERSION__', '0.0.0-test')

// ── mock useToast：捕获 toastError ──
const toastError = vi.hoisted(() => vi.fn())
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError }),
}))

// ── mock useSidebar：返回的 CRUD 方法可控制 reject ──
const sidebarMocks = vi.hoisted(() => ({
  selectSession: vi.fn(),
  deleteSession: vi.fn(),
  renameSession: vi.fn(),
  newSession: vi.fn(),
  focusedSessionId: { value: null },
  focusedSession: { value: null },
  goOverview: vi.fn(),
  loadSessions: vi.fn(() => Promise.resolve()),
  syncSessionToPanel: vi.fn(),
}))
vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => sidebarMocks,
  deriveStatus: () => ({ value: 'done' }),
}))

// ── mock stores（Sidebar setup 期读取）──
vi.mock('@/stores/sidebar', () => ({
  useSidebarStore: () => ({ collapsed: false, activeTab: 'sessions', toggleCollapsed: vi.fn() }),
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({
    groups: [],
    list: [],
    activeId: null,
    applySnapshot: vi.fn(),
  }),
}))
vi.mock('@/stores/fileTree', () => ({
  useFileTreeStore: () => ({
    fileCount: 0,
    getTree: () => null,
    getNodeState: () => 'idle',
    setNodeState: vi.fn(),
  }),
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
  useSubagentStore: () => ({ recordsOf: () => ({ value: [] }), getRecordsBySession: () => [], hasRunning: () => false }),
}))
vi.mock('@/stores/workflow', () => ({
  useWorkflowStore: () => ({
    recordsOf: () => ({ value: [] }),
    getRecordsBySession: () => [],
    hasRunningOrPaused: () => false,
    workflowCount: () => 0,
    getCurrentWorkflow: () => null,
    selectWorkflow: vi.fn(),
    backToWorkflowList: vi.fn(),
    loadWorkflows: vi.fn(() => Promise.resolve()),
    selectAgentCall: vi.fn(() => Promise.resolve()),
    backFromAgentCall: vi.fn(),
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

// ── mock composables ──
vi.mock('@/composables/features/chat/useSessionDerivations', () => ({
  useSessionDerivations: () => ({ derivedStatus: () => ({ value: 'done' }) }),
}))
vi.mock('@/composables/features/chat/useListSync', () => ({ useListSync: vi.fn() }))

// ── mock api/events（onMounted 的 loadSessions / app.info 订阅）──
vi.mock('@xyz-agent/core/transport/api', () => ({
  onGlobalType: vi.fn(() => () => {}),
  dispatchSession: vi.fn(),
  dispatchGlobal: vi.fn(),
}))
vi.mock('@xyz-agent/core/transport/api/domains/session', () => ({
  list: vi.fn().mockResolvedValue([]),
}))

import Sidebar from '@/components/sidebar/Sidebar.vue'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  // 默认 resolve（非异常用例的基础状态）
  sidebarMocks.selectSession.mockResolvedValue(undefined)
  sidebarMocks.deleteSession.mockResolvedValue(undefined)
  sidebarMocks.renameSession.mockResolvedValue(undefined)
  sidebarMocks.newSession.mockResolvedValue(null)
})

describe('Sidebar CRUD handler 异常处理', () => {
  /**
   * U5: onSelectSession switchSession 失败时 toast 报错。
   */
  it('onSelectSession 失败时 toast 报错（不静默吞错）', async () => {
    sidebarMocks.selectSession.mockRejectedValue(new Error('network down'))
    const wrapper = shallowMount(Sidebar)

    await wrapper.vm.$nextTick()
    // shallowMount 下 SessionList 被 stub，通过 stub 触发 select 事件
    const sessionList = wrapper.findComponent({ name: 'SessionList' })
    sessionList.vm.$emit('select', 's1')

    await vi.waitFor(() => {
      expect(sidebarMocks.selectSession).toHaveBeenCalledWith('s1')
    })

    await vi.waitFor(() => {
      expect(toastError).toHaveBeenCalledTimes(1)
      expect(toastError.mock.calls[0][0]).toContain('切换会话失败')
    })
  })

  /**
   * U6: onDeleteSession remove 失败时 toast 报错。
   */
  it('onDeleteSession 失败时 toast 报错', async () => {
    sidebarMocks.deleteSession.mockRejectedValue(new Error('server error'))
    const wrapper = shallowMount(Sidebar)

    await wrapper.vm.$nextTick()
    const sessionList = wrapper.findComponent({ name: 'SessionList' })
    sessionList.vm.$emit('delete', 's1')

    await vi.waitFor(() => {
      expect(sidebarMocks.deleteSession).toHaveBeenCalledWith('s1')
    })

    await vi.waitFor(() => {
      expect(toastError).toHaveBeenCalledTimes(1)
      expect(toastError.mock.calls[0][0]).toContain('删除会话失败')
    })
  })
})
