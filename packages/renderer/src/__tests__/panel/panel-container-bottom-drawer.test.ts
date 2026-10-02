/**
 * PanelContainer 底抽屉纵轴布局集成测试（display-containers u-w1-layout：§6.2/§7.3/§5.1）。
 *
 * 被测行为：
 * - S1 形态：底抽屉插在 split 行（对话区+右抽屉）之下、StatusBar 之上，横跨全宽（不在
 *   drawer-area 内）；terminal 搬家后在此挂载（defineAsyncComponent + LAZY_RETRY_KEY 作用域
 *   接线保留，chunk 失败占位链归 lazy-retry 测试族）
 * - S2 双容器同开：右抽屉 + 底抽屉同时可见；高度默认 35%；拖上沿调高度（写侧 clamp 15–70 +
 *   全局单键持久化）；矮窗显示期 clamp（保证对话流+composer 最小可视区）且**不写回**持久值
 * - S10 默认 git：首开右抽屉呈现 git tab（terminal 迁出后默认 activeTab 'terminal'→'git'）
 *
 * 三视角：构建者白盒（拖拽数学/写侧 clamp/KV 写穿）、使用者黑盒（开合/双开/拖拽后刷新保持/
 * 矮窗不遮对话流）、观察者形态（DOM 顺序：split 行之下、StatusBar 之上）。
 *
 * mock 策略：TerminalView/DetailPane 懒加载 mock 为轻量占位（本文件测布局与高度，chunk 失败
 * 路径归 panel-container-lazy-retry*.test.ts）；壳层依赖 mock 对齐 panel-container-drawer-mode。
 * 高度持久化走 core KV 单键（taiji:bottom-drawer-height）：platform storage 用内存 stub
 * （layout.test.ts 同款），写穿落盘可断言。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/panel-container-bottom-drawer.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { computed, nextTick, reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import {
  bindDrawerSessionId,
  openDrawerTab,
  toggleDrawer,
  _resetDrawerForTest,
} from '@taiji/core/domain/drawer'
import {
  bindBottomDrawerSessionId,
  toggleBottomDrawer,
  _resetBottomDrawerForTest,
  getBottomDrawerHeightPct,
  BOTTOM_DRAWER_HEIGHT_DEFAULT_PCT,
  BOTTOM_DRAWER_HEIGHT_KEY,
  BOTTOM_DRAWER_HEIGHT_MAX_PCT,
} from '@taiji/core/domain/bottom-drawer'
import {
  providePlatform,
  __resetPlatformForTesting,
  type KVStorage,
  type PlatformPort,
} from '@taiji/core/platform/port'

// ── 懒加载面板 mock（轻量占位，带 sessionId 透传断言面）──
vi.mock('@/components/panel/TerminalView.vue', () => ({
  default: {
    name: 'TerminalView',
    props: { sessionId: { type: String, default: null } },
    template: '<div data-testid="terminal-loaded" :data-session-id="sessionId" />',
  },
  [Symbol.toStringTag]: 'Module',
}))
vi.mock('@/components/panel/DetailPane.vue', () => ({
  default: { name: 'DetailPane', template: '<div data-testid="detail-loaded" />' },
  [Symbol.toStringTag]: 'Module',
}))

// ── 静态重面板 + 壳层组件 vi.mock（对齐 panel-container-drawer-mode.test.ts）──
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
// StatusBar mock 带 testid（布局顺序断言面：底抽屉在 status-bar 之前）
vi.mock('@taiji/ui/extension-host', () => ({
  StatusBar: { name: 'StatusBar', template: '<div data-testid="status-bar" />' },
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
  useChatStore: () => ({ getMessages: (sid: string) => chatMock.read(sid) }),
}))
chatMock.registerReader((sid) => reactiveMessages.get(sid) ?? [])

// ── KV 内存 stub（layout.test.ts 同款简化版）：peek 看落盘值，setWrites 记录写穿 ──
class StubKV implements KVStorage {
  private map = new Map<string, string>()
  setWrites: Array<[string, string]> = []
  peek(): string | undefined {
    return this.map.get(BOTTOM_DRAWER_HEIGHT_KEY)
  }
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null
  }
  async set(key: string, value: string): Promise<void> {
    this.setWrites.push([key, value])
    this.map.set(key, value)
  }
  async remove(key: string): Promise<void> {
    this.map.delete(key)
  }
}

let kv: StubKV

/** jsdom 无布局：按用例注入 pool 高度（clamp/拖拽数学基准）。mount 前安装（测量在挂载期） */
function stubPoolRect(height: number): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    return {
      width: 1000,
      height,
      top: 0,
      left: 0,
      right: 1000,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect
  })
}

