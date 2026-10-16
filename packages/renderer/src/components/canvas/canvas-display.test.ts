/**
 * canvas 展示派生单测（problem-solve-canvas §3.1(3) U7）。
 *
 * 覆盖：阶段枚举（契约派生口径三分支）/ must-fix 开放投影 / 主干关系投影
 * （kids/parent/选定反查）/ 论据分组与互驳 / 评论锚定 / 布局（分层、子树居中、
 * 隐藏子树让位、负 x 归一）/ 边路径形状。
 *
 * 驱动方式：纯函数直驱（无 mock、无 DOM）。运行：
 * cd packages/renderer && npx vitest run src/components/canvas/canvas-display.test.ts
 */
import { describe, expect, it } from 'vitest'
import type { CanvasState } from '@zhushanwen/extension-protocol'
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
