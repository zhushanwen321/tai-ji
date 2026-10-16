/**
 * CanvasDetailPanel 组件测试（problem-solve-canvas §3.1(3) 三 tab 详情面板）。
 *
 * 覆盖语义：tab 切换（用户可见激活态）/ 审查 tab 未处置 must-fix 徽标 /
 * 审查条目点击定位（targetId 节点直选、边解析到终点）/ 子面板事件上抛转发 /
 * 选中节点变化 → 详情 tab 跟随。
 *
 * mock 策略：三个子面板 stub 为空组件（面板编排逻辑本组件持有——数据与交互
 * 全经 props/emit，stub 后事件仍可从 findComponent 驱动）；i18n 走全局 setup。
 * 运行：cd packages/renderer && npx vitest run src/components/canvas/canvas-detail-panel.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import type { CanvasState } from '@zhushanwen/extension-protocol'
import CanvasDetailPanel from './CanvasDetailPanel.vue'
import CanvasNodeDetail from './CanvasNodeDetail.vue'
import CanvasReviewPanel from './CanvasReviewPanel.vue'
import CanvasExportPanel from './CanvasExportPanel.vue'

function makeState(overrides: Partial<CanvasState> = {}): CanvasState {
  return {
    canvasId: 'cvs-1',
    name: '画布规划',
    root: { nodeId: 'root', statement: '根问题', criterias: ['判据一'], scopeExclusions: [] },
    direction: null,
    nodes: [
      { id: 'root', type: 'question', content: '根问题怎么解', lifecycle: 'draft', createdAt: 'T0' },
      { id: 'o1', type: 'option', content: '方案一', lifecycle: 'draft', createdAt: 'T0' },
    ],
    edges: [{ id: 'er-1', type: 'resolve', from: 'root', to: 'o1' }],
    comments: [],
    dirtyPaths: [],
    review: null,
    converged: false,
    createdAt: 'T0',
    updatedAt: 'T0',
    ...overrides,
  }
}

function mountPanel(state: CanvasState, selectedNodeId: string | null = null) {
  return mount(CanvasDetailPanel, {
    props: { state, selectedNodeId, rejection: null },
    global: {
      stubs: {
        CanvasNodeDetail: { template: '<div data-stub="node-detail" />' },
        CanvasReviewPanel: { template: '<div data-stub="review-panel" />' },
        CanvasExportPanel: { template: '<div data-stub="export-panel" />' },
      },
    },
  })
}

describe('CanvasDetailPanel tab 编排', () => {
  it('三 tab 渲染且默认激活详情 tab', () => {
    const wrapper = mountPanel(makeState())
    const tabs = wrapper.findAll('[data-testid^="canvas-detail-tab-"]')
    expect(tabs).toHaveLength(3)
    expect(wrapper.get('[data-testid="canvas-detail-tab-detail"]').attributes('aria-selected')).toBe('true')
    expect(wrapper.get('[data-testid="canvas-detail-tab-review"]').attributes('aria-selected')).toBe('false')
  })

  it('点击 tab 切换激活态（切审查 → 审查激活）', async () => {
    const wrapper = mountPanel(makeState())
    await wrapper.get('[data-testid="canvas-detail-tab-review"]').trigger('click')
    expect(wrapper.get('[data-testid="canvas-detail-tab-review"]').attributes('aria-selected')).toBe('true')
    expect(wrapper.get('[data-testid="canvas-detail-tab-detail"]').attributes('aria-selected')).toBe('false')
  })

  it('审查 tab 徽标 = 未处置 must-fix 计数（有报告时）', () => {
    const state = makeState({
      review: {
        status: 'in-progress',
        round: 1,
        maxRounds: 5,
        entries: [
          { id: 're1', round: 1, dimension: 'completeness', severity: 'must-fix', targetId: 'o1', note: '缺迁移' },
          { id: 're2', round: 1, dimension: 'depth', severity: 'suggestion', targetId: 'root', note: '可再拆' },
          { id: 're3', round: 1, dimension: 'necessity', severity: 'must-fix', targetId: 'o1', note: '冗余', resolution: { disposition: 'accepted', by: 'user', note: '已改' } },
        ],
      },
    })
    const wrapper = mountPanel(state)
    expect(wrapper.get('[data-testid="canvas-review-tab-count"]').text()).toBe('1')
  })

  it('无审查聚合时无徽标', () => {
    const wrapper = mountPanel(makeState())
    expect(wrapper.find('[data-testid="canvas-review-tab-count"]').exists()).toBe(false)
  })
})

describe('CanvasDetailPanel 子面板事件上抛与审查定位', () => {
  it('NodeDetail 的 op / select 转发到面板', async () => {
    const wrapper = mountPanel(makeState())
    await wrapper.findComponent(CanvasNodeDetail).vm.$emit('op', { kind: 'edit-content', nodeId: 'o1' })
    await wrapper.findComponent(CanvasNodeDetail).vm.$emit('select', 'o1')
    expect(wrapper.emitted('op')?.[0]).toEqual([{ kind: 'edit-content', nodeId: 'o1' }])
    expect(wrapper.emitted('select')?.[0]).toEqual(['o1'])
  })

  it('ReviewPanel 的 op / request-review 转发；select 走定位（边 targetId 解析到终点节点并切详情）', async () => {
    const wrapper = mountPanel(makeState())
    await wrapper.get('[data-testid="canvas-detail-tab-review"]').trigger('click')

    await wrapper.findComponent(CanvasReviewPanel).vm.$emit('request-review')
    expect(wrapper.emitted('request-review')).toHaveLength(1)

    await wrapper.findComponent(CanvasReviewPanel).vm.$emit('select', 'er-1')
    expect(wrapper.emitted('select')?.[0]).toEqual(['o1'])
    // 定位后详情 tab 跟随激活
    expect(wrapper.get('[data-testid="canvas-detail-tab-detail"]').attributes('aria-selected')).toBe('true')
  })

  it('ReviewPanel select 指向节点 id 时直接选中该节点', async () => {
    const wrapper = mountPanel(makeState())
    await wrapper.findComponent(CanvasReviewPanel).vm.$emit('select', 'o1')
    expect(wrapper.emitted('select')?.[0]).toEqual(['o1'])
  })

  it('ExportPanel 的 export / op / select 全量转发', async () => {
    const wrapper = mountPanel(makeState())
    await wrapper.get('[data-testid="canvas-detail-tab-export"]').trigger('click')
    const exportPanel = wrapper.findComponent(CanvasExportPanel)
    await exportPanel.vm.$emit('export', { target: 'planning-doc' })
    await exportPanel.vm.$emit('op', { kind: 'decide-direction' })
    await exportPanel.vm.$emit('select', 'root')
    expect(wrapper.emitted('export')?.[0]).toEqual([{ target: 'planning-doc' }])
    expect(wrapper.emitted('op')?.[0]).toEqual([{ kind: 'decide-direction' }])
    expect(wrapper.emitted('select')?.at(-1)).toEqual(['root'])
  })
})

describe('CanvasDetailPanel 选中节点跟随', () => {
  it('selectedNodeId 从 null 变为节点 → 详情 tab 激活（画布点节点 = 看详情的自然意图）', async () => {
    const wrapper = mountPanel(makeState(), null)
    await wrapper.get('[data-testid="canvas-detail-tab-review"]').trigger('click')
    await wrapper.setProps({ selectedNodeId: 'o1' })
    await nextTick()
    expect(wrapper.get('[data-testid="canvas-detail-tab-detail"]').attributes('aria-selected')).toBe('true')
  })

  it('selectedNodeId 回到 null 不抢 tab（清空选区不劫持用户所在 tab）', async () => {
    const wrapper = mountPanel(makeState(), 'o1')
    await wrapper.get('[data-testid="canvas-detail-tab-export"]').trigger('click')
    await wrapper.setProps({ selectedNodeId: null })
    await nextTick()
    expect(wrapper.get('[data-testid="canvas-detail-tab-export"]').attributes('aria-selected')).toBe('true')
  })
})
