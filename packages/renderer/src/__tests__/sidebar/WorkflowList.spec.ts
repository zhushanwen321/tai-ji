/**
 * WorkflowList 组件测试。
 *
 * 覆盖：
 * - 渲染 workflow 卡片列表（scriptName + slug + 进度条 + 摘要 + 状态点）
 * - running 态显示 spinner
 * - 空态展示
 * - 点击卡片触发 select 事件
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/WorkflowList.spec.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import WorkflowList from '@/components/sidebar/WorkflowList.vue'
import type { WorkflowRunRecord } from '@taiji/shared'

function makeRecord(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    runId: 'wf-test-001',
    scriptName: 'test-flow',
    slug: 'deploy',
    status: 'done',
    reason: 'completed',
    startedAt: '2026-07-10T10:00:00Z',
    completedAt: '2026-07-10T10:30:00Z',
    usedTokens: 50000,
    totalCallCount: 2,
    agentCalls: [
      { id: 0, agent: 'dev-W1', status: 'completed', phase: 'Dev' },
      { id: 1, agent: 'dev-W2', status: 'completed', phase: 'Dev' },
    ],
    stateFilePath: '/data/wf-test-001.jsonl',
    ...overrides,
  }
}

describe('WorkflowList 布局结构（滚动修复）', () => {
  // 回归防护：根 div 缺 h-full 会导致 flex 高度传递链断裂，
  // 列表超长时 ScrollArea 不出现滚动条（CW topic: fix-sidebar-subagent-workflow-scroll）
  it('根 div 含 h-full + min-h-0 + flex-col（确保撑满父容器，ScrollArea flex-1 才能正确约束高度）', () => {
    const records = [makeRecord()]
    const wrapper = mount(WorkflowList, { props: { workflows: records } })
    const root = wrapper.find('[data-testid="workflow-list"]')
    expect(root.exists()).toBe(true)
    expect(root.classes()).toContain('h-full')
    expect(root.classes()).toContain('min-h-0')
    expect(root.classes()).toContain('flex-col')
  })
})

describe('WorkflowList', () => {
  it('渲染 workflow 卡片列表（含 scriptName + slug + 进度）', () => {
    const records = [
      makeRecord({ runId: 'wf-a', scriptName: 'deploy-flow', slug: 'prod' }),
      makeRecord({ runId: 'wf-b', scriptName: 'test-flow', slug: 'ci' }),
    ]

    const wrapper = mount(WorkflowList, {
      props: { workflows: records },
    })

    const cards = wrapper.findAll('[data-testid="workflow-card"]')
    expect(cards).toHaveLength(2)

    // 第一张卡片含 scriptName + slug
    expect(cards[0].text()).toContain('deploy-flow')
    expect(cards[0].text()).toContain('prod')
    // 含 agent 完成比例
    expect(cards[0].text()).toContain('2/2')
  })

  it('running 态显示 spinner', () => {
    const records = [makeRecord({ runId: 'wf-run', status: 'running' })]
    const wrapper = mount(WorkflowList, { props: { workflows: records } })

    expect(wrapper.find('[data-testid="workflow-card-spinner"]').exists()).toBe(true)
  })

  it('空态展示提示文案', () => {
    const wrapper = mount(WorkflowList, { props: { workflows: [] } })

    expect(wrapper.find('[data-testid="workflow-list-empty"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('暂无工作流')
  })

  it('点击卡片触发 select 事件', () => {
    const records = [makeRecord({ runId: 'wf-click' })]
    const wrapper = mount(WorkflowList, { props: { workflows: records } })

    wrapper.find('[data-testid="workflow-card"]').trigger('click')

    expect(wrapper.emitted('select')).toBeTruthy()
    expect(wrapper.emitted('select')![0]).toEqual(['wf-click'])
  })

  it('running 态渲染 Pause + Abort 按钮（hover-only，含 group-focus-within 可见性）', () => {
    const records = [makeRecord({ runId: 'wf-run', status: 'running' })]
    const wrapper = mount(WorkflowList, { props: { workflows: records } })

    // running 态 pause + abort 按钮存在于 DOM（jsdom 不应用 hover CSS，验证元素存在即可）
    const pauseBtn = wrapper.find('[data-testid="workflow-action-pause"]')
    const abortBtn = wrapper.find('[data-testid="workflow-action-abort"]')
    expect(pauseBtn.exists()).toBe(true)
    expect(abortBtn.exists()).toBe(true)

    // 操作容器需 hover + focus-within 可见性（可访问性：键盘聚焦也要能显示）
    const container = pauseBtn.element.parentElement
    expect(container?.classList.contains('group-hover:opacity-100')).toBe(true)
    expect(container?.classList.contains('group-focus-within:opacity-100')).toBe(true)
  })

  it('卡片压缩 2 行：不再显示 token 信息（token 移至详情视图）', () => {
    const records = [makeRecord({ runId: 'wf-tok', usedTokens: 50000 })]
    const wrapper = mount(WorkflowList, { props: { workflows: records } })

    const card = wrapper.find('[data-testid="workflow-card"]')
    // usedTokens 不在卡片显示（50k / 50000 均不应出现）
    expect(card.text()).not.toContain('50k')
    expect(card.text()).not.toContain('50000')
    // 但完成比例 + 耗时仍在
    expect(card.text()).toContain('2/2')
  })

  it('abort 两段式：首次点击进入确认态（不 emit），再次点击确认按钮才 emit abort', async () => {
    const records = [makeRecord({ runId: 'wf-abort', status: 'running' })]
    const wrapper = mount(WorkflowList, { props: { workflows: records } })

    const abortBtn = wrapper.find('[data-testid="workflow-action-abort"]')
    // 第一次点击：进入确认态，不 emit action
    await abortBtn.trigger('click')
    expect(wrapper.emitted('action')).toBeFalsy()

    // 确认态出现 abort-confirm 按钮
    const confirmBtn = wrapper.find('[data-testid="workflow-action-abort-confirm"]')
    expect(confirmBtn.exists()).toBe(true)

    // 第二次点击确认 → emit abort
    await confirmBtn.trigger('click')
    const emitted = wrapper.emitted('action')
    expect(emitted).toBeTruthy()
    expect(emitted![0]).toEqual([{ action: 'abort', runId: 'wf-abort' }])
  })

  it('pause 仍为单次点击直接 emit（非破坏性，不需两段确认）', async () => {
    const records = [makeRecord({ runId: 'wf-pause', status: 'running' })]
    const wrapper = mount(WorkflowList, { props: { workflows: records } })

    await wrapper.find('[data-testid="workflow-action-pause"]').trigger('click')
    expect(wrapper.emitted('action')).toBeTruthy()
    expect(wrapper.emitted('action')![0]).toEqual([{ action: 'pause', runId: 'wf-pause' }])
  })

  it('done 态不渲染操作按钮', () => {
    const records = [makeRecord({ runId: 'wf-done', status: 'done' })]
    const wrapper = mount(WorkflowList, { props: { workflows: records } })

    expect(wrapper.find('[data-testid="workflow-action-abort"]').exists()).toBe(false)
  })
})
