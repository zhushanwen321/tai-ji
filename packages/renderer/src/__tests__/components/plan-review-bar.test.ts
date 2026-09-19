/**
 * PlanReviewBar 组件单测 —— plan 模式重设计 u1-banner（审批条，设计 D5/G3/G4）。
 *
 * 覆盖（impl-plan u1-banner 验收条款）：
 * - 四分支显示公式逐分支 DOM 断言（含 isActive=false 整体不渲染）：
 *   ① isActive+挂起+awaiting → 三键全功能；② revising → 修订中禁用态；
 *   ③ awaiting 无挂起 → 降级态「等待 agent 重新提交审批」；④ isActive=false → 不渲染
 * - 三键 respond payload 形状断言（PlanReviewResponse 判别联合：approve 无 comments；
 *   revise/explain 打包评论草稿快照；提交后草稿清空——D6）
 * - 挂起请求枚举消费（useExtensionUI planReviewFilter 实例，requestId 精确回传）
 *
 * mock 形态照抄 useExtensionUI.test.ts（真实 InternalEventBus）+ plan-store.test.ts
 * （spread actual 保真实 events 通道只换 command）；i18n 经 vitest-i18n-setup 全局 mock。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/plan-review-bar.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { computed, nextTick } from 'vue'
import { effectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { InternalEventBus } from '@taiji/core'
import type { PlanStateView } from '@taiji/shared'

// ── mock ①：command（plan-store 首拉 RPC）——spread actual 保真实 events 通道 ──
const commandMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api', async (importActual) => {
  const actual = await importActual<typeof import('@taiji/core/transport/api')>()
  return { ...actual, command: commandMock, RPC_BACKSTOP_TIMEOUT_MS: 30_000 }
})

// ── mock ②：extension domain（useExtensionUI 的 WS/RPC 面，照 useExtensionUI.test.ts）──
const uiTimeoutHandlers = new Map<string, Array<(requestId: string) => void>>()
vi.mock('@taiji/core/transport/api/domains/extension', () => ({
  onUITimeout: (sid: string, handler: (requestId: string) => void) => {
    const arr = uiTimeoutHandlers.get(sid) ?? []
    arr.push(handler)
    uiTimeoutHandlers.set(sid, arr)
    return () => {
      const cur = uiTimeoutHandlers.get(sid)
      if (!cur) return
      const idx = cur.indexOf(handler)
      if (idx !== -1) cur.splice(idx, 1)
      if (cur.length === 0) uiTimeoutHandlers.delete(sid)
    }
  },
  sendExtensionUIResponse: vi.fn(),
  onNotify: () => () => {},
  onExtensions: vi.fn(),
  getPendingRequests: vi.fn().mockResolvedValue([]),
}))

// ── mock ③：getExtensionBus → 真实 InternalEventBus 实例 ──
let mockBus: InternalEventBus
vi.mock('@/composables/shell/useExtensionHostBridge', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/composables/shell/useExtensionHostBridge')>()
  return { ...original, getExtensionBus: () => mockBus }
})

import PlanReviewBar from '@/components/panel/plan/PlanReviewBar.vue'
import {
  useExtensionUI,
  formFilter,
  __resetExtensionBusSubscriptionForTesting,
} from '@/composables/useExtensionUI'
import { usePlanStore } from '@/stores/plan-store'
import { sendExtensionUIResponse } from '@taiji/core/transport/api/domains/extension'

const SID = 'sess-bar'

function viewOf(overrides: Partial<PlanStateView> = {}): PlanStateView {
  return {
    isActive: true,
    planFilePath: '/data/A/.taiji-harness/auth/plan.md',
    requirement: '重构 auth 模块',
    templateName: 'default',
    ...overrides,
  }
}

/** 挂起 planReview 审批请求（runtime event-adapter 广播形状，D5） */
function emitPlanReviewRequest(requestId = 'pr-1'): void {
  mockBus.emit({
    kind: 'ui-request',
    sessionId: SID,
    request: {
      requestId,
      pluginId: '',
      kind: 'select',
      method: 'select',
      title: '\x00TAIJI_PLAN_REVIEW:',
      options: [JSON.stringify({ docs: [] })],
      planReview: true,
    },
  } as never)
}

