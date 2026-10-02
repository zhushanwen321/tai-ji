/**
 * workflow-viz overlay 控制器 + Host 容器测试（workflow-visualization U6——三视角）。
 *
 * - 构建者（白盒）：opener 反查全分支（runId 直开 / (scriptName, slug) 精确 / slug 缺失
 *   回落 name → 最新 / slug 碰撞取最新 / 未命中兜底 drawer）；DAG 通道两路错误归一
 *   （结构化领域回执 / RPC 通道错误 'channel'）；D10 fallback 动作序列（关 overlay +
 *   openDrawerTab('workflow') + openWorkflowInDrawer(runId)）
 * - 使用者（黑盒 DOM）：打开后 overlay 面板呈现；装载异常回落 drawer workflow tab（选中
 *   态已注入，非空态）；回落后再点击 overlay 重试呈现（Guard epoch 重挂，无失败卡死）
 * - 观察者（形态）：D11⑤ session 删除关 overlay 的会话匹配语义
 *
 * mock 策略：api/domains/session（getWorkflows/getWorkflowDag）+ @/api 门面回指 +
 * vue-i18n override + WorkflowLivePanel 可控抛错 stub（fallback 触发源）。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/workflow-viz/overlay/__tests__/workflow-viz-overlay-host.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { h } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import {
  bindDrawerSessionId,
  bindWorkflowOverlayOpener,
  openWorkflow,
  openWorkflowInDrawer,
  useDrawerControl,
  useWorkflowSelection,
  _resetDrawerForTest,
} from '@taiji/core/domain/drawer'
import { ref } from 'vue'
import type { Ref } from 'vue'
import WorkflowVizOverlayHost from '../WorkflowVizOverlayHost.vue'
import { closeOverlay, getOverlayControlState } from '@taiji/core/domain/overlay'
import {
  closeWorkflowVizOverlay,
  closeWorkflowVizOverlayForSession,
  openWorkflowVizOverlay,
  overlayDag,
  overlayDagError,
  retryDagParse,
} from '../workflow-viz-overlay'
import { useWorkflowStore } from '@/stores/workflow'
import { usePanelStore } from '@/stores/panel'
import type { WorkflowDag, WorkflowRunRecord } from '@taiji/shared'

// ── core SSOT 读出投影（u-w1-core 迁移：开合态唯一权威 = core/domain/overlay）────

/** 浮层是否开着（原 overlayOpen ref 已退役，读 core SSOT） */
function isOverlayOpen(): boolean {
  return getOverlayControlState().isOpen
}

/** 当前 workflow run 投影（core OverlayContent → { sessionId, runId } 断言口径） */
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
  mockGetDag.mockResolvedValue({ runId: 'x', dag: SAMPLE_DAG })
  focusPanel(SID)
})

describe('opener 反查（D1 调用面：托盘 runId 直开 + block (name, slug) 反查）', () => {
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

  it('slug 缺失回落「name → 最新 run」（记录末条，与 WorkflowTab 兼收解析同口径）', async () => {
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

  it('反查未命中 → 兜底显式 drawer 语义（workflow tab 打开 + 选中名注入，点击不丢反馈）', async () => {
    await seedRecords([makeRun('wf-1', 's1')])

    openWorkflow('gone-flow', { sessionId: SID })
    await flushPromises()

    expect(isOverlayOpen()).toBe(false)
    const drawer = useDrawerControl()
    expect(drawer.isOpen.value).toBe(true)
    expect(drawer.activeTab.value).toBe('workflow')
    expect(useWorkflowSelection().selectedWorkflowName.value).toBe('gone-flow')
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

  it('retryDagParse：parse_failed 后重试重拉当前 run', async () => {
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

  it('零命中实例在左栏未匹配分组可见（D2⑥ 不静默丢弃——真实匹配链派生，S3 对账出口）', async () => {
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

  it('D10 fallback：装载异常 → 关 overlay + drawer workflow tab 打开且选中态已注入（runId）', async () => {
    await seedRecords([makeRun('wf-1', 's1')])
    panelThrowBox.value = true
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const wrapper = mount(WorkflowVizOverlayHost)

    openWorkflowVizOverlay(SID, 'wf-1')
    await flushPromises()

    // Guard 捕获 → fallback 序列执行
    const drawer = useDrawerControl()
    expect(isOverlayOpen()).toBe(false)
    expect(drawer.isOpen.value).toBe(true)
    expect(drawer.activeTab.value).toBe('workflow')
    expect(useWorkflowSelection().selectedWorkflowName.value).toBe('wf-1')
    wrapper.unmount()
    consoleSpy.mockRestore()
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
