/**
 * Panel 挂载测试合并产物（round5-h colocated 收尾，同被测对象 Panel.vue 两切面节）。
 *
 * 来源（本目录，各包基名 describe，节内 hook/helper 随节下沉）：
 *   - Panel.inbound-frame-notice.test.ts（入站丢帧终止阀提示条挂载闭环，u-init P0 /
 *     crash-forensics-and-watchdog §3.3 D8）
 *   - Panel.plan-quota-float-overlay.test.ts（套餐浮层 overlay 判据 + 宽度自动收起）
 *
 * 合并纪律：vi.hoisted / vi.mock 全部上提产物文件顶（vitest 4.1.9 describe 内声明
 * 不提升且失效）；两节各自的 beforeEach/afterEach 与私有 helper 留在节内 describe
 * 作用域；mountPanel 两节实现相同，各节自包含定义。合并适配：inbound 节 beforeEach
 * 补 quotaPlanListMock 空 entries 默认（原文件跑真实 useQuotaPlanList，合并后统一吃
 * 本文件 mock——空 entries 语义等价「无额度数据」，浮层不渲染，不触碰丢帤断言）。
 * Panel.dead-diagnostics-export.test.ts 因 '@/lib/ipc' mock 工厂与本簇 inbound 节
 * 不同，保持独立文件（同 spec 不同工厂互斥）。
 *
 * 共同 mock 底座：壳依赖六连（sidebar/toast/extensionUI/new-task-flow/chat/session）
 * 由 helpers/panel-mount-mocks 导入即注册（置于 Panel import 之前，注册早于其导入链
 * 加载）；真实 Pinia。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/__tests__/Panel.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import type { Ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { InboundFrameDroppedInfo } from '@taiji/core'
// Panel 挂载壳 mock 六连（useSidebar/useToast/useExtensionUI/useNewTaskFlow/chat/session）
// 由 panel-mount-mocks 导入即注册——置于 Panel import 之前，注册早于其导入链加载
//（两节均不断言 toast，仅隔离副作用；chat/session 状态经 panelChatMock/panelSessionMock 注入）
import {
  MessageStreamStub,
  panelChatMock,
  panelSessionMock,
} from '@/__tests__/helpers/panel-mount-mocks'
import { ROOT_PANEL_ID, usePanelStore } from '@/stores/panel'
import Panel from '../Panel.vue'
import {
  _resetInboundFrameGuardForTest,
  installInboundFrameGuard,
  isInboundSessionTripped,
} from '@/composables/useInboundFrameGuard'
import type { QuotaPlanEntry } from '@/composables/features/model/useQuotaPlanList'
import { QUOTA_FLOAT_AUTO_COLLAPSE_PANEL_WIDTH } from '../plan-quota-float'

// ── mock 面（文件顶；工厂引用的 hoisted 变量与工厂同作用域）─────────────────

const coreMock = vi.hoisted(() => ({
  onInboundFrameDropped: vi.fn(),
  retryInboundDroppedSession: vi.fn(),
  subscribeSession: vi.fn(),
}))
const reportMock = vi.hoisted(() => vi.fn())

vi.mock('@taiji/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@taiji/core')>()),
  onInboundFrameDropped: coreMock.onInboundFrameDropped,
  retryInboundDroppedSession: coreMock.retryInboundDroppedSession,
  subscribeSession: coreMock.subscribeSession,
}))

vi.mock('@/lib/ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc')>()),
  reportRendererLog: reportMock,
}))

const quotaApiMock = vi.hoisted(() => ({
  getCached: vi.fn(),
  fetchQuota: vi.fn(),
}))
vi.mock('@taiji/core/transport/api/domains/quota', () => quotaApiMock)

/** entries 每用例控制（beforeEach 重装 ref；Panel 与浮层本体共用同一 mock 返回值） */
const quotaPlanListMock = vi.hoisted(() => ({ useQuotaPlanList: vi.fn() }))
vi.mock('@/composables/features/model/useQuotaPlanList', () => quotaPlanListMock)

/* ════════ 来源：Panel.inbound-frame-notice.test.ts ════════ */

