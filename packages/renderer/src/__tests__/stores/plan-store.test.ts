// @vitest-environment node

/**
 * plan store 单测 —— plan 模式状态机显式化（D1/D2/D4）：状态、推导与审批窗口机件。
 *
 * 覆盖（impl-plan U4b 验收条款 + S15 renderer 断言族）：
 * - derivePlanStage 重写（derivePhase 单点接线）：① exploring / ② writing（含 revising 归
 *   规划中档）/ ③ reviewing / ③✓ approved（D5 阶段不倒退，F5）
 * - state 读侧解析（resolvePlanLifecycleState：归一 View 的 state 直读 + 值域守卫，缺失/
 *   垃圾落 idle——批次 3 条目 1 删除混装兜底后的声明例外锚；resolveResumeHint：直读）
 * - D4 分支公式单源（derivePlanReviewBarMode）：presence 语义 / 抑制窗 / 稳定窗输入面
 * - 审批窗口机件：已应答标记三路解除（预期后态帧值判定 / 新 pending / 冷拉真值）、迟到旧帧
 *   不解标记、稳定窗 arm/cancel·重置、10s 兑底双源冷拉（失败 → 标记悬挂 + loadError（R7）；
 *   成功 → 真值解除 + 冷拉豁免直通 + sink 再入店）
 * - D8 检测窗相位机（dmg-r1-2）：send resolve 只进 armed（前置在途 turn 终态不判定）、
 *   nudge 轮 message_start 才开 watching、send.rejected 不受起点标记门
 * - 辅助表迟到写拦截（D-B2-1 口径延伸，dmg-r1-3）：cleanup 后迟到 applyFrame /
 *   活动信号不复活 frameRevs / edgeFrameRevs / activityReconcileAt 条目
 * - 首拉成功/置空/失败、陈旧首拉守卫、applyFrame 分区写、评论草稿、enter 翻转清、
 *   草稿回看（历史族，行为不变）
 *
 * 范式照抄 subagent.test.ts（pinia setActivePinia 每 case 重建）+ gen-stats-composable.test.ts
 * 的 mock 边界（spread actual 保真实 events 通道，只换 command）。
 * 断言经 storeToRefs（pinia setup store 的 computed 经 store 实例访问已解包，.value 是 undefined）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/stores/plan-store.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { storeToRefs } from 'pinia'
import {
  triggerSessionCleanups,
  __clearSessionCleanupRegistryForTest,
} from '@/composables/useSessionScopedState'
import {
  usePlanStore,
  derivePlanStage,
  derivePlanReviewBarMode,
  resolvePlanLifecycleState,
  resolveResumeHint,
  registerPlanReviewColdSink,
  __resetPlanReviewColdSinkForTesting,
  PLAN_REVIEW_DEGRADED_STABLE_MS,
  PLAN_REVIEW_ACK_FALLBACK_MS,
  type PlanReviewComment,
} from '@/stores/plan-store'
import type { PlanDocMeta, PlanStateView } from '@taiji/shared'
import type { ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension'

// ── mock 边界：getPlanState RPC mock 掉（runtime 侧 u1-rpc 未接线，用受控 deferred 驱动）──
// spread actual 保留 events 真实通道与 transport 其余面（本文件不 mount，不依赖 events；
// 与 use-plan-sync.test.ts 共用同一 mock 形态，防两文件对同模块的 mock 形状漂移）
const commandMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api', async (importActual) => {
  const actual = await importActual<typeof import('@taiji/core/transport/api')>()
  return { ...actual, command: commandMock, RPC_BACKSTOP_TIMEOUT_MS: 30_000 }
})

// ── mock 边界②：extension domain（D4③ 冷拉双源之一 getPendingRequests）——受控返回/拒绝 ──
const getPendingRequestsMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api/domains/extension', () => ({
  getPendingRequests: getPendingRequestsMock,
}))

import { RPC_BACKSTOP_TIMEOUT_MS } from '@taiji/core/transport/api'

// ── 共享测试基建 ─────────────────────────────────────────────

const BASE_VIEW: PlanStateView = {
  isActive: true,
  planFilePath: '/data/A/.tmp/plans/auth/plan.md',
  requirement: '重构 auth 模块',
  templateName: 'default',
  state: 'planning',
}

const DOC: PlanDocMeta = {
  fileName: 'design.md',
  absPath: '/data/A/.tmp/plans/auth/design.md',
  sourceSkill: 'tech-design',
  version: 1,
}

/** store + storeToRefs 一起取（断言经 refs.value；store 实例访问 computed 已解包）。 */
function usePlanRefs() {
  const store = usePlanStore()
  return { store, ...storeToRefs(store) }
}

/** 在途 RPC 的受控 deferred（mock 发起时登记） */
interface PendingRpc {
  sid: string
  resolve: (v: { sessionId: string; planState: PlanStateView }) => void
  reject: (e: unknown) => void
}

let pendingRpcs: PendingRpc[] = []

function resolveForSid(sid: string, reply: { sessionId: string; planState: PlanStateView }): void {
  const idx = pendingRpcs.findIndex((e) => e.sid === sid)
  if (idx < 0) throw new Error(`测试编排错误：sid ${sid} 无在途 RPC`)
  const [entry] = pendingRpcs.splice(idx, 1)
  entry.resolve(reply)
}

