/**
 * WorkflowTab 组件测试（[P3/D6] 快照投影增强的消费面）。
 * [W0] 合并投影消费面锚定（V4 两阶段归组 + V6 failed 错误摘要）。
 *
 * 三视角（TEST-STRATEGY §3）：
 * - 使用者（黑盒 DOM）：agent call 三态渲染（running/pending/done 耗时）——每条用例
 *   至少一个用户可见断言；[P3/D6] 每 ask 已执行时长槽（「运行中 · 30s」）可见
 * - 观察者（形态）：run 级停滞徽标与 per-ask 停滞信号（stalledSince 消费侧推导，
 *   推导纯函数单源在 stores/workflow——数值边界在其单测，此处验渲染接线）
 * - 构建者：旧快照 additive 读缺省渲染路径（health/startedAt/lastProgressAt 缺省
 *   → 无停滞徽标、时长槽省略，组件不炸）
 *
 * mock 策略：真实 pinia（panel + workflow store，分区 ref 直写种数据）；
 * drawer 控制态 bindDrawerSessionId + openWorkflow 真实域状态；vue-i18n 全局 setup
 * （zh-CN 取值）；fake timers 固定 now（1s tick 在 fake timers 下不推进——推导以
 * FIXED_NOW 为锚，确定性断言）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/workflow-tab.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import { bindDrawerSessionId, openWorkflow, _resetDrawerForTest } from '@taiji/core/domain/drawer'
import WorkflowTab from '@/components/panel/WorkflowTab.vue'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import { useWorkflowStore } from '@/stores/workflow'
import { WORKFLOW_STALL_THRESHOLD_MS } from '@/stores/workflow'
import type { WorkflowAgentCall, WorkflowRunRecord } from '@taiji/shared'

// 固定 now（fake timers）：停滞推导与时长槽的时间锚
const FIXED_NOW = 1_758_000_000_000
const SID = 'sid-wf-tab'

const startedIso = (msAgo: number) => new Date(FIXED_NOW - msAgo).toISOString()

function call(overrides: Partial<WorkflowAgentCall>): WorkflowAgentCall {
  return { id: 0, agent: 'dev', status: 'running', ...overrides }
}

function record(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    runId: 'wf-tab-1',
    scriptName: 'review-fix-loop',
    status: 'running',
    startedAt: startedIso(120_000),
    agentCalls: [],
    stateFilePath: '',
    ...overrides,
  }
}

async function mountTab(records: WorkflowRunRecord[]): Promise<VueWrapper> {
  const workflowStore = useWorkflowStore()
  // 种数据：applyRecords 已从 store 导出面摘除，直写分区 ref（不可变替换触发响应性）
  workflowStore.recordsBySession = new Map(workflowStore.recordsBySession).set(SID, records)
  openWorkflow(records[0]!.runId)
  const wrapper = mount(WorkflowTab)
  return wrapper
}

describe('WorkflowTab [P3/D6] 投影消费', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: FIXED_NOW })
    setActivePinia(createPinia())
    _resetDrawerForTest()
    usePanelStore().loadSession(ROOT_PANEL_ID, SID)
    bindDrawerSessionId(ref(SID))
  })

  afterEach(() => {
    vi.useRealTimers()
    _resetDrawerForTest()
  })

  it('三态渲染：running「运行中」/ pending「等待中」/ done 耗时（既有三态直读）', async () => {
    const wf = record({
      agentCalls: [
        call({ id: 0, agent: 'a-run', status: 'running' }),
        call({ id: 1, agent: 'a-pending', status: 'pending' }),
        call({ id: 2, agent: 'a-done', status: 'completed', durationMs: 65_000 }),
      ],
    })
    const wrapper = await mountTab([wf])

    const rows = wrapper.findAll('[data-testid="drawer-workflow-agent-call"]')
    expect(rows).toHaveLength(3)
    expect(rows[0]!.text()).toContain('运行中')
    expect(rows[1]!.text()).toContain('等待中')
    expect(rows[2]!.text()).toContain('1m5s') // done ask 耗时（durationMs 既有通道）
  })

  it('每 ask 已执行时长槽：running 且 startedAt 可解析 → 「运行中 · 30s」', async () => {
    const wf = record({
      agentCalls: [call({ id: 0, status: 'running', startedAt: startedIso(30_000) })],
    })
    const wrapper = await mountTab([wf])
    const row = wrapper.find('[data-testid="drawer-workflow-agent-call"]')
    expect(row.text()).toContain('运行中 · 30s')
  })

  it('停滞渲染：run 级 health 超阈值 → drawer-workflow-stalled 徽标（无进展文案）', async () => {
    const stale = FIXED_NOW - WORKFLOW_STALL_THRESHOLD_MS - 60_000
    const wf = record({
      agentCalls: [call({ id: 0, status: 'running', startedAt: startedIso(30_000) })],
      health: { lastProgressAt: stale },
    })
    const wrapper = await mountTab([wf])
    const badge = wrapper.find('[data-testid="drawer-workflow-stalled"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toContain('无进展')
    expect(badge.text()).toContain('16m')
  })

  it('per-ask 停滞：call.lastProgressAt 超阈值 → 该 ask 标签呈「无进展」（warn 色档），他 ask 不受累', async () => {
    const stale = FIXED_NOW - WORKFLOW_STALL_THRESHOLD_MS - 60_000
    const wf = record({
      agentCalls: [
        call({ id: 0, agent: 'stalled-ask', status: 'running', startedAt: startedIso(30_000), lastProgressAt: stale }),
        call({ id: 1, agent: 'fresh-ask', status: 'running', startedAt: startedIso(30_000), lastProgressAt: FIXED_NOW - 1000 }),
      ],
    })
    const wrapper = await mountTab([wf])
    const rows = wrapper.findAll('[data-testid="drawer-workflow-agent-call"]')
    expect(rows[0]!.text()).toContain('无进展')
    expect(rows[1]!.text()).toContain('运行中')
  })

  it('旧快照缺省渲染：health/startedAt/lastProgressAt 全缺 → 无停滞徽标、时长槽省略、不炸', async () => {
    const wf = record({
      agentCalls: [call({ id: 0, status: 'running', startedAt: undefined, lastProgressAt: undefined })],
    })
    const wrapper = await mountTab([wf])

    // 组件照常渲染三态（running ask 标签为纯「运行中」，无时长槽后缀）
    const row = wrapper.find('[data-testid="drawer-workflow-agent-call"]')
    expect(row.exists()).toBe(true)
    expect(row.text()).toContain('运行中')
    expect(row.text()).not.toContain('·')
    // 无 run 级停滞徽标（health 缺省 → 不判定）
    expect(wrapper.find('[data-testid="drawer-workflow-stalled"]').exists()).toBe(false)
  })

  it('done run 不判停滞：终局 run 即使 health 陈旧也无徽标', async () => {
    const stale = FIXED_NOW - WORKFLOW_STALL_THRESHOLD_MS * 10
    const wf = record({
      status: 'done',
      reason: 'completed',
      health: { lastProgressAt: stale },
    })
    const wrapper = await mountTab([wf])
    expect(wrapper.find('[data-testid="drawer-workflow-stalled"]').exists()).toBe(false)
  })
})

// ── [W0] 合并投影形状锚定（设计 D2-R3：mock 输入按契约形状——id/agent/slug/status/
// startedAt/sessionId，phase 可 undefined；U2 合并投影落地后由主 agent 复核真实形状）──

describe('WorkflowTab [W0] 合并投影消费锚定（V4 结构 / V6 失败渲染）', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: FIXED_NOW })
    setActivePinia(createPinia())
    _resetDrawerForTest()
    usePanelStore().loadSession(ROOT_PANEL_ID, SID)
    bindDrawerSessionId(ref(SID))
  })

  afterEach(() => {
    vi.useRealTimers()
    _resetDrawerForTest()
  })

  it('V4 盲区窗口平铺：record-only 行（phase undefined）全部渲染、无分组 header、无「Other」占位组', async () => {
    // D2-R3 record-only 成行契约形状：record 有候选而 trace 暂无节点 → 用自身字段成行，
    // phase 保持 undefined（盲区窗口 ① trace 快照恒 steps=0、② record 无 phase）
    const wf = record({
      agentCalls: [
        call({ id: 0, agent: 'reviewer-1', status: 'running', startedAt: startedIso(30_000), sessionId: 'acs-r1' }),
        call({ id: 1, agent: 'reviewer-2', status: 'running', startedAt: startedIso(30_000), sessionId: 'acs-r2' }),
        call({ id: 2, agent: 'reviewer-3', status: 'running', startedAt: startedIso(30_000), sessionId: 'acs-r3' }),
        call({ id: 3, agent: 'reviewer-4', status: 'running', startedAt: startedIso(30_000), sessionId: 'acs-r4' }),
      ],
    })
    const wrapper = await mountTab([wf])

    // 秒级出现的步骤行是「无分组 header 的平铺」：4 行全渲染，各带 agent 名 + running + 计时
    const rows = wrapper.findAll('[data-testid="drawer-workflow-agent-call"]')
    expect(rows).toHaveLength(4)
    expect(rows[0]!.text()).toContain('reviewer-1')
    expect(rows[0]!.text()).toContain('运行中 · 30s')
    // hasExplicitPhases 判 phase !== undefined 保持 false → 不出分组头（无「N 个代理」计数），
    // 也不出「Other」占位组文案
    expect(wrapper.text()).not.toContain('Other')
    expect(wrapper.text()).not.toContain('个代理')
  })

  it('V4 归组阶段：① flush 后 phase 到位 → 分组 header 出现（phase 名 + 组内计数），组内步骤不丢', async () => {
    const wf = record({
      agentCalls: [
        call({ id: 0, agent: 'reviewer-1', status: 'completed', phase: 'Review', sessionId: 'acs-r1', durationMs: 60_000 }),
        call({ id: 1, agent: 'reviewer-2', status: 'completed', phase: 'Review', sessionId: 'acs-r2', durationMs: 45_000 }),
        call({ id: 2, agent: 'fixer-1', status: 'running', phase: 'Fix', startedAt: startedIso(10_000), sessionId: 'acs-f1' }),
      ],
    })
    const wrapper = await mountTab([wf])

    // 分组 header：phase 名可见 + 组内计数（agentsLabel '{count} 个代理'）
    expect(wrapper.text()).toContain('Review')
    expect(wrapper.text()).toContain('Fix')
    expect(wrapper.text()).toContain('2 个代理')
    expect(wrapper.text()).toContain('1 个代理')
    // 组内步骤行全渲染（3 行归两组）
    expect(wrapper.findAll('[data-testid="drawer-workflow-agent-call"]')).toHaveLength(3)
  })

  it('V6 失败渲染：failed 行红点态 + 错误摘要文案（record.error 投影）', async () => {
    const wf = record({
      agentCalls: [
        call({ id: 0, agent: 'reviewer-2', status: 'failed', sessionId: 'acs-r2', durationMs: 5_000, error: 'agent process crashed (exit 1)' }),
      ],
    })
    const wrapper = await mountTab([wf])

    const row = wrapper.find('[data-testid="drawer-workflow-agent-call"]')
    expect(row.exists()).toBe(true)
    expect(row.text()).toContain('reviewer-2')
    // 错误摘要可见（failed 行不再只靠红点；title 提供全文）
    const err = wrapper.find('[data-testid="drawer-workflow-agent-call-error"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('agent process crashed (exit 1)')
    expect(err.attributes('title')).toBe('agent process crashed (exit 1)')
  })

  it('V6 failed 行无 error 字段：不渲染空摘要行（缺省路径不炸）', async () => {
    const wf = record({
      agentCalls: [call({ id: 0, agent: 'reviewer-3', status: 'failed', sessionId: 'acs-r3' })],
    })
    const wrapper = await mountTab([wf])
    expect(wrapper.find('[data-testid="drawer-workflow-agent-call"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="drawer-workflow-agent-call-error"]').exists()).toBe(false)
  })
})
