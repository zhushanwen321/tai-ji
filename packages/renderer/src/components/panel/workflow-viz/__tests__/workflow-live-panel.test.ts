/**
 * WorkflowLivePanel 面板组件测试（workflow-visualization U5——三视角，TEST-STRATEGY §3）：
 *
 * - 构建者（白盒）：事件流数据经 mock RPC 注入 workflowStore 缓存分区；tab 模型经 expose
 *   与 DOM 事件直接驱动；store 挂载编排（活跃 run 登记 / 事件流首拉）断言 mock 调用
 * - 使用者（黑盒 DOM）：每条用例至少一个用户可见断言——header 去重形态（D2 单 header
 *   终态：三槽零渲染）、trace 行状态与空值回归（D5 盘点锚）、
 *   事件流行与 ✂ 截断标注、错误二分形态（静态指引 vs 重试按钮）、phase 头卡轮次、tab 关闭回落
 * - 观察者（形态）：data-testid 结构（wf-viz-* 树）与 data-status/data-active 属性
 *
 * mock 策略：
 * - api/domains/session mock（getWorkflowRunEvents / getWorkflows）+ @/api 门面回指
 *   （同 workflow.test.ts 先例——store 与断言用同一 vi.fn()）
 * - vue-i18n 文件内 override（t(key, named) → `key(k=v)`，key 引用 + 参数双断言面）
 * - MessageStream / useSubagentTabData mock（agent tab 对话流编排接线验证，渲染树 stub）
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/workflow-viz/__tests__/workflow-live-panel.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { h, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import WorkflowLivePanel from '../panel/WorkflowLivePanel.vue'
import { useWorkflowStore } from '@/stores/workflow'
import type { WorkflowAgentCall, WorkflowRunRecord } from '@taiji/shared'

// ── mock：RPC 域 + @/api 门面回指 ─────────────────────────────────────────────

vi.mock('@taiji/core/transport/api/domains/session', () => ({
  getWorkflows: vi.fn(),
  getWorkflowRunEvents: vi.fn(),
}))
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  const session = await import('@taiji/core/transport/api/domains/session')
  return { ...actual, session }
})
import * as sessionApi from '@taiji/core/transport/api/domains/session'
const mockGetRunEvents = vi.mocked(sessionApi.getWorkflowRunEvents)

// ── mock：i18n（t(key, named) → `key(k=v)`）───────────────────────────────────

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return {
    ...actual,
    useI18n: () => ({
      t: (key: string, named?: Record<string, unknown>) => {
        if (!named) return key
        const params = Object.entries(named)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(',')
        return `${key}(${params})`
      },
      locale: { value: 'zh-CN' },
    }),
  }
})

// ── mock：agent tab 对话流渲染树（MessageStream stub + 编排接线 spy）────────────

const loadSubagentDataMock = vi.fn().mockResolvedValue(undefined)
// loadError 用模块级可控 ref（agent tab 错误态用例注入失败值；useSubagentTabData 实装
// 的 loadSubagentData 开头置空语义由用例内手动复位模拟）
const loadErrorRef = ref<string | null>(null)
vi.mock('@/composables/panel/useSubagentTabData', () => ({
  useSubagentTabData: () => ({
    loadError: loadErrorRef,
    loadSubagentData: loadSubagentDataMock,
    stopSubagentStream: vi.fn(),
    recordEngine: vi.fn(() => 'pi'),
  }),
}))
vi.mock('@/components/panel/MessageStream.vue', () => ({
  default: {
    name: 'MessageStreamStub',
    props: ['sessionId'],
    setup(props: { sessionId: string }) {
      return () => h('div', { 'data-testid': 'message-stream-stub' }, props.sessionId)
    },
  },
}))

// ── 测试数据 ──────────────────────────────────────────────────────────────────

const SID = 's-panel'
const RUN_ID = 'wf-panel-1'

function makeCall(overrides: Partial<WorkflowAgentCall> & { id: number }): WorkflowAgentCall {
  return {
    agent: `worker-${overrides.id}`,
    phase: 'alpha',
    status: 'done',
    startedAt: '2026-10-02T02:00:00Z',
    durationMs: 1200,
    inputTokens: 100,
    outputTokens: 200,
    sessionId: `acs-${overrides.id}`,
    ...overrides,
  }
}

function makeRun(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    runId: RUN_ID,
    scriptName: 'panel-flow',
    status: 'done',
    reason: 'completed',
    outcome: 'done',
    startedAt: '2026-10-02T02:00:00Z',
    completedAt: '2026-10-02T02:00:30Z',
    argsSummary: '{"task":"demo"}',
    stateFilePath: '/tmp/record.jsonl',
    agentCalls: [
      makeCall({ id: 0, status: 'done' }),
      makeCall({ id: 1, status: 'failed', error: 'boom' }),
      makeCall({ id: 2, status: 'running', attempts: 2, phase: 'beta' }),
      makeCall({ id: 3, status: 'pending', sessionId: undefined }),
    ],
    ...overrides,
  }
}

/** 事件流样本（含 truncatedFields 标注行——D4 截断协议的展示面验证数据；beta = 纯脚本 phase） */
function eventsReply(): {
  runId: string
  events: Array<Record<string, unknown> & { type: string; ts: number }>
} {
  return {
    runId: RUN_ID,
    events: [
      { type: 'run-created', runId: RUN_ID, workflowName: 'panel-flow', argsSummary: '{"task":"demo"}', seq: 1, ts: 1000 },
      { type: 'phase-started', phase: 'alpha', seq: 2, ts: 1010 },
      {
        type: 'agent-started',
        taskIndex: 0,
        agentName: 'worker-0',
        attempt: 1,
        phase: 'alpha',
        input: '{"prompt":"..."}',
        truncatedFields: ['input'],
        seq: 3,
        ts: 1020,
      },
      { type: 'phase-settled', phase: 'alpha', seq: 4, ts: 1100 },
      { type: 'phase-started', phase: 'beta', seq: 5, ts: 1110 },
      { type: 'run-settled', outcome: 'done', reason: 'completed', artifactsDir: '/tmp/x', seq: 6, ts: 1200 },
    ],
  }
}

