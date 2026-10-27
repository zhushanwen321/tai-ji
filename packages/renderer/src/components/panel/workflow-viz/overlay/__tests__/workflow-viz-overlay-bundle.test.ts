/**
 * workflow-viz overlay 域合并产物（round 6 renderer 测试压缩）：三文件同产物。
 *
 * 并入来源（基名）：
 *  - overlay-shell（壳层 focus trap + 遮罩，9 例；零 mock，真实 key-orchestrator）
 *  - workflow-viz-overlay（浮层主体渲染 + guard，37 例）
 *  - workflow-viz-overlay-host（宿主编排 + 三要素 modal，30 例）
 *
 * mock 注册与互斥核查（三源归一）：
 *  - ModelSelectPopover.vue：overlay 与 host 两厂差异仅 data-selected/data-switching
 *    两 attr（overlay 是 host 的超集）→ 统一取 overlay 版，host 节断言不触这两 attr。
 *  - '@/components/ui/popover'：PopoverTrigger as-child 透传（两源逐字相同）。
 *  - vue-i18n（host）/ session domain + '@/api'（host）：对 overlay-shell 与 overlay 节
 *    为增量注入——OverlayShell 不消费；WorkflowVizOverlay 消费 useI18n，t(key)→key
 *    口径下 overlay 节断言均为 testid/role/属性断言（无译文文本断言），不受影响。
 *  - WorkflowLivePanel.vue 可控抛错 stub / BrowserOverlay / useToast / useSubagentModel /
 *    panelThrowBox / setSubagentModelMock（host 独占），对本域其余被测对象无消费面。
 *  - host 节 mockGetWorkflows / mockGetDag 经统一 session domain 工厂实例取
 *    vi.mocked 锚点；overlay-shell 节零 mock 依赖保持。
 *
 * 运行：cd packages/renderer && TAIJI_SKIP_REAL_PI=1 npx vitest run src/components/panel/workflow-viz/overlay/__tests__/workflow-viz-overlay-bundle.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import type { Ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import OverlayShell from '../OverlayShell.vue'
import WorkflowVizOverlay from '../WorkflowVizOverlay.vue'
import WorkflowVizOverlayGuard from '../WorkflowVizOverlayGuard.vue'
import WorkflowVizOverlayHost from '../WorkflowVizOverlayHost.vue'
import { SCHEDULER_MODAL_VIEW_ID } from '../workflow-viz-overlay'
import {
  closeWorkflowVizOverlay,
  closeWorkflowVizOverlayForSession,
  openCanvasTab,
  openSchedulerTab,
  openWorkflowVizOverlay,
  overlayDag,
  overlayDagError,
  overlayTab,
  retryDagParse,
} from '../workflow-viz-overlay'
import { VIEW_HOST_SOURCE_KEY, type ViewCacheEntry, type ViewHostSource } from '@taiji/ui/extension-host'
import { getOverlayFocusTrapPanel, registerOverlayFocusTrapPanel } from '@/composables/features/app/key-orchestrator'
import { bindDrawerSessionId, bindWorkflowOverlayOpener, openWorkflow, useDrawerControl, _resetDrawerForTest } from '@taiji/core/domain/drawer'
import { closeOverlay, getOverlayControlState, openBrowser } from '@taiji/core/domain/overlay'
import { useWorkflowStore } from '@/stores/workflow'
import { usePanelStore } from '@/stores/panel'
import type { WorkflowDag, WorkflowRunRecord } from '@taiji/shared'
import type { WorkflowUnmatchedInstance } from '../../blueprint-match'
import type { WorkflowVizDagLoadError } from '../types'

// ── core SSOT 读出派生视图（u-w1-core 迁移：开合态唯一权威 = core/domain/overlay）────

/** 浮层是否开着（原 overlayOpen ref 已退役，读 core SSOT） */
function isOverlayOpen(): boolean {
  return getOverlayControlState().isOpen
}

/** 当前 workflow run 派生视图（core OverlayContent → { sessionId, runId } 断言口径） */
function currentRun(): { sessionId: string; runId: string } | null {
  const cur = getOverlayControlState().current
  return cur !== null && cur.kind === 'workflow' ? cur.payload : null
}

vi.mock('@taiji/core/transport/api/domains/session', () => ({
  getWorkflows: vi.fn(),
  getWorkflowRunEvents: vi.fn(),
  getWorkflowDag: vi.fn(),
}))
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  const session = await import('@taiji/core/transport/api/domains/session')
  return { ...actual, session }
})
import * as sessionApi from '@taiji/core/transport/api/domains/session'
const mockGetWorkflows = vi.mocked(sessionApi.getWorkflows)
const mockGetDag = vi.mocked(sessionApi.getWorkflowDag)

// ── mock：WorkflowLivePanel 可控抛错 stub（D10 装载异常的触发源）───────────────

const { panelThrowBox } = vi.hoisted(() => ({ panelThrowBox: { value: false } }))
vi.mock('../../panel/WorkflowLivePanel.vue', () => ({
  default: {
    name: 'WorkflowLivePanelStub',
    props: ['sessionId', 'run', 'ganttComponent'],
    setup() {
      if (panelThrowBox.value) throw new Error('panel boom')
      return () => h('div', { 'data-testid': 'wf-live-panel-stub' })
    },
  },
}))

// ── mock：useToast（反查未命中兜底 toast——[2026-10-19] drawer 空态兜底已删）────

const { toastErrorMock } = vi.hoisted(() => ({ toastErrorMock: vi.fn() }))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastErrorMock }),
}))

// ── mock：BrowserOverlay stub（kind 门控用例经 openBrowser 换入 browser 内容）────
// 真实 BrowserOverlay 会拉起 BrowserPane/view 链路；本文件只关心 Host 侧 kind 门控，
// 壳内容无断言观测范围，stub 掉保用例密闭。
vi.mock('@/components/panel/BrowserOverlay.vue', () => ({
  default: { name: 'BrowserOverlayStub', template: '<div />' },
}))

// ── mock：useSubagentModel（run 级模型全切动作边界——断言 Host 接线，不深入 RPC）──

const { setSubagentModelMock } = vi.hoisted(() => ({ setSubagentModelMock: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/composables/features/subagent/useSubagentModel', () => ({
  useSubagentModel: () => ({
    setSubagentModel: setSubagentModelMock,
    memberDisplayOf: () => undefined,
  }),
  resolveSubagentModelDisplay: (input: { stampedModel?: string }) => ({
    label: input.stampedModel,
    overridden: false,
  }),
}))

// ── mock：ModelSelectPopover + PopoverTrigger（标题栏全切入口组件边界，壳测试同款）──
vi.mock('@/components/panel/ModelSelectPopover.vue', () => ({
  default: defineComponent({
    name: 'ModelSelectPopoverStub',
    props: { selected: { type: String, default: '' }, switching: { type: Boolean, default: false } },
    emits: ['select'],
    setup(props: { selected: string }, { emit, slots }) {
      return () =>
        h('div', {
          'data-testid': 'model-select-stub',
          'data-selected': props.selected,
          'data-switching': String(props.switching),
          onClick: () => emit('select', { modelId: 'glm-4.7', provider: 'zai-coding-cn' }),
        }, slots.trigger?.())
    },
  }),
}))
vi.mock('@/components/ui/popover', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    PopoverTrigger: defineComponent({
      inheritAttrs: false,
      setup(_, { attrs, slots }) {
        return () => h('button', attrs, slots.default?.())
      },
    }),
  }
})

// ── mock：Guard 实例身份记录（U4 kind 门控对账观测范围）─────────────────────────
// 保留真实 Guard 回落语义（onErrorCaptured → emit fallback 原样转发），仅在 setup 记录
// 实例身份。2026-10-22 测试整治：原「mount 累计计数」把批处理切分时机变成了断言对象
// （一次开合触发两轮 watch 排空时计数跳 2 → 满并行下随机红）；实例身份差分（重挂 =
// 末位实例更换）只依赖「是否发生重挂」这一行为事实，与重挂发生几次无关。
const { guardMounts } = vi.hoisted(() => ({ guardMounts: { instances: [] as symbol[] } }))
vi.mock('../WorkflowVizOverlayGuard.vue', async (importOriginal) => {
  const { defineComponent, h } = await import('vue')
  const actual = await importOriginal<typeof import('../WorkflowVizOverlayGuard.vue')>()
  return {
    default: defineComponent({
      name: 'CountingWorkflowVizOverlayGuard',
      inheritAttrs: false,
      emits: ['fallback'],
      setup(_props, { attrs, slots, emit }) {
        guardMounts.instances.push(Symbol('guard-instance'))
        return () => h(actual.default, { ...attrs, onFallback: () => emit('fallback') }, slots)
      },
    }),
  }
})

