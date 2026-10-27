/**
 * plan 审批条合并产物（round 6 renderer 测试压缩）：两文件同产物（姊妹 mock 族统一）。
 *
 * 并入来源（基名）：
 *  - plan-mode-bar（PlanModeBar 常驻订阅/左区渲染/退出确认等，29 例）
 *  - plan-review-bar（PlanReviewBar 分支公式/三键 payload/自审等，31 例）
 *
 * mock 注册（产物内统一）：
 *  - '@taiji/core/transport/api' → 两原文件逐字同构（spread actual + commandMock 覆写）。
 *  - '@taiji/core/transport/api/domains/extension' → 统一取 review 版注册表实现
 *    （onUITimeout per-session 注册/注销；mode 版 no-op 为其子集形态——该文件无检测窗用例）。
 *  - drawer / chat domain（review 版保留式）、useExtensionHostBridge（同构）、
 *    usePanelView / '@/stores/chat' / useSidebar / useToast（mode 版独有四条；review 节
 *    挂载树不消费，超集注册零影响）。
 *
 * hook 布置：统一顶层 beforeEach（review 版超集——mode 版的两个 reset 被包含，多出的
 * planStore/drawer/chat/uiTimeoutHandlers reset 对 mode 节幂等无害）+ afterEach
 * （unmountPortalWrappers 共享 mountedWrappers 注册表，两节 mount 均入表）。
 * 同名异构 helper 按节改名：reviewSID / reviewViewOf（无 state 字段）/ reviewMountBar /
 * reviewEmitPlanRequest；mode 节 viewOf/mountBar/emitPlanReviewRequest 保留原名。
 *
 * 互斥登记（保留独立）：plan-docs-panel（'@/stores/chat' 保留式工厂与 mode 版窄替换
 * 同 spec 多工厂互斥）；plan-comment-popover 已并入 components 域 ui-misc-bundle。
 *
 * 运行：cd packages/renderer && TAIJI_SKIP_REAL_PI=1 npx vitest run src/components/panel/plan/__tests__/plan-bars-bundle.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { computed, nextTick, defineComponent, h, effectScope } from 'vue'
import { createPinia } from 'pinia'
import PlanModeBar from '@/components/panel/plan/PlanModeBar.vue'
import PlanReviewBar from '@/components/panel/plan/PlanReviewBar.vue'
import Panel from '@/components/panel/Panel.vue'
import zhPlan from '@/i18n/locales/zh-CN/plan'
import enPlan from '@/i18n/locales/en-US/plan'
import { useExtensionUIStore } from '@/stores/extension-ui'
import { useExtensionUI, formFilter, isPlanReviewRequest, __testing } from '@/composables/useExtensionUI'
import { usePlanStore, __testing as planStoreTesting } from '@/stores/plan-store'
import * as events from '@taiji/core/transport/api'
import { sendExtensionUIResponse } from '@taiji/core/transport/api/domains/extension'
import type { PlanStateView } from '@/stores/plan-store'
import {
  busSlot,
  emitPlanReviewRequest as emitPlanReviewRequestOn,
  extensionDomainMocks,
  flushAsync,
  resetUseExtensionUITestEnv,
  unmountPortalWrappers,
} from '@/__tests__/helpers/use-extension-ui-test-env'

// 快照权威 pending 集的引用别名（用例按需改写返回值）
const getPendingRequestsMock = extensionDomainMocks.getPendingRequests

const SID = 'sess-mode-bar'

const openDrawerTabMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/domain/drawer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/domain/drawer')>()
  return { ...actual, openDrawerTab: openDrawerTabMock }
})

// ── mock ⓪½：chat domain（D8 重新提交的消息发送通道 + 回归检查：搁置不经 message.abort）──
const chatSendMock = vi.hoisted(() => vi.fn(async () => {}))
const chatAbortMock = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@taiji/core/transport/api/domains/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api/domains/chat')>()
  return { ...actual, send: chatSendMock, abort: chatAbortMock }
})


const commandMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api', async (importActual) => {
  const actual = await importActual<typeof import('@taiji/core/transport/api')>()
  return { ...actual, command: commandMock, RPC_BACKSTOP_TIMEOUT_MS: 30_000 }
})

// ── mock ②：extension domain（useExtensionUI 的 WS/RPC 面 + D4③ 主动拉取 getPendingRequests）

// 公共四键单源 helpers/use-extension-ui-test-env；onUITimeout 是本文件特有注册表实现
// （真实语义形态：per-session handler 注册/注销，检测窗用例消费），主动拉取快照经
// getPendingRequestsMock 引用按需改写返回值（默认空快照 = 事实上无挂起）──
const uiTimeoutHandlers = new Map<string, Array<(requestId: string) => void>>()
vi.mock('@taiji/core/transport/api/domains/extension', async () => {
  const { extensionDomainMocks } = await import('@/__tests__/helpers/use-extension-ui-test-env')
  return {
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
    ...extensionDomainMocks,
  }
})

// ── mock ③：getExtensionBus → 真实 InternalEventBus 实例（busSlot 单源 helper）──

vi.mock('@/composables/shell/useExtensionHostBridge', async (importOriginal) => {
  const { bridgeModuleMocks } = await import('@/__tests__/helpers/use-extension-ui-test-env')
  return bridgeModuleMocks(importOriginal)
})


// ── mock ④：Panel 的重依赖（挂载位断言用；PlanModeBar 真实挂载不 stub）──
vi.mock('@/composables/features/panel/usePanelView', () => ({
  usePanelView: () => ({
    panelView: computed(() => ({ kind: 'conversation', sessionId: SID, input: 'composer' })),
    hasMessages: computed(() => true),
    currentFormRequest: computed(() => undefined),
    respond: vi.fn(),
    cancel: vi.fn(),
  }),
}))
vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({
    failedHistory: new Set<string>(),
    isRespawnPending: () => false,
    getMessages: () => [],
    // review 节原走真实 store：useExtensionUI onInvalidated 链消费 clearPendingSend
    clearPendingSend: vi.fn(),
  }),
}))
vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => ({
    restoreSession: vi.fn(),
    retryHistory: vi.fn(),
    deleteSession: vi.fn(),
  }),
}))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: vi.fn(), toastError: vi.fn() }),
}))

function viewOf(overrides: Partial<PlanStateView> = {}): PlanStateView {
  return {
    isActive: true,
    planFilePath: '/data/A/.tmp/plans/auth/plan.md',
    requirement: '重构 auth 模块',
    templateName: 'default',
    state: 'planning', // 真形态基线：归一 View 恒携带 state（批次 3 条目 1 后缺失格落 idle）
    ...overrides,
  }
}

/** 挂起 planReview 审批请求（bus 取 helper 的 busSlot 当前实例） */
function emitPlanReviewRequest(requestId = 'pr-1'): void {
  emitPlanReviewRequestOn(busSlot.current!, SID, requestId)
}

