/**
 * usePlanState 单测 —— plan 模式重设计 u1-store 层 2（编排：订阅 / 首拉 / 视图透出）。
 *
 * 覆盖（plan-mode-redesign impl-plan u1-store（历史项目，未入库）验收条款）：
 * - 首拉 watch immediate：初始挂载即拉 + 切 session 再拉；RPC reject（reply success=false）
 *   走错误通路（分区 loadError）断言
 * - WS 帧驱动状态流转：awaiting → revising → 无值（reviewing → reviewing → writing）
 * - updateFor 分区断言：session A 帧不污染 session B 分区；capturedSid 与切焦点竞态模拟
 *   （切换的异步退订窗口内旧 sid 迟到帧只写旧分区）
 * - 评论草稿转发接线 + 清理编排（triggerSessionCleanups → 分区重置，其他 session 保留；
 *   分区语义本体归 plan-store.test.ts，此处不重复）
 *
 * 范式照抄 gen-stats-composable.test.ts：
 * - mock 边界：command 部分 mock（spread actual 保留 events 真实通道——useSessionEvents 经
 *   主模块 events.on 订阅，测试侧 dispatchSession 与实现侧订阅经同一模块实例共享注册表）
 * - 宿主组件：useSessionEvents 的 getCurrentInstance 守卫要求组件 setup 上下文，mount 宿主
 *   expose composable 返回值
 * - 实现/测试均无 timer 依赖，异步链用 setTimeout(0) macrotask 排空（无需 fake timers）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/use-plan-sync.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { defineComponent, h, ref, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { mount, type VueWrapper } from '@vue/test-utils'
import { commandMock, transportApiCommandModule } from '../helpers/transport-command-mock'
import * as events from '@taiji/core/transport/api'
import { RPC_BACKSTOP_TIMEOUT_MS } from '@taiji/core/transport/api'
import {
  triggerSessionCleanups,
  __clearSessionCleanupRegistryForTest,
} from '@/composables/useSessionScopedState'
import { usePlanState, type UsePlanStateReturn } from '@/composables/use-plan-sync'
import { PLAN_ACTIVITY_RECONCILE_COOLDOWN_MS } from '@/stores/plan-store'
import type { PlanDocMeta, PlanStateView } from '@taiji/shared'

// ── mock 边界：getPlanState RPC mock 掉（runtime 侧 u1-rpc 未接线，受控 deferred 驱动）──
// spread-actual mock 体单源在 helpers/transport-command-mock.ts（events 真实通道保留，
// RPC_BACKSTOP_TIMEOUT_MS 透传 30_000；commandMock 为该 helper 导出的文件内单例）
vi.mock('@taiji/core/transport/api', () => transportApiCommandModule())

// ── 共享测试基建 ─────────────────────────────────────────────

const DOC: PlanDocMeta = {
  fileName: 'design.md',
  absPath: '/data/A/.tmp/plans/auth/design.md',
  sourceSkill: 'tech-design',
  version: 1,
}

/** 帧工厂：激活态四必填字段为基线，用例按需覆写（D4：新字段 optional） */
function planStateOf(sid: string, overrides: Partial<PlanStateView> = {}): PlanStateView {
  return {
    isActive: true,
    planFilePath: `/data/${sid}/.tmp/plans/auth/plan.md`,
    requirement: '重构 auth 模块',
    templateName: 'default',
    state: 'planning', // 真形态基线：归一 View 恒携带 state（批次 3 条目 1 后缺失格落 idle）
    ...overrides,
  }
}

/** 真实 events.dispatchSession 通道派发 session.planState 帧（更新分区） */
function dispatchPlanState(sid: string, planState: PlanStateView): void {
  events.dispatchSession(sid, { type: 'session.planState', payload: { sessionId: sid, planState } })
}

/** 在途 RPC 的受控 deferred（mock 发起时登记） */
interface PendingRpc {
  sid: string
  resolve: (v: { sessionId: string; planState: PlanStateView }) => void
  reject: (e: unknown) => void
}

