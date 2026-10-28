/**
 * plan 同步 + preset 编排 + shields 遮蔽上报 + drawer 自动开窗合并文件（簇 3-8，4 源合一，DOM 环境）：
 * - use-plan-sync.test.ts —— usePlanState 订阅/首次拉取/帧流转/补充拉取/草稿接线
 * - use-pi-presets.test.ts —— usePiPresets 编排层 + u5 加载点
 * - features/browser/shields-view-sync.test.ts —— shieldsView 全量上报
 * - use-plan-drawer-sync.test.ts —— drawer「计划产物」tab 自动打开接线
 *
 * 五 mock 注册各管一段、经核实互不入对方消费图：transport/api 为 spread-actual 部分 mock
 * （command mock、events 真实）；@taiji/core barrel 为 spread-actual（只重写 getState）；
 * @/api（project+preset）与 @/lib/ipc（browserSetShields）窄 mock 在其他节图零消费；
 * domain/drawer 窄 mock 仅 usePlanDrawerSync 消费。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { defineComponent, h, ref, nextTick, onScopeDispose } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { mount, flushPromises, enableAutoUnmount, type VueWrapper } from '@vue/test-utils'
import { commandMock, transportApiCommandModule } from '../helpers/transport-command-mock'
import { apiProjectMock } from '../helpers/api-facade-mock'
import { wsStateModuleWithControlledRef } from '../helpers/ws-state-ref-mock'
import { makeSettingsTransportStub } from '../helpers/settings-transport-stub'
import * as events from '@taiji/core/transport/api'
import { RPC_BACKSTOP_TIMEOUT_MS } from '@taiji/core/transport/api'
import {
  triggerSessionCleanups,
  __clearSessionCleanupRegistryForTest,
} from '@/composables/useSessionScopedState'
import { usePlanState, type UsePlanStateReturn } from '@/composables/use-plan-sync'
import type { PlanDocMeta, PlanStateView, PiLaunchPreset } from '@taiji/shared'
import { provideSettingsTransport } from '@taiji/core'
import { usePresetStore } from '@/stores/preset'
import {
  usePiPresets,
  createPresetAutoLoad,
} from '@/composables/features/settings/usePiPresets'
import { _resetOverlayForTest, openOverlay } from '@taiji/core/domain/overlay'
import { registerModalSurface, resetModalSurfaceRegistry } from '@/composables/features/app/modal-surface-registry'
import { useShieldsViewSync } from '@/composables/features/browser/useShieldsViewSync'
import { usePlanStore } from '@/stores/plan-store'
import { usePlanDrawerSync } from '@/composables/use-plan-drawer-sync'

// VTU 每文件限一次：shields-view-sync 与 use-plan-drawer-sync 两源原各自文件级启用，合并后统一在此
enableAutoUnmount(afterEach)

// ── use-plan-sync 节 mock：getPlanState RPC mock 掉（spread actual 保 events 真实通道）──
vi.mock('@taiji/core/transport/api', () => transportApiCommandModule())

// ── use-pi-presets 节 mock：preset 域捕获 + ws 连接态受控 ref（默认 disconnected）──
const presetApiMock = vi.hoisted(() => {
  const mocks: Record<string, ReturnType<typeof vi.fn>> = {}
  for (const method of ['list', 'getDefault', 'setDefault', 'create', 'update', 'remove']) {
    mocks[method] = vi.fn()
  }
  return mocks
})
vi.mock('@/api', () => ({ project: apiProjectMock(), preset: presetApiMock }))

const wsMock = vi.hoisted(() => ({ ref: null as null | { value: string } }))
vi.mock('@taiji/core', () => wsStateModuleWithControlledRef('@taiji/core', wsMock))

// ── shields-view-sync 节 mock：browserSetShields 捕获（web 环境 electronAPI 缺席的等价形态）──
const mockBrowserSetShields = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/ipc', () => ({
  browserSetShields: (payload: {
    faces: Array<{ id: string; fullscreen: boolean; rect?: { x: number; y: number; width: number; height: number } }>
  }) => mockBrowserSetShields(payload),
}))

// ── use-plan-drawer-sync 节 mock：drawer 控制态通道（openDrawerTab spy + isOpen 可控 ref）──
const drawerMock = vi.hoisted(() => {
  const state: {
    openDrawerTab: ReturnType<typeof vi.fn>
    setIsOpen: ((v: boolean) => void) | null
  } = { openDrawerTab: vi.fn(), setIsOpen: null }
  return state
})

vi.mock('@taiji/core/domain/drawer', async () => {
  const { ref } = await import('vue')
  const isOpen = ref(false)
  drawerMock.setIsOpen = (v: boolean) => {
    isOpen.value = v
  }
  return {
    openDrawerTab: drawerMock.openDrawerTab,
    useDrawerControl: () => ({ isOpen }),
  }
})

// ═══ 来源节：use-plan-sync.test.ts —— usePlanState 订阅/首次拉取/帧流转/补充拉取/草稿接线 ═══
describe('use-plan-sync', () => {
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
   * 测试宿主组件：setup 内调 usePlanState（useSessionEvents 检查要求组件 setup 上下文），
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
    // vm 属性经 test-utils 暴露为宽类型；断言前运行时类型收窄（禁裸 as）
    const candidate = (wrapper.vm as { plan?: unknown }).plan
    if (!candidate || typeof candidate !== 'object' || !('view' in candidate)) {
      throw new Error('host 组件未暴露 plan')
    }
    return { sidRef, plan: candidate as UsePlanStateReturn }
  }

  /**
   * 排空在途异步链。setTimeout(0) 是 macrotask：其回调执行前，所有已排队微任务（promise
   * 链 → 写分区）与 Vue watcher（含 useSessionEvents 的重订 / 首次拉取 watch）全部跑完。
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

  // ── 首次拉取（watch immediate：挂载与切换合一时点）────────────────

  describe('首次拉取：watch immediate', () => {
    it('初始挂载即首次拉取（immediate），RPC 参数带超时常量', async () => {
      mountHost('A')
      await settle()
      expect(commandMock).toHaveBeenCalledTimes(1)
      expect(commandMock).toHaveBeenCalledWith(
        'session.getPlanState',
        { sessionId: 'A' },
        RPC_BACKSTOP_TIMEOUT_MS,
      )
    })

    it('切 session 再拉：A → B 第二次首次拉取，reply 写 B 分区；切回 A 恢复 A 分区缓存', async () => {
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

      // 切回 A：分区缓存即时恢复（第二次首次拉取在途不阻塞显示）
      host.sidRef.value = 'A'
      await settle()
      expect(commandMock).toHaveBeenCalledTimes(3)
      expect(host.plan.view.value?.docs?.length).toBe(1)
    })

    it('null sid 不首次拉取（无活跃 session），视图为空', async () => {
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

      // 切走再切回，第二次首次拉取失败
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
      // 切回靠首次拉取刷新）——非焦点 sid 的帧只能经切换竞态窗口入分区（上一用例覆盖）。
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

      // 切回 A：分区缓存保留（首次拉取在途也不丢显示）
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

  // ── 活动补充拉取：新 session 首次拉取窗口丢帧补偿（2026-09-25 真机缺陷）──────────────

  /**
   * 缺陷时序（真机双形态实证）：session 创建即首次拉取 → plan-state entry 未落盘，reply
   * INACTIVE 落分区 → session.planState 帧早于订阅送达或 runtime 水位竞态未发布 →
   * 两条路径全断且无再拉触发点 → 状态带永不渲染（需手动切走切回）。补偿锚点 =
   * assistant 消息活动（message_start = turn 内最早边沿；message.complete 兜底；/plan
   * 写 entry 是 turn 前置动作，必然早于消息开始，补充拉取必得真值）。限频双门（非活跃 +
   * 冷却）内聚 plan-store。
   */
  describe('活动补充拉取：首次拉取早于 entry 落盘 + 帧不可靠窗口的丢帧补偿', () => {
    /** assistant 消息活动帧（message_start 首选；payload 形状本 handler 不消费） */
    function dispatchActivity(sid: string, type: 'message.message_start' | 'message.complete' = 'message.message_start'): void {
      events.dispatchSession(sid, { type, payload: { sessionId: sid } })
    }

    it('首次拉取回 INACTIVE + planState 帧全程未达 → 消息活动触发补充拉取 → 真值恢复 view', async () => {
      const host = mountHost('A')
      await settle()
      // 首次拉取 reply = INACTIVE（真机形态：plan-state entry 尚未落盘时冷读）
      resolveLatestForSid('A', { sessionId: 'A', planState: planStateOf('A', { isActive: false }) })
      await settle()
      expect(host.plan.view.value?.isActive).toBe(false)

      // session.planState 帧不 dispatch（真机：帧早于订阅送达 / 未发布——两条路径全断）

      // assistant 消息开始（turn 内最早活动信号）→ 补充拉取发出
      dispatchActivity('A')
      await settle()
      expect(commandMock).toHaveBeenCalledTimes(2) // 首次拉取 + 补充拉取

      // 补充拉取 reply = planning（entry 已落盘后的冷读真值）→ view 恢复活跃
      resolveLatestForSid('A', { sessionId: 'A', planState: planStateOf('A') })
      await settle()
      expect(host.plan.view.value?.isActive).toBe(true)
      expect(host.plan.stage.value).not.toBeNull()
    })

    it('message.complete 同样触发补充拉取（长 turn 多消息兜底锚点）', async () => {
      const host = mountHost('A')
      await settle()
      resolveLatestForSid('A', { sessionId: 'A', planState: planStateOf('A', { isActive: false }) })
      await settle()

      dispatchActivity('A', 'message.complete')
      await settle()
      expect(commandMock).toHaveBeenCalledTimes(2)
    })

    it('[ADR-0122] 无冷却门：紧随的后续活动信号同样按门条件触发补充拉取（时间节流已删）', async () => {
      const host = mountHost('A')
      await settle()
      resolveLatestForSid('A', { sessionId: 'A', planState: planStateOf('A', { isActive: false }) })
      await settle()

      dispatchActivity('A')
      await settle()
      expect(commandMock).toHaveBeenCalledTimes(2)
      resolveLatestForSid('A', { sessionId: 'A', planState: planStateOf('A', { isActive: false }) })
      await settle()

      // 紧随的第二条活动信号：仍按非活跃门直接补充拉取（无冷却节流）
      dispatchActivity('A')
      await settle()
      expect(commandMock).toHaveBeenCalledTimes(3)
    })

    it('非活跃门：view 已被 live 帧点亮时活动信号不触发补充拉取（活跃态由帧链自持）', async () => {
      const host = mountHost('A')
      await settle()
      dispatchPlanState('A', planStateOf('A')) // live 帧点亮
      await settle()
      expect(host.plan.view.value?.isActive).toBe(true)

      dispatchActivity('A')
      await settle()
      expect(commandMock).toHaveBeenCalledTimes(1) // 仅首次拉取，无补充拉取
    })

    it('活跃冻结检测（F-W3-2）：view 活跃但帧链无进展时，消息边沿触发补充拉取', async () => {
      const host = mountHost('A')
      await settle()
      // live 帧点亮 view（②形态：planning + docs，frameRev=1）——真机 6c3：此后帧链再无帧到达
      dispatchPlanState('A', planStateOf('A', { docs: [DOC], state: 'planning' }))
      await settle()
      expect(host.plan.view.value?.state).toBe('planning')

      // 首条消息边沿：只立帧基准，不补充拉取（健康链路常态 turn 不产生补充拉取）
      dispatchActivity('A')
      await settle()
      expect(commandMock).toHaveBeenCalledTimes(1)

      // 第二条边沿：frameRev 无增长 = planState 帧链疑死 → 补充拉取直读磁盘
      dispatchActivity('A')
      await settle()
      expect(commandMock).toHaveBeenCalledTimes(2)

      // 补充拉取 reply = 恢复后的磁盘真值（dispatching）→ 阶段指示收敛 ③已批准
      resolveLatestForSid('A', { sessionId: 'A', planState: planStateOf('A', { docs: [DOC], state: 'dispatching' }) })
      await settle()
      expect(host.plan.view.value?.state).toBe('dispatching')
      expect(host.plan.stage.value).toBe('approved')
    })

    it('帧链恢复自动静默：frameRev 增长（planState 帧到达）后，消息边沿不再补充拉取', async () => {
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

      // 后续消息边沿：rev 有进展 → 不补充拉取（活跃态重新由帧链自持）
      dispatchActivity('A')
      await settle()
      expect(commandMock).toHaveBeenCalledTimes(1)
    })

    it('补充拉取走 updateFor(sid)：焦点 session 的活动信号补充拉取写自身分区（capturedSid 语义）', async () => {
      const host = mountHost('A')
      await settle()
      resolveLatestForSid('A', { sessionId: 'A', planState: planStateOf('A', { isActive: false }) })
      await settle()

      // 切焦点到 B（A 的订阅退订，A 分区数据保留；后台 session 无消费方=无活动信号转发）
      host.sidRef.value = 'B'
      await settle()
      resolveLatestForSid('B', { sessionId: 'B', planState: planStateOf('B', { isActive: false }) })
      await settle()

      // 焦点 B 的活动信号正常补充拉取且只写 B 分区
      dispatchActivity('B')
      await settle()
      expect(commandMock).toHaveBeenCalledTimes(3) // A 首次拉取 + B 首次拉取 + B 补充拉取
      resolveLatestForSid('B', { sessionId: 'B', planState: planStateOf('B') })
      await settle()
      expect(host.plan.view.value?.isActive).toBe(true)
    })
  })

  // ── 崩溃恢复对账：session.restored 边沿主动拉取（F-W3-2 恢复链重确认）──────────────

  describe('崩溃恢复对账：session.restored 边沿主动拉取', () => {
    it('restored 帧到达即主动拉取磁盘真值（不切换焦点也有重确认触发点）', async () => {
      const host = mountHost('A')
      await settle()
      // view 停在恢复前的旧形态（首次拉取 deferred 未 resolve，分区为 null 也可——本用例断言拉取触发）
      events.dispatchSession('A', {
        type: 'session.restored',
        payload: { sessionId: 'A', attempts: 1 },
      })
      await settle()
      expect(commandMock).toHaveBeenCalledTimes(2) // 首次拉取 + restored 主动拉取

      resolveLatestForSid('A', { sessionId: 'A', planState: planStateOf('A', { docs: [DOC], state: 'dispatching' }) })
      await settle()
      expect(host.plan.view.value?.state).toBe('dispatching')
    })
  })

  // ── 评论草稿：usePlanState 转发接线 + 清理编排增量 ───────────────
  // 草稿的焦点分区语义本体（加/删/清只作用焦点、跨区隔离、null 焦点 no-op）归
  // plan-store.test.ts「评论草稿：焦点分区操作与 per-session 隔离」；此处只测
  // composable 转发接线（removeDraft 唯一杀伤点）与 cleanup 编排（重新拉取增量）。

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
      // 首次拉取是受控 deferred、用例不 resolve → 分区 view 恒 null），真机时序是审阅态（view
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
      // A 分区重新惰性 init：草稿与 view 全空（下次进入重新首次拉取）
      expect(host.plan.drafts.value).toEqual([])
      expect(host.plan.view.value).toBeNull()
      expect(commandMock).toHaveBeenCalledTimes(3) // 切回 A 触发重新首次拉取

      host.sidRef.value = 'B'
      await settle()
      // B 分区不受 A 清理影响
      expect(host.plan.drafts.value).toEqual([{ quote: 'q2', comment: 'c2' }])
      expect(host.plan.view.value?.state).toBe('reviewing')
    })
  })
})