/** 挂载注册表：reka Popover Portal 内容挂在 document.body，用例末尾统一 unmount 清理
 *  （禁 document.body.innerHTML='' 强删——破坏 Vue 内部 vnode 引致 unmount 崩溃，UpdateButton 先例） */
const mountedWrappers: VueWrapper[] = []

async function mountBar(view: PlanStateView | null = viewOf()): Promise<VueWrapper> {
  commandMock.mockResolvedValue({ sessionId: SID, planState: view })
  const wrapper = mount(PlanModeBar, { props: { sessionId: SID }, attachTo: document.body })
  mountedWrappers.push(wrapper)
  await flushAsync()
  return wrapper
}

/** 退出确认层（Popover Portal 在 document.body，wrapper.find 不可见）；null = 未打开 */
function findExitConfirm(): DOMWrapper<Element> | null {
  const el = document.body.querySelector('[data-testid="plan-mode-bar-exit-confirm"]')
  return el ? new DOMWrapper(el) : null
}

beforeEach(() => {
  planStoreTesting.__resetPlanReviewColdSinkForTesting()
  commandMock.mockReset()
  openDrawerTabMock.mockReset()
  chatSendMock.mockClear()
  chatAbortMock.mockClear()
  uiTimeoutHandlers.clear()
  // 公共段（refCount bus 订阅残留重置 + 新 pinia/bus + RPC mock 复位）单源 helper：
  // 不重置订阅则上一用例组件的 handler 仍挂在 Set 里，事件会写进旧 pinia 的 store 分区
  resetUseExtensionUITestEnv(__testing.__resetExtensionBusSubscriptionForTesting)
})

afterEach(() => {
  unmountPortalWrappers(mountedWrappers)
})

// ═══════════ 来源节：plan-mode-bar ═══════════
describe('承接清单① 常驻挂载订阅（M1 硬约束）', () => {
  it('isActive=false：整行不渲染 DOM，但 planReview 请求仍入 store（常驻订阅存活）', async () => {
    const wrapper = await mountBar(viewOf({ isActive: false }))
    expect(wrapper.find('[data-testid="plan-mode-bar"]').exists()).toBe(false)

    emitPlanReviewRequest('pr-stale')
    await flushAsync()

    // 构造性证据：PlanModeBar setup 自持 planReviewFilter 实例在 isActive=false 期间
    // 放行请求入 store（右区 PlanReviewBar 此时未创建，无第二实例）
    const records = useExtensionUIStore().recordsOf(SID).value.filter(isPlanReviewRequest)
    expect(records.map((r) => r.requestId)).toContain('pr-stale')
  })

  it('isActive 翻转 true 后右区 ready 可达：先前入 store 的挂起请求被 PlanReviewBar 枚举', async () => {
    const wrapper = await mountBar(viewOf({ isActive: false }))
    emitPlanReviewRequest('pr-1')
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-approve"]').exists()).toBe(false)

    // isActive 帧到达（派生视图链广播）→ 整行渲染 → PlanReviewBar 创建。其 usePlanState
    // watch immediate 会再触发一次首次拉取（生产语义 = 拉 runtime 最新快照，bus 内存态即
    // 权威源、不回退；mock 持久返回旧快照会造成假覆盖）——mock 演进到最新帧对齐生产。
    // 快照权威同步演进：PlanReviewBar 新实例 subscribe 拉取 getPendingRequests，runtime
    // 挂起表含 'pr-1'（extension-ui kind 事件与广播同源缓存）——空快照会让 retainOnly
    // 快照差集剔除按权威语义剪掉帧先入 store 的挂起请求（scheduler-trigger-inversion §6.2）。
    getPendingRequestsMock.mockResolvedValue([
      {
        requestId: 'pr-1',
        pluginId: '',
        kind: 'select',
        dialogKind: 'select',
        title: '\x00TAIJI_PLAN_REVIEW:',
        options: [JSON.stringify({ docs: [] })],
        planReview: true,
      },
    ])
    usePlanStore().applyFrame(SID, viewOf({ state: 'reviewing' }))
    commandMock.mockResolvedValue({ sessionId: SID, planState: viewOf({ state: 'reviewing' }) })
    await flushAsync()

    expect(wrapper.find('[data-testid="plan-mode-bar"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-review-approve"]').exists()).toBe(true)
  })
})

describe('承接清单② focusedSid 注入迁移', () => {
  it('mount 后 planStore.focusedSid = props.sessionId（usePlanState watch immediate → syncFocus）', async () => {
    await mountBar()
    expect(usePlanStore().focusedSid).toBe(SID)
  })

  it('首次拉取触发（loadPlanState RPC 随挂载发出）', async () => {
    await mountBar()
    expect(commandMock.mock.calls.some((c) => c[0] === 'session.getPlanState')).toBe(true)
  })
})

