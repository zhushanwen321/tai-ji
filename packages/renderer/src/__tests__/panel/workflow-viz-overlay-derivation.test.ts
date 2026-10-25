/**
 * workflow-viz overlay 派生视图测试（容器扩展点统一 §6.8/§7.3/§11.1-2，U7——三视角）。
 *
 * - 构建者（白盒）：标签条分段派生（tab 位映射 / 序 / openableWithoutData / browser 排除 /
 *   插件不进条）与壳承载 kind 集（workflow-viz-overlay-derivation 单点；派生源 =
 *   builtinOverlayTypeViews(OVERLAY_REGISTRY)，§6.1 内置项不经声明通道）；
 * - 使用者（黑盒 DOM）：标签条分段渲染、§6.15 openableWithoutData 数据驱动禁用（runs 无
 *   run 灰置不上抛 / scheduler·canvas 恒可进）、段集外 tab 值零渲染（无 v-else 兜底）、
 *   §11.1-2 级联判据经 renderer 编排对插件内容同样生效（删归属关 / 删其他不关）；
 * - 观察者（形态）：Host 插件内容承载位（§6.8 独立浮层内容——不进 workflow 壳标签条，
 *   独立 OverlayShell + plugin pane 在场）。
 *
 * mock 策略比照 workflow-viz-overlay-host.test.ts（RPC 域 / i18n / 面板与托盘组件边界）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/workflow-viz-overlay-derivation.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { bindDrawerSessionId, _resetDrawerForTest } from '@taiji/core/domain/drawer'
import { OVERLAY_REGISTRY } from '@taiji/core/domain/drawer'
import { openOverlayContent, closeOverlay, getOverlayControlState } from '@taiji/core/domain/overlay'
import WorkflowVizOverlay from '../../components/panel/workflow-viz/overlay/WorkflowVizOverlay.vue'
import WorkflowVizOverlayHost from '../../components/panel/workflow-viz/overlay/WorkflowVizOverlayHost.vue'
import {
  deriveOverlayHostedKinds,
  deriveOverlayTabSegments,
} from '../../components/panel/workflow-viz/overlay/workflow-viz-overlay-derivation'
import { closeWorkflowVizOverlayForSession } from '../../components/panel/workflow-viz/overlay/workflow-viz-overlay'
import { useWorkflowStore } from '@/stores/workflow'
import { usePanelStore } from '@/stores/panel'
import type { WorkflowDag, WorkflowRunRecord } from '@taiji/shared'

// ── mock：RPC 域 + @/api 门面回指（host 测试同款——setupFiles 真连 ws 防线）─────────

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

// ── mock：i18n（Host/壳消费 useI18n；key 直通形态断言）───────────────────────────

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return {
    ...actual,
    useI18n: () => ({
      t: (key: string) => key,
      locale: { value: 'zh-CN' },
    }),
  }
})

// ── mock：组件边界（壳/Host 的 slot 与旁挂件——本文件只观测派生消费形态）──────────

vi.mock('@/components/panel/ModelSelectPopover.vue', () => ({
  default: defineComponent({
    name: 'ModelSelectPopoverStub',
    props: { selected: { type: String, default: '' }, switching: { type: Boolean, default: false } },
    emits: ['select'],
    setup(_, { emit, slots }) {
      return () => h('div', { 'data-testid': 'model-select-stub', onClick: () => emit('select', {}) }, slots.trigger?.())
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
vi.mock('@/components/panel/BrowserOverlay.vue', () => ({
  default: { name: 'BrowserOverlayStub', template: '<div />' },
}))
vi.mock('../../components/panel/workflow-viz/panel/WorkflowLivePanel.vue', () => ({
  default: { name: 'WorkflowLivePanelStub', props: ['sessionId', 'run', 'ganttComponent'], template: '<div data-testid="wf-live-panel-stub" />' },
}))
vi.mock('../../components/panel/workflow-viz/panel/AgentStreamDrawer.vue', () => ({
  default: { name: 'AgentStreamDrawerStub', props: ['sessionId', 'run'], template: '<div />' },
}))
vi.mock('@/composables/features/subagent/useSubagentModel', () => ({
  useSubagentModel: () => ({ setSubagentModel: vi.fn().mockResolvedValue(undefined), memberDisplayOf: () => undefined }),
  resolveSubagentModelDisplay: () => ({ label: undefined, overridden: false }),
}))

// ── 测试数据 ──────────────────────────────────────────────────────────────────

const SID = 's-main'

function makeRun(runId: string, overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    runId,
    scriptName: 'flow-a',
    slug: 'flow-a-7f3a',
    status: 'running',
    startedAt: '2026-10-02T00:00:00Z',
    agentCalls: [],
    stateFilePath: '',
    ...overrides,
  }
}

beforeEach(async () => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  const sidRef = ref<string | null>(SID)
  bindDrawerSessionId(sidRef)
  _resetDrawerForTest()
  closeOverlay()
  const panel = usePanelStore()
  panel.loadSession(panel.layout.id, SID)
})

// ── 构建者（白盒）：派生函数 ─────────────────────────────────────────────────

describe('标签条分段派生（§7.3 浮层标签条行：内置内容视图 → 段集）', () => {
  it('三段齐备且 tab 位映射正确：workflow→runs、scheduler、canvas；序 = OVERLAY_REGISTRY 派生序', () => {
    const segments = deriveOverlayTabSegments()
    expect(segments.map((s) => s.value)).toEqual(['runs', 'scheduler', 'canvas'])
    expect(segments.map((s) => s.kind)).toEqual(['workflow', 'scheduler', 'canvas'])
  })

  it('browser 段不派生（BrowserOverlay 专属壳承载，§7.4 两壳互斥）；元数据来自注册表条目（labelKey/icon 直投）', () => {
    const segments = deriveOverlayTabSegments()
    expect(segments.map((s) => s.value)).not.toContain('browser')
    // 元数据直投自 builtinOverlayTypeViews 产出（workflow 条目 icon='workflow'，registry 单测对账）
    const runs = segments.find((s) => s.value === 'runs')
    expect(runs?.icon).toBe('workflow')
    expect(runs?.labelKey).toBe('panel.workflowViz.overlayTitle')
  })

  it('§6.15 openableWithoutData：workflow 段显式 false（既有禁用规则的数据驱动形态），scheduler/canvas 为 true', () => {
    const segments = deriveOverlayTabSegments()
    expect(segments.find((s) => s.value === 'runs')?.openableWithoutData).toBe(false)
    expect(segments.find((s) => s.value === 'scheduler')?.openableWithoutData).toBe(true)
    expect(segments.find((s) => s.value === 'canvas')?.openableWithoutData).toBe(true)
  })

  it('派生段数与 OVERLAY_REGISTRY 内置条目数对账（§6.1：浮层条目 4 员——3 段 + browser 专属壳排除）', () => {
    expect(OVERLAY_REGISTRY).toHaveLength(4)
    expect(deriveOverlayTabSegments()).toHaveLength(3)
  })

  it('壳承载 kind 集合（Host「是否打开」判定派生源）：内置三类在场，browser 与 plugin 排除', () => {
    const hosted = deriveOverlayHostedKinds()
    expect([...hosted].sort()).toEqual(['canvas', 'scheduler', 'workflow'])
  })
})

// ── 使用者（黑盒 DOM）：壳消费派生 ────────────────────────────────────────────

describe('壳标签条渲染消费派生段（黑盒 DOM）', () => {
  const SAMPLE_DAG: WorkflowDag = {
    phases: [{ name: 'gate', order: 0 }],
    nodes: [{ id: 'n1', kind: 'agent', templateName: 'preflight', matchPattern: '', phase: 'gate', line: 3 }],
    edges: [],
    parallelGroups: [],
    loops: [],
  }

  function mountOverlay(props: Record<string, unknown> = {}) {
    return mount(WorkflowVizOverlay, { props: { open: true, run: null, dag: null, dagError: null, ...props } })
  }

  it('标签条三段由派生段集渲染：runs 选中、scheduler/canvas 未选中（aria-selected 形态）', () => {
    const wrapper = mountOverlay({ dag: SAMPLE_DAG })
    expect(wrapper.find('[data-testid="wfvz-overlay-tabs"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-overlay-tab-runs"]').attributes('aria-selected')).toBe('true')
    expect(wrapper.find('[data-testid="wfvz-overlay-tab-scheduler"]').attributes('aria-selected')).toBe('false')
    expect(wrapper.find('[data-testid="wfvz-overlay-tab-canvas"]').attributes('aria-selected')).toBe('false')
    wrapper.unmount()
  })

  it('§6.15 数据驱动禁用：无 run 时 runs 段灰置且点击不上抛（openableWithoutData=false + 无数据）', async () => {
    const wrapper = mountOverlay({ run: null })
    const runsTab = wrapper.find('[data-testid="wfvz-overlay-tab-runs"]')
    expect(runsTab.attributes('disabled')).toBeDefined()
    await runsTab.trigger('click')
    expect(wrapper.emitted('update:tab')).toBeUndefined()
    wrapper.unmount()
  })

  it('§6.15 数据驱动放行：run 在场 → runs 可点上抛（数据就绪即开，判据来自派生字段非硬编码段名）', async () => {
    const wrapper = mountOverlay({ run: makeRun('wf-1'), dag: SAMPLE_DAG })
    const runsTab = wrapper.find('[data-testid="wfvz-overlay-tab-runs"]')
    expect(runsTab.attributes('disabled')).toBeUndefined()
    await runsTab.trigger('click')
    expect(wrapper.emitted('update:tab')?.[0]).toEqual(['runs'])
    wrapper.unmount()
  })

  it('§6.15 openableWithoutData=true 段恒可进：无 run 时 scheduler/canvas 点击照常上抛', async () => {
    const wrapper = mountOverlay({ run: null })
    await wrapper.find('[data-testid="wfvz-overlay-tab-scheduler"]').trigger('click')
    await wrapper.find('[data-testid="wfvz-overlay-tab-canvas"]').trigger('click')
    expect(wrapper.emitted('update:tab')?.[0]).toEqual(['scheduler'])
    expect(wrapper.emitted('update:tab')?.[1]).toEqual(['canvas'])
    wrapper.unmount()
  })

  it('段集外 tab 值零渲染（§7.3 无 v-else 兜底）：标题段与内容 pane 全部不在场', () => {
    const wrapper = mountOverlay({ tab: 'nonexistent' })
    expect(wrapper.find('[data-testid="wfvz-overlay-scheduler-title"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="wfvz-overlay-canvas-title"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="wfvz-overlay-canvas-pane"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="wfvz-overlay-scheduler-pane"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="wfvz-overlay-dag-pane"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('派生段标题与内容 pane 的 testid 锚点保持（scheduler/canvas 段——e2e 与既有单测共享锚点）', () => {
    const scheduler = mountOverlay({ tab: 'scheduler' })
    expect(scheduler.find('[data-testid="wfvz-overlay-scheduler-title"]').exists()).toBe(true)
    expect(scheduler.find('[data-testid="wfvz-overlay-scheduler-pane"]').exists()).toBe(true)
    scheduler.unmount()

    const canvas = mountOverlay({ tab: 'canvas' })
    expect(canvas.find('[data-testid="wfvz-overlay-canvas-title"]').exists()).toBe(true)
    expect(canvas.find('[data-testid="wfvz-overlay-canvas-pane"]').exists()).toBe(true)
    canvas.unmount()
  })
})

// ── §11.1-2 级联（renderer 编排消费统一判据）+ Host 插件承载位（观察者形态）────────

describe('级联判据统一 payload.sessionId（renderer 编排 closeWorkflowVizOverlayForSession）', () => {
  it('§11.1-2 插件内容：删归属会话 → 浮层关闭；删其他会话 → 不关闭（kind 不参与）', () => {
    openOverlayContent('my-plugin.panel', SID)
    expect(getOverlayControlState().isOpen).toBe(true)

    closeWorkflowVizOverlayForSession('s-other')
    expect(getOverlayControlState().isOpen, '删其他会话浮层不动').toBe(true)
    expect(getOverlayControlState().current).toEqual({ kind: 'plugin', payload: { contentId: 'my-plugin.panel', sessionId: SID } })

    closeWorkflowVizOverlayForSession(SID)
    expect(getOverlayControlState().isOpen, '删归属会话浮层关闭').toBe(false)
    expect(getOverlayControlState().current).toBeNull()
  })
})

describe('Host 插件内容承载位（§6.8 独立浮层内容，观察者形态）', () => {
  it('plugin 内容打开：独立 OverlayShell 在场（plugin pane）——workflow 壳（runs body）不同时在场', async () => {
    const wrapper = mount(WorkflowVizOverlayHost)
    openOverlayContent('my-plugin.panel', SID)
    await flushPromises()

    expect(wrapper.find('[data-testid="wfvz-overlay-plugin-pane"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-overlay-dag-pane"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="wfvz-overlay-scheduler-pane"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('plugin 内容关闭：承载位 DOM 零痕迹（壳 v-if 全量挂卸——像素对比层基线安全）', async () => {
    const wrapper = mount(WorkflowVizOverlayHost)
    openOverlayContent('my-plugin.panel', SID)
    await flushPromises()
    expect(wrapper.find('[data-testid="wfvz-overlay-plugin-pane"]').exists()).toBe(true)

    closeOverlay()
    await flushPromises()
    expect(wrapper.find('[data-testid="wfvz-overlay-plugin-pane"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="wfvz-overlay"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('workflow 内容打开：plugin 承载位不在场（两壳互斥——kind 判定互斥）', async () => {
    const sessionApi = await import('@taiji/core/transport/api/domains/session')
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue({ workflows: [makeRun('wf-1')] })
    await useWorkflowStore().loadWorkflows(SID)

    const wrapper = mount(WorkflowVizOverlayHost)
    const { openWorkflowVizOverlay } = await import('../../components/panel/workflow-viz/overlay/workflow-viz-overlay')
    openWorkflowVizOverlay(SID, 'wf-1')
    await flushPromises()

    expect(wrapper.find('[data-testid="wfvz-overlay-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-overlay-plugin-pane"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
