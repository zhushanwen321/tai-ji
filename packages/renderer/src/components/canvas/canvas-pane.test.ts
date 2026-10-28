/**
 * canvas 家族 colocated 合并产物（round5-f C2）。
 *
 * 来源（本目录同源五件，环境均为 vitest 默认）：
 *   - canvas-detail-panel.test.ts（三 tab 详情面板编排，零 mock）
 *   - canvas-display.test.ts（展示派生纯函数直驱，零 mock、无 DOM）
 *   - canvas-graph.test.ts（首帧自适应全景，零 mock）
 *   - canvas-node-card.test.ts（节点卡视觉通道，零 mock）
 *   - canvas-pane.test.ts（主文件：CanvasPane/CanvasBindingBadge 全链集成）
 *
 * mock 说明：唯一 vi.mock 为 canvas-pane 节的 '@taiji/core/transport/api'——
 * 保留式（spread actual 全成员 + 仅覆写 command），其余四节消费链不受影响；
 * 该节原文件级 beforeEach/afterEach（pinia / command 桩 / 挂载登记清理）下沉
 * 包裹层 describe 内，作用域与原单文件等价。
 *
 * 合并纪律：describe/it 名零改动；五节各外包一层同名 describe（纯前缀添加）
 * 消除 makeState 等跨节私有 helper 同名冲突；i18n 走全局 setup（zh-CN 取值）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { computed, nextTick } from 'vue'
import type { CanvasState, CanvasNode } from '@zhushanwen/extension-protocol'

import CanvasDetailPanel from './CanvasDetailPanel.vue'
import CanvasNodeDetail from './CanvasNodeDetail.vue'
import CanvasReviewPanel from './CanvasReviewPanel.vue'
import CanvasExportPanel from './CanvasExportPanel.vue'
import CanvasGraph from './CanvasGraph.vue'
import CanvasNodeCard from './CanvasNodeCard.vue'
import CanvasArgStrip from './CanvasArgStrip.vue'
import CanvasPane from './CanvasPane.vue'
import CanvasBindingBadge from './CanvasBindingBadge.vue'
import {
  argsOfHost,
  canvasPhaseOf,
  commentsOfAnchor,
  computeCanvasLayout,
  edgePathOf,
  openMustFixOf,
  pendingCommentCountOf,
  questionIdOfOption,
  rebutTargetOf,
  rebuttersOf,
  selectedOptionIdOf,
  trunkKidsOf,
  trunkParentOf,
} from './canvas-display'
import type { HostArgs, LayoutPos } from './canvas-display'

vi.mock('@taiji/core/transport/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api')>()
  return { ...actual, command: vi.fn() }
})

const commandMock = vi.mocked(await import('@taiji/core/transport/api').then((m) => m.command))

/* ════════ 来源：canvas-detail-panel.test.ts ════════ */

describe('CanvasDetailPanel', () => {
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
            { id: 're3', round: 1, dimension: 'completeness', severity: 'must-fix', targetId: 'o1', note: '冗余', resolution: { disposition: 'accepted', by: 'user', note: '已改' } },
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
})

/* ════════ 来源：canvas-display.test.ts ════════ */

