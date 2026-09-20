/**
 * PlanModeBar 组件单测 —— plan-mode-ux-refactor u-plan-bar（状态带合并，设计 §3.3 D1）
 * + u-review-source-ui（§3.5 退出确认 Popover / 退出清草稿）。
 *
 * 覆盖（impl-plan u-plan-bar 验收条款 + u-review-source-ui 增量）：
 * - 承接清单① 常驻订阅：isActive=false 时组件常驻（无 DOM），planReview 请求仍入
 *   extensionUIStore（PlanModeBar setup 自持 useExtensionUI(planReviewFilter) 实例——
 *   右区 PlanReviewBar 此时未创建，本实例是唯一订阅面）；isActive 翻转 true 后右区
 *   ready 分支可达（先有 isActive 帧后有消费者的鸡蛋困境由常驻订阅消除）
 * - 承接清单② focusedSid 注入：mount 后 planStore.focusedSid 非空（syncFocus 义务随
 *   组件自 PanelContainer 横幅/审批条迁移到 PlanModeBar）
 * - 左区渲染：模式名 + 三阶段点（tooltip 含义文案）+ 退出；skills 默认不渲染（有技能
 *   收进模式名 title）；hint 长句不再存在（组件无该文案挂点）
 * - §3.5 退出确认 Popover：点退出只开确认层（不发 abortPlan）；分情境警示（revising =
 *   「退出将中止修订」优先 / 有评论草稿 =「N 条评论草稿将丢弃」）；确认后才发 abortPlan
 *   且草稿清空；取消不发；degraded 右区退出按钮（PlanReviewBar exit 事件）复用本确认层
 * - 退出命令：确认后 click → command('session.abortPlan')；失败 → E9 错误行就近呈现
 * - 右区四分支：ready 三键 / revising / degraded / 隐藏（仅左区）
 * - 场景 7（A7 降级 L1，DOM 存在性）：退出（isActive=false）后 PlanModeBar 不在 DOM；
 *   PanelContainer 无横幅/审批条挂载残留（findComponent 断言 PlanReviewBar 不在其树内）
 * - 挂载位：Panel 内 plan-mode-bar 行位于 .composer-band 之前（composer 正上方）
 *
 * mock 形态照抄 plan-review-bar.test.ts（command spread actual 保真实 events 通道 +
 * extension domain mock + 真实 InternalEventBus）；状态驱动用 store.applyFrame（真实 WS
 * 帧路径）。i18n 经 vitest-i18n-setup 全局 mock，t() 取 zh-CN 文案。
 * 退出确认层经 reka Popover Portal 渲染在 document.body（UpdateButton.test.ts 同款断言
 * 形态）：mount attachTo document.body + 用例末尾统一 unmount（afterEach），禁 innerHTML 强删。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/plan-mode-bar.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { computed, defineComponent, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { InternalEventBus } from '@taiji/core'
import type { PlanStateView } from '@taiji/shared'

// ── mock ①：command（plan-store 首拉 RPC + 退出 session.abortPlan）——spread actual ──
const commandMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api', async (importActual) => {
  const actual = await importActual<typeof import('@taiji/core/transport/api')>()
  return { ...actual, command: commandMock, RPC_BACKSTOP_TIMEOUT_MS: 30_000 }
})

// ── mock ②：extension domain（useExtensionUI 的 WS/RPC 面，照 plan-review-bar.test.ts）──
vi.mock('@taiji/core/transport/api/domains/extension', () => ({
  onUITimeout: () => () => {},
  sendExtensionUIResponse: vi.fn((): boolean => true),
  onNotify: () => () => {},
  onExtensions: vi.fn(),
  getPendingRequests: vi.fn().mockResolvedValue([]),
}))

// ── mock ③：getExtensionBus → 真实 InternalEventBus 实例 ──
let mockBus: InternalEventBus
vi.mock('@/composables/shell/useExtensionHostBridge', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/composables/shell/useExtensionHostBridge')>()
  return { ...original, getExtensionBus: () => mockBus }
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

import PlanModeBar from '@/components/panel/plan/PlanModeBar.vue'
import Panel from '@/components/panel/Panel.vue'
import { usePlanStore } from '@/stores/plan-store'
import { useExtensionUIStore } from '@/stores/extension-ui'
import { isPlanReviewRequest, __resetExtensionBusSubscriptionForTesting } from '@/composables/useExtensionUI'

const SID = 'sess-mode-bar'

function viewOf(overrides: Partial<PlanStateView> = {}): PlanStateView {
  return {
    isActive: true,
    planFilePath: '/data/A/.taiji-harness/auth/plan.md',
    requirement: '重构 auth 模块',
    templateName: 'default',
    ...overrides,
  }
}

/** 挂起 planReview 审批请求（runtime event-adapter 广播形状，D5） */
function emitPlanReviewRequest(requestId = 'pr-1'): void {
  mockBus.emit({
    kind: 'ui-request',
    sessionId: SID,
    request: {
      requestId,
      pluginId: '',
      kind: 'select',
      method: 'select',
      title: '\x00TAIJI_PLAN_REVIEW:',
      options: [JSON.stringify({ docs: [] })],
      planReview: true,
    },
  } as never)
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

async function flushAsync(): Promise<void> {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

beforeEach(() => {
  // 模块级 refCount bus 订阅残留重置（对齐 plan-review-bar.test.ts）
  __resetExtensionBusSubscriptionForTesting()
  setActivePinia(createPinia())
  commandMock.mockReset()
  mockBus = new InternalEventBus()
})

afterEach(() => {
  while (mountedWrappers.length > 0) {
    const w = mountedWrappers.pop()
    w?.unmount()
  }
})

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

    // isActive 帧到达（投影链广播）→ 整行渲染 → PlanReviewBar 创建。其 usePlanState
    // watch immediate 会再触发一次首拉（生产语义 = 拉 runtime 最新快照，bus 内存态即
    // 权威源、不回退；mock 持久返回旧快照会造成假覆盖）——mock 演进到最新帧对齐生产。
    usePlanStore().applyFrame(SID, viewOf({ reviewState: 'awaiting' }))
    commandMock.mockResolvedValue({ sessionId: SID, planState: viewOf({ reviewState: 'awaiting' }) })
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

  it('首拉触发（loadPlanState RPC 随挂载发出）', async () => {
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

    usePlanStore().applyFrame(SID, viewOf({ docs: [{ path: '/p/plan.md', version: 1, commentCount: 0 }] }))
    await nextTick()
    const firstAfter = stageEl.findAll('span').find((s) => s.text().includes('需求探索'))!
    expect(firstAfter.find('svg').exists()).toBe(true) // done = 对勾（同色系，去绿点）
  })

  it('skills 默认不渲染；有技能时收进模式名 title（hover tooltip）', async () => {
    const wrapper = await mountBar(viewOf())
    expect(wrapper.find('[data-testid="plan-mode-bar-title"]').attributes('title')).toBeUndefined()

    usePlanStore().applyFrame(SID, viewOf({ skills: ['tech-design', 'dev-flow'] }))
    await nextTick()
    expect(wrapper.find('[data-testid="plan-mode-bar-title"]').attributes('title')).toContain('tech-design · dev-flow')
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
    const wrapper = await mountBar(viewOf({ reviewState: 'revising' }))
    usePlanStore().addDraftComment({ quote: '引文', comment: '评语' }) // 残留草稿也不改判：revising 优先
    await flushAsync()
    await wrapper.find('[data-testid="plan-mode-bar-exit"]').trigger('click')
    await flushAsync()

    const confirm = findExitConfirm()
    expect(confirm!.find('[data-testid="plan-mode-bar-exit-warn-revising"]').text()).toContain('退出将中止修订')
    expect(confirm!.find('[data-testid="plan-mode-bar-exit-warn-drafts"]').exists()).toBe(false)
  })

  it('ready 且有评论草稿 →「N 条评论草稿将丢弃」警示（计数随 drafts）', async () => {
    const wrapper = await mountBar(viewOf({ reviewState: 'awaiting' }))
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
    const wrapper = await mountBar(viewOf({ reviewState: 'awaiting' }))
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

  it('degraded 右区退出按钮（PlanReviewBar exit 事件）复用同一确认层（确认守卫单入口）', async () => {
    const wrapper = await mountBar(viewOf({ reviewState: 'awaiting' }))
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-degraded-exit"]').exists()).toBe(true)

    await wrapper.find('[data-testid="plan-review-degraded-exit"]').trigger('click')
    await flushAsync()

    expect(findExitConfirm()).not.toBeNull()
    expect(commandMock.mock.calls.some((c) => c[0] === 'session.abortPlan')).toBe(false)

    // 同一确认层确认后发 abortPlan
    await findExitConfirm()!.find('[data-testid="plan-mode-bar-exit-confirm"]').trigger('click')
    await flushAsync()
    expect(commandMock.mock.calls.some((c) => c[0] === 'session.abortPlan')).toBe(true)
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
  })
})

describe('右区四分支（PlanReviewBar 情境渲染，宿主行内）', () => {
  it('ready：awaiting + 挂起请求 → 三键渲染在状态带行内', async () => {
    const wrapper = await mountBar(viewOf({ reviewState: 'awaiting' }))
    emitPlanReviewRequest('pr-1')
    await flushAsync()

    expect(wrapper.find('[data-testid="plan-mode-bar"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-review-approve"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-review-revise"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-review-explain"]').exists()).toBe(true)
  })

  it('revising → 修订中状态行，三键不渲染', async () => {
    const wrapper = await mountBar(viewOf({ reviewState: 'revising' }))
    emitPlanReviewRequest('pr-1')
    await flushAsync()

    expect(wrapper.find('[data-testid="plan-review-revising"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-review-approve"]').exists()).toBe(false)
  })

  it('degraded：awaiting 无挂起 → 降级态行', async () => {
    const wrapper = await mountBar(viewOf({ reviewState: 'awaiting' }))
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-review-degraded"]').exists()).toBe(true)
  })

  it('隐藏：isActive 且无 reviewState 无挂起（阶段①/②）→ 仅左区，右区无 DOM', async () => {
    const wrapper = await mountBar(viewOf())
    await flushAsync()
    expect(wrapper.find('[data-testid="plan-mode-bar"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-review-bar"]').exists()).toBe(false)
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

    // PlanReviewBar 若被挂回 PanelContainer（回归），findComponent 命中 → 红
    expect(wrapper.findComponent({ name: 'PlanReviewBar' }).exists()).toBe(false)
    expect(wrapper.find('[data-testid="plan-review-bar"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('挂载位：Panel 内 composer 正上方（.composer-band 之前）', () => {
  it('isActive=true 时 plan-mode-bar 行是 section 子级且位于 composer-band 之前', async () => {
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
    expect(barIdx).toBeLessThan(bandIdx)
    wrapper.unmount()
  })
})