/** reject 指定 sid 最晚登记的在途 RPC（多轮切入后失败分支针对最新一次首拉） */
function rejectLatestForSid(sid: string, err: unknown): void {
  const idx = pendingRpcs.map((e) => e.sid).lastIndexOf(sid)
  if (idx < 0) throw new Error(`测试编排错误：sid ${sid} 无在途 RPC`)
  const [entry] = pendingRpcs.splice(idx, 1)
  entry.reject(err)
}

/** 排空在途异步链（promise 链 → 写分区） */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  pendingRpcs = []
  commandMock.mockReset()
  commandMock.mockImplementation(
    (_type: string, payload: { sessionId: string }) =>
      new Promise<{ sessionId: string; planState: PlanStateView }>((resolve, reject) => {
        pendingRpcs.push({ sid: payload.sessionId, resolve, reject })
      }),
  )
  getPendingRequestsMock.mockReset().mockResolvedValue([])
  setActivePinia(createPinia())
  __clearSessionCleanupRegistryForTest()
  __resetPlanReviewColdSinkForTesting()
})

afterEach(() => {
  vi.useRealTimers()
})

// ── 阶段推导（D1 derivePhase 单点接线 + D5 已批准档）──────────

describe('derivePlanStage：derivePhase 单点接线（consumers.md §三 C）', () => {
  it('① 需求探索 = phase planning ∧ 无 docs（docs 缺省与空数组两形态）', () => {
    expect(derivePlanStage(BASE_VIEW)).toBe('exploring')
    expect(derivePlanStage({ ...BASE_VIEW, docs: [] })).toBe('exploring')
  })

  it('② 文档撰写 = phase planning ∧ docs ≥ 1；revising 归规划中档（D1：规划中 = planning|revising）', () => {
    expect(derivePlanStage({ ...BASE_VIEW, docs: [DOC] })).toBe('writing')
    expect(derivePlanStage({ ...BASE_VIEW, docs: [DOC, DOC] })).toBe('writing')
    expect(derivePlanStage({ ...BASE_VIEW, docs: [DOC], state: 'revising' })).toBe('writing')
  })

  it('③ 审阅确认 = phase reviewing（state 直读）', () => {
    expect(derivePlanStage({ ...BASE_VIEW, docs: [DOC], state: 'reviewing' })).toBe('reviewing')
    // 异常组合防御：state=reviewing 但 docs 空——③ 公式不含 docs 条件
    expect(derivePlanStage({ ...BASE_VIEW, state: 'reviewing' })).toBe('reviewing')
  })

  it('③✓ 已批准档 = phase approved（approved/dispatching，D5 阶段不倒退——F5 不复活）', () => {
    expect(derivePlanStage({ ...BASE_VIEW, docs: [DOC], state: 'approved' })).toBe('approved')
    // 执行方式表单挂起期间（dispatching）不再打回 ②文档撰写（F5 病灶形态）
    expect(derivePlanStage({ ...BASE_VIEW, docs: [DOC], state: 'dispatching' })).toBe('approved')
  })

  it('state 缺失格（旧 runtime 混装降级）不外显阶段指示', () => {
    // 批次 3 条目 1：混装兜底映射删除后，state 缺失落 idle → 阶段不外显（原按 isActive
    // 推断 planning 的行为已随条目 1 声明的例外退役）
    const { state: _omitted, ...noStateView } = BASE_VIEW
    expect(derivePlanStage({ ...noStateView, docs: [DOC] })).toBeNull()
  })

  it('isActive=false（退出/执行后 reset 终态）或无 view → null；终态/垃圾 state 不外显', () => {
    expect(derivePlanStage(null)).toBeNull()
    expect(derivePlanStage({ ...BASE_VIEW, isActive: false, state: 'exited' })).toBeNull()
    expect(derivePlanStage({ ...BASE_VIEW, isActive: false, docs: [DOC], state: 'reviewing' })).toBeNull()
    expect(derivePlanStage({ ...BASE_VIEW, state: 'completed' })).toBeNull()
    expect(derivePlanStage({ ...BASE_VIEW, state: 'exited' })).toBeNull()
    // 垃圾 state + isActive=true → 落 idle（条目 1 声明例外：原经 isActive 推断呈 exploring）
    expect(derivePlanStage({ ...BASE_VIEW, state: 'garbage' as never })).toBeNull()
  })
})

// ── state 读侧解析（resolvePlanLifecycleState / resolveResumeHint）──

describe('state 读侧解析（归一 View 直读；缺失/垃圾统一落 idle）', () => {
  it('state 直读（归一 View 恒携带的值域白名单字段）', () => {
    expect(resolvePlanLifecycleState({ ...BASE_VIEW, state: 'dispatching' })).toBe('dispatching')
    expect(resolvePlanLifecycleState(BASE_VIEW)).toBe('planning')
    expect(resolvePlanLifecycleState({ ...BASE_VIEW, state: 'exited' })).toBe('exited')
    expect(resolvePlanLifecycleState(null)).toBe('idle')
  })

  it('垃圾 state 值 + isActive=true → idle（条目 1 声明行为例外：原经 isActive 推断呈 planning）', () => {
    expect(resolvePlanLifecycleState({ ...BASE_VIEW, state: 'garbage' as never })).toBe('idle')
  })

  it('state 缺失 → idle（不再按 reviewState 映射 / isActive 推断——混装兜底已删）', () => {
    const { state: _omitted, ...noStateView } = BASE_VIEW
    expect(resolvePlanLifecycleState(noStateView)).toBe('idle')
    expect(resolvePlanLifecycleState({ ...noStateView, isActive: false })).toBe('idle')
  })

  it('resolveResumeHint：resumeHint 直读；其余/缺省不猜测来源', () => {
    expect(resolveResumeHint({ ...BASE_VIEW, resumeHint: 'resubmit' })).toBe('resubmit')
    expect(resolveResumeHint(BASE_VIEW)).toBeUndefined()
    expect(resolveResumeHint(null)).toBeUndefined()
  })
})

