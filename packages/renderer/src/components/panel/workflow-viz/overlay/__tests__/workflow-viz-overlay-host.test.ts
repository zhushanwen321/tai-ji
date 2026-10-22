/**
 * workflow-viz overlay 控制器 + Host 容器测试（workflow-visualization U6——三视角）。
 *
 * - 构建者（白盒）：opener 反查全分支（runId 直开 / (scriptName, slug) 精确 / slug 缺失
 *   回落 name → 最新 / slug 碰撞取最新 / 未命中兜底 toast）；DAG 通道两路错误归一
 *   （结构化领域回执 / RPC 通道错误 'channel'）；D10 fallback 动作序列（关 overlay——
 *   [2026-10-19] drawer workflow tab 删除，回落载体不再存在）
 * - 使用者（黑盒 DOM）：打开后 overlay 面板呈现；装载异常关 overlay；回落后再点击
 *   overlay 重试呈现（Guard epoch 重挂，无失败卡死）
 * - 观察者（形态）：D11⑤ session 删除关 overlay 的会话匹配语义
 *
 * mock 策略：api/domains/session（getWorkflows/getWorkflowDag）+ @/api 门面回指 +
 * vue-i18n override + WorkflowLivePanel 可控抛错 stub（fallback 触发源）。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/workflow-viz/overlay/__tests__/workflow-viz-overlay-host.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import {
  bindDrawerSessionId,
  bindWorkflowOverlayOpener,
  openWorkflow,
  useDrawerControl,
  _resetDrawerForTest,
} from '@taiji/core/domain/drawer'
import { ref } from 'vue'
import type { Ref } from 'vue'
import WorkflowVizOverlayHost from '../WorkflowVizOverlayHost.vue'
import { closeOverlay, getOverlayControlState, openBrowser } from '@taiji/core/domain/overlay'
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
import { useWorkflowStore } from '@/stores/workflow'
import { usePanelStore } from '@/stores/panel'
import type { WorkflowDag, WorkflowRunRecord } from '@taiji/shared'

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

// ── mock：RPC 域 + @/api 门面回指（u5 workflow-store-run-events.test.ts 同款）──

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

// ── mock：i18n（Host 链内壳/DAG 画布消费 useI18n）──────────────────────────────

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
    setup(_, { emit, slots }) {
      return () =>
        h('div', {
          'data-testid': 'model-select-stub',
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

  it('关闭态 DOM 零痕迹（壳 v-if 不渲染——像素轨基线安全）', () => {
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