describe('canvas-display', () => {
  /** 最小合法画布（根 + 两层主干 + 候选/论据/评论），按用例需要覆盖字段。 */
  function makeState(overrides: Partial<CanvasState> = {}): CanvasState {
    return {
      canvasId: 'cvs-1',
      name: '测试画布',
      root: { nodeId: 'root', statement: '根问题', criterias: ['判据一'], scopeExclusions: [] },
      direction: null,
      nodes: [
        { id: 'root', type: 'question', content: '根问题', lifecycle: 'draft', createdAt: '2026-10-14T00:00:00.000Z' },
        { id: 'q2', type: 'question', content: '子问题', lifecycle: 'draft', createdAt: '2026-10-14T00:00:00.000Z' },
        { id: 'o1', type: 'option', content: '方案一', lifecycle: 'draft', createdAt: '2026-10-14T00:00:00.000Z' },
        { id: 'o2', type: 'option', content: '方案二', lifecycle: 'draft', createdAt: '2026-10-14T00:00:00.000Z' },
        { id: 'a1', type: 'argument', content: '支持论据', lifecycle: 'draft', polarity: 'support', materiality: 'fact', factVerified: true, createdAt: '2026-10-14T00:00:00.000Z' },
        { id: 'a2', type: 'argument', content: '反对论据', lifecycle: 'draft', polarity: 'object', materiality: 'claim', createdAt: '2026-10-14T00:00:00.000Z' },
      ],
      edges: [
        { id: 'ed-1', type: 'decompose', from: 'root', to: 'q2' },
        { id: 'er-1', type: 'resolve', from: 'q2', to: 'o1' },
        { id: 'er-2', type: 'resolve', from: 'q2', to: 'o2' },
        { id: 'ea-1', type: 'argue', from: 'a1', to: 'o1', polarity: 'support' },
        { id: 'ea-2', type: 'argue', from: 'a2', to: 'o1', polarity: 'object' },
      ],
      comments: [{ id: 'cm-1', anchorId: 'o2', text: '会挤占独立窗口吗', status: 'pending', createdAt: '2026-10-14T00:00:00.000Z' }],
      dirtyPaths: [],
      review: null,
      converged: false,
      createdAt: '2026-10-14T00:00:00.000Z',
      updatedAt: '2026-10-14T00:00:00.000Z',
      ...overrides,
    }
  }

  describe('canvasPhaseOf（契约派生口径）', () => {
    it('converged = 已收敛（优先级最高）', () => {
      expect(canvasPhaseOf(makeState({ converged: true }))).toBe('converged')
    })

    it('开放 must-fix 或审查进行中 = 审查中', () => {
      const withMustFix = makeState({
        review: { status: 'max-rounds', round: 2, maxRounds: 3, entries: [{ id: 'e1', round: 1, dimension: 'depth', severity: 'must-fix', targetId: 'o1', note: 'n' }] },
      })
      expect(canvasPhaseOf(withMustFix)).toBe('reviewing')
      expect(canvasPhaseOf(makeState({ review: { status: 'in-progress', round: 1, maxRounds: 3, entries: [] } }))).toBe('reviewing')
    })

    it('审查停回终态（无开放 must-fix）不算审查中 = 生长中', () => {
      expect(canvasPhaseOf(makeState({ review: { status: 'max-rounds', round: 2, maxRounds: 3, entries: [] } }))).toBe('growing')
    })

    it('白板画布 = 生长中', () => {
      expect(canvasPhaseOf(makeState())).toBe('growing')
    })
  })

  describe('openMustFixOf（未处置投影）', () => {
    it('只留 must-fix 且无处置记录的条目', () => {
      const state = makeState({
        review: {
          status: 'in-progress',
          round: 1,
          maxRounds: 3,
          entries: [
            { id: 'e1', round: 1, dimension: 'depth', severity: 'must-fix', targetId: 'o1', note: '开放' },
            { id: 'e2', round: 1, dimension: 'depth', severity: 'must-fix', targetId: 'o2', note: '已处置', resolution: { disposition: 'accepted', by: 'agent', note: 'ok' } },
            { id: 'e3', round: 1, dimension: 'depth', severity: 'suggestion', targetId: 'o2', note: '建议' },
          ],
        },
      })
      expect(openMustFixOf(state).map((e) => e.id)).toEqual(['e1'])
    })
  })

  describe('主干关系投影', () => {
    it('trunkKidsOf / trunkParentOf：decompose 与 resolve 同为 parent→child', () => {
      const state = makeState()
      expect(trunkKidsOf(state).get('root')).toEqual(['q2'])
      expect(trunkKidsOf(state).get('q2')).toEqual(['o1', 'o2'])
      expect(trunkParentOf(state, 'o1')).toBe('q2')
      expect(trunkParentOf(state, 'root')).toBeNull()
    })

    it('selectedOptionIdOf / questionIdOfOption 双向反查', () => {
      const state = makeState({ nodes: makeState().nodes.map((n) => (n.id === 'o1' ? { ...n, selected: true } : n)) })
      expect(selectedOptionIdOf(state, 'q2')).toBe('o1')
      expect(questionIdOfOption(state, 'o1')).toBe('q2')
      expect(selectedOptionIdOf(makeState(), 'q2')).toBeNull()
    })
  })

  describe('论据分组与互驳', () => {
    it('argsOfHost 按极性分组挂宿主', () => {
      const args = argsOfHost(makeState(), 'o1')
      expect(args.support.map((a) => a.id)).toEqual(['a1'])
      expect(args.object.map((a) => a.id)).toEqual(['a2'])
      expect(argsOfHost(makeState(), 'o2').support).toHaveLength(0)
    })

    it('rebuttersOf / rebutTargetOf：rebut 边两向反查', () => {
      const state = makeState({
        edges: [...makeState().edges, { id: 'eb-1', type: 'rebut', from: 'a2', to: 'a1' }],
      })
      expect(rebuttersOf(state, 'a1').map((a) => a.id)).toEqual(['a2'])
      expect(rebutTargetOf(state, 'a2')?.id).toBe('a1')
      expect(rebutTargetOf(state, 'a1')).toBeNull()
    })
  })

  describe('评论锚定', () => {
    it('commentsOfAnchor / pendingCommentCountOf', () => {
      const state = makeState({
        comments: [
          { id: 'cm-1', anchorId: 'o2', text: '待响应', status: 'pending', createdAt: 'T0' },
          { id: 'cm-2', anchorId: 'o2', text: '已响应', status: 'responded', response: { disposition: 'adopted', note: '补了' }, createdAt: 'T0' },
          { id: 'cm-3', anchorId: 'o1', text: '别家', status: 'pending', createdAt: 'T0' },
        ],
      })
      expect(commentsOfAnchor(state, 'o2')).toHaveLength(2)
      expect(pendingCommentCountOf(state, 'o2')).toBe(1)
    })
  })

  describe('computeCanvasLayout（demo v3 内核平移）', () => {
    it('分层定位：根在上、子树居中、无负 x', () => {
      const state = makeState()
      const layout = computeCanvasLayout(state, { heightOf: () => 100 })
      const root = layout.pos.get('root')
      const o1 = layout.pos.get('o1')
      const o2 = layout.pos.get('o2')
      expect(root).toBeDefined()
      expect(o1).toBeDefined()
      expect(o2).toBeDefined()
      expect(root!.y).toBeLessThan(o1!.y)
      expect(o1!.y).toBe(o2!.y)
      // 两候选并排居中于父下
      const mid = (o1!.x + o2!.x + o2!.w) / 2
      expect(Math.abs(mid - (root!.x + root!.w / 2))).toBeLessThanOrEqual(1)
      // 归一化：全部位置非负
      for (const p of layout.pos.values()) {
        expect(p.x).toBeGreaterThanOrEqual(0)
      }
      expect(layout.bbox.x2).toBeGreaterThan(layout.bbox.x1)
    })

    it('heightOf 注入生效（层高取该层最大值）', () => {
      const state = makeState()
      const layout = computeCanvasLayout(state, { heightOf: (id) => (id === 'o1' ? 200 : 100) })
      const o1 = layout.pos.get('o1')!
      const o2 = layout.pos.get('o2')!
      expect(o1.h).toBe(200)
      expect(o2.h).toBe(100)
      // 第二层 y 起点 = 30(顶距) + 100(根层高) + 42(层距) + 100(q2 层高) + 42(层距) = 314
      expect(o1.y).toBe(314)
    })

    it('hidden 判据整支让位（否决折叠）', () => {
      const state = makeState({ nodes: makeState().nodes.map((n) => (n.id === 'o1' ? { ...n, lifecycle: 'rejected' } : n)) })
      const full = computeCanvasLayout(state, { heightOf: () => 100 })
      const collapsed = computeCanvasLayout(state, { heightOf: () => 100, hidden: (id) => id === 'o1' })
      expect(full.pos.has('o1')).toBe(true)
      expect(collapsed.pos.has('o1')).toBe(false)
      expect(collapsed.pos.get('o2')).toBeDefined()
    })
  })

  describe('edgePathOf', () => {
    it('父底边到子顶边的 C 曲线（resolve 终点微入保箭头）', () => {
      const d = edgePathOf({ x: 0, y: 0, w: 296, h: 100 }, { x: 0, y: 200, w: 296, h: 50 }, 'resolve')
      expect(d).toMatch(/^M 148 94 C /)
      expect(d).toContain('148 202')
      const decompose = edgePathOf({ x: 0, y: 0, w: 296, h: 100 }, { x: 0, y: 200, w: 296, h: 50 }, 'decompose')
      expect(decompose).toContain('148 206')
    })
  })
})