// ── D4 分支公式单源（derivePlanReviewBarMode）──────────────

describe('derivePlanReviewBarMode：D4 分支公式单源（presence 语义）', () => {
  const base = { isActive: true, hasPending: false, state: 'reviewing' as const, ackMarked: false, degradedGate: true }

  it('ready ⇔ 挂起存在且恒优先（presence）：压制标记 / revising 态均不压 ready', () => {
    expect(derivePlanReviewBarMode({ ...base, hasPending: true })).toBe('ready')
    expect(derivePlanReviewBarMode({ ...base, hasPending: true, ackMarked: true })).toBe('ready')
    expect(derivePlanReviewBarMode({ ...base, hasPending: true, state: 'revising' })).toBe('ready')
  })

  it('已应答抑制窗压制 state 判定分支（degraded/revising）', () => {
    expect(derivePlanReviewBarMode({ ...base, ackMarked: true })).toBeNull()
    expect(derivePlanReviewBarMode({ ...base, ackMarked: true, state: 'revising' })).toBeNull()
  })

  it('revising ⇔ state=revising（无挂起无压制）；degraded ⇔ reviewing ∧ 稳定窗放行', () => {
    expect(derivePlanReviewBarMode({ ...base, state: 'revising' })).toBe('revising')
    expect(derivePlanReviewBarMode(base)).toBe('degraded')
    expect(derivePlanReviewBarMode({ ...base, degradedGate: false })).toBeNull()
  })

  it('dispatching/approved 不进审批条；isActive=false 恒不渲染', () => {
    expect(derivePlanReviewBarMode({ ...base, state: 'dispatching' })).toBeNull()
    expect(derivePlanReviewBarMode({ ...base, state: 'approved' })).toBeNull()
    expect(derivePlanReviewBarMode({ ...base, isActive: false, hasPending: true })).toBeNull()
  })
})

// ── 审批窗口机件（D4 抑制窗 / 稳定窗 / 冷拉对账）─────────────

