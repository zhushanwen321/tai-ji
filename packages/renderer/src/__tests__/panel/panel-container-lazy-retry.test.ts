/**
 * PanelContainer 懒加载双面板 retry 路由集成测试（W31 D-8 review major-2 回归防护）。
 *
 * 被测行为：DetailPane/TerminalView 懒加载（defineAsyncComponent）失败后，错误占位
 * （AsyncErrorFallback）的重试按钮经 LAZY_RETRY_KEY 回调必须路由到「当前激活 tab」的面板——
 * 旧实现 `if (detailRetryFn) else if (terminalRetryFn)` 在 detail 失败后（detailRetryFn 恒非
 * null、无重置路径）terminal 再失败时，terminal 占位的重试实际执行 detail 的 userRetry，
 * terminal 永久卡 error（file:// chunk 404 会同时打断两个 chunk，是设计内真实路径）。
 *
 * 用户旅程（每步均有 DOM 断言 + loader 调用计数佐证路由正确性）：
 * 1. detail tab 首挂失败 → 错误占位（加载失败文案 + 重试按钮）
 * 2. 切 terminal tab 失败 → 错误占位
 * 3. 点 terminal 占位重试 → terminal loader 重跑成功、终端内容渲染，detail loader 未重跑
 *
 * mock 策略（探针验证过的运行时事实，AGENTS.md 规则 13）：
 * - vi.mock 工厂抛错后，userRetry 重新 import 时工厂会重新执行（失败结果不缓存）；成功结果
 *   会缓存——因此**失败注入场景必须每文件一个用例**（跨用例的成功缓存使下个用例的工厂不再
 *   执行），对称方向（detail tab 重试）在 panel-container-lazy-retry-detail.test.ts。
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
import { computed, nextTick, reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import {
  bindDrawerSessionId,
  openDrawerTab,
  _resetDrawerForTest,
} from '@taiji/core/domain/drawer'

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

// Panel stub：避免主 panel 的 chat/session 依赖（本测试聚焦 drawer 懒加载路径）
const PanelStub = {
  name: 'Panel',
  props: ['panelId', 'sessionId'],
  template: '<div data-testid="panel" />',
}

async function mountContainer() {
  // 动态 import 让 vi.mock 先生效；不 stub DetailPane/TerminalView（本测试的被测对象）
  const PanelContainer = (await import('@/components/workspace/PanelContainer.vue')).default
  return mount(PanelContainer, {
    global: {
      stubs: { Panel: PanelStub },
    },
  })
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

// [HISTORICAL] 用例间 wrapper 必须自动 unmount（原因见 panel-container-drawer-mode.test.ts 同注释）
enableAutoUnmount(afterEach)

describe('PanelContainer 懒加载双面板 retry 路由（major-2 回归防护）', () => {
  it('detail 先失败、terminal 后失败 → 点 terminal 占位重试：terminal 重载渲染，detail loader 未重跑', async () => {
    lazy.detailFailures = 1
    lazy.terminalFailures = 1
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 'sess-lazy')
    openDrawerTab('detail')
    const wrapper = await mountContainer()
    await flushPromises()

    // ① detail chunk 失败 → 用户可见错误占位（加载失败文案 + 重试按钮）
    expect(wrapper.find('[data-testid="async-error-fallback"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('加载失败')
    expect(wrapper.find('[data-testid="async-retry-btn"]').exists()).toBe(true)
    expect(lazy.detailLoads).toBe(1)

    // ② 切 terminal tab → terminal chunk 失败 → 错误占位（detail 分支已卸载）
    openDrawerTab('terminal')
    await nextTick()
    await flushPromises()
    expect(wrapper.find('[data-testid="async-error-fallback"]').exists()).toBe(true)
    expect(lazy.terminalLoads).toBe(1)

    // ③ 点 terminal 占位的重试 → terminal loader 重跑成功 → 终端内容替换占位
    await wrapper.find('[data-testid="async-retry-btn"]').trigger('click')
    await flushPromises()
    expect(lazy.terminalLoads).toBe(2)
    expect(wrapper.find('[data-testid="terminal-loaded"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="async-error-fallback"]').exists()).toBe(false)

    // ④ detail 不受影响：terminal 重试期间 detail loader 未重跑（旧 bug 下 ③ 的
    //    terminal-loaded 断言会失败——重试被路由到 detailRetryFn，terminal 永久卡 error）
    expect(lazy.detailLoads).toBe(1)
  }, 60_000)
})