/* ════════ 来源：canvas-graph.test.ts ════════ */

describe('CanvasGraph', () => {
  /** 最小画布：根 → 子问题 → 两候选（happy-dom clientWidth=0 → fit 落 K_MIN=0.28 钳位）。 */
  function makeState(overrides: Partial<CanvasState> = {}): CanvasState {
    return {
      canvasId: 'cvs-1',
      name: '画布规划',
      root: { nodeId: 'root', statement: '根问题', criterias: ['判据一'], scopeExclusions: [] },
      direction: null,
      nodes: [
        { id: 'root', type: 'question', content: '根问题怎么解', lifecycle: 'draft', createdAt: 'T0' },
        { id: 'q2', type: 'question', content: '子问题拆解', lifecycle: 'draft', createdAt: 'T0' },
        { id: 'o1', type: 'option', content: '方案一', lifecycle: 'draft', createdAt: 'T0' },
        { id: 'o2', type: 'option', content: '方案二', lifecycle: 'draft', createdAt: 'T0' },
      ],
      edges: [
        { id: 'ed-1', type: 'decompose', from: 'root', to: 'q2' },
        { id: 'er-1', type: 'resolve', from: 'q2', to: 'o1' },
        { id: 'er-2', type: 'resolve', from: 'q2', to: 'o2' },
      ],
      comments: [],
      dirtyPaths: [],
      review: null,
      converged: false,
      createdAt: 'T0',
      updatedAt: 'T0',
      ...overrides,
    }
  }

  /** 加宽画布的生长态（bbox 变化——fit 若跟随重算，translate 必变）。 */
  const grownState = makeState({
    nodes: [
      ...makeState().nodes,
      { id: 'o3', type: 'option', content: '方案三', lifecycle: 'draft', createdAt: 'T1' },
    ],
    edges: [...makeState().edges, { id: 'er-3', type: 'resolve', from: 'q2', to: 'o3' }],
    updatedAt: 'T1',
  })

  function planeTransform(wrapper: ReturnType<typeof mount>): string {
    const el = wrapper.find('[data-testid="canvas-plane"]')
    return el.attributes('style') ?? ''
  }

  describe('CanvasGraph 首帧自适应全景', () => {
    it('挂载即适配：视口离开初始档位（fit 首帧执行）', async () => {
      const wrapper = mount(CanvasGraph, { props: { state: makeState(), selectedId: null } })
      // onMounted 内 fit 改 ref，DOM 更新在下一个微任务 flush
      await nextTick()
      const style = planeTransform(wrapper)
      // 初始档位 scale(0.9) 被 fit 覆盖（容器 0 尺寸 → K_MIN 钳位 0.28）
      expect(style).not.toContain('scale(0.9)')
      expect(style).toContain('scale(0.28)')
    })

    it('布局变化跟随重适配：数据生长后 bbox 变化，视口重新 fit', async () => {
      const wrapper = mount(CanvasGraph, { props: { state: makeState(), selectedId: null } })
      const before = planeTransform(wrapper)
      await wrapper.setProps({ state: grownState })
      await nextTick()
      expect(planeTransform(wrapper)).not.toBe(before)
    })

    it('用户滚轮缩放接管后，后续布局变化不再自动重置视口', async () => {
      const wrapper = mount(CanvasGraph, { props: { state: makeState(), selectedId: null } })
      await wrapper.find('[data-testid="canvas-viewport"]').trigger('wheel', { deltaY: -100 })
      await nextTick()
      const afterWheel = planeTransform(wrapper)
      expect(afterWheel).not.toContain('scale(0.28)')

      await wrapper.setProps({ state: grownState })
      await nextTick()
      expect(planeTransform(wrapper)).toBe(afterWheel)
    })

    it('手动 fit 按钮执行适配并接管：后续数据生长不再重置视口', async () => {
      const wrapper = mount(CanvasGraph, { props: { state: makeState(), selectedId: null } })
      // 先滚轮打乱视口（k≠fit 值），再点手动 fit 验证「接管 + 重新适配」双语义
      await wrapper.find('[data-testid="canvas-viewport"]').trigger('wheel', { deltaY: -100 })
      await nextTick()
      await wrapper.find('[data-testid="canvas-fit-view"]').trigger('click')
      await nextTick()
      const afterManualFit = planeTransform(wrapper)
      expect(afterManualFit).toContain('scale(0.28)')

      await wrapper.setProps({ state: grownState })
      await nextTick()
      expect(planeTransform(wrapper)).toBe(afterManualFit)
    })
  })
})

