/**
 * plan store 单测 —— plan 模式重设计 u1-store 层 1（状态与操作）。
 *
 * 覆盖（impl-plan u1-store 验收条款 + u-review-source-ui 增量）：
 * - 三步阶段推导三元组（D1：① exploring / ② writing / ③ reviewing；isActive 门 + reviewState 优先）
 * - 首拉成功写分区 / 响应缺 planState 置空 / RPC 失败错误通路（分区 loadError，view 不被覆盖）
 * - WS 帧落地 updateFor 分区写（applyFrame + 清 loadError）
 * - 评论草稿只作用焦点分区（per-session 隔离、切回恢复、越界删除 no-op、null 焦点 no-op）
 * - cleanup 链（triggerSessionCleanups → 分区重置，其他 session 保留）
 * - §3.5 enter 翻转清草稿（applyFrame 与 loadPlanState 双路 updateFor 出口：sid 分区内
 *   isActive 旧值 无→有 翻转清该 sid 草稿；true→true / true→false / 失败路径不清；
 *   切 session 焦点视图不误清——设计禁令的反向断言）
 * - §3.5 草稿回看请求信号（requestDraftsReveal / markDraftsRevealConsumed / per-session 隔离）
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
    // 草稿先于 view 建立会被 §3.5 翻转清兜底清掉（null→active = 新审阅轮），真机时序
    // 是审阅态（view 就绪）下才产生草稿——先 applyFrame 再 addDraft 对齐真机序列
    store.syncFocus('A')
    store.applyFrame('A', { ...BASE_VIEW, docs: [DOC] })
    store.addDraftComment(C1)
    store.syncFocus('B')
    store.applyFrame('B', { ...BASE_VIEW, docs: [DOC], reviewState: 'awaiting' })
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
    expect(planView.value?.reviewState).toBe('awaiting')
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

    store.applyFrame('A', { ...BASE_VIEW, isActive: true, reviewState: 'awaiting' })
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
    store.applyFrame('A', { ...BASE_VIEW, isActive: true, reviewState: 'awaiting' })
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