describe('审批窗口机件（D4）', () => {
  /** planReview 帧记录（冷拉 getPendingRequests 快照形态） */
  function planReviewRecord(requestId: string): ExtensionUIRequest {
    return { sessionId: 'A', requestId, method: 'select', planReview: true } as unknown as ExtensionUIRequest
  }

  function mountStore(): ReturnType<typeof usePlanRefs> {
    const refs = usePlanRefs()
    refs.store.syncFocus('A')
    return refs
  }

  it('已应答标记：markPlanReviewAnswered 置起；预期后态帧（state ≠ reviewing）值判定解除', () => {
    const { store, planReviewAckMarked } = mountStore()
    store.applyFrame('A', { ...BASE_VIEW, state: 'reviewing' })
    store.markPlanReviewAnswered('A')
    expect(planReviewAckMarked.value).toBe(true)

    // 迟到旧帧（值仍是 reviewing）不解标记（D4②：按帧内值判定，不按任意帧到达）
    store.applyFrame('A', { ...BASE_VIEW, state: 'reviewing' })
    expect(planReviewAckMarked.value).toBe(true)

    // 预期后态帧（dismiss/review_aborted→planning）→ 解除
    store.applyFrame('A', { ...BASE_VIEW, state: 'planning' })
    expect(planReviewAckMarked.value).toBe(false)
  })

  it('新 planReview pending 登记到达同样解除标记（ready 优先于抑制）', () => {
    const { store, planReviewAckMarked } = mountStore()
    store.applyFrame('A', { ...BASE_VIEW, state: 'reviewing' })
    store.markPlanReviewAnswered('A')
    expect(planReviewAckMarked.value).toBe(true)

    store.setPlanReviewPending('A', true)
    expect(planReviewAckMarked.value).toBe(false)
  })

  it('多挂起镜像一致性：markPlanReviewAnswered 不覆写镜像真值（registry 仍有挂起时保持 true）', () => {
    const { store, planReviewPendingKnown, planReviewAckMarked } = mountStore()
    // 多挂起异常形态：registry 两条挂起入店 → 消费其中一条（respond/失效）置已应答标记，
    // 镜像必须保持 registry 现值 true（不被无条件置 false 打假——漏斗自述不变量）
    store.setPlanReviewPending('A', true)
    store.markPlanReviewAnswered('A')
    expect(planReviewPendingKnown.value).toBe(true)
    expect(planReviewAckMarked.value).toBe(true)
  })

  it('D8 检测窗相位机：send resolve 只进 armed（前置在途 turn 终态不判定），message_start 才开窗，watching 下终态判未响应', () => {
    const { store, planReviewNudgePhase, planReviewNudgeError } = mountStore()
    // 未点重提（idle）→ turn 终态信号 no-op（不误报）
    store.endPlanReviewNudge('A', 'no-response')
    expect(planReviewNudgeError.value).toBeNull()

    // send resolve → armed（只武装不开窗，清旧错误）
    store.beginPlanReviewNudge('A')
    expect(planReviewNudgePhase.value).toBe('armed')
    // busy defer 形态：armed 阶段到达的 message.complete / message.error 属于前置在途
    // turn（先于 nudge 轮起点标记）→ 不判定、不落错误（dmg-r1-2）
    store.endPlanReviewNudge('A', 'no-response')
    expect(planReviewNudgePhase.value).toBe('armed')
    expect(planReviewNudgeError.value).toBeNull()

    // nudge 轮自身的 message_start 到达 → 开判定窗（watching）
    store.markPlanReviewNudgeTurnStart('A')
    expect(planReviewNudgePhase.value).toBe('watching')
    // 此后 turn 结束未重挂 → 落错误行
    store.endPlanReviewNudge('A', 'no-response')
    expect(planReviewNudgePhase.value).toBe('idle')
    expect(planReviewNudgeError.value).toBe('no-response')

    // 重试成功形态：armed → 重挂到达（setPlanReviewPending(true) 内含收口：关窗 + 清错误）
    store.beginPlanReviewNudge('A')
    store.setPlanReviewPending('A', true)
    expect(planReviewNudgePhase.value).toBe('idle')
    expect(planReviewNudgeError.value).toBeNull()
    // 已收口后的 turn 信号不再误报
    store.endPlanReviewNudge('A', 'no-response')
    expect(planReviewNudgeError.value).toBeNull()
  })

  it('D8 起点标记相位门：idle / watching 下的 message_start no-op（他人消息开轮不误开窗、轮内后续消息段不重入）', () => {
    const { store, planReviewNudgePhase } = mountStore()
    // idle：无在途 nudge，起点标记 no-op
    store.markPlanReviewNudgeTurnStart('A')
    expect(planReviewNudgePhase.value).toBe('idle')

    // watching：轮已开（首个 message_start 已消费），轮内后续 assistant 消息段再到达不重入
    store.beginPlanReviewNudge('A')
    store.markPlanReviewNudgeTurnStart('A')
    store.markPlanReviewNudgeTurnStart('A')
    expect(planReviewNudgePhase.value).toBe('watching')
  })

  it('send.rejected（预检拒绝未进轮）不受起点标记门：armed / watching 均落错误行，idle no-op', () => {
    const { store, planReviewNudgePhase, planReviewNudgeError } = mountStore()
    // idle（无在途 nudge，他人发送被拒）→ no-op，不误写审批条错误行
    store.rejectPlanReviewNudge('A', 'no-response')
    expect(planReviewNudgeError.value).toBeNull()

    // armed（busy 拒绝的 defer 重投再拒形态）→ 判未响应
    store.beginPlanReviewNudge('A')
    store.rejectPlanReviewNudge('A', 'no-response')
    expect(planReviewNudgePhase.value).toBe('idle')
    expect(planReviewNudgeError.value).toBe('no-response')

    // watching（nudge 轮开后的拒绝）→ 同判
    store.setPlanReviewNudgeError('A', null)
    store.beginPlanReviewNudge('A')
    store.markPlanReviewNudgeTurnStart('A')
    store.rejectPlanReviewNudge('A', 'no-response')
    expect(planReviewNudgeError.value).toBe('no-response')
  })

  it('稳定窗 arm/cancel·重置（fake timers）：组合持续 ≥2s 放行；中途变假重置，再转真重新计满', async () => {
    vi.useFakeTimers()
    const { store, planReviewDegradedGate } = mountStore()
    store.applyFrame('A', { ...BASE_VIEW, state: 'reviewing' })
    expect(planReviewDegradedGate.value).toBe(false)
    await vi.advanceTimersByTimeAsync(PLAN_REVIEW_DEGRADED_STABLE_MS - 1)
    expect(planReviewDegradedGate.value).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(planReviewDegradedGate.value).toBe(true)

    // 变假（挂起到达）→ cancel·重置；再转真 → 重新计满 2s 才放行
    store.setPlanReviewPending('A', true)
    expect(planReviewDegradedGate.value).toBe(false)
    store.setPlanReviewPending('A', false)
    await vi.advanceTimersByTimeAsync(PLAN_REVIEW_DEGRADED_STABLE_MS - 1)
    expect(planReviewDegradedGate.value).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(planReviewDegradedGate.value).toBe(true)
  })

  it('冷拉失败（R7 失败分支）→ 标记悬挂不解除 + loadError 呈现', async () => {
    vi.useFakeTimers()
    const { store, planReviewAckMarked, planReviewDegradedGate, planLoadError } = mountStore()
    store.applyFrame('A', { ...BASE_VIEW, state: 'reviewing' })
    store.markPlanReviewAnswered('A')
    commandMock.mockReset().mockRejectedValue(new Error('ws closed'))
    getPendingRequestsMock.mockReset().mockRejectedValue(new Error('ws closed'))

    await vi.advanceTimersByTimeAsync(PLAN_REVIEW_ACK_FALLBACK_MS)
    await vi.advanceTimersByTimeAsync(0)

    // 标记悬挂（审批条保持不渲染——fail-safe 不误导）+ loadError 既有错误通路
    expect(planReviewAckMarked.value).toBe(true)
    expect(planReviewDegradedGate.value).toBe(false)
    expect(planLoadError.value).toContain('ws closed')
  })

  it('冷拉真值（reviewing ∧ 无挂起）→ 解除标记 + 冷拉豁免稳定窗直通', async () => {
    vi.useFakeTimers()
    const { store, planReviewAckMarked, planReviewDegradedGate } = mountStore()
    store.applyFrame('A', { ...BASE_VIEW, state: 'reviewing' })
    store.markPlanReviewAnswered('A')
    commandMock.mockReset().mockResolvedValue({ sessionId: 'A', planState: { ...BASE_VIEW, state: 'reviewing' } })
    getPendingRequestsMock.mockReset().mockResolvedValue([])

    await vi.advanceTimersByTimeAsync(PLAN_REVIEW_ACK_FALLBACK_MS)
    await vi.advanceTimersByTimeAsync(0)

    expect(planReviewAckMarked.value).toBe(false)
    // 冷拉真值豁免稳定窗：对账结果即事实，直接放行（不再等 2s）
    expect(planReviewDegradedGate.value).toBe(true)
  })

  it('冷拉真值（pending 在场）→ 真值解除标记 + sink 再入店 registry（呈 ready 权威优先）', async () => {
    vi.useFakeTimers()
    const sinkRecords: ExtensionUIRequest[][] = []
    registerPlanReviewColdSink((sid, records) => {
      expect(sid).toBe('A')
      sinkRecords.push(records)
    })
    const { store, planReviewAckMarked } = mountStore()
    store.applyFrame('A', { ...BASE_VIEW, state: 'reviewing' })
    store.markPlanReviewAnswered('A')
    commandMock.mockReset().mockResolvedValue({ sessionId: 'A', planState: { ...BASE_VIEW, state: 'reviewing' } })
    getPendingRequestsMock.mockReset().mockResolvedValue([planReviewRecord('pr-cold'), { ...planReviewRecord('form-1'), planReview: false }])

    await vi.advanceTimersByTimeAsync(PLAN_REVIEW_ACK_FALLBACK_MS)
    await vi.advanceTimersByTimeAsync(0)

    expect(planReviewAckMarked.value).toBe(false)
    // 只有 planReview 记录入店（form 键不归审批条）
    expect(sinkRecords).toHaveLength(1)
    expect(sinkRecords[0]!.map((r) => r.requestId)).toEqual(['pr-cold'])
  })
})