/** 读取底抽屉高度 style（jsdom 不执行 CSS transition，style.height 即终态） */
function bottomHeight(wrapper: Awaited<ReturnType<typeof mountContainer>>): string {
  const style = wrapper.find('[data-testid="bottom-drawer"]').attributes('style') ?? ''
  return /height:\s*([^;]+);/.exec(style)?.[1] ?? ''
}

async function mountContainer() {
  const PanelContainer = (await import('@/components/workspace/PanelContainer.vue')).default
  // 真实 Transition（test-utils 默认 <transition-stub> 会吞掉 leave 语义——U6 收合期内容
  // 保挂载的回归锚点必须走真实 leave 路径）；enter 无 CSS 类零动画，其余用例无感
  return mount(PanelContainer, { global: { stubs: { transition: false } } })
}

beforeEach(() => {
  setActivePinia(createPinia())
  bindDrawerSessionId(computed(() => usePanelStore().focusedSessionId))
  bindBottomDrawerSessionId(computed(() => usePanelStore().focusedSessionId))
  _resetDrawerForTest()
  _resetBottomDrawerForTest()
  reactiveMessages.clear()
  localStorage.clear()
  kv = new StubKV()
  providePlatform({
    kind: 'mock',
    storage: kv,
    webSocket: { create: () => { throw new Error('unused') } },
  } as PlatformPort)
})

afterEach(() => {
  vi.restoreAllMocks()
  __resetPlatformForTesting()
})
enableAutoUnmount(afterEach)

describe('底抽屉纵轴布局（S1/S2 形态：split 行之下、StatusBar 之上、全宽）', () => {
  it('开底抽屉 → terminal 挂载于 split 行之下、StatusBar 之上，且不在 drawer-area 内（全宽）', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 'sess-bd')
    const wrapper = await mountContainer()
    toggleBottomDrawer()
    await flushPromises()

    // terminal 搬家后的新家（挂载点带 sessionId）
    const terminal = wrapper.find('[data-testid="terminal-loaded"]')
    expect(terminal.exists()).toBe(true)
    expect(terminal.attributes('data-session-id')).toBe('sess-bd')

    // 纵轴顺序（观察者形态）：split 行 → 底抽屉 → StatusBar
    const html = wrapper.html()
    expect(html.indexOf('data-testid="split-area"')).toBeLessThan(html.indexOf('data-testid="bottom-drawer"'))
    expect(html.indexOf('data-testid="bottom-drawer"')).toBeLessThan(html.indexOf('data-testid="status-bar"'))

    // 全宽：底抽屉是纵轴池的直接子项（与 split 行同级），不在 drawer-area 里
    const pool = wrapper.find('[data-testid="vertical-pool"]')
    expect(pool.exists()).toBe(true)
    expect(wrapper.find('[data-testid="drawer-area"] [data-testid="bottom-drawer"]').exists()).toBe(false)

    // 上沿拖拽手柄（role=separator，键盘可达）
    const handle = wrapper.find('[data-testid="bottom-drawer-resize-handle"]')
    expect(handle.exists()).toBe(true)
    expect(handle.attributes('role')).toBe('separator')
    expect(handle.attributes('aria-orientation')).toBe('horizontal')
  }, 60_000)

  it('S2 双容器同开：右抽屉 git + 底抽屉同时可见', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 'sess-bd-dual')
    openDrawerTab('git')
    toggleBottomDrawer()
    const wrapper = await mountContainer()
    await flushPromises()

    expect(wrapper.find('[data-testid="drawer-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="bottom-drawer"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="terminal-loaded"]').exists()).toBe(true)
  }, 60_000)

  it('S10 默认 git：首开右抽屉呈现 git tab（terminal 已迁出 L1）', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 'sess-bd-default')
    const wrapper = await mountContainer()
    toggleDrawer()
    await flushPromises()

    // 用户可见：首开右抽屉是 git 内容 + git 图标高亮
    expect(wrapper.find('[data-testid="git-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="drawer-tab-git"]').classes()).toContain('bg-surface-hover')
    expect(wrapper.find('[data-testid="drawer-tab-terminal"]').exists()).toBe(false)
  }, 60_000)

  it('收回底抽屉 → 高度回 0%；收合过渡期终端保挂载（U6），leave 结束后卸载（对话流恢复原高：split 行吃回 flex-1）', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 'sess-bd-close')
    const wrapper = await mountContainer()
    toggleBottomDrawer()
    await flushPromises()
    expect(wrapper.find('[data-testid="terminal-loaded"]').exists()).toBe(true)

    toggleBottomDrawer()
    await nextTick()
    expect(bottomHeight(wrapper)).toBe('0%')
    // [U6] 收合动画期（壳 height 过渡期）终端仍挂载——动画期空抽屉回归锚点（真实
    // Transition leave：元素带 leave-active 类保挂载，卸载时机 = leave 过渡结束）
    expect(wrapper.find('[data-testid="terminal-loaded"]').exists()).toBe(true)
    // 手柄（v-if 随开合态，不经 Transition）同帧消失
    expect(wrapper.find('[data-testid="bottom-drawer-resize-handle"]').exists()).toBe(false)

    // leave 过渡结束（测试环境无 CSS → 时长 0，双 rAF 帧后移除）：终端卸载
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="terminal-loaded"]').exists()).toBe(false)
    })
  }, 60_000)
})

