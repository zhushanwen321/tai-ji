/**
 * WorkflowTab 组件测试（[P3/D6] 快照投影增强的消费面）。
 *
 * 三视角（TEST-STRATEGY §3）：
 * - 使用者（黑盒 DOM）：agent call 三态渲染（running/pending/done 耗时）——每条用例
 *   至少一个用户可见断言；[P3/D6] 每 ask 已执行时长槽（「运行中 · 30s」）可见
 * - 观察者（形态）：run 级停滞徽标与 per-ask 停滞信号（stalledSince 消费侧推导，
 *   推导纯函数单源在 stores/workflow——数值边界在其单测，此处验渲染接线）
 * - 构建者：旧快照 additive 读缺省渲染路径（health/startedAt/lastProgressAt 缺省
 *   → 无停滞徽标、时长槽省略，组件不炸）
 *
 * mock 策略：真实 pinia（panel + workflow store，applyRecords 直接种数据）；
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
  workflowStore.applyRecords(SID, records)
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