let pendingRpcs: PendingRpc[] = []
const mountedWrappers: VueWrapper[] = []

function resolveLatestForSid(sid: string, reply: { sessionId: string; planState: PlanStateView }): void {
  const idx = pendingRpcs.map((e) => e.sid).lastIndexOf(sid)
  if (idx < 0) throw new Error(`测试编排错误：sid ${sid} 无在途 RPC`)
  const [entry] = pendingRpcs.splice(idx, 1)
  entry.resolve(reply)
}

function rejectLatestForSid(sid: string, err: unknown): void {
  const idx = pendingRpcs.map((e) => e.sid).lastIndexOf(sid)
  if (idx < 0) throw new Error(`测试编排错误：sid ${sid} 无在途 RPC`)
  const [entry] = pendingRpcs.splice(idx, 1)
  entry.reject(err)
}

interface HostHandle {
  sidRef: ReturnType<typeof ref<string | null>>
  plan: UsePlanStateReturn
}

/**
 * 测试宿主组件：setup 内调 usePlanState（useSessionEvents 守卫要求组件 setup 上下文），
 * expose 返回值（对齐 gen-stats-composable.test.ts 形态）。
 */
function mountHost(initialSid: string | null): HostHandle {
  const sidRef = ref<string | null>(initialSid)
  const wrapper = mount(
    defineComponent({
      setup() {
        const plan = usePlanState(sidRef)
        return { plan }
      },
      render: () => h('div'),
    }),
  )
  mountedWrappers.push(wrapper)
  // vm 属性经 test-utils 暴露为宽类型；断言前运行时守卫收缩（禁裸 as）
  const candidate = (wrapper.vm as { plan?: unknown }).plan
  if (!candidate || typeof candidate !== 'object' || !('view' in candidate)) {
    throw new Error('host 组件未暴露 plan')
  }
  return { sidRef, plan: candidate as UsePlanStateReturn }
}

/**
 * 排空在途异步链。setTimeout(0) 是 macrotask：其回调执行前，所有已排队微任务（promise
 * 链 → 写分区）与 Vue watcher（含 useSessionEvents 的重订 / 首拉 watch）全部跑完。
 */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await nextTick()
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

afterEach(() => {
  while (mountedWrappers.length) mountedWrappers.pop()?.unmount()
})

// ── 首拉（watch immediate：挂载与切换合一时点）────────────────

describe('首拉：watch immediate', () => {
  it('初始挂载即首拉（immediate），RPC 参数带超时常量', async () => {
    mountHost('A')
    await settle()
    expect(commandMock).toHaveBeenCalledTimes(1)
    expect(commandMock).toHaveBeenCalledWith(
      'session.getPlanState',
      { sessionId: 'A' },
      RPC_BACKSTOP_TIMEOUT_MS,
    )
  })

  it('切 session 再拉：A → B 第二次首拉，reply 写 B 分区；切回 A 恢复 A 分区缓存', async () => {
    const host = mountHost('A')
    await settle()
    resolveLatestForSid('A', { sessionId: 'A', planState: planStateOf('A', { docs: [DOC] }) })
    await settle()
    expect(host.plan.view.value?.docs?.length).toBe(1)

    host.sidRef.value = 'B'
    await settle()
    expect(commandMock).toHaveBeenCalledTimes(2)
    resolveLatestForSid('B', { sessionId: 'B', planState: planStateOf('B', { skills: ['tech-design'] }) })
    await settle()
    expect(host.plan.view.value?.skills).toEqual(['tech-design'])

    // 切回 A：分区缓存即时恢复（第二次首拉在途不阻塞显示）
    host.sidRef.value = 'A'
    await settle()
    expect(commandMock).toHaveBeenCalledTimes(3)
    expect(host.plan.view.value?.docs?.length).toBe(1)
  })

  it('null sid 不首拉（无活跃 session），视图为空', async () => {
    const host = mountHost(null)
    await settle()
    expect(commandMock).not.toHaveBeenCalled()
    expect(host.plan.view.value).toBeNull()
  })

  it('RPC reject（reply success=false）→ loadError 落分区（错误通路），view 不被覆盖', async () => {
    const host = mountHost('A')
    await settle()
    resolveLatestForSid('A', { sessionId: 'A', planState: planStateOf('A', { docs: [DOC] }) })
    await settle()
    expect(host.plan.loadError.value).toBeNull()

    // 切走再切回，第二次首拉失败
    host.sidRef.value = null
    await settle()
    host.sidRef.value = 'A'
    await settle()
    rejectLatestForSid('A', new Error('session not found'))
    await settle()

    expect(host.plan.loadError.value).toBe('session not found')
    // 失败兜底显示：分区缓存 view 仍在
    expect(host.plan.view.value?.docs?.length).toBe(1)
  })
})