describe('底抽屉高度（S2：默认 35% / 拖拽持久化 / 显示期 clamp 不写回）', () => {
  it('默认高度 35%（§7.1 裁决值）', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 'sess-bd-h-default')
    toggleBottomDrawer()
    const wrapper = await mountContainer()
    await flushPromises()

    expect(bottomHeight(wrapper)).toBe(`${BOTTOM_DRAWER_HEIGHT_DEFAULT_PCT}%`)
    expect(getBottomDrawerHeightPct()).toBe(BOTTOM_DRAWER_HEIGHT_DEFAULT_PCT)
  }, 60_000)

  it('拖上沿调高度：指针跟手改高度 + 写侧 clamp + 全局单键持久化（刷新后保持）', async () => {
    stubPoolRect(800)
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 'sess-bd-h-drag')
    toggleBottomDrawer()
    const wrapper = await mountContainer()
    await flushPromises()

    const handle = wrapper.find('[data-testid="bottom-drawer-resize-handle"]')
    await handle.trigger('pointerdown', { pointerId: 1 })
    // 拖到 y=440：高 = (800-440)/800 = 45%
    await handle.trigger('pointermove', { pointerId: 1, clientY: 440 })
    await flushPromises()
    expect(bottomHeight(wrapper)).toBe('45%')
    expect(getBottomDrawerHeightPct()).toBe(45)

    // 写侧 clamp：拖到 y=60 → 目标 92.5% → 钳到上限 70%
    await handle.trigger('pointermove', { pointerId: 1, clientY: 60 })
    await flushPromises()
    expect(bottomHeight(wrapper)).toBe(`${BOTTOM_DRAWER_HEIGHT_MAX_PCT}%`)
    expect(getBottomDrawerHeightPct()).toBe(BOTTOM_DRAWER_HEIGHT_MAX_PCT)

    await handle.trigger('pointerup', { pointerId: 1 })
    await flushPromises()
    // 持久化：全局单键落盘（同构尺寸值同粒度，§7.1）
    expect(kv.peek()).toBe(JSON.stringify(BOTTOM_DRAWER_HEIGHT_MAX_PCT))
    expect(kv.setWrites).toContainEqual([BOTTOM_DRAWER_HEIGHT_KEY, JSON.stringify(BOTTOM_DRAWER_HEIGHT_MAX_PCT)])
  }, 60_000)

  it('矮窗显示期 clamp：显示高受主区最小可视钳制，但不写回持久值（恢复高度回到拖拽值）', async () => {
    // 矮窗：pool 高 300px，主区最小可视 240px → 显示上限 (300-240)/300 = 20%
    stubPoolRect(300)
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 'sess-bd-h-clamp')
    toggleBottomDrawer()
    const wrapper = await mountContainer()
    await flushPromises()

    expect(bottomHeight(wrapper)).toBe('20%')
    // 未写回：持久值仍是默认 35，KV 无写入（恢复窗口高度后回到拖拽持久值）
    expect(getBottomDrawerHeightPct()).toBe(BOTTOM_DRAWER_HEIGHT_DEFAULT_PCT)
    expect(kv.setWrites).toEqual([])
  }, 60_000)

  it('键盘微调（separator 可达性）：ArrowUp 变高 / ArrowDown 变低', async () => {
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 'sess-bd-h-key')
    toggleBottomDrawer()
    const wrapper = await mountContainer()
    await flushPromises()

    const handle = wrapper.find('[data-testid="bottom-drawer-resize-handle"]')
    await handle.trigger('keydown', { key: 'ArrowUp' })
    await flushPromises()
    expect(getBottomDrawerHeightPct()).toBe(BOTTOM_DRAWER_HEIGHT_DEFAULT_PCT + 2)
    await handle.trigger('keydown', { key: 'ArrowDown' })
    await flushPromises()
    expect(getBottomDrawerHeightPct()).toBe(BOTTOM_DRAWER_HEIGHT_DEFAULT_PCT)
  }, 60_000)
})