// ── 首拉 RPC（成功 / 空响应置空 / 失败错误通路）──────────────

describe('loadPlanState：首拉与错误通路', () => {
  it('首拉成功 → reply.planState 写入焦点 sid 分区（updateFor），RPC 参数带超时', async () => {
    const { store, planView, planStage, planLoadError } = usePlanRefs()
    store.syncFocus('A')
    void store.loadPlanState('A')
    expect(commandMock).toHaveBeenCalledWith(
      'session.getPlanState',
      { sessionId: 'A' },
      RPC_BACKSTOP_TIMEOUT_MS,
    )
    resolveForSid('A', { sessionId: 'A', planState: { ...BASE_VIEW, docs: [DOC] } })
    await settle()

    expect(planView.value?.docs?.length).toBe(1)
    expect(planStage.value).toBe('writing')
    expect(planLoadError.value).toBeNull()
  })

  it('响应空/无 planState = 无 plan 状态，分区 view 置空', async () => {
    const { store, planView, planStage } = usePlanRefs()
    store.syncFocus('A')
    // 先建立非空 view（帧路径），再首拉到空响应
    store.applyFrame('A', { ...BASE_VIEW, docs: [DOC] })
    expect(planView.value).not.toBeNull()

    void store.loadPlanState('A')
    resolveForSid('A', {
      sessionId: 'A',
      planState: null,
    } as unknown as { sessionId: string; planState: PlanStateView })
    await settle()

    expect(planView.value).toBeNull()
    expect(planStage.value).toBeNull()
  })

  it('RPC 失败（reply success=false → command reject）→ 错误落分区 loadError，view 不被覆盖', async () => {
    const { store, planView, planLoadError } = usePlanRefs()
    store.syncFocus('A')
    // 先建立非空 view，再触发失败首拉（失败兜底显示语义）
    store.applyFrame('A', { ...BASE_VIEW, docs: [DOC] })

    void store.loadPlanState('A')
    rejectLatestForSid('A', new Error('session not found'))
    await settle()

    expect(planLoadError.value).toBe('session not found')
    // 失败不覆盖现有分区 view（subagent loadSubagents M1 同款）
    expect(planView.value?.docs?.length).toBe(1)
  })
})

// ── 陈旧首拉守卫（F-R2-1：首拉空 reply 晚于 live 帧 → 丢弃，不倒拨热状态）──