// ═══════════ 来源节：overlay-shell ═══════════

describe('overlay-shell', () => {
function mountShell(props: Record<string, unknown> = {}, slots?: Record<string, unknown>): VueWrapper {
  return mount(OverlayShell, {
    props: {
      open: true,
      label: '浮层标题',
      closeLabel: '关闭',
      ...props,
    },
    ...(slots ? { slots } : {}),
  })
}

afterEach(() => {
  // 注销陷阱目标（用例间隔离——注册点是模块级单例，泄漏会让下个用例误判）
  registerOverlayFocusTrapPanel(null)
})

describe('OverlayShell 壳（黑盒 DOM）', () => {
  it('open=false 不渲染；open=true 渲染 dialog 形态 + aria 文案（观察者形态）', () => {
    const closed = mountShell({ open: false })
    expect(closed.find('[data-testid="wfvz-overlay"]').exists()).toBe(false)
    const opened = mountShell()
    const panel = opened.find('[data-testid="wfvz-overlay-panel"]')
    expect(panel.exists()).toBe(true)
    expect(panel.attributes('role')).toBe('dialog')
    expect(panel.attributes('aria-modal')).toBe('true')
    expect(panel.attributes('aria-label')).toBe('浮层标题')
    expect(opened.find('[data-testid="wfvz-overlay-close"]').attributes('aria-label')).toBe('关闭')
  })

  it('标题栏 slot 与 body slot 透传（内容侧注入 header 信息与内容区）', () => {
    const wrapper = mountShell({}, {
      title: () => h('span', { 'data-testid': 'shell-title-probe' }, '标题内容'),
      default: () => h('div', { 'data-testid': 'shell-body-probe' }, '正文内容'),
    })
    const title = wrapper.find('[data-testid="shell-title-probe"]')
    expect(title.exists()).toBe(true)
    // 标题内容挂在标题栏内（关闭按钮恒在最右）
    expect(wrapper.find('[data-testid="wfvz-overlay-header"]').element.contains(title.element)).toBe(true)
    expect(wrapper.find('[data-testid="shell-body-probe"]').text()).toBe('正文内容')
  })

  it('两通道关闭①：右上关闭按钮点击 → close', async () => {
    const wrapper = mountShell()
    await wrapper.find('[data-testid="wfvz-overlay-close"]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('两通道关闭②：点遮罩（面板外区域）→ close；面板内点击不关', async () => {
    const wrapper = mountShell()
    await wrapper.find('[data-testid="wfvz-overlay"]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)

    const second = mountShell()
    await second.find('[data-testid="wfvz-overlay-panel"]').trigger('click')
    expect(second.emitted('close')).toBeUndefined()
  })

  it('ESC 不由壳消费（display-containers §6.7 唯一属主 = 栈序编排器，负向锚防双监听双触发）', async () => {
    const wrapper = mountShell()
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    window.dispatchEvent(e)
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(e.defaultPrevented, '壳不消费 Esc（连 preventDefault 约定也不置位）').toBe(false)
  })

  it('IME 组合态壳级零动作（检查单源在编排器 isComposing 前置——组合态 Esc 不发 close）', async () => {
    const wrapper = mountShell()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('close')).toBeUndefined()
  })
})

describe('OverlayShell Tab 焦点陷阱注册点 + 焦点契约（构建者白盒）', () => {
  it('open→面板 ref 注册为陷阱目标 / close→注销；壳自身不监听 Tab（Tab 事件零动作）', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const wrapper = mount(OverlayShell, {
      props: { open: true, label: '浮层标题', closeLabel: '关闭' },
      attachTo: host,
    })
    try {
      await wrapper.vm.$nextTick()
      const panel = wrapper.find('[data-testid="wfvz-overlay-panel"]').element as HTMLElement
      expect(getOverlayFocusTrapPanel(), 'open 后面板注册给编排器浮层分支').toBe(panel)
      // Tab 不由壳消费（陷阱逻辑在编排器，本壳只供面板 ref）
      const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      window.dispatchEvent(e)
      expect(e.defaultPrevented).toBe(false)

      await wrapper.setProps({ open: false })
      await wrapper.vm.$nextTick()
      expect(getOverlayFocusTrapPanel(), 'close 后注销陷阱目标').toBe(null)
    } finally {
      wrapper.unmount()
      host.remove()
    }
  })

  it('卸载同样注销陷阱目标（不留模块级残留指向已卸载面板）', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const wrapper = mount(OverlayShell, {
      props: { open: true, label: '浮层标题', closeLabel: '关闭' },
      attachTo: host,
    })
    await wrapper.vm.$nextTick()
    expect(getOverlayFocusTrapPanel()).not.toBe(null)
    wrapper.unmount()
    expect(getOverlayFocusTrapPanel(), '卸载后注销').toBe(null)
    host.remove()
  })

  it('焦点契约（display-containers §6.7）：打开 focus 面板；关闭后焦点回 composer', async () => {
    const box = document.createElement('div')
    box.className = 'composer-box'
    box.setAttribute('data-testid', 'composer-box')
    const input = document.createElement('div')
    input.setAttribute('contenteditable', 'true')
    box.appendChild(input)
    document.body.appendChild(box)

    const host = document.createElement('div')
    document.body.appendChild(host)
    const wrapper = mount(OverlayShell, {
      props: { open: false, label: '浮层标题', closeLabel: '关闭' },
      attachTo: host,
    })
    await wrapper.setProps({ open: true })
    await wrapper.vm.$nextTick()
    const panel = wrapper.find('[data-testid="wfvz-overlay-panel"]').element as HTMLElement
    expect(document.activeElement, '打开即 focus 面板（安全默认焦点）').toBe(panel)

    await wrapper.setProps({ open: false })
    await wrapper.vm.$nextTick()
    expect(document.activeElement, '关闭后焦点回 composer 而非旧焦点锚').toBe(input)
    wrapper.unmount()
    host.remove()
    box.remove()
  })
})
})

// ═══════════ 来源节：workflow-viz-overlay ═══════════