async function mountBar(view: PlanStateView | null = viewOf()): Promise<VueWrapper> {
  commandMock.mockResolvedValue({ sessionId: SID, planState: view })
  const wrapper = mount(PlanReviewBar, { props: { sessionId: SID } })
  await flushAsync()
  return wrapper
}

async function flushAsync(): Promise<void> {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

beforeEach(() => {
  // 模块级 refCount bus 订阅残留重置：不重置则上一用例组件的 handler 仍挂在 Set 里，
  // 事件会写进旧 pinia 的 store 分区，新用例组件读不到（对齐 useExtensionUI.test.ts）
  __resetExtensionBusSubscriptionForTesting()
  setActivePinia(createPinia())
  commandMock.mockReset()
  mockBus = new InternalEventBus()
  uiTimeoutHandlers.clear()
  vi.mocked(sendExtensionUIResponse).mockClear()
})

describe('PlanReviewBar 四分支显示公式（D5）', () => {
  it('分支④ isActive=false → 整体不渲染（退出后挂起缓存残留由 isActive 门兜住）', async () => {
    // 先挂起请求已入 store（残留面），isActive=false 仍不渲染
    const wrapper = await mountBar(viewOf({ isActive: false }))
    emitPlanReviewRequest('pr-stale')
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-bar"]').exists()).toBe(false)
  })

  it('分支④ 无 view（首拉 null）→ 不渲染', async () => {
    const wrapper = await mountBar(null)
    expect(wrapper.find('[data-testid="plan-review-bar"]').exists()).toBe(false)
  })

  it('分支① isActive + reviewState=awaiting + 有挂起 → 三键全功能 + 评论计数', async () => {
    const wrapper = await mountBar(viewOf({ reviewState: 'awaiting' }))
    emitPlanReviewRequest('pr-1')
    await flushAsync()

    expect(wrapper.find('[data-testid="plan-review-bar"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-review-approve"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-review-revise"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-review-explain"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-review-summary"]').text()).toContain('0 条评论')
  })

  it('分支② reviewState=revising → 修订中状态条，三键不渲染（禁用语义=不可达）', async () => {
    const wrapper = await mountBar(viewOf({ reviewState: 'revising' }))
    emitPlanReviewRequest('pr-1') // race 残留挂起也禁用（安全侧）
    await flushAsync()

    expect(wrapper.find('[data-testid="plan-review-revising"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-review-revising"]').text()).toContain('正在根据评论修订')
    expect(wrapper.find('[data-testid="plan-review-approve"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="plan-review-revise"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="plan-review-explain"]').exists()).toBe(false)
  })

  it('分支③ awaiting 无挂起 → 降级态「等待 agent 重新提交审批」，无三键', async () => {
    const wrapper = await mountBar(viewOf({ reviewState: 'awaiting' }))
    await flushAsync()

    expect(wrapper.find('[data-testid="plan-review-bar"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-review-degraded"]').text()).toContain('等待 agent 重新提交审批')
    expect(wrapper.find('[data-testid="plan-review-approve"]').exists()).toBe(false)
  })

  it('挂起请求独立触发渲染（∪ 半边）：reviewState 无值 + 有挂起 → ready（瞬态 race 收敛）', async () => {
    const wrapper = await mountBar(viewOf()) // 无 reviewState
    emitPlanReviewRequest('pr-1')
    await flushAsync()

    expect(wrapper.find('[data-testid="plan-review-approve"]').exists()).toBe(true)
  })

  it('跨实例共享 store：formFilter 实例入队的表单请求不影响 planReview 枚举', async () => {
    const wrapper = await mountBar(viewOf({ reviewState: 'awaiting' }))
    // 另一消费面实例（Panel inline 表单）注册订阅并入队表单请求
    const sidRef = computed(() => SID)
    const scope = effectScope()
    scope.run(() => useExtensionUI(sidRef, formFilter))
    emitPlanReviewRequest('pr-1')
    mockBus.emit({
      kind: 'ui-request',
      sessionId: SID,
      request: { requestId: 'au-1', pluginId: 'p', kind: 'select', method: 'select', title: 't', askUser: true, askUserQuestions: [] },
    } as never)
    await flushAsync()

    // 审批条只认 planReview 请求（互斥过滤），三键正常
    expect(wrapper.find('[data-testid="plan-review-approve"]').exists()).toBe(true)
    scope.stop()
  })
})

describe('PlanReviewBar 三键 respond payload（PlanReviewResponse 判别联合）', () => {
  it('approve → payload 仅 { decision: "approve" }（结构上无 comments 键），requestId 精确回传', async () => {
    const wrapper = await mountBar(viewOf({ reviewState: 'awaiting' }))
    emitPlanReviewRequest('pr-1')
    await flushAsync()

    await wrapper.find('[data-testid="plan-review-approve"]').trigger('click')

    expect(vi.mocked(sendExtensionUIResponse)).toHaveBeenCalledTimes(1)
    const [, requestId, method, result] = vi.mocked(sendExtensionUIResponse).mock.calls[0]!
    expect(requestId).toBe('pr-1')
    expect(method).toBe('select')
    expect(JSON.parse(result as string)).toEqual({ decision: 'approve' })
    expect('comments' in JSON.parse(result as string)).toBe(false)
  })

  it('approve 终局同样清草稿（C-U2）：跨 plan run 无残留计数，同 session 再次 /plan 不误触 revise', async () => {
    const wrapper = await mountBar(viewOf({ reviewState: 'awaiting' }))
    emitPlanReviewRequest('pr-1')
    await flushAsync()

    const store = usePlanStore()
    store.addDraftComment({ quote: '遗留评论引文', comment: '遗留评语' })
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-summary"]').text()).toContain('1 条评论')

    await wrapper.find('[data-testid="plan-review-approve"]').trigger('click')
    await flushAsync()

    // D6 草稿生命周期到提交为止的终局半边：approve 后草稿清空
    expect(store.draftComments).toHaveLength(0)

    // 跨 run 模拟：同 session 再次 /plan 挂起新审批请求 → 计数归零（旧评论不残留、
    // 不会被误打包进新 run 的 revise payload）
    emitPlanReviewRequest('pr-2')
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-approve"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-review-summary"]').text()).toContain('0 条评论')
  })

  it('revise → comments 打包自草稿快照（{quote, comment} 数组），提交后草稿清空（D6）', async () => {
    const wrapper = await mountBar(viewOf({ reviewState: 'awaiting' }))
    emitPlanReviewRequest('pr-1')
    await flushAsync()

    const store = usePlanStore()
    store.addDraftComment({ quote: '这段推导跳步了', comment: '补充状态机图' })
    store.addDraftComment({ quote: '命名不准确', comment: '改用唯一入口表述' })
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-summary"]').text()).toContain('2 条评论')

    await wrapper.find('[data-testid="plan-review-revise"]').trigger('click')

    const result = JSON.parse(vi.mocked(sendExtensionUIResponse).mock.calls[0]![3] as string)
    expect(result).toEqual({
      decision: 'revise',
      comments: [
        { quote: '这段推导跳步了', comment: '补充状态机图' },
        { quote: '命名不准确', comment: '改用唯一入口表述' },
      ],
    })
    // D6：评论已注入对话流持久，草稿生命周期到提交为止；提交后挂起出队 → 审批条转降级态
    expect(store.draftComments).toHaveLength(0)
    expect(wrapper.find('[data-testid="plan-review-degraded"]').exists()).toBe(true)
  })

  it('explain → { decision: "explain", comments }（不改 reviewState 的解释请求，同款打包）', async () => {
    const wrapper = await mountBar(viewOf({ reviewState: 'awaiting' }))
    emitPlanReviewRequest('pr-1')
    await flushAsync()

    usePlanStore().addDraftComment({ quote: '为什么不用方案 B', comment: '给出取舍依据' })
    await flushAsync()

    await wrapper.find('[data-testid="plan-review-explain"]').trigger('click')

    const result = JSON.parse(vi.mocked(sendExtensionUIResponse).mock.calls[0]![3] as string)
    expect(result).toEqual({
      decision: 'explain',
      comments: [{ quote: '为什么不用方案 B', comment: '给出取舍依据' }],
    })
  })

  it('respond 后挂起请求出队 → 审批条转降级态（awaiting 无挂起）', async () => {
    const wrapper = await mountBar(viewOf({ reviewState: 'awaiting' }))
    emitPlanReviewRequest('pr-1')
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-approve"]').exists()).toBe(true)

    await wrapper.find('[data-testid="plan-review-approve"]').trigger('click')
    await flushAsync()

    expect(wrapper.find('[data-testid="plan-review-degraded"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-review-approve"]').exists()).toBe(false)
  })
})
