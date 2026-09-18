/**
 * boot/error-reporter 三件套单测（u2-renderer-errors 验收条款）。
 *
 * 覆盖（三视角）：
 * - 使用者黑盒（DOM 断言）：mount 含「正常子组件 + 渲染即抛子组件」的宿主——mount 不抛、
 *   正常子组件仍在 DOM（渲染错误被 errorHandler 捕获且不卸载整树）、electronAPI 收到上报
 * - 构建者白盒：payload 组装（source 分诊 / message+stack 透传 / sessionId 取自 panel
 *   store / performance.memory guard 透传与缺失省略）
 * - 观察者形态：unhandledrejection 捕获（UI 不受影响——DOM 仍在）；三件套自身零抛错
 *   （electronAPI 同步抛 / invoke reject 均静默）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/boot/error-reporter.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, defineComponent, h } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { usePanelStore } from '@/stores/panel'
import type { RendererLogPayload } from '@taiji/shared'

// [HISTORICAL] lib/ipc 顶层 `const api = window.electronAPI` 在模块加载期捕获——
// 必须先注 electronAPI mock 再动态 import（vi.resetModules + await import），
// 对齐 ipc-reveal-in-folder.test.ts 范式。

/** electronAPI.reportRendererLog 桩（beforeEach 注入）。 */
let reportMock: ReturnType<typeof vi.fn>

/** 正常渲染子组件（用户可见部分）。 */
const GoodChild = defineComponent({
  name: 'GoodChild',
  render: () => h('div', { 'data-testid': 'good-child' }, 'good-part-alive'),
})

/** setup 即抛子组件（注入的「真实组件渲染错误」——A4 场景的最小构造）。 */
const BadChild = defineComponent({
  name: 'BadChild',
  setup() {
    throw new Error('injected-render-boom')
  },
  render: () => h('div', 'never-renders'),
})

/** 宿主：GoodChild 在前（先入 DOM），BadChild 在后（渲染期 throw 被 errorHandler 接住）。 */
const Host = defineComponent({
  name: 'Host',
  render: () => h('div', [h(GoodChild), h(BadChild)]),
})

/**
 * 组装已安装三件套的 app 并原生 mount（对齐 main.ts 的 app.mount 形态——三件套装在
 * app 实例上，不能经 @vue/test-utils mount 包装（其内部另建 app，errorHandler 丢失））。
 * 每次调用先 resetModules 再动态 import：lib/ipc 门面在模块加载期捕获 electronAPI，
 * 用例中途换注入（零抛错用例）时必须取新模块实例。返回挂载容器（DOM 断言用）。
 */
async function mountWithErrorReporting(): Promise<HTMLElement> {
  vi.resetModules()
  const { installRendererErrorReporting } = await import('@/boot/error-reporter')
  const app = createApp(Host)
  installRendererErrorReporting(app)
  const container = document.createElement('div')
  document.body.appendChild(container)
  app.mount(container)
  return container
}

/** 断言用户可见部分存活（整树未卸载）。 */
function expectGoodChildAlive(container: HTMLElement): void {
  const good = container.querySelector('[data-testid="good-child"]')
  expect(good).not.toBeNull()
  expect(good?.textContent).toBe('good-part-alive')
}

/** 触发 window error 事件（Vue 体系外全局 JS 错误的模拟）。 */
function dispatchWindowError(err: unknown, message: string): void {
  window.dispatchEvent(new ErrorEvent('error', { error: err, message }))
}

/** 触发 unhandledrejection（happy-dom 无 PromiseRejectionEvent 构造时以 duck-typed Event 注入 reason）。 */
function dispatchUnhandledRejection(reason: unknown): void {
  try {
    const evt = new PromiseRejectionEvent('unhandledrejection', {
      promise: Promise.resolve(),
      reason,
    })
    window.dispatchEvent(evt)
  } catch {
    const evt = new Event('unhandledrejection') as Event & { reason: unknown; promise: Promise<unknown> }
    evt.reason = reason
    evt.promise = Promise.resolve()
    window.dispatchEvent(evt)
  }
}

/** 取最近一次上报 payload（测试断言面）。 */
function lastReport(): RendererLogPayload {
  expect(reportMock).toHaveBeenCalled()
  const calls = reportMock.mock.calls as unknown as Array<[RendererLogPayload]>
  return calls[calls.length - 1][0]
}

