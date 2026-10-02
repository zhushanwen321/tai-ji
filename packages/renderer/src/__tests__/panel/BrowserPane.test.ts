/**
 * BrowserPane 组件最小 mount 测试（Browser Drawer Wave 2 + Wave 3）。
 *
 * 覆盖：
 * - mount 后 [data-testid=browser-pane] 存在（组件根渲染）
 * - 有 url 时显 loading 态（isLoading 初始 true，等主进程 did-stop-loading 推 false）
 * - 无 url 时显空态（Globe icon + 文案）
 * - reload / openInExternal 触发对应 IPC（mock 捕获）
 *
 * Wave 3：
 * - navigate/show 被移入 onMounted 的 nextTick（先 pushRect 再 navigate+show），
 *   断言需 await wrapper.vm.$nextTick() 才能捕获。
 * - pushRect 在 nextTick 调 browserSetRect，mock 工厂必须导出 browserSetRect 否则抛错中断 nextTick 回调。
 * - rect 不乘 dpr：mount 后 browserSetRect 收到 getBoundingClientRect 的 round 值（jsdom 固定 0，故仅验证不抛错 + 被调用）。
 *
 * mock 策略：vi.mock('@/lib/ipc') 捕获 browserCreate/Navigate/Hide/Show/SetRect + onBrowserState（返回 no-op 退订），
 *            openExternal 捕获外链导出。useI18n 经 vitest-i18n-setup 全局注入。
 *
 * display-containers 修复组 B 补测：
 * - §6.7 先行档对账（真实事件序）：地址栏编辑态 Esc 消费即 preventDefault → 模拟编排器
 *   （window bubble + defaultPrevented 检查）不动作；非编辑态 Esc 不拦 → 编排器照常动作
 * - U5：retryCreate windowId 缺失 → 结构化 warn（口径对齐 onMounted）+ 不调 browserCreate
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/panel/BrowserPane.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

// ── mock lib/ipc：捕获 browser 系列 + onBrowserState（返回 no-op 退订）+ openExternal ──
const mockBrowserCreate = vi.fn().mockResolvedValue(undefined)
const mockBrowserNavigate = vi.fn().mockResolvedValue(undefined)
const mockBrowserHide = vi.fn().mockResolvedValue(undefined)
const mockBrowserShow = vi.fn().mockResolvedValue(undefined)
const mockBrowserBack = vi.fn().mockResolvedValue(undefined)
const mockBrowserForward = vi.fn().mockResolvedValue(undefined)
const mockBrowserSetRect = vi.fn().mockResolvedValue(undefined)
const mockBrowserSetZoom = vi.fn().mockResolvedValue(undefined)
const mockBrowserGetZoom = vi.fn().mockResolvedValue(1.0)
const mockOnBrowserState = vi.fn().mockReturnValue(() => {})
const mockOpenExternal = vi.fn().mockResolvedValue(undefined)

vi.mock('@/lib/ipc', () => ({
  browserCreate: (sessionId: string, windowId: string) => mockBrowserCreate(sessionId, windowId),
  browserNavigate: (sessionId: string, url: string) => mockBrowserNavigate(sessionId, url),
  browserHide: (sessionId: string) => mockBrowserHide(sessionId),
  browserShow: (sessionId: string) => mockBrowserShow(sessionId),
  browserBack: (sessionId: string) => mockBrowserBack(sessionId),
  browserForward: (sessionId: string) => mockBrowserForward(sessionId),
  browserSetRect: (
    sessionId: string,
    rect: { x: number; y: number; width: number; height: number },
  ) => mockBrowserSetRect(sessionId, rect),
  browserSetZoom: (sessionId: string, factor: number) => mockBrowserSetZoom(sessionId, factor),
  browserGetZoom: (sessionId: string) => mockBrowserGetZoom(sessionId),
  onBrowserState: (cb: unknown) => mockOnBrowserState(cb),
  openExternal: (url: string) => mockOpenExternal(url),
}))

import BrowserPane from '@/components/panel/BrowserPane.vue'

function mountPane(props: { sessionId?: string; url?: string } = {}) {
  return mount(BrowserPane, {
    props: { sessionId: props.sessionId ?? 'sess-1', url: props.url ?? '' },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  // [W4] 模拟 window-factory 注入的 windowId。jsdom 默认 window.location.search 为空，
  // 如不设置，BrowserPane.vue:onMounted 的 W4 fail-fast 会跳过 browserCreate，
  // 打破现有测试断言。为不破坏现有契约，pre-注入一个默认 windowId。
  // 缺 windowId 场景由专属测试负责。
  window.history.replaceState({}, '', '/?windowId=win-1')
})

afterEach(() => {
  // 还原 location.search，避免跨测试串扰
  window.history.replaceState({}, '', '/')
})

describe('BrowserPane（Wave 2 + Wave 3）', () => {
  it('mount 后渲染 [data-testid=browser-pane] 根节点', () => {
    const wrapper = mountPane({ url: 'https://example.com' })
    expect(wrapper.find('[data-testid="browser-pane"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('windowId 缺失 fail-fast（PR #100 W4）：不调 browserCreate，不拋错', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 清除 beforeEach 注入的 windowId
    window.history.replaceState({}, '', '/')
    const wrapper = mountPane({ url: 'https://example.com' })
    expect(mockBrowserCreate).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('windowId missing'))
    warnSpy.mockRestore()
    wrapper.unmount()
  })

  it('有 url 时 onMounted（nextTick 内）调 browserCreate + browserNavigate + browserShow', async () => {
    const wrapper = mountPane({ url: 'https://example.com' })
    // Wave 3：create 在 onMounted 同步调，navigate/show 在 nextTick 内（先 pushRect 再 navigate+show）。
    expect(mockBrowserCreate).toHaveBeenCalledWith('sess-1', expect.any(String))
    // 等 nextTick 回调执行（pushRect → navigate → show）
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(mockBrowserNavigate).toHaveBeenCalledWith('sess-1', 'https://example.com')
    expect(mockBrowserShow).toHaveBeenCalledWith('sess-1')
    // 订阅 onBrowserState
    expect(mockOnBrowserState).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('有 url 时显 loading 态（isLoading 初始 true）', () => {
    const wrapper = mountPane({ url: 'https://example.com' })
    expect(wrapper.find('[data-testid="browser-loading"]').exists()).toBe(true)
    // 地址栏 input value 显示传入 url（防钓鱼：主进程 did-navigate 后回填真实 URL）
    const urlInput = wrapper.find('[data-testid="browser-urlbar-input"]').element as HTMLInputElement
    expect(urlInput.value).toContain('https://example.com')
    wrapper.unmount()
  })

  it('无 url 时显空态（不调 navigate/show）', () => {
    const wrapper = mountPane({ url: '' })
    expect(wrapper.find('[data-testid="browser-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="browser-loading"]').exists()).toBe(false)
    expect(mockBrowserNavigate).not.toHaveBeenCalled()
    expect(mockBrowserShow).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('onBeforeUnmount 调 browserHide（keep-alive 不 destroy）', () => {
    const wrapper = mountPane({ url: 'https://example.com' })
    wrapper.unmount()
    expect(mockBrowserHide).toHaveBeenCalledWith('sess-1')
  })

  it('点外链导出按钮 → openExternal(displayUrl)', async () => {
    const wrapper = mountPane({ url: 'https://example.com' })
    await wrapper.find('[data-testid="browser-open-external"]').trigger('click')
    expect(mockOpenExternal).toHaveBeenCalledWith('https://example.com')
    wrapper.unmount()
  })
})

describe('BrowserPane（Wave 5 导航 + 安全）', () => {
  it('back/forward 按钮初始 disabled（canGoBack/canGoForward=false）', () => {
    const wrapper = mountPane({ url: 'https://example.com' })
    expect(wrapper.find('[data-testid="browser-back"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="browser-forward"]').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('点 back 按钮（canGoBack=true 后）→ browserBack(sessionId)', async () => {
    const wrapper = mountPane({ url: 'https://example.com' })
    const stateCb = mockOnBrowserState.mock.calls[0][0] as (s: {
      sessionId: string; currentUrl: string; isLoading: boolean
      error: { errorCode: number; errorDescription: string; validatedURL: string } | null
      canGoBack: boolean; canGoForward: boolean
    }) => void
    // 推 canGoBack=true 启用 back 按钮
    stateCb({ sessionId: 'sess-1', currentUrl: 'https://example.com', isLoading: false, error: null, canGoBack: true, canGoForward: false })
    await wrapper.vm.$nextTick()
    await wrapper.find('[data-testid="browser-back"]').trigger('click')
    expect(mockBrowserBack).toHaveBeenCalledWith('sess-1')
    wrapper.unmount()
  })

  it('点 forward 按钮（canGoForward=true 后）→ browserForward(sessionId)', async () => {
    const wrapper = mountPane({ url: 'https://example.com' })
    const stateCb = mockOnBrowserState.mock.calls[0][0] as (s: {
      sessionId: string; currentUrl: string; isLoading: boolean
      error: { errorCode: number; errorDescription: string; validatedURL: string } | null
      canGoBack: boolean; canGoForward: boolean
    }) => void
    stateCb({ sessionId: 'sess-1', currentUrl: 'https://example.com', isLoading: false, error: null, canGoBack: false, canGoForward: true })
    await wrapper.vm.$nextTick()
    await wrapper.find('[data-testid="browser-forward"]').trigger('click')
    expect(mockBrowserForward).toHaveBeenCalledWith('sess-1')
    wrapper.unmount()
  })

  it('点复制按钮 → navigator.clipboard.writeText(url)', async () => {
    const writeTextSpy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    const wrapper = mountPane({ url: 'https://example.com' })
    await wrapper.find('[data-testid="browser-copy-url"]').trigger('click')
    expect(writeTextSpy).toHaveBeenCalledWith('https://example.com')
    writeTextSpy.mockRestore()
    wrapper.unmount()
  })

  it('登录墙检测：401 errorCode → 显提示条', async () => {
    // 拿到 onBrowserState 的 callback，模拟主进程推 401 错误
    const wrapper = mountPane({ url: 'https://example.com' })
    const stateCb = mockOnBrowserState.mock.calls[0][0] as (s: {
      sessionId: string
      currentUrl: string
      isLoading: boolean
      error: { errorCode: number; errorDescription: string; validatedURL: string } | null
      canGoBack: boolean
      canGoForward: boolean
    }) => void
    // 初始无提示条
    expect(wrapper.find('[data-testid="browser-login-wall"]').exists()).toBe(false)
    // 推 401 错误
    stateCb({
      sessionId: 'sess-1',
      currentUrl: 'https://example.com/login',
      isLoading: false,
      error: { errorCode: 401, errorDescription: 'Unauthorized', validatedURL: 'https://example.com' },
      canGoBack: false,
      canGoForward: false,
    })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="browser-login-wall"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('地址栏输入 URL 回车 → browserNavigate（补全 https://）', async () => {
    const wrapper = mountPane({ url: 'https://example.com' })
    mockBrowserNavigate.mockClear()
    const input = wrapper.find('[data-testid="browser-urlbar-input"]')
    await input.setValue('github.com')
    await input.trigger('keydown', { key: 'Enter' })
    // 裸域名补全 https:// 前缀
    expect(mockBrowserNavigate).toHaveBeenCalledWith('sess-1', 'https://github.com')
    wrapper.unmount()
  })

  it('地址栏输入完整 URL 回车 → browserNavigate（不重复补全）', async () => {
    const wrapper = mountPane({ url: 'https://example.com' })
    mockBrowserNavigate.mockClear()
    const input = wrapper.find('[data-testid="browser-urlbar-input"]')
    await input.setValue('http://foo.bar/baz')
    await input.trigger('keydown', { key: 'Enter' })
    expect(mockBrowserNavigate).toHaveBeenCalledWith('sess-1', 'http://foo.bar/baz')
    wrapper.unmount()
  })
})

describe('BrowserPane（错误通道，display-containers §5.3 两类占位区分）', () => {
  it('browserCreate reject → 「创建失败」占位（与页面加载失败占位区分，带原因 + 重试/外链出口）', async () => {
    mockBrowserCreate.mockRejectedValueOnce(new Error('window gone'))
    const wrapper = mountPane({ url: 'https://example.com' })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="browser-create-error"]').exists()).toBe(true)
    // 两类占位互斥：加载失败占位不出现
    expect(wrapper.find('[data-testid="browser-error"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('window gone')
    wrapper.unmount()
  })

  it('创建失败占位内点重试 → 重新 create + navigate + show（§5.3 恢复路径）', async () => {
    mockBrowserCreate.mockRejectedValueOnce(new Error('window gone'))
    const wrapper = mountPane({ url: 'https://example.com' })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    mockBrowserCreate.mockClear()
    mockBrowserNavigate.mockClear()
    mockBrowserShow.mockClear()
    await wrapper.find('[data-testid="browser-create-error"] button').trigger('click')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(mockBrowserCreate).toHaveBeenCalledWith('sess-1', expect.any(String))
    expect(mockBrowserNavigate).toHaveBeenCalledWith('sess-1', 'https://example.com')
    expect(mockBrowserShow).toHaveBeenCalledWith('sess-1')
    expect(wrapper.find('[data-testid="browser-create-error"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('render-process-gone（processGone 推送）→ 「创建失败/进程崩溃」占位；存活推送恢复后清占位', async () => {
    const wrapper = mountPane({ url: 'https://example.com' })
    const stateCb = mockOnBrowserState.mock.calls[0][0] as (s: Record<string, unknown>) => void
    stateCb({
      sessionId: 'sess-1',
      currentUrl: 'https://example.com',
      isLoading: false,
      error: null,
      processGone: { reason: 'crashed' },
      canGoBack: false,
      canGoForward: false,
      zoomFactor: 1,
    })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="browser-create-error"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('crashed')
    // 进程恢复（存活推送 processGone=null）→ 清占位
    stateCb({
      sessionId: 'sess-1',
      currentUrl: 'https://example.com',
      isLoading: false,
      error: null,
      processGone: null,
      canGoBack: false,
      canGoForward: false,
      zoomFactor: 1,
    })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="browser-create-error"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

// ── display-containers 修复组 B：§6.7 先行档对账 + retryCreate 口径（U3/U5）────

describe('BrowserPane（display-containers §6.7 地址栏 Esc 先行档对账）', () => {
  /** 模拟 Esc 栈序编排器（window bubble + defaultPrevented 守卫，§6.7 规格最小化） */
  function attachOrchestrator(decisions: string[]): () => void {
    const onOrchestratorKeydown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      decisions.push(e.defaultPrevented ? 'skip-prevented' : 'act')
    }
    window.addEventListener('keydown', onOrchestratorKeydown)
    return () => window.removeEventListener('keydown', onOrchestratorKeydown)
  }

  function escEvent(): KeyboardEvent {
    return new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  }

  it('编辑态 Esc：消费即 preventDefault → 编排器不动作（双动作击穿防御：不弃编辑关浮层）+ 回填放弃', async () => {
    // attachTo：真实冒泡路径（Input → document → window）必需——detached 树冒泡不达 window
    const wrapper = mount(BrowserPane, {
      props: { sessionId: 'sess-1', url: 'https://example.com' },
      attachTo: document.body,
    })
    await wrapper.vm.$nextTick()
    const decisions: string[] = []
    const detach = attachOrchestrator(decisions)

    // 聚焦地址栏 → 进入编辑态（与真实使用路径一致），输入未确认地址
    const input = wrapper.find('[data-testid="browser-urlbar-input"]')
    await input.trigger('focus')
    await input.setValue('github.com')
    expect((input.element as HTMLInputElement).value).toBe('github.com')

    mockBrowserNavigate.mockClear()
    // 真实事件序：Esc 从 Input 元素冒泡到 window（元素级监听先于编排器）
    const evt = escEvent()
    input.element.dispatchEvent(evt)

    // 先行档契约：消费即 preventDefault → 编排器让位（浮层不关）
    expect(evt.defaultPrevented, '编辑态消费必须 preventDefault').toBe(true)
    expect(decisions, '编排器不动作：只弃编辑不关浮层').toEqual(['skip-prevented'])
    // 防钓鱼回填：不导航到未确认输入（DOM 回填走 Vue 响应式 flush）
    await wrapper.vm.$nextTick()
    expect((input.element as HTMLInputElement).value, '回填真实 URL').toBe('https://example.com')
    expect(mockBrowserNavigate, 'Esc 不触发导航').not.toHaveBeenCalled()

    detach()
    document.body.innerHTML = ''
    wrapper.unmount()
  })

  it('非编辑态 Esc 不拦：编排器照常走层级序（行为分界——Esc 归容器栈序）', async () => {
    const wrapper = mountPane({ url: 'https://example.com' })
    await wrapper.vm.$nextTick()
    const decisions: string[] = []
    const detach = attachOrchestrator(decisions)

    // 焦点不在地址栏（未聚焦 = 非编辑态）：元素级监听不消费，事件直达 window bubble
    const evt = escEvent()
    window.dispatchEvent(evt)
    expect(evt.defaultPrevented, '非编辑态不拦').toBe(false)
    expect(decisions, '编排器照常动作（关浮层）').toEqual(['act'])

    detach()
    wrapper.unmount()
  })
})

describe('BrowserPane（retryCreate windowId 缺失口径，U5）', () => {
  it('占位内重试遇 windowId 缺失：结构化 warn（口径对齐 onMounted）+ 不调 browserCreate', async () => {
    mockBrowserCreate.mockRejectedValueOnce(new Error('window gone'))
    const wrapper = mountPane({ url: 'https://example.com' })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="browser-create-error"]').exists()).toBe(true)

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockBrowserCreate.mockClear()
    // 清除 beforeEach 注入的 windowId → 重试路径守卫命中
    window.history.replaceState({}, '', '/')
    await wrapper.find('[data-testid="browser-create-error"] button').trigger('click')

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('windowId missing'))
    expect(mockBrowserCreate, '守卫拦截：不发起创建').not.toHaveBeenCalled()

    warnSpy.mockRestore()
    window.history.replaceState({}, '', '/?windowId=win-1')
    wrapper.unmount()
  })
})
