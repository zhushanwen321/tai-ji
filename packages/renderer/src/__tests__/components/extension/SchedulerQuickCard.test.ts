/**
 * SchedulerQuickCard 测试（composer 左簇定时任务快捷面板，2026-10-19 左簇浮层优化）。
 *
 * 覆盖（三视角：每条至少一个用户可见 DOM 断言）：
 * - hover 160ms 开面板 / 离开 240ms 收起（fake timers 驱动状态机）
 * - 点击 = pin（面板常驻），再点解除；pin 态离开不收起
 * - 面板数据面 = ViewHost 消费 SCHEDULER_MODAL_VIEW_ID 分区树（与 overlay 定时任务 tab
 *   同源同渲染——用户可见断言：插件推的树内容直接渲染在面板内）
 * - 底部操作条「打开定时任务面板」→ openSchedulerTab(sessionId) + 面板收起
 * - disabled（运行时灰置）hover 不开面板
 * - Esc 关闭（reka DismissableLayer 上报 update:open=false → 收起解 pin）
 *
 * 面板经 reka PopoverPortal Teleport 到 body：attachTo + document.body 查询（与
 * sidebar-assign-project 测试同范式；unmount 后清 body 防 reka 异步 DOM 残留）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/extension/SchedulerQuickCard.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import SchedulerQuickCard from '@/components/extension/SchedulerQuickCard.vue'
// 真模块顶层有 overlay 装配副作用（模块加载即 watch），整体 mock 隔离；
// SCHEDULER_MODAL_VIEW_ID 常量同源保留（ViewHost 分区键透传断言的对照值）
vi.mock('@/components/panel/workflow-viz/overlay/workflow-viz-overlay', () => ({
  openSchedulerTab: vi.fn(),
  SCHEDULER_MODAL_VIEW_ID: 'scheduler-modal',
}))
import { openSchedulerTab } from '@/components/panel/workflow-viz/overlay/workflow-viz-overlay'
import { VIEW_HOST_SOURCE_KEY, type ViewCacheEntry, type ViewHostSource } from '@taiji/ui/extension-host'

function schedulerEntry(): ViewCacheEntry {
  return {
    guiTree: [{ type: 'ansi-text', props: { lines: ['2 启用 · 1 停用 · 共 3'] } }],
  } as ViewCacheEntry
}

function makeSource(entry: ViewCacheEntry | undefined): ViewHostSource {
  return {
    getView: vi.fn((sessionId: string, viewId: string) =>
      sessionId === 's1' && viewId === 'scheduler-modal' ? entry : undefined),
    getViewIds: vi.fn(() => (entry ? ['scheduler-modal'] : [])),
  } as unknown as ViewHostSource
}

function mountCard(source: ViewHostSource, over: Record<string, unknown> = {}) {
  return mount(SchedulerQuickCard, {
    attachTo: document.body,
    props: { sessionId: 's1', badge: '3', disabled: false, testid: 'header-action-scheduler-manager-open', tooltip: '定时任务', ...over },
    global: { provide: { [VIEW_HOST_SOURCE_KEY]: source } },
  })
}

const BTN = '[data-testid="header-action-scheduler-manager-open"]'
const ANCHOR = '[data-testid="scheduler-quick-anchor"]'
const PANEL = '[data-testid="scheduler-quick-panel"]'

/** 面板在 Teleport 树（document.body）里，wrapper.find 不达——统一走 body 查询 */
function panelEl(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(PANEL)
}

/** 面板已收起：DOM 移除（reka 无过渡卸载）或 data-state='closed'（出方向过渡中，
 *  jsdom 无 CSS 动画引擎时 reka Presence 可能延迟卸载）都算收起 */
