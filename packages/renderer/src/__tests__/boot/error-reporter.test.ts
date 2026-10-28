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
 * - D5 聚合降噪：window-onerror + 无堆栈 + 固定 RO loop 告警文本 → 窗内聚合计数、窗尾一条
 *   含次数的汇总（fake timers 驱动）；未命中 / 同文本带堆栈的真错误逐条转发不变
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

/** 取最近一次上报 payload（测试断言范围）。 */
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
    // 捕获点不干扰用户可见界面
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

  it('RD-3#8 ① console.error 显形：捕获的错误必写 console（即便 IPC 正常也不静默）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const container = await mountWithErrorReporting()
      expectGoodChildAlive(container)
      // 修复「report 全链静默、不写 console」：message 出现在 console.error 实参里
      const loggedMessage = errorSpy.mock.calls.some((c) =>
        c.some((arg) => typeof arg === 'string' && arg.includes('injected-render-boom')),
      )
      expect(loggedMessage).toBe(true)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('RD-3#8 ②③ 通道恢复回放：invoke reject 期错误滞留，通道恢复后被回放（不蒸发）', async () => {
    const container = await mountWithErrorReporting() // mount 时 vue-error 已成功交付
    expectGoodChildAlive(container)

    // 通道 down：reportRendererLog invoke reject → 错误滞留环形缓冲（未交付）
    reportMock.mockRejectedValue(new Error('main busy'))
    dispatchWindowError(new Error('buffered-boom'), 'Uncaught Error: buffered-boom')
    // 等待首次（失败）交付尝试完成
    await vi.waitFor(
      () => expect(reportMock.mock.calls.filter((c) => (c[0] as RendererLogPayload).message === 'buffered-boom').length).toBe(1),
      { interval: 1 },
    )

    // 通道恢复：resolve。下一条错误成功交付 → 触发回放此前滞留的 buffered-boom
    reportMock.mockResolvedValue(undefined)
    dispatchWindowError(new Error('recovery-probe'), 'Uncaught Error: recovery-probe')
    await vi.waitFor(() => {
      const messages = reportMock.mock.calls.map((c) => (c[0] as RendererLogPayload).message)
      // buffered-boom 至少出现 2 次：首次失败 + 回放成功（证明滞留条目被回放而非蒸发）
      expect(messages.filter((m) => m === 'buffered-boom').length).toBeGreaterThanOrEqual(2)
      expect(messages).toContain('recovery-probe')
    }, { interval: 1 })
  })
})

// ── D5 RO loop 告警聚合 ────────────────────────────────────────────

/** D5 聚合判据锚点：与 error-reporter.ts 的 RO_LOOP_NOISE_TEXT 同源（生产串的测试镜像）。 */
const RO_LOOP_TEXT = 'ResizeObserver loop completed with undelivered notifications'

/** RO loop 告警的真实形态：无 Error 对象（无堆栈），仅 message 文本（尾句点为 Chromium 派发形态）。 */
function dispatchRoLoopWarning(message: string = `${RO_LOOP_TEXT}.`): void {
  window.dispatchEvent(new ErrorEvent('error', { error: null, message }))
}

/** 取基线起新增上报中的聚合汇总条目（窗尾汇总的 (aggregated summary) 标记）。 */
function aggregateSummaries(fromIndex: number): RendererLogPayload[] {
  return reportMock.mock.calls
    .slice(fromIndex)
    .map((c) => c[0] as RendererLogPayload)
    .filter((p) => p.message.includes('(aggregated summary)'))
}

/** 指定 message 的落盘次数（既有 RD-3#8 回放竞态可能重复交付在途条目，断言按 message 精确计数）。 */
function deliverCount(message: string): number {
  return reportMock.mock.calls.filter((c) => (c[0] as RendererLogPayload).message === message)
    .length
}