describe('boot/error-reporter 三件套', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    delete (window as { electronAPI?: unknown }).electronAPI
    reportMock = vi.fn().mockResolvedValue(undefined)
    ;(window as { electronAPI?: unknown }).electronAPI = { reportRendererLog: reportMock }
  })

  afterEach(() => {
    document.body.innerHTML = ''
    delete (window as { electronAPI?: unknown }).electronAPI
    // performance.memory 是可配置注桩，用后清理防泄漏到其他用例
    delete (performance as unknown as { memory?: unknown }).memory
  })

  it('渲染错误被捕获且不卸载整树：mount 不抛、GoodChild 仍在 DOM、错误上报', async () => {
    const container = await mountWithErrorReporting() // mount 本身不抛 = 不卸载整树的前提
    expectGoodChildAlive(container) // 用户可见 DOM 断言：正常部分存活
    // 注：Vue 3.5 中 setup 抛错被 errorHandler 捕获后，该组件仍以 render 输出兜底渲染，
    // 断言对象是「整树存活」而非「坏子树消失」（后者是 Vue 内部行为，非本单元契约）

    expect(reportMock).toHaveBeenCalledTimes(1)
    const payload = lastReport()
    expect(payload.source).toBe('vue-error-handler')
    expect(payload.message).toContain('injected-render-boom')
    expect(typeof payload.stack).toBe('string')
    expect(payload.stack).toContain('injected-render-boom')
    expect(typeof payload.timestamp).toBe('number')
  })

  it('window error 事件捕获 Vue 体系外错误；无 message 的资源错误事件跳过', async () => {
    const container = await mountWithErrorReporting()
    expectGoodChildAlive(container)

    dispatchWindowError(new Error('global-boom'), 'Uncaught Error: global-boom')
    const payload = lastReport()
    expect(payload.source).toBe('window-onerror')
    expect(payload.message).toContain('global-boom')

    // 资源加载错误（error 事件无 error 对象与 message）不作为 JS 错误上报
    const callsBefore = reportMock.mock.calls.length
    window.dispatchEvent(new Event('error'))
    expect(reportMock.mock.calls.length).toBe(callsBefore)
  })

  it('unhandledrejection 捕获且 UI 不受影响（DOM 仍在）', async () => {
    const container = await mountWithErrorReporting()
    dispatchUnhandledRejection(new Error('rejection-boom'))
    const payload = lastReport()
    expect(payload.source).toBe('unhandledrejection')
    expect(payload.message).toContain('rejection-boom')
    // 捕获面不干扰用户可见界面
    expectGoodChildAlive(container)
  })

  it('sessionId 取自 panel store focusedSessionId；无活跃 session 时省略', async () => {
    setActivePinia(createPinia())
    usePanelStore().loadSession('panel-root', 'sess-1')

    const container = await mountWithErrorReporting()
    expectGoodChildAlive(container)
    expect(lastReport().sessionId).toBe('sess-1')
  })

  it('无活跃 session（landing 态 / mount 前早期窗口）→ sessionId 省略，上报不失败', async () => {
    // 两种形态行为等价收敛到省略：① pinia 已激活但无活跃 session（此处空 pinia）；
    // ② pinia 完全未激活（readActiveSessionId 的 catch 降级——getActivePinia 是模块级
    // 全局，本套件前序用例激活后无法复位，catch 分支与空 pinia 形态在同一 try 契约内）
    setActivePinia(createPinia())
    const container = await mountWithErrorReporting()
    expectGoodChildAlive(container)
    expect(lastReport().sessionId).toBeUndefined()
  })

  it('performance.memory 可用时透传快照；不可用（默认环境缺失）时字段省略', async () => {
    const container = await mountWithErrorReporting()
    expectGoodChildAlive(container)
    // 默认（happy-dom 无 memory）→ 省略：P-mem-api 不可用降级形态
    expect(lastReport().memory).toBeUndefined()

    // 注入 Chromium 形态 memory → guard 通过后透传
    Object.defineProperty(performance, 'memory', {
      value: { usedJSHeapSize: 111, totalJSHeapSize: 222, jsHeapSizeLimit: 333 },
      configurable: true,
    })
    dispatchWindowError(new Error('boom-with-memory'), 'Uncaught Error: boom-with-memory')
    expect(lastReport().memory).toEqual({ usedJSHeapSize: 111, totalJSHeapSize: 222, jsHeapSizeLimit: 333 })

    // 形态不完整（缺字段）→ guard 拒绝，整字段省略
    Object.defineProperty(performance, 'memory', {
      value: { usedJSHeapSize: 'not-a-number' },
      configurable: true,
    })
    dispatchWindowError(new Error('boom-malformed-memory'), 'Uncaught Error: boom-malformed-memory')
    expect(lastReport().memory).toBeUndefined()
  })

  it('三件套自身零抛错：electronAPI 同步抛错 / invoke reject 均静默，UI 不受影响', async () => {
    // 同步抛错变体
    ;(window as { electronAPI?: unknown }).electronAPI = {
      reportRendererLog: vi.fn(() => {
        throw new Error('bridge-exploded')
      }),
    }
    let container = await mountWithErrorReporting()
    expectGoodChildAlive(container)

    // invoke reject 变体（errorHandler 内消化，不产生新的 unhandled rejection）
    ;(window as { electronAPI?: unknown }).electronAPI = {
      reportRendererLog: vi.fn().mockRejectedValue(new Error('invoke-rejected')),
    }
    container = await mountWithErrorReporting()
    expectGoodChildAlive(container)

    // electronAPI 整体缺失（web/mock）→ 不抛不上报
    delete (window as { electronAPI?: unknown }).electronAPI
    container = await mountWithErrorReporting()
    expectGoodChildAlive(container)
  })
})