describe('workflow-viz-overlay', () => {
function run(partial: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    runId: 'wf-1',
    scriptName: 'pr-lifecycle',
    slug: 'pr-lifecycle-7f3a',
    status: 'running',
    startedAt: '2026-10-02T00:00:00Z',
    agentCalls: [],
    stateFilePath: '',
    ...partial,
  }
}

const SAMPLE_DAG: WorkflowDag = {
  phases: [{ name: 'gate', order: 0 }],
  nodes: [{
    id: 'n1',
    kind: 'agent',
    templateName: 'preflight',
    matchPattern: '',
    phase: 'gate',
    line: 3,
  }],
  edges: [],
  parallelGroups: [],
  loops: [],
}

function mountOverlay(props: Record<string, unknown> = {}, errorHandler?: (err: unknown) => void): VueWrapper {
  return mount(WorkflowVizOverlay, {
    props: {
      open: true,
      run: run(),
      dag: null,
      dagError: null,
      ...props,
    },
    ...(errorHandler ? { global: { config: { errorHandler } } } : {}),
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('WorkflowVizOverlay 壳（黑盒 DOM）', () => {
  it('open=false 不渲染；open=true 渲染 dialog 形态（role/aria-modal 观察者形态）', () => {
    const closed = mountOverlay({ open: false })
    expect(closed.find('[data-testid="wfvz-overlay"]').exists()).toBe(false)
    const opened = mountOverlay()
    const panel = opened.find('[data-testid="wfvz-overlay-panel"]')
    expect(panel.exists()).toBe(true)
    expect(panel.attributes('role')).toBe('dialog')
    expect(panel.attributes('aria-modal')).toBe('true')
  })

  it('header 可见：脚本名 + slug + 状态 pill + 关闭按钮；header 内无 args 元素（D2 v5 终裁）', () => {
    const wrapper = mountOverlay({ run: run({ argsSummary: 'base=main reviewers=4' }) })
    expect(wrapper.find('[data-testid="wfvz-overlay-header"]').text()).toContain('pr-lifecycle')
    expect(wrapper.find('[data-testid="wfvz-overlay-slug"]').text()).toBe('pr-lifecycle-7f3a')
    // V6-wf：args 元素不进 header——run 带 argsSummary 数据也不渲染（参数信息整体丢弃）
    expect(wrapper.find('[data-testid="wfvz-overlay-args"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="wfvz-overlay-close"]').exists()).toBe(true)
  })

  it('状态 pill：running → 「运行中」（data-status 形态）', () => {
    const wrapper = mountOverlay()
    const pill = wrapper.find('[data-testid="wfvz-overlay-run-pill"]')
    expect(pill.attributes('data-status')).toBe('running')
    expect(pill.text()).toContain('运行中')
  })

  it('状态 pill：interrupted → 「已中断（可续跑）」（tray 词源复用）', () => {
    const wrapper = mountOverlay({ run: run({ status: 'interrupted' }) })
    expect(wrapper.find('[data-testid="wfvz-overlay-run-pill"]').text()).toContain('已中断（可续跑）')
  })

  it('状态 pill：cancelled 终局 → shared 词表「已取消」+ 中性色（D9 全枚举，非绿——原面板层 pill 断言迁壳层）', () => {
    const wrapper = mountOverlay({ run: run({ status: 'done', outcome: 'cancelled', reason: 'aborted' }) })
    const pill = wrapper.find('[data-testid="wfvz-overlay-run-pill"]')
    expect(pill.text()).toContain('已取消')
    expect(pill.classes()).toContain('text-neutral-mid')
    expect(pill.classes()).not.toContain('text-success')
  })

  it('标题栏模型全切入口：modelDisplay 注入时渲染触发器（模型名 + 覆盖徽章）；未注入不渲染', () => {
    const withModel = mountOverlay({ modelDisplay: { label: 'glm-5.3', overridden: true } })
    const trigger = withModel.find('[data-testid="wfvz-overlay-model-trigger"]')
    expect(trigger.exists()).toBe(true)
    expect(trigger.text()).toContain('glm-5.3')
    expect(withModel.find('[data-testid="wfvz-overlay-model-override-badge"]').text()).toContain('用户覆盖中')
    // 无覆盖分发：徽章不渲染
    const plain = mountOverlay({ modelDisplay: { label: 'glm-5.3', overridden: false } })
    expect(plain.find('[data-testid="wfvz-overlay-model-override-badge"]').exists()).toBe(false)
    // 未注入（run 数据未就绪的宿主形态）：入口整体不渲染
    const none = mountOverlay()
    expect(none.find('[data-testid="wfvz-overlay-model-trigger"]').exists()).toBe(false)
  })

  it('标题栏模型全切入口：选模型 → select-model 事件上抛（payload 原样透传，切换动作用的宿主）', async () => {
    const wrapper = mountOverlay({ modelDisplay: { label: 'glm-5.3', overridden: false } })
    await wrapper.find('[data-testid="model-select-stub"]').trigger('click')
    expect(wrapper.emitted('select-model')).toHaveLength(1)
    expect(wrapper.emitted('select-model')?.[0]?.[0]).toEqual({ modelId: 'glm-4.7', provider: 'zai-coding-cn' })
  })

  it('标题栏模型全切入口随 run 元素三态进退：scheduler / canvas 态 header 让位时入口消失', () => {
    const scheduler = mountOverlay({ tab: 'scheduler', modelDisplay: { label: 'glm-5.3', overridden: false } })
    expect(scheduler.find('[data-testid="wfvz-overlay-model-trigger"]').exists()).toBe(false)
    const canvas = mountOverlay({ tab: 'canvas', modelDisplay: { label: 'glm-5.3', overridden: false } })
    expect(canvas.find('[data-testid="wfvz-overlay-model-trigger"]').exists()).toBe(false)
  })

  it('终局 pill：done+failed → shared 词表「失败」+ errorCode 摘要可见（D9 失败终态）', () => {
    const wrapper = mountOverlay({
      run: run({ status: 'done', outcome: 'failed', errorCode: 'schema_deterministic' }),
    })
    const pill = wrapper.find('[data-testid="wfvz-overlay-run-pill"]')
    expect(pill.text()).toContain('失败')
    expect(wrapper.find('[data-testid="wfvz-overlay-error-code"]').text()).toBe('schema_deterministic')
  })

  it('elapsedMs 提供时渲染已用时长槽（已派生输入透传）；缺省不渲染', () => {
    const withElapsed = mountOverlay({ elapsedMs: 65_000 })
    expect(withElapsed.find('[data-testid="wfvz-overlay-elapsed"]').text()).toContain('1m')
    const without = mountOverlay()
    expect(without.find('[data-testid="wfvz-overlay-elapsed"]').exists()).toBe(false)
  })

  it('关闭通道①：ESC 不由壳消费（display-containers §6.7 唯一属主 = 栈序编排器，双监听防回归）', async () => {
    const wrapper = mountOverlay()
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    window.dispatchEvent(e)
    await wrapper.vm.$nextTick()
    // 负向锚：壳不再挂 window keydown（旧实现此处发 close——双监听会一次 Esc 连剥两层）
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(e.defaultPrevented, '壳不消费 Esc（连 preventDefault 约定也不置位）').toBe(false)
  })

  it('IME 检查已随迁编排器：壳不再自行判定 isComposing（组合态 Esc 也不发 close）', async () => {
    const wrapper = mountOverlay()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it('Tab 焦点陷阱随迁编排器：面板 ref 注册给陷阱目标（open→注册 / close→注销），壳不再监听 Tab', async () => {
    // attach 到真实 document——注册读点断言依赖面板在文档树内
    const host = document.createElement('div')
    document.body.appendChild(host)
    const wrapper = mount(WorkflowVizOverlay, {
      props: { open: true, run: run(), dag: SAMPLE_DAG, nodeStates: { n1: 'done' }, dagError: null },
      attachTo: host,
    })
    try {
      await wrapper.vm.$nextTick()
      const panel = wrapper.find('[data-testid="wfvz-overlay-panel"]').element as HTMLElement
      expect(getOverlayFocusTrapPanel(), 'open 后面板注册给编排器浮层分支').toBe(panel)
      // Tab 不再由壳消费（陷阱逻辑在编排器，本壳只供面板 ref）
      const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      window.dispatchEvent(e)
      expect(e.defaultPrevented).toBe(false)

      await wrapper.setProps({ open: false })
      await wrapper.vm.$nextTick()
      expect(getOverlayFocusTrapPanel(), 'close 后注销陷阱目标').toBe(null)
    } finally {
      wrapper.unmount()
      host.remove()
    }
  })

  it('焦点契约（display-containers §6.7）：关闭后焦点回 composer（焦点锚归还放弃）', async () => {
    const box = document.createElement('div')
    box.className = 'composer-box'
    box.setAttribute('data-testid', 'composer-box')
    const input = document.createElement('div')
    input.setAttribute('contenteditable', 'true')
    box.appendChild(input)
    document.body.appendChild(box)

    const wrapper = mountOverlay()
    await wrapper.vm.$nextTick()
    await wrapper.setProps({ open: false })
    await wrapper.vm.$nextTick()
    expect(document.activeElement, '关闭后焦点回 composer 而非旧焦点锚').toBe(input)
    box.remove()
  })

  it('关闭通道②：右上关闭按钮点击 → close', async () => {
    const wrapper = mountOverlay()
    await wrapper.find('[data-testid="wfvz-overlay-close"]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('关闭通道③：点遮罩（面板外区域）→ close；面板内点击不关', async () => {
    const wrapper = mountOverlay()
    await wrapper.find('[data-testid="wfvz-overlay"]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
    // 面板内点击被 @click.stop 吸收（冒泡被阻断且自身不触发遮罩 close）
    const second = mountOverlay()
    await second.find('[data-testid="wfvz-overlay-panel"]').trigger('click')
    expect(second.emitted('close')).toBeUndefined()
  })

  it('DAG 就绪：画布渲染；画布点击 select 透传（壳转发；[2026-10-19] agent 钻取语义已删——pending 节点 = phase 语义）', async () => {
    const wrapper = mountOverlay({ dag: SAMPLE_DAG, nodeStates: { n1: 'pending' } })
    expect(wrapper.find('[data-testid="wfvz-dag-svg"]').exists()).toBe(true)
    // pending 节点点击 → 壳转发 select（phase 语义）；done 态节点点击 no-op（纯展示）
    await wrapper.find('[data-testid="wfvz-dag-node-n1"]').trigger('pointerdown')
    await wrapper.find('[data-testid="wfvz-dag-node-n1"]').trigger('pointerup')
    expect(wrapper.emitted('select')?.[0]?.[0]).toEqual({ semantic: 'phase', phase: 'gate' })

    const done = mountOverlay({ dag: SAMPLE_DAG, nodeStates: { n1: 'done' } })
    await done.find('[data-testid="wfvz-dag-node-n1"]').trigger('pointerdown')
    await done.find('[data-testid="wfvz-dag-node-n1"]').trigger('pointerup')
    expect(done.emitted('select')).toBeUndefined()
  })

  it('body 纵向两段（D1 观察者形态）：上区 DAG flex-[1.6] + 下区 dock flex-1，无左右分栏中缝', () => {
    const wrapper = mountOverlay({ dag: SAMPLE_DAG, nodeStates: { n1: 'done' } })
    const dagPane = wrapper.find('[data-testid="wfvz-overlay-dag-pane"]')
    const livePane = wrapper.find('[data-testid="wfvz-overlay-live-pane"]')
    // 纵向份额：上区 1.6 / 下区 1（flex-[1.6] 发射为 flex:1.6 1.6 0%）
    expect(dagPane.classes()).toContain('flex-[1.6]')
    expect(dagPane.classes()).not.toContain('basis-[45%]')
    expect(dagPane.classes()).not.toContain('border-r')
    expect(livePane.classes()).toContain('flex-1')
    // 画布与 dock 同为 body 纵向容器的兄弟段（上区在前）
    const body = dagPane.element.parentElement
    expect(body).not.toBeNull()
    expect(body!.children[0]).toBe(dagPane.element)
    expect(body!.children[1]).toBe(livePane.element)
  })

  it('下区 dock slot 透传（U5 面板填充位，纵向布局下挂 live-pane 段内）', () => {
    const wrapper = mount(WorkflowVizOverlay, {
      props: { open: true, run: run(), dag: null, dagError: null },
      slots: { default: h('div', { 'data-testid': 'wfvz-test-slot-probe' }, 'panel') },
    })
    const pane = wrapper.find('[data-testid="wfvz-overlay-live-pane"]')
    expect(pane.find('[data-testid="wfvz-test-slot-probe"]').exists()).toBe(true)
  })
})

describe('WorkflowVizOverlay 未匹配实例分组（D2⑥ 展示侧，黑盒 DOM）', () => {
  const unmatched: WorkflowUnmatchedInstance[] = [
    { call: { id: 0, agent: 'orphan-agent', phase: 'gate', status: 'done' }, hitCount: 0, ambiguous: false },
    { call: { id: 1, agent: 'reviewer-x', phase: 'review', status: 'running' }, hitCount: 2, ambiguous: true },
  ]

  it('DAG 就绪 + 未匹配非空：分组可见——phase 组标题 + agent 名 + 歧义/零命中标注随行', () => {
    const wrapper = mountOverlay({ dag: SAMPLE_DAG, unmatched })
    expect(wrapper.find('[data-testid="wfvz-overlay-unmatched"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-overlay-unmatched-group-gate"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-overlay-unmatched-group-review"]').exists()).toBe(true)
    const items = wrapper.findAll('[data-testid="wfvz-overlay-unmatched-item"]')
    expect(items).toHaveLength(2)
    expect(items[0].attributes('data-ambiguous')).toBe('false')
    expect(items[0].text()).toContain('orphan-agent')
    expect(items[0].text()).toContain('未命中任何调用点')
    expect(items[1].attributes('data-ambiguous')).toBe('true')
    expect(items[1].attributes('data-hit-count')).toBe('2')
    expect(items[1].text()).toContain('reviewer-x')
    expect(items[1].text()).toContain('歧义（命中 2 个调用点）')
  })

  it('未匹配空/缺省：分组零渲染 + 三态互斥（画布就绪时解析中占位不渲染）', () => {
    const empty = mountOverlay({ dag: SAMPLE_DAG, unmatched: [] })
    expect(empty.find('[data-testid="wfvz-overlay-unmatched"]').exists()).toBe(false)
    const absent = mountOverlay({ dag: SAMPLE_DAG })
    expect(absent.find('[data-testid="wfvz-overlay-unmatched"]').exists()).toBe(false)
    // U7 回归断言：dag 就绪 + 无未匹配实例时，上区不得同时渲染「解析中」占位
    expect(empty.find('[data-testid="wfvz-overlay-dag-loading"]').exists()).toBe(false)
    expect(absent.find('[data-testid="wfvz-overlay-dag-loading"]').exists()).toBe(false)
  })

  it('phase 缺失实例归「未归属 phase」组（不猜缺省分区名）', () => {
    const wrapper = mountOverlay({ dag: SAMPLE_DAG, unmatched: [
      { call: { id: 2, agent: 'no-phase-agent', status: 'pending' }, hitCount: 0, ambiguous: false },
    ] })
    const group = wrapper.find('[data-testid="wfvz-overlay-unmatched-group-unknown"]')
    expect(group.exists()).toBe(true)
    expect(group.text()).toContain('未归属 phase')
    expect(group.text()).toContain('no-phase-agent')
  })

  it('DAG 不可得时不渲染未匹配分组（分组属 DAG 就绪分支的展示侧）', () => {
    const wrapper = mountOverlay({ dagError: { code: 'parse_failed', message: 'bad' }, unmatched })
    expect(wrapper.find('[data-testid="wfvz-overlay-unmatched"]').exists()).toBe(false)
  })
})

describe('WorkflowVizOverlay DAG 不可得降级（黑盒 DOM）', () => {
  it('record_not_found：静态指引文案 + 原因码可见、无重试按钮（重试恒同）', () => {
    const dagError: WorkflowVizDagLoadError = { code: 'record_not_found', message: 'no record' }
    const wrapper = mountOverlay({ dagError })
    expect(wrapper.find('[data-testid="wfvz-overlay-dag-fallback"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-overlay-dag-error"]').text()).toContain('无运行记录')
    expect(wrapper.find('[data-testid="wfvz-overlay-dag-error-code"]').text()).toBe('record_not_found')
    expect(wrapper.find('[data-testid="wfvz-overlay-dag-retry"]').exists()).toBe(false)
  })

  it('parse_failed：降级列表 + 「重试解析」入口（点击上抛 retry-dag）', async () => {
    const dagError: WorkflowVizDagLoadError = { code: 'parse_failed', message: 'unsupported syntax' }
    const wrapper = mountOverlay({ dagError, run: run({ agentCalls: [
      { id: 0, agent: 'reviewer-biz', phase: 'review', status: 'done' },
      { id: 1, agent: 'preflight', status: 'done' },
    ] }) })
    expect(wrapper.find('[data-testid="wfvz-overlay-dag-error"]').text()).toContain('DAG 解析失败')
    // 降级列表按 phase 分组渲染（有显式 phase 显示分组 header）
    expect(wrapper.find('[data-testid="wfvz-overlay-dag-fallback-group-review"]').exists()).toBe(true)
    const calls = wrapper.findAll('[data-testid="wfvz-overlay-dag-fallback-call"]')
    expect(calls).toHaveLength(2)
    // 重试入口
    const retry = wrapper.find('[data-testid="wfvz-overlay-dag-retry"]')
    expect(retry.exists()).toBe(true)
    await retry.trigger('click')
    expect(wrapper.emitted('retry-dag')).toHaveLength(1)
  })

  it('channel（RPC 通道错误归一形态）：通用获取失败文案', () => {
    const wrapper = mountOverlay({ dagError: { code: 'channel', message: 'rpc failed' } })
    expect(wrapper.find('[data-testid="wfvz-overlay-dag-error"]').text()).toContain('获取 workflow 结构失败')
  })
})

describe('WorkflowVizOverlay 一级 tab（scheduler 整合 2026-10-06，黑盒 DOM）', () => {
  /** scheduler 树 stub 源：(s1, SCHEDULER_MODAL_VIEW_ID) 命中，其余 miss */
  function makeSchedulerSource(entry: ViewCacheEntry): ViewHostSource {
    return {
      getView: vi.fn((sessionId: string, viewId: string) =>
        sessionId === 's1' && viewId === SCHEDULER_MODAL_VIEW_ID ? entry : undefined),
      getViewIds: vi.fn(() => []),
    }
  }

  function schedulerEntry(): ViewCacheEntry {
    return {
      viewId: SCHEDULER_MODAL_VIEW_ID,
      pluginId: 'scheduler-manager',
      guiTree: [{ type: 'ansi-text', props: { lines: ['2 启用 · 1 停用 · 共 3'] } }] as ViewCacheEntry['guiTree'],
      updatedAt: 1,
    }
  }

  it('缺省 tab=runs：tab 条两 tab 可见且 runs 选中（aria-selected），runs body 在场、scheduler pane 不渲染', () => {
    const wrapper = mountOverlay({ dag: SAMPLE_DAG })
    expect(wrapper.find('[data-testid="wfvz-overlay-tabs"]').exists()).toBe(true)
    const runsTab = wrapper.find('[data-testid="wfvz-overlay-tab-runs"]')
    const schedulerTab = wrapper.find('[data-testid="wfvz-overlay-tab-scheduler"]')
    expect(runsTab.exists()).toBe(true)
    expect(schedulerTab.exists()).toBe(true)
    expect(runsTab.attributes('aria-selected')).toBe('true')
    expect(schedulerTab.attributes('aria-selected')).toBe('false')
    expect(wrapper.find('[data-testid="wfvz-overlay-dag-pane"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-overlay-scheduler-pane"]').exists()).toBe(false)
  })

  it('tab=scheduler：scheduler pane 在场且 ViewHost 渲染插件树（用户可见文本），runs body 卸载；header 换定时任务标题（run 元素让位）', () => {
    const wrapper = mount(WorkflowVizOverlay, {
      props: { open: true, run: run(), dag: SAMPLE_DAG, dagError: null, tab: 'scheduler', schedulerSessionId: 's1' },
      global: { provide: { [VIEW_HOST_SOURCE_KEY as symbol]: makeSchedulerSource(schedulerEntry()) } },
    })
    const pane = wrapper.find('[data-testid="wfvz-overlay-scheduler-pane"]')
    expect(pane.exists()).toBe(true)
    expect(pane.text()).toContain('2 启用 · 1 停用 · 共 3')
    expect(wrapper.find('[data-testid="wfvz-overlay-dag-pane"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="wfvz-overlay-live-pane"]').exists()).toBe(false)
    // header 双态：定时任务标题在场，run 六元素整体让位
    expect(wrapper.find('[data-testid="wfvz-overlay-scheduler-title"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-overlay-slug"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="wfvz-overlay-run-pill"]').exists()).toBe(false)
  })

  it('树未到（source miss + empty=hidden）：容器在场、ViewHost 零 DOM（首帧空白契约形态）', () => {
    const wrapper = mount(WorkflowVizOverlay, {
      props: { open: true, run: null, dag: null, dagError: null, tab: 'scheduler', schedulerSessionId: 's-miss' },
      global: { provide: { [VIEW_HOST_SOURCE_KEY as symbol]: makeSchedulerSource(schedulerEntry()) } },
    })
    expect(wrapper.find('[data-testid="wfvz-overlay-scheduler-pane"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="view-host"]').exists()).toBe(false)
  })

  it('run=null：「运行」tab 禁用（disabled 形态）且点击不上抛；scheduler tab 可点上抛', async () => {
    const wrapper = mountOverlay({ run: null, dag: null })
    const runsTab = wrapper.find('[data-testid="wfvz-overlay-tab-runs"]')
    expect(runsTab.attributes('disabled')).toBeDefined()
    await runsTab.trigger('click')
    expect(wrapper.emitted('update:tab')).toBeUndefined()
    await wrapper.find('[data-testid="wfvz-overlay-tab-scheduler"]').trigger('click')
    expect(wrapper.emitted('update:tab')?.[0]).toEqual(['scheduler'])
  })

  it('run 在场：两 tab 均可点，点 scheduler 上抛 update:tab（tab SSOT 在控制器，壳只上抛）', async () => {
    const wrapper = mountOverlay({ dag: SAMPLE_DAG })
    await wrapper.find('[data-testid="wfvz-overlay-tab-scheduler"]').trigger('click')
    expect(wrapper.emitted('update:tab')?.[0]).toEqual(['scheduler'])
    const runsTab = wrapper.find('[data-testid="wfvz-overlay-tab-runs"]')
    expect(runsTab.attributes('disabled')).toBeUndefined()
    await runsTab.trigger('click')
    expect(wrapper.emitted('update:tab')?.[1]).toEqual(['runs'])
  })
})

describe('WorkflowVizOverlay canvas tab（problem-solve-canvas §3.1(3)，黑盒 DOM）', () => {
  it('tab 条三段齐备：canvas 段在场且缺省未选中（runs 选中）', () => {
    const wrapper = mountOverlay({ dag: SAMPLE_DAG })
    const canvasTab = wrapper.find('[data-testid="wfvz-overlay-tab-canvas"]')
    expect(canvasTab.exists()).toBe(true)
    expect(canvasTab.attributes('aria-selected')).toBe('false')
    expect(wrapper.find('[data-testid="wfvz-overlay-tab-runs"]').attributes('aria-selected')).toBe('true')
  })

  it('tab=canvas：canvas pane 空 wrapper 在场（shell 路径未置 core 开合态、canvasId 缺席 CanvasPane 不挂载），runs body（DAG 区 + live dock）与 scheduler pane 均卸载；header 换画布标题（run 六元素让位）', () => {
    const wrapper = mountOverlay({ dag: SAMPLE_DAG, tab: 'canvas' })
    expect(wrapper.find('[data-testid="wfvz-overlay-canvas-pane"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-overlay-dag-pane"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="wfvz-overlay-live-pane"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="wfvz-overlay-scheduler-pane"]').exists()).toBe(false)
    // header 三态：画布标题在场，run 元素整体让位（同 scheduler 形态）
    expect(wrapper.find('[data-testid="wfvz-overlay-canvas-title"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-overlay-slug"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="wfvz-overlay-run-pill"]').exists()).toBe(false)
  })

  it('run=null：canvas tab 不禁用、可点上抛 update:tab（画布打开不依赖 run 数据）', async () => {
    const wrapper = mountOverlay({ run: null, dag: null })
    const canvasTab = wrapper.find('[data-testid="wfvz-overlay-tab-canvas"]')
    expect(canvasTab.attributes('disabled')).toBeUndefined()
    await canvasTab.trigger('click')
    expect(wrapper.emitted('update:tab')?.[0]).toEqual(['canvas'])
  })
})

describe('WorkflowVizOverlayGuard（D10 捕获路径，构建者白盒）', () => {
  const ThrowingChild = defineComponent({
    name: 'ThrowingChild',
    setup() {
      throw new Error('overlay mount boom')
    },
    render() {
      return h('div')
    },
  })

  /**
   * 端到端捕获形态：Guard 包住「壳 + 抛错子组件」——实况面板 slot 内子页抛错
   * （设计 §3.1 失败路径「overlay 装载异常 → 回落 drawer」的真实来源形态之一）
   * 由 Guard 捕获，壳自身未设 errorCaptured 不拦截。
   */
  function mountGuardWithOverlay(errorHandler?: (err: unknown) => void): VueWrapper {
    return mount(WorkflowVizOverlayGuard, {
      slots: {
        default: () => [
          h(WorkflowVizOverlay, { open: true, run: run(), dag: null, dagError: null }),
          h(ThrowingChild),
        ],
      },
      ...(errorHandler ? { global: { config: { errorHandler } } } : {}),
    })
  }

  function mountGuardOnly(errorHandler?: (err: unknown) => void): VueWrapper {
    return mount(WorkflowVizOverlayGuard, {
      slots: { default: h(ThrowingChild) },
      ...(errorHandler ? { global: { config: { errorHandler } } } : {}),
    })
  }

  it('overlay 树内子组件抛错 → fallback 事件发出（回落动作序列由接线方承接）', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const wrapper = mountGuardWithOverlay()
    expect(wrapper.emitted('fallback')).toHaveLength(1)
  })

  it('failed 后 overlay 树卸载（回落 drawer 时 overlay 随之消失，无占位 UI）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const wrapper = mountGuardWithOverlay()
    // failed 置位 → 重渲染在下一 tick
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="wfvz-overlay"]').exists()).toBe(false)
  })

  it('错误被边界拦截：全局 errorHandler 零调用（return false 阻断，不升级全局故障）', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const globalErrors: unknown[] = []
    mountGuardOnly((err) => globalErrors.push(err))
    expect(globalErrors).toHaveLength(0)
  })
})
})

// ═══════════ 来源节：workflow-viz-overlay-host ═══════════

describe('workflow-viz-overlay-host', () => {
/** 当前在场的最后一个 Guard 实例身份（无实例 = undefined）。 */
function lastGuardInstance(): symbol | undefined {
  return guardMounts.instances[guardMounts.instances.length - 1]
}

// ── 测试数据 ──────────────────────────────────────────────────────────────────

const SID = 's-main'

/** 三条同名 run（记录序 = 时间序）：slug 各异，用于反查/最新/碰撞分支。 */
function makeRun(runId: string, slug: string | undefined, overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    runId,
    scriptName: 'flow-a',
    ...(slug !== undefined ? { slug } : {}),
    status: 'running',
    startedAt: '2026-10-02T00:00:00Z',
    agentCalls: [],
    stateFilePath: '',
    ...overrides,
  }
}

const SAMPLE_DAG: WorkflowDag = {
  phases: [{ name: 'gate', order: 0 }],
  nodes: [{
    id: 'n1',
    kind: 'agent',
    templateName: 'preflight',
    matchPattern: '',
    phase: 'gate',
    line: 3,
  }],
  edges: [],
  parallelGroups: [],
  loops: [],
}

/** 当前测试分区键（bindDrawerSessionId 的 renderer 装配等价物） */
let sidRef: Ref<string | null>

async function seedRecords(records: WorkflowRunRecord[], sessionId = SID): Promise<void> {
  mockGetWorkflows.mockResolvedValue({ workflows: records })
  await useWorkflowStore().loadWorkflows(sessionId)
}

function focusPanel(sid: string | null): void {
  const panel = usePanelStore()
  panel.loadSession(panel.layout.id, sid)
}

beforeEach(async () => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  // core 侧装配等价物：分区键绑定 + drawer 测试隔离
  sidRef = ref<string | null>(null)
  bindDrawerSessionId(sidRef)
  _resetDrawerForTest()
  // controller/SSOT 状态复位（overlay 开合态经 core closeOverlay——关浮层复位不变量；
  // DAG 缓存模块级 ref 直写，装配绑定在 import 时已发生，本文件用例共用该绑定）
  closeOverlay()
  overlayDag.value = null
  overlayDagError.value = null
  panelThrowBox.value = false
  guardMounts.instances.length = 0
  mockGetDag.mockResolvedValue({ runId: 'x', dag: SAMPLE_DAG })
  focusPanel(SID)
})

describe('opener 反查（D1 调用点：托盘 runId 直开 + block (name, slug) 反查）', () => {
  it('托盘路径：runId 精确匹配直开（openWorkflow(runId) 零改动语义）', async () => {
    await seedRecords([makeRun('wf-1', 's1'), makeRun('wf-2', 's2', { scriptName: 'flow-b' })])

    openWorkflow('wf-2')
    await flushPromises()

    expect(isOverlayOpen()).toBe(true)
    expect(currentRun()).toEqual({ sessionId: SID, runId: 'wf-2' })
  })

  it('block 路径：(scriptName, slug) 精确命中（slug 区分并发 run）', async () => {
    await seedRecords([makeRun('wf-1', 's1'), makeRun('wf-2', 's2'), makeRun('wf-3', 's3')])

    openWorkflow('flow-a', { slug: 's2', sessionId: SID })
    await flushPromises()

    expect(currentRun()).toEqual({ sessionId: SID, runId: 'wf-2' })
  })

  it('block 路径：name 为路径/带扩展名形态时 basename 归一命中（L4 真机缺陷回归）', async () => {
    await seedRecords([makeRun('wf-1', 's1'), makeRun('wf-2', 's2')])

    // 主 agent 常传绝对路径（/abs/path/flow-a.js）与 record.basename（flow-a）互通
    openWorkflow('/Users/agent/workflows/flow-a.js', { slug: 's1', sessionId: SID })
    await flushPromises()
    expect(currentRun()).toEqual({ sessionId: SID, runId: 'wf-1' })

    closeOverlay()
    openWorkflow('flow-a.mjs', { slug: 's2', sessionId: SID })
    await flushPromises()
    expect(currentRun()?.runId).toBe('wf-2')
  })

  it('slug 缺失回落「name → 最新 run」（记录末条，run-name 归一后取最新）', async () => {
    await seedRecords([makeRun('wf-1', 's1'), makeRun('wf-2', 's2'), makeRun('wf-3', 's3')])

    openWorkflow('flow-a', { sessionId: SID })
    await flushPromises()

    expect(currentRun()?.runId).toBe('wf-3')
  })

  it('slug 碰撞（多条同 slug）取最新一条并照常打开，不阻塞', async () => {
    await seedRecords([makeRun('wf-1', 'dup'), makeRun('wf-2', 'dup'), makeRun('wf-3', 's3')])

    openWorkflow('flow-a', { slug: 'dup', sessionId: SID })
    await flushPromises()

    expect(currentRun()?.runId).toBe('wf-2')
  })

  it('反查未命中 → 兜底 toast（[2026-10-19] drawer workflow tab 已删，点击不丢反馈）', async () => {
    await seedRecords([makeRun('wf-1', 's1')])

    openWorkflow('gone-flow', { sessionId: SID })
    await flushPromises()

    expect(isOverlayOpen()).toBe(false)
    // drawer 不被误开（workflow tab 已不存在）
    const drawer = useDrawerControl()
    expect(drawer.isOpen.value).toBe(false)
    // toast 反馈错误可操作（错误 → 重试闭环的入口提示）
    expect(toastErrorMock).toHaveBeenCalledTimes(1)
  })

  it('opener 未传 sessionId 且焦点 pane 无 session → no-op', async () => {
    await seedRecords([makeRun('wf-1', 's1')])
    focusPanel(null)

    openWorkflow('wf-1')
    await flushPromises()

    expect(isOverlayOpen()).toBe(false)
    expect(currentRun()).toBeNull()
  })
})

describe('DAG 通道（§3.1-5 两路错误归一 + 在途丢弃 + 重试）', () => {
  it('打开即拉 DAG；成功臂写入 overlayDag', async () => {
    await seedRecords([makeRun('wf-1', 's1')])
    mockGetDag.mockResolvedValue({ runId: 'wf-1', dag: SAMPLE_DAG })

    openWorkflowVizOverlay(SID, 'wf-1')
    await flushPromises()

    expect(mockGetDag).toHaveBeenCalledWith(SID, 'wf-1')
    expect(overlayDag.value).toEqual(SAMPLE_DAG)
    expect(overlayDagError.value).toBeNull()
  })

  it('结构化领域回执（record_not_found）→ dagError 透传 code', async () => {
    await seedRecords([makeRun('wf-1', 's1')])
    mockGetDag.mockResolvedValue({ runId: 'wf-1', code: 'record_not_found', message: 'no record' })

    openWorkflowVizOverlay(SID, 'wf-1')
    await flushPromises()

    expect(overlayDag.value).toBeNull()
    expect(overlayDagError.value?.code).toBe('record_not_found')
  })

  it('RPC 通道错误（reject）→ 归一为 channel 码', async () => {
    await seedRecords([makeRun('wf-1', 's1')])
    mockGetDag.mockRejectedValue(new Error('rpc down'))

    openWorkflowVizOverlay(SID, 'wf-1')
    await flushPromises()

    expect(overlayDagError.value?.code).toBe('channel')
    expect(overlayDagError.value?.message).toBe('rpc down')
  })

  it('切换 run / 关闭后返回的旧结果在途丢弃（不写入新活跃组合）', async () => {
    await seedRecords([makeRun('wf-1', 's1'), makeRun('wf-2', 's2')])
    // wf-1 的 DAG 挂起不 settle；期间切到 wf-2 并完成
    let resolveFirst: (v: { runId: string; dag: WorkflowDag }) => void = () => {}
    mockGetDag.mockImplementationOnce(() => new Promise((res) => { resolveFirst = res }))
    mockGetDag.mockResolvedValueOnce({ runId: 'wf-2', dag: SAMPLE_DAG })

    openWorkflowVizOverlay(SID, 'wf-1')
    openWorkflowVizOverlay(SID, 'wf-2')
    await flushPromises()
    resolveFirst({ runId: 'wf-1', dag: SAMPLE_DAG })
    await flushPromises()

    // 旧拉取 settle 时活跃组合已是 wf-2 → 丢弃，不覆盖 wf-2 的结果
    expect(currentRun()?.runId).toBe('wf-2')
    expect(mockGetDag).toHaveBeenCalledTimes(2)
  })

  it('retryDagParse：parse_failed 后重试重新拉取当前 run', async () => {
    await seedRecords([makeRun('wf-1', 's1')])
    mockGetDag.mockResolvedValueOnce({ runId: 'wf-1', code: 'parse_failed', message: 'bad syntax' })

    openWorkflowVizOverlay(SID, 'wf-1')
    await flushPromises()
    expect(overlayDagError.value?.code).toBe('parse_failed')

    mockGetDag.mockResolvedValueOnce({ runId: 'wf-1', dag: SAMPLE_DAG })
    retryDagParse()
    await flushPromises()

    expect(overlayDag.value).toEqual(SAMPLE_DAG)
    expect(overlayDagError.value).toBeNull()
  })
})

describe('session 删除关 overlay（D11⑤）', () => {
  it('删除的是发起 session → 关 overlay；其他 session 不关', async () => {
    await seedRecords([makeRun('wf-1', 's1')], SID)
    openWorkflowVizOverlay(SID, 'wf-1')
    expect(isOverlayOpen()).toBe(true)

    closeWorkflowVizOverlayForSession('other-sid')
    expect(isOverlayOpen()).toBe(true)

    closeWorkflowVizOverlayForSession(SID)
    expect(isOverlayOpen()).toBe(false)
  })
})

describe('Host 容器（黑盒 DOM + D10 回落）', () => {
  it('打开后 overlay 面板呈现 + 实况面板挂载（slot 填充位）', async () => {
    await seedRecords([makeRun('wf-1', 's1')])
    const wrapper = mount(WorkflowVizOverlayHost)

    openWorkflowVizOverlay(SID, 'wf-1')
    await flushPromises()

    expect(wrapper.find('[data-testid="wfvz-overlay-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wf-live-panel-stub"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('关闭态 DOM 零痕迹（壳 v-if 不渲染——像素对比层基线安全）', () => {
    const wrapper = mount(WorkflowVizOverlayHost)
    expect(wrapper.find('[data-testid="wfvz-overlay"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('零命中实例在上区未匹配分组可见（D2⑥ 不静默丢弃——真实匹配链派生，S3 对账出口）', async () => {
    // phase 'elsewhere' 不在 DAG 分区 → 零命中进 unmatched（Host 派生经 matchInstancesToNodes）
    await seedRecords([makeRun('wf-1', 's1', { agentCalls: [
      { id: 0, agent: 'stray-agent', phase: 'elsewhere', status: 'done' },
    ] })])
    const wrapper = mount(WorkflowVizOverlayHost)

    openWorkflowVizOverlay(SID, 'wf-1')
    await flushPromises()

    const group = wrapper.find('[data-testid="wfvz-overlay-unmatched-group-elsewhere"]')
    expect(group.exists()).toBe(true)
    expect(group.text()).toContain('stray-agent')
    wrapper.unmount()
  })

  it('D10 fallback：装载异常 → 关 overlay（[2026-10-19] 回落载体 drawer workflow tab 已删，重开即重试）', async () => {
    await seedRecords([makeRun('wf-1', 's1')])
    panelThrowBox.value = true
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const wrapper = mount(WorkflowVizOverlayHost)

    openWorkflowVizOverlay(SID, 'wf-1')
    await flushPromises()

    // Guard 捕获 → fallback 序列执行：仅关 overlay，drawer 不被误开
    const drawer = useDrawerControl()
    expect(isOverlayOpen()).toBe(false)
    expect(drawer.isOpen.value).toBe(false)
    wrapper.unmount()
    consoleSpy.mockRestore()
  })

  it('标题栏模型全切接线：壳 select-model → setSubagentModel（runId + provider + modelId 透传）', async () => {
    await seedRecords([makeRun('wf-1', 's1', {
      agentCalls: [{
        id: 0, agent: 'worker-0', phase: 'alpha', status: 'running', startedAt: new Date().toISOString(),
        sessionId: 'acs-0', model: 'glm-5.3',
      } as unknown as WorkflowRunRecord['agentCalls'][number]],
    })])
    const wrapper = mount(WorkflowVizOverlayHost)
    openWorkflowVizOverlay(SID, 'wf-1')
    await flushPromises()

    // 触发器在场（run 元素行内），点击选模型 → 宿主接线 setSubagentModel
    expect(wrapper.find('[data-testid="wfvz-overlay-model-trigger"]').exists()).toBe(true)
    await wrapper.find('[data-testid="model-select-stub"]').trigger('click')
    await flushPromises()
    expect(setSubagentModelMock).toHaveBeenCalledWith({
      runId: 'wf-1',
      provider: 'zai-coding-cn',
      modelId: 'glm-4.7',
    })
    wrapper.unmount()
  })

  it('回落后再点击 → overlay 重试呈现（Guard epoch 重挂，failed 不卡死后续打开——D10 每次点击均重试）', async () => {
    await seedRecords([makeRun('wf-1', 's1')])
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const wrapper = mount(WorkflowVizOverlayHost)

    // 第一次打开：面板抛错 → 回落
    panelThrowBox.value = true
    openWorkflowVizOverlay(SID, 'wf-1')
    await flushPromises()
    expect(isOverlayOpen()).toBe(false)

    // 第二次打开：正常面板 → overlay 再次完整呈现
    panelThrowBox.value = false
    openWorkflowVizOverlay(SID, 'wf-1')
    await flushPromises()

    expect(isOverlayOpen()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-overlay-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wf-live-panel-stub"]').exists()).toBe(true)
    wrapper.unmount()
    consoleSpy.mockRestore()
  })
})

describe('scheduler 一级 tab（Host 挂载门控 + tab 状态机，scheduler 整合 2026-10-06）', () => {
  it('scheduler 直达打开：overlay 面板呈现 + scheduler pane 在场 + runs body 不在场 + header 换定时任务标题 + 「运行」tab 禁用（无 run 数据）', async () => {
    const wrapper = mount(WorkflowVizOverlayHost)

    openSchedulerTab(SID)
    await flushPromises()

    expect(wrapper.find('[data-testid="wfvz-overlay-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-overlay-scheduler-pane"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-overlay-dag-pane"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="wfvz-overlay-live-pane"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="wfvz-overlay-scheduler-title"]').exists()).toBe(true)
    const runsTab = wrapper.find('[data-testid="wfvz-overlay-tab-runs"]')
    expect(runsTab.attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('workflow 开着点「定时任务」tab：scheduler pane 出现 + DAG 区卸载；点回「运行」还原（tab 只切展示维度，core 内容 kind 不变）', async () => {
    await seedRecords([makeRun('wf-1', 's1')])
    const wrapper = mount(WorkflowVizOverlayHost)

    openWorkflowVizOverlay(SID, 'wf-1')
    await flushPromises()
    expect(wrapper.find('[data-testid="wfvz-overlay-dag-pane"]').exists()).toBe(true)

    await wrapper.find('[data-testid="wfvz-overlay-tab-scheduler"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="wfvz-overlay-scheduler-pane"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-overlay-dag-pane"]').exists()).toBe(false)
    expect(currentRun()).toEqual({ sessionId: SID, runId: 'wf-1' })

    await wrapper.find('[data-testid="wfvz-overlay-tab-runs"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="wfvz-overlay-dag-pane"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('关闭复位（任意通道）：Esc 编排器直关 core 开合态 → overlayTab 复位 runs；重开按入口定', () => {
    openSchedulerTab(SID)
    expect(overlayTab.value).toBe('scheduler')
    // closeOverlay = core 直关（stack-order Esc 通道同形态，不经控制器关闭函数）
    closeOverlay()
    expect(overlayTab.value).toBe('runs')

    openSchedulerTab(SID)
    expect(overlayTab.value).toBe('scheduler')
    closeWorkflowVizOverlay() // 壳 close 通道
    expect(overlayTab.value).toBe('runs')
  })

  it('session 删除级联对 scheduler 内容同判据：删发起 session 关、删其他不关（D11⑤ §7.4 同语义）', () => {
    openSchedulerTab(SID)
    closeWorkflowVizOverlayForSession('other-sid')
    expect(isOverlayOpen()).toBe(true)
    closeWorkflowVizOverlayForSession(SID)
    expect(isOverlayOpen()).toBe(false)
  })
})

describe('canvas 一级 tab（problem-solve-canvas §3.1(3)：画布按归属会话隔离 D4，scheduler 双入口先例平移）', () => {
  it('canvas 直达打开（kind 直达）：overlay 面板呈现 + canvas pane 在场且 CanvasPane 真实挂载（core 内容 kind=canvas、canvasId=cvs-1 + 归属 sessionId）+ runs/scheduler body 不在场 + header 换画布标题', async () => {
    const wrapper = mount(WorkflowVizOverlayHost)

    openCanvasTab('cvs-1', SID)
    await flushPromises()

    expect(getOverlayControlState().current).toEqual({ kind: 'canvas', payload: { canvasId: 'cvs-1', sessionId: SID } })
    expect(wrapper.find('[data-testid="wfvz-overlay-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-overlay-canvas-pane"]').exists()).toBe(true)
    // CanvasPane 异步导入（defineAsyncComponent）落定后真实挂载——canvas-pane 为其根元素
    // testid；挂载即 loadCanvas（host 路径无 canvas RPC mock，transport 不可达走 store
    // 错误态渲染，根元素仍在——断言坐实「非空 wrapper」）
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="canvas-pane"]').exists()).toBe(true)
    })
    expect(wrapper.find('[data-testid="wfvz-overlay-dag-pane"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="wfvz-overlay-live-pane"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="wfvz-overlay-scheduler-pane"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="wfvz-overlay-canvas-title"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('tab 切换互不串扰：workflow 开着切 canvas 再切回——core 内容 kind 不变（workflow），DAG 区随 tab 卸载/还原', async () => {
    await seedRecords([makeRun('wf-1', 's1')])
    const wrapper = mount(WorkflowVizOverlayHost)

    openWorkflowVizOverlay(SID, 'wf-1')
    await flushPromises()
    expect(wrapper.find('[data-testid="wfvz-overlay-dag-pane"]').exists()).toBe(true)

    // 切 canvas：runs body 卸载、canvas pane 空 wrapper 在场（core 内容仍 workflow、canvasId 缺席 CanvasPane 不挂载）；tab 只切展示维度
    await wrapper.find('[data-testid="wfvz-overlay-tab-canvas"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="wfvz-overlay-canvas-pane"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-overlay-dag-pane"]').exists()).toBe(false)
    expect(currentRun()).toEqual({ sessionId: SID, runId: 'wf-1' })

    // 切回 runs：DAG 区还原
    await wrapper.find('[data-testid="wfvz-overlay-tab-runs"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="wfvz-overlay-dag-pane"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-overlay-canvas-pane"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('tab 切换互不串扰：canvas 直达开着切 scheduler——scheduler pane 替换 canvas pane（CanvasPane 随之卸载），再点 canvas 段还原', async () => {
    const wrapper = mount(WorkflowVizOverlayHost)

    openCanvasTab('cvs-1', SID)
    await flushPromises()
    expect(wrapper.find('[data-testid="wfvz-overlay-canvas-pane"]').exists()).toBe(true)

    await wrapper.find('[data-testid="wfvz-overlay-tab-scheduler"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="wfvz-overlay-scheduler-pane"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-overlay-canvas-pane"]').exists()).toBe(false)

    await wrapper.find('[data-testid="wfvz-overlay-tab-canvas"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="wfvz-overlay-canvas-pane"]').exists()).toBe(true)
    expect(overlayTab.value).toBe('canvas')
    wrapper.unmount()
  })

  it('关闭复位对 canvas 内容同构：关（任意通道）→ overlayTab 复位 runs；重开由入口定', () => {
    openCanvasTab('cvs-1', SID)
    expect(overlayTab.value).toBe('canvas')
    closeOverlay()
    expect(overlayTab.value).toBe('runs')

    openCanvasTab('cvs-1', SID)
    expect(overlayTab.value).toBe('canvas')
    closeWorkflowVizOverlay()
    expect(overlayTab.value).toBe('runs')
  })

  it('session 删除级联对 canvas 内容关（D4：删除画布归属会话 → 关浮层；删其他会话不关）', () => {
    openCanvasTab('cvs-1', SID)
    // 删非归属会话 → 条件式级联不动浮层
    closeWorkflowVizOverlayForSession('s-other')
    expect(isOverlayOpen()).toBe(true)
    expect(getOverlayControlState().current?.kind).toBe('canvas')

    // 删归属会话 → 关浮层（载荷 sessionId = 归属会话，与 workflow/scheduler 同判据）
    closeWorkflowVizOverlayForSession(SID)
    expect(isOverlayOpen()).toBe(false)
  })
})

describe('kind 门控（U4 修复对账）：Guard 重挂与时长 tick 只随 workflow 内容开合', () => {
  it('Guard 重挂：workflow 开必重挂（fresh Guard 复位 failed）；browser 开/换入零重挂', async () => {
    await seedRecords([makeRun('wf-1', 's1')])
    const wrapper = mount(WorkflowVizOverlayHost)
    await flushPromises()
    const initial = lastGuardInstance() // 关闭态首挂的实例（immediate watch 不重挂）
    expect(initial).toBeDefined()

    openWorkflowVizOverlay(SID, 'wf-1')
    await flushPromises()
    const afterWorkflowOpen = lastGuardInstance()
    expect(afterWorkflowOpen).not.toBe(initial) // workflow 开 → epoch++ → 重挂（fresh Guard）

    // 单例换内容：workflow → browser（isOpen 全程 true，仅 kind 判定感知换出）
    openBrowser('http://localhost:1420', SID)
    await flushPromises()
    expect(lastGuardInstance()).toBe(afterWorkflowOpen) // [U4] browser 换入零重挂（旧裸 overlayOpen 语义无法感知）

    openWorkflowVizOverlay(SID, 'wf-1')
    await flushPromises()
    const afterReopen = lastGuardInstance()
    expect(afterReopen).not.toBe(afterWorkflowOpen) // workflow 再入必重挂（fresh Guard，D10 每次点击均重试）

    closeOverlay()
    openBrowser('http://localhost:1420', SID)
    await flushPromises()
    // [U4] 关闭态开 browser 零重挂（旧行为在此无谓重挂）：关闭已卸载 Guard，开 browser 不应再挂新实例
    expect(lastGuardInstance()).toBe(afterReopen)

    wrapper.unmount()
  })

  it('时长 tick：workflow 开启动、browser 换入即停（旧行为空转）、关闭即停', async () => {
    await seedRecords([makeRun('wf-1', 's1', { startedAt: new Date(Date.now() - 5_000).toISOString() })])
    const wrapper = mount(WorkflowVizOverlayHost)
    await flushPromises()
    // spy 在 mount 后建立：只观测用例内的开合动作（隔离环境杂音）。
    // 2026-10-22 测试整治：断言「活跃 handle 集合」而非「spy 调用次数」——次数把
    // watch 重跑的批处理切分变成了断言对象（满并行下一次开合多排空一轮即随机红）；
    // 行为语义是「同一时刻至多一个活跃 tick、内容换出/关闭后零活跃」，与重启几轮无关。
    const setSpy = vi.spyOn(globalThis, 'setInterval')
    const clearSpy = vi.spyOn(globalThis, 'clearInterval')
    const activeTickHandles = (): number => {
      // setInterval 的返回 handle 在 mock.results（calls 里 [0] 是回调参数）；clearInterval 的 handle 在 calls[0]
      const handles = setSpy.mock.results.map((result) => result.value)
      const cleared = new Set(clearSpy.mock.calls.map((call) => call[0]))
      return handles.filter((handle) => !cleared.has(handle)).length
    }

    openWorkflowVizOverlay(SID, 'wf-1')
    await flushPromises()
    expect(activeTickHandles()).toBe(1) // workflow 开 → tick 启动（恰一个活跃）
    // 时长的用户可见消费方（壳 header 时长槽）随开渲染
    expect(wrapper.find('[data-testid="wfvz-overlay-elapsed"]').exists()).toBe(true)

    openBrowser('http://localhost:1420', SID)
    await flushPromises()
    expect(activeTickHandles()).toBe(0) // [U4] 换入 browser 即停（旧行为 tick 空转）

    openWorkflowVizOverlay(SID, 'wf-1')
    await flushPromises()
    expect(activeTickHandles()).toBe(1) // workflow 再入 → 重启（仍恰一个活跃）

    closeOverlay()
    await flushPromises()
    expect(activeTickHandles()).toBe(0) // 关闭即停

    wrapper.unmount()
    setSpy.mockRestore()
    clearSpy.mockRestore()
  })
})
})