describe('陈旧首拉守卫（F-R2-1：冷回填不倒拨 live 帧）', () => {
  it('归因场景：首拉在途 → 帧先达（view=active）→ 迟到的空 reply 丢弃，view 保持 active', async () => {
    const { store, planView, planStage, planLoadError } = usePlanRefs()
    store.syncFocus('A')
    // 首拉发出（base rev 记录），reply 悬挂——模拟 runtime 冷腿慢（scanSessions 全目录重扫）
    void store.loadPlanState('A')
    // live 帧在请求在途窗口内到达（/plan 毫秒级落盘 entry → 300ms 防抖 → publish）
    store.applyFrame('A', { ...BASE_VIEW, docs: [DOC] })
    expect(planView.value?.isActive).toBe(true)

    // 迟到的首拉 reply：冷读早于 entry 落盘 → 空（INACTIVE）
    resolveForSid('A', {
      sessionId: 'A',
      planState: null,
    } as unknown as { sessionId: string; planState: PlanStateView })
    await settle()

    // 守卫生效：view 不被倒拨回空（bar 90s 不显形的根因消除）
    expect(planView.value?.isActive).toBe(true)
    expect(planView.value?.docs?.length).toBe(1)
    expect(planStage.value).toBe('writing')
    expect(planLoadError.value).toBeNull()
  })

  it('失败分支同守卫：首拉在途窗口内帧到达 → 迟到的 reject 丢弃，不误写 loadError', async () => {
    const { store, planView, planLoadError } = usePlanRefs()
    store.syncFocus('A')
    void store.loadPlanState('A')
    store.applyFrame('A', { ...BASE_VIEW })

    rejectLatestForSid('A', new Error('stale failure'))
    await settle()

    expect(planView.value?.isActive).toBe(true)
    expect(planLoadError.value).toBeNull()
  })

  it('正常序不误伤：reply（空）先于帧到达 → 置空生效，随后帧照常写入', async () => {
    const { store, planView } = usePlanRefs()
    store.syncFocus('A')
    void store.loadPlanState('A')
    resolveForSid('A', {
      sessionId: 'A',
      planState: null,
    } as unknown as { sessionId: string; planState: PlanStateView })
    await settle()
    expect(planView.value).toBeNull()

    // 帧晚于 reply：applyFrame 不经守卫，live 权威照常落地
    store.applyFrame('A', { ...BASE_VIEW })
    expect(planView.value?.isActive).toBe(true)
  })

  it('新一轮重拉不受上轮丢弃误伤：帧失效请求 1 → 请求 2（新基准）reply 正常回填', async () => {
    const { store, planView } = usePlanRefs()
    store.syncFocus('A')
    // 请求 1：切会话首拉（空启动）
    void store.loadPlanState('A')
    // 在途窗口帧到达 → 请求 1 失效
    store.applyFrame('A', { ...BASE_VIEW, isActive: false })

    // 请求 2：切回重拉（新基准，晚于帧）
    void store.loadPlanState('A')

    // FIFO 到达序（对齐真机）：请求 1 的迟到空 reply 先到 → 丢弃
    resolveForSid('A', {
      sessionId: 'A',
      planState: null,
    } as unknown as { sessionId: string; planState: PlanStateView })
    await settle()
    expect(planView.value?.isActive).toBe(false) // 帧 view 未被倒拨

    // 请求 2 的 reply 后到：新基准放行，正常回填
    resolveForSid('A', { sessionId: 'A', planState: { ...BASE_VIEW, docs: [DOC] } })
    await settle()
    expect(planView.value?.isActive).toBe(true)
    expect(planView.value?.docs?.length).toBe(1)
  })

  it('cleanup 链同步清帧版本：session 销毁后重建分区，首拉回填不受残留版本影响', async () => {
    const { store, planView } = usePlanRefs()
    store.syncFocus('A')
    void store.loadPlanState('A')
    store.applyFrame('A', { ...BASE_VIEW })

    triggerSessionCleanups('A')
    await settle()

    // 分区已重置；cleanup 前在途请求的版本表条目已随 cleanup 删除 → 迟到 reply 丢弃，
    // 不写进已重置的分区
    store.syncFocus('A')
    expect(planView.value).toBeNull()
    resolveForSid('A', {
      sessionId: 'A',
      planState: null,
    } as unknown as { sessionId: string; planState: PlanStateView })
    await settle()
    expect(planView.value).toBeNull()

    // 销毁后重新首拉：版本表已清（新基准），reply 正常回填
    void store.loadPlanState('A')
    resolveForSid('A', { sessionId: 'A', planState: { ...BASE_VIEW } })
    await settle()
    expect(planView.value?.isActive).toBe(true)
  })

  it('辅助表迟到写拦截（D-B2-1 口径延伸）：cleanup 后迟到 applyFrame 不复活 frameRevs 条目，旧生命周期在途 reply 不写进同 id 重建分区', async () => {
    const { store, planView } = usePlanRefs()
    store.syncFocus('A')
    store.applyFrame('A', { ...BASE_VIEW, docs: [DOC] }) // rev=1，view 就绪
    // 旧生命周期的首拉在途（reply 跨 cleanup 到达）
    void store.loadPlanState('A') // baseRev=1
    triggerSessionCleanups('A')
    await settle()

    // WS 退订窗口内的迟到 live 帧：updateFor 分区写被工厂拦截，frameRevs 的递增也须
    // 同口径拦截——若未拦截，rev 条目复活回 1，下方旧 reply 的陈旧判定被伪解除
    store.applyFrame('A', { ...BASE_VIEW })

    // 同 id 重建（重导入形态）：current 重新 init 出列，view 从空起步
    store.syncFocus('A')
    expect(planView.value).toBeNull()

    // 旧生命周期在途 reply 到达：迟到帧被拦截（rev 保持 cleanup 清除态，0 ≠ baseRev 1）
    // → 陈旧守卫丢弃，不写进新生命周期分区；未拦截形态下 rev=1 === baseRev 伪解除 →
    // 僵尸 reply 写入新分区（docs 1），断言即红
    resolveForSid('A', { sessionId: 'A', planState: { ...BASE_VIEW, docs: [DOC] } })
    await settle()
    expect(planView.value).toBeNull()

    // 新生命周期重新首拉：正常回填（拦截不误伤健康路径）
    void store.loadPlanState('A')
    resolveForSid('A', { sessionId: 'A', planState: { ...BASE_VIEW, docs: [DOC] } })
    await settle()
    expect(planView.value?.docs?.length).toBe(1)
  })

  it('辅助表迟到写拦截（D-B2-1 口径延伸）：cleanup 后迟到活动信号不重建 edgeFrameRevs/activityReconcileAt，不触发补拉', async () => {
    const { store } = usePlanRefs()
    store.syncFocus('A')
    store.applyFrame('A', { ...BASE_VIEW, docs: [DOC] })
    triggerSessionCleanups('A')
    await settle()

    // 迟到活动信号 ×2：若未拦截，第一次会重建 edgeFrameRevs('A'→0)，第二次因「边沿间
    // frameRev 零增长」通过帧进展门 + 冷却表空 → 触发补拉 RPC（零 RPC 断言拦截生效）
    store.reconcileOnAssistantMessage('A')
    store.reconcileOnAssistantMessage('A')
    await settle()

    expect(commandMock).not.toHaveBeenCalled()
  })
})