async function mountPanel(run = makeRun(), ganttComponent?: Parameters<typeof mount>[1]['props']) {
  const wrapper = mount(WorkflowLivePanel, {
    props: {
      sessionId: SID,
      run,
      ...(ganttComponent !== undefined ? { ganttComponent } : {}),
    },
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  loadSubagentDataMock.mockClear()
  loadErrorRef.value = null
  mockGetRunEvents.mockResolvedValue(eventsReply())
})

// ── header 去重（D2 单 header 终态：面板无 header 行，pill/elapsed/args 由壳 header
// 单点呈现——cancelled/failed pill 文案与停走时长语义迁壳层（overlay 测试）与派生单点
// 函数级测试（__tests__/stores/workflow.test.ts deriveWorkflowRunElapsedMs 全分支）承载）

describe('WorkflowLivePanel · header 去重（D2 单 header 终态）', () => {
  it('面板无 header 行：pill / 已用时长 / args 三槽零渲染，顶格从 L2TabBar 开始', async () => {
    const wrapper = await mountPanel()
    expect(wrapper.find('[data-testid="wf-viz-run-pill"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="wf-viz-run-elapsed"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="wf-viz-run-args"]').exists()).toBe(false)
    // 面板首子元素 = L2TabBar 包裹层（顶格，无 header 行占位）
    const first = wrapper.find('[data-testid="wf-viz-live-panel"]').element.children[0]
    expect(first.querySelector('[data-testid="wf-viz-tabbar"]')).not.toBeNull()
  })

  it('interrupted 暂停态：在途 trace 行叠加中性停止色且不旋转（D9 停止着色 + 静态图标）', async () => {
    // call #2 = 无重试记录的纯 running（attempts 缺省）——stoppedInFlight 与 retrying 派生无关的正交验证
    const wrapper = await mountPanel(makeRun({
      status: 'interrupted',
      reason: undefined,
      completedAt: undefined,
      agentCalls: [makeCall({ id: 2, status: 'running', attempts: undefined, phase: 'beta' })],
    }))
    // call #2 running → stoppedInFlight：状态文字 span 叠 text-neutral-mid；Loader2 静态（无 animate-spin）
    const status2 = wrapper.find('[data-testid="wf-viz-trace-status-2"]')
    expect(status2.attributes('data-status')).toBe('running')
    const label = status2.find('span.font-mono')
    expect(label.classes()).toContain('text-neutral-mid')
    const spinner = status2.find('svg')
    expect(spinner.exists()).toBe(true)
    expect(spinner.classes()).not.toContain('animate-spin')
  })
})

// ── workflow 固定 tab 三子页 ──────────────────────────────────────────────────

describe('WorkflowLivePanel · workflow tab 三子页（使用者黑盒 + 观察者形态）', () => {
  it('默认 workflow tab + trace 子页：实例行渲染，D9 派生 retrying 态可见（attempts 有值 running → retrying，首败重试窗口覆盖，非仅事后）', async () => {
    const wrapper = await mountPanel()
    // 固定 tab 标题 = scriptName；trace 表 4 行
    expect(wrapper.find('[data-testid="wf-viz-tabbar"]').text()).toContain('panel-flow')
    expect(wrapper.findAll('[data-testid^="wf-viz-trace-row-"]')).toHaveLength(4)
    // call #2：running + attempts=2 → retrying 派生态（重试窗口内可见，非仅事后）
    const status2 = wrapper.find('[data-testid="wf-viz-trace-status-2"]')
    expect(status2.attributes('data-status')).toBe('retrying')
    expect(status2.text()).toContain('panel.workflowViz.statusRetrying')
    // call #1 failed：错误摘要列可见
    expect(wrapper.find('[data-testid="wf-viz-trace-row-1"]').text()).toContain('boom')
    // token 单列总量（100+200=300）
    expect(wrapper.find('[data-testid="wf-viz-trace-row-0"]').text()).toContain('300')
  })

  it('trace 表空值回归（D5 盘点锚）：语义空列统一 —（phase/duration/tokens/error），无空串或 undefined 泄漏', async () => {
    // pending call：phase 缺省 + 无 duration/tokens/error（startedAt 有值显示时间）——
    // 5 处 — 空值槽中本行可呈现的 4 处逐一锁定（startedAt 缺省形态由 formatTime 分支
    // 覆盖，attempt/状态/agent/# 恒有值无空形态）
    const wrapper = await mountPanel(makeRun({
      agentCalls: [makeCall({
        id: 9,
        status: 'pending',
        sessionId: undefined,
        phase: undefined,
        durationMs: undefined,
        inputTokens: undefined,
        outputTokens: undefined,
        error: undefined,
      })],
    }))
    const row = wrapper.find('[data-testid="wf-viz-trace-row-9"]')
    expect(row.text()).toContain('—')
    expect(row.text()).not.toContain('undefined')
    const cells = row.findAll('span')
    const dashCells = cells.filter((c) => c.text() === '—')
    expect(dashCells.length).toBe(4)
  })

  it('pending / sessionId 缺失行点击不开 agent tab（对齐 WorkflowTab 现状 no-op）', async () => {
    const wrapper = await mountPanel()
    await wrapper.find('[data-testid="wf-viz-trace-row-3"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-testid="l2-tab-agent\\:3"]')).toHaveLength(0) // 无 agent tab
  })

  it('事件流子页：行渲染 + ✂ truncatedFields 标注（D4 截断协议展示面）', async () => {
    const wrapper = await mountPanel()
    await wrapper.find('[data-testid="wf-viz-subpage-events"]').trigger('click')
    await flushPromises()
    const list = wrapper.find('[data-testid="wf-viz-events-list"]')
    // 事件行 testid = wf-viz-event-<type>；前缀选择器排除 ✂ 标注徽标（wf-viz-event-truncated）
    const rows = list.findAll('[data-testid^="wf-viz-event-"]').filter(
      (r) => r.attributes('data-testid') !== 'wf-viz-event-truncated',
    )
    expect(rows.length).toBe(6)
    // 截断标注行：agent-started 的 input 被截断
    const truncated = list.findAll('[data-testid="wf-viz-event-truncated"]')
    expect(truncated).toHaveLength(1)
    expect(truncated[0].text()).toContain('input')
    // i18n mock 下 title = key(named) 形态——断言 key 引用 + named 参数双到位
    expect(truncated[0].attributes('title')).toBe('panel.workflowViz.truncatedHint(fields=input)')
  })

  it('事件流错误二分：record_not_found → 静态指引无重试按钮', async () => {
    mockGetRunEvents.mockResolvedValue({ runId: RUN_ID, code: 'record_not_found', message: '无记录' })
    const wrapper = await mountPanel()
    await wrapper.find('[data-testid="wf-viz-subpage-events"]').trigger('click')
    await flushPromises()
    const err = wrapper.find('[data-testid="wf-viz-events-error"]')
    expect(err.text()).toContain('panel.workflowViz.eventsNotFound')
    expect(err.find('[data-testid="wf-viz-events-retry"]').exists()).toBe(false) // 静态指引无重试
  })

  it('事件流错误二分：通道错误 → 错误 + 重试按钮；点重试 force 重拉', async () => {
    mockGetRunEvents.mockRejectedValueOnce(new Error('transport down'))
    const wrapper = await mountPanel()
    await wrapper.find('[data-testid="wf-viz-subpage-events"]').trigger('click')
    await flushPromises()
    const err = wrapper.find('[data-testid="wf-viz-events-error"]')
    expect(err.text()).toContain('transport down')
    const retryBtn = err.find('[data-testid="wf-viz-events-retry"]')
    expect(retryBtn.exists()).toBe(true)
    mockGetRunEvents.mockResolvedValue(eventsReply())
    await retryBtn.trigger('click')
    await flushPromises()
    expect(mockGetRunEvents).toHaveBeenCalledTimes(2)
    // 重拉成功后错误态消失、事件列表出现（恢复路径闭环）
    expect(wrapper.find('[data-testid="wf-viz-events-list"]').exists()).toBe(true)
  })

  it('Gantt 子页（未注入展示组件）：分段统计降级形态渲染派生结果', async () => {
    const wrapper = await mountPanel()
    await wrapper.find('[data-testid="wf-viz-subpage-gantt"]').trigger('click')
    await flushPromises()
    const summary = wrapper.find('[data-testid="wf-viz-gantt-segments-summary"]')
    expect(summary.exists()).toBe(true)
    // 派生结果可见：phaseCards 两行（alpha/beta 轮次）
    expect(summary.text()).toContain('alpha:')
    expect(summary.text()).toContain('beta:')
  })

  it('Gantt 子页（注入展示组件）：props 注入 segments + 游标接线 runStatus/runOutcome/nowMs（面板不反向 import u4 的分界验证）', async () => {
    let received: Record<string, unknown> = {}
    const GanttStub = {
      name: 'GanttStub',
      props: ['segments', 'runStatus', 'runOutcome', 'nowMs', 'callLabels'],
      setup(props: Record<string, unknown>) {
        return () => {
          received = props
          return h('div', { 'data-testid': 'gantt-stub' }, 'gantt')
        }
      },
    }
    // 运行中 run：游标三接线全透传（nowMs 激活即赋值，不等首个 1s tick）
    const wrapper = await mountPanel(makeRun({ status: 'running', outcome: undefined, completedAt: undefined }), GanttStub)
    await wrapper.find('[data-testid="wf-viz-subpage-gantt"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="gantt-stub"]').exists()).toBe(true)
    // 注入组件收到派生分段（WorkflowGanttSegments 形态）
    const segments = received.segments as { attemptSegments: unknown[]; phaseBands: unknown[]; phaseCards: unknown[] }
    expect(Array.isArray(segments.attemptSegments)).toBe(true)
    expect(segments.phaseCards.length).toBe(2) // alpha + beta
    // 游标接线（D9）：runStatus/runOutcome 透传 + nowMs 已有值
    expect(received.runStatus).toBe('running')
    expect(received.runOutcome).toBeUndefined()
    expect(typeof received.nowMs).toBe('number')
    // 行标签接线：事件流 agent-started 帧的 taskIndex → agentName 映射（行标签 #N 退化消除）
    expect(received.callLabels).toEqual({ 0: 'worker-0' })
  })

  it('Gantt 子页游标 tick 仅运行中活跃：停止 run 不启 tick（nowMs 不注入，冻结游标由 runStatus 驱动）', async () => {
    let received: Record<string, unknown> = {}
    const GanttStub = {
      name: 'GanttStub',
      props: ['segments', 'runStatus', 'runOutcome', 'nowMs', 'callLabels'],
      setup(props: Record<string, unknown>) {
        return () => {
          received = props
          return h('div', { 'data-testid': 'gantt-stub' }, 'gantt')
        }
      },
    }
    const wrapper = await mountPanel(makeRun(), GanttStub)
    await wrapper.find('[data-testid="wf-viz-subpage-gantt"]').trigger('click')
    await flushPromises()
    expect(received.runStatus).toBe('done')
    expect(received.runOutcome).toBe('done')
    expect(received.nowMs).toBeUndefined()
  })
})

