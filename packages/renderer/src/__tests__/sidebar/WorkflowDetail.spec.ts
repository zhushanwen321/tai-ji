/**
 * WorkflowDetail 组件测试。
 *
 * 覆盖：
 * - 有显式 phase → 渲染 phase header
 * - 无显式 phase（全部归 Other）→ 不渲染 phase header（agent call 平铺）
 * - running phase → header 有 bg-accent/10 软底色（视觉锚定）
 * - 点击 agent call 触发 select-agent-call（pending 态除外）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/WorkflowDetail.spec.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import WorkflowDetail from '@/components/sidebar/WorkflowDetail.vue'
import type { WorkflowRunRecord, WorkflowAgentCall } from '@taiji/shared'

function makeCall(overrides: Partial<WorkflowAgentCall> = {}): WorkflowAgentCall {
  return {
    id: 0,
    agent: 'dev-agent',
    status: 'completed',
    ...overrides,
  }
}

function makeRecord(calls: WorkflowAgentCall[], overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    runId: 'wf-detail-001',
    scriptName: 'test-flow',
    slug: 'deploy',
    status: 'running',
    startedAt: '2026-07-10T10:00:00Z',
    agentCalls: calls,
    stateFilePath: '/data/wf-detail-001.jsonl',
    ...overrides,
  }
}

describe('WorkflowDetail', () => {
  it('有显式 phase → 渲染 phase header（含 phase 名 + agent 计数）', () => {
    const calls = [
      makeCall({ id: 0, agent: 'builder', phase: 'BUILD', status: 'completed' }),
      makeCall({ id: 1, agent: 'tester', phase: 'TEST', status: 'running' }),
    ]
    const wrapper = mount(WorkflowDetail, { props: { workflow: makeRecord(calls) } })

    const headerTexts = wrapper.findAll('[data-testid="workflow-detail"] .text-\\[length\\:var\\(--text-3xs\\)\\].font-medium')
    // 至少渲染了 phase header（BUILD / TEST）
    const phaseNames = headerTexts.map((h) => h.text())
    expect(phaseNames).toContain('BUILD')
    expect(phaseNames).toContain('TEST')
  })

  it('无显式 phase → 不渲染 phase header（agent call 平铺，无 OTHER 噪音）', () => {
    // 全部 call 无 phase 字段
    const calls = [
      makeCall({ id: 0, agent: 'agent-a', phase: undefined, status: 'completed' }),
      makeCall({ id: 1, agent: 'agent-b', phase: undefined, status: 'running' }),
    ]
    const wrapper = mount(WorkflowDetail, { props: { workflow: makeRecord(calls) } })

    // agent call 卡片仍渲染
    const cards = wrapper.findAll('[data-testid="workflow-agent-call"]')
    expect(cards).toHaveLength(2)

    // 不应出现 'OTHER' phase header（phase 名 span 里不含 OTHER）
    // phase 名 span = .text-[10px].font-medium（WorkflowDetail 内唯一，去 uppercase 后改用此稳定选择器）
    const phaseNameSpans = wrapper.findAll('.text-\\[length\\:var\\(--text-3xs\\)\\].font-medium')
    const phaseHeaders = phaseNameSpans.filter((el) => el.text() !== '')
    // 无 phase 时 phase header v-if=false，phase 名 span 不应渲染
    expect(phaseHeaders.length).toBe(0)
  })

  it('running phase → header 有 bg-accent/10 软底色', () => {
    const calls = [
      makeCall({ id: 0, agent: 'builder', phase: 'BUILD', status: 'completed' }),
      makeCall({ id: 1, agent: 'tester', phase: 'TEST', status: 'running' }),
    ]
    const wrapper = mount(WorkflowDetail, { props: { workflow: makeRecord(calls) } })

    // 找到含 bg-accent/10 的元素（running phase header）
    const accentBgElements = wrapper.findAll('.bg-accent\\/10')
    expect(accentBgElements.length).toBeGreaterThanOrEqual(1)
  })

  it('全部 completed 态 → 无 running phase，无 bg-accent/10 软底色', () => {
    const calls = [
      makeCall({ id: 0, agent: 'builder', phase: 'BUILD', status: 'completed' }),
      makeCall({ id: 1, agent: 'tester', phase: 'TEST', status: 'completed' }),
    ]
    const wrapper = mount(WorkflowDetail, {
      props: { workflow: makeRecord(calls, { status: 'done', reason: 'completed' }) },
    })

    const accentBgElements = wrapper.findAll('.bg-accent\\/10')
    expect(accentBgElements.length).toBe(0)
  })

  it('点击非 pending agent call → emit select-agent-call', async () => {
    const calls = [
      makeCall({ id: 0, agent: 'runner', phase: 'RUN', status: 'completed', sessionId: 'sess-123' }),
    ]
    const wrapper = mount(WorkflowDetail, { props: { workflow: makeRecord(calls) } })

    await wrapper.find('[data-testid="workflow-agent-call"]').trigger('click')
    expect(wrapper.emitted('select-agent-call')).toBeTruthy()
    expect(wrapper.emitted('select-agent-call')![0]).toEqual(['sess-123'])
  })

  it('点击 pending agent call → 不 emit（pending 态不可点击）', async () => {
    const calls = [
      makeCall({ id: 0, agent: 'pending-agent', phase: 'WAIT', status: 'pending' }),
    ]
    const wrapper = mount(WorkflowDetail, { props: { workflow: makeRecord(calls) } })

    await wrapper.find('[data-testid="workflow-agent-call"]').trigger('click')
    expect(wrapper.emitted('select-agent-call')).toBeFalsy()
  })
})