/* ════════ 来源：canvas-node-card.test.ts ════════ */

describe('CanvasNodeCard', () => {
  const pos: LayoutPos = { x: 10, y: 20, w: 200, h: 60 }

  function makeNode(overrides: Partial<CanvasNode> = {}): CanvasNode {
    return {
      id: 'o1',
      type: 'option',
      content: '混合形态方案',
      lifecycle: 'passed',
      createdAt: 'T0',
      ...overrides,
    }
  }

  const emptyArgs: HostArgs = { support: [], object: [] }

  function argNode(id: string, polarity: 'support' | 'object'): CanvasNode {
    return { id, type: 'argument', content: `论据 ${id}`, lifecycle: 'draft', polarity, createdAt: 'T0' }
  }

  function mountCard(node: CanvasNode, extra: Record<string, unknown> = {}) {
    return mount(CanvasNodeCard, {
      props: {
        node,
        pos,
        args: emptyArgs,
        canDispatch: false,
        dirty: false,
        commentCount: 0,
        pendingComments: 0,
        focused: false,
        rebuttedIds: new Set<string>(),
        rejectedKids: 0,
        collapsed: false,
        ...extra,
      },
    })
  }

  describe('CanvasNodeCard 类型与生命周期视觉通道', () => {
    it('question 卡 Q 徽标 + 类型词条；option 卡 O 徽标', () => {
      const q = mountCard(makeNode({ id: 'q1', type: 'question', content: '根问题' }))
      expect(q.find('[data-node-id="q1"]').exists()).toBe(true)
      expect(q.get('[data-testid="canvas-node-title"]').text()).toContain('根问题')
      expect(q.get('b').text()).toBe('Q')

      const o = mountCard(makeNode())
      expect(o.get('b').text()).toBe('O')
    })

    it.each(['draft', 'under-review', 'passed', 'rejected', 'shelved'] as const)('生命周期 %s → 边框/透明度通道 + data-lifecycle', (lifecycle) => {
      const wrapper = mountCard(makeNode({ lifecycle }))
      const root = wrapper.get('[data-node-id="o1"]')
      expect(root.attributes('data-lifecycle')).toBe(lifecycle)
      const cls = root.classes().join(' ')
      if (lifecycle === 'draft') expect(cls).toContain('border-dashed')
      if (lifecycle === 'under-review') expect(cls).toContain('border-warn')
      if (lifecycle === 'passed') expect(cls).not.toContain('border-warn')
      if (lifecycle === 'rejected') expect(cls).toContain('opacity-55')
      if (lifecycle === 'shelved') expect(cls).toContain('opacity-70')
    })

    it('rejected 卡标题删除线 + 状态点 title 随生命周期', () => {
      const wrapper = mountCard(makeNode({ lifecycle: 'rejected' }))
      expect(wrapper.get('[data-testid="canvas-node-title"]').classes().join(' ')).toContain('line-through')
      expect(wrapper.get('[data-testid="canvas-node-status-dot"]').attributes('title')).toBeTruthy()
    })

    it('待重审角标（dirty）与评论气泡（含待响应醒目）按 props 出现', () => {
      const plain = mountCard(makeNode())
      expect(plain.find('[data-testid="canvas-node-recheck-badge"]').exists()).toBe(false)
      expect(plain.find('[data-testid="canvas-node-comments-badge"]').exists()).toBe(false)

      const marked = mountCard(makeNode(), { dirty: true, commentCount: 2, pendingComments: 1 })
      expect(marked.get('[data-testid="canvas-node-recheck-badge"]').exists()).toBe(true)
      expect(marked.get('[data-testid="canvas-node-comments-badge"]').text()).toBe('2')
    })
  })

  describe('CanvasNodeCard 否决折叠 chip', () => {
    it('rejectedKids > 0 渲染 chip；点击上抛 toggle-collapse；collapsed 切换箭头', async () => {
      const expanded = mountCard(makeNode({ lifecycle: 'rejected' }), { rejectedKids: 3, collapsed: false })
      const chip = expanded.get('[data-testid="canvas-node-rejected-chip"]')
      expect(chip.text()).toContain('▾')
      await chip.trigger('click')
      expect(expanded.emitted('toggle-collapse')).toHaveLength(1)

      const collapsed = mountCard(makeNode({ lifecycle: 'rejected' }), { rejectedKids: 3, collapsed: true })
      expect(collapsed.get('[data-testid="canvas-node-rejected-chip"]').text()).toContain('▸')
    })

    it('rejectedKids = 0 无 chip（否决折叠只在有否决子节点时出现）', () => {
      const wrapper = mountCard(makeNode())
      expect(wrapper.find('[data-testid="canvas-node-rejected-chip"]').exists()).toBe(false)
    })
  })

  describe('CanvasNodeCard 论据条', () => {
    it('support / object 论据分组各自渲染；条目选中上抛 select', async () => {
      const wrapper = mountCard(makeNode(), {
        args: { support: [argNode('a1', 'support')], object: [argNode('a2', 'object')] },
      })
      const strips = wrapper.findAllComponents(CanvasArgStrip)
      expect(strips).toHaveLength(2)

      await strips[0].vm.$emit('select', 'a1')
      await strips[1].vm.$emit('select', 'a2')
      const ids = wrapper.emitted('select')?.map((args) => args[0])
      expect(ids).toEqual(['a1', 'a2'])
    })

    it('无论据时无论据条', () => {
      const wrapper = mountCard(makeNode())
      expect(wrapper.findAllComponents(CanvasArgStrip)).toHaveLength(0)
    })
  })

  describe('CanvasNodeCard 派发通道（不变量 7 的 UI 预判）', () => {
    it('已派发 → 徽标（带指针 title），无派发按钮', () => {
      const wrapper = mountCard(makeNode({ dispatch: { pointer: 'docs/design/x.md', dispatchedAt: 'T1' } }), { canDispatch: true })
      expect(wrapper.get('[data-testid="canvas-node-dispatched-badge"]').attributes('title')).toBe('docs/design/x.md')
      expect(wrapper.find('[data-testid="canvas-node-dispatch-button"]').exists()).toBe(false)
    })

    it('执行叶子 + passed + 未派发 + canDispatch → 派发按钮；点击上抛 dispatch(nodeId)', async () => {
      const wrapper = mountCard(makeNode(), { canDispatch: true })
      await wrapper.get('[data-testid="canvas-node-dispatch-button"]').trigger('click')
      expect(wrapper.emitted('dispatch')?.[0]).toEqual(['o1'])
    })

    it('canDispatch = false → 无派发按钮（权限前置由父层判定，卡不越权展示）', () => {
      const wrapper = mountCard(makeNode())
      expect(wrapper.find('[data-testid="canvas-node-dispatch-button"]').exists()).toBe(false)
    })
  })
})

