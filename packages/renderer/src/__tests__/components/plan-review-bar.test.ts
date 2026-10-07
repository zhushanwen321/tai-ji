/**
 * PlanReviewBar 组件单测 —— plan 模式状态机显式化（设计 D3/D4/D8/D9，U4b 审批交互重设计）。
 *
 * 覆盖（impl-plan U4b 验收条款②③⑤ + S15 renderer 断言族）：
 * - D4 分支公式单源化（derivePlanReviewBarMode）逐分支 DOM 断言：
 *   ① ready ⇔ 挂起注册表（presence 语义——ready 恒优先渲染，revising+挂起共存出 ready）；
 *   ② revising ⇔ state=revising（无挂起）；③ degraded ⇔ state=reviewing ∧ 无挂起 ∧ 组合
 *   放行（[ADR-0122] 帧到达即时评估）；④ isActive=false / dispatching·approved / 其余 → 不渲染
 * - D3 搁置（decision:'dismiss' respond 通道，取代「忽略 = 杀 turn」）：payload 形状、
 *   不经 message.abort、文案含「暂存待办」提示、草稿保留
 * - D4「已应答抑制标记」断言：压制零渲染（事件驱动解除）+ 悬挂无时间自愈 + P2-2 失效帧
 *   同置标记 + 冷拉对账真值解除（显式拉取）
 * - D8 degraded 可行动化：[重新提交审批] 按钮（复用消息发送通道注入固定文案）+ resumeHint
 *   分源文案（'resubmit' / 通用）+ 发送失败就近错误行
 * - D8 检测窗开窗时机（dmg-r1-2）：nudge 轮自身的 message_start 到达才开判定窗——busy
 *   defer 场景（busy 拒绝 reply success + 前置在途 turn 终态信号）不误报「agent 未响应」
 * - D9③ 自审结论行（截断 + Popover 全文；无 selfReview 不渲染）
 * - 两键 respond payload 形状（approve 无 comments / revise 打包草稿快照）+ P2-2 失效帧 +
 *   §3.5 0 评论禁用 / 评论计数回看
 *
 * mock 形态照抄 useExtensionUI.test.ts（真实 InternalEventBus）+ plan-store.test.ts
 * （spread actual 保真实 events 通道只换 command）；i18n 经 vitest-i18n-setup 全局 mock。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/plan-review-bar.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { computed, nextTick } from 'vue'
import { effectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { InternalEventBus } from '@taiji/core'
import type { PlanStateView } from '@taiji/shared'

// ── mock ⓪：drawer domain（§3.5 草稿回看 openDrawerTab）——spread actual：import 链
// （useExtensionUI → chat store → agentcall-lru-linkage）还消费 bindViewedVidPanels 等导出 ──
const openDrawerTabMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/domain/drawer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/domain/drawer')>()
  return { ...actual, openDrawerTab: openDrawerTabMock }
})

// ── mock ⓪½：chat domain（D8 重新提交的消息发送通道 + 回归守卫：搁置不经 message.abort）──
const chatSendMock = vi.hoisted(() => vi.fn(async () => {}))
const chatAbortMock = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@taiji/core/transport/api/domains/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api/domains/chat')>()
  return { ...actual, send: chatSendMock, abort: chatAbortMock }
})

// ── mock ①：command（plan-store 首拉 RPC + D4③ 冷拉 getPlanState）——spread actual 保真实 events 通道 ──
const commandMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api', async (importActual) => {
  const actual = await importActual<typeof import('@taiji/core/transport/api')>()
  return { ...actual, command: commandMock, RPC_BACKSTOP_TIMEOUT_MS: 30_000 }
})

// ── mock ②：extension domain（useExtensionUI 的 WS/RPC 面 + D4③ 冷拉 getPendingRequests）──
// getPendingRequests 引用外提：冷拉对账双源之一，用例按需改写返回值（默认空快照 = 事实上无挂起）
const uiTimeoutHandlers = new Map<string, Array<(requestId: string) => void>>()
const getPendingRequestsMock = vi.hoisted(() => vi.fn())
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
  // 返 true = 送达（M1 环 3 后 respond 消费 boolean；「respond 后出队」用例依赖送达态）
  sendExtensionUIResponse: vi.fn((): boolean => true),
  onNotify: () => () => {},
  onExtensions: vi.fn(),
  getPendingRequests: getPendingRequestsMock,
}))

// ── mock ③：getExtensionBus → 真实 InternalEventBus 实例 ──
let mockBus: InternalEventBus
vi.mock('@/composables/shell/useExtensionHostBridge', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/composables/shell/useExtensionHostBridge')>()
  return { ...original, getExtensionBus: () => mockBus }
})

import PlanReviewBar from '@/components/panel/plan/PlanReviewBar.vue'
import * as events from '@taiji/core/transport/api'
import {
  useExtensionUI,
  formFilter,
  __resetExtensionBusSubscriptionForTesting,
} from '@/composables/useExtensionUI'
import {
  usePlanStore,
  __resetPlanReviewColdSinkForTesting,
} from '@/stores/plan-store'
import { sendExtensionUIResponse } from '@taiji/core/transport/api/domains/extension'

const SID = 'sess-bar'

function viewOf(overrides: Partial<PlanStateView> = {}): PlanStateView {
  return {
    isActive: true,
    planFilePath: '/data/A/.tmp/plans/auth/plan.md',
    requirement: '重构 auth 模块',
    templateName: 'default',
    ...overrides,
  }
}

/** 挂起 planReview 审批请求（runtime event-adapter 广播形状，D5）；可带 selfReview（D9③） */
function emitPlanReviewRequest(requestId = 'pr-1', selfReview?: string): void {
  mockBus.emit({
    kind: 'ui-request',
    sessionId: SID,
    request: {
      requestId,
      pluginId: '',
      kind: 'select',
      method: 'select',
      title: '\x00TAIJI_PLAN_REVIEW:',
      options: [JSON.stringify({ docs: [], ...(selfReview !== undefined ? { selfReview } : {}) })],
      planReview: true,
      ...(selfReview !== undefined ? { selfReview } : {}),
    },
  } as never)
}

