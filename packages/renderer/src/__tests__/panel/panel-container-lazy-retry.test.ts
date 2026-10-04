/**
 * PanelContainer 懒加载双面板内部自动重试集成测试（W31 D-8 major-2 回归防护改造 · D6 交付后修复）。
 *
 * 2026-10-03 用户裁决：界面无重试按钮——装载失败由 createLazyChunkRetry 内部有界自动重试
 * 承接（3 次 × 300ms 递增退避；穷尽才呈现错误态，文案给「关闭重开恢复」指引）。
 *
 * 被测行为：
 * - detail（抽屉 detail tab）失败 1 次 → 内部自动重试恢复渲染，无需任何用户交互。
 * - terminal（底抽屉）持续失败 → 3 轮自动重试后穷尽 → 错误占位（无重试按钮）+ 指引文案。
 * - 双挂载点状态机独立：terminal 的多轮重试不触碰 detail 的 loader（旧「按 tab 路由」串线
 *   形态的回归防护，机制演变后断言面保留）。
 *
 * mock 策略（探针验证过的运行时事实，AGENTS.md 规则 13）：
 * - vi.mock 工厂抛错后，重试重跑 loader 时工厂会重新执行（失败结果不缓存）；成功结果会缓存
 *   ——因此**失败注入场景必须每文件一个用例**（跨用例的成功缓存使下个用例的工厂不再执行）。
 * - 工厂错误不带模块 URL（非真实装载错误形态）→ busting 分支不触发，重试走同 URL 机械路径
 *   ——loader 重跑断言等价；busting 分支由 AsyncErrorFallback.test.ts 的 helper 状态机单测覆盖。
 * - 工厂返回必须带 [Symbol.toStringTag]:'Module'，defineAsyncComponent 的 load() 依此
 *   unwrap .default（与 vite 动态 import 真实产物一致）。
 * - 禁用 vi.resetModules()：它会拆散模块身份（测试的静态 import 与 PanelContainer 重新导入的
 *   模块图变成不同实例，pinia store / drawer 单例分裂，drawer 打不开）。
 *
 * 失败未穷尽期间 wrapper 停 loading 占位（Vue userOnError 契约：链 pending → loading，
 * 非 error 态——瞬时失败不闪错误），穷尽 fail 才呈现错误占位（见 lazy-chunk-retry.ts 头注）。
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
  vi.useFakeTimers()
})

// [HISTORICAL] 用例间 wrapper 必须自动 unmount（原因见 panel-container-drawer-mode.test.ts 同注释）
enableAutoUnmount(afterEach)
afterEach(() => {
  vi.useRealTimers()
})

describe('PanelContainer 懒加载内部自动重试（D6：无界面按钮）', () => {
  it('detail 失败 1 次自动重试恢复；terminal 持续失败 3 轮后穷尽显错误态（无按钮），双挂载点互不串线', async () => {
    lazy.detailFailures = 1
    lazy.terminalFailures = 999
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 'sess-lazy')
    openDrawerTab('detail')
    openBottomDrawer()
    const wrapper = await mountContainer()
    await flushPromises()
    // delay:200 门控（defineAsyncComponent delayed ref）——fake timers 下需推进才显示 loading 占位
    await vi.advanceTimersByTimeAsync(200)
    await flushPromises()

    // ① 首挂双失败：未穷尽 → 双双停 loading 占位（非错误态），全程无重试按钮
    expect(wrapper.find('[data-testid="async-retry-btn"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="drawer-area"] [data-testid="async-loading"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="bottom-drawer"] [data-testid="async-loading"]').exists()).toBe(true)
    expect(lazy.detailLoads).toBe(1)
    expect(lazy.terminalLoads).toBe(1)

    // ② 第 1 轮退避（300ms）到点：detail 自动重试成功渲染；terminal 重试再败继续排队
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    expect(lazy.detailLoads).toBe(2)
    expect(wrapper.find('[data-testid="detail-loaded"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="drawer-area"] [data-testid="async-error-fallback"]').exists()).toBe(false)
    expect(lazy.terminalLoads).toBe(2)

    // ③ terminal 第 2/3 轮（600/900ms）递增退避重试均败 → 穷尽 → 错误占位 + 指引文案 + 无按钮
    await vi.advanceTimersByTimeAsync(600 + 900)
    await flushPromises()
    expect(lazy.terminalLoads).toBe(4)
    const terminalError = wrapper.find('[data-testid="bottom-drawer"] [data-testid="async-error-fallback"]')
    expect(terminalError.exists()).toBe(true)
    expect(wrapper.text()).toContain('加载失败')
    expect(wrapper.text()).toContain('已自动重试 3 次')
    expect(wrapper.text()).toContain('关闭后重新打开可恢复')
    expect(wrapper.find('[data-testid="async-retry-btn"]').exists()).toBe(false)

    // ④ 穷尽后不再调度：时间继续推进 loader 不重跑
    await vi.advanceTimersByTimeAsync(10_000)
    await flushPromises()
    expect(lazy.terminalLoads).toBe(4)

    // ⑤ 隔离：terminal 多轮重试期间 detail loader 未重跑（挂载点状态机独立，回归防护）
    expect(lazy.detailLoads).toBe(2)
    expect(wrapper.find('[data-testid="detail-loaded"]').exists()).toBe(true)
  }, 60_000)
})
