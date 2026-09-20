/**
 * usePlanState 单测 —— plan 模式重设计 u1-store 层 2（编排：订阅 / 首拉 / 视图透出）。
 *
 * 覆盖（impl-plan u1-store 验收条款）：
 * - 首拉 watch immediate：初始挂载即拉 + 切 session 再拉；RPC reject（reply success=false）
 *   走错误通路（分区 loadError）断言
 * - WS 帧驱动状态流转：awaiting → revising → 无值（reviewing → reviewing → writing）
 * - updateFor 分区断言：session A 帧不污染 session B 分区；capturedSid 与切焦点竞态模拟
 *   （切换的异步退订窗口内旧 sid 迟到帧只写旧分区）
 * - 评论草稿 per-session 隔离与清理链（triggerSessionCleanups → 分区重置，其他 session 保留）
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
import * as events from '@taiji/core/transport/api'
import { RPC_BACKSTOP_TIMEOUT_MS } from '@taiji/core/transport/api'
import {
  triggerSessionCleanups,
  __clearSessionCleanupRegistryForTest,
} from '@/composables/useSessionScopedState'
import { usePlanState, type UsePlanStateReturn } from '@/composables/use-plan-sync'
import type { PlanDocMeta, PlanStateView } from '@taiji/shared'

// ── mock 边界：getPlanState RPC mock 掉（runtime 侧 u1-rpc 未接线，受控 deferred 驱动）──
const commandMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api', async (importActual) => {
  const actual = await importActual<typeof import('@taiji/core/transport/api')>()
  return { ...actual, command: commandMock, RPC_BACKSTOP_TIMEOUT_MS: 30_000 }
})

// ── 共享测试基建 ─────────────────────────────────────────────

const DOC: PlanDocMeta = {
  fileName: 'design.md',
  absPath: '/data/A/.taiji-harness/auth/design.md',
  sourceSkill: 'tech-design',
  version: 1,
}

/** 帧工厂：激活态四必填字段为基线，用例按需覆写（D4：新字段 optional） */
function planStateOf(sid: string, overrides: Partial<PlanStateView> = {}): PlanStateView {
  return {
    isActive: true,
    planFilePath: `/data/${sid}/.taiji-harness/auth/plan.md`,
    requirement: '重构 auth 模块',
    templateName: 'default',
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
  it('帧驱动 reviewState 流转：awaiting → revising → 无值（reviewing → reviewing → writing）', async () => {
    const host = mountHost('A')
    await settle()

    dispatchPlanState('A', planStateOf('A', { docs: [DOC], reviewState: 'awaiting' }))
    await settle()
    expect(host.plan.stage.value).toBe('reviewing')
    expect(host.plan.view.value?.reviewState).toBe('awaiting')

    dispatchPlanState('A', planStateOf('A', { docs: [DOC], reviewState: 'revising' }))
    await settle()
    expect(host.plan.stage.value).toBe('reviewing')
    expect(host.plan.view.value?.reviewState).toBe('revising')

    // 修订完成重新提交前的过渡帧（reviewState 无值）——D1 三步推导落回 ②
    dispatchPlanState('A', planStateOf('A', { docs: [DOC] }))
    await settle()
    expect(host.plan.stage.value).toBe('writing')
    expect(host.plan.view.value?.reviewState).toBeUndefined()
  })

  it('isActive=false 帧驱动横幅消失语义（stage → null）', async () => {
    const host = mountHost('A')
    await settle()
    dispatchPlanState('A', planStateOf('A', { docs: [DOC], reviewState: 'awaiting' }))
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
    dispatchPlanState('A', planStateOf('A', { docs: [DOC], reviewState: 'awaiting' }))
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
    expect(host.plan.view.value?.reviewState).toBe('awaiting')
  })

  it('capturedSid 与切焦点竞态：切换的异步退订窗口内旧 sid 迟到帧只写旧 sid 分区', async () => {
    const host = mountHost('A')
    await settle()

    // 切焦点到 B：watch flush 前向 A 派发迟到帧（useSessionEvents 尚未退订 A，
    // handler 收到的 sid 是订阅时捕获的 'A'，不是当前焦点）
    host.sidRef.value = 'B'
    dispatchPlanState('A', planStateOf('A', { docs: [DOC], reviewState: 'revising' }))
    await settle()

    // 焦点 B：迟到 A 帧不污染 B 分区
    expect(host.plan.view.value).toBeNull()
    expect(host.plan.stage.value).toBeNull()

    // 切回 A：迟到帧确实写入了 A 分区（而非被丢弃或写错分区）
    host.sidRef.value = 'A'
    await settle()
    expect(host.plan.view.value?.reviewState).toBe('revising')
  })
})

// ── 评论草稿：per-session 隔离与清理链 ───────────────────────

describe('评论草稿：per-session 隔离与清理链', () => {
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

  it('clearDrafts 清空焦点分区，其他分区保留', async () => {
    const host = mountHost('A')
    await settle()
    host.plan.addDraft({ quote: 'q1', comment: 'c1' })
    host.sidRef.value = 'B'
    await settle()
    host.plan.addDraft({ quote: 'q2', comment: 'c2' })
    host.plan.clearDrafts()
    expect(host.plan.drafts.value).toEqual([])

    host.sidRef.value = 'A'
    await settle()
    expect(host.plan.drafts.value).toEqual([{ quote: 'q1', comment: 'c1' }])
  })

  it('cleanup 链：triggerSessionCleanups(A) → A 分区重置（草稿/view 清空），B 保留', async () => {
    const host = mountHost('A')
    await settle()
    host.plan.addDraft({ quote: 'q1', comment: 'c1' })
    dispatchPlanState('A', planStateOf('A', { docs: [DOC] }))
    await settle()
    expect(host.plan.drafts.value.length).toBe(1)

    host.sidRef.value = 'B'
    await settle()
    host.plan.addDraft({ quote: 'q2', comment: 'c2' })
    dispatchPlanState('B', planStateOf('B', { docs: [DOC], reviewState: 'awaiting' }))
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
    expect(host.plan.view.value?.reviewState).toBe('awaiting')
  })
})