// ── WS 帧驱动状态流转（updateFor 分区写）─────────────────────

describe('WS 帧：状态流转与分区隔离', () => {
  it('帧驱动状态流转（真形态：View 携带 state）：reviewing → ③；revising → ②；planning → ②', async () => {
    const host = mountHost('A')
    await settle()

    // 回归契约（真实链路形态）：归一点产出的 View 恒携带 state（批次 3 条目 1 后旧字段已退出契约）
    dispatchPlanState('A', planStateOf('A', { docs: [DOC], state: 'reviewing' }))
    await settle()
    expect(host.plan.stage.value).toBe('reviewing')
    expect(host.plan.view.value?.state).toBe('reviewing')

    // revising 归 phase 'planning'（derivePhase 单点接线）→ 文档撰写档（②）
    dispatchPlanState('A', planStateOf('A', { docs: [DOC], state: 'revising' }))
    await settle()
    expect(host.plan.stage.value).toBe('writing')

    // 修订完成重新提交前的过渡帧（state=planning）——D1 三步推导落回 ②
    dispatchPlanState('A', planStateOf('A', { docs: [DOC], state: 'planning' }))
    await settle()
    expect(host.plan.stage.value).toBe('writing')
  })

  it('isActive=false 帧驱动 plan 态消失语义（stage → null）', async () => {
    const host = mountHost('A')
    await settle()
    dispatchPlanState('A', planStateOf('A', { docs: [DOC], state: 'reviewing' }))
    await settle()
    expect(host.plan.stage.value).toBe('reviewing')

    dispatchPlanState('A', planStateOf('A', { isActive: false, docs: [DOC] }))
    await settle()
    expect(host.plan.stage.value).toBeNull()
  })

  it('切焦点后各分区各自正确：旧分区帧数据保留，新分区不受影响', async () => {
    // 注：useSessionEvents 只订阅焦点 sid 通道（D1：不做非活跃 session 兜底，后台 session
    // 切回靠首拉刷新）——非焦点 sid 的帧只能经切换竞态窗口入分区（上一用例覆盖）。
    // 本用例断言切焦点后「新焦点分区为空、旧分区数据保留」的可见语义。
    const host = mountHost('A')
    await settle()
    dispatchPlanState('A', planStateOf('A', { docs: [DOC], state: 'reviewing' }))
    await settle()
    expect(host.plan.stage.value).toBe('reviewing')

    host.sidRef.value = 'B'
    await settle()
    // 新焦点 B 分区为空，不被 A 的数据污染
    expect(host.plan.view.value).toBeNull()
    expect(host.plan.stage.value).toBeNull()

    // 切回 A：分区缓存保留（首拉在途也不丢显示）
    host.sidRef.value = 'A'
    await settle()
    expect(host.plan.view.value?.state).toBe('reviewing')
  })

  it('capturedSid 与切焦点竞态：切换的异步退订窗口内旧 sid 迟到帧只写旧 sid 分区', async () => {
    const host = mountHost('A')
    await settle()

    // 切焦点到 B：watch flush 前向 A 派发迟到帧（useSessionEvents 尚未退订 A，
    // handler 收到的 sid 是订阅时捕获的 'A'，不是当前焦点）
    host.sidRef.value = 'B'
    dispatchPlanState('A', planStateOf('A', { docs: [DOC], state: 'revising' }))
    await settle()

    // 焦点 B：迟到 A 帧不污染 B 分区
    expect(host.plan.view.value).toBeNull()
    expect(host.plan.stage.value).toBeNull()

    // 切回 A：迟到帧确实写入了 A 分区（而非被丢弃或写错分区）
    host.sidRef.value = 'A'
    await settle()
    expect(host.plan.view.value?.state).toBe('revising')
  })
})