describe('左区渲染（常驻：模式名 + 三阶段 + 退出）', () => {
  it('isActive=true → 模式名可见；hint 长句无挂点（砍噪音）', async () => {
    const wrapper = await mountBar()
    const bar = wrapper.find('[data-testid="plan-mode-bar"]')
    expect(bar.exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-mode-bar-title"]').text()).toContain('计划模式')
    expect(bar.text()).not.toContain('不修改源码')
  })

  it('三阶段点渲染 label + tooltip（各阶段含义，i18n）', async () => {
    const wrapper = await mountBar()
    const tips = wrapper
      .find('[data-testid="plan-mode-bar-stage"]')
      .findAll('span[title]')
      .map((s) => s.attributes('title'))
    expect(tips).toHaveLength(3)
    expect(tips[0]).toContain('探索需求')
    expect(tips[1]).toContain('撰写计划文档')
    expect(tips[2]).toContain('审阅确认')
  })

  it('阶段视觉态：阶段① 无文档 → 第一步 cur 高亮；docs≥1 → 第一步 done（对勾）', async () => {
    const wrapper = await mountBar(viewOf()) // exploring：无 docs
    const stageEl = wrapper.find('[data-testid="plan-mode-bar-stage"]')
    const firstStep = stageEl.findAll('span').find((s) => s.text().includes('需求探索'))!
    expect(firstStep.classes()).toContain('text-accent')
    expect(firstStep.find('svg').exists()).toBe(false) // cur = 点，非对勾

    usePlanStore().applyFrame(SID, viewOf({ docs: [{ fileName: 'plan.md', absPath: '/p/plan.md', sourceSkill: '', version: 1 }] }))
    await nextTick()
    const firstAfter = stageEl.findAll('span').find((s) => s.text().includes('需求探索'))!
    expect(firstAfter.find('svg').exists()).toBe(true) // done = 对勾（同色系，去绿点）
  })

  it('技能 chips（D7①）：无技能不渲染；有技能内联 chips（至多 2 枚 + +n），点击 Popover 列全量', async () => {
    const wrapper = await mountBar(viewOf())
    expect(wrapper.find('[data-testid="plan-mode-bar-skills"]').exists()).toBe(false)

    usePlanStore().applyFrame(SID, viewOf({ skills: ['tech-design', 'dev-flow', 'test-quality'] }))
    await nextTick()
    const chips = wrapper.find('[data-testid="plan-mode-bar-skills"]')
    expect(chips.exists()).toBe(true)
    // 至多 2 枚 + +n（D7①：不扩噪音墙）
    expect(chips.text()).toContain('tech-design')
    expect(chips.text()).toContain('dev-flow')
    expect(chips.text()).not.toContain('test-quality')
    expect(chips.text()).toContain('+1')
    // 技能名不藏 tooltip（取代 tooltip-only）
    expect(wrapper.find('[data-testid="plan-mode-bar-title"]').attributes('title')).toBeUndefined()

    // 点击 Popover 列全量技能名（Portal 在 document.body；reka jsdom 形态 = 即点即查，
    // 退出确认同款窗口断言形态）
    await chips.trigger('click')
    const list = document.body.querySelector('[data-testid="plan-mode-bar-skills-list"]')
    expect(list).not.toBeNull()
    expect(list!.textContent).toContain('tech-design')
    expect(list!.textContent).toContain('dev-flow')
    expect(list!.textContent).toContain('test-quality')
  })

  it('退出按钮 click 只开确认层（§3.5 确认前置）：abortPlan 未发、确认层含标题与两键', async () => {
    const wrapper = await mountBar()
    await wrapper.find('[data-testid="plan-mode-bar-exit"]').trigger('click')
    await flushAsync()

    const confirm = findExitConfirm()
    expect(confirm).not.toBeNull()
    expect(confirm!.text()).toContain('退出计划模式？')
    expect(confirm!.find('[data-testid="plan-mode-bar-exit-cancel"]').exists()).toBe(true)
    expect(commandMock.mock.calls.some((c) => c[0] === 'session.abortPlan')).toBe(false)
  })

  it('确认后才发 abortPlan（session.abortPlan 命令参数 {sessionId}）+ 确认层关闭', async () => {
    const wrapper = await mountBar()
    await wrapper.find('[data-testid="plan-mode-bar-exit"]').trigger('click')
    await flushAsync()
    expect(commandMock.mock.calls.some((c) => c[0] === 'session.abortPlan')).toBe(false)

    await findExitConfirm()!.find('[data-testid="plan-mode-bar-exit-confirm"]').trigger('click')
    await flushAsync()

    const abortCall = commandMock.mock.calls.find((c) => c[0] === 'session.abortPlan')
    expect(abortCall?.[1]).toEqual({ sessionId: SID })
    expect(findExitConfirm()).toBeNull()
  })

  it('取消 → 确认层关闭且 abortPlan 不发', async () => {
    const wrapper = await mountBar()
    await wrapper.find('[data-testid="plan-mode-bar-exit"]').trigger('click')
    await flushAsync()

    await findExitConfirm()!.find('[data-testid="plan-mode-bar-exit-cancel"]').trigger('click')
    await flushAsync()

    expect(findExitConfirm()).toBeNull()
    expect(commandMock.mock.calls.some((c) => c[0] === 'session.abortPlan')).toBe(false)
  })

  it('revising 警示优先：「agent 正在修订文档，退出将中止修订」（GUI 草稿在 revise 提交时已清，警示指 agent 侧）', async () => {
    const wrapper = await mountBar(viewOf({ state: 'revising' }))
    usePlanStore().addDraftComment({ quote: '引文', comment: '评语' }) // 残留草稿也不改判：revising 优先
    await flushAsync()
    await wrapper.find('[data-testid="plan-mode-bar-exit"]').trigger('click')
    await flushAsync()

    const confirm = findExitConfirm()
    expect(confirm!.find('[data-testid="plan-mode-bar-exit-warn-revising"]').text()).toContain('退出将中止修订')
    expect(confirm!.find('[data-testid="plan-mode-bar-exit-warn-drafts"]').exists()).toBe(false)
  })

  it('ready 且有评论草稿 →「N 条评论草稿将丢弃」警示（计数随 drafts）', async () => {
    const wrapper = await mountBar(viewOf({ state: 'reviewing' }))
    usePlanStore().addDraftComment({ quote: '引文一', comment: '评语一' })
    usePlanStore().addDraftComment({ quote: '引文二', comment: '评语二' })
    await flushAsync()
    await wrapper.find('[data-testid="plan-mode-bar-exit"]').trigger('click')
    await flushAsync()

    const warn = findExitConfirm()!.find('[data-testid="plan-mode-bar-exit-warn-drafts"]')
    expect(warn.exists()).toBe(true)
    expect(warn.text()).toContain('2 条评论草稿将丢弃')
    expect(findExitConfirm()!.find('[data-testid="plan-mode-bar-exit-warn-revising"]').exists()).toBe(false)
  })

  it('确认退出即清草稿（§3.5）：drafts 2 条 → 确认后焦点分区草稿清空', async () => {
    const wrapper = await mountBar(viewOf({ state: 'reviewing' }))
    usePlanStore().addDraftComment({ quote: '引文一', comment: '评语一' })
    usePlanStore().addDraftComment({ quote: '引文二', comment: '评语二' })
    await flushAsync()
    expect(usePlanStore().draftComments).toHaveLength(2)

    await wrapper.find('[data-testid="plan-mode-bar-exit"]').trigger('click')
    await flushAsync()
    await findExitConfirm()!.find('[data-testid="plan-mode-bar-exit-confirm"]').trigger('click')
    await flushAsync()

    expect(usePlanStore().draftComments).toHaveLength(0)
  })

  it('degraded 态右区无退出按钮（问题 5 去重：退出唯一入口 = 左区常驻退出按钮）', async () => {
    vi.useFakeTimers()
    const wrapper = await mountBar(viewOf({ state: 'reviewing' }))
    await vi.advanceTimersByTimeAsync(2000) // degraded 稳定窗放行（D4）
    await flushAsync()

    expect(wrapper.find('[data-testid="plan-review-degraded"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-review-degraded-exit"]').exists()).toBe(false)
    // 左区退出按钮仍在（唯一入口）：click 只开确认层、不直发命令
    await wrapper.find('[data-testid="plan-mode-bar-exit"]').trigger('click')
    await flushAsync()
    expect(findExitConfirm()).not.toBeNull()
    expect(commandMock.mock.calls.some((c) => c[0] === 'session.abortPlan')).toBe(false)
  })

  it('确认后退出命令失败 → E9 错误行就近呈现（内嵌恢复动作），状态带保持原状', async () => {
    const wrapper = await mountBar()
    commandMock.mockRejectedValueOnce(new Error('conn lost'))
    await wrapper.find('[data-testid="plan-mode-bar-exit"]').trigger('click')
    await flushAsync()
    await findExitConfirm()!.find('[data-testid="plan-mode-bar-exit-confirm"]').trigger('click')
    await flushAsync()

    const err = wrapper.find('[data-testid="plan-mode-bar-error"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('退出失败')
    expect(err.text()).toContain('/plan abort')
    expect(wrapper.find('[data-testid="plan-mode-bar"]').exists()).toBe(true)
    // P2-4 顺序契约：命令失败时草稿保留（先清后发的数据丢失路径已修）——重试退出不丢评论
    usePlanStore().addDraftComment({ quote: '引文', comment: '评语' })
    await flushAsync()
    commandMock.mockResolvedValueOnce(undefined)
    await wrapper.find('[data-testid="plan-mode-bar-exit"]').trigger('click')
    await flushAsync()
    await findExitConfirm()!.find('[data-testid="plan-mode-bar-exit-confirm"]').trigger('click')
    await flushAsync()
    expect(commandMock.mock.calls.some((c) => c[0] === 'session.abortPlan')).toBe(true)
    expect(usePlanStore().draftComments).toHaveLength(0)
  })
})

describe('右区三分支（PlanReviewBar 情境渲染，宿主行内）', () => {
  it('ready：state=reviewing + 挂起请求 → 修订/执行/搁置三键渲染在状态带行内', async () => {
    const wrapper = await mountBar(viewOf({ state: 'reviewing' }))
    emitPlanReviewRequest('pr-1')
    await flushAsync()

    expect(wrapper.find('[data-testid="plan-mode-bar"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-review-approve"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-review-revise"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-review-dismiss"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-review-ignore"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="plan-review-explain"]').exists()).toBe(false)
  })

  it('revising（无挂起）→ 修订中状态行，三键不渲染', async () => {
    const wrapper = await mountBar(viewOf({ state: 'revising' }))
    await flushAsync()

    expect(wrapper.find('[data-testid="plan-review-revising"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-review-approve"]').exists()).toBe(false)
  })

  it('degraded：state=reviewing 无挂起 → 稳定窗放行后降级态行', async () => {
    vi.useFakeTimers()
    const wrapper = await mountBar(viewOf({ state: 'reviewing' }))
    await vi.advanceTimersByTimeAsync(2000)
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-degraded"]').exists()).toBe(true)
  })

  it('隐藏：isActive 且无审阅态无挂起（阶段①/②）→ 仅左区，右区无 DOM', async () => {
    const wrapper = await mountBar(viewOf())
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-mode-bar"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-review-bar"]').exists()).toBe(false)
  })
})

describe('窄窗换行策略（F-R2-2 反重叠回归检查）', () => {
  it('右区 = grow + flex-wrap（basis max-content）：窄窗放不下整体换行而非收缩覆盖左区', async () => {
    const wrapper = await mountBar(viewOf({ state: 'reviewing' }))
    emitPlanReviewRequest('pr-1')
    await flushAsync()

    // 宿主行 flex-wrap：右区一行放不下时下移第二行。jsdom 无布局，断言通道 = 策略类
    // （换行触发链：右区 basis=max-content → 假想主尺寸为真实内容宽 → 宿主行换行判定成立）
    expect(wrapper.find('[data-testid="plan-mode-bar"]').classes()).toContain('flex-wrap')
    // 右区策略类：grow（basis 走 max-content）+ flex-wrap（自身行内再折，兜极窄窗）。
    // 回归形态 = flex-1（basis 0% → 假想主尺寸恒 0 → 宿主行换行永不触发）+ min-w-0
    // 收缩后 justify-end 内容左溢覆盖左区（r2-s10 验收事故：右区按键矩形与左区文字/
    // 退出交叉，pointer 拦截请求解释/提交修订/退出全不可点）
    const reviewBar = wrapper.find('[data-testid="plan-review-bar"]')
    expect(reviewBar.classes()).toContain('grow')
    expect(reviewBar.classes()).toContain('flex-wrap')
    expect(reviewBar.classes()).not.toContain('flex-1')
    // 左区优先保全：退出按钮 shrink-0（任何宽度下不收缩，pointer 可达）
    expect(wrapper.find('[data-testid="plan-mode-bar-exit"]').classes()).toContain('shrink-0')
  })
})

describe('场景 7（A7 降级 L1，DOM 存在性）', () => {
  it('退出后（isActive=false 帧到达）PlanModeBar 不在 DOM', async () => {
    const wrapper = await mountBar()
    expect(wrapper.find('[data-testid="plan-mode-bar"]').exists()).toBe(true)

    usePlanStore().applyFrame(SID, viewOf({ isActive: false }))
    await nextTick()
    expect(wrapper.find('[data-testid="plan-mode-bar"]').exists()).toBe(false)
    // 横幅 testid 一并不存在（挂载已拆除，无残留形态）
    expect(wrapper.find('[data-testid="plan-banner"]').exists()).toBe(false)
  })

  it('PanelContainer 无审批条挂载残留（u-plan-bar 拆挂载后组件树内无 PlanReviewBar）', async () => {
    const PanelContainer = (await import('@/components/workspace/PanelContainer.vue')).default
    const stub = defineComponent({
      name: 'PlanReviewBarStub',
      template: '<div data-testid="plan-review-bar-stub" />',
    })
    // stub 全部 plan 面板内容（Panel/PlanDocsPanel 重依赖），只验证挂载拓扑
    const wrapper = mount(PanelContainer, {
      global: {
        stubs: {
          Panel: defineComponent({ name: 'PanelStub', template: '<div data-testid="panel" />' }),
          PlanDocsPanel: defineComponent({ name: 'PlanDocsPanelStub', template: '<div />' }),
          PlanReviewBar: stub,
          GitPanel: defineComponent({ name: 'GitPanelStub', template: '<div />' }),
          CommandDocPanel: defineComponent({ name: 'CommandDocPanelStub', template: '<div />' }),
          DetailPane: defineComponent({ name: 'DetailPaneStub', template: '<div />' }),
          TerminalView: defineComponent({ name: 'TerminalViewStub', template: '<div />' }),
          BackgroundTaskDetailPanel: defineComponent({ name: 'BashTaskStub', template: '<div />' }),
        },
      },
    })
    await flushAsync()

    // PlanReviewBar 若被挂回 PanelContainer（回归），stub 替身渲染 → 三个断言全命中 → 红。
    // 杀伤断言是 stub 自身 testid（findComponent 按名匹配不上名为 PlanReviewBarStub 的
    // 替身，plan-review-bar 真身 testid 也不在替身上——两者单独恒 false，靠本条兜住）
    expect(wrapper.find('[data-testid="plan-review-bar-stub"]').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'PlanReviewBar' }).exists()).toBe(false)
    expect(wrapper.find('[data-testid="plan-review-bar"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('挂载位：Panel 内 composer 下方（.composer-band 之后）', () => {
  it('isActive=true 时 plan-mode-bar 行是 section 子级且位于 composer-band 之后', async () => {
    commandMock.mockResolvedValue({ sessionId: SID, planState: viewOf() })
    const wrapper = mount(Panel, {
      props: { panelId: 'p1', sessionId: SID, sessionDir: '/tmp/proj' },
      global: {
        stubs: {
          MessageStream: defineComponent({ name: 'MessageStreamStub', template: '<div />' }),
          ModeDeclarationRow: defineComponent({ name: 'ModeDeclarationRowStub', template: '<div />' }),
          Composer: defineComponent({ name: 'ComposerStub', template: '<div />' }),
          TraceView: defineComponent({ name: 'TraceViewStub', template: '<div />' }),
          Landing: defineComponent({ name: 'LandingStub', template: '<div />' }),
          FormOverlay: defineComponent({ name: 'FormOverlayStub', template: '<div />' }),
          InboundFrameDroppedNotice: defineComponent({ name: 'InboundStub', template: '<div />' }),
          DiagnosticsExportAction: defineComponent({ name: 'DiagStub', template: '<div />' }),
        },
      },
    })
    await flushAsync()

    const barEl = wrapper.find('[data-testid="plan-mode-bar"]').element
    const bandEl = wrapper.find('.composer-band').element
    const children = Array.from(wrapper.find('section').element.children)
    const barIdx = children.indexOf(barEl)
    const bandIdx = children.indexOf(bandEl)
    expect(barIdx).toBeGreaterThan(-1)
    expect(bandIdx).toBeGreaterThan(-1)
    expect(barIdx).toBeGreaterThan(bandIdx)
    wrapper.unmount()
  })
})

/** locale 值递归展平（文案合规静态断言的输入范围） */
function flattenStrings(obj: unknown, out: string[] = []): string[] {
  if (typeof obj === 'string') {
    out.push(obj)
    return out
  }
  if (obj && typeof obj === 'object') {
    for (const v of Object.values(obj as Record<string, unknown>)) flattenStrings(v, out)
  }
  return out
}

describe('D13 视觉/文案合规断言（S13 降级兑现：状态带/审批条/文案侧②⑤⑥⑦⑧⑨）', () => {
  it('D13⑥ 退出键 padding 收敛进按钮尺寸体系（size=dense 档，无任意值 padding）', async () => {
    const wrapper = await mountBar()
    const cls = wrapper.find('[data-testid="plan-mode-bar-exit"]').classes()
    // 回归形态 = px-[7px] py-[3px] 自定义任意值 padding；现 = Button 尺寸档（dense：h-8 px-3）
    expect(cls.some((c) => /^p[xy]?-\[/.test(c))).toBe(false)
    expect(cls).toContain('px-3')
    expect(cls).toContain('h-8')
  })

  it('D13⑦ 0 草稿不渲染评论计数键（常态归零）；有草稿才出现且计数正确', async () => {
    const wrapper = await mountBar(viewOf({ state: 'reviewing' }))
    emitPlanReviewRequest('pr-1')
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-summary"]').exists()).toBe(false)

    usePlanStore().addDraftComment({ quote: '引文', comment: '评语' })
    await flushAsync()
    const summary = wrapper.find('[data-testid="plan-review-summary"]')
    expect(summary.exists()).toBe(true)
    expect(summary.text()).toContain('1 条评论')
  })

  it('D13② 评论计数图标/角标非 warn 色（图标 accent / 角标 neutral，warn 回归异常语义）', async () => {
    const wrapper = await mountBar(viewOf({ state: 'reviewing' }))
    emitPlanReviewRequest('pr-1')
    usePlanStore().addDraftComment({ quote: '引文', comment: '评语' })
    await flushAsync()

    const icon = wrapper.find('[data-testid="plan-review-summary"] svg')
    expect(icon.exists()).toBe(true)
    expect(icon.classes()).not.toContain('text-warn')
    expect(icon.classes()).toContain('text-accent')

    const badge = wrapper.find('[data-testid="plan-review-revise"] span')
    expect(badge.exists()).toBe(true)
    expect(badge.classes()).not.toContain('text-warn')
    expect(badge.classes()).not.toContain('bg-warn-soft')
    expect(badge.classes()).toContain('text-neutral-mid')
  })

  it('D13⑤ 降级文案区无 opacity 叠乘（text-2xs × dim 已压线，不再乘 0.7）', async () => {
    vi.useFakeTimers()
    const wrapper = await mountBar(viewOf({ state: 'reviewing' }))
    await vi.advanceTimersByTimeAsync(2000)
    await flushAsync()
    const reason = wrapper.find('[data-testid="plan-review-degraded-reason"]')
    expect(reason.exists()).toBe(true)
    expect(reason.classes().some((c) => c.startsWith('opacity-'))).toBe(false)
    expect(wrapper.find('[data-testid="plan-review-degraded"]').classes().some((c) => c.startsWith('opacity-'))).toBe(false)
  })

  it('D13⑧⑨ 文案合规（静态）：无布局黑话「左区」/left-zone；plan 域文案无 em dash；zh 无键盘标点', () => {
    const zh = flattenStrings(zhPlan)
    const en = flattenStrings(enPlan)
    expect(zh.length).toBeGreaterThan(0)
    expect(en.length).toBeGreaterThan(0)
    for (const s of [...zh, ...en]) {
      // D13⑧：用户可见文案不暴露布局黑话（改「左侧的『退出』」类指引）
      expect(s).not.toContain('左区')
      expect(s).not.toContain('left-zone')
      // D13⑨：em dash 全部改写（en 实测 5 处字符串含 ignoreError，设计计 4 处）
      expect(s).not.toContain('—')
    }
    // 中文文案键盘标点（半角 ,;:!?()）清零：中文语境用全角标点（D13 规则族）
    for (const s of zh) {
      expect(s).not.toMatch(/[(),;:!?]/)
    }
  })
})

// ═══════════ 来源节：plan-review-bar ═══════════
const reviewSID = 'sess-bar'

/** review 节挂起 planReview 审批请求（bus 取 helper 的 busSlot 当前实例；selfReview 可选） */
function reviewEmitPlanRequest(requestId = 'pr-1', selfReview?: string): void {
  emitPlanReviewRequestOn(busSlot.current!, reviewSID, requestId, selfReview)
}

/** review 节 view fixture（无 state 字段——与 mode 节 viewOf 异构，按节隔离） */
function reviewViewOf(overrides: Partial<PlanStateView> = {}): PlanStateView {
  return {
    isActive: true,
    planFilePath: '/data/A/.tmp/plans/auth/plan.md',
    requirement: '重构 auth 模块',
    templateName: 'default',
    ...overrides,
  }
}

/** review 节挂载（PlanReviewBar + 注册表 push 共享 mountedWrappers） */
async function reviewMountBar(view: PlanStateView | null = reviewViewOf()): Promise<VueWrapper> {
  commandMock.mockResolvedValue({ sessionId: reviewSID, planState: view })
  const wrapper = mount(PlanReviewBar, { props: { sessionId: reviewSID }, attachTo: document.body })
  mountedWrappers.push(wrapper)
  await flushAsync()
  return wrapper
}

/** 自审结论 Popover 全文层（Portal 在 document.body，wrapper.find 不可见）；null = 未打开 */
function findSelfReviewFull(): DOMWrapper<Element> | null {
  const el = document.body.querySelector('[data-testid="plan-review-self-review-full"]')
  return el ? new DOMWrapper(el) : null
}

describe('PlanReviewBar 分支公式（D4 单源：ready ⇔ 挂起注册表，presence 语义）', () => {
  it('分支④ isActive=false → 整体不渲染（退出后挂起缓存残留由 isActive 门兜住）', async () => {
    const wrapper = await reviewMountBar(reviewViewOf({ isActive: false }))
    reviewEmitPlanRequest('pr-stale')
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-bar"]').exists()).toBe(false)
  })

  it('分支④ 无 view（首次拉取 null）→ 不渲染', async () => {
    const wrapper = await reviewMountBar(null)
    expect(wrapper.find('[data-testid="plan-review-bar"]').exists()).toBe(false)
  })

  it('分支① state=reviewing + 有挂起 → 三键（修订/执行/搁置）全功能 + 搁置 tooltip 含「暂存待办」', async () => {
    const wrapper = await reviewMountBar(reviewViewOf({ state: 'reviewing' }))
    reviewEmitPlanRequest('pr-1')
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
    // 旧「忽略」键与危险色形态退役（D3 非破坏 + F16 检查配重消解）
    expect(wrapper.find('[data-testid="plan-review-ignore"]').exists()).toBe(false)
    expect(dismiss.classes().some((c) => c.includes('danger'))).toBe(false)
    // D13⑦ 0 草稿不渲染评论计数键（常态归零）
    expect(wrapper.find('[data-testid="plan-review-summary"]').exists()).toBe(false)
  })

  it('ready 恒优先渲染（presence 语义）：revising + 挂起共存 → ready 三键（不被 state 分支压制）', async () => {
    const wrapper = await reviewMountBar(reviewViewOf({ state: 'revising' }))
    reviewEmitPlanRequest('pr-1')
    await flushAsync()

    expect(wrapper.find('[data-testid="plan-review-approve"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-review-revising"]').exists()).toBe(false)
  })

  it('分支② state=revising（无挂起）→ 修订中状态条，三键不渲染', async () => {
    const wrapper = await reviewMountBar(reviewViewOf({ state: 'revising' }))
    await flushAsync()

    expect(wrapper.find('[data-testid="plan-review-revising"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-review-revising"]').text()).toContain('正在根据评论修订')
    expect(wrapper.find('[data-testid="plan-review-approve"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="plan-review-revise"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="plan-review-dismiss"]').exists()).toBe(false)
  })

  it('挂起请求独立触发渲染：state 缺失 + 有挂起 → ready（瞬态 race 收敛，交互权威 = 注册表）', async () => {
    const wrapper = await reviewMountBar(reviewViewOf()) // state 缺失格
    reviewEmitPlanRequest('pr-1')
    await flushAsync()

    expect(wrapper.find('[data-testid="plan-review-approve"]').exists()).toBe(true)
  })

  it('分支④ dispatching 不进审批条（执行方式表单是其唯一交互入口）', async () => {
    const wrapper = await reviewMountBar(reviewViewOf({ state: 'dispatching' }))
    await flushAsync()

    expect(wrapper.find('[data-testid="plan-review-bar"]').exists()).toBe(false)
  })

  it('跨实例共享 store：formFilter 实例入队的表单请求不影响 planReview 枚举', async () => {
    const wrapper = await reviewMountBar(reviewViewOf({ state: 'reviewing' }))
    const sidRef = computed(() => reviewSID)
    const scope = effectScope()
    scope.run(() => useExtensionUI(sidRef, formFilter))
    await flushAsync()
    reviewEmitPlanRequest('pr-1')
    busSlot.current!.emit({
      kind: 'ui-request',
      sessionId: reviewSID,
      request: { requestId: 'au-1', pluginId: 'p', kind: 'select', dialogKind: 'select', title: 't', askUser: true, askUserQuestions: [] },
    } as never)
    await flushAsync()

    // 审批条只认 planReview 请求（互斥过滤），三键正常
    expect(wrapper.find('[data-testid="plan-review-approve"]').exists()).toBe(true)
    scope.stop()
  })
})

describe('三键 respond payload（PlanReviewResponse 判别联合，D3 dismiss 加员）', () => {
  it('approve → payload 仅 { decision: "approve" }（结构上无 comments 键），requestId 精确回传', async () => {
    const wrapper = await reviewMountBar(reviewViewOf({ state: 'reviewing' }))
    reviewEmitPlanRequest('pr-1')
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
    const wrapper = await reviewMountBar(reviewViewOf({ state: 'reviewing' }))
    reviewEmitPlanRequest('pr-1')
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
    reviewEmitPlanRequest('pr-2')
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-approve"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-review-summary"]').exists()).toBe(false)
  })

  it('revise → comments 打包自草稿快照，提交后草稿清空；提交后抑制标记压制零渲染（revising 帧到达后出修订中行）', async () => {
    const wrapper = await reviewMountBar(reviewViewOf({ state: 'reviewing' }))
    reviewEmitPlanRequest('pr-1')
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
    usePlanStore().applyFrame(reviewSID, reviewViewOf({ state: 'revising' }))
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-revising"]').exists()).toBe(true)
  })

  it('搁置（D3 dismiss）→ respond {decision:"dismiss"}（不走 message.abort）；草稿保留（暂存待办）', async () => {
    const wrapper = await reviewMountBar(reviewViewOf({ state: 'reviewing' }))
    reviewEmitPlanRequest('pr-1')
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
    const wrapper = await reviewMountBar(reviewViewOf({ state: 'reviewing' }))
    await flushAsync()

    expect(wrapper.find('[data-testid="plan-review-degraded"]').exists()).toBe(true)
  })

  it('组合变假即复位：state 离开 reviewing 即切修订中行；转回 reviewing 即 degraded', async () => {
    const wrapper = await reviewMountBar(reviewViewOf({ state: 'reviewing' }))
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-degraded"]').exists()).toBe(true)

    // 组合变假（state 离开 reviewing → revising 帧）→ 即时复位
    usePlanStore().applyFrame(reviewSID, reviewViewOf({ state: 'revising' }))
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-revising"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-review-degraded"]').exists()).toBe(false)

    // 再转真：即时放行
    usePlanStore().applyFrame(reviewSID, reviewViewOf({ state: 'reviewing' }))
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-degraded"]').exists()).toBe(true)
  })

  it('ready 恒优先：组合成立下新 pending 到达 → ready 立即渲染（presence 优先）', async () => {
    const wrapper = await reviewMountBar(reviewViewOf({ state: 'reviewing' }))
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-degraded"]').exists()).toBe(true)

    reviewEmitPlanRequest('pr-gap')
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-approve"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-review-degraded"]').exists()).toBe(false)
  })

  it('主动拉取对账真值解除：已应答标记压制零渲染 → 显式主动拉取（reviewing ∧ 无挂起真值）→ degraded 渲染', async () => {
    const wrapper = await reviewMountBar(reviewViewOf({ state: 'reviewing' }))
    reviewEmitPlanRequest('pr-1')
    await flushAsync()
    await wrapper.find('[data-testid="plan-review-approve"]').trigger('click')
    await flushAsync()
    // 已应答抑制标记：ready 摘除后零渲染
    expect(wrapper.find('[data-testid="plan-review-bar"]').exists()).toBe(false)

    // 显式双源主动拉取（getPlanState + getPendingRequests，本 mock 形态 = 真值
    // reviewing ∧ 事实上无挂起）→ 解除标记 + degraded 组合即时放行
    commandMock.mockResolvedValue({ sessionId: reviewSID, planState: reviewViewOf({ state: 'reviewing' }) })
    getPendingRequestsMock.mockResolvedValue([])
    await usePlanStore().coldReconcilePlanReview(reviewSID)
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-degraded"]').exists()).toBe(true)
  })

  it('抑制标记悬挂无时间自愈：搁置后标记压制零渲染，时间流逝不解悬挂（[ADR-0122] 无兜底定时器）', async () => {
    vi.useFakeTimers()
    const wrapper = await reviewMountBar(reviewViewOf({ state: 'reviewing' }))
    reviewEmitPlanRequest('pr-1')
    await flushAsync()
    await wrapper.find('[data-testid="plan-review-dismiss"]').trigger('click')

    await vi.advanceTimersByTimeAsync(3000)
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-bar"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="plan-review-degraded"]').exists()).toBe(false)
  })

  it('P2-2 失效帧（requestsInvalidated 摘除）同置已应答标记：ready 消失且 degraded 不闪现', async () => {
    const wrapper = await reviewMountBar(reviewViewOf({ state: 'reviewing' }))
    reviewEmitPlanRequest('pr-1')
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-approve"]').exists()).toBe(true)

    busSlot.current!.emit({ kind: 'requests-invalidated', sessionId: reviewSID, requestIds: ['pr-1'], reason: 'turn-aborted' } as never)
    await flushAsync()

    expect(wrapper.find('[data-testid="plan-review-approve"]').exists()).toBe(false)
    // 杀伤锚点：失效链同置已应答标记 → 组合不成立，degraded 不渲染（即时评估下漏置
    // 标记的变异会在 flush 后立即渲染 degraded → 红）
    expect(wrapper.find('[data-testid="plan-review-degraded"]').exists()).toBe(false)
  })
})

describe('degraded 可行动化（D8：成因分源文案 + [重新提交审批] 按钮）', () => {
  it("resumeHint='resubmit'（E3）→「审批提问已随会话重启失效」+ 按钮经消息发送通道注入固定文案", async () => {
    const wrapper = await reviewMountBar(reviewViewOf({ state: 'reviewing', resumeHint: 'resubmit' }))
    await flushAsync()

    const reason = wrapper.find('[data-testid="plan-review-degraded-reason"]')
    expect(reason.text()).toContain('审批提问已随会话重启失效')
    const btn = wrapper.find('[data-testid="plan-review-resubmit"]')
    expect(btn.exists()).toBe(true)

    await btn.trigger('click')
    await flushAsync()
    // D8 写侧：复用消息发送通道（message.send）注入固定文案 user 可见消息
    expect(chatSendMock).toHaveBeenCalledTimes(1)
    expect(chatSendMock).toHaveBeenCalledWith(reviewSID, '请重新提交计划审批')
    // 退出入口收敛：右区无退出按钮（唯一入口 = 左区常驻退出）
    expect(wrapper.find('[data-testid="plan-review-degraded-exit"]').exists()).toBe(false)
  })

  it('其余来源（resumeHint 缺省）→ 「审批提问未挂起」（不猜测来源）', async () => {
    const wrapper = await reviewMountBar(reviewViewOf({ state: 'reviewing' }))
    await flushAsync()

    const reason = wrapper.find('[data-testid="plan-review-degraded-reason"]')
    expect(reason.text()).toContain('审批提问未挂起')
    expect(reason.text()).not.toContain('会话已重启')
    expect(wrapper.find('[data-testid="plan-review-resubmit"]').exists()).toBe(true)
  })

  it('发送失败 → 就近错误行（失败要出声），降级态保留可重试', async () => {
    const wrapper = await reviewMountBar(reviewViewOf({ state: 'reviewing', resumeHint: 'resubmit' }))
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
    events.dispatchSession(reviewSID, { type, payload: { sessionId: reviewSID, ...payloadExtra } } as never)
  }

  async function clickResubmit(wrapper: VueWrapper): Promise<void> {
    await wrapper.find('[data-testid="plan-review-resubmit"]').trigger('click')
    await flushAsync()
  }

  async function mountDegraded(): Promise<VueWrapper> {
    const wrapper = await reviewMountBar(reviewViewOf({ state: 'reviewing', resumeHint: 'resubmit' }))
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

    // submit-review 是轮内工具调用：挂起登记先于 turn 结束到达 → 成功收尾
    reviewEmitPlanRequest('pr-resub')
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
    const wrapper = await reviewMountBar(reviewViewOf({ state: 'reviewing' }))
    reviewEmitPlanRequest('pr-1', selfReview)
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
    const wrapper = await reviewMountBar(reviewViewOf({ state: 'reviewing' }))
    reviewEmitPlanRequest('pr-1')
    await flushAsync()

    expect(wrapper.find('[data-testid="plan-review-self-review"]').exists()).toBe(false)
  })
})

describe('§3.5 检查与回看', () => {
  it('0 评论：「提交评论修订」禁用 + tooltip 说明；加草稿后恢复可用', async () => {
    const wrapper = await reviewMountBar(reviewViewOf({ state: 'reviewing' }))
    reviewEmitPlanRequest('pr-1')
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
    const wrapper = await reviewMountBar(reviewViewOf({ state: 'reviewing' }))
    reviewEmitPlanRequest('pr-1')
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