describe('D5 RO loop 告警聚合（window-onerror + 无堆栈 + 固定文本）', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    delete (window as { electronAPI?: unknown }).electronAPI
    reportMock = vi.fn().mockResolvedValue(undefined)
    ;(window as { electronAPI?: unknown }).electronAPI = { reportRendererLog: reportMock }
    // 窗口推进用 fake timers（确定性触发，无真实等待）
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
    delete (window as { electronAPI?: unknown }).electronAPI
  })

  it('命中 → 聚合计数：窗内多条不逐条转发（console 与落盘均静默），窗尾一条汇总含次数', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const container = await mountWithErrorReporting()
      expectGoodChildAlive(container)
      const baselineCalls = reportMock.mock.calls.length

      // 窗内 3 条命中：规范化匹配覆盖浏览器派发形态（尾句点 / 无句点 / Uncaught 前缀）
      dispatchRoLoopWarning()
      dispatchRoLoopWarning(RO_LOOP_TEXT)
      dispatchRoLoopWarning(`Uncaught ${RO_LOOP_TEXT}`)

      // 窗内：零逐条转发——落盘无新增，console 无该文本输出
      expect(reportMock.mock.calls.length).toBe(baselineCalls)
      expect(
        errorSpy.mock.calls.filter((c) =>
          c.some((a) => typeof a === 'string' && a.includes(RO_LOOP_TEXT)),
        ),
      ).toHaveLength(0)

      // 窗尾：恰一条汇总，含固定告警文本与窗内次数
      await vi.advanceTimersByTimeAsync(60_000)
      const summaries = aggregateSummaries(baselineCalls)
      expect(summaries).toHaveLength(1)
      expect(summaries[0]?.source).toBe('window-onerror')
      expect(summaries[0]?.message).toContain('x3')
      expect(summaries[0]?.message).toContain('(aggregated summary)')
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('未命中 → 逐条转发行为完全不变：每条立即落盘，窗尾无聚合汇总', async () => {
    const container = await mountWithErrorReporting()
    expectGoodChildAlive(container)

    dispatchWindowError(new Error('real-boom-1'), 'Uncaught Error: real-boom-1')
    dispatchWindowError(new Error('real-boom-2'), 'Uncaught Error: real-boom-2')
    // 逐条即时转发（不等窗尾）：每条各恰一次落盘
    expect(deliverCount('real-boom-1')).toBe(1)
    expect(deliverCount('real-boom-2')).toBe(1)

    await vi.advanceTimersByTimeAsync(60_000)
    // 未命中不产生聚合汇总。（既有 RD-3#8 回放竞态可能把在途条目重复交付一次，
    // 断言按 message 计数 + 汇总标记过滤，与该既有行为解耦，不在此断言总调用数。）
    expect(aggregateSummaries(0)).toHaveLength(0)
  })

  it('同文本但带堆栈的真错误不聚合 → 立即逐条转发（不吞真错误），窗尾无汇总', async () => {
    const container = await mountWithErrorReporting()
    expectGoodChildAlive(container)

    // Error 对象形态（带堆栈）即便文本恰同也不命中聚合——聚合只针对无堆栈噪声条目
    dispatchWindowError(new Error(RO_LOOP_TEXT), `Uncaught Error: ${RO_LOOP_TEXT}`)
    expect(deliverCount(RO_LOOP_TEXT)).toBe(1)
    const payload = lastReport()
    expect(payload.source).toBe('window-onerror')
    expect(payload.message).toBe(RO_LOOP_TEXT)
    expect(typeof payload.stack).toBe('string')

    await vi.advanceTimersByTimeAsync(60_000)
    // 未入聚合窗：窗尾无聚合汇总（该错误保持逐条转发形态，未被吞）
    expect(aggregateSummaries(0)).toHaveLength(0)
  })

  it('窗尾复位后下一窗独立计数：各窗各一条汇总（x1 / x2）', async () => {
    const container = await mountWithErrorReporting()
    expectGoodChildAlive(container)
    const baselineCalls = reportMock.mock.calls.length

    dispatchRoLoopWarning()
    await vi.advanceTimersByTimeAsync(60_000)
    let summaries = aggregateSummaries(baselineCalls)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.message).toContain('x1')

    dispatchRoLoopWarning()
    dispatchRoLoopWarning()
    await vi.advanceTimersByTimeAsync(60_000)
    summaries = aggregateSummaries(baselineCalls)
    expect(summaries).toHaveLength(2)
    expect(summaries[1]?.message).toContain('x2')
  })
})