// ── 活动补拉：新 session 首拉窗口丢帧补偿（2026-09-25 真机缺陷）──────────────

/**
 * 缺陷时序（真机双形态实证）：session 创建即首拉 → plan-state entry 未落盘，reply
 * INACTIVE 落分区 → session.planState 帧早于订阅送达或 runtime 水位竞态未发布 →
 * 两条腿全断且无再拉触发点 → 状态带永不渲染（需手动切走切回）。补偿锚点 =
 * assistant 消息活动（message_start = turn 内最早边沿；message.complete 兜底；/plan
 * 写 entry 是 turn 前置动作，必然早于消息开始，补拉必得真值）。限频双门（非活跃 +
 * 冷却）内聚 plan-store。
 */
describe('活动补拉：首拉早于 entry 落盘 + 帧不可靠窗口的丢帧补偿', () => {
  /** assistant 消息活动帧（message_start 首选；payload 形状本 handler 不消费） */
  function dispatchActivity(sid: string, type: 'message.message_start' | 'message.complete' = 'message.message_start'): void {
    events.dispatchSession(sid, { type, payload: { sessionId: sid } })
  }

  it('首拉回 INACTIVE + planState 帧全程未达 → 消息活动触发补拉 → 真值恢复 view', async () => {
    const host = mountHost('A')
    await settle()
    // 首拉 reply = INACTIVE（真机形态：plan-state entry 尚未落盘时冷读）
    resolveLatestForSid('A', { sessionId: 'A', planState: planStateOf('A', { isActive: false }) })
    await settle()
    expect(host.plan.view.value?.isActive).toBe(false)

    // session.planState 帧不 dispatch（真机：帧早于订阅送达 / 未发布——两条腿全断）

    // assistant 消息开始（turn 内最早活动信号）→ 补拉发出
    dispatchActivity('A')
    await settle()
    expect(commandMock).toHaveBeenCalledTimes(2) // 首拉 + 补拉

    // 补拉 reply = planning（entry 已落盘后的冷读真值）→ view 恢复活跃
    resolveLatestForSid('A', { sessionId: 'A', planState: planStateOf('A') })
    await settle()
    expect(host.plan.view.value?.isActive).toBe(true)
    expect(host.plan.stage.value).not.toBeNull()
  })

  it('message.complete 同样触发补拉（长 turn 多消息兜底锚点）', async () => {
    const host = mountHost('A')
    await settle()
    resolveLatestForSid('A', { sessionId: 'A', planState: planStateOf('A', { isActive: false }) })
    await settle()

    dispatchActivity('A', 'message.complete')
    await settle()
    expect(commandMock).toHaveBeenCalledTimes(2)
  })

  it('冷却门：冷却窗口内的后续活动信号不重复补拉（频率上限）', async () => {
    const host = mountHost('A')
    await settle()
    resolveLatestForSid('A', { sessionId: 'A', planState: planStateOf('A', { isActive: false }) })
    await settle()

    dispatchActivity('A')
    await settle()
    expect(commandMock).toHaveBeenCalledTimes(2)
    resolveLatestForSid('A', { sessionId: 'A', planState: planStateOf('A', { isActive: false }) })
    await settle()

    // 冷却窗口内第二条活动信号：不再补（PLAN_ACTIVITY_RECONCILE_COOLDOWN_MS 未过）
    dispatchActivity('A')
    await settle()
    expect(commandMock).toHaveBeenCalledTimes(2)
  })

  it('非活跃门：view 已被 live 帧点亮时活动信号不触发补拉（活跃态由帧链自持）', async () => {
    const host = mountHost('A')
    await settle()
    dispatchPlanState('A', planStateOf('A')) // live 帧点亮
    await settle()
    expect(host.plan.view.value?.isActive).toBe(true)

    dispatchActivity('A')
    await settle()
    expect(commandMock).toHaveBeenCalledTimes(1) // 仅首拉，无补拉
  })

  it('活跃冻结检测（F-W3-2）：view 活跃但帧链无进展时，冷却后的消息边沿触发补拉', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const host = mountHost('A')
      await settle()
      // live 帧点亮 view（②形态：planning + docs，frameRev=1）——真机 6c3：此后帧链再无帧到达
      dispatchPlanState('A', planStateOf('A', { docs: [DOC], state: 'planning' }))
      await settle()
      expect(host.plan.view.value?.state).toBe('planning')

      // 首条消息边沿：只立帧基准，不补拉（健康链路常态 turn 不产生补拉）
      dispatchActivity('A')
      await settle()
      expect(commandMock).toHaveBeenCalledTimes(1)

      // 冷却期过后第二/第三条边沿：frameRev 无增长 = planState 帧链疑死 → 补拉直读磁盘
      vi.setSystemTime(Date.now() + PLAN_ACTIVITY_RECONCILE_COOLDOWN_MS + 1)
      dispatchActivity('A')
      await settle()
      expect(commandMock).toHaveBeenCalledTimes(2)

      // 补拉 reply = 恢复后的磁盘真值（dispatching）→ 阶段指示收敛 ③已批准
      resolveLatestForSid('A', { sessionId: 'A', planState: planStateOf('A', { docs: [DOC], state: 'dispatching' }) })
      await settle()
      expect(host.plan.view.value?.state).toBe('dispatching')
      expect(host.plan.stage.value).toBe('approved')
    } finally {
      vi.useRealTimers()
    }
  })

  it('帧链恢复自动静默：frameRev 增长（planState 帧到达）后，消息边沿不再补拉', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const host = mountHost('A')
      await settle()
      dispatchPlanState('A', planStateOf('A', { docs: [DOC], state: 'planning' }))
      await settle()
      dispatchActivity('A')
      await settle()
      expect(commandMock).toHaveBeenCalledTimes(1)

      // 帧链恢复：新 planState 帧到达（frameRev 增长）
      dispatchPlanState('A', planStateOf('A', { docs: [DOC], state: 'reviewing' }))
      await settle()

      // 冷却期后消息边沿：rev 有进展 → 不补拉（活跃态重新由帧链自持）
      vi.setSystemTime(Date.now() + PLAN_ACTIVITY_RECONCILE_COOLDOWN_MS + 1)
      dispatchActivity('A')
      await settle()
      expect(commandMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('补拉走 updateFor(sid)：焦点 session 的活动信号补拉写自身分区（capturedSid 语义）', async () => {
    const host = mountHost('A')
    await settle()
    resolveLatestForSid('A', { sessionId: 'A', planState: planStateOf('A', { isActive: false }) })
    await settle()

    // 切焦点到 B（A 的订阅退订，A 分区数据保留；后台 session 无消费面=无活动信号转发）
    host.sidRef.value = 'B'
    await settle()
    resolveLatestForSid('B', { sessionId: 'B', planState: planStateOf('B', { isActive: false }) })
    await settle()

    // 焦点 B 的活动信号正常补拉且只写 B 分区
    dispatchActivity('B')
    await settle()
    expect(commandMock).toHaveBeenCalledTimes(3) // A 首拉 + B 首拉 + B 补拉
    resolveLatestForSid('B', { sessionId: 'B', planState: planStateOf('B') })
    await settle()
    expect(host.plan.view.value?.isActive).toBe(true)
  })
})

