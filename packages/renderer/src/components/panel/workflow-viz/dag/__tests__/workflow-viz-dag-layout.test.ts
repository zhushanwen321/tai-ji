/**
 * WorkflowVizDag 布局纯函数单测（构建者白盒视角；workflow-visualization U4）。
 *
 * 布局规则 = 设计 §3.2 渲染选型 A「按 phase 列分区，调用点按词法序排列」：
 * - 分区列 WorkflowDagPhase.order 升序从左到右；
 * - 分区内节点按 templateName 词法序（codepoint）垂直排列；
 * - 节点归属分区缺失 → 动态补尾部分区（节点不丢弃）；
 * - 零节点 run → 空布局 + 最小占位（渲染层出摘要卡）；
 * - 边几何：顺序/数据流/条件 = 源右中心→目标左中心贝塞尔；loop-back = 底部下绕弧；
 *   端点缺失的边跳过不抛。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/workflow-viz/dag/__tests__/workflow-viz-dag-layout.test.ts
 */
import { describe, it, expect } from 'vitest'
import type { WorkflowDag, WorkflowDagNode } from '@taiji/shared'
import { layoutDag, layoutEdges, DAG_NODE_W, DAG_NODE_H } from '../layout'

function node(partial: Partial<WorkflowDagNode> & { id: string }): WorkflowDagNode {
  return {
    kind: 'agent',
    templateName: partial.id,
    matchPattern: '',
    phase: 'p0',
    line: 1,
    ...partial,
  }
}

function dag(partial: Partial<WorkflowDag> = {}): WorkflowDag {
  return {
    nodes: [],
    edges: [],
    phases: [],
    parallelGroups: [],
    loops: [],
    ...partial,
  }
}

describe('layoutDag 列式布局（白盒）', () => {
  it('分区列按 order 升序从左到右排列，列间留水平间距', () => {
    const result = layoutDag(dag({
      phases: [
        { name: 'review', order: 1 },
        { name: 'gate', order: 0 },
      ],
    }))
    expect(result.clusters.map((c) => c.phase)).toEqual(['gate', 'review'])
    const [first, second] = result.clusters
    expect(second.x).toBeGreaterThan(first.x + first.width)
  })

  it('分区内节点按 templateName 词法序垂直排列（同一分区列内）', () => {
    const result = layoutDag(dag({
      phases: [{ name: 'p0', order: 0 }],
      nodes: [
        node({ id: 'b', templateName: 'reviewer-types' }),
        node({ id: 'a', templateName: 'reviewer-biz' }),
        node({ id: 'c', templateName: 'reviewer-security' }),
      ],
    }))
    const ys = result.nodes.map((ln) => ln.y)
    // 词法序：reviewer-biz(a) < reviewer-security(c) < reviewer-types(b)
    expect(result.nodes.map((ln) => ln.node.id)).toEqual(['a', 'c', 'b'])
    // 垂直步进：后一节点在前一节点下方（步进 ≥ 节点高，同列不重叠）
    expect(ys[1]).toBeGreaterThan(ys[0])
    expect(ys[2]).toBeGreaterThan(ys[1])
    expect(ys[1] - ys[0]).toBeGreaterThanOrEqual(DAG_NODE_H)
    // 全部节点 x 一致（同列）且含分区左内边距
    expect(new Set(result.nodes.map((ln) => ln.x)).size).toBe(1)
  })

  it('同名分区内词法序并列时按 id 决胜（稳定序）', () => {
    const result = layoutDag(dag({
      phases: [{ name: 'p0', order: 0 }],
      nodes: [node({ id: 'n2', templateName: 'same' }), node({ id: 'n1', templateName: 'same' })],
    }))
    expect(result.nodes.map((ln) => ln.node.id)).toEqual(['n1', 'n2'])
  })

  it('节点归属分区缺失 → 动态补尾部分区，节点不丢弃', () => {
    const result = layoutDag(dag({
      phases: [{ name: 'known', order: 0 }],
      nodes: [node({ id: 'a', phase: 'ghost' })],
    }))
    expect(result.clusters.map((c) => c.phase)).toEqual(['known', 'ghost'])
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].node.phase).toBe('ghost')
    expect(result.clusters[1].x).toBeGreaterThan(result.clusters[0].x)
  })

  it('零节点 run：空布局 + 最小占位尺寸（渲染层出摘要卡）', () => {
    const result = layoutDag(dag())
    expect(result.nodes).toHaveLength(0)
    expect(result.clusters).toHaveLength(0)
    expect(result.width).toBeGreaterThan(0)
    expect(result.height).toBeGreaterThan(0)
  })

  it('分区高度随节点行数增长（行多时覆盖节点堆叠高度）', () => {
    const nodes = Array.from({ length: 5 }, (_, i) => node({ id: `n${i}`, templateName: `agent-${i}` }))
    const result = layoutDag(dag({ phases: [{ name: 'p0', order: 0 }], nodes }))
    expect(result.clusters[0].height).toBeGreaterThanOrEqual(DAG_NODE_H * 5)
  })
})

describe('layoutEdges 边几何（白盒）', () => {
  it('顺序边：源右边缘中心 → 目标左边缘中心', () => {
    const nodes = [node({ id: 'a' }), node({ id: 'b' })]
    const d = dag({
      phases: [{ name: 'p0', order: 0 }, { name: 'p1', order: 1 }],
      nodes: [
        { ...nodes[0], phase: 'p0' },
        { ...nodes[1], phase: 'p1' },
      ],
      edges: [{ id: 'e1', from: 'a', to: 'b', kind: 'sequence' }],
    })
    const layout = layoutDag(d)
    const [la, lb] = layout.nodes
    const [edge] = layoutEdges(d, layout.nodes)
    const expected = `M ${la.x + DAG_NODE_W} ${la.y + DAG_NODE_H / 2}`
    expect(edge.d.startsWith(expected)).toBe(true)
    expect(edge.d.endsWith(`${lb.x} ${lb.y + DAG_NODE_H / 2}`)).toBe(true)
    expect(edge.labelX).toBeDefined()
    expect(edge.labelY).toBeDefined()
  })

  it('loop-back 边：下绕弧（起点锚在 from 节点底边）', () => {
    const d = dag({
      phases: [{ name: 'p0', order: 0 }],
      nodes: [node({ id: 'a' }), node({ id: 'b' })],
      edges: [{ id: 'loop', from: 'b', to: 'a', kind: 'loop-back' }],
    })
    const layout = layoutDag(d)
    const [lb] = layout.nodes.filter((ln) => ln.node.id === 'b')
    const [edge] = layoutEdges(d, layout.nodes)
    // d 形态 `M bx fromBottom C ...`：起点 = from 节点底边
    const parts = edge.d.split(' ')
    expect(parts[0]).toBe('M')
    expect(Number(parts[2])).toBe(lb.y + DAG_NODE_H)
    expect(edge.labelX).toBeUndefined()
  })

  it('端点缺失的边跳过不抛（防御解析器缺口）', () => {
    const d = dag({
      phases: [{ name: 'p0', order: 0 }],
      nodes: [node({ id: 'a' })],
      edges: [{ id: 'e-bad', from: 'a', to: 'missing', kind: 'sequence' }],
    })
    const layout = layoutDag(d)
    expect(() => layoutEdges(d, layout.nodes)).not.toThrow()
    expect(layoutEdges(d, layout.nodes)).toHaveLength(0)
  })
})
