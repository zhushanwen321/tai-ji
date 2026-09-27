/**
 * PanelContainer 懒加载 retry 路由——对称方向（W31 D-8 review major-2 回归防护，第二用例）。
 *
 * 与 panel-container-lazy-retry.test.ts（terminal 方向）分文件的唯一原因：vi.mock 工厂的
 * **成功**结果跨用例缓存（失败不缓存、重 import 重跑——两文件头注释已记探针结论），同文件
 * 第二个用例的失败注入会被上一用例的成功缓存吞掉。本文件覆盖路由的 detail 侧：
 *
 * 两面板都失败后停在 detail tab（回切 remount 再失败）→ 点重试 → detail loader 重跑成功、
 * detail 内容渲染，terminal loader 未重跑。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/panel-container-lazy-retry-detail.test.ts
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { computed, nextTick, reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import {
  bindDrawerSessionId,
  openDrawerTab,
  _resetDrawerForTest,
} from '@taiji/core/domain/drawer'

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

vi.mock('@/composables/features/file-tree/useGitStatus', () => ({
  GIT_STATUS_KEY: Symbol('git-status'),
  provideGitStatus: () => ({ indicator: { value: undefined }, state: { value: 'clean' }, lines: { value: [] } }),
}))
vi.mock('@/composables/features/chat/useSessionDerivations', () => ({
  useSessionDerivations: () => ({ derivedStatus: () => ({ value: 'done' }) }),
}))
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
  _resetDrawerForTest()
  reactiveMessages.clear()
  lazy.detailFailures = 0
  lazy.detailLoads = 0
  lazy.terminalFailures = 0
  lazy.terminalLoads = 0
})

enableAutoUnmount(afterEach)

describe('PanelContainer 懒加载 retry 路由——detail 方向（major-2 回归防护）', () => {
  it('两面板失败后停在 detail tab（remount 再失败）→ 点重试重载 detail，terminal 不受影响', async () => {
    // detailFailures=2：首挂失败 1 次 + 回切 tab remount 再失败 1 次（工厂失败不缓存、重 import 重跑）
    lazy.detailFailures = 2
    lazy.terminalFailures = 1
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 'sess-lazy-detail')
    openDrawerTab('detail')
    const wrapper = await mountContainer()
    await flushPromises()

    // ① detail 首挂失败 → 错误占位（加载失败文案 + 重试按钮）
    expect(wrapper.find('[data-testid="async-error-fallback"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('加载失败')
    expect(wrapper.find('[data-testid="async-retry-btn"]').exists()).toBe(true)
    expect(lazy.detailLoads).toBe(1)

    // ② 切 terminal tab → terminal 失败 → 错误占位
    openDrawerTab('terminal')
    await nextTick()
    await flushPromises()
    expect(wrapper.find('[data-testid="async-error-fallback"]').exists()).toBe(true)
    expect(lazy.terminalLoads).toBe(1)

    // ③ 回切 detail：wrapper remount → 重 import → 第二次失败 → 错误占位仍在
    openDrawerTab('detail')
    await nextTick()
    await flushPromises()
    expect(lazy.detailLoads).toBe(2)
    expect(wrapper.find('[data-testid="async-error-fallback"]').exists()).toBe(true)

    // ④ 点 detail 占位的重试 → detail loader 第三次执行成功 → detail 内容替换占位
    await wrapper.find('[data-testid="async-retry-btn"]').trigger('click')
    await flushPromises()
    expect(lazy.detailLoads).toBe(3)
    expect(wrapper.find('[data-testid="detail-loaded"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="async-error-fallback"]').exists()).toBe(false)

    // ⑤ terminal 不受影响：detail 重试期间 terminal loader 未重跑
    expect(lazy.terminalLoads).toBe(1)
  }, 60_000)
})
