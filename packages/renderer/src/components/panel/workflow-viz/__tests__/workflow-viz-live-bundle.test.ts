/**
 * workflow-viz live 域合并产物（round 6 renderer 测试压缩）：两文件同产物。
 *
 * 并入来源（基名）：
 *  - workflow-live-panel（live 面板 tab 编排 + 事件流，45 例；本文件即 round5 合并产物，
 *    节内 beforeEach 默认值下沉结构保持）
 *  - agent-stream-drawer（agent 流 drawer 接线，10 例）
 *
 * mock 注册与互斥核查（两源同构族，vue-i18n / MessageStream.vue / session domain /
 * '@/api' 四工厂逐字相同；useSubagentTabData 统一为两源成员并集——drawer 的
 * inline stopSubagentStream 换 live-panel 的 stopSubagentStreamMock 单源，drawer 节
 * 无停流断言、不受影响；loadSubagentDataMock / loadErrorRef 共享实例，两节
 * beforeEach 各自 clearAllMocks + 复位，跨节无泄漏）：
 *  - session domain：getWorkflows / getWorkflowRunEvents（两源逐字相同）
 *  - '@/api'：importActual spread + session 指回 domain mock（两源逐字相同）
 *  - vue-i18n：t(key, named) → `key(k=v)`（两源逐字相同）
 *  - MessageStream.vue：marker stub（两源逐字相同）
 *
 * 运行：cd packages/renderer && TAIJI_TEST_DOMAIN=subagent TAIJI_SKIP_REAL_PI=1 npx vitest run src/components/panel/workflow-viz/__tests__/workflow-viz-live-bundle.test.ts（本文件登记在 domain-map.json subagent 域，默认档被排除）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { h, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import WorkflowLivePanel from '../panel/WorkflowLivePanel.vue'
import AgentStreamDrawer from '../panel/AgentStreamDrawer.vue'
import { openShieldingSurfaces, resetModalSurfaceRegistry } from '@/composables/features/app/modal-surface-registry/registry'
import { useWorkflowStore } from '@/stores/workflow'
import { WORKFLOW_FIXED_TAB_KEY, closeLiveTab, openLiveTab, phaseTabKey } from '../panel/panel-tabs'
import type { WorkflowLiveTab } from '../panel/panel-tabs'
import type { WorkflowAgentCall, WorkflowRunRecord } from '@taiji/shared'

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

// ── mock：agent tab 对话流渲染树（MessageStream stub + 编排接线 spy；两源共享实例）──
const loadSubagentDataMock = vi.fn().mockResolvedValue(undefined)
const loadErrorRef = ref<string | null>(null)
const stopSubagentStreamMock = vi.fn()

vi.mock('@/composables/panel/useSubagentTabData', () => ({
  useSubagentTabData: () => ({
    loadError: loadErrorRef,
    loadSubagentData: loadSubagentDataMock,
    stopSubagentStream: stopSubagentStreamMock,
    recordEngine: vi.fn(() => 'pi'),
  }),
}))

vi.mock('@/components/panel/MessageStream.vue', () => ({
  default: {
    name: 'MessageStreamStub',
    props: ['sessionId', 'mainSessionId'],
    setup(props: { sessionId: string; mainSessionId?: string }) {
      return () =>
        h(
          'div',
          { 'data-testid': 'message-stream-stub', 'data-main-sid': props.mainSessionId ?? '' },
          props.sessionId,
        )
    },
  },
}))

// ═══════════ 来源节：workflow-live-panel ═══════════

describe('workflow-live-panel', () => {
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
    memberRecordId: `rec-${overrides.id}`,
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

/** 事件流样本（含 truncatedFields 标注行——D4 截断协议的展示侧验证数据；beta = 纯脚本 phase） */
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
      {
        type: 'worker-log',
        entry: { level: 'warn', message: '诊断行截断前缀…' },
        truncatedFields: ['entryMessage'],
        seq: 6,
        ts: 1150,
      },
      { type: 'run-settled', outcome: 'done', reason: 'completed', artifactsDir: '/tmp/x', seq: 7, ts: 1200 },
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

  it('cancelled 行（§3.3.8 run 终局收尾在途成员）：trace 表渲染中性档状态词，不再折进 failed', async () => {
    const wrapper = await mountPanel(makeRun({
      agentCalls: [makeCall({ id: 4, status: 'cancelled' })],
    }))
    const status4 = wrapper.find('[data-testid="wf-viz-trace-status-4"]')
    expect(status4.attributes('data-status')).toBe('cancelled')
    expect(status4.text()).toContain('panel.workflowViz.statusCancelled')
    // 状态点着色 = 中性灰（与 pending 同灰系，非失败红）
    const dot = status4.find('span.rounded-full')
    expect(dot.classes()).toContain('bg-neutral-dim')
  })

  it('partially_succeeded run：在途行渲染中性停止色、不抛错（run 级聚合 outcome 不是 call 级失败形态；成员行无 settled 帧投影保持 running 可达此输入）', async () => {
    // run 终局部分成功 + 成员行在途（closeOutInFlightCalls 只写内存不落帧 → 投影保持 running）
    const wrapper = await mountPanel(makeRun({
      outcome: 'partially_succeeded',
      reason: 'partially_succeeded',
      agentCalls: [makeCall({ id: 2, status: 'running', attempts: undefined, phase: 'beta' })],
    }))
    // 修复前 rows computed 对 partially_succeeded 抛错、trace 表整体不可渲染
    //（根 testid 在本组合被父层同名透传属性覆盖为 wf-viz-subpage-trace-panel，锚后者）
    expect(wrapper.find('[data-testid="wf-viz-subpage-trace-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wf-viz-trace-row-2"]').exists()).toBe(true)
    const status2 = wrapper.find('[data-testid="wf-viz-trace-status-2"]')
    expect(status2.attributes('data-status')).toBe('running')
    const label = status2.find('span.font-mono')
    expect(label.classes()).toContain('text-neutral-mid')
    expect(label.classes()).not.toContain('text-danger')
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

  it('事件流子页：行渲染 + ✂ truncatedFields 标注（D4 截断协议展示面，含 worker-log entryMessage 行）', async () => {
    const wrapper = await mountPanel()
    await wrapper.find('[data-testid="wf-viz-subpage-events"]').trigger('click')
    await flushPromises()
    const list = wrapper.find('[data-testid="wf-viz-events-list"]')
    // 事件行 testid = wf-viz-event-<type>；前缀选择器排除 ✂ 标注徽标（wf-viz-event-truncated）
    const rows = list.findAll('[data-testid^="wf-viz-event-"]').filter(
      (r) => r.attributes('data-testid') !== 'wf-viz-event-truncated',
    )
    expect(rows.length).toBe(7)
    // worker-log 行渲染：截断后的 message 走 summary 行（不进 detail 区）
    const workerLogRow = list.find('[data-testid="wf-viz-event-worker-log"]')
    expect(workerLogRow.exists()).toBe(true)
    expect(workerLogRow.text()).toContain('诊断行截断前缀…')
    // 截断标注行：agent-started 的 input + worker-log 的 entryMessage
    const truncated = list.findAll('[data-testid="wf-viz-event-truncated"]')
    expect(truncated).toHaveLength(2)
    expect(truncated[0].text()).toContain('input')
    expect(truncated[1].text()).toContain('entryMessage')
    // i18n mock 下 title = key(named) 形态——断言 key 引用 + named 参数双到位
    expect(truncated[0].attributes('title')).toBe('panel.workflowViz.truncatedHint(fields=input)')
    expect(truncated[1].attributes('title')).toBe('panel.workflowViz.truncatedHint(fields=entryMessage)')
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

  it('事件流错误二分：通道错误 → 错误 + 重试按钮；点重试 force 重新拉取', async () => {
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
    // 重新拉取成功后错误态消失、事件列表出现（恢复路径闭环）
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

// ── 多级 tab（phase 钻取 + 关闭回落；agent 钻取已收归 AgentStreamDrawer）──────

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

  it('trace 行点击 → openAgent 事件上抛（[2026-10-19] agent 详情归宿 = 宿主接 AgentStreamDrawer，面板不再内嵌 agent tab）', async () => {
    const wrapper = await mountPanel()
    await wrapper.find('[data-testid="wf-viz-trace-row-0"]').trigger('click')
    await flushPromises()
    const emitted = wrapper.emitted('openAgent')
    expect(emitted).toHaveLength(1)
    expect((emitted?.[0]?.[0] as WorkflowAgentCall).id).toBe(0)
    // 面板内不再出现 agent 对话流（dock 无 agent tab）
    expect(wrapper.find('[data-testid="message-stream-stub"]').exists()).toBe(false)
  })

  it('pending 行点击 no-op：不上抛 openAgent（对齐 RunTraceTable 行点击守卫现状）', async () => {
    const wrapper = await mountPanel()
    await wrapper.find('[data-testid="wf-viz-trace-row-3"]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('openAgent')).toBeUndefined()
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
  it('挂载：活跃 run 登记 + 事件流首次拉取；卸载：条件释放活跃锚', async () => {
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


// ══════════ 来源：workflow-store-run-events.test.ts（D11 生命周期五条；session 域与
//             @/api mock 共享主体注册，STORE_SID/storeEventsReply 为按节重命名，
//             默认值 hook 已下沉各 describe） ══════════

// （session 域 mock / @/api 门面回指 mock / mockGetRunEvents 声明与主体逐字同构，已去重共享）

const STORE_SID = 's-main'
const RUN_A = 'wf-run-a'
const RUN_B = 'wf-run-b'

/** 事件流 reply 样本（骨架两行形态；截断标注语义归 gantt-segments 测试） */
function storeEventsReply(runId: string): { runId: string; events: Array<{ type: string; ts: number }> } {
  return {
    runId,
    events: [
      { type: 'run-created', ts: 1000 },
      { type: 'run-settled', ts: 2000 },
    ],
  }
}

describe('workflowStore 事件流缓存：拉取与缓存复用', () => {
  // 节内默认值（原文件顶层 beforeEach 下沉：覆盖主体的七行 events 形态为本节两行形态）
  beforeEach(() => {
    mockGetRunEvents.mockResolvedValue(storeEventsReply(RUN_A))
  })


  it('成功拉取写入 runId 分区（ready + events），缓存条目携带归属 session', async () => {
    const store = useWorkflowStore()
    store.setActiveWorkflowRun(STORE_SID, RUN_A)
    await store.loadWorkflowRunEvents(STORE_SID, RUN_A)
    const entry = store.runEventsOf(RUN_A)
    expect(entry?.status).toBe('ready')
    expect(entry?.sessionId).toBe(STORE_SID)
    expect(entry?.events).toHaveLength(2)
    expect(mockGetRunEvents).toHaveBeenCalledWith(STORE_SID, RUN_A)
  })

  it('ready 缓存复用：非 force 重复调用不重发 RPC（D11② 重开秒显）', async () => {
    const store = useWorkflowStore()
    store.setActiveWorkflowRun(STORE_SID, RUN_A)
    await store.loadWorkflowRunEvents(STORE_SID, RUN_A)
    await store.loadWorkflowRunEvents(STORE_SID, RUN_A)
    expect(mockGetRunEvents).toHaveBeenCalledTimes(1)
  })

  it('force 覆盖 ready 缓存重新拉取（workflowUpdate 信号 / 重试按钮语义）', async () => {
    const store = useWorkflowStore()
    store.setActiveWorkflowRun(STORE_SID, RUN_A)
    await store.loadWorkflowRunEvents(STORE_SID, RUN_A)
    await store.loadWorkflowRunEvents(STORE_SID, RUN_A, { force: true })
    expect(mockGetRunEvents).toHaveBeenCalledTimes(2)
  })

  it('loading 在途合并：在途期间的重复调用不另起 RPC', async () => {
    const store = useWorkflowStore()
    store.setActiveWorkflowRun(STORE_SID, RUN_A)
    let resolveRpc!: (v: unknown) => void
    mockGetRunEvents.mockReturnValueOnce(new Promise((resolve) => (resolveRpc = resolve)))
    const first = store.loadWorkflowRunEvents(STORE_SID, RUN_A)
    const second = store.loadWorkflowRunEvents(STORE_SID, RUN_A)
    expect(mockGetRunEvents).toHaveBeenCalledTimes(1)
    resolveRpc(storeEventsReply(RUN_A))
    await Promise.all([first, second])
    expect(store.runEventsOf(RUN_A)?.status).toBe('ready')
  })

  it('force 调用在途窗口内到达：并入在途拉取不另起 RPC（去重由 runEventsInflight 承载，缓存条目三态不兼任）', async () => {
    const store = useWorkflowStore()
    store.setActiveWorkflowRun(STORE_SID, RUN_A)
    let resolveRpc!: (v: unknown) => void
    mockGetRunEvents.mockReturnValueOnce(new Promise((resolve) => (resolveRpc = resolve)))
    const first = store.loadWorkflowRunEvents(STORE_SID, RUN_A)
    // 信号触发的 force 重新拉取在首次拉取在途窗口到达——同 runId 仅首次发起，复用者共享 promise
    const forced = store.loadWorkflowRunEvents(STORE_SID, RUN_A, { force: true })
    expect(mockGetRunEvents).toHaveBeenCalledTimes(1)
    resolveRpc(storeEventsReply(RUN_A))
    await Promise.all([first, forced])
    expect(store.runEventsOf(RUN_A)?.status).toBe('ready')
  })

  it('空 sid / runId 检查：不发起 RPC 不写分区', async () => {
    const store = useWorkflowStore()
    await store.loadWorkflowRunEvents('', RUN_A)
    await store.loadWorkflowRunEvents(STORE_SID, '')
    expect(mockGetRunEvents).not.toHaveBeenCalled()
    expect(store.runEventsOf(RUN_A)).toBeUndefined()
  })
})

describe('workflowStore 事件流缓存：错误二分数据形态', () => {
  // 节内默认值（原文件顶层 beforeEach 下沉：覆盖主体的七行 events 形态为本节两行形态）
  beforeEach(() => {
    mockGetRunEvents.mockResolvedValue(storeEventsReply(RUN_A))
  })


  it('record_not_found 结构化回执 → status error + errorCode（静态指引数据源）', async () => {
    mockGetRunEvents.mockResolvedValue({ runId: RUN_A, code: 'record_not_found', message: '无记录' })
    const store = useWorkflowStore()
    store.setActiveWorkflowRun(STORE_SID, RUN_A)
    await store.loadWorkflowRunEvents(STORE_SID, RUN_A)
    expect(store.runEventsOf(RUN_A)).toMatchObject({ status: 'error', errorCode: 'record_not_found' })
  })

  it('RPC 通道错误（reject）→ status error + errorMessage（重试按钮数据源）', async () => {
    mockGetRunEvents.mockRejectedValue(new Error('transport down'))
    const store = useWorkflowStore()
    store.setActiveWorkflowRun(STORE_SID, RUN_A)
    await store.loadWorkflowRunEvents(STORE_SID, RUN_A)
    expect(store.runEventsOf(RUN_A)).toMatchObject({ status: 'error', errorMessage: 'transport down' })
    expect(store.runEventsOf(RUN_A)?.errorCode).toBeUndefined()
  })

  it('oversize 降级（成功臂 + oversize 标志）→ status ready + events 恒空 + oversize=true（「不可用 ≠ 无数据」分形透传）', async () => {
    mockGetRunEvents.mockResolvedValue({ runId: RUN_A, events: [], oversize: true })
    const store = useWorkflowStore()
    store.setActiveWorkflowRun(STORE_SID, RUN_A)
    await store.loadWorkflowRunEvents(STORE_SID, RUN_A)
    expect(store.runEventsOf(RUN_A)).toMatchObject({ status: 'ready', events: [], oversize: true })
  })

  it('error 态非 force 不自动重新拉取（重试 = 用户显式 force）', async () => {
    mockGetRunEvents.mockResolvedValue({ runId: RUN_A, code: 'record_not_found', message: '无记录' })
    const store = useWorkflowStore()
    store.setActiveWorkflowRun(STORE_SID, RUN_A)
    await store.loadWorkflowRunEvents(STORE_SID, RUN_A)
    await store.loadWorkflowRunEvents(STORE_SID, RUN_A)
    expect(mockGetRunEvents).toHaveBeenCalledTimes(1)
  })
})

describe('workflowStore 事件流缓存：D11① 在途丢弃检查', () => {
  // 节内默认值（原文件顶层 beforeEach 下沉：覆盖主体的七行 events 形态为本节两行形态）
  beforeEach(() => {
    mockGetRunEvents.mockResolvedValue(storeEventsReply(RUN_A))
  })


  it('settle 时活跃锚已切走（切换 run）→ 结果丢弃、loading 占位撤除（防幻影 loading）', async () => {
    const store = useWorkflowStore()
    store.setActiveWorkflowRun(STORE_SID, RUN_A)
    let resolveRpc!: (v: unknown) => void
    mockGetRunEvents.mockReturnValueOnce(new Promise((resolve) => (resolveRpc = resolve)))
    const pending = store.loadWorkflowRunEvents(STORE_SID, RUN_A)
    // overlay 切换到 run B
    store.setActiveWorkflowRun(STORE_SID, RUN_B)
    resolveRpc(storeEventsReply(RUN_A))
    await pending
    // 丢弃 = loading 占位一并撤除——残留 loading 会被后续调用的在途合并误判为在途而
    // no-op（重开该 run 永远加载中的幻影 loading）
    expect(store.runEventsOf(RUN_A)).toBeUndefined()
    // 丢弃后重开（活跃锚切回）可正常重新拉取写入
    store.setActiveWorkflowRun(STORE_SID, RUN_A)
    await store.loadWorkflowRunEvents(STORE_SID, RUN_A)
    expect(store.runEventsOf(RUN_A)?.status).toBe('ready')
    expect(mockGetRunEvents).toHaveBeenCalledTimes(2)
  })

  it('settle 时活跃锚已清（overlay 关闭）→ 结果丢弃不写缓存', async () => {
    const store = useWorkflowStore()
    store.setActiveWorkflowRun(STORE_SID, RUN_A)
    let rejectRpc!: (e: Error) => void
    mockGetRunEvents.mockReturnValueOnce(new Promise((_, reject) => (rejectRpc = reject)))
    const pending = store.loadWorkflowRunEvents(STORE_SID, RUN_A)
    store.releaseActiveWorkflowRun(STORE_SID, RUN_A)
    rejectRpc(new Error('late failure'))
    await pending
    expect(store.runEventsOf(RUN_A)).toBeUndefined() // 丢弃 = 条目不出现（loading 占位撤除）
  })
})

describe('workflowStore 事件流缓存：D11② LRU 与关闭不清', () => {
  // 节内默认值（原文件顶层 beforeEach 下沉：覆盖主体的七行 events 形态为本节两行形态）
  beforeEach(() => {
    mockGetRunEvents.mockResolvedValue(storeEventsReply(RUN_A))
  })


  it('overlay 关闭（活跃锚清）后缓存保留——重开秒显', async () => {
    const store = useWorkflowStore()
    store.setActiveWorkflowRun(STORE_SID, RUN_A)
    await store.loadWorkflowRunEvents(STORE_SID, RUN_A)
    store.releaseActiveWorkflowRun(STORE_SID, RUN_A)
    expect(store.runEventsOf(RUN_A)?.status).toBe('ready')
  })

  it('releaseActiveWorkflowRun 条件释放：锚已切走时不误清新 run 的锚', async () => {
    const store = useWorkflowStore()
    store.setActiveWorkflowRun(STORE_SID, RUN_A)
    store.setActiveWorkflowRun(STORE_SID, RUN_B) // 切换（新面板登记）
    store.releaseActiveWorkflowRun(STORE_SID, RUN_A) // 旧面板晚到的卸载清理
    // 锚未被误清：后续 loadWorkflowRunEvents 丢弃检查仍以 RUN_B 为活跃
    let resolveRpc!: (v: unknown) => void
    mockGetRunEvents.mockReturnValueOnce(new Promise((resolve) => (resolveRpc = resolve)))
    const pending = store.loadWorkflowRunEvents(STORE_SID, RUN_B)
    resolveRpc(storeEventsReply(RUN_B))
    await pending
    expect(store.runEventsOf(RUN_B)?.status).toBe('ready') // 锚在 → 结果未被丢弃
  })

  it('LRU 上界 5：写入第 6 个 run 驱逐最旧非活跃者', async () => {
    const store = useWorkflowStore()
    // 模拟真实打开路径：逐个切换活跃 run 后拉取（非活跃 run 的拉取结果被 D11① 丢弃，
    // 不入缓存——LRU 填充只发生在「曾打开」的 run 上）
    const runIds = ['wf-1', 'wf-2', 'wf-3', 'wf-4', 'wf-5', 'wf-6']
    for (const runId of runIds) {
      mockGetRunEvents.mockResolvedValue(storeEventsReply(runId))
      store.setActiveWorkflowRun(STORE_SID, runId)
      await store.loadWorkflowRunEvents(STORE_SID, runId)
    }
    // 6 个 run 全 ready → 超界，最旧（wf-1）被驱逐
    expect(store.runEventsOf('wf-1')).toBeUndefined()
    expect(store.runEventsOf('wf-2')?.status).toBe('ready')
    expect(store.runEventsOf('wf-6')?.status).toBe('ready')
  })

  it('LRU 驱逐豁免活跃 run（正在显示的 run 不被驱逐）', async () => {
    const store = useWorkflowStore()
    // 填满 5 个（逐个切换活跃锚）
    for (const runId of ['wf-1', 'wf-2', 'wf-3', 'wf-4', 'wf-5']) {
      mockGetRunEvents.mockResolvedValue(storeEventsReply(runId))
      store.setActiveWorkflowRun(STORE_SID, runId)
      await store.loadWorkflowRunEvents(STORE_SID, runId)
    }
    // 活跃锚切回最早写入的 wf-1，再写入 wf-6 → 驱逐跳过 wf-1、淘汰次旧 wf-2
    store.setActiveWorkflowRun(STORE_SID, 'wf-1')
    mockGetRunEvents.mockResolvedValue(storeEventsReply('wf-6'))
    await store.loadWorkflowRunEvents(STORE_SID, 'wf-6')
    expect(store.runEventsOf('wf-1')?.status).toBe('ready')
    expect(store.runEventsOf('wf-2')).toBeUndefined()
  })
})

describe('workflowStore 事件流缓存：生命周期清理', () => {
  // 节内默认值（原文件顶层 beforeEach 下沉：覆盖主体的七行 events 形态为本节两行形态）
  beforeEach(() => {
    mockGetRunEvents.mockResolvedValue(storeEventsReply(RUN_A))
  })


  async function seedTwoSessions(store: ReturnType<typeof useWorkflowStore>): Promise<void> {
    mockGetRunEvents.mockResolvedValue(storeEventsReply(RUN_A))
    store.setActiveWorkflowRun(STORE_SID, RUN_A)
    await store.loadWorkflowRunEvents(STORE_SID, RUN_A)
    mockGetRunEvents.mockResolvedValue(storeEventsReply(RUN_B))
    store.setActiveWorkflowRun('s-other', RUN_B)
    await store.loadWorkflowRunEvents('s-other', RUN_B)
  }

  it('D11⑤ clearSession：清该 session 名下 run 缓存与活跃锚，其他 session 分区保留', async () => {
    const store = useWorkflowStore()
    await seedTwoSessions(store)
    store.setActiveWorkflowRun(STORE_SID, RUN_A) // 活跃锚回到 s-main 名下
    store.clearSession(STORE_SID)
    expect(store.runEventsOf(RUN_A)).toBeUndefined()
    expect(store.runEventsOf(RUN_B)?.status).toBe('ready') // 其他 session 保留
    expect(store.runEventsOf(RUN_B)?.sessionId).toBe('s-other')
  })

  it('clearSession 清活跃锚（归属该 session 时）', async () => {
    const store = useWorkflowStore()
    await seedTwoSessions(store)
    // 活跃锚指 RUN_B（s-other），清 s-main 不动锚；清 s-other 才动
    store.setActiveWorkflowRun('s-other', RUN_B)
    store.clearSession(STORE_SID)
    expect(store.runEventsOf(RUN_B)).toBeDefined()
    store.clearSession('s-other')
    expect(store.runEventsOf(RUN_B)).toBeUndefined()
  })

  it('clearSession 在途窗口释放去重簿记：后续同 runId 调用重新发起 RPC（不并入注定丢弃的在途拉取）', async () => {
    const store = useWorkflowStore()
    store.setActiveWorkflowRun(STORE_SID, RUN_A)
    let resolveRpc!: (v: unknown) => void
    mockGetRunEvents.mockReturnValueOnce(new Promise((resolve) => (resolveRpc = resolve)))
    const stale = store.loadWorkflowRunEvents(STORE_SID, RUN_A)
    expect(mockGetRunEvents).toHaveBeenCalledTimes(1)

    // session 删除时首次拉取仍在途：分区 + 活跃锚 + 在途簿记一并释放
    store.clearSession(STORE_SID)
    // 重开该 run（分区重建后的重挂载形态）：新调用发起独立 RPC——若在途簿记未释放，
    // 会静默并入已删除分区的陈旧在途（结果无 loading 占位可显示的空窗）
    store.setActiveWorkflowRun(STORE_SID, RUN_A)
    const fresh = store.loadWorkflowRunEvents(STORE_SID, RUN_A)
    expect(mockGetRunEvents).toHaveBeenCalledTimes(2)
    await fresh
    expect(store.runEventsOf(RUN_A)?.status).toBe('ready')

    // 陈旧在途 settle：活跃锚已重指本 run（非丢弃路径），写回同源数据无害
    resolveRpc(storeEventsReply(RUN_A))
    await stale
    expect(store.runEventsOf(RUN_A)?.status).toBe('ready')
  })

  it('clearWorkflows：事件流缓存 + LRU 序 + 活跃锚全清', async () => {
    const store = useWorkflowStore()
    await seedTwoSessions(store)
    store.clearWorkflows()
    expect(store.runEventsOf(RUN_A)).toBeUndefined()
    expect(store.runEventsOf(RUN_B)).toBeUndefined()
    // 清空后重新拉取可正常写入（无残留 LRU 序干扰）
    mockGetRunEvents.mockResolvedValue(storeEventsReply(RUN_A))
    store.setActiveWorkflowRun(STORE_SID, RUN_A)
    await store.loadWorkflowRunEvents(STORE_SID, RUN_A)
    expect(store.runEventsOf(RUN_A)?.status).toBe('ready')
  })
})

describe('workflowStore：triggerWorkflowReload 活跃 run 事件流联动（§3.1-4 信号接线）', () => {
  // 节内默认值（原文件顶层 beforeEach 下沉：覆盖主体的七行 events 形态为本节两行形态）
  beforeEach(() => {
    mockGetRunEvents.mockResolvedValue(storeEventsReply(RUN_A))
  })


  it('活跃 run 命中信号 session → force 重新拉取事件流', async () => {
    const store = useWorkflowStore()
    store.setActiveWorkflowRun(STORE_SID, RUN_A)
    await store.loadWorkflowRunEvents(STORE_SID, RUN_A)
    expect(mockGetRunEvents).toHaveBeenCalledTimes(1)
    mockGetWorkflowsResolved()
    store.triggerWorkflowReload(STORE_SID)
    await vi.waitFor(() => expect(mockGetRunEvents).toHaveBeenCalledTimes(2), { interval: 1 })
    expect(mockGetRunEvents).toHaveBeenLastCalledWith(STORE_SID, RUN_A)
  })

  it('信号 session 与活跃 run 不归属 → 不触发事件流拉取', async () => {
    const store = useWorkflowStore()
    store.setActiveWorkflowRun(STORE_SID, RUN_A)
    await store.loadWorkflowRunEvents(STORE_SID, RUN_A)
    mockGetWorkflowsResolved()
    store.triggerWorkflowReload('s-other')
    // 等待微任务排空确认无新增调用
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mockGetRunEvents).toHaveBeenCalledTimes(1)
  })

  /** getWorkflows mock（triggerWorkflowReload 内 loadWorkflows 的伴随调用）默认 resolve 空列表 */
  function mockGetWorkflowsResolved(): void {
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue({ workflows: [] })
  }
})


// ══════════ 来源：panel-tabs.test.ts（一级 tab 模型纯逻辑；零 mock 零组件依赖） ══════════

function phaseTab(name: string): WorkflowLiveTab {
  return { key: phaseTabKey(name), kind: 'phase', title: name, phase: name }
}

describe('panel-tabs：openLiveTab', () => {
  it('新 tab 追加到尾部并激活；已存在仅激活不重复追加', () => {
    const base = [phaseTab('alpha')]
    const opened = openLiveTab(base, phaseTab('beta'))
    expect(opened.tabs.map((t) => t.title)).toEqual(['alpha', 'beta'])
    expect(opened.activeKey).toBe(phaseTabKey('beta'))

    const again = openLiveTab(opened.tabs, phaseTab('alpha'))
    expect(again.tabs.map((t) => t.title)).toEqual(['alpha', 'beta']) // 不重复
    expect(again.activeKey).toBe(phaseTabKey('alpha'))
  })
})

describe('panel-tabs：closeLiveTab', () => {
  it('固定 tab 不可关（原样返回）', () => {
    const tabs = [phaseTab('alpha')]
    const result = closeLiveTab(tabs, phaseTabKey('alpha'), WORKFLOW_FIXED_TAB_KEY)
    expect(result.tabs).toHaveLength(1)
    expect(result.activeKey).toBe(phaseTabKey('alpha'))
  })

  it('关闭激活 tab 激活左侧相邻；首个动态 tab 关闭后回 workflow 固定 tab', () => {
    const tabs = [phaseTab('alpha'), phaseTab('beta'), phaseTab('gamma')]
    // 关最右（gamma）→ 激活左侧 beta
    const closeRight = closeLiveTab(tabs, phaseTabKey('gamma'), phaseTabKey('gamma'))
    expect(closeRight.tabs.map((t) => t.title)).toEqual(['alpha', 'beta'])
    expect(closeRight.activeKey).toBe(phaseTabKey('beta'))
    // 关首个（alpha，当前激活）→ 无左侧相邻 → 回 workflow 固定 tab
    const closeFirst = closeLiveTab(tabs, phaseTabKey('alpha'), phaseTabKey('alpha'))
    expect(closeFirst.tabs.map((t) => t.title)).toEqual(['beta', 'gamma'])
    expect(closeFirst.activeKey).toBe(WORKFLOW_FIXED_TAB_KEY)
  })

  it('关闭非激活 tab 激活键不变', () => {
    const tabs = [phaseTab('alpha'), phaseTab('beta')]
    const result = closeLiveTab(tabs, phaseTabKey('beta'), phaseTabKey('alpha'))
    expect(result.tabs.map((t) => t.title)).toEqual(['beta'])
    expect(result.activeKey).toBe(phaseTabKey('beta'))
  })

  it('关闭不存在的 tab 原样返回（防御）', () => {
    const tabs = [phaseTab('alpha')]
    const result = closeLiveTab(tabs, phaseTabKey('alpha'), phaseTabKey('ghost'))
    expect(result.tabs).toHaveLength(1)
    expect(result.activeKey).toBe(phaseTabKey('alpha'))
  })
})
})

// ═══════════ 来源节：agent-stream-drawer ═══════════

describe('agent-stream-drawer', () => {
// ── 测试数据 ──────────────────────────────────────────────────────────────────

const SID = 's-drawer'
const RUN_ID = 'wf-drawer-1'
// 三段式 vid（AgentTabContent.virtualId = subagentVirtualId(SID, call.memberRecordId)）
const VID0 = 'subagent:s-drawer:rec-0'

function makeCall(overrides: Partial<WorkflowAgentCall> & { id: number }): WorkflowAgentCall {
  return {
    agent: `worker-${overrides.id}`,
    phase: 'alpha',
    status: 'done',
    startedAt: '2026-10-19T02:00:00Z',
    durationMs: 1200,
    inputTokens: 100,
    outputTokens: 200,
    sessionId: `acs-${overrides.id}`,
    memberRecordId: `rec-${overrides.id}`,
    ...overrides,
  }
}

function makeRun(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    runId: RUN_ID,
    scriptName: 'drawer-flow',
    status: 'running',
    reason: undefined,
    outcome: undefined,
    startedAt: '2026-10-19T02:00:00Z',
    completedAt: undefined,
    argsSummary: '{"task":"demo"}',
    stateFilePath: '/tmp/record.jsonl',
    agentCalls: [
      makeCall({ id: 0, status: 'done' }),
      makeCall({ id: 1, status: 'running', phase: 'beta' }),
      makeCall({ id: 2, status: 'pending', sessionId: undefined }),
    ],
    ...overrides,
  }
}

type DrawerVM = { openAgent: (call: WorkflowAgentCall) => void }

async function mountDrawer(run = makeRun()) {
  const wrapper = mount(AgentStreamDrawer, {
    props: { sessionId: SID, run },
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  loadSubagentDataMock.mockClear()
  loadErrorRef.value = null
})

describe('AgentStreamDrawer · 开合（黑盒 DOM）', () => {
  it('初始收起：inert + aria-hidden（tab 集为空也无空态 UI——抽屉未开启即不可见不可达）', async () => {
    const wrapper = await mountDrawer()
    const drawer = wrapper.find('[data-testid="wf-viz-agent-drawer"]')
    expect(drawer.exists()).toBe(true)
    expect(drawer.attributes('inert')).toBeDefined()
    expect(drawer.attributes('aria-hidden')).toBe('true')
    expect(drawer.classes()).toContain('translate-x-full')
  })

  it('openAgent(call) → 展开 + 对话流挂载 subagent 三段式 vid + 拉取编排被调 + meta 条（构建者 + 黑盒）', async () => {
    const wrapper = await mountDrawer()
    ;(wrapper.vm as unknown as DrawerVM).openAgent(makeCall({ id: 0 }))
    await flushPromises()
    const drawer = wrapper.find('[data-testid="wf-viz-agent-drawer"]')
    expect(drawer.attributes('inert')).toBeUndefined()
    expect(drawer.classes()).toContain('translate-x-0')
    // 对话流：MessageStream stub 挂 subagent 三段式 vid；mainSessionId = 发起 session（D11⑤）
    const stream = wrapper.find('[data-testid="message-stream-stub"]')
    expect(stream.exists()).toBe(true)
    expect(stream.text()).toBe(VID0)
    expect(stream.attributes('data-main-sid')).toBe(SID)
    // 快照编排接线（useSubagentTabData.loadSubagentData 复用，零新拉取链）
    expect(loadSubagentDataMock).toHaveBeenCalledWith(VID0)
    // trace 详情元信息条（AgentTabContent 复用）
    expect(wrapper.find('[data-testid="wf-viz-agent-meta"]').text()).toContain('worker-0')
    // 单 tab 也渲染 tab 条（demo 确认形态：chip 常显，「全关 = 收起」语义可达）
    expect(wrapper.find('[data-testid="wf-viz-agent-drawer-tab-strip"]').exists()).toBe(true)
  })

  it('cancelled call（§3.3.8）openAgent → meta 条渲染中性档状态词（不再折进 failed）', async () => {
    const cancelledCall = makeCall({ id: 4, status: 'cancelled' })
    const wrapper = await mountDrawer(makeRun({ agentCalls: [cancelledCall] }))
    ;(wrapper.vm as unknown as DrawerVM).openAgent(cancelledCall)
    await flushPromises()
    const statusSpan = wrapper.find('[data-testid="wf-viz-agent-meta"] span[data-status="cancelled"]')
    expect(statusSpan.exists()).toBe(true)
    expect(statusSpan.text()).toContain('panel.workflowViz.statusCancelled')
  })

  it('收起钮：只收起不清 tab（重开恢复既有 tab 集）；卸载归宿在宿主 v-if', async () => {
    const wrapper = await mountDrawer()
    const vm = wrapper.vm as unknown as DrawerVM
    vm.openAgent(makeCall({ id: 0 }))
    await flushPromises()
    await wrapper.find('[data-testid="wf-viz-agent-drawer-collapse"]').trigger('click')
    expect(wrapper.find('[data-testid="wf-viz-agent-drawer"]').attributes('inert')).toBeDefined()
    // 重开（宿主再次 openAgent）→ 原 tab 恢复激活，快照不重拉（同 vid 分区复用）
    loadSubagentDataMock.mockClear()
    vm.openAgent(makeCall({ id: 0 }))
    await flushPromises()
    expect(wrapper.find('[data-testid="wf-viz-agent-drawer"]').attributes('inert')).toBeUndefined()
    expect(wrapper.find('[data-testid="message-stream-stub"]').exists()).toBe(true)
  })
})

describe('AgentStreamDrawer · 守卫与多 tab（黑盒 + 构建者）', () => {
  it('pending / sessionId 缺失 call：openAgent no-op（零对话可看，对齐 trace 行守卫现状）', async () => {
    const wrapper = await mountDrawer()
    ;(wrapper.vm as unknown as DrawerVM).openAgent(makeCall({ id: 2, status: 'pending', sessionId: undefined }))
    await flushPromises()
    expect(wrapper.find('[data-testid="wf-viz-agent-drawer"]').attributes('inert')).toBeDefined()
    expect(wrapper.find('[data-testid="message-stream-stub"]').exists()).toBe(false)
  })

  it('两个 call → tab 条双 chip（状态点 + 名称 + 关闭钮）；点击切换激活', async () => {
    const wrapper = await mountDrawer()
    const vm = wrapper.vm as unknown as DrawerVM
    vm.openAgent(makeCall({ id: 0 }))
    vm.openAgent(makeCall({ id: 1, status: 'running' }))
    await flushPromises()
    const strip = wrapper.find('[data-testid="wf-viz-agent-drawer-tab-strip"]')
    expect(strip.exists()).toBe(true)
    const tabs = strip.findAll('[data-testid="wf-viz-agent-drawer-tab-item"]')
    expect(tabs).toHaveLength(2)
    expect(tabs[1].attributes('data-active')).toBe('true') // 后开者激活
    expect(tabs[0].attributes('data-active')).toBe('false')
    // running 状态点 + 名称
    expect(tabs[1].text()).toContain('worker-1')
    // 切换：点第一个 chip → 激活切走 + 对话流换 vid
    await tabs[0].trigger('click')
    await flushPromises()
    expect(strip.findAll('[data-testid="wf-viz-agent-drawer-tab-item"]')[0].attributes('data-active')).toBe('true')
    expect(wrapper.find('[data-testid="message-stream-stub"]').text()).toBe(VID0)
  })

  it('关闭激活 tab → 激活左邻；全关 → 抽屉收起（demo 语义：无剩余收起）', async () => {
    const wrapper = await mountDrawer()
    const vm = wrapper.vm as unknown as DrawerVM
    vm.openAgent(makeCall({ id: 0 }))
    vm.openAgent(makeCall({ id: 1, status: 'running' }))
    await flushPromises()
    // 关激活者（#1）→ 激活左邻 #0，对话流切走
    await wrapper.find('[data-testid="wf-viz-agent-drawer-tab-item"][data-call-id="1"] [data-testid="wf-viz-agent-drawer-tab-close"]').trigger('click')
    await flushPromises()
    const tabs = () => wrapper.findAll('[data-testid="wf-viz-agent-drawer-tab-item"]')
    expect(tabs()).toHaveLength(1)
    expect(tabs()[0].attributes('data-call-id')).toBe('0')
    expect(tabs()[0].attributes('data-active')).toBe('true')
    expect(wrapper.find('[data-testid="message-stream-stub"]').text()).toBe(VID0)
    // 关最后一个 → 抽屉收起 + 对话流卸载
    await tabs()[0].find('[data-testid="wf-viz-agent-drawer-tab-close"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="wf-viz-agent-drawer"]').attributes('inert')).toBeDefined()
    expect(wrapper.find('[data-testid="message-stream-stub"]').exists()).toBe(false)
  })
})

describe('AgentStreamDrawer · 快照刷新与错误态（AgentTabContent 链保持）', () => {
  it('memberRecordId 未达 → 等待态零拉取；run 投影更新后就绪 → watch(virtualId) 加载自愈（§3.1-2 刷新链现行形态）', async () => {
    const wrapper = await mountDrawer(makeRun({ agentCalls: [makeCall({ id: 0, memberRecordId: undefined })] }))
    ;(wrapper.vm as unknown as DrawerVM).openAgent(makeCall({ id: 0, memberRecordId: undefined }))
    await flushPromises()
    // memberRecordId 未达（run 推送窗口）：等待态，零对话可看，快照编排不发起
    expect(wrapper.find('[data-testid="wf-viz-agent-waiting"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="message-stream-stub"]').exists()).toBe(false)
    expect(loadSubagentDataMock).not.toHaveBeenCalled()
    loadSubagentDataMock.mockClear()
    // run 投影更新（recordId 就绪）→ activeCall 反查最新投影 → watch(virtualId) 触发加载自愈
    wrapper.setProps({ run: makeRun() })
    await flushPromises()
    expect(wrapper.find('[data-testid="wf-viz-agent-waiting"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="message-stream-stub"]').exists()).toBe(true)
    expect(loadSubagentDataMock).toHaveBeenCalledWith(VID0)
  })

  it('快照拉取失败：错误态 + 重试按钮；点重试重调快照编排（§3.1-2 同一错误态语言）', async () => {
    const wrapper = await mountDrawer()
    ;(wrapper.vm as unknown as DrawerVM).openAgent(makeCall({ id: 0 }))
    await flushPromises()
    loadErrorRef.value = 'rpc down'
    await flushPromises()
    const err = wrapper.find('[data-testid="wf-viz-agent-error"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('rpc down')
    const retryBtn = err.find('[data-testid="wf-viz-agent-retry"]')
    expect(retryBtn.exists()).toBe(true)
    loadSubagentDataMock.mockClear()
    await retryBtn.trigger('click')
    expect(loadSubagentDataMock).toHaveBeenCalledWith(VID0)
    loadErrorRef.value = null
    await flushPromises()
    expect(wrapper.find('[data-testid="wf-viz-agent-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="message-stream-stub"]').exists()).toBe(true)
  })
})

describe('AgentStreamDrawer · 模态表面聚合注册（§6.7 agent-stream-drawer 族）', () => {
  beforeEach(() => {
    // 注册表是模块级单例：本 describe 用例自持挂载实例，先复位防跨用例条目残留
    resetModalSurfaceRegistry()
  })

  it('挂载即注册 view 遮蔽族（intersecting）：开合态直读 open 本体，rect 读抽屉根元素实测', async () => {
    const wrapper = await mountDrawer()
    // 收起（open=false）：不在遮蔽报告内
    expect(openShieldingSurfaces().some((s) => s.id === 'agent-stream-drawer')).toBe(false)
    // 展开：intersecting 档 + rect 读点直读 DOM（jsdom 下 getBoundingClientRect 全 0，非 null 即读点接通）
    ;(wrapper.vm as unknown as DrawerVM).openAgent(makeCall({ id: 0 }))
    await flushPromises()
    const entry = openShieldingSurfaces().find((s) => s.id === 'agent-stream-drawer')
    expect(entry).toBeDefined()
    expect(entry?.mode).toBe('intersecting')
    expect(entry?.rect).toEqual({ x: 0, y: 0, width: 0, height: 0 })
    // 收起后恢复「不在报告内」（开合态与 open 本体绑定）
    await wrapper.find('[data-testid="wf-viz-agent-drawer-collapse"]').trigger('click')
    await flushPromises()
    expect(openShieldingSurfaces().some((s) => s.id === 'agent-stream-drawer')).toBe(false)
  })

  it('卸载即注销（onBeforeUnmount dispose）：条目从注册表摘除', async () => {
    const wrapper = await mountDrawer()
    ;(wrapper.vm as unknown as DrawerVM).openAgent(makeCall({ id: 0 }))
    await flushPromises()
    expect(openShieldingSurfaces().some((s) => s.id === 'agent-stream-drawer')).toBe(true)
    wrapper.unmount()
    expect(openShieldingSurfaces().some((s) => s.id === 'agent-stream-drawer')).toBe(false)
  })
})
})

