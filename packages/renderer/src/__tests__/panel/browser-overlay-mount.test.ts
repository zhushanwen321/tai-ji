/**
 * BrowserOverlay 挂载测试 —— u-w2-browser-mount（display-containers §7.4 browser 复活接线，
 * S5 断言渲染侧：渲染可点 / view 定位浮层视口）。
 *
 * 覆盖：
 * - URL 注入链终点：core openBrowser(url, sessionId) → 浮层壳（wfvz-overlay）内渲染 BrowserPane
 *   （S5「渲染可点」的 DOM 面——点击链前半在 ui MarkdownRenderer ⑤路用例，后半在此）
 * - 显示收口事实源：browser:overlay-state 上报 {open, content, sessionId}，且**先于** show 请求
 *   （preload 契约「谓词事实先于 show 请求」）；关闭态同样上报
 * - view 定位浮层视口（S5）：rect 同步观测目标 = 浮层壳内 browser-vp 元素——pushRect 推送该
 *   元素 getBoundingClientRect 的 round 值（jsdom stub 单元素，断言观测对象即浮层视口）
 * - 关闭通道：closeOverlay（Esc/⌘W 走编排器的同一落点）/ 点遮罩（壳两通道之一）→ 浏览器内容
 *   卸载（browserHide keep-alive）+ 浮层 DOM 无残留
 * - 单例换内容：browser → workflow 换出时 browser 壳卸载（两壳互斥不叠显）
 *
 * mock：@/lib/ipc 全 browser 系列捕获（onBrowserState 返回 no-op 退订）；core overlay 域真身
 * （开合态 SSOT 单一权威——测试直驱 openBrowser/openOverlay/closeOverlay）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/browser-overlay-mount.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { openBrowser, openOverlay, closeOverlay, _resetOverlayForTest } from '@taiji/core/domain/overlay'
import { closeTopContainer } from '@/composables/features/app/key-orchestrator/stack-order'

// ── mock lib/ipc：browser 系列捕获（web 环境 electronAPI 缺席的等价形态）──
const mockBrowserCreate = vi.fn().mockResolvedValue(undefined)
const mockBrowserNavigate = vi.fn().mockResolvedValue(undefined)
const mockBrowserHide = vi.fn().mockResolvedValue(undefined)
const mockBrowserShow = vi.fn().mockResolvedValue(undefined)
const mockBrowserSetRect = vi.fn().mockResolvedValue(undefined)
const mockBrowserSetOverlayState = vi.fn().mockResolvedValue(undefined)
const mockOnBrowserState = vi.fn().mockReturnValue(() => {})

vi.mock('@/lib/ipc', () => ({
  browserCreate: (sessionId: string, windowId: string) => mockBrowserCreate(sessionId, windowId),
  browserNavigate: (sessionId: string, url: string) => mockBrowserNavigate(sessionId, url),
  browserHide: (sessionId: string) => mockBrowserHide(sessionId),
  browserShow: (sessionId: string) => mockBrowserShow(sessionId),
  browserBack: vi.fn().mockResolvedValue(undefined),
  browserForward: vi.fn().mockResolvedValue(undefined),
  browserSetRect: (
    sessionId: string,
    rect: { x: number; y: number; width: number; height: number },
  ) => mockBrowserSetRect(sessionId, rect),
  browserSetZoom: vi.fn().mockResolvedValue(undefined),
  browserGetZoom: vi.fn().mockResolvedValue(1.0),
  browserSetOverlayState: (state: {
    open: boolean
    content: 'browser' | 'workflow' | null
    sessionId: string | null
  }) => mockBrowserSetOverlayState(state),
  onBrowserState: (cb: unknown) => mockOnBrowserState(cb),
  openExternal: vi.fn().mockResolvedValue(undefined),
}))

import BrowserOverlay from '@/components/panel/BrowserOverlay.vue'

/** 挂载 BrowserOverlay + 开浮层浏览器内容 + 落定挂载链（onMounted → nextTick pushRect/navigate/show） */
async function mountBrowserOverlay(url = 'http://localhost:1420/', sessionId = 'sess-a') {
  const wrapper = mount(BrowserOverlay)
  openBrowser(url, sessionId)
  await nextTick()
  await nextTick()
  await nextTick()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  _resetOverlayForTest()
  // 模拟 window-factory 注入 windowId（BrowserPane onMounted fail-fast 前置）
  window.history.replaceState({}, '', '/?windowId=win-1')
})

afterEach(() => {
  _resetOverlayForTest()
  window.history.replaceState({}, '', '/')
})

