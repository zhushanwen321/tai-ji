/**
 * PanelContainer 懒加载双面板 retry 作用域集成测试（W31 D-8 major-2 回归防护 · display-containers 搬家后形态）。
 *
 * 被测行为：DetailPane（抽屉 detail tab）/ TerminalView（底抽屉，terminal 迁出右抽屉后的新家）
 * 懒加载（defineAsyncComponent）失败后，错误占位（AsyncErrorFallback）的重试按钮必须路由到
 * **本挂载点**的 loader——scopedRetryFallback 在各自 errorComponent 上 provide 自己的
 * LAZY_RETRY_KEY，结构性隔离；旧「按激活 tab 路由」在两 chunk 同时失败（file:// 404，设计内
 * 真实路径）时会串线，terminal 永久卡 error。
 *
 * 用户旅程（每步均有 DOM 断言 + loader 调用计数佐证路由正确性）：
 * 1. detail tab 首挂失败 → 抽屉内错误占位（加载失败文案 + 重试按钮）
 * 2. 开底抽屉 terminal 首挂失败 → 底抽屉内错误占位（两占位同时可见）
 * 3. 点底抽屉占位重试 → terminal loader 重跑成功、终端内容渲染，detail loader 未重跑
 *
 * mock 策略（探针验证过的运行时事实，AGENTS.md 规则 13）：
 * - vi.mock 工厂抛错后，userRetry 重新 import 时工厂会重新执行（失败结果不缓存）；成功结果
 *   会缓存——因此**失败注入场景必须每文件一个用例**（跨用例的成功缓存使下个用例的工厂不再
 *   执行），对称方向（detail 占位重试）在 panel-container-lazy-retry-detail.test.ts。
 * - 工厂返回必须带 [Symbol.toStringTag]:'Module'，defineAsyncComponent 的 load() 依此
 *   unwrap .default（与 vite 动态 import 真实产物一致）。
 * - 禁用 vi.resetModules()：它会拆散模块身份（测试的静态 import 与 PanelContainer 重新导入的
 *   模块图变成不同实例，pinia store / drawer 单例分裂，drawer 打不开）。
 * - 其余壳层依赖 mock 对齐 panel-container-drawer-mode.test.ts。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/panel-container-lazy-retry.test.ts
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
import {
  bindBottomDrawerSessionId,
  openBottomDrawer,
  _resetBottomDrawerForTest,
} from '@taiji/core/domain/bottom-drawer'

// ── flaky 懒加载面板 mock：工厂按 hoisted 计数决定失败/成功（vi.hoisted 使工厂可引用）──
const lazy = vi.hoisted(() => ({
  detailFailures: 0,
  detailLoads: 0,
  terminalFailures: 0,
  terminalLoads: 0,
}))

vi.mock('@/components/panel/DetailPane.vue', () => {
  lazy.detailLoads++
  if (lazy.detailFailures > 0) {
    lazy.detailFailures--
    throw new Error('Failed to fetch dynamically imported module')
  }
  return {
    default: { name: 'DetailPane', template: '<div data-testid="detail-loaded">detail</div>' },
    [Symbol.toStringTag]: 'Module',
  }
})
vi.mock('@/components/panel/TerminalView.vue', () => {
  lazy.terminalLoads++
  if (lazy.terminalFailures > 0) {
    lazy.terminalFailures--
    throw new Error('Failed to fetch dynamically imported module')
  }
  return {
    default: { name: 'TerminalView', template: '<div data-testid="terminal-loaded">terminal</div>' },
    [Symbol.toStringTag]: 'Module',
  }
})

// ── 静态重面板 + 壳层组件 vi.mock（import 期替换，砍掉 PanelContainer 整图 transform；本文件
// 只开 detail/terminal tab，以下占位组件均无断言观测面，形态对齐 drawer-mode 测试。StatusBar
// 来自 @taiji/ui/extension-host，mock 路径须与 PanelContainer 的 import 说明符一致）──
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
vi.mock('@/components/panel/WorkflowTab.vue', () => ({
  default: { name: 'WorkflowTab', template: '<div />' },
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
  // 动态 import 让 vi.mock 先生效；不 mock/stub DetailPane/TerminalView 的渲染面（本测试的被测对象，
  // 两者的 vi.mock 工厂在文件头控制失败/成功）
  const PanelContainer = (await import('@/components/workspace/PanelContainer.vue')).default
  return mount(PanelContainer)
}

beforeEach(() => {
  setActivePinia(createPinia())
  bindDrawerSessionId(computed(() => usePanelStore().focusedSessionId))
  bindBottomDrawerSessionId(computed(() => usePanelStore().focusedSessionId))
  _resetDrawerForTest()
  _resetBottomDrawerForTest()
  reactiveMessages.clear()
  lazy.detailFailures = 0
  lazy.detailLoads = 0
  lazy.terminalFailures = 0
  lazy.terminalLoads = 0
})

// [HISTORICAL] 用例间 wrapper 必须自动 unmount（原因见 panel-container-drawer-mode.test.ts 同注释）
enableAutoUnmount(afterEach)

describe('PanelContainer 懒加载双面板 retry 作用域隔离（major-2 回归防护）', () => {
  it('detail + terminal 同时失败 → 点底抽屉 terminal 占位重试：terminal 重载渲染，detail loader 未重跑', async () => {
    lazy.detailFailures = 1
    lazy.terminalFailures = 1
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 'sess-lazy')
    openDrawerTab('detail')
    openBottomDrawer()
    const wrapper = await mountContainer()
    await flushPromises()

    // ① 两个挂载点 chunk 同时失败 → 各自错误占位（加载失败文案 + 重试按钮）同时可见
    expect(wrapper.findAll('[data-testid="async-error-fallback"]')).toHaveLength(2)
    expect(wrapper.text()).toContain('加载失败')
    expect(wrapper.find('[data-testid="bottom-drawer"] [data-testid="async-retry-btn"]').exists()).toBe(true)
    expect(lazy.detailLoads).toBe(1)
    expect(lazy.terminalLoads).toBe(1)

    // ② 点底抽屉 terminal 占位的重试 → terminal loader 重跑成功 → 终端内容替换占位
    await wrapper.find('[data-testid="bottom-drawer"] [data-testid="async-retry-btn"]').trigger('click')
    await flushPromises()
    expect(lazy.terminalLoads).toBe(2)
    expect(wrapper.find('[data-testid="terminal-loaded"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="bottom-drawer"] [data-testid="async-error-fallback"]').exists()).toBe(false)

    // ③ detail 不受影响：terminal 重试期间 detail loader 未重跑（作用域隔离；旧「按 tab 路由」
    //    下会串线——terminal 永久卡 error）
    expect(lazy.detailLoads).toBe(1)
    expect(wrapper.find('[data-testid="drawer-area"] [data-testid="async-error-fallback"]').exists()).toBe(true)
  }, 60_000)
})
