/**
 * Sidebar CRUD handler 异常处理测试（W3 / S2）。
 *
 * 验证 onSelectSession / onArchiveSession 两个 async handler 在底层 reject 时
 * catch + toastError，不产生 unhandled rejection。对齐同组件已有的
 * onSelectAgentCall / onWorkflowAction 模式。
 *
 * 覆盖边界：sidebar 删除链路的 UI 入口是归档钮（session-archive D6 迁移后删除走
 * archive 链路，其异常处理契约由 onArchiveSession 承载断言）；
 * onConfirmRename / onNewSession 的错误路径不在本文件覆盖范围。
 *
 * 策略：mount Sidebar 前把 useSidebar 返回的方法 mock 成 reject，mock useToast 捕获
 * toastError 调用。mount 后通过 DOM 事件或直接调 handler 触发。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/components/sidebar-crud-error-handling.test.ts
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
  archiveSession: vi.fn(),
  renameSession: vi.fn(),
  newSession: vi.fn(),
  focusedSessionId: { value: null },
  focusedSession: { value: null },
  loadSessions: vi.fn(() => Promise.resolve()),
  syncSessionToPanel: vi.fn(),
}))
vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => sidebarMocks,
  deriveStatus: () => ({ value: 'done' }),
}))

// ── mock stores（Sidebar setup 期读取）──
vi.mock('@/stores/sidebar', () => ({
  SIDEBAR_TAB_SESSIONS: 'ui.sessions',
  SIDEBAR_TAB_FILES: 'ui.files',
  SIDEBAR_TAB_PLUGINS: 'ui.plugins',
  useSidebarStore: () => ({ collapsed: false, activeTab: 'ui.sessions', toggleCollapsed: vi.fn() }),
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
    loadWorkflows: vi.fn(() => Promise.resolve()),
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

// ── mock api/events（onMounted 的 loadSessions / app.info 订阅）──
vi.mock('@taiji/core/transport/api', () => ({
  onGlobalType: vi.fn(() => () => {}),
  dispatchSession: vi.fn(),
  dispatchGlobal: vi.fn(),
}))
vi.mock('@taiji/core/transport/api/domains/session', () => ({
  list: vi.fn().mockResolvedValue([]),
  // 归档搜索源（useSearchModalDeps 壳组装引用；本用例不涉归档，空列表即足）
  listArchives: vi.fn().mockResolvedValue([]),
}))

import Sidebar from '@/components/sidebar/Sidebar.vue'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  // 默认 resolve（非异常用例的基础状态）
  sidebarMocks.selectSession.mockResolvedValue(undefined)
  sidebarMocks.archiveSession.mockResolvedValue(undefined)
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
   * U6: 删除链路 remove 失败时 toast 报错。
   */
  it('onArchiveSession 失败时 toast 报错', async () => {
    // [session-archive D6] 悬停删除钮已迁移为归档钮——Sidebar 删除链路异常处理契约的
    // 现行载体是 archive 链路
    sidebarMocks.archiveSession.mockRejectedValue(new Error('server error'))
    const wrapper = shallowMount(Sidebar)

    await wrapper.vm.$nextTick()
    const sessionList = wrapper.findComponent({ name: 'SessionList' })
    sessionList.vm.$emit('archive', 's1')

    await vi.waitFor(() => {
      expect(sidebarMocks.archiveSession).toHaveBeenCalledWith('s1')
    })

    await vi.waitFor(() => {
      expect(toastError).toHaveBeenCalledTimes(1)
      expect(toastError.mock.calls[0][0]).toContain('归档失败')
    })
  })
})
