// @vitest-environment node

/**
 * useExtensionUI planReview 分流单测 —— plan 模式状态机显式化（D5 marker select 通道）。
 *
 * 覆盖（impl-plan U4b 验收条款⑥ + 既有 C4 过滤器面）：
 * - planReview 标记请求入 store（C4 放行），挂起状态按 requestId 可枚举（currentPlanReviewRequests）
 * - planReviewFilter 实例与 formFilter 实例互斥（一请求只归一面；表单类行为无回归）
 * - respond 按 requestId 精确回传 + 出队（planReview 请求面）
 * - pickPlanFields 白名单 selfReview 双入店路径契约（D9③）：热帧（bus→toExtensionUIRequest
 *   白名单搬运）与冷补（getPendingRequests 快照全量解包）两路都携带 selfReview——防
 *   「切回 session 有自审行、实时挂起无」半残形态；respond 后置已应答标记（D4 抑制窗①）
 *
 * 非 form 非 planReview dialog 原语不入 store 的 C4 负向由 useExtensionUI.test.ts T2
 * 承载（同一闸口同一 store 面，此处不重复）。
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
const getPendingRequestsMock = vi.hoisted(() => vi.fn())

vi.mock('@taiji/core/transport/api/domains/extension', () => ({
  // 返 true = 送达（M1 环 3 后 respond 消费 boolean）
  sendExtensionUIResponse: vi.fn((): boolean => true),
  onNotify: () => () => {},
  onExtensions: vi.fn(),
  getPendingRequests: getPendingRequestsMock,
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
import { usePlanStore, __resetPlanReviewColdSinkForTesting } from '@/stores/plan-store'

/** 在独立 effectScope 内运行，模拟组件实例生命周期 */
function runWithScope<T>(fn: () => T): { result: T; dispose: () => void } {
  const scope = effectScope()
  let result!: T
  scope.run(() => {
    result = fn()
  })
  return { result, dispose: () => scope.stop() }
}

/** planReview 标记请求（runtime event-adapter 检测 PLAN_REVIEW_MARKER 后的广播形状，D5）；
 *  可带 selfReview（D9③，帧字段与 PlanReviewRequest.selfReview 同名同义） */
function mkPlanReviewReq(requestId: string, selfReview?: string): Record<string, unknown> {
  return {
    requestId,
    pluginId: '',
    kind: 'select',
    dialogKind: 'select',
    title: '\x00TAIJI_PLAN_REVIEW:',
    options: [JSON.stringify({ docs: [], ...(selfReview !== undefined ? { selfReview } : {}) })],
    planReview: true,
    ...(selfReview !== undefined ? { selfReview } : {}),
  }
}

function mkAskUserReq(requestId: string): Record<string, unknown> {
  // runtime ASK_USER_MARKER 分支产出的 view-ready 帧形状（legacy 归一上移 runtime）
  return {
    requestId,
    pluginId: 'p',
    kind: 'select',
    dialogKind: 'select',
    title: 't',
    form: true,
    formQuestions: [{ type: 'text', header: 'q', question: 'q?' }],
    allowCancel: true,
  }
}

function emitBusUIRequest(sid: string, request: unknown): void {
  mockBus.emit({ kind: 'ui-request', sessionId: sid, request } as never)
}

