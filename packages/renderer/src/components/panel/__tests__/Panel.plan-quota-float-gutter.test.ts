/**
 * Panel 套餐浮层让位 gutter 判据联动测试（plan-quota-float）。
 *
 * 背景：gutter（panelStyle paddingLeft）此前只看挂载分支（conversation/trace），不感知
 * 浮层清单 entries——entries 为空时浮层本体（内部 v-if）不渲染，但对话流左侧仍恒空
 * 让位 300px（收起 64px）无内容，全新安装/未配置额度监控的常态命中。判据必须与浮层
 * 渲染判据同源：entries 空 → 浮层不渲染且 gutter 归零。
 *
 * 覆盖：
 *  - conversation 分支 + entries 空 → plan-quota-float 不存在 + gutter 0px；
 *  - conversation 分支 + entries 非空 → 浮层渲染 + 展开档 gutter 300px；
 *  - entries 非空 + 手动收起（折叠钮）→ 收起档 gutter 64px；
 *  - 浮层本体宽度两态（276px/44px）与左缘 12px —— 与 gutter 三档同源
 *    （plan-quota-float.ts 尺寸契约），改宽度只改常量模块。
 *
 * Mock 策略（Panel 挂载最小闭合集，同 Panel.inbound-frame-notice.test.ts）：mock
 * useQuotaPlanList（entries 每用例直接控制——本文件聚焦 Panel gutter 判据，entries
 * 派生由 PlanQuotaFloatPanel.test.ts 覆盖）+ quota 查询域 API（PlanQuotaItem 挂载即查，
 * 固定返回 null 数据不引入额度态噪音）+ chat/session/new-task-flow；Panel 与
 * PlanQuotaFloatPanel/PlanQuotaItem 真实渲染；真实 Pinia。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/__tests__/Panel.plan-quota-float-gutter.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import type { Ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
// Panel 挂载壳 mock 三连（useSidebar/useToast/useExtensionUI）由 panel-mount-mocks 导入即
// 注册——置于 Panel import 之前，注册早于其导入链加载（useToast 工厂绑定 TDZ 坑）
import { MessageStreamStub } from '@/__tests__/helpers/panel-mount-mocks'
import type { QuotaPlanEntry } from '@/composables/features/model/useQuotaPlanList'
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

/** chat store mock：Panel 只消费 readers 面 */
const chatMock = vi.hoisted(() => ({
  getMessages: vi.fn(() => [] as unknown[]),
  isActive: vi.fn(() => false),
  isCompacting: vi.fn(() => false),
  isRespawnPending: vi.fn(() => false),
  getOccupancy: vi.fn(() => ({ turn: 'idle', compacting: false, bash: false })),
  failedHistory: new Map<string, boolean>(),
}))
vi.mock('@/stores/chat', () => ({ useChatStore: () => chatMock }))

const sessionMock = vi.hoisted(() => ({
  list: [] as Array<{ id: string; status: string; modelId?: string }>,
}))
vi.mock('@/stores/session', () => ({ useSessionStore: () => sessionMock }))

vi.mock('@/composables/features/new-task/useNewTaskFlow', () => ({
  useNewTaskFlow: () => ({ state: { value: 'idle' }, isActive: { value: false } }),
}))

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

/** Panel 根 section 的让位 gutter（padding-left 值；'0px' = 不让位）。
 *  定位方式：Panel 模板是多根 fragment（首注释 + section），wrapper.attributes 拿不到
 *  根元素——用「携带 --panel-bg 变量的 section」锚定（该变量是 Panel 根 section 独有）。 */
function gutterOf(wrapper: ReturnType<typeof mountPanel>): string {
  const panelSection = wrapper
    .findAll('section')
    .find((s) => (s.attributes('style') ?? '').includes('--panel-bg'))
  expect(panelSection, '应找到携带 --panel-bg 的 Panel 根 section').toBeDefined()
  const match = panelSection!.attributes('style')!.match(/padding-left:\s*([^;]+)/)
  expect(match, `Panel 根 section 应有 padding-left（style=${panelSection!.attributes('style')}）`).not.toBeNull()
  return match![1].trim()
}

beforeEach(() => {
  vi.clearAllMocks()
  chatMock.getMessages.mockReturnValue([])
  chatMock.failedHistory.clear()
  sessionMock.list = [] // s1 不在 list → 非 dead → conversation 分支
  quotaApiMock.getCached.mockResolvedValue({ data: null, lastFetchAt: null })
  quotaApiMock.fetchQuota.mockResolvedValue({ data: null, lastFetchAt: null, reason: 'network' })
  entriesRef = ref<QuotaPlanEntry[]>([])
  quotaPlanListMock.useQuotaPlanList.mockReturnValue({ entries: entriesRef })
  setActivePinia(createPinia())
})

describe('Panel 套餐浮层让位 gutter 判据联动（entries 空 → 浮层不渲染 + gutter 归零）', () => {
  it('conversation 分支 + entries 为空：浮层不渲染，gutter 0px（不再恒空让位）', async () => {
    const wrapper = mountPanel('s1')
    await nextTick()
    await flushPromises()

    expect(wrapper.find('[data-testid="plan-quota-float"]').exists()).toBe(false)
    expect(gutterOf(wrapper)).toBe('0px')
    wrapper.unmount()
  })

  it('conversation 分支 + entries 非空：浮层渲染，展开档 gutter 300px', async () => {
    entriesRef.value = [{ providerId: 'kimi-coding', label: 'Kimi Coding' }]
    const wrapper = mountPanel('s1')
    await nextTick()
    await flushPromises()

    const floatPanel = wrapper.find('[data-testid="plan-quota-float"]')
    expect(floatPanel.exists()).toBe(true)
    // 浮层本体宽度与左缘（尺寸契约 SSOT 消费面）
    expect(floatPanel.attributes('style')).toContain('width: 276px')
    expect(floatPanel.attributes('style')).toContain('left: 12px')
    expect(gutterOf(wrapper)).toBe('300px')
    wrapper.unmount()
  })

  it('entries 非空 + 点击折叠钮手动收起：gutter 收起档 64px，浮层宽度切 44px', async () => {
    entriesRef.value = [{ providerId: 'kimi-coding', label: 'Kimi Coding' }]
    const wrapper = mountPanel('s1')
    await nextTick()
    await flushPromises()

    await wrapper.find('[data-testid="plan-quota-collapse"]').trigger('click')
    await nextTick()
    await flushPromises()

    expect(gutterOf(wrapper)).toBe('64px')
    expect(wrapper.find('[data-testid="plan-quota-float"]').attributes('style')).toContain('width: 44px')
    wrapper.unmount()
  })

  it('entries 从非空变空（用户关闭全部额度监控）：浮层卸载，gutter 归零', async () => {
    entriesRef.value = [{ providerId: 'kimi-coding', label: 'Kimi Coding' }]
    const wrapper = mountPanel('s1')
    await nextTick()
    await flushPromises()
    expect(gutterOf(wrapper)).toBe('300px')

    entriesRef.value = []
    await nextTick()
    await flushPromises()

    expect(wrapper.find('[data-testid="plan-quota-float"]').exists()).toBe(false)
    expect(gutterOf(wrapper)).toBe('0px')
    wrapper.unmount()
  })
})