function panelClosed(): boolean {
  const el = panelEl()
  return el === null || el.dataset.state === 'closed'
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(openSchedulerTab).mockClear()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('SchedulerQuickCard（hover 快捷面板）', () => {
  it('hover 160ms 开面板，插件树内容直接渲染（与 overlay tab 同源数据同渲染）', async () => {
    const wrapper = mountCard(makeSource(schedulerEntry()))
    expect(panelEl()).toBeNull()

    await wrapper.find(ANCHOR).trigger('pointerenter')
    vi.advanceTimersByTime(159)
    await nextTick()
    expect(panelEl()).toBeNull() // 160ms 内不开
    vi.advanceTimersByTime(1)
    await nextTick()

    const panel = panelEl()
    expect(panel).not.toBeNull()
    expect(panel!.textContent).toContain('2 启用 · 1 停用 · 共 3')
    expect(wrapper.find(BTN).attributes('aria-expanded')).toBe('true')
    wrapper.unmount()
    await nextTick()
    document.body.innerHTML = ''
  })

  it('指针离开 240ms 收起；pin 态离开不收', async () => {
    const wrapper = mountCard(makeSource(schedulerEntry()))
    const anchor = () => wrapper.find(ANCHOR)

    await anchor().trigger('pointerenter')
    vi.advanceTimersByTime(160)
    await nextTick()
    expect(panelEl()).not.toBeNull()

    // 未 pin：离开 → 240ms 后收
    await anchor().trigger('pointerleave')
    vi.advanceTimersByTime(239)
    await nextTick()
    expect(panelEl()).not.toBeNull()
    vi.advanceTimersByTime(1)
    await nextTick()
    expect(panelClosed()).toBe(true)

    // pin：点击开 + 离开不收
    await wrapper.find(BTN).trigger('click')
    await nextTick()
    expect(wrapper.find(BTN).attributes('aria-pressed')).toBe('true')
    expect(panelEl()).not.toBeNull()
    await anchor().trigger('pointerleave')
    vi.advanceTimersByTime(500)
    await nextTick()
    expect(panelEl()).not.toBeNull()

    // 再点解除 pin + 收起
    await wrapper.find(BTN).trigger('click')
    await nextTick()
    expect(panelClosed()).toBe(true)
    wrapper.unmount()
    await nextTick()
    document.body.innerHTML = ''
  })

  it('disabled（运行时灰置）：hover 不开面板', async () => {
    const wrapper = mountCard(makeSource(schedulerEntry()), { disabled: true })
    await wrapper.find(ANCHOR).trigger('pointerenter')
    vi.advanceTimersByTime(300)
    await nextTick()
    expect(panelEl()).toBeNull()
    expect(wrapper.find(BTN).attributes('disabled')).toBeDefined()
    wrapper.unmount()
    await nextTick()
    document.body.innerHTML = ''
  })

  it('底部「打开定时任务面板」→ openSchedulerTab(sessionId) 且面板收起', async () => {
    const wrapper = mountCard(makeSource(schedulerEntry()))
    await wrapper.find(ANCHOR).trigger('pointerenter')
    vi.advanceTimersByTime(160)
    await nextTick()
    expect(panelEl()).not.toBeNull()

    const openBtn = panelEl()!.querySelector<HTMLButtonElement>('[data-testid="scheduler-quick-open-overlay"]')!
    expect(openBtn.textContent).toContain('打开定时任务面板')
    openBtn.click()
    await nextTick()

    expect(openSchedulerTab).toHaveBeenCalledTimes(1)
    expect(openSchedulerTab).toHaveBeenCalledWith('s1')
    expect(panelClosed()).toBe(true)
    wrapper.unmount()
    await nextTick()
    document.body.innerHTML = ''
  })

  it('Esc 关闭（reka DismissableLayer 上报 update:open=false → 收起解 pin）', async () => {
    const wrapper = mountCard(makeSource(schedulerEntry()))
    await wrapper.find(BTN).trigger('click') // pin
    await nextTick()
    expect(panelEl()).not.toBeNull()

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(panelClosed()).toBe(true)
    // pin 已解：再次 hover 走 160ms 正常路径
    await wrapper.find(ANCHOR).trigger('pointerenter')
    vi.advanceTimersByTime(160)
    await nextTick()
    expect(panelEl()).not.toBeNull()
    wrapper.unmount()
    await nextTick()
    document.body.innerHTML = ''
  })
})
