/**
 * useExtensionUI planReview 分流单测 —— plan 模式重设计 u1-banner（设计 D5 marker select 通道）。
 *
 * 覆盖（impl-plan u1-banner 验收条款 C4 过滤器面）：
 * - planReview 标记请求入 store（C4 放行），挂起状态按 requestId 可枚举（currentPlanReviewRequests）
 * - 非 form 非 planReview 的 dialog 原语仍不入 store（C4 负向不回归）
 * - planReviewFilter 实例与 formFilter 实例互斥（一请求只归一面；表单类行为无回归）
 * - respond 按 requestId 精确回传 + 出队（planReview 请求面）
 *
 * mock 形态照抄 useExtensionUI.test.ts（真实 InternalEventBus + extension domain mock），
 * 本文件只覆盖 planReview 新增面，T1-T10 既有断言不在此重复。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/use-extension-ui-plan-review.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { effectScope, ref, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { InternalEventBus } from '@taiji/core'

// ── mock extension api domain（照 useExtensionUI.test.ts）──
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

// ── mock getExtensionBus：真实 InternalEventBus 实例 ──
let mockBus: InternalEventBus

vi.mock('@/composables/shell/useExtensionHostBridge', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/composables/shell/useExtensionHostBridge')>()
  return {
    ...original,
    getExtensionBus: () => mockBus,
  }
})

import {
  useExtensionUI,
  formFilter,
  planReviewFilter,
  isPlanReviewRequest,
  __resetExtensionBusSubscriptionForTesting,
} from '@/composables/useExtensionUI'
import { sendExtensionUIResponse } from '@taiji/core/transport/api/domains/extension'
import { useExtensionUIStore } from '@/stores/extension-ui'

/** 在独立 effectScope 内运行，模拟组件实例生命周期 */
function runWithScope<T>(fn: () => T): { result: T; dispose: () => void } {
  const scope = effectScope()
  let result!: T
  scope.run(() => {
    result = fn()
  })
  return { result, dispose: () => scope.stop() }
}

/** planReview 标记请求（runtime event-adapter 检测 PLAN_REVIEW_MARKER 后的广播形状，D5） */
function mkPlanReviewReq(requestId: string): Record<string, unknown> {
  return {
    requestId,
    pluginId: '',
    kind: 'select',
    method: 'select',
    title: '\x00TAIJI_PLAN_REVIEW:',
    options: [JSON.stringify({ docs: [] })],
    planReview: true,
  }
}

function mkAskUserReq(requestId: string): Record<string, unknown> {
  return {
    requestId,
    pluginId: 'p',
    kind: 'select',
    method: 'select',
    title: 't',
    askUser: true,
    askUserQuestions: [{ header: 'q', question: 'q?', options: [] }],
    allowCancel: true,
  }
}

function emitBusUIRequest(sid: string, request: unknown): void {
  mockBus.emit({ kind: 'ui-request', sessionId: sid, request } as never)
}

beforeEach(() => {
  __resetExtensionBusSubscriptionForTesting()
  setActivePinia(createPinia())
  mockBus = new InternalEventBus()
  uiTimeoutHandlers.clear()
  vi.mocked(sendExtensionUIResponse).mockClear()
})

describe('planReview 分流：C4 放行入 store + 挂起可枚举', () => {
  it('planReview 标记请求入 store（C4 放行），planReviewFilter 实例按 requestId 枚举', () => {
    const { result, dispose } = runWithScope(() =>
      useExtensionUI(ref('sess-A'), planReviewFilter),
    )
    const requests = result.currentPlanReviewRequests

    emitBusUIRequest('sess-A', mkPlanReviewReq('pr-1'))

    expect(requests.value).toHaveLength(1)
    expect(requests.value[0]?.requestId).toBe('pr-1')
    expect(isPlanReviewRequest(requests.value[0]!)).toBe(true)
    expect(requests.value[0]?.sessionId).toBe('sess-A')
    // store 分区可查（审批条外其他消费方 / 派生状态可枚举）
    const records = useExtensionUIStore().getRequestsBySession('sess-A')
    expect(records).toHaveLength(1)
    dispose()
  })

  it('非 form 非 planReview 的 dialog 原语不入 store（C4 负向不回归）', () => {
    const { result, dispose } = runWithScope(() =>
      useExtensionUI(ref('sess-A'), planReviewFilter),
    )

    emitBusUIRequest('sess-A', { requestId: 'd1', pluginId: '', kind: 'confirm', method: 'confirm', title: 't' })

    expect(result.currentPlanReviewRequests.value).toHaveLength(0)
    expect(useExtensionUIStore().getRequestsBySession('sess-A')).toHaveLength(0)
    dispose()
  })

  it('formFilter 实例拒绝 planReview 请求（两标记互斥，一请求只归一面）', () => {
    const { result, dispose } = runWithScope(() =>
      useExtensionUI(ref('sess-A'), formFilter),
    )

    emitBusUIRequest('sess-A', mkPlanReviewReq('pr-1'))

    // form 实例不入 planReview 请求，currentFormRequest 不受污染（表单类无回归）
    expect(useExtensionUIStore().getRequestsBySession('sess-A')).toHaveLength(0)
    expect(result.currentFormRequest.value).toBeUndefined()
    dispose()
  })

  it('表单请求不进 planReview 枚举（表单类行为无回归）', () => {
    // 两个消费面实例各持各的 filter：planReviewFilter 实例只枚举 planReview；
    // 表单入队回归由 formFilter 实例承载（互斥过滤是设计语义，不是丢失）
    const review = runWithScope(() => useExtensionUI(ref('sess-A'), planReviewFilter))
    const form = runWithScope(() => useExtensionUI(ref('sess-A'), formFilter))

    emitBusUIRequest('sess-A', mkAskUserReq('au-1'))

    expect(review.result.currentPlanReviewRequests.value).toHaveLength(0)
    expect(form.result.currentFormRequest.value?.requestId).toBe('au-1')
    expect(useExtensionUIStore().getRequestsBySession('sess-A').map((r) => r.requestId)).toEqual(['au-1'])
    review.dispose()
    form.dispose()
  })

  it('respond 按 requestId 精确回传 + 出队；payload 原样透传给 sendExtensionUIResponse', () => {
    const { result, dispose } = runWithScope(() =>
      useExtensionUI(ref('sess-A'), planReviewFilter),
    )

    emitBusUIRequest('sess-A', mkPlanReviewReq('pr-1'))
    expect(result.currentPlanReviewRequests.value).toHaveLength(1)

    const payload = JSON.stringify({ decision: 'approve' })
    result.respond('pr-1', payload)

    expect(vi.mocked(sendExtensionUIResponse)).toHaveBeenCalledWith(
      'sess-A',
      'pr-1',
      'select',
      payload,
    )
    expect(result.currentPlanReviewRequests.value).toHaveLength(0)
    expect(useExtensionUIStore().getRequestsBySession('sess-A')).toHaveLength(0)
    dispose()
  })

  it('切 session 后枚举读新分区（Map 分区语义）', () => {
    const sid = ref<string | null>('sess-A')
    const { result, dispose } = runWithScope(() => useExtensionUI(sid, planReviewFilter))

    emitBusUIRequest('sess-A', mkPlanReviewReq('pr-a'))
    expect(result.currentPlanReviewRequests.value).toHaveLength(1)

    sid.value = 'sess-B'
    expect(result.currentPlanReviewRequests.value).toHaveLength(0)

    sid.value = 'sess-A'
    expect(result.currentPlanReviewRequests.value.map((r) => r.requestId)).toEqual(['pr-a'])
    dispose()
  })
})