// ── 崩溃恢复对账：session.restored 边沿冷拉（F-W3-2 恢复链重确认）──────────────

describe('崩溃恢复对账：session.restored 边沿冷拉', () => {
  it('restored 帧到达即冷拉磁盘真值（不切换焦点也有重确认触发点）', async () => {
    const host = mountHost('A')
    await settle()
    // view 停在恢复前的旧形态（首拉 deferred 未 resolve，分区为 null 也可——本用例断言拉取触发）
    events.dispatchSession('A', {
      type: 'session.restored',
      payload: { sessionId: 'A', attempts: 1 },
    })
    await settle()
    expect(commandMock).toHaveBeenCalledTimes(2) // 首拉 + restored 冷拉

    resolveLatestForSid('A', { sessionId: 'A', planState: planStateOf('A', { docs: [DOC], state: 'dispatching' }) })
    await settle()
    expect(host.plan.view.value?.state).toBe('dispatching')
  })
})

// ── 评论草稿：usePlanState 转发接线 + 清理编排增量 ───────────────
// 草稿的焦点分区语义本体（加/删/清只作用焦点、跨区隔离、null 焦点 no-op）归
// plan-store.test.ts「评论草稿：焦点分区操作与 per-session 隔离」；此处只测
// composable 转发接线（removeDraft 唯一杀伤点）与 cleanup 编排（重拉增量）。