/* ════════ 来源：canvas-pane.test.ts（主文件） ════════ */

describe('CanvasPane', () => {
  /** 画布归属会话 id（D4：CanvasPane 以 props.sessionId 为分区键与 RPC 归属字段）。 */
  const SID = 'sid-pane'

  /** 当前 canvas.get 应答（用例内可换——模拟广播失效重拉收敛）。 */
  let currentState: CanvasState

  /** 最小合法画布：根 → 子问题 → 两候选（o2 预置待重审 + 待响应评论）。 */
  function makeState(overrides: Partial<CanvasState> = {}): CanvasState {
    return {
      canvasId: 'cvs-1',
      ownerSessionId: SID,
      name: '画布规划',
      root: { nodeId: 'root', statement: '根问题', criterias: ['判据一'], scopeExclusions: ['不做多画布'] },
      direction: null,
      nodes: [
        { id: 'root', type: 'question', content: '根问题怎么解', lifecycle: 'draft', createdAt: 'T0' },
        { id: 'q2', type: 'question', content: '子问题拆解', lifecycle: 'draft', createdAt: 'T0' },
        { id: 'o1', type: 'option', content: '方案一', lifecycle: 'draft', createdAt: 'T0' },
        { id: 'o2', type: 'option', content: '方案二', lifecycle: 'under-review', createdAt: 'T0' },
        { id: 'a1', type: 'argument', content: '支持论据', lifecycle: 'draft', polarity: 'support', materiality: 'fact', factVerified: true, createdAt: 'T0' },
      ],
      edges: [
        { id: 'ed-1', type: 'decompose', from: 'root', to: 'q2' },
        { id: 'er-1', type: 'resolve', from: 'q2', to: 'o1' },
        { id: 'er-2', type: 'resolve', from: 'q2', to: 'o2' },
        { id: 'ea-1', type: 'argue', from: 'a1', to: 'o1', polarity: 'support' },
      ],
      comments: [{ id: 'cm-1', anchorId: 'o2', text: '会挤占独立窗口吗', status: 'pending', createdAt: 'T0' }],
      dirtyPaths: ['q2'],
      review: null,
      converged: false,
      createdAt: 'T0',
      updatedAt: 'T0',
      ...overrides,
    }
  }

  /** command 按 type 分流：list 空清单 / get 当前态 / mutate 成功回执（失败形态用例内覆盖）。 */
  function stubCommand(): void {
    commandMock.mockImplementation(async (type: never) => {
      if (type === 'canvas.list') return { canvases: [] }
      if (type === 'canvas.get') return currentState
      if (type === 'canvas.mutate') {
        return { ok: true as const, eventId: 'ev-1', evType: 'OptionSelected' as const, summary: '已选定方案一' }
      }
      throw new Error(`unexpected command: ${String(type)}`)
    })
  }

  /** 在挂实例登记（对话框 teleport 到 body——跨用例残留会互相污染查询，afterEach 统一卸载）。 */
  const mounted: VueWrapper[] = []

  async function mountPane(canvasId = 'cvs-1'): Promise<VueWrapper> {
    const wrapper = mount(CanvasPane, { props: { canvasId, sessionId: SID } })
    mounted.push(wrapper)
    await flushPromises()
    return wrapper
  }

  function cardEl(wrapper: VueWrapper, nodeId: string): Element | null {
    return wrapper.find(`[data-node-id="${nodeId}"]`).element ?? null
  }

  /** 对话框经 reka DialogPortal teleport 到 body：统一从 body 查（RenameSessionDialog.test.ts 先例）。 */
  function bodyEl(testId: string): Element | null {
    return document.body.querySelector(`[data-testid="${testId}"]`)
  }

  /** 对话框内字段注入值（v-model 走真实 input 事件链）。 */
  async function setDialogField(testId: string, value: string): Promise<void> {
    const el = bodyEl(testId) as HTMLTextAreaElement | HTMLInputElement | null
    expect(el, `对话框字段 ${testId} 应存在`).not.toBeNull()
    el!.value = value
    el!.dispatchEvent(new Event('input'))
    await nextTick()
  }

  /** 点对话框提交按钮（Portal 内容不在 wrapper 子树，走 body）。 */
  async function submitDialog(): Promise<void> {
    const btn = bodyEl('canvas-op-submit') as HTMLButtonElement | null
    expect(btn, '提交按钮应存在').not.toBeNull()
    btn!.click()
    await flushPromises()
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    commandMock.mockReset()
    currentState = makeState()
    stubCommand()
  })

  afterEach(() => {
    for (const w of mounted.splice(0)) w.unmount()
    document.body.innerHTML = ''
  })

  describe('CanvasPane 节点渲染（使用者可见 DOM）', () => {
    it('主干节点卡渲染：标题 / 类型 / 生命周期可见；根与子问题、两候选齐全', async () => {
      const wrapper = await mountPane()
      expect(wrapper.find('[data-testid="canvas-pane"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="canvas-pane-title"]').text()).toBe('画布规划')
      expect(cardEl(wrapper, 'root')?.textContent).toContain('根问题怎么解')
      expect(cardEl(wrapper, 'q2')).not.toBeNull()
      expect(cardEl(wrapper, 'o1')?.textContent).toContain('方案一')
      expect(cardEl(wrapper, 'o2')?.getAttribute('data-lifecycle')).toBe('under-review')
      // 主干边 SVG 在场（decompose + resolve）
      expect(wrapper.find('[data-testid="canvas-edge-decompose"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="canvas-edge-resolve"]').exists()).toBe(true)
    })

    it('选定方案高亮与待重审角标（契约字段的直接投影）', async () => {
      currentState = makeState({
        nodes: makeState().nodes.map((n) => (n.id === 'o1' ? { ...n, selected: true } : n)),
      })
      const wrapper = await mountPane()
      expect(cardEl(wrapper, 'o1')?.getAttribute('data-selected')).toBe('true')
      expect(cardEl(wrapper, 'o2')?.getAttribute('data-selected')).toBe('false')
      // 待重审专属角标：q2 在 dirtyPaths → 角标可见（门禁③的可感知通道）
      const q2 = wrapper.find('[data-node-id="q2"]')
      expect(q2.find('[data-testid="canvas-node-recheck-badge"]').exists()).toBe(true)
      expect(q2.find('[data-testid="canvas-node-recheck-badge"]').text()).toBe('待重审')
      expect(wrapper.find('[data-node-id="root"] [data-testid="canvas-node-recheck-badge"]').exists()).toBe(false)
    })

    it('论据条收于宿主卡内：支持条 + fact 核实角标；评论计数气泡带待响应态', async () => {
      const wrapper = await mountPane()
      const o1 = wrapper.find('[data-node-id="o1"]')
      expect(o1.find('[data-testid="canvas-arg-strip-support"]').exists()).toBe(true)
      expect(o1.find('[data-testid="canvas-arg-row"]').text()).toContain('支持论据')
      expect(o1.find('[data-testid="canvas-arg-verified-ok"]').exists()).toBe(true)
      // o2 有待响应评论：气泡计数 + warn 态
      const o2 = wrapper.find('[data-node-id="o2"]')
      expect(o2.find('[data-testid="canvas-node-comments-badge"]').text()).toBe('1')
    })

    it('未选中时详情面板空态引导可见；点击节点卡出详情', async () => {
      const wrapper = await mountPane()
      expect(wrapper.find('[data-testid="canvas-detail-empty"]').exists()).toBe(true)
      await wrapper.find('[data-node-id="o1"]').trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-testid="canvas-detail-empty"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="canvas-detail-title"]').text()).toBe('方案一')
    })
  })

  describe('CanvasPane 选定交互走 mutate（无乐观回显）', () => {
    it('选定提交：canvas.mutate actor=user + select params 契约形状；成功回显仅在重新拉取后出现', async () => {
      const wrapper = await mountPane()
      // 点开方案一 → 详情 → 选定按钮 → 对话框
      await wrapper.find('[data-node-id="o1"]').trigger('click')
      await flushPromises()
      await wrapper.find('[data-testid="canvas-action-select"]').trigger('click')
      await flushPromises()
      await nextTick()
      expect(bodyEl('canvas-op-dialog'), '操作对话框应打开').not.toBeNull()

      // 必填拦截：理由为空不提交
      await submitDialog()
      expect(commandMock).not.toHaveBeenCalledWith('canvas.mutate', expect.anything(), expect.anything())

      // 填理由提交
      await setDialogField('canvas-op-field-reason', '成本与可控性更优')
      await submitDialog()

      expect(commandMock).toHaveBeenCalledWith(
        'canvas.mutate',
        {
          actor: 'user',
          sessionId: SID,
          action: 'select',
          params: { canvasId: 'cvs-1', questionId: 'q2', optionId: 'o1', reason: '成本与可控性更优' },
        },
        expect.any(Number),
      )

      // 无乐观回显：mutate 成功后、广播刷新前，卡片仍是未选定（store 未被本地改写）
      expect(cardEl(wrapper, 'o1')?.getAttribute('data-selected')).toBe('false')

      // 广播回返 → store 重新拉取 → 成功才呈现
      currentState = makeState({
        nodes: makeState().nodes.map((n) => (n.id === 'o1' ? { ...n, selected: true, selectionReason: '成本与可控性更优' } : n)),
      })
      const store = (await import('@/stores/canvas')).useCanvasStore(computed(() => SID))
      await store.loadCanvas('cvs-1')
      await flushPromises()
      expect(cardEl(wrapper, 'o1')?.getAttribute('data-selected')).toBe('true')
    })

    it('换选形态：对话框呈现旧选定告知，提交携带 replace 迁移语义', async () => {
      currentState = makeState({
        nodes: makeState().nodes.map((n) => (n.id === 'o2' ? { ...n, selected: true } : n)),
      })
      const wrapper = await mountPane()
      await wrapper.find('[data-node-id="o1"]').trigger('click')
      await flushPromises()
      await wrapper.find('[data-testid="canvas-action-select"]').trigger('click')
      await flushPromises()
      await nextTick()
      expect(bodyEl('canvas-op-replace-hint')?.textContent).toContain('方案二')

      await setDialogField('canvas-op-field-reason', '换选理由')
      await submitDialog()

      expect(commandMock).toHaveBeenCalledWith(
        'canvas.mutate',
        expect.objectContaining({
          actor: 'user',
          action: 'select',
          params: expect.objectContaining({ optionId: 'o1', replace: { fromOptionId: 'o2' } }),
        }),
        expect.any(Number),
      )
    })

    it('mutate 失败：结构化错误呈现（错误 + 恢复动作 toast 入列），无本地回显', async () => {
      commandMock.mockImplementation(async (type: never) => {
        if (type === 'canvas.list') return { canvases: [] }
        if (type === 'canvas.get') return currentState
        if (type === 'canvas.mutate') {
          return { ok: false as const, error: { code: 'selection_conflict', message: '该问题已有选定方案', recover: '换选走 replace 参数' } }
        }
        throw new Error(`unexpected command: ${String(type)}`)
      })
      const { useToast } = await import('@/composables/useToast')
      const { toasts } = useToast()
      const wrapper = await mountPane()
      await wrapper.find('[data-node-id="o1"]').trigger('click')
      await flushPromises()
      await wrapper.find('[data-testid="canvas-action-select"]').trigger('click')
      await flushPromises()
      await nextTick()
      await setDialogField('canvas-op-field-reason', '理由')
      await submitDialog()

      // 失败 toast 含原因与恢复动作（无乐观回显——卡片选中态不变）
      const last = toasts.value[toasts.value.length - 1]
      expect(last?.type).toBe('error')
      expect(last?.message).toContain('该问题已有选定方案')
      expect(last?.message).toContain('换选走 replace 参数')
      expect(cardEl(wrapper, 'o1')?.getAttribute('data-selected')).toBe('false')
    })
  })

  describe('CanvasBindingBadge（绑定徽标状态）', () => {
    it('count=null（reply 缺字段兼容）不渲染徽标——未知不呈现', () => {
      const wrapper = mount(CanvasBindingBadge, { props: { count: null } })
      expect(wrapper.find('[data-testid="canvas-binding-badge"]').exists()).toBe(false)
    })

    it('空集合明示「当前无 agent 在响应」（重启后重绑入口的感知锚）', () => {
      const wrapper = mount(CanvasBindingBadge, { props: { count: 0 } })
      const badge = wrapper.find('[data-testid="canvas-binding-badge"]')
      expect(badge.exists()).toBe(true)
      expect(badge.attributes('data-binding')).toBe('none')
      expect(badge.text()).toBe('当前无 agent 在响应')
    })

    it('非空集合显示在响应会话数', () => {
      const wrapper = mount(CanvasBindingBadge, { props: { count: 2 } })
      const badge = wrapper.find('[data-testid="canvas-binding-badge"]')
      expect(badge.attributes('data-binding')).toBe('active')
      expect(badge.text()).toBe('2 个会话在响应')
    })

    it('画布头部接线：activeBindings 随 canvas.get reply 到达——空集合明示「当前无 agent 在响应」', async () => {
      currentState = makeState({ activeBindings: 0 })
      const wrapper = await mountPane()
      const badge = wrapper.find('[data-testid="canvas-binding-badge"]')
      expect(badge.exists()).toBe(true)
      expect(badge.attributes('data-binding')).toBe('none')
      expect(badge.text()).toBe('当前无 agent 在响应')
    })

    it('画布头部接线：非空集合徽标显示在响应会话数', async () => {
      currentState = makeState({ activeBindings: 2 })
      const wrapper = await mountPane()
      const badge = wrapper.find('[data-testid="canvas-binding-badge"]')
      expect(badge.attributes('data-binding')).toBe('active')
      expect(badge.text()).toBe('2 个会话在响应')
    })

    it('画布头部：reply 缺 activeBindings 字段（marker 通道形态 / 旧 runtime）徽标不出现——未知不呈现', async () => {
      // makeState 默认不带 activeBindings（optional 字段缺失）
      const wrapper = await mountPane()
      expect(wrapper.find('[data-testid="canvas-binding-badge"]').exists()).toBe(false)
    })
  })

  describe('审查报告 tab 头部结构化计数', () => {
    it('计数行 = 条目总数 + 未处置 must-fix 数（摘要条裁决落地：头部只留计数，散文总结只在条目正文）', async () => {
      currentState = makeState({
        review: {
          status: 'in-progress',
          round: 2,
          maxRounds: 5,
          entries: [
            { id: 'rv-1', round: 1, dimension: 'completeness', severity: 'must-fix', targetId: 'q2', note: '缺一条分支', resolution: { disposition: 'accepted', by: 'agent', note: '已补' } },
            { id: 'rv-2', round: 2, dimension: 'support', severity: 'must-fix', targetId: 'er-1', note: '支撑缺口未附论据链' },
            { id: 'rv-3', round: 2, dimension: 'depth', severity: 'suggestion', targetId: 'o2', note: '分支过浅' },
          ],
        },
      })
      stubCommand()
      const wrapper = await mountPane()
      const counts = wrapper.find('[data-testid="canvas-review-entry-counts"]')
      expect(counts.exists()).toBe(true)
      // 3 条目中 1 条已处置 → 未处置 must-fix = 1（rv-2；rv-1 已处置不计、rv-3 是 suggestion）
      expect(counts.text()).toBe('条目 3 · 未处置 must-fix 1')
    })

    it('已处置 must-fix 与 suggestion 都不计入未处置计数', async () => {
      currentState = makeState({
        review: {
          status: 'in-progress',
          round: 1,
          maxRounds: 5,
          entries: [
            { id: 'rv-1', round: 1, dimension: 'completeness', severity: 'must-fix', targetId: 'q2', note: '缺分支', resolution: { disposition: 'accepted', by: 'user', note: '已补' } },
            { id: 'rv-2', round: 1, dimension: 'depth', severity: 'suggestion', targetId: 'o2', note: '过浅' },
          ],
        },
      })
      stubCommand()
      const wrapper = await mountPane()
      expect(wrapper.find('[data-testid="canvas-review-entry-counts"]').text()).toBe('条目 2 · 未处置 must-fix 0')
    })
  })

  describe('导出面板门禁区阻断清单（门禁②逐项呈现裁决）', () => {
    it('未收敛且带 convergenceBlockers → 清单逐项呈现（导出前可见具体缺口）', async () => {
      currentState = makeState({
        convergenceBlockers: [
          '就绪递归未成立（根未就绪：存在无选定方案或子树未就绪的问题）',
          '画布没有执行叶子（无 dispatchable 标记的选定方案），无交付单元',
        ],
      })
      stubCommand()
      const wrapper = await mountPane()
      const block = wrapper.find('[data-testid="canvas-export-blockers"]')
      expect(block.exists()).toBe(true)
      const items = wrapper.findAll('[data-testid="canvas-export-blocker"]')
      expect(items).toHaveLength(2)
      expect(items[0]?.text()).toContain('就绪递归未成立')
      expect(items[1]?.text()).toContain('没有执行叶子')
    })

    it('缺 convergenceBlockers 字段（marker 通道形态 / 旧 runtime）→ 清单不渲染，②格退回措辞形态', async () => {
      currentState = makeState()
      stubCommand()
      const wrapper = await mountPane()
      expect(wrapper.find('[data-testid="canvas-export-blockers"]').exists()).toBe(false)
    })
  })
})
