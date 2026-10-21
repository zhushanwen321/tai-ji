/**
 * Panel 套餐浮层（plan-quota-float）overlay 判据测试。
 *
 * 契约：浮层是纯 overlay——悬浮在对话流上方，不挤占消息列/composer 边距（Panel 根
 * section 不得出现让位 padding-left）；挂载域 = conversation/trace 分支且 entries 非空；
 * 收起判据单点收敛（trace / drawer / panel 宽度不足 / 用户手动），宽度不足自动收起、
 * 恢复自动展开、用户手动收起优先保持。
 *
 * 覆盖：
 *  - conversation 分支 + entries 空 → 浮层不渲染；
 *  - conversation 分支 + entries 非空 → 浮层渲染（276px / left 12px）+ panel 无 padding-left；
 *  - 手动收起（折叠钮）→ 浮层 44px，panel 仍无 padding-left；
 *  - panel 宽度 < 阈值 → 自动收起；恢复 → 自动展开；手动收起后恢复 → 保持收起。
 *
 * Mock 策略（Panel 挂载最小闭合集）：壳依赖六连（sidebar/toast/extensionUI/new-task-flow/
 * chat/session）由 helpers/panel-mount-mocks 导入即注册；mock useQuotaPlanList（entries
 * 每用例直接控制——本文件聚焦 Panel 判据，entries 派生由 PlanQuotaFloatPanel.test.ts 覆盖）
 * + quota 查询域 API（PlanQuotaItem 挂载即查，固定返回 null 数据不引入额度态噪音）；
 * Panel 与 PlanQuotaFloatPanel/PlanQuotaItem 真实渲染；真实 Pinia。
 * ResizeObserver 用 fake 替身（jsdom 无实现）：捕获 callback 手动喂宽度驱动自动收起判定。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/__tests__/Panel.plan-quota-float-overlay.test.ts
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import type { Ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
// Panel 挂载壳 mock 六连（useSidebar/useToast/useExtensionUI/useNewTaskFlow/chat/session）
// 由 panel-mount-mocks 导入即注册——置于 Panel import 之前，注册早于其导入链加载（TDZ 坑）
import {
  MessageStreamStub,
  panelChatMock,
  panelSessionMock,
} from '@/__tests__/helpers/panel-mount-mocks'
import type { QuotaPlanEntry } from '@/composables/features/model/useQuotaPlanList'
import { QUOTA_FLOAT_AUTO_COLLAPSE_PANEL_WIDTH } from '../plan-quota-float'
import Panel from '../Panel.vue'

// ── mock 面 ────────────────────────────────────────────────────────

const quotaApiMock = vi.hoisted(() => ({
  getCached: vi.fn(),
  fetchQuota: vi.fn(),
}))
vi.mock('@taiji/core/transport/api/domains/quota', () => quotaApiMock)

/** entries 每用例控制（beforeEach 重装 ref；Panel 与浮层本体共用同一 mock 返回值） */
const quotaPlanListMock = vi.hoisted(() => ({ useQuotaPlanList: vi.fn() }))
vi.mock('@/composables/features/model/useQuotaPlanList', () => quotaPlanListMock)

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

describe('Panel 套餐浮层 overlay 判据（纯浮层不让位 + 宽度自动收起）', () => {
  it('conversation 分支 + entries 为空：浮层不渲染，panel 无让位 padding', async () => {
    const wrapper = mountPanel('s1')
    await nextTick()
    await flushPromises()

    expect(wrapper.find('[data-testid="plan-quota-float"]').exists()).toBe(false)
    expect(panelSectionOf(wrapper).attributes('style')).not.toContain('padding-left')
    wrapper.unmount()
  })

  it('conversation 分支 + entries 非空：浮层渲染（276px / left 12px），panel 无让位 padding（纯 overlay）', async () => {
    entriesRef.value = [{ providerId: 'kimi-coding', label: 'Kimi Coding' }]
    const wrapper = mountPanel('s1')
    await nextTick()
    await flushPromises()

    const floatPanel = wrapper.find('[data-testid="plan-quota-float"]')
    expect(floatPanel.exists()).toBe(true)
    expect(floatPanel.attributes('style')).toContain('width: 276px')
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

  it('panel 宽度低于阈值：浮层自动收起（44px）；恢复宽度自动展开（276px）', async () => {
    entriesRef.value = [{ providerId: 'kimi-coding', label: 'Kimi Coding' }]
    const wrapper = mountPanel('s1')
    await nextTick()
    await flushPromises()

    expect(FakeResizeObserver.instances).toHaveLength(1)
    const observer = FakeResizeObserver.instances[0]

    expect(await emitFloatStyle(observer, wrapper, QUOTA_FLOAT_AUTO_COLLAPSE_PANEL_WIDTH - 1)).toContain('width: 44px')
    expect(await emitFloatStyle(observer, wrapper, QUOTA_FLOAT_AUTO_COLLAPSE_PANEL_WIDTH)).toContain('width: 276px')
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
    expect(await emitFloatStyle(observer, wrapper, QUOTA_FLOAT_AUTO_COLLAPSE_PANEL_WIDTH)).toContain('width: 276px')

    // 手动收起 + 宽度充足 → 保持收起
    await wrapper.find('[data-testid="plan-quota-collapse"]').trigger('click')
    expect(await emitFloatStyle(observer, wrapper, QUOTA_FLOAT_AUTO_COLLAPSE_PANEL_WIDTH + 100)).toContain('width: 44px')
    wrapper.unmount()
  })
})