/** 挂载注册表：Popover Portal 内容挂在 document.body，用例末尾统一 unmount 清理 */
const mountedWrappers: VueWrapper[] = []

async function mountBar(view: PlanStateView | null = viewOf()): Promise<VueWrapper> {
  commandMock.mockResolvedValue({ sessionId: SID, planState: view })
  const wrapper = mount(PlanReviewBar, { props: { sessionId: SID }, attachTo: document.body })
  mountedWrappers.push(wrapper)
  await flushAsync()
  return wrapper
}

/** 自审结论 Popover 全文层（Portal 在 document.body，wrapper.find 不可见）；null = 未打开 */
function findSelfReviewFull(): DOMWrapper<Element> | null {
  const el = document.body.querySelector('[data-testid="plan-review-self-review-full"]')
  return el ? new DOMWrapper(el) : null
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
  __resetPlanReviewColdSinkForTesting()
  setActivePinia(createPinia())
  commandMock.mockReset()
  getPendingRequestsMock.mockReset().mockResolvedValue([])
  openDrawerTabMock.mockReset()
  chatSendMock.mockClear()
  chatAbortMock.mockClear()
  mockBus = new InternalEventBus()
  uiTimeoutHandlers.clear()
  vi.mocked(sendExtensionUIResponse).mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  while (mountedWrappers.length > 0) {
    const w = mountedWrappers.pop()
    w?.unmount()
  }
})