describe('BrowserOverlay（BrowserPane 挂浮层壳，S5 渲染可点）', () => {
  it('openBrowser(url, 发起会话) → 浮层壳内渲染 BrowserPane（URL 注入链终点 DOM）', async () => {
    const wrapper = await mountBrowserOverlay('http://localhost:1420/', 'sess-a')
    expect(wrapper.find('[data-testid="wfvz-overlay"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-overlay-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="browser-pane"]').exists()).toBe(true)
    // 标题栏注入 URL（浮层壳标题栏 slot = 内容侧 header 信息）
    expect(wrapper.find('[data-testid="browser-overlay-title"]').text()).toContain('http://localhost:1420/')
    // BrowserPane 以发起会话为 view 键挂载（create + navigate + show 链）
    expect(mockBrowserCreate).toHaveBeenCalledWith('sess-a', expect.any(String))
    expect(mockBrowserNavigate).toHaveBeenCalledWith('sess-a', 'http://localhost:1420/')
    expect(mockBrowserShow).toHaveBeenCalledWith('sess-a')
    wrapper.unmount()
  })

  it('显示收口事实源：browser:overlay-state 上报 {open, content, sessionId} 且先于 show 请求（谓词事实先行）', async () => {
    const wrapper = await mountBrowserOverlay()
    expect(mockBrowserSetOverlayState).toHaveBeenCalledWith({
      open: true,
      content: 'browser',
      sessionId: 'sess-a',
    })
    // 契约：BrowserPane 挂载/重开前先上报（谓词事实先于 show 请求）——取 open:true 的那次上报比对
    const openReportIndex = mockBrowserSetOverlayState.mock.calls.findIndex(
      (call) => (call[0] as { open: boolean }).open === true,
    )
    expect(openReportIndex).toBeGreaterThanOrEqual(0)
    const reportOrder = mockBrowserSetOverlayState.mock.invocationCallOrder[openReportIndex]
    const showOrder = mockBrowserShow.mock.invocationCallOrder[0]
    expect(reportOrder).toBeLessThan(showOrder)
    wrapper.unmount()
  })

  it('view 定位浮层视口（S5）：rect 同步观测浮层壳内 browser-vp 元素，推其 getBoundingClientRect round 值', async () => {
    const wrapper = mount(BrowserOverlay)
    openBrowser('http://localhost:1420/', 'sess-a')
    await nextTick()
    // 单元素 stub：若观测目标不是浮层视口内 browser-vp（如旧抽屉视口），推的不是该 rect
    const vp = wrapper.find('[data-testid="browser-vp"]').element
    vi.spyOn(vp, 'getBoundingClientRect').mockReturnValue({
      x: 10.4,
      y: 20.6,
      width: 300.2,
      height: 400.8,
      top: 20.6,
      left: 10.4,
      right: 310.6,
      bottom: 421.4,
      toJSON: () => ({}),
    } as DOMRect)
    await nextTick()
    await nextTick()
    expect(mockBrowserSetRect).toHaveBeenCalledWith('sess-a', { x: 10, y: 21, width: 300, height: 401 })
    wrapper.unmount()
  })
})

describe('BrowserOverlay（关闭通道 + 单例换内容，§7.4 联动③关浮层隐藏）', () => {
  it('closeOverlay（Esc/⌘W 编排器同落点）→ 内容卸载（browserHide keep-alive）+ 关态上报 + DOM 无残留', async () => {
    const wrapper = await mountBrowserOverlay()
    expect(wrapper.find('[data-testid="browser-pane"]').exists()).toBe(true)

    closeOverlay()
    await nextTick()
    await nextTick()
    expect(wrapper.find('[data-testid="wfvz-overlay"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="browser-pane"]').exists()).toBe(false)
    expect(mockBrowserHide).toHaveBeenCalledWith('sess-a')
    expect(mockBrowserSetOverlayState).toHaveBeenLastCalledWith({
      open: false,
      content: null,
      sessionId: null,
    })
    wrapper.unmount()
  })

  it('点遮罩关闭（壳两通道之一）→ 浮层关闭、浏览器内容卸载', async () => {
    const wrapper = await mountBrowserOverlay()
    await wrapper.find('[data-testid="wfvz-overlay"]').trigger('click')
    await nextTick()
    expect(wrapper.find('[data-testid="wfvz-overlay"]').exists()).toBe(false)
    expect(mockBrowserHide).toHaveBeenCalledWith('sess-a')
    wrapper.unmount()
  })

  it('单例换内容：browser → workflow 换出时 browser 壳卸载（两壳互斥不叠显）', async () => {
    const wrapper = await mountBrowserOverlay()
    openOverlay({ kind: 'workflow', payload: { sessionId: 'sess-a', runId: 'wf-1' } })
    await nextTick()
    await nextTick()
    expect(wrapper.find('[data-testid="browser-pane"]').exists()).toBe(false)
    expect(mockBrowserHide).toHaveBeenCalledWith('sess-a')
    // 换出后主进程谓词事实同步为 workflow 内容（view 不显示）
    expect(mockBrowserSetOverlayState).toHaveBeenLastCalledWith({
      open: true,
      content: 'workflow',
      sessionId: 'sess-a',
    })
    wrapper.unmount()
  })

  it('Esc/⌘W 层级序终点（stack-order 编排器落点）：closeTopContainer 剥浮层 → 浏览器内容卸载；页面聚焦态 Esc 归页面（不入转发清单）由主进程键矩阵对账', async () => {
    const wrapper = await mountBrowserOverlay()
    // DOM 侧 Esc 路由落点 = 栈序编排器唯一属主（kind 无关直接关 core 开合态）；
    // 跨 webContents 半边（view 内焦点时 Esc 不转发、⌃`/⌘W 转发）见 browser-forward-keys.test.ts
    const closed = closeTopContainer()
    expect(closed).toBe(true)
    await nextTick()
    expect(wrapper.find('[data-testid="browser-pane"]').exists()).toBe(false)
    expect(mockBrowserHide).toHaveBeenCalledWith('sess-a')
    wrapper.unmount()
  })
})
