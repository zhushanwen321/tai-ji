/**
 * Sidebar 整体 mount 测试共享 helper（sidebar-assign-project-wiring / sidebar-import-entry，
 * 范式同 sidebar-ondeletefolder.test.ts：Sidebar.vue 依赖 10+ store/composable，完整真实
 * mount 成本过高，shallowMount + store/composable mock）。
 *
 * 收敛两测试文件逐字重复的 mock 段（fallow duplication 告警）：mock 模块工厂 /
 * sidebar 动作 mock 单例收敛到本 helper 单源；vi.mock 注册留在测试文件（mock 是文件
 * 作用域，工厂经顶层 import 转发本 helper 导出——同 system-page-mount.ts 先例）。
 *
 * focusedSessionId / focusedSession 必须是真实 Vue ref（非裸 { value } 对象），否则
 * Sidebar 模板 `:active-id="focusedSessionId"` 传对象给 String|Null 子组件触发
 * "Invalid prop" 警告——真实 ref 模板自动解包为 null。
 *
 * vitest 按测试文件隔离模块图：sidebarActionMocks / toastErrorMock 单例在每个测试
 * 文件内是独立实例（文件内 mock 工厂与断言共享同一批 vi.fn）。
 */
import { ref } from 'vue'
import { vi } from 'vitest'

/** sidebar 动作 mock 集（超集：assign-project 用基础面，import-entry 走 restore/fork/handoff 扩展面）。 */
export const sidebarActionMocks = {
  selectSession: vi.fn(),
  deleteSession: vi.fn(),
  deleteFolder: vi.fn(),
  renameSession: vi.fn(),
  newSession: vi.fn(),
  goOverview: vi.fn(),
  loadSessions: vi.fn(() => Promise.resolve()),
  syncSessionToPanel: vi.fn(),
  assignSessionToProject: vi.fn(),
  restoreSession: vi.fn(),
  forkFromLastAssistant: vi.fn(),
  enterForkModeFromLastAssistant: vi.fn(),
  handoffFromLastAssistant: vi.fn(),
}

/** toast error 捕获（assign-project 失败分支断言用）。 */
export const toastErrorMock = vi.fn()

/** '@/composables/useToast' mock 工厂（error 引单例可断言，info/warning 隔离副作用）。 */
export function toastModule() {
  return {
    useToast: () => ({ error: toastErrorMock, info: vi.fn(), warning: vi.fn() }),
  }
}

/** '@/composables/features/sidebar/useSidebar' mock 工厂（真实 Vue ref，见文件头注释）。 */
export function useSidebarModule() {
  return {
    useSidebar: () => ({
      ...sidebarActionMocks,
      focusedSessionId: ref<string | null>(null),
      focusedSession: ref(null),
    }),
  }
}

/** '@/stores/sidebar' mock 工厂。 */
export function sidebarStoreModule() {
  return {
    useSidebarStore: () => ({ collapsed: false, activeTab: 'sessions', toggleCollapsed: vi.fn() }),
  }
}

/** '@/stores/session' mock 工厂。includeSetListLoadError：import-entry 走列表加载错误面。 */
export function sessionStoreModule(options: { includeSetListLoadError?: boolean } = {}) {
  return {
    useSessionStore: () => ({
      groups: [],
      list: [],
      activeId: null,
      applySnapshot: vi.fn(),
      listLoadError: null,
      ...(options.includeSetListLoadError ? { setListLoadError: vi.fn() } : {}),
    }),
  }
}

/** '@/stores/fileTree' mock 工厂。 */
export function fileTreeStoreModule() {
  return {
    useFileTreeStore: () => ({ fileCount: 0, getTree: () => null }),
  }
}

/** '@/stores/panel' mock 工厂（ref 暴露响应式属性）。 */
export function panelStoreModule() {
  return {
    usePanelStore: () => ({
      currentLeaf: { id: 'panel-root', sessionId: null },
      activePanelId: 'panel-root',
      focusedSessionId: ref<string | null>(null),
      findPanelBySession: () => null,
      loadSession: vi.fn(),
    }),
  }
}

/** '@/stores/subagent' mock 工厂。 */
export function subagentStoreModule() {
  return {
    useSubagentStore: () => ({
      recordsOf: () => ({ value: [] }),
      getRecordsBySession: () => [],
      isLoading: false,
      loadError: null,
    }),
  }
}

/** '@/stores/workflow' mock 工厂。 */
export function workflowStoreModule() {
  return {
    useWorkflowStore: () => ({
      recordsOf: () => ({ value: [] }),
      getRecordsBySession: () => [],
      isLoading: false,
      loadError: null,
      workflowCount: () => 0,
      getCurrentWorkflow: () => null,
      selectWorkflow: vi.fn(),
      backToWorkflowList: vi.fn(),
      loadWorkflows: vi.fn(() => Promise.resolve()),
      selectAgentCall: vi.fn(() => Promise.resolve()),
      backFromAgentCall: vi.fn(),
    }),
  }
}

/** '@/stores/navigation' mock 工厂。 */
export function navigationStoreModule() {
  return {
    useNavigationStore: () => ({ push: vi.fn(), current: { value: { view: 'chat' } }, stack: [] }),
  }
}

/** '@/composables/features/command/useCommandStore' mock 工厂。 */
export function commandStoreModule() {
  return {
    useCommandStore: () => ({
      appCommands: { value: [] },
      shortcutOverrides: { value: {} },
      pendingSlash: { value: null },
      clearPendingSlash: vi.fn(),
    }),
  }
}

/** '@/composables/features/chat/useChat' mock 工厂。 */
export function chatComposableModule() {
  return {
    useChat: () => ({ abort: vi.fn() }),
  }
}

/** '@/composables/features/chat/useSessionDerivations' mock 工厂。 */
export function sessionDerivationsModule() {
  return {
    useSessionDerivations: () => ({ derivedStatus: () => ({ value: 'done' }) }),
  }
}

/** '@/composables/features/chat/useListSync' mock 工厂（屏蔽 Sidebar 挂载时的列表首拉 watch）。 */
export function listSyncModule() {
  return {
    useListSync: vi.fn(),
  }
}

/** '@/composables/features/sidebar/useSidebarSubagentActions' mock 工厂。 */
export function sidebarSubagentActionsModule() {
  return {
    useSidebarSubagentActions: () => ({ onSelectSubagent: vi.fn(), onCancelSubagent: vi.fn(), onRetrySubagents: vi.fn() }),
  }
}

/** '@/composables/usePlatformShortcut' mock 工厂。 */
export function platformShortcutModule() {
  return {
    usePlatformShortcut: () => ({ formatKbd: () => '⌘K' }),
  }
}

/** '@xyz-agent/core/transport/api' mock 工厂（onMounted 的 loadSessions / app.info 订阅）。 */
export function coreTransportApiModule() {
  return {
    onGlobalType: vi.fn(() => () => {}),
    dispatchSession: vi.fn(),
    dispatchGlobal: vi.fn(),
  }
}
