/**
 * plan store 单测 —— plan 模式重设计 u1-store 层 1（状态与操作）。
 *
 * 覆盖（impl-plan u1-store 验收条款）：
 * - 三步阶段推导三元组（D1：① exploring / ② writing / ③ reviewing；isActive 门 + reviewState 优先）
 * - 首拉成功写分区 / 响应缺 planState 置空 / RPC 失败错误通路（分区 loadError，view 不被覆盖）
 * - WS 帧落地 updateFor 分区写（applyFrame + 清 loadError）
 * - 评论草稿只作用焦点分区（per-session 隔离、切回恢复、越界删除 no-op、null 焦点 no-op）
 * - cleanup 链（triggerSessionCleanups → 分区重置，其他 session 保留）
 *
 * 范式照抄 subagent.test.ts（pinia setActivePinia 每 case 重建）+ gen-stats-composable.test.ts
 * 的 mock 边界（spread actual 保真实 events 通道，只换 command）。
 * 断言经 storeToRefs（pinia setup store 的 computed 经 store 实例访问已解包，.value 是 undefined）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/stores/plan-store.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { storeToRefs } from 'pinia'
import {
  triggerSessionCleanups,
  __clearSessionCleanupRegistryForTest,
} from '@/composables/useSessionScopedState'
import {
  usePlanStore,
  derivePlanStage,
  type PlanReviewComment,
} from '@/stores/plan-store'
import type { PlanDocMeta, PlanStateView } from '@taiji/shared'

// ── mock 边界：getPlanState RPC mock 掉（runtime 侧 u1-rpc 未接线，用受控 deferred 驱动）──
// spread actual 保留 events 真实通道与 transport 其余面（本文件不 mount，不依赖 events；
// 与 use-plan-sync.test.ts 共用同一 mock 形态，防两文件对同模块的 mock 形状漂移）
const commandMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api', async (importActual) => {
  const actual = await importActual<typeof import('@taiji/core/transport/api')>()
  return { ...actual, command: commandMock, RPC_BACKSTOP_TIMEOUT_MS: 30_000 }
})

import { RPC_BACKSTOP_TIMEOUT_MS } from '@taiji/core/transport/api'

// ── 共享测试基建 ─────────────────────────────────────────────

const BASE_VIEW: PlanStateView = {
  isActive: true,
  planFilePath: '/data/A/.taiji-harness/auth/plan.md',
  requirement: '重构 auth 模块',
  templateName: 'default',
}

const DOC: PlanDocMeta = {
  fileName: 'design.md',
  absPath: '/data/A/.taiji-harness/auth/design.md',
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
  setActivePinia(createPinia())
  __clearSessionCleanupRegistryForTest()
})

// ── 三步阶段推导（D1 推导三元组）─────────────────────────────

describe('derivePlanStage：三步阶段推导三元组', () => {
  it('① 需求探索 = isActive && 无 docs（docs 缺省与空数组两形态）', () => {
    expect(derivePlanStage(BASE_VIEW)).toBe('exploring')
    expect(derivePlanStage({ ...BASE_VIEW, docs: [] })).toBe('exploring')
  })

  it('② 文档撰写 = isActive && docs.length ≥ 1 && 无 reviewState', () => {
    expect(derivePlanStage({ ...BASE_VIEW, docs: [DOC] })).toBe('writing')
    expect(derivePlanStage({ ...BASE_VIEW, docs: [DOC, DOC] })).toBe('writing')
  })

  it('③ 审阅确认 = reviewState ∈ {awaiting, revising}（优先于 docs 判定）', () => {
    expect(derivePlanStage({ ...BASE_VIEW, docs: [DOC], reviewState: 'awaiting' })).toBe('reviewing')
    expect(derivePlanStage({ ...BASE_VIEW, docs: [DOC], reviewState: 'revising' })).toBe('reviewing')
    // 异常组合防御：reviewState 有值但 docs 空——③ 公式不含 docs 条件，仍 reviewing
    expect(derivePlanStage({ ...BASE_VIEW, reviewState: 'awaiting' })).toBe('reviewing')
  })

  it('isActive=false（退出/执行后 reset 终态）或无 view → null（横幅消失，阶段随横幅不外显）', () => {
    expect(derivePlanStage(null)).toBeNull()
    expect(derivePlanStage({ ...BASE_VIEW, isActive: false })).toBeNull()
    expect(derivePlanStage({ ...BASE_VIEW, isActive: false, docs: [DOC], reviewState: 'awaiting' })).toBeNull()
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

// ── WS 帧落地（updateFor 分区写）────────────────────────────

describe('applyFrame：updateFor 分区写', () => {
  it('帧写入指定 sid 分区，不依赖焦点；reviewState 翻转驱动阶段流转', () => {
    const { store, planView, planStage } = usePlanRefs()
    // 焦点在 B，A 的帧写入 A 分区（B 分区不受影响）
    store.syncFocus('B')
    store.applyFrame('A', { ...BASE_VIEW, docs: [DOC], reviewState: 'awaiting' })
    expect(planView.value).toBeNull() // 焦点 B 尚无数据

    store.syncFocus('A')
    expect(planView.value?.reviewState).toBe('awaiting')
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
    store.syncFocus('A')
    store.addDraftComment(C1)
    store.applyFrame('A', { ...BASE_VIEW, docs: [DOC] })
    store.syncFocus('B')
    store.addDraftComment(C2)
    store.applyFrame('B', { ...BASE_VIEW, docs: [DOC], reviewState: 'awaiting' })

    triggerSessionCleanups('A')
    await settle()

    store.syncFocus('A')
    // A 分区重新惰性 init：草稿与 view 全空（下次访问重新首拉）
    expect(draftComments.value).toEqual([])
    expect(planView.value).toBeNull()

    store.syncFocus('B')
    // B 分区不受 A 清理影响
    expect(draftComments.value).toEqual([C2])
    expect(planView.value?.reviewState).toBe('awaiting')
  })
})
