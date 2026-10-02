/**
 * PanelContainer 抽屉 workflow 回落内容懒加载失败占位测试（display-containers §5.3 第 2 行 ·
 * u-w2-shell 验收「回落目标失败 → AsyncErrorFallback 占位」）。
 *
 * 被测行为：WorkflowTab 是浮层装载失败回落链的目标内容（S6：render-error → 关浮层 →
 * 自动开右抽屉 workflow tab 注入选中态、无占位无重试），目标内容自身的 chunk 也可能
 * 失败（file:// chunk 404）——此时抽屉内容位必须显示 AsyncErrorFallback 占位（加载失败
 * 文案 + 重试按钮），重试按钮路由到**本挂载点**的 loader（scopedRetryFallback 作用域隔离，
 * 与 DetailPane/TerminalView 同款，见 panel-container-lazy-retry.test.ts）。
 *
 * 用户旅程（每步均有 DOM 断言 + loader 调用计数佐证）：
 * 1. 开抽屉 workflow tab，WorkflowTab chunk 首挂失败 → 抽屉内容位错误占位（无内容渲染）
 * 2. 点占位重试 → loader 重跑成功 → workflow 内容替换占位（恢复面成立）
 *
 * mock 策略：vi.mock 工厂抛错 = 动态 import reject（defineAsyncComponent onError →
 * errorComponent）；失败结果不缓存、成功结果缓存 → 本文件一个用例覆盖失败→重试成功全链
 * （探针验证过的运行时事实，见 panel-container-lazy-retry.test.ts 头注）；工厂返回带
 * [Symbol.toStringTag]:'Module' 使 defineAsyncComponent unwrap .default。其余壳层依赖
 * mock 对齐 panel-container-drawer-mode.test.ts。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/panel-container-lazy-retry-workflow.test.ts
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { computed, reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import {
  bindDrawerSessionId,
  openDrawerTab,
  _resetDrawerForTest,
} from '@taiji/core/domain/drawer'

// ── flaky 懒加载 workflow 回落内容 mock：工厂按 hoisted 计数决定失败/成功 ──
const lazy = vi.hoisted(() => ({
  workflowFailures: 0,
  workflowLoads: 0,
}))

vi.mock('@/components/panel/WorkflowTab.vue', () => {
  lazy.workflowLoads++
  if (lazy.workflowFailures > 0) {
    lazy.workflowFailures--
    throw new Error('Failed to fetch dynamically imported module')
  }
  return {
    default: { name: 'WorkflowTab', template: '<div data-testid="workflow-loaded">workflow</div>' },
    [Symbol.toStringTag]: 'Module',
  }
})

// ── 静态重面板 + 壳层组件 vi.mock（import 期替换，砍掉 PanelContainer 整图 transform；本文件
// 只开 workflow tab，以下占位组件均无断言观测面，形态对齐 drawer-mode 测试）──
vi.mock('@/components/panel/GitPanel.vue', () => ({
  default: { name: 'GitPanel', template: '<div data-testid="git-panel" />' },
}))
vi.mock('@/components/panel/CommandDocPanel.vue', () => ({
  default: { name: 'CommandDocPanel', template: '<div data-testid="doc-panel" />' },
}))
vi.mock('@/components/extension/BackgroundTaskDetailPanel.vue', () => ({
  default: { name: 'BackgroundTaskDetailPanel', template: '<div data-testid="bash-task-detail-panel" />' },
}))
vi.mock('@/components/panel/plan/PlanDocsPanel.vue', () => ({
  default: { name: 'PlanDocsPanel', template: '<div data-testid="plan-docs-panel" />' },
}))
vi.mock('@/components/panel/BtwPanel.vue', () => ({
  default: { name: 'BtwPanel', template: '<div data-testid="btw-panel" />' },
}))
vi.mock('@/components/panel/Panel.vue', () => ({
  default: {
    name: 'Panel',
    props: { panelId: String, sessionId: { type: String, default: null } },
    template: '<div data-testid="panel" :data-panel-id="panelId" />',
  },
}))
vi.mock('@/components/panel/PanelHeader.vue', () => ({
  default: { name: 'PanelHeader', template: '<div />' },
}))
vi.mock('@/components/ui/ToastContainer.vue', () => ({
  default: { name: 'ToastContainer', template: '<div />' },
}))
vi.mock('@/components/panel/trace/TraceInspector.vue', () => ({
  default: { name: 'TraceInspector', template: '<div />' },
}))
vi.mock('@/components/panel/SubagentTab.vue', () => ({
  default: { name: 'SubagentTab', template: '<div />' },
}))
vi.mock('@taiji/ui/extension-host', () => ({
  StatusBar: { name: 'StatusBar', template: '<div />' },
}))

// ── 壳层依赖 mock（对齐 panel-container-drawer-mode.test.ts）──
vi.mock('@/composables/features/file-tree/useGitStatus', () => ({
  GIT_STATUS_KEY: Symbol('git-status'),
  provideGitStatus: () => ({ indicator: { value: undefined }, state: { value: 'clean' }, lines: { value: [] } }),
}))
vi.mock('@/composables/features/chat/useSessionDerivations', () => ({
  useSessionDerivations: () => ({ derivedStatus: () => ({ value: 'done' }) }),
}))

// chatStore mock：unread watch 的消息数读取转发到响应式 Map（对齐 drawer-mode 测试）
const chatMock = vi.hoisted(() => {
  let readFn: ((sid: string) => unknown[]) | null = null
  return {
    registerReader(fn: (sid: string) => unknown[]): void {
      readFn = fn
    },
    read(sid: string): unknown[] {
      return readFn ? readFn(sid) : []
    },
  }
})
const reactiveMessages = reactive(new Map<string, unknown[]>())
vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({
    getMessages: (sid: string) => chatMock.read(sid),
  }),
}))
chatMock.registerReader((sid) => reactiveMessages.get(sid) ?? [])

async function mountContainer() {
  // 动态 import 让 vi.mock 先生效；不 mock/stub WorkflowTab 的渲染面（本测试的被测对象，
  // 其 vi.mock 工厂在文件头控制失败/成功）
  const PanelContainer = (await import('@/components/workspace/PanelContainer.vue')).default
  return mount(PanelContainer)
}

beforeEach(() => {
  setActivePinia(createPinia())
  bindDrawerSessionId(computed(() => usePanelStore().focusedSessionId))
  _resetDrawerForTest()
  reactiveMessages.clear()
  lazy.workflowFailures = 0
  lazy.workflowLoads = 0
})

// [HISTORICAL] 用例间 wrapper 必须自动 unmount（原因见 panel-container-drawer-mode.test.ts 同注释）
enableAutoUnmount(afterEach)

describe('抽屉 workflow 回落内容懒加载失败占位（display-containers §5.3 第 2 行）', () => {
  it('回落目标 chunk 失败 → 抽屉内容位 AsyncErrorFallback 占位；点重试重跑 loader 恢复内容', async () => {
    lazy.workflowFailures = 1
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 'sess-wf-lazy')
    openDrawerTab('workflow')
    const wrapper = await mountContainer()
    await flushPromises()

    // ① 回落目标 chunk 失败 → 抽屉内容位错误占位（加载失败文案 + 重试按钮，无内容渲染）
    expect(lazy.workflowLoads).toBe(1)
    expect(wrapper.find('[data-testid="drawer-area"] [data-testid="async-error-fallback"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('加载失败')
    const retry = wrapper.find('[data-testid="drawer-area"] [data-testid="async-retry-btn"]')
    expect(retry.exists()).toBe(true)
    expect(wrapper.find('[data-testid="workflow-loaded"]').exists()).toBe(false)

    // ② 占位内重试按钮重跑本挂载点 loader → 内容渲染、占位消失（恢复面成立）
    await retry.trigger('click')
    await flushPromises()
    expect(lazy.workflowLoads).toBe(2)
    expect(wrapper.find('[data-testid="workflow-loaded"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="drawer-area"] [data-testid="async-error-fallback"]').exists()).toBe(false)
  }, 60_000)
})
