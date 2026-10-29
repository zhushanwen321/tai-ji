/**
 * PanelContainer 懒加载内部自动重试——detail 方向 + 「关闭重开 = 全新一轮」恢复出路
 * （W31 D-8 major-2 回归防护改造 · D6 交付后修复）。
 *
 * 2026-10-03 用户裁决的恢复出路：内部重试穷尽呈现错误态后，「关闭后重新打开」必须重置
 * 计数获得全新一轮自动重试（重开抽屉 → 挂载点 v-if 重挂 → fresh mount 清零）。
 *
 * 与 panel-container-lazy-retry.test.ts（terminal 方向）分文件的唯一原因：vi.mock 工厂的
 * **成功**结果跨用例缓存（失败不缓存、重 import 重跑），同文件第二个用例的失败注入会被
 * 上一用例的成功缓存吞掉。本文件 detail 持续失败（穷尽 + 重开新一轮），不注入成功。
 *
 * 运行：cd packages/renderer && TAIJI_TEST_DOMAIN=panel npx vitest run src/__tests__/panel/panel-container-lazy-retry-detail.test.ts（本文件登记在 domain-map.json panel 域，默认档被排除）
 */
import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { computed, nextTick, reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import {
  bindDrawerSessionId,
  openDrawerTab,
  setDrawerTab,
  _resetDrawerForTest,
} from '@taiji/core/domain/drawer'
import {
  bindBottomDrawerSessionId,
  openBottomDrawer,
  _resetBottomDrawerForTest,
} from '@taiji/core/domain/bottom-drawer'
import type { SessionGroup, SessionSummary } from '@taiji/shared'
import { createSessionLiveState, createSessionLiveStateSelector, createSessionStore } from '@taiji/core'

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
// 只开 detail/terminal tab，以下占位组件均无断言观测范围，形态对齐 drawer-mode 测试。
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
vi.mock('@taiji/ui/extension-host', () => ({
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

// 模块图文件级预热（vi.mock 工厂经 hoisting 先于本 import 注册，mock 语义不变）：
// PanelContainer 整图 transform 是单用例 3.38s 的主因，移进 beforeAll 后用例只付 mount
// 成本；懒加载 DetailPane/TerminalView 的 vi.mock 工厂不在静态图内（defineAsyncComponent
// 渲染期才触发），lazy.* 计数不受预热影响。
let PanelContainer: (typeof import('@/components/workspace/PanelContainer.vue'))['default']

beforeAll(async () => {
  PanelContainer = (await import('@/components/workspace/PanelContainer.vue')).default
})

async function mountContainer() {
  // 不 mock/stub DetailPane/TerminalView 的渲染范围（本测试的被测对象，两者的 vi.mock
  // 工厂在文件头控制失败/成功）
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

describe('PanelContainer 懒加载内部自动重试——detail 方向（重开 = 全新一轮）', () => {
  it('detail 持续失败穷尽显错误态 → 关抽屉重开 → 计数重置获得全新一轮自动重试', async () => {
    lazy.detailFailures = 999
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 'sess-lazy-detail')
    openDrawerTab('detail')
    const wrapper = await mountContainer()
    await flushPromises()
    // delay:200 门控（defineAsyncComponent delayed ref）——fake timers 下需推进才显示 loading 占位
    await vi.advanceTimersByTimeAsync(200)
    await flushPromises()

    // ① 首挂失败：loading 占位（未穷尽非错误态），无重试按钮
    expect(wrapper.find('[data-testid="drawer-area"] [data-testid="async-loading"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="async-retry-btn"]').exists()).toBe(false)

    // ② 3 轮退避重试（300/600/900ms）均败 → 穷尽 → 错误占位 + 指引文案（4 = 首载 + 3 轮重试）
    await vi.advanceTimersByTimeAsync(300 + 600 + 900)
    await flushPromises()
    expect(lazy.detailLoads).toBe(4)
    expect(wrapper.find('[data-testid="drawer-area"] [data-testid="async-error-fallback"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('已自动重试 3 次')
    expect(wrapper.find('[data-testid="async-retry-btn"]').exists()).toBe(false)

    // ③ 关抽屉（回切 git tab）再重开 detail：fresh mount 计数清零 → 静态重跑（第 5 次 load）
    //    ——「关闭后重新打开可恢复」的出路语义（错误态被新一轮 loading 替换）
    setDrawerTab('git')
    await nextTick()
    await flushPromises()
    setDrawerTab('detail')
    await nextTick()
    await flushPromises()
    expect(lazy.detailLoads).toBe(5)
    expect(wrapper.find('[data-testid="drawer-area"] [data-testid="async-error-fallback"]').exists()).toBe(false)
    // delay:200 门控：fresh wrapper 的 loading 占位需推进 delay 窗口后才渲染
    await vi.advanceTimersByTimeAsync(200)
    await flushPromises()
    expect(wrapper.find('[data-testid="drawer-area"] [data-testid="async-loading"]').exists()).toBe(true)

    // ④ 新一轮第 1 次重试按 300ms 基准调度（若计数未重置则为 600ms 不触发）→ 触发即证重置
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    expect(lazy.detailLoads).toBe(6)

    // ⑤ terminal 挂载点未开未加载（本文件不触底抽屉）
    expect(lazy.terminalLoads).toBe(0)
  })
})

// ══════════ 来源：live-state-selector.test.ts ══════════
{
  function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
      label: overrides.id,
      cwd: '/work/a',
      status: 'idle',
      lastActiveAt: 0,
      ...overrides,
    }
  }

  function group(cwd: string, sessions: SessionSummary[]): SessionGroup {
    return { cwd, sessions }
  }

  const MAIN = 'main-s1'
  const LINE = 'pi-line-1' // 线 session id（W4a 后 = pi 真实 id）

  function makeFixture() {
    const live = createSessionLiveState()
    const nav = createSessionStore()
    nav.applySnapshot({
      groups: [
        group('/work/a', [makeSession({ id: MAIN })]),
      ],
    })
    const getSessionState = createSessionLiveStateSelector(live)
    return { live, nav, getSessionState }
  }

  describe('composer 状态层选择器（验收项 2：列表外会话状态写入后 composer 可见）', () => {
    it('列表外会话 id 写入状态层 → 选择器可读（与主会话同一入口）', () => {
      const f = makeFixture()
      f.live.applyLiveState(LINE, { modelId: 'p/line', thinkingLevel: 'low' })

      expect(f.getSessionState(LINE)).toEqual({ modelId: 'p/line', thinkingLevel: 'low' })
      // 侧栏列表不含该 id（列表是导航视图，不因状态写入变化）
      expect(f.nav.list.value.map((s) => s.id)).toEqual([MAIN])
    })

    it('缓存缺失 → undefined（显式未知，禁止回退到主会话值）', () => {
      const f = makeFixture()
      f.live.applyLiveState(MAIN, { modelId: 'p/main', thinkingLevel: 'high' })

      // 线未写入任何状态：不得拿主会话当前值猜（设计 §2.4 I5）
      expect(f.getSessionState(LINE)).toBeUndefined()
    })

    it('线内切换不影响主会话，主会话切换不影响线（验收项 7）', () => {
      const f = makeFixture()
      f.live.applyLiveState(MAIN, { modelId: 'p/main-a', thinkingLevel: 'high' })
      f.live.applyLiveState(LINE, { modelId: 'p/line-a', thinkingLevel: 'low' })

      // 线内切换
      f.live.applyLiveState(LINE, { modelId: 'p/line-b' })
      expect(f.getSessionState(MAIN)).toEqual({ modelId: 'p/main-a', thinkingLevel: 'high' })
      expect(f.getSessionState(LINE)).toEqual({ modelId: 'p/line-b', thinkingLevel: 'low' })

      // 主会话切换
      f.live.applyLiveState(MAIN, { modelId: 'p/main-b', thinkingLevel: 'max' })
      expect(f.getSessionState(LINE)).toEqual({ modelId: 'p/line-b', thinkingLevel: 'low' })
      expect(f.getSessionState(MAIN)).toEqual({ modelId: 'p/main-b', thinkingLevel: 'max' })
    })
  })

  describe('导航列表变化不触碰状态层（验收项 3）', () => {
    it('整表刷新 / 归档 / 项目过滤后选择器输出不变', () => {
      const f = makeFixture()
      const other = makeSession({ id: 'other', cwd: '/work/b' })
      f.live.applyLiveState(MAIN, { modelId: 'p/main', thinkingLevel: 'high' })
      f.live.applyLiveState('other', { modelId: 'p/other' })

      // 整表刷新（加入 other）
      f.nav.applySnapshot({ groups: [group('/work/a', [makeSession({ id: MAIN })]), group('/work/b', [other])] })
      expect(f.getSessionState(MAIN)).toEqual({ modelId: 'p/main', thinkingLevel: 'high' })
      expect(f.getSessionState('other')).toEqual({ modelId: 'p/other' })

      // 归档（other 从列表消失）
      f.nav.applySnapshot({ groups: [group('/work/a', [makeSession({ id: MAIN })])] })
      expect(f.nav.list.value.map((s) => s.id)).toEqual([MAIN])
      expect(f.getSessionState('other')).toEqual({ modelId: 'p/other' })

      // 项目过滤（只剩 b 组：main 不在列表）
      f.nav.applySnapshot({ groups: [group('/work/b', [other])] })
      expect(f.getSessionState(MAIN)).toEqual({ modelId: 'p/main', thinkingLevel: 'high' })
    })
  })
}
