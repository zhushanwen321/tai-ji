/**
 * Sidebar plugins tab 渲染测试（MF-10）。
 *
 * 验证第 5 plugin tab（本批次核心验收「tab 激活后渲染 plugin view」）：
 * - TC1: activeTab='plugins' + 有焦点 session → PluginViewContainer 挂载且
 *   sessionId 绑定焦点 session（L2 二级路由容器，内部 L2TabBar + ViewHost）
 * - TC2: activeTab='plugins' + 无焦点 session（Overview 态）→ sidebar-plugin-no-session 占位 DOM
 * - TC3: activeTab='sessions'（非 plugins）→ 不挂 PluginViewContainer（回归）
 *
 * mock 策略对齐 sidebar-ondeletefolder.test.ts 先例（Sidebar.vue 整体 mount 依赖
 * 10+ store/composable，shallowMount + store/composable mock；activeTab/focusedSessionId
 * 经 hoisted 容器注入可变 ref 控制两个用例分支）。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/sidebar/__tests__/Sidebar.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { shallowMount } from '@vue/test-utils'
import type { Ref } from 'vue'
import { PluginViewContainer } from '@xyz-agent/ui/extension-host'

// __APP_VERSION__ 是 vite define 注入的全局常量，vitest 下不存在，stub 之
vi.stubGlobal('__APP_VERSION__', '0.0.0-test')

// ── mock 容器：测试内控制 activeTab / focusedSessionId（真实 Vue ref）──
const sidebarMocks = vi.hoisted(() => ({
  selectSession: vi.fn(),
  deleteSession: vi.fn(),
  deleteFolder: vi.fn(),
  renameSession: vi.fn(),
  newSession: vi.fn(),
  goOverview: vi.fn(),
  loadSessions: vi.fn(() => Promise.resolve()),
  syncSessionToPanel: vi.fn(),
  activeTab: null as unknown as Ref<string>,
  focusedSessionId: null as unknown as Ref<string | null>,
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}))

vi.mock('@/composables/features/sidebar/useSidebar', async () => {
  const { ref } = await import('vue')
  const focusedSessionId = ref<string | null>(null)
  sidebarMocks.focusedSessionId = focusedSessionId
  return {
    useSidebar: () => ({
      ...sidebarMocks,
      focusedSessionId,
      focusedSession: ref(null),
    }),
  }
})

// ── mock stores（Sidebar setup 期读取；activeTab 可变 ref 控制 plugins tab 分支）──
vi.mock('@/stores/sidebar', async () => {
  const { ref, reactive } = await import('vue')
  const activeTab = ref<string>('sessions')
  sidebarMocks.activeTab = activeTab
  return {
    // reactive 包装：属性 ref 在模板中自动解包（裸对象属性 ref 不解包，
    // `sidebar.activeTab === 'plugins'` 判断会恒 false，plugins tab 分支不可达）
    useSidebarStore: () => reactive({ collapsed: false, activeTab, toggleCollapsed: vi.fn() }),
  }
})
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ groups: [], list: [], activeId: null, applySnapshot: vi.fn(), listLoadError: null }),
}))
vi.mock('@/stores/fileTree', () => ({
  useFileTreeStore: () => ({ fileCount: 0, getTree: () => null }),
}))
vi.mock('@/stores/panel', async () => {
  const { ref } = await import('vue')
  return {
    usePanelStore: () => ({
      currentLeaf: { id: 'panel-root', sessionId: null },
      activePanelId: 'panel-root',
      focusedSessionId: ref<string | null>(null),
      findPanelBySession: () => null,
      loadSession: vi.fn(),
    }),
  }
})
vi.mock('@/stores/subagent', () => ({
  useSubagentStore: () => ({
    recordsOf: () => ({ value: [] }),
    getRecordsBySession: () => [],
    isLoading: false,
    loadError: null,
  }),
}))
vi.mock('@/stores/workflow', () => ({
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
vi.mock('@/composables/features/chat/useChat', () => ({ useChat: () => ({ abort: vi.fn() }) }))
vi.mock('@/composables/features/chat/useSessionDerivations', () => ({
  useSessionDerivations: () => ({ derivedStatus: () => ({ value: 'done' }) }),
}))
vi.mock('@/composables/features/chat/useListSync', () => ({ useListSync: vi.fn() }))
vi.mock('@/composables/features/sidebar/useSidebarSubagentActions', () => ({
  useSidebarSubagentActions: () => ({ onSelectSubagent: vi.fn(), onCancelSubagent: vi.fn(), onRetrySubagents: vi.fn() }),
}))
vi.mock('@/composables/usePlatformShortcut', () => ({ usePlatformShortcut: () => ({ formatKbd: () => '⌘K' }) }))

// ── mock api/events（onMounted 的 loadSessions / app.info 订阅）──
vi.mock('@xyz-agent/core/transport/api', () => ({
  onGlobalType: vi.fn(() => () => {}),
  dispatchSession: vi.fn(),
  dispatchGlobal: vi.fn(),
}))

import Sidebar from '@/components/sidebar/Sidebar.vue'
import { onGlobalType } from '@xyz-agent/core/transport/api'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  sidebarMocks.activeTab.value = 'sessions'
  sidebarMocks.focusedSessionId.value = null
})

describe('Sidebar plugins tab（MF-10 渲染 gate）', () => {
  it('TC1: activeTab=plugins + 焦点 session → PluginViewContainer 挂载，sessionId 绑定焦点 session', () => {
    sidebarMocks.activeTab.value = 'plugins'
    sidebarMocks.focusedSessionId.value = 's1'
    const wrapper = shallowMount(Sidebar)

    const container = wrapper.findComponent(PluginViewContainer)
    expect(container.exists()).toBe(true)
    expect(container.props('sessionId')).toBe('s1')
    // 无焦点 session 占位不渲染
    expect(wrapper.find('[data-testid="sidebar-plugin-no-session"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('TC2: activeTab=plugins + 无焦点 session（Overview 态）→ sidebar-plugin-no-session 占位 DOM，不挂 PluginViewContainer', () => {
    sidebarMocks.activeTab.value = 'plugins'
    const wrapper = shallowMount(Sidebar)

    expect(wrapper.find('[data-testid="sidebar-plugin-no-session"]').exists()).toBe(true)
    expect(wrapper.findComponent(PluginViewContainer).exists()).toBe(false)
    wrapper.unmount()
  })

  it('TC3: 回归——activeTab=sessions 不挂 PluginViewContainer（plugins tab 独占）', () => {
    const wrapper = shallowMount(Sidebar)

    expect(wrapper.findComponent(PluginViewContainer).exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('Sidebar app.info 退订（B3 / 2026-09-14 内存审计 §2.4）', () => {
  it('TC4: onMounted 保存退订函数，onBeforeUnmount 调用——断连重挂不泄漏 handler', async () => {
    // A4 场景（kill runtime ×5 重连）：AppShell 每次重挂都会重新走 onMounted——
    // 退订函数若被丢弃，globalTypeHandlers 'app.info' 逐次累积。本用例锁定组件侧闭环。
    const unsub = vi.fn()
    vi.mocked(onGlobalType).mockReturnValueOnce(unsub)

    const wrapper = shallowMount(Sidebar)
    expect(onGlobalType).toHaveBeenCalledWith('app.info', expect.any(Function))
    expect(unsub).not.toHaveBeenCalled()

    wrapper.unmount()
    expect(unsub).toHaveBeenCalledTimes(1)
  })

  it('TC5: 重复挂卸循环对称——每次 mount 订阅一次 / unmount 退订一次（A4 场景：重连重挂后 handler 数恒 1）', () => {
    // 连接抖动模拟：5 轮 mount/unmount，退订函数逐次消费（mock 队列 5 份）
    const unsubs = Array.from({ length: 5 }, () => vi.fn())
    for (const un of unsubs) vi.mocked(onGlobalType).mockReturnValueOnce(un)

    for (let i = 0; i < 5; i++) {
      const wrapper = shallowMount(Sidebar)
      expect(unsubs[i]).not.toHaveBeenCalled()
      wrapper.unmount()
      expect(unsubs[i]).toHaveBeenCalledTimes(1)
    }
  })
})