describe('PlanReviewBar 分支公式（D4 单源：ready ⇔ 挂起注册表，presence 语义）', () => {
  it('分支④ isActive=false → 整体不渲染（退出后挂起缓存残留由 isActive 门兜住）', async () => {
    const wrapper = await mountBar(viewOf({ isActive: false }))
    emitPlanReviewRequest('pr-stale')
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-bar"]').exists()).toBe(false)
  })

  it('分支④ 无 view（首拉 null）→ 不渲染', async () => {
    const wrapper = await mountBar(null)
    expect(wrapper.find('[data-testid="plan-review-bar"]').exists()).toBe(false)
  })

  it('分支① state=reviewing + 有挂起 → 三键（修订/执行/搁置）全功能 + 搁置 tooltip 含「暂存待办」', async () => {
    const wrapper = await mountBar(viewOf({ state: 'reviewing' }))
    emitPlanReviewRequest('pr-1')
    await flushAsync()

    expect(wrapper.find('[data-testid="plan-review-bar"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-review-approve"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-review-revise"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-review-dismiss"]').exists()).toBe(true)
    // 文案锚点：approve 键「确认并执行」；D3 搁置（取代忽略）+「暂存待办」提示
    expect(wrapper.find('[data-testid="plan-review-approve"]').text()).toContain('确认并执行')
    const dismiss = wrapper.find('[data-testid="plan-review-dismiss"]')
    expect(dismiss.text()).toContain('搁置')
    expect(dismiss.attributes('title')).toContain('暂存待办')
    // 旧「忽略」键与危险色形态退役（D3 非破坏 + F16 守卫配重消解）
    expect(wrapper.find('[data-testid="plan-review-ignore"]').exists()).toBe(false)
    expect(dismiss.classes().some((c) => c.includes('danger'))).toBe(false)
    // D13⑦ 0 草稿不渲染评论计数键（常态归零）
    expect(wrapper.find('[data-testid="plan-review-summary"]').exists()).toBe(false)
  })

  it('ready 恒优先渲染（presence 语义）：revising + 挂起共存 → ready 三键（不被 state 分支压制）', async () => {
    const wrapper = await mountBar(viewOf({ state: 'revising' }))
    emitPlanReviewRequest('pr-1')
    await flushAsync()

    expect(wrapper.find('[data-testid="plan-review-approve"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-review-revising"]').exists()).toBe(false)
  })

  it('分支② state=revising（无挂起）→ 修订中状态条，三键不渲染', async () => {
    const wrapper = await mountBar(viewOf({ state: 'revising' }))
    await flushAsync()

    expect(wrapper.find('[data-testid="plan-review-revising"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-review-revising"]').text()).toContain('正在根据评论修订')
    expect(wrapper.find('[data-testid="plan-review-approve"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="plan-review-revise"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="plan-review-dismiss"]').exists()).toBe(false)
  })

  it('挂起请求独立触发渲染：state 缺失 + 有挂起 → ready（瞬态 race 收敛，交互权威 = 注册表）', async () => {
    const wrapper = await mountBar(viewOf()) // state 缺失格
    emitPlanReviewRequest('pr-1')
    await flushAsync()

    expect(wrapper.find('[data-testid="plan-review-approve"]').exists()).toBe(true)
  })

  it('分支④ dispatching 不进审批条（执行方式表单是其唯一交互面）', async () => {
    const wrapper = await mountBar(viewOf({ state: 'dispatching' }))
    await flushAsync()

    expect(wrapper.find('[data-testid="plan-review-bar"]').exists()).toBe(false)
  })

  it('跨实例共享 store：formFilter 实例入队的表单请求不影响 planReview 枚举', async () => {
    const wrapper = await mountBar(viewOf({ state: 'reviewing' }))
    const sidRef = computed(() => SID)
    const scope = effectScope()
    scope.run(() => useExtensionUI(sidRef, formFilter))
    await flushAsync()
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

describe('三键 respond payload（PlanReviewResponse 判别联合，D3 dismiss 加员）', () => {
  it('approve → payload 仅 { decision: "approve" }（结构上无 comments 键），requestId 精确回传', async () => {
    const wrapper = await mountBar(viewOf({ state: 'reviewing' }))
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
    const wrapper = await mountBar(viewOf({ state: 'reviewing' }))
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

    // 跨 run 模拟：同 session 再次 /plan 挂起新审批请求 → 计数归零（旧评论不残留）
    emitPlanReviewRequest('pr-2')
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-approve"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-review-summary"]').exists()).toBe(false)
  })

  it('revise → comments 打包自草稿快照，提交后草稿清空；提交后抑制标记压制零渲染（revising 帧到达后出修订中行）', async () => {
    const wrapper = await mountBar(viewOf({ state: 'reviewing' }))
    emitPlanReviewRequest('pr-1')
    await flushAsync()

    const store = usePlanStore()
    store.addDraftComment({ quote: '这段推导跳步了', comment: '补充状态机图' })
    store.addDraftComment({ quote: '命名不准确', comment: '改用唯一入口表述' })
    await flushAsync()

    await wrapper.find('[data-testid="plan-review-revise"]').trigger('click')

    const result = JSON.parse(vi.mocked(sendExtensionUIResponse).mock.calls[0]![3] as string)
    expect(result).toEqual({
      decision: 'revise',
      comments: [
        { quote: '这段推导跳步了', comment: '补充状态机图' },
        { quote: '命名不准确', comment: '改用唯一入口表述' },
      ],
    })
    // D6：评论已注入对话流持久，草稿生命周期到提交为止
    expect(store.draftComments).toHaveLength(0)
    // D4 抑制标记：已应答待帧标记压制 state 判定分支，不闪 degraded/revising（零渲染）
    expect(wrapper.find('[data-testid="plan-review-bar"]').exists()).toBe(false)
    // 预期后态帧（state=revising ≠ reviewing）到达 → 值判定解除标记 → 修订中行
    usePlanStore().applyFrame(SID, viewOf({ state: 'revising' }))
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-revising"]').exists()).toBe(true)
  })

  it('搁置（D3 dismiss）→ respond {decision:"dismiss"}（不走 message.abort）；草稿保留（暂存待办）', async () => {
    const wrapper = await mountBar(viewOf({ state: 'reviewing' }))
    emitPlanReviewRequest('pr-1')
    await flushAsync()

    const store = usePlanStore()
    store.addDraftComment({ quote: '待办引文', comment: '待办评语' })
    await flushAsync()

    await wrapper.find('[data-testid="plan-review-dismiss"]').trigger('click')
    await flushAsync()

    // 搁置 = 普通 respond（与评论/批准同通道），payload 判别联合 dismiss 员；不经 abort
    expect(vi.mocked(sendExtensionUIResponse)).toHaveBeenCalledTimes(1)
    const result = JSON.parse(vi.mocked(sendExtensionUIResponse).mock.calls[0]![3] as string)
    expect(result).toEqual({ decision: 'dismiss' })
    expect(chatAbortMock).not.toHaveBeenCalled()
    // 暂存待办：计划进度与评论草稿保留（草稿不随应答消费）
    expect(store.draftComments).toHaveLength(1)
    // 已应答抑制标记：提交后整条不渲染（不闪 degraded——dismiss 后 state 帧回流前的时序窗口）
    expect(wrapper.find('[data-testid="plan-review-bar"]').exists()).toBe(false)
  })
})

describe('已应答抑制标记 + degraded 组合判定（D4，[ADR-0122] 帧到达即时评估）', () => {
  it('degraded 即时放行：组合成立（reviewing ∧ 无挂起 ∧ 无标记）帧到达即渲染，无时间窗', async () => {
    const wrapper = await mountBar(viewOf({ state: 'reviewing' }))
    await flushAsync()

    expect(wrapper.find('[data-testid="plan-review-degraded"]').exists()).toBe(true)
  })

  it('组合变假即复位：state 离开 reviewing 即切修订中行；转回 reviewing 即 degraded', async () => {
    const wrapper = await mountBar(viewOf({ state: 'reviewing' }))
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-degraded"]').exists()).toBe(true)

    // 组合变假（state 离开 reviewing → revising 帧）→ 即时复位
    usePlanStore().applyFrame(SID, viewOf({ state: 'revising' }))
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-revising"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-review-degraded"]').exists()).toBe(false)

    // 再转真：即时放行
    usePlanStore().applyFrame(SID, viewOf({ state: 'reviewing' }))
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-degraded"]').exists()).toBe(true)
  })

  it('ready 恒优先：组合成立下新 pending 到达 → ready 立即渲染（presence 优先）', async () => {
    const wrapper = await mountBar(viewOf({ state: 'reviewing' }))
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-degraded"]').exists()).toBe(true)

    emitPlanReviewRequest('pr-gap')
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-approve"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-review-degraded"]').exists()).toBe(false)
  })

  it('冷拉对账真值解除：已应答标记压制零渲染 → 显式冷拉（reviewing ∧ 无挂起真值）→ degraded 渲染', async () => {
    const wrapper = await mountBar(viewOf({ state: 'reviewing' }))
    emitPlanReviewRequest('pr-1')
    await flushAsync()
    await wrapper.find('[data-testid="plan-review-approve"]').trigger('click')
    await flushAsync()
    // 已应答抑制标记：ready 摘除后零渲染
    expect(wrapper.find('[data-testid="plan-review-bar"]').exists()).toBe(false)

    // 显式双源冷拉（getPlanState + getPendingRequests，本 mock 形态 = 真值
    // reviewing ∧ 事实上无挂起）→ 解除标记 + degraded 组合即时放行
    commandMock.mockResolvedValue({ sessionId: SID, planState: viewOf({ state: 'reviewing' }) })
    getPendingRequestsMock.mockResolvedValue([])
    await usePlanStore().coldReconcilePlanReview(SID)
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-degraded"]').exists()).toBe(true)
  })

  it('抑制标记悬挂无时间自愈：搁置后标记压制零渲染，时间流逝不解悬挂（[ADR-0122] 无兜底定时器）', async () => {
    vi.useFakeTimers()
    const wrapper = await mountBar(viewOf({ state: 'reviewing' }))
    emitPlanReviewRequest('pr-1')
    await flushAsync()
    await wrapper.find('[data-testid="plan-review-dismiss"]').trigger('click')

    await vi.advanceTimersByTimeAsync(3000)
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-bar"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="plan-review-degraded"]').exists()).toBe(false)
  })

  it('P2-2 失效帧（requestsInvalidated 摘除）同置已应答标记：ready 消失且 degraded 不闪现', async () => {
    const wrapper = await mountBar(viewOf({ state: 'reviewing' }))
    emitPlanReviewRequest('pr-1')
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-approve"]').exists()).toBe(true)

    mockBus.emit({ kind: 'requests-invalidated', sessionId: SID, requestIds: ['pr-1'], reason: 'turn-aborted' } as never)
    await flushAsync()

    expect(wrapper.find('[data-testid="plan-review-approve"]').exists()).toBe(false)
    // 杀伤锚点：失效链同置已应答标记 → 组合不成立，degraded 不渲染（即时评估下漏置
    // 标记的变异会在 flush 后立即渲染 degraded → 红）
    expect(wrapper.find('[data-testid="plan-review-degraded"]').exists()).toBe(false)
  })
})

describe('degraded 可行动化（D8：成因分源文案 + [重新提交审批] 按钮）', () => {
  it("resumeHint='resubmit'（E3）→「审批提问已随会话重启失效」+ 按钮经消息发送通道注入固定文案", async () => {
    const wrapper = await mountBar(viewOf({ state: 'reviewing', resumeHint: 'resubmit' }))
    await flushAsync()

    const reason = wrapper.find('[data-testid="plan-review-degraded-reason"]')
    expect(reason.text()).toContain('审批提问已随会话重启失效')
    const btn = wrapper.find('[data-testid="plan-review-resubmit"]')
    expect(btn.exists()).toBe(true)

    await btn.trigger('click')
    await flushAsync()
    // D8 写入面：复用消息发送通道（message.send）注入固定文案 user 可见消息
    expect(chatSendMock).toHaveBeenCalledTimes(1)
    expect(chatSendMock).toHaveBeenCalledWith(SID, '请重新提交计划审批')
    // 退出入口收敛：右区无退出按钮（唯一入口 = 左区常驻退出）
    expect(wrapper.find('[data-testid="plan-review-degraded-exit"]').exists()).toBe(false)
  })

  it('其余来源（resumeHint 缺省）→ 「审批提问未挂起」（不猜测来源）', async () => {
    const wrapper = await mountBar(viewOf({ state: 'reviewing' }))
    await flushAsync()

    const reason = wrapper.find('[data-testid="plan-review-degraded-reason"]')
    expect(reason.text()).toContain('审批提问未挂起')
    expect(reason.text()).not.toContain('会话已重启')
    expect(wrapper.find('[data-testid="plan-review-resubmit"]').exists()).toBe(true)
  })

  it('发送失败 → 就近错误行（失败要出声），降级态保留可重试', async () => {
    const wrapper = await mountBar(viewOf({ state: 'reviewing', resumeHint: 'resubmit' }))
    await flushAsync()

    chatSendMock.mockRejectedValueOnce(new Error('ws down'))
    await wrapper.find('[data-testid="plan-review-resubmit"]').trigger('click')
    await flushAsync()
    await flushAsync()

    const err = wrapper.find('[data-testid="plan-review-resubmit-error"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('重新提交失败')
    expect(wrapper.find('[data-testid="plan-review-resubmit"]').exists()).toBe(true)
  })
})

describe('D8「agent 未响应」分支（turn 生命周期信号驱动，非墙钟）', () => {
  /** turn 生命周期事件派发（真实 events 通道，use-plan-sync.test 同款 dispatchSession 形态）；
   *  payloadExtra 透传扩展字段（willRetry 判据用例，event-adapter 透传形态）。
   *  message_start = nudge 轮起点标记（armed → watching 开判定窗，dmg-r1-2） */
  function dispatchTurnEvent(
    type: 'message.message_start' | 'message.complete' | 'message.error' | 'send.rejected',
    payloadExtra: Record<string, unknown> = {},
  ): void {
    events.dispatchSession(SID, { type, payload: { sessionId: SID, ...payloadExtra } } as never)
  }

  async function clickResubmit(wrapper: VueWrapper): Promise<void> {
    await wrapper.find('[data-testid="plan-review-resubmit"]').trigger('click')
    await flushAsync()
  }

  async function mountDegraded(): Promise<VueWrapper> {
    const wrapper = await mountBar(viewOf({ state: 'reviewing', resumeHint: 'resubmit' }))
    await flushAsync()
    return wrapper
  }

  it('nudge 开轮（message_start）后 turn 结束未重挂 → 就近错误行「agent 未响应」（D8 失败契约②）', async () => {
    const wrapper = await mountDegraded()
    await clickResubmit(wrapper)
    expect(chatSendMock).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="plan-review-resubmit-error"]').exists()).toBe(false)

    // nudge 轮真正开始（起点标记开窗）→ turn 结束（message.complete）而预期重挂未至 → 判未响应
    dispatchTurnEvent('message.message_start')
    dispatchTurnEvent('message.complete')
    await flushAsync()

    const err = wrapper.find('[data-testid="plan-review-resubmit-error"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('agent 未响应')
    expect(wrapper.find('[data-testid="plan-review-resubmit"]').exists()).toBe(true) // 保留可重试
  })

  it('busy defer 场景（dmg-r1-2）：busy 拒绝 reply success 后前置在途 turn 的终态信号不误报；defer 重投开轮后才判', async () => {
    const wrapper = await mountDegraded()
    // busy 预检拒绝走 reply success：send.rejected 广播先于 reply 到达（WS FIFO）——
    // 用 pending promise 锁定发送在途，先派拒绝帧再放行 reply，如实模拟到达序
    let resolveSend!: () => void
    chatSendMock.mockReturnValueOnce(new Promise<void>((r) => { resolveSend = r }))
    const clicked = wrapper.find('[data-testid="plan-review-resubmit"]').trigger('click')
    dispatchTurnEvent('send.rejected', { reason: 'busy' }) // 窗未开（idle）→ no-op
    resolveSend()
    await clicked
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-resubmit-error"]').exists()).toBe(false)

    // nudge 尚未开轮（defer 队列等 occupancy idle 重投）：前置在途 turn 的收尾帧
    // （message.complete / message.error）先于 nudge 轮起点标记到达 → 不判定、不落错误
    dispatchTurnEvent('message.complete')
    dispatchTurnEvent('message.error')
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-resubmit-error"]').exists()).toBe(false)

    // defer 重投、nudge 真正开轮（message_start 开窗）→ turn 结束未重挂 → 此刻才判
    dispatchTurnEvent('message.message_start')
    dispatchTurnEvent('message.complete')
    await flushAsync()
    const err = wrapper.find('[data-testid="plan-review-resubmit-error"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('agent 未响应')
  })

  it('同轮先重挂后收尾：pending 到达撤销检测，turn 结束不误报（成功路径）', async () => {
    const wrapper = await mountDegraded()
    await clickResubmit(wrapper)

    // submit-review 是轮内工具调用：挂起登记先于 turn 结束到达 → 成功收口
    emitPlanReviewRequest('pr-resub')
    await flushAsync()
    dispatchTurnEvent('message.complete')
    await flushAsync()

    expect(wrapper.find('[data-testid="plan-review-resubmit-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="plan-review-approve"]').exists()).toBe(true) // ready 优先
  })

  it('turn 错误收尾（message.error）同判未响应；send.rejected（预检拒绝未进轮）同判', async () => {
    const wrapper = await mountDegraded()
    await clickResubmit(wrapper)
    // nudge 轮开轮后错误收尾（message.error）→ 判未响应
    dispatchTurnEvent('message.message_start')
    dispatchTurnEvent('message.error')
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-resubmit-error"]').text()).toContain('agent 未响应')

    // 重试 → 预检拒绝（busy 未进轮，armed 相位）→ 同一失败契约②（不受起点标记门）
    await clickResubmit(wrapper)
    dispatchTurnEvent('send.rejected')
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-resubmit-error"]').text()).toContain('agent 未响应')
  })

  it('willRetry=true 中间失败帧不关检测窗（pi auto-retry 中 turn 未结束）；终态帧才判未响应', async () => {
    const wrapper = await mountDegraded()
    await clickResubmit(wrapper)
    // nudge 轮开轮（watching）后进入 pi 自动重试链
    dispatchTurnEvent('message.message_start')

    // pi 自动重试链的中间失败帧（willRetry=true，event-adapter 透传形态）→ turn 未结束，
    // 不关窗不落错误（判据与 useCompletionNotify 的 willRetry 静音同型）
    dispatchTurnEvent('message.complete', { stopReason: 'error', willRetry: true })
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-resubmit-error"]').exists()).toBe(false)

    // 重试链终态（willRetry=false）而重挂仍未至 → 此刻才判「agent 未响应」
    dispatchTurnEvent('message.complete', { stopReason: 'error', willRetry: false })
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-resubmit-error"]').text()).toContain('agent 未响应')
    expect(wrapper.find('[data-testid="plan-review-resubmit"]').exists()).toBe(true) // 保留可重试
  })

  it('未点重提时 turn 信号不误报（检测窗口未开启）', async () => {
    const wrapper = await mountDegraded()
    dispatchTurnEvent('message.complete')
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-resubmit-error"]').exists()).toBe(false)
  })
})

describe('D9③ 自审结论行（ready 分支截断 + Popover 全文）', () => {
  it('挂起请求带 selfReview → 自审行渲染截断文本；点击 Popover 看全文', async () => {
    const selfReview = '已核对 3 条需求全覆盖；2 处假设已验证；验收场景可执行。'
    const wrapper = await mountBar(viewOf({ state: 'reviewing' }))
    emitPlanReviewRequest('pr-1', selfReview)
    await flushAsync()

    const line = wrapper.find('[data-testid="plan-review-self-review"]')
    expect(line.exists()).toBe(true)
    expect(line.text()).toContain('已核对 3 条需求全覆盖')

    // reka Popover 的 jsdom 形态：Portal 内容随 trigger click 挂载（dismissable 层随后的
    // outside 判定会关合——UpdateButton/PlanModeBar 退出确认同款窗口断言形态），断言即点即查
    await line.trigger('click')
    const full = findSelfReviewFull()
    expect(full).not.toBeNull()
    expect(full!.text()).toContain('agent 自审结论')
    expect(full!.text()).toContain('验收场景可执行')
  })

  it('无 selfReview（旧扩展降级形态）→ 自审行不渲染', async () => {
    const wrapper = await mountBar(viewOf({ state: 'reviewing' }))
    emitPlanReviewRequest('pr-1')
    await flushAsync()

    expect(wrapper.find('[data-testid="plan-review-self-review"]').exists()).toBe(false)
  })
})

describe('§3.5 守卫与回看', () => {
  it('0 评论：「提交评论修订」禁用 + tooltip 说明；加草稿后恢复可用', async () => {
    const wrapper = await mountBar(viewOf({ state: 'reviewing' }))
    emitPlanReviewRequest('pr-1')
    await flushAsync()

    const revise = wrapper.find('[data-testid="plan-review-revise"]')
    expect(revise.attributes('disabled')).toBeDefined()
    expect(revise.attributes('title')).toContain('先在文档中划选添加评论')

    usePlanStore().addDraftComment({ quote: '引文', comment: '评语' })
    await flushAsync()

    const reviseAfter = wrapper.find('[data-testid="plan-review-revise"]')
    expect(reviseAfter.attributes('disabled')).toBeUndefined()
    expect(reviseAfter.attributes('title')).toBeUndefined()
  })

  it('评论计数可点 → openDrawerTab("plan") 打开/聚焦计划产物 tab + plan-store 回看请求递增', async () => {
    const wrapper = await mountBar(viewOf({ state: 'reviewing' }))
    emitPlanReviewRequest('pr-1')
    await flushAsync()

    expect(usePlanStore().draftsRevealSeq).toBe(0)
    // D13⑦：计数键只在有草稿时渲染——先建草稿再走回看链
    usePlanStore().addDraftComment({ quote: '引文', comment: '评语' })
    await flushAsync()
    await wrapper.find('[data-testid="plan-review-summary"]').trigger('click')
    await flushAsync()

    expect(openDrawerTabMock).toHaveBeenCalledWith('plan')
    expect(usePlanStore().draftsRevealSeq).toBe(1)
    expect(usePlanStore().draftsRevealPending).toBe(true)
  })
})