// ═══ 来源节：use-pi-presets.test.ts —— usePiPresets 编排层 + u5 加载点 ═══
describe('use-pi-presets', () => {
  const FIXTURE_PRESETS: PiLaunchPreset[] = [
    { id: 'builtin:full', name: '全工具模式', builtin: true, order: 0, toolMode: 'all', extensionMode: 'all' },
    { id: 'builtin:readonly', name: '只读模式', builtin: true, order: 2, toolMode: 'allowlist', allowedTools: ['read'], extensionMode: 'all' },
  ]

  beforeEach(() => {
    setActivePinia(createPinia())
    presetApiMock.list.mockReset()
    presetApiMock.getDefault.mockReset()
    presetApiMock.setDefault.mockReset()
    presetApiMock.create.mockReset()
    presetApiMock.update.mockReset()
    presetApiMock.remove.mockReset()
    provideSettingsTransport(makeSettingsTransportStub({
      listPresets: presetApiMock.list,
      getDefaultPreset: presetApiMock.getDefault,
      setDefaultPreset: presetApiMock.setDefault,
      createPreset: presetApiMock.create,
      updatePreset: presetApiMock.update,
      removePreset: presetApiMock.remove,
    }))
  })

  describe('usePiPresets.loadPresets（TC-4）', () => {
    it('loadPresets() → list 与 getDefault 并行调用，结果写 store', async () => {
      presetApiMock.list.mockResolvedValueOnce(FIXTURE_PRESETS)
      presetApiMock.getDefault.mockResolvedValueOnce('builtin:full')

      const store = usePresetStore()
      const { loadPresets } = usePiPresets()
      await loadPresets()

      expect(presetApiMock.list).toHaveBeenCalledTimes(1)
      expect(presetApiMock.getDefault).toHaveBeenCalledTimes(1)
      expect(store.presets).toEqual(FIXTURE_PRESETS)
      expect(store.defaultPresetId).toBe('builtin:full')
    })

    it('loadPresets 降级：getDefault reject 不阻断 list 写 store（allSettled）', async () => {
      presetApiMock.list.mockResolvedValueOnce(FIXTURE_PRESETS)
      presetApiMock.getDefault.mockRejectedValueOnce(new Error('rpc failed'))

      const store = usePresetStore()
      const { loadPresets } = usePiPresets()
      await loadPresets()

      // list 成功 → presets 写入；getDefault 失败 → defaultPresetId 保持初值 ''
      expect(store.presets).toEqual(FIXTURE_PRESETS)
      expect(store.defaultPresetId).toBe('')
    })

    it('loadPresets 降级：list reject 不阻断 getDefault 写 store（allSettled）', async () => {
      presetApiMock.list.mockRejectedValueOnce(new Error('rpc failed'))
      presetApiMock.getDefault.mockResolvedValueOnce('builtin:readonly')

      const store = usePresetStore()
      const { loadPresets } = usePiPresets()
      await loadPresets()

      expect(store.presets).toEqual([])
      expect(store.defaultPresetId).toBe('builtin:readonly')
    })
  })

  describe('usePiPresets.setDefault（TC-5）', () => {
    it('setDefault(id) → 乐观更新 store + 调 RPC', async () => {
      presetApiMock.setDefault.mockResolvedValueOnce(undefined)
      presetApiMock.list.mockResolvedValueOnce(FIXTURE_PRESETS)
      presetApiMock.getDefault.mockResolvedValueOnce('builtin:readonly')

      const store = usePresetStore()
      const { setDefault } = usePiPresets()
      await setDefault('builtin:readonly')

      expect(store.defaultPresetId).toBe('builtin:readonly')
      expect(presetApiMock.setDefault).toHaveBeenCalledWith('builtin:readonly')
    })

    it('setDefault 成功后强拉权威值：getDefault 回读覆盖乐观镜像（RD-4#2）', async () => {
      const store = usePresetStore()
      store.setDefaultPresetId('builtin:full')
      // 写成功，但权威回读返回旧值（模拟 runtime 规范化/拒绝场景）——强拉必须覆盖乐观镜像
      presetApiMock.setDefault.mockResolvedValueOnce(undefined)
      presetApiMock.list.mockResolvedValueOnce(FIXTURE_PRESETS)
      presetApiMock.getDefault.mockResolvedValueOnce('builtin:full')

      const { setDefault } = usePiPresets()
      await setDefault('builtin:readonly')

      expect(presetApiMock.list).toHaveBeenCalledTimes(1)
      expect(presetApiMock.getDefault).toHaveBeenCalledTimes(1)
      expect(store.defaultPresetId).toBe('builtin:full')
    })

    it('setDefault RPC 失败 → 回滚 defaultPresetId 至旧值 + throw（RD-4#2，与 create 同构）', async () => {
      const store = usePresetStore()
      store.setDefaultPresetId('builtin:full')
      presetApiMock.setDefault.mockRejectedValueOnce(new Error('rpc failed'))

      const { setDefault } = usePiPresets()
      await expect(setDefault('builtin:readonly')).rejects.toThrow('rpc failed')

      // 回滚：store 回到旧默认值，不再显示未落盘的新值
      expect(store.defaultPresetId).toBe('builtin:full')
      // 失败分支不触发强拉
      expect(presetApiMock.list).not.toHaveBeenCalled()
    })
  })

  describe('usePiPresets.create（W-RN-3 reply 回写）', () => {
    it('create(preset) → 乐观 upsert + RPC reply 回写 store（runtime 补全字段）', async () => {
      const input: PiLaunchPreset = {
        id: 'custom:abc',
        name: '新预设',
        builtin: false,
        order: 99,
        toolMode: 'all',
        extensionMode: 'all',
      }
      // runtime reply 补全 order（99 → 3）
      const saved: PiLaunchPreset = { ...input, order: 3 }
      presetApiMock.create.mockResolvedValueOnce(saved)

      const store = usePresetStore()
      const { create } = usePiPresets()
      const result = await create(input)

      // 调用了 RPC
      expect(presetApiMock.create).toHaveBeenCalledWith(input)
      // 返回值是 reply（不是输入）
      expect(result).toEqual(saved)
      // store 里是 runtime 规范化后的 order=3（reply 回写覆盖乐观镜像）
      expect(store.presets).toHaveLength(1)
      expect(store.presets[0]!.order).toBe(3)
    })

    it('create RPC 失败 → 移除乐观插入的预设 + throw', async () => {
      const input: PiLaunchPreset = {
        id: 'custom:fail',
        name: '失败预设',
        builtin: false,
        order: 0,
        toolMode: 'all',
        extensionMode: 'all',
      }
      presetApiMock.create.mockRejectedValueOnce(new Error('rpc failed'))

      const store = usePresetStore()
      const { create } = usePiPresets()
      await expect(create(input)).rejects.toThrow('rpc failed')

      // 失败回滚：store 里没有该预设
      expect(store.presets.find((p) => p.id === 'custom:fail')).toBeUndefined()
    })
  })

  describe('usePiPresets.update（W-RN-3 reply 回写）', () => {
    it('update(preset) → 乐观 upsert + RPC reply 回写 store', async () => {
      const original: PiLaunchPreset = {
        id: 'builtin:full',
        name: '全工具模式',
        builtin: true,
        order: 0,
        toolMode: 'all',
        extensionMode: 'all',
      }
      const store = usePresetStore()
      store.setPresets([original])
      const input: PiLaunchPreset = { ...original, toolMode: 'denylist', deniedTools: ['bash'] }
      // runtime reply（PresetGuard 规范化后的权威态）
      const saved: PiLaunchPreset = { ...input, deniedTools: ['bash', 'edit'] }
      presetApiMock.update.mockResolvedValueOnce(saved)

      const { update } = usePiPresets()
      const result = await update(input)

      expect(presetApiMock.update).toHaveBeenCalledWith(input)
      expect(result).toEqual(saved)
      // store 里是 reply 的权威态
      expect(store.presets[0]!.deniedTools).toEqual(['bash', 'edit'])
    })

    it('update RPC 失败 → loadPresets 全量刷新回滚 + throw', async () => {
      const original: PiLaunchPreset = {
        id: 'builtin:full',
        name: '全工具模式',
        builtin: true,
        order: 0,
        toolMode: 'all',
        extensionMode: 'all',
      }
      const store = usePresetStore()
      store.setPresets([original])
      // 失败后 loadPresets 全量刷新（list 返回原值）
      presetApiMock.update.mockRejectedValueOnce(new Error('rpc failed'))
      presetApiMock.list.mockResolvedValueOnce([original])
      presetApiMock.getDefault.mockResolvedValueOnce('builtin:full')

      const { update } = usePiPresets()
      const input: PiLaunchPreset = { ...original, toolMode: 'denylist' }
      await expect(update(input)).rejects.toThrow('rpc failed')

      // loadPresets 回滚：toolMode 恢复为原值
      expect(store.presets[0]!.toolMode).toBe('all')
      expect(presetApiMock.list).toHaveBeenCalledTimes(1)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // u5 mode-declaration-row · 加载点（设计 §6.5 P0-12）：首次 connected 必拉一次，
  // 重连不重复；加载失败不置位 → 下一次 connected 补充拉取（E7 ③ 恢复通道）。
  // ─────────────────────────────────────────────────────────────────────────
  describe('usePiPresets.installPresetAutoLoad（u5 加载点）', () => {
    // 每用例新自动加载容器（createPresetAutoLoad 实例即隔离，不碰生产默认单例）
    let autoLoad: ReturnType<typeof createPresetAutoLoad>

    beforeEach(() => {
      autoLoad = createPresetAutoLoad()
      wsMock.ref!.value = 'disconnected'
    })

    afterEach(() => {
      wsMock.ref!.value = 'disconnected'
    })

    it('首次 connected → 拉一次（list/getDefault 各一次）；重连不重复拉', async () => {
      presetApiMock.list.mockResolvedValue(FIXTURE_PRESETS)
      presetApiMock.getDefault.mockResolvedValue('builtin:full')

      autoLoad.install()
      // 安装时未 connected → 不拉（bootstrap 只提交连接不等于 connected）
      expect(presetApiMock.list).not.toHaveBeenCalled()

      wsMock.ref!.value = 'connected'
      await flushPromises()
      expect(presetApiMock.list).toHaveBeenCalledTimes(1)
      expect(presetApiMock.getDefault).toHaveBeenCalledTimes(1)
      expect(usePresetStore().presets).toEqual(FIXTURE_PRESETS)

      // 重连边沿：disconnected → connected 不重复拉
      wsMock.ref!.value = 'reconnecting'
      await flushPromises()
      wsMock.ref!.value = 'connected'
      await flushPromises()
      expect(presetApiMock.list).toHaveBeenCalledTimes(1)
    })

    it('安装时已 connected（AppShell 稳态：仅在 connected 后渲染）→ immediate 拉一次', async () => {
      presetApiMock.list.mockResolvedValue(FIXTURE_PRESETS)
      presetApiMock.getDefault.mockResolvedValue('builtin:full')
      wsMock.ref!.value = 'connected'

      autoLoad.install()
      await flushPromises()
      expect(presetApiMock.list).toHaveBeenCalledTimes(1)
      expect(usePresetStore().defaultPresetId).toBe('builtin:full')
    })

    it('加载失败 → 不置位，下一次 connected 补充拉取（E7 ③ 恢复通道）', async () => {
      presetApiMock.list.mockRejectedValueOnce(new Error('rpc failed'))
      presetApiMock.getDefault.mockRejectedValueOnce(new Error('rpc failed'))

      autoLoad.install()
      wsMock.ref!.value = 'connected'
      await flushPromises()
      expect(presetApiMock.list).toHaveBeenCalledTimes(1)
      expect(usePresetStore().loadError).not.toBeNull()

      // 下一次 connected：因未置位而补充拉取，成功后清错误态
      presetApiMock.list.mockResolvedValueOnce(FIXTURE_PRESETS)
      presetApiMock.getDefault.mockResolvedValueOnce('builtin:full')
      wsMock.ref!.value = 'disconnected'
      await flushPromises()
      wsMock.ref!.value = 'connected'
      await flushPromises()
      expect(presetApiMock.list).toHaveBeenCalledTimes(2)
      expect(usePresetStore().loadError).toBeNull()
      expect(usePresetStore().presets).toEqual(FIXTURE_PRESETS)
    })

    it('幂等：重复 installPresetAutoLoad 只挂一个 watcher（不重复拉）', async () => {
      presetApiMock.list.mockResolvedValue(FIXTURE_PRESETS)
      presetApiMock.getDefault.mockResolvedValue('builtin:full')
      wsMock.ref!.value = 'connected'

      autoLoad.install()
      autoLoad.install()
      await flushPromises()
      expect(presetApiMock.list).toHaveBeenCalledTimes(1)
    })
  })
})

// ═══ 来源节：features/browser/shields-view-sync.test.ts —— shieldsView 遮蔽视图全量上报 ═══
describe('features/browser/shields-view-sync', () => {
  type Rect = { x: number; y: number; width: number; height: number }
  type FacesCall = { faces: Array<{ id: string; fullscreen: boolean; rect?: Rect }> }

  function sentCalls(): FacesCall[] {
    return mockBrowserSetShields.mock.calls.map((call) => call[0] as FacesCall)
  }

  /** 常驻宿主（useShieldsViewSync 挂载要求：不随表面开合卸载） */
  function mountSyncHost() {
    return mount(defineComponent({
      setup() {
        useShieldsViewSync()
        return () => h('div', { 'data-testid': 'sync-host' })
      },
    }))
  }

  /** 开合可翻的表面宿主（挂载即注册，isOpen 读注入 ref——SessionList 同款参考模式） */
  function mountSurface(surface: 'search-modal' | 'rolling-restart-banner', key: string, options: { rect?: () => Rect | null } = {}) {
    const open = ref(false)
    const wrapper = mount(defineComponent({
      setup() {
        const dispose = registerModalSurface({ surface, key, isOpen: () => open.value, ...options })
        onScopeDispose(dispose)
        return () => h('div')
      },
    }))
    return { wrapper, open }
  }

  /** 恒开表面（挂载⇔开形态：isOpen 不读任何响应式 ref，卸载即注销） */
  function mountAlwaysOpenSurface(surface: 'form-overlay' | 'toast-container', key: string) {
    return mount(defineComponent({
      setup() {
        const dispose = registerModalSurface({ surface, key, isOpen: () => true })
        onScopeDispose(dispose)
        return () => h('div')
      },
    }))
  }

  beforeEach(() => {
    resetModalSurfaceRegistry()
    _resetOverlayForTest()
    mockBrowserSetShields.mockClear()
  })

  afterEach(() => {
    _resetOverlayForTest()
  })

  describe('faces payload 形状（§7.4 ShieldFace 契约）', () => {
    it('全屏阻塞遮罩 = {id, fullscreen:true} 不带 rect；非全屏遮罩带实测 rect；未提供几何读点省略 rect 键', async () => {
      mountSyncHost()
      const unconditional = mountSurface('search-modal', 'sm')
      const intersecting = mountSurface('rolling-restart-banner', 'rr', {
        rect: () => ({ x: 10, y: 20, width: 300, height: 40 }),
      })
      mountAlwaysOpenSurface('toast-container', 'tc') // 非全屏族但无 rect 读点

      unconditional.open.value = true
      intersecting.open.value = true
      await nextTick()
      await nextTick()

      const last = sentCalls().at(-1)!
      const faces = [...last.faces].sort((a, b) => (a.id < b.id ? -1 : 1))
      expect(faces).toEqual([
        { id: 'rolling-restart-banner', fullscreen: false, rect: { x: 10, y: 20, width: 300, height: 40 } },
        { id: 'search-modal', fullscreen: true },
        { id: 'toast-container', fullscreen: false },
      ])
      expect(faces[1]).not.toHaveProperty('rect')
      expect(faces[2]).not.toHaveProperty('rect')
    })
  })

  describe('开关触发上报（真实事件序：ref 翻转 → flush 即报，无 debounce）', () => {
    it('成员开 → flush 后上报含该面；关 → 上报空集；重开 → 再报', async () => {
      mountSyncHost()
      const surface = mountSurface('search-modal', 'sm')
      expect(sentCalls()).toEqual([{ faces: [] }])

      surface.open.value = true
      await nextTick()
      await nextTick()
      expect(sentCalls().at(-1)).toEqual({ faces: [{ id: 'search-modal', fullscreen: true }] })

      surface.open.value = false
      await nextTick()
      await nextTick()
      expect(sentCalls().at(-1)).toEqual({ faces: [] })

      surface.open.value = true
      await nextTick()
      await nextTick()
      expect(sentCalls()).toHaveLength(4)
      expect(sentCalls().at(-1)).toEqual({ faces: [{ id: 'search-modal', fullscreen: true }] })
    })

    it('挂载⇔开型成员（isOpen 不读响应式 ref）：卸载注销经成员表版本号触发重报', async () => {
      mountSyncHost()
      const surface = mountAlwaysOpenSurface('form-overlay', 'fo')
      await nextTick()
      await nextTick()
      expect(sentCalls().at(-1)).toEqual({ faces: [{ id: 'form-overlay', fullscreen: true }] })

      surface.unmount()
      await nextTick()
      await nextTick()
      expect(sentCalls().at(-1)).toEqual({ faces: [] })
    })

    it('overlay 内容切换触发范围：unconditional 面随浮层开合让位上报一次，faces 无变化时重算不上报（变化才上报，内容比较收敛）', async () => {
      mountSyncHost()
      const surface = mountSurface('search-modal', 'sm')
      surface.open.value = true
      await nextTick()
      await nextTick()

      // 浮层开 → unconditional 面（search-modal）让位（05f496948：被壳盖住无需避让）——
      // faces 全集真实变化 ⇒ 上报一次（合法）
      openOverlay({ kind: 'browser', payload: { sessionId: 'sess-a', url: 'http://localhost:1420/' } })
      await nextTick()
      await nextTick()
      expect(sentCalls().at(-1)).toEqual({ faces: [] })
      const callsAfterOverlayOpen = mockBrowserSetShields.mock.calls.length

      // overlay 换内容（browser → browser，另一 url）——faces 全集不变 ⇒ 重算等值 ⇒ 不产生新 IPC
      openOverlay({ kind: 'browser', payload: { sessionId: 'sess-a', url: 'http://localhost:9999/' } })
      await nextTick()
      await nextTick()
      expect(mockBrowserSetShields.mock.calls.length).toBe(callsAfterOverlayOpen)
    })
  })

  describe('resize 触发范围（§6.7：事件直推重测，无防抖）', () => {
    it('开态内几何变化 + window resize 事件 → 立即重报新 rect（不依赖响应式依赖）', async () => {
      mountSyncHost()
      const currentRect = { x: 10, y: 10, width: 200, height: 30 }
      const surface = mountSurface('rolling-restart-banner', 'rr', { rect: () => ({ ...currentRect }) })
      surface.open.value = true
      await nextTick()
      await nextTick()
      expect(sentCalls().at(-1)).toEqual({
        faces: [{ id: 'rolling-restart-banner', fullscreen: false, rect: { x: 10, y: 10, width: 200, height: 30 } }],
      })

      // 横幅改宽（真实场景：memory bar 文案随 level 切换）——DOM 几何非响应式，resize 事件直推
      currentRect.width = 320
      window.dispatchEvent(new Event('resize'))
      expect(sentCalls().at(-1)).toEqual({
        faces: [{ id: 'rolling-restart-banner', fullscreen: false, rect: { x: 10, y: 10, width: 320, height: 30 } }],
      })
    })
  })

  describe('卸载对称（composable 宿主卸载 → 空 faces 复位）', () => {
    it('宿主卸载上报空 faces；重挂后首报必达（lastSent 复位）', async () => {
      const host = mountSyncHost()
      const surface = mountSurface('search-modal', 'sm')
      surface.open.value = true
      await nextTick()
      await nextTick()
      expect(sentCalls().at(-1)).toEqual({ faces: [{ id: 'search-modal', fullscreen: true }] })

      host.unmount()
      await nextTick()
      expect(sentCalls().at(-1)).toEqual({ faces: [] })

      mountSyncHost()
      await nextTick()
      await nextTick()
      expect(sentCalls().at(-1)).toEqual({ faces: [{ id: 'search-modal', fullscreen: true }] })
    })
  })
})

// ═══ 来源节：use-plan-drawer-sync.test.ts —— drawer「计划产物」tab 自动打开接线 ═══
describe('use-plan-drawer-sync', () => {
  // ── 测试基建 ─────────────────────────────────────────────────

  /** 帧工厂（四必填字段基线，用例按需覆写 plan 新字段——D4 optional） */
  function planStateOf(overrides: Partial<PlanStateView> = {}): PlanStateView {
    return {
      isActive: false,
      planFilePath: null,
      requirement: null,
      templateName: null,
      ...overrides,
    }
  }

  const mountedWrappers: VueWrapper[] = []

  /** 宿主组件：setup 内调 usePlanDrawerSync（与 PanelContainer 同形态），unmount 自动停 watch */
  function mountHost(): void {
    const Host = defineComponent({
      name: 'PlanDrawerSyncHost',
      setup() {
        usePlanDrawerSync()
        return () => h('div')
      },
    })
    mountedWrappers.push(mount(Host))
  }

  async function flush(): Promise<void> {
    await nextTick()
    await nextTick()
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    drawerMock.openDrawerTab.mockClear()
    drawerMock.setIsOpen?.(false)
  })

  describe('usePlanDrawerSync（u-drawer-gate：门控修复后仅 docs 0→1 触发）', () => {
    it('isActive 翻转不开窗（§3.2 删 activated 触发；激活即空弹已删）', async () => {
      const store = usePlanStore()
      mountHost()
      store.syncFocus('sess-a')
      store.applyFrame('sess-a', planStateOf({ isActive: false }))
      await flush()
      expect(drawerMock.openDrawerTab).not.toHaveBeenCalled()

      // false→true：不开窗（docs 仍空，无内容可看）
      store.applyFrame('sess-a', planStateOf({ isActive: true }))
      await flush()
      expect(drawerMock.openDrawerTab).not.toHaveBeenCalled()

      // true→false（退出）：同样不开窗
      store.applyFrame('sess-a', planStateOf({ isActive: false }))
      await flush()
      expect(drawerMock.openDrawerTab).not.toHaveBeenCalled()
    })

    it('docs 0→1：发；docs 1→2 不发（仅首份产物边界）', async () => {
      const store = usePlanStore()
      mountHost()
      store.syncFocus('sess-doc')
      // 激活基线（isActive 翻转不再消耗打开请求——触发只剩 docs 边界）
      store.applyFrame('sess-doc', planStateOf({ isActive: true, docs: [] }))
      await flush()
      expect(drawerMock.openDrawerTab).not.toHaveBeenCalled()

      const doc = { fileName: 'design.md', absPath: '/d/design.md', sourceSkill: 'tech-design', version: 1 }
      store.applyFrame('sess-doc', planStateOf({ isActive: true, docs: [doc] }))
      await flush()
      expect(drawerMock.openDrawerTab).toHaveBeenCalledTimes(1)
      expect(drawerMock.openDrawerTab).toHaveBeenCalledWith('plan')

      // 1→2：tab 已在，L2 清单由 u1-docs-panel 响应式驱动，不重开
      drawerMock.openDrawerTab.mockClear()
      store.applyFrame('sess-doc', planStateOf({ isActive: true, docs: [doc, { ...doc, fileName: 'impl-plan.md' }] }))
      await flush()
      expect(drawerMock.openDrawerTab).not.toHaveBeenCalled()
    })

    it('已开不重发：docs 0→1 时 drawer 已开不发（不动用户当前 tab）；关闭后的新一轮翻转仍发', async () => {
      const store = usePlanStore()
      mountHost()
      store.syncFocus('sess-open')
      store.applyFrame('sess-open', planStateOf({ isActive: true, docs: [] }))
      await flush()

      // 首份产物就绪，但 drawer 已开（用户在看其他 tab）→ 不拽回
      drawerMock.setIsOpen?.(true)
      store.applyFrame('sess-open', planStateOf({ isActive: true, docs: [{ fileName: 'a.md', absPath: '/d/a.md', sourceSkill: 's', version: 1 }] }))
      await flush()
      expect(drawerMock.openDrawerTab).not.toHaveBeenCalled()

      // drawer 关闭后的新事件（新一轮 docs 重置后 0→1）是新提示
      drawerMock.setIsOpen?.(false)
      store.applyFrame('sess-open', planStateOf({ isActive: true, docs: [] }))
      await flush()
      store.applyFrame('sess-open', planStateOf({ isActive: true, docs: [{ fileName: 'b.md', absPath: '/d/b.md', sourceSkill: 's', version: 1 }] }))
      await flush()
      expect(drawerMock.openDrawerTab).toHaveBeenCalledTimes(1)
    })

    it('切走不发：非焦点 session 的首份产物帧不触发（焦点视图不受非焦点分区写入影响）', async () => {
      const store = usePlanStore()
      mountHost()
      store.syncFocus('sess-focus')
      store.applyFrame('sess-focus', planStateOf({ isActive: true, docs: [] }))
      await flush()

      // 用户切到另一 session
      store.syncFocus('sess-other')
      await flush()
      // 原 session 的首份产物帧迟到到达（写入的是非焦点分区）→ 不开窗
      store.applyFrame('sess-focus', planStateOf({ isActive: true, docs: [{ fileName: 'a.md', absPath: '/d/a.md', sourceSkill: 's', version: 1 }] }))
      await flush()
      expect(drawerMock.openDrawerTab).not.toHaveBeenCalled()

      // 焦点 session 自身跨越 docs 边界仍发
      store.applyFrame('sess-other', planStateOf({ isActive: true, docs: [{ fileName: 'b.md', absPath: '/d/b.md', sourceSkill: 's', version: 1 }] }))
      await flush()
      expect(drawerMock.openDrawerTab).toHaveBeenCalledTimes(1)
      expect(drawerMock.openDrawerTab).toHaveBeenCalledWith('plan')
    })

    it('切回不重复打开：切走再切回、无新翻转 → 不发', async () => {
      const store = usePlanStore()
      mountHost()
      store.syncFocus('sess-back')
      store.applyFrame('sess-back', planStateOf({ isActive: true, docs: [] }))
      await flush()
      store.applyFrame('sess-back', planStateOf({ isActive: true, docs: [{ fileName: 'a.md', absPath: '/d/a.md', sourceSkill: 's', version: 1 }] }))
      await flush()
      expect(drawerMock.openDrawerTab).toHaveBeenCalledTimes(1)

      // 切走再切回：无新翻转，不重发
      store.syncFocus('sess-back-b')
      await flush()
      store.syncFocus('sess-back')
      await flush()
      expect(drawerMock.openDrawerTab).toHaveBeenCalledTimes(1)
    })

    it('挂载即有状态不触发（重开恢复 isActive=true / docs 已有）；重进后 docs 0→1 触发', async () => {
      const store = usePlanStore()
      // 挂载前先置激活态（重开 session 恢复 isActive=true 的形态）——watch 非 immediate，
      // 挂载态是基线，不打开
      store.syncFocus('sess-reenter')
      store.applyFrame('sess-reenter', planStateOf({ isActive: true }))
      mountHost()
      await flush()
      expect(drawerMock.openDrawerTab).not.toHaveBeenCalled()

      // 重进（true→false→true）本身不触发——触发只剩 docs 边界
      store.applyFrame('sess-reenter', planStateOf({ isActive: false }))
      await flush()
      store.applyFrame('sess-reenter', planStateOf({ isActive: true, docs: [] }))
      await flush()
      expect(drawerMock.openDrawerTab).not.toHaveBeenCalled()

      // 首份产物就绪才开窗
      store.applyFrame('sess-reenter', planStateOf({ isActive: true, docs: [{ fileName: 'a.md', absPath: '/d/a.md', sourceSkill: 's', version: 1 }] }))
      await flush()
      expect(drawerMock.openDrawerTab).toHaveBeenCalledTimes(1)
      expect(drawerMock.openDrawerTab).toHaveBeenCalledWith('plan')
    })
  })
})