describe('Panel 承接入站丢帧终止阀提示（D8 挂载点闭环）', () => {
  function mountPanel(sessionId: string) {
    return mount(Panel, {
      props: { panelId: 'p1', sessionId, sessionDir: '/tmp/x' },
      global: {
        plugins: [createPinia()],
        stubs: { MessageStream: MessageStreamStub, Composer: true, Landing: true, FormOverlay: true },
      },
    })
  }

  /** 捕获 core 侧注册的丢帧回调。 */
  let dropCallback: ((info: InboundFrameDroppedInfo) => void) | null = null

  function fireDrop(overrides: Partial<InboundFrameDroppedInfo> = {}): void {
    expect(dropCallback, 'installInboundFrameGuard 应先绑定 onInboundFrameDropped').toBeTypeOf('function')
    dropCallback?.({
      sessionId: 's1',
      frameSize: 42_000_001,
      kind: 'text',
      valveTripped: true,
      sessionDropCount: 3,
      ...overrides,
    })
  }

  let panel: ReturnType<typeof usePanelStore>

  beforeEach(() => {
    _resetInboundFrameGuardForTest()
    dropCallback = null
    coreMock.onInboundFrameDropped.mockReset()
    coreMock.retryInboundDroppedSession.mockReset().mockReturnValue(false)
    coreMock.subscribeSession.mockReset().mockResolvedValue(undefined)
    reportMock.mockReset()
    coreMock.onInboundFrameDropped.mockImplementation((cb: (info: InboundFrameDroppedInfo) => void) => {
      dropCallback = cb
      return () => {
        if (dropCallback === cb) dropCallback = null
      }
    })
    // 合并适配：本节原跑真实 useQuotaPlanList；统一吃文件顶 mock 后补空 entries
    // 默认（等价原「无额度数据」路径，quotaFloatVisible=false，不影响丢帤断言）
    quotaPlanListMock.useQuotaPlanList.mockReset()
    quotaPlanListMock.useQuotaPlanList.mockReturnValue({ entries: ref<QuotaPlanEntry[]>([]) })
    panelChatMock.getMessages.mockReturnValue([])
    panelChatMock.failedHistory.clear()
    panelSessionMock.list = []
    setActivePinia(createPinia())
    panel = usePanelStore()
  })

  afterEach(() => {
    _resetInboundFrameGuardForTest()
  })

  it('安装检查 + 丢帧触发终止阀 → Panel 会话视图内提示条可见（composer-band 同区），非 tripped session 不渲染', async () => {
    installInboundFrameGuard() // App 装配层等价动作
    fireDrop({ sessionId: 's1' })
    expect(isInboundSessionTripped('s1')).toBe(true)

    const wrapper = mountPanel('s1')
    await nextTick()
    const notice = wrapper.find('[data-testid="inbound-frame-dropped-notice"]')
    expect(notice.exists()).toBe(true)
    expect(notice.attributes('role')).toBe('alert')
    expect(wrapper.find('[data-testid="inbound-frame-dropped-title"]').text()).toBe('本会话数据流已暂停')
    // 挂载点在 composer band（与 respawnPending 过渡条同区），非对话流内部
    expect(wrapper.find('.composer-band').find('[data-testid="inbound-frame-dropped-notice"]').exists()).toBe(true)
    wrapper.unmount()

    // 单 session 作用域：别的 session 视图不渲染（不连坐）
    const other = mountPanel('s2')
    await nextTick()
    expect(other.find('[data-testid="inbound-frame-dropped-notice"]').exists()).toBe(false)
    other.unmount()
  })

  it('未触发终止阀（valveTripped=false）→ Panel 不渲染提示条', async () => {
    installInboundFrameGuard()
    fireDrop({ sessionDropCount: 1, valveTripped: false })
    expect(isInboundSessionTripped('s1')).toBe(false)

    const wrapper = mountPanel('s1')
    await nextTick()
    expect(wrapper.find('[data-testid="inbound-frame-dropped-notice"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('切走再切回 tripped session → 重试订阅恰好一次、提示条随恢复动作消失', async () => {
    installInboundFrameGuard()
    coreMock.retryInboundDroppedSession.mockReturnValue(true)
    fireDrop({ sessionId: 's1' })

    const wrapper = mountPanel('s1')
    await nextTick()
    expect(wrapper.find('[data-testid="inbound-frame-dropped-notice"]').exists()).toBe(true)

    panel.loadSession(ROOT_PANEL_ID, 's2') // 切走：非 tripped，零动作
    await nextTick()
    expect(coreMock.retryInboundDroppedSession).not.toHaveBeenCalled()

    panel.loadSession(ROOT_PANEL_ID, 's1') // 切回：恢复触发器命中
    await nextTick()
    expect(coreMock.retryInboundDroppedSession).toHaveBeenCalledTimes(1)
    expect(coreMock.retryInboundDroppedSession).toHaveBeenCalledWith('s1')
    expect(coreMock.subscribeSession).toHaveBeenCalledTimes(1) // 重试订阅一次
    await nextTick()
    expect(wrapper.find('[data-testid="inbound-frame-dropped-notice"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

/* ════════ 来源：Panel.plan-quota-float-overlay.test.ts ════════ */

describe('Panel 套餐浮层 overlay 判据（纯浮层不让位 + 宽度自动收起）', () => {
  // ── ResizeObserver fake（jsdom 无实现；捕获实例手动喂宽度）──────────

  class FakeResizeObserver {
    static instances: FakeResizeObserver[] = []
    callback: ResizeObserverCallback
    observe = vi.fn()
    unobserve = vi.fn()
    disconnect = vi.fn()

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback
      FakeResizeObserver.instances.push(this)
    }

    /** 模拟一次尺寸回调（borderBoxSize 通道，与实装消费路径同形）。 */
    emit(width: number): void {
      this.callback(
        [{ borderBoxSize: [{ inlineSize: width }] }] as unknown as ResizeObserverEntry[],
        this as unknown as ResizeObserver,
      )
    }
  }

  // ── 挂载 helper ────────────────────────────────────────────────────

  let entriesRef: Ref<QuotaPlanEntry[]>

  function mountPanel(sessionId: string) {
    return mount(Panel, {
      props: { panelId: 'p1', sessionId, sessionDir: '/tmp/x' },
      global: {
        plugins: [createPinia()],
        stubs: { MessageStream: MessageStreamStub, Composer: true, Landing: true, FormOverlay: true },
      },
    })
  }

  /** Panel 根 section（「携带 --panel-bg 变量的 section」锚定——Panel 模板是多根 fragment）。 */
  function panelSectionOf(wrapper: ReturnType<typeof mountPanel>) {
    const panelSection = wrapper
      .findAll('section')
      .find((s) => (s.attributes('style') ?? '').includes('--panel-bg'))
    expect(panelSection, '应找到携带 --panel-bg 的 Panel 根 section').toBeDefined()
    return panelSection!
  }

  /** 喂一次面板宽度回调并返回浮层当前 style 串（自动收起/展开断言共用序列）。 */
  async function emitFloatStyle(observer: FakeResizeObserver, wrapper: ReturnType<typeof mountPanel>, width: number) {
    observer.emit(width)
    await nextTick()
    return wrapper.find('[data-testid="plan-quota-float"]').attributes('style') ?? ''
  }

  beforeEach(() => {
    vi.clearAllMocks()
    FakeResizeObserver.instances = []
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    panelChatMock.getMessages.mockReturnValue([])
    panelChatMock.failedHistory.clear()
    panelSessionMock.list = [] // s1 不在 list → 非 dead → conversation 分支
    quotaApiMock.getCached.mockResolvedValue({ data: null, lastFetchAt: null })
    quotaApiMock.fetchQuota.mockResolvedValue({ data: null, lastFetchAt: null, reason: 'network' })
    entriesRef = ref<QuotaPlanEntry[]>([])
    quotaPlanListMock.useQuotaPlanList.mockReturnValue({ entries: entriesRef })
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('conversation 分支 + entries 为空：浮层不渲染，panel 无让位 padding', async () => {
    const wrapper = mountPanel('s1')
    await nextTick()
    await flushPromises()

    expect(wrapper.find('[data-testid="plan-quota-float"]').exists()).toBe(false)
    expect(panelSectionOf(wrapper).attributes('style')).not.toContain('padding-left')
    wrapper.unmount()
  })

  it('conversation 分支 + entries 非空：浮层渲染（240px / left 12px），panel 无让位 padding（纯 overlay）', async () => {
    entriesRef.value = [{ providerId: 'kimi-coding', label: 'Kimi Coding' }]
    const wrapper = mountPanel('s1')
    await nextTick()
    await flushPromises()

    const floatPanel = wrapper.find('[data-testid="plan-quota-float"]')
    expect(floatPanel.exists()).toBe(true)
    expect(floatPanel.attributes('style')).toContain('width: 240px')
    expect(floatPanel.attributes('style')).toContain('left: 12px')
    // 回归锚点：浮层不得通过 padding 挤占对话流/composer 边距
    expect(panelSectionOf(wrapper).attributes('style')).not.toContain('padding-left')
    wrapper.unmount()
  })

  it('entries 非空 + 点击折叠钮手动收起：浮层宽度切 44px，panel 仍无让位 padding', async () => {
    entriesRef.value = [{ providerId: 'kimi-coding', label: 'Kimi Coding' }]
    const wrapper = mountPanel('s1')
    await nextTick()
    await flushPromises()

    await wrapper.find('[data-testid="plan-quota-collapse"]').trigger('click')
    await nextTick()
    await flushPromises()

    expect(wrapper.find('[data-testid="plan-quota-float"]').attributes('style')).toContain('width: 44px')
    expect(panelSectionOf(wrapper).attributes('style')).not.toContain('padding-left')
    wrapper.unmount()
  })

  it('entries 从非空变空（用户关闭全部额度监控）：浮层卸载', async () => {
    entriesRef.value = [{ providerId: 'kimi-coding', label: 'Kimi Coding' }]
    const wrapper = mountPanel('s1')
    await nextTick()
    await flushPromises()
    expect(wrapper.find('[data-testid="plan-quota-float"]').exists()).toBe(true)

    entriesRef.value = []
    await nextTick()
    await flushPromises()

    expect(wrapper.find('[data-testid="plan-quota-float"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('panel 宽度低于阈值：浮层自动收起（44px）；恢复宽度自动展开（240px）', async () => {
    entriesRef.value = [{ providerId: 'kimi-coding', label: 'Kimi Coding' }]
    const wrapper = mountPanel('s1')
    await nextTick()
    await flushPromises()

    expect(FakeResizeObserver.instances).toHaveLength(1)
    const observer = FakeResizeObserver.instances[0]

    expect(await emitFloatStyle(observer, wrapper, QUOTA_FLOAT_AUTO_COLLAPSE_PANEL_WIDTH - 1)).toContain('width: 44px')
    expect(await emitFloatStyle(observer, wrapper, QUOTA_FLOAT_AUTO_COLLAPSE_PANEL_WIDTH)).toContain('width: 240px')
    wrapper.unmount()
  })

  it('用户手动收起后宽度恢复：保持手动收起态（手动优先于自动展开）', async () => {
    entriesRef.value = [{ providerId: 'kimi-coding', label: 'Kimi Coding' }]
    const wrapper = mountPanel('s1')
    await nextTick()
    await flushPromises()

    const observer = FakeResizeObserver.instances[0]
    expect(await emitFloatStyle(observer, wrapper, QUOTA_FLOAT_AUTO_COLLAPSE_PANEL_WIDTH - 1)).toContain('width: 44px')

    // 宽度恢复（自动来源解除）前用户手动展开，再触发恢复 → 自动来源不得覆盖手动态
    await wrapper.find('[data-testid="plan-quota-rail"]').trigger('click')
    expect(await emitFloatStyle(observer, wrapper, QUOTA_FLOAT_AUTO_COLLAPSE_PANEL_WIDTH)).toContain('width: 240px')

    // 手动收起 + 宽度充足 → 保持收起
    await wrapper.find('[data-testid="plan-quota-collapse"]').trigger('click')
    expect(await emitFloatStyle(observer, wrapper, QUOTA_FLOAT_AUTO_COLLAPSE_PANEL_WIDTH + 100)).toContain('width: 44px')
    wrapper.unmount()
  })
})