// ── 多级 tab（phase / agent 钻取 + 关闭回落）────────────────────────────────

describe('WorkflowLivePanel · 多级 tab（使用者黑盒）', () => {
  it('expose openPhaseTab：phase tab 头卡渲染（轮次/起止/状态）+ phase 内 trace 过滤 + phase 事件过滤', async () => {
    const wrapper = await mountPanel()
    ;(wrapper.vm as unknown as { openPhaseTab: (p: string) => void }).openPhaseTab('alpha')
    await flushPromises()
    const tab = wrapper.find('[data-testid="wf-viz-phase-tab"]')
    expect(tab.exists()).toBe(true)
    // 头卡：轮次计数（事件流里 alpha 一个非空段——run-created/agent 帧在区间内）
    expect(tab.find('[data-testid="wf-viz-phase-card-turns"]').text()).toContain('panel.workflowViz.turnCount')
    // phase 内 trace 过滤：alpha 归属 2 行（call 0/1；call 2 是 beta、call 3 是 alpha pending）
    expect(tab.findAll('[data-testid^="wf-viz-trace-row-"]').length).toBe(3)
    // phase 事件过滤：仅 alpha 归属（phase-started/settled + agent 帧）；run 级与跨 phase 不进
    const events = tab.find('[data-testid="wf-viz-phase-events"]')
    expect(events.text()).not.toContain('run-settled')
    expect(events.text()).not.toContain('run-created')
  })

  it('trace 行点击开 agent tab：对话流编排被调 + MessageStream 挂载 agentcall 虚拟 id', async () => {
    const wrapper = await mountPanel()
    await wrapper.find('[data-testid="wf-viz-trace-row-0"]').trigger('click')
    await flushPromises()
    // agent tab 出现（agentcall:acs-0 分区）
    const stream = wrapper.find('[data-testid="message-stream-stub"]')
    expect(stream.exists()).toBe(true)
    expect(stream.text()).toBe('agentcall:acs-0')
    // 快照编排接线（useSubagentTabData.loadSubagentData 复用，零新拉取链）
    expect(loadSubagentDataMock).toHaveBeenCalledWith('agentcall:acs-0')
    // trace 详情元信息条渲染
    expect(wrapper.find('[data-testid="wf-viz-agent-meta"]').text()).toContain('worker-0')
  })

  it('workflowUpdate 信号（命中活跃 run）→ agent tab 快照重拉（§3.1-2/D8 信号刷新链）', async () => {
    const wrapper = await mountPanel()
    await wrapper.find('[data-testid="wf-viz-trace-row-0"]').trigger('click')
    await flushPromises()
    loadSubagentDataMock.mockClear()
    // 面板挂载已登记活跃锚（setActiveWorkflowRun）——信号经 store 聚合触发纪元自增
    const store = useWorkflowStore()
    store.triggerWorkflowReload(SID, 'running')
    await flushPromises()
    expect(loadSubagentDataMock).toHaveBeenCalledWith('agentcall:acs-0')
    // 非活跃 session 的信号不触发重拉（纪元不自增）
    loadSubagentDataMock.mockClear()
    store.triggerWorkflowReload('other-session', 'running')
    await flushPromises()
    expect(loadSubagentDataMock).not.toHaveBeenCalled()
  })

  it('agent tab 快照拉取失败：错误态 + 重试按钮；点重试重调快照编排（§3.1-2 同一错误态语言）', async () => {
    const wrapper = await mountPanel()
    await wrapper.find('[data-testid="wf-viz-trace-row-0"]').trigger('click')
    await flushPromises()
    // 失败形态：错误态显示错误信息 + 重试按钮（恢复动作与事件流子页错误态语言一致）
    loadErrorRef.value = 'rpc down'
    await flushPromises()
    const err = wrapper.find('[data-testid="wf-viz-agent-error"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('rpc down')
    const retryBtn = err.find('[data-testid="wf-viz-agent-retry"]')
    expect(retryBtn.exists()).toBe(true)
    // 点重试 → 重调快照拉取编排（实装 loadSubagentData 开头同步置空 loadError → 错误块
    // 分支切走按钮消失，构造性防重复点击；mock 无副作用由用例手动复位模拟该语义）
    loadSubagentDataMock.mockClear()
    await retryBtn.trigger('click')
    expect(loadSubagentDataMock).toHaveBeenCalledWith('agentcall:acs-0')
    loadErrorRef.value = null
    await flushPromises()
    expect(wrapper.find('[data-testid="wf-viz-agent-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="message-stream-stub"]').exists()).toBe(true)
  })

  it('tab 关闭激活左侧相邻；关闭首个动态 tab 回 workflow 固定 tab（L2TabBar close 事件链）', async () => {
    const wrapper = await mountPanel()
    const vm = wrapper.vm as unknown as { openPhaseTab: (p: string) => void }
    vm.openPhaseTab('alpha')
    vm.openPhaseTab('beta')
    await flushPromises()
    expect(wrapper.find('[data-testid="l2-tab-phase\\:beta"]').attributes('data-active')).toBe('true')
    // 关 beta（激活态）→ 激活左侧 alpha
    await wrapper.find('[data-testid="l2-tab-close-phase\\:beta"]').trigger('click')
    expect(wrapper.find('[data-testid="l2-tab-phase\\:alpha"]').attributes('data-active')).toBe('true')
    // 关 alpha（激活态、首个动态）→ 回 workflow 固定 tab（workflow 内容可见）
    await wrapper.find('[data-testid="l2-tab-close-phase\\:alpha"]').trigger('click')
    expect(wrapper.find('[data-testid="l2-tab-workflow"]').attributes('data-active')).toBe('true')
    expect(wrapper.find('[data-testid="wf-viz-subpage-switch"]').exists()).toBe(true)
  })
})

// ── store 挂载编排（构建者白盒）──────────────────────────────────────────────

describe('WorkflowLivePanel · store 挂载编排（构建者白盒）', () => {
  it('挂载：活跃 run 登记 + 事件流首拉；卸载：条件释放活跃锚', async () => {
    const store = useWorkflowStore()
    const wrapper = await mountPanel()
    expect(mockGetRunEvents).toHaveBeenCalledWith(SID, RUN_ID)
    expect(store.runEventsOf(RUN_ID)?.status).toBe('ready')
    wrapper.unmount()
    // 条件释放后缓存保留（D11② overlay 关闭不清——重开秒显）
    expect(store.runEventsOf(RUN_ID)?.status).toBe('ready')
  })

  it('props.run.runId 变化（防御性重置）：tab 回固定 tab + 事件流换 run 拉取', async () => {
    const wrapper = await mountPanel()
    ;(wrapper.vm as unknown as { openPhaseTab: (p: string) => void }).openPhaseTab('alpha')
    await flushPromises()
    mockGetRunEvents.mockClear()
    mockGetRunEvents.mockResolvedValue({ runId: 'wf-2', events: [] })
    await wrapper.setProps({ run: makeRun({ runId: 'wf-2' }) })
    await flushPromises()
    // tab 重置回 workflow 固定 tab（D11③ 切换 run 语义）
    expect(wrapper.find('[data-testid="l2-tab-workflow"]').attributes('data-active')).toBe('true')
    expect(wrapper.find('[data-testid="l2-tab-phase\\:alpha"]').exists()).toBe(false)
    // 事件流换 run 拉取
    expect(mockGetRunEvents).toHaveBeenCalledWith(SID, 'wf-2')
  })
})