// ── WS 帧落地（updateFor 分区写）────────────────────────────

describe('applyFrame：updateFor 分区写', () => {
  it('帧写入指定 sid 分区，不依赖焦点；state 驱动阶段流转', () => {
    const { store, planView, planStage } = usePlanRefs()
    // 焦点在 B，A 的帧写入 A 分区（B 分区不受影响）
    store.syncFocus('B')
    store.applyFrame('A', { ...BASE_VIEW, docs: [DOC], state: 'reviewing' })
    expect(planView.value).toBeNull() // 焦点 B 尚无数据

    store.syncFocus('A')
    expect(planView.value?.state).toBe('reviewing')
    expect(planStage.value).toBe('reviewing')
  })
})

// ── 评论草稿（焦点分区操作 + per-session 隔离）───────────────

describe('评论草稿：焦点分区操作与 per-session 隔离', () => {
  const C1: PlanReviewComment = { quote: '第一段引文', comment: '这里要补充边界条件' }
  const C2: PlanReviewComment = { quote: '第二段引文', comment: '流程图不对' }

  it('加/删/清空只作用焦点分区；切 session 隔离、切回恢复', () => {
    const { store, draftComments } = usePlanRefs()
    store.syncFocus('A')
    store.addDraftComment(C1)
    expect(draftComments.value).toEqual([C1])

    // 切到 B：草稿从 B 分区起步（空），A 的草稿不串
    store.syncFocus('B')
    expect(draftComments.value).toEqual([])
    store.addDraftComment(C2)
    expect(draftComments.value).toEqual([C2])

    // 切回 A：Map 分区保留，草稿恢复
    store.syncFocus('A')
    expect(draftComments.value).toEqual([C1])

    // 删 A 的第 0 条（越界 no-op 先验证）
    store.removeDraftComment(5)
    expect(draftComments.value).toEqual([C1])
    store.removeDraftComment(0)
    expect(draftComments.value).toEqual([])

    // B 的草稿不受 A 删除影响；清空只清焦点（B）
    store.syncFocus('B')
    expect(draftComments.value).toEqual([C2])
    store.clearDraftComments()
    expect(draftComments.value).toEqual([])
    store.syncFocus('A')
    expect(draftComments.value).toEqual([])
  })

  it('null 焦点时草稿操作 no-op（不污染任何真实分区）', () => {
    const { store, draftComments } = usePlanRefs()
    store.syncFocus(null)
    store.addDraftComment(C1)
    // null 焦点视图为空（useSessionScopedState 契约：null 返回临时默认实例，不写 Map）
    expect(draftComments.value).toEqual([])

    store.syncFocus('A')
    store.addDraftComment(C1)
    store.syncFocus(null)
    store.removeDraftComment(0)
    store.clearDraftComments()
    // null 期间视图恒空（临时实例）
    expect(draftComments.value).toEqual([])
    // 切回 A：null 期间的操作未触达 A 分区
    store.syncFocus('A')
    expect(draftComments.value).toEqual([C1])
  })

  it('cleanup 链：triggerSessionCleanups → 该 session 分区重置，其他 session 保留', async () => {
    const { store, planView, draftComments } = usePlanRefs()
    // 草稿先于 view 建立会被 §3.5 翻转清兜底清掉（null→active = 新审阅轮），真机时序
    // 是审阅态（view 就绪）下才产生草稿——先 applyFrame 再 addDraft 对齐真机序列
    store.syncFocus('A')
    store.applyFrame('A', { ...BASE_VIEW, docs: [DOC] })
    store.addDraftComment(C1)
    store.syncFocus('B')
    store.applyFrame('B', { ...BASE_VIEW, docs: [DOC], state: 'reviewing' })
    store.addDraftComment(C2)

    triggerSessionCleanups('A')
    await settle()

    store.syncFocus('A')
    // A 分区重新惰性 init：草稿与 view 全空（下次访问重新首拉）
    expect(draftComments.value).toEqual([])
    expect(planView.value).toBeNull()

    store.syncFocus('B')
    // B 分区不受 A 清理影响
    expect(draftComments.value).toEqual([C2])
    expect(planView.value?.state).toBe('reviewing')
  })
})