beforeEach(() => {
  __resetExtensionBusSubscriptionForTesting()
  __resetPlanReviewColdSinkForTesting()
  setActivePinia(createPinia())
  mockBus = new InternalEventBus()
  getPendingRequestsMock.mockReset().mockResolvedValue([])
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

describe('pickPlanFields 白名单 selfReview 双入店路径契约（D9③）', () => {
  it('热帧路径：bus → toExtensionUIRequest 白名单搬运携带 selfReview', () => {
    const { result, dispose } = runWithScope(() =>
      useExtensionUI(ref('sess-A'), planReviewFilter),
    )

    emitBusUIRequest('sess-A', mkPlanReviewReq('pr-1', '已核对 3 条需求全覆盖'))

    const req = result.currentPlanReviewRequests.value[0]
    expect(req?.selfReview).toBe('已核对 3 条需求全覆盖')
    expect(useExtensionUIStore().getRequestsBySession('sess-A')[0]).toMatchObject({
      requestId: 'pr-1',
      selfReview: '已核对 3 条需求全覆盖',
    })
    dispose()
  })

  it('热帧路径负向：非 string selfReview 不入店（守卫即透传闸）', () => {
    const { result, dispose } = runWithScope(() =>
      useExtensionUI(ref('sess-A'), planReviewFilter),
    )

    emitBusUIRequest('sess-A', { ...mkPlanReviewReq('pr-1'), selfReview: 42 })

    const req = result.currentPlanReviewRequests.value[0] as { selfReview?: unknown } | undefined
    expect(req?.selfReview).toBeUndefined()
    dispose()
  })

  it('冷补路径：getPendingRequests 快照全量解包携带 selfReview（切回 session 不丢自审行）', async () => {
    getPendingRequestsMock.mockResolvedValue([
      { ...mkPlanReviewReq('pr-cold', '冷补自审结论'), receivedAt: Date.now() },
    ])
    const { result, dispose } = runWithScope(() =>
      useExtensionUI(ref('sess-A'), planReviewFilter),
    )
    await Promise.resolve()
    await Promise.resolve()
    await nextTick()

    const req = result.currentPlanReviewRequests.value[0]
    expect(req?.requestId).toBe('pr-cold')
    expect(req?.selfReview).toBe('冷补自审结论')
    dispose()
  })
})

describe('D4 审批窗口漏斗接线（respond/失效置已应答标记；pending 到达解除）', () => {
  it('respond（planReview）→ markPlanReviewAnswered 置已应答标记；非 planReview respond 不置', () => {
    const plan = usePlanStore()
    plan.syncFocus('sess-A') // 窗口位断言读焦点分区（usePlanState 的 syncFocus 义务，本文件直驱）
    const { result, dispose } = runWithScope(() =>
      useExtensionUI(ref('sess-A'), planReviewFilter),
    )

    emitBusUIRequest('sess-A', mkPlanReviewReq('pr-1'))
    expect(plan.planReviewAckMarked).toBe(false)

    result.respond('pr-1', JSON.stringify({ decision: 'dismiss' }))
    expect(plan.planReviewAckMarked).toBe(true)

    // 新 planReview pending 到达 → 解除（ready 优先于抑制）
    emitBusUIRequest('sess-A', mkPlanReviewReq('pr-2'))
    expect(plan.planReviewAckMarked).toBe(false)
    dispose()
  })

  it('requestsInvalidated 摘除 planReview → 同置已应答标记（turn abort / /plan abort 解散源）', () => {
    const plan = usePlanStore()
    plan.syncFocus('sess-A')
    runWithScope(() => useExtensionUI(ref('sess-A'), planReviewFilter))

    emitBusUIRequest('sess-A', mkPlanReviewReq('pr-1'))
    mockBus.emit({ kind: 'requests-invalidated', sessionId: 'sess-A', requestIds: ['pr-1'], reason: 'turn-aborted' } as never)

    expect(plan.planReviewAckMarked).toBe(true)
  })

  it('多挂起异常形态：respond 其中一条 → 镜像按 registry 现值保持 true + 已应答标记置起', () => {
    const plan = usePlanStore()
    plan.syncFocus('sess-A')
    const { result, dispose } = runWithScope(() =>
      useExtensionUI(ref('sess-A'), planReviewFilter),
    )

    emitBusUIRequest('sess-A', mkPlanReviewReq('pr-1'))
    emitBusUIRequest('sess-A', mkPlanReviewReq('pr-2'))
    result.respond('pr-1', JSON.stringify({ decision: 'dismiss' }))

    // registry 仍有 pr-2 → 镜像保持 true（markPlanReviewAnswered 不得覆写为 false）
    expect(result.currentPlanReviewRequests.value.map((r) => r.requestId)).toEqual(['pr-2'])
    expect(plan.planReviewPendingKnown).toBe(true)
    expect(plan.planReviewAckMarked).toBe(true)
    dispose()
  })
})