describe('评论草稿：usePlanState 转发接线 + 清理编排增量', () => {
  it('草稿按焦点分区隔离：A/B 各自累积、切回恢复、删除只作用焦点', async () => {
    const host = mountHost('A')
    await settle()
    host.plan.addDraft({ quote: '引文一', comment: '补充边界条件' })
    expect(host.plan.drafts.value).toEqual([{ quote: '引文一', comment: '补充边界条件' }])

    host.sidRef.value = 'B'
    await settle()
    expect(host.plan.drafts.value).toEqual([])
    host.plan.addDraft({ quote: '引文二', comment: '流程图不对' })
    host.plan.addDraft({ quote: '引文三', comment: '命名不一致' })
    host.plan.removeDraft(1)
    expect(host.plan.drafts.value).toEqual([{ quote: '引文二', comment: '流程图不对' }])

    // 切回 A：草稿恢复（Map 分区保留）
    host.sidRef.value = 'A'
    await settle()
    expect(host.plan.drafts.value).toEqual([{ quote: '引文一', comment: '补充边界条件' }])
  })

  it('cleanup 链：triggerSessionCleanups(A) → A 分区重置（草稿/view 清空），B 保留', async () => {
    const host = mountHost('A')
    await settle()
    // 草稿先于 view 建立会被 §3.5 enter 翻转清兜底清掉（null→active = 新审阅轮；本文件
    // 首拉是受控 deferred、用例不 resolve → 分区 view 恒 null），真机时序是审阅态（view
    // 就绪）下才产生草稿——先帧后草稿对齐真机序列（参照 plan-store.test.ts 同类用例）
    dispatchPlanState('A', planStateOf('A', { docs: [DOC] }))
    await settle()
    host.plan.addDraft({ quote: 'q1', comment: 'c1' })
    await settle()
    expect(host.plan.drafts.value.length).toBe(1)

    host.sidRef.value = 'B'
    await settle()
    dispatchPlanState('B', planStateOf('B', { docs: [DOC], state: 'reviewing' }))
    await settle()
    host.plan.addDraft({ quote: 'q2', comment: 'c2' })
    await settle()

    // useSidebar.deleteSession 销毁 session A 的编排入口
    triggerSessionCleanups('A')
    await nextTick()

    host.sidRef.value = 'A'
    await settle()
    // A 分区重新惰性 init：草稿与 view 全空（下次进入重新首拉）
    expect(host.plan.drafts.value).toEqual([])
    expect(host.plan.view.value).toBeNull()
    expect(commandMock).toHaveBeenCalledTimes(3) // 切回 A 触发重新首拉

    host.sidRef.value = 'B'
    await settle()
    // B 分区不受 A 清理影响
    expect(host.plan.drafts.value).toEqual([{ quote: 'q2', comment: 'c2' }])
    expect(host.plan.view.value?.state).toBe('reviewing')
  })
})