// ── §3.5 enter 翻转清草稿（分区写入共同出口，禁焦点视图落点）──

describe('enter 翻转清草稿（§3.5 兜底：新审阅轮 = 干净草稿区）', () => {
  const C: PlanReviewComment = { quote: '上一轮残留引文', comment: '上一轮残留评语' }

  it('WS 帧路径：sid 分区 isActive 无→有 翻转（applyFrame）→ 清该 sid 残留草稿', () => {
    const { store, draftComments } = usePlanRefs()
    // 退出态（isActive=false）残留草稿 = agent 自退/崩溃绕过 GUI 确认的路径
    store.syncFocus('A')
    store.applyFrame('A', { ...BASE_VIEW, isActive: false })
    store.addDraftComment(C)
    expect(draftComments.value).toEqual([C])

    // 同 sid 新一轮 plan 进入（false→true 翻转）→ 草稿清
    store.applyFrame('A', { ...BASE_VIEW, isActive: true })
    expect(draftComments.value).toEqual([])
  })

  it('首拉路径：loadPlanState 冷启动返回 isActive=true → 同样触发翻转清（双路同覆）', async () => {
    const { store, draftComments } = usePlanRefs()
    store.syncFocus('A')
    store.applyFrame('A', { ...BASE_VIEW, isActive: false })
    store.addDraftComment(C)

    void store.loadPlanState('A')
    resolveForSid('A', { sessionId: 'A', planState: { ...BASE_VIEW, isActive: true } })
    await settle()

    expect(draftComments.value).toEqual([])
  })

  it('true→true（审阅中的重复帧/首拉回放）不清：审阅中草稿安全', () => {
    const { store, draftComments } = usePlanRefs()
    store.syncFocus('A')
    store.applyFrame('A', { ...BASE_VIEW, isActive: true })
    store.addDraftComment(C)

    store.applyFrame('A', { ...BASE_VIEW, isActive: true, state: 'reviewing' })
    expect(draftComments.value).toEqual([C])
  })

  it('true→false（退出/执行后）不清：草稿清走退出确认路径', () => {
    const { store, draftComments } = usePlanRefs()
    store.syncFocus('A')
    store.applyFrame('A', { ...BASE_VIEW, isActive: true })
    store.addDraftComment(C)

    store.applyFrame('A', { ...BASE_VIEW, isActive: false })
    expect(draftComments.value).toEqual([C])
  })

  it('首拉失败（RPC reject）不清：view 不被覆盖，翻转无从发生', async () => {
    const { store, draftComments } = usePlanRefs()
    store.syncFocus('A')
    store.applyFrame('A', { ...BASE_VIEW, isActive: false })
    store.addDraftComment(C)

    void store.loadPlanState('A')
    rejectLatestForSid('A', new Error('offline'))
    await settle()

    expect(draftComments.value).toEqual([C])
  })

  it('切 session 焦点视图不误清（设计禁令反向断言）：审阅中 A 的草稿在焦点切走切回后保留', async () => {
    const { store, draftComments } = usePlanRefs()
    // A 审阅中（isActive=true）且已有草稿——若误挂「焦点视图 watch」落点，
    // 从无 view 的 B 切到 A 时焦点 isActive 呈假「无→有」翻转，会误清 A
    store.syncFocus('A')
    store.applyFrame('A', { ...BASE_VIEW, isActive: true, state: 'reviewing' })
    store.addDraftComment(C)
    expect(draftComments.value).toEqual([C])

    // 焦点切到无 plan 状态的 B → 再切回 A：syncFocus 只动焦点指针，不写分区
    store.syncFocus('B')
    void store.loadPlanState('B') // B 侧首拉（返回 isActive=true 触发 B 的翻转清——只清 B 分区）
    resolveForSid('B', { sessionId: 'B', planState: { ...BASE_VIEW, isActive: true } })
    await settle()

    store.syncFocus('A')
    expect(draftComments.value).toEqual([C]) // A 草稿不误清
  })
})

// ── §3.5 草稿回看请求信号 ──

describe('草稿回看请求（requestDraftsReveal / markDraftsRevealConsumed）', () => {
  it('请求递增 seq 并置 pending；消费标记复位 pending', () => {
    const { store } = usePlanRefs()
    store.syncFocus('A')
    expect(store.draftsRevealSeq).toBe(0)
    expect(store.draftsRevealPending).toBe(false)

    store.requestDraftsReveal()
    expect(store.draftsRevealSeq).toBe(1)
    expect(store.draftsRevealPending).toBe(true)

    store.markDraftsRevealConsumed()
    expect(store.draftsRevealPending).toBe(false)

    // 新请求：seq 再递增、pending 复位（drawer 重开后的第二次回看仍可消费）
    store.requestDraftsReveal()
    expect(store.draftsRevealSeq).toBe(2)
    expect(store.draftsRevealPending).toBe(true)
  })

  it('per-session 隔离：A 的待消费请求不串 B 分区', () => {
    const { store } = usePlanRefs()
    store.syncFocus('A')
    store.requestDraftsReveal()

    store.syncFocus('B')
    expect(store.draftsRevealSeq).toBe(0)
    expect(store.draftsRevealPending).toBe(false)
  })
})
