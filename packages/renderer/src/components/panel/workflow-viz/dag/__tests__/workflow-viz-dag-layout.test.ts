/**
 * WorkflowVizDag 布局纯函数单测（构建者白盒视角；workflow-visualization U4）。
 *
 * 布局规则 = 设计 §3.2 渲染选型 A「按 phase 列分区，调用点按词法序排列」：
 * - 分区列 WorkflowDagPhase.order 升序从左到右；
 * - 分区内节点按 templateName 词法序（codepoint）垂直排列；
 * - 节点归属分区缺失 → 动态补尾部分区（节点不丢弃）；
 * - 零节点 run → 空布局 + 最小占位（渲染层出居中摘要提示，无独立卡片容器）；
 * - 节点高度：≥2 实例的调用点按 dagNodeHeight 增高（实例行画进节点），经
 *   nodeHeights 表传入布局；
 * - 边几何（正交路由）：锚点只取节点四条边的中点（4 个连线点）；顺序/数据流/条件
 *   = 源右中心→通道竖线→目标左中心的三段折线（同行退化直线），同通道并行边按错开位
 *   错开不重合；loop-back 底边中点垂直进出（跨列两端下方无堆叠时四折点直连，被
 *   同列堆叠挡住才走侧向细道 + 底边下空隙带，同列 U 形折返，自环边不产出几何），
 *   任何段不穿节点；全部折点严格轴对齐（横竖两向不变量）；
 * - fit-to-view：computeFitTransform 内容四周留 FIT_PAD_PX 居中（k 封顶 1 不放大）；
 * - 端点缺失的边跳过不抛。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/workflow-viz/dag/__tests__/workflow-viz-dag-layout.test.ts
 */
import { describe, it, expect } from 'vitest'
import type { WorkflowDag, WorkflowDagNode } from '@taiji/shared'
import type { DagLayout, DagLayoutEdge, DagLayoutNode, ChannelMember } from '../layout'
import {
  layoutDag,
  layoutEdges,
  computeFitTransform,
  dagNodeHeight,
  avoidObstructedChannelMid,
  DAG_NODE_W,
  DAG_NODE_H,
  INSTANCE_ROW_H,
  FIT_PAD_PX,
  ZOOM_MIN,
  LANE_STEP_PX,
} from '../layout'

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

  it('零节点 run：空布局 + 最小占位尺寸（居中摘要提示的底板）', () => {
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

/**
 * 轴对齐不变量断言：相邻折点恒共享 x 或 y（正交路由「只有横竖」的结构性保证——
 * 不逐字串断 d 形态，改断路由折点序列的几何性质，圆角过渡不破坏轴对齐）。
 */
function expectAxisAligned(points: Array<{ x: number; y: number }>): void {
  expect(points.length).toBeGreaterThanOrEqual(2)
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]
    const cur = points[i]
    expect(prev.x === cur.x || prev.y === cur.y).toBe(true)
  }
}

/**
 * 路由画布一体的取样样板：构造 dag → 布局 → 装配边 → 按 id 索引节点几何。
 * geo 取代的 filter 取样缺 id 时返回 undefined，用例内以非空断言取值——边有产出
 * 即端点必然在布局内，缺端点时后续属性访问抛错让用例失败（语义自暴露）。
 */
function buildRoutedCanvas(partial: Partial<WorkflowDag> = {}): {
  d: WorkflowDag
  layout: DagLayout
  geo: Map<string, DagLayoutNode>
  edges: DagLayoutEdge[]
} {
  const d = dag(partial)
  const layout = layoutDag(d)
  return {
    d,
    layout,
    geo: new Map(layout.nodes.map((ln) => [ln.node.id, ln])),
    edges: layoutEdges(d, layout.nodes),
  }
}

/** 全图最深节点底（loop-back 横行总线 y 的断言锚）。 */
function deepestBottomOf(layout: DagLayout): number {
  return Math.max(...layout.nodes.map((ln) => ln.y + ln.h))
}

/**
 * 跨列路由用例共用底座：3 phase（p0/p1/p2）× 4 节点（a→p0，r1/r2→p1，f→p2）。
 * p1 列预置 r2 作堆叠遮挡、f 压底（词法序最后），edges 由用例注入。
 */
function crossColumnCanvas(edges: WorkflowDag['edges']): Partial<WorkflowDag> {
  return {
    phases: [
      { name: 'p0', order: 0 },
      { name: 'p1', order: 1 },
      { name: 'p2', order: 2 },
    ],
    nodes: [
      node({ id: 'a', phase: 'p0' }),
      node({ id: 'r1', templateName: 'ra', phase: 'p1' }),
      node({ id: 'r2', templateName: 'rb', phase: 'p1' }),
      node({ id: 'f', templateName: 'zz', phase: 'p2' }),
    ],
    edges,
  }
}

describe('layoutEdges 正交路由（白盒）', () => {
  it('顺序边：锚点 = 源右边缘中心 → 目标左边缘中心，d 无三次贝塞尔（C 指令）', () => {
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
    expect(edge.points[0]).toEqual({ x: la.x + DAG_NODE_W, y: la.y + DAG_NODE_H / 2 })
    expect(edge.points[edge.points.length - 1]).toEqual({ x: lb.x, y: lb.y + DAG_NODE_H / 2 })
    expect(edge.d).not.toContain('C ')
    expect(edge.labelX).toBeDefined()
    expect(edge.labelY).toBeDefined()
  })

  it('不同行顺序边：经中位竖线的三段折线，全部折点轴对齐（横竖不变量）', () => {
    const d = dag({
      phases: [{ name: 'p0', order: 0 }, { name: 'p1', order: 1 }],
      nodes: [
        node({ id: 'a', phase: 'p0' }),
        node({ id: 'b', templateName: 'zb', phase: 'p1' }),
        node({ id: 'c', templateName: 'zc', phase: 'p1' }),
      ],
      // c 在 p1 列第二行（与 a 不同行）→ 走中位竖线折线
      edges: [{ id: 'e1', from: 'a', to: 'c', kind: 'dataflow' }],
    })
    const layout = layoutDag(d)
    const [la] = layout.nodes.filter((ln) => ln.node.id === 'a')
    const [lc] = layout.nodes.filter((ln) => ln.node.id === 'c')
    const [edge] = layoutEdges(d, layout.nodes)
    expect(edge.points).toHaveLength(4)
    expectAxisAligned(edge.points)
    // 独占通道的边错开位 = 默认中位（两锚点中位，竖线落在列间距带内）
    expect(edge.points[1].x).toBe((la.x + DAG_NODE_W + lc.x) / 2)
    expect(edge.points[1].x).toBe(edge.points[2].x)
  })

  it('同行边退化为直线（2 折点，无竖直段）', () => {
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
    const [edge] = layoutEdges(d, layout.nodes)
    // 两分区各 1 节点，同列高 → y 相等 → 直线
    expect(edge.points).toHaveLength(2)
    expect(edge.points[0].y).toBe(edge.points[1].y)
    expectAxisAligned(edge.points)
  })

  it('loop-back 边：横行走全图最深节点下方总线（不穿任何节点），起终锚在两节点底边', () => {
    const { layout, geo, edges } = buildRoutedCanvas({
      phases: [{ name: 'p0', order: 0 }, { name: 'p1', order: 1 }],
      nodes: [
        node({ id: 'a', phase: 'p0' }),
        node({ id: 'b', templateName: 'zb', phase: 'p1' }),
        node({ id: 'c', templateName: 'zc', phase: 'p1' }),
      ],
      edges: [{ id: 'loop', from: 'b', to: 'a', kind: 'loop-back' }],
    })
    const lb = geo.get('b')!
    const deepest = deepestBottomOf(layout)
    const [edge] = edges
    expect(edge.points[0].y).toBe(lb.y + lb.h)
    // 横行总线 y 压在全图最深节点底之下（busY = deepest + LOOP_DROP）
    const busY = edge.points[3].y
    expect(busY).toBeGreaterThan(deepest)
    expect(edge.points[3].y).toBe(edge.points[4].y)
    expectAxisAligned(edge.points)
    expect(edge.labelX).toBeUndefined()
  })

  it('跨列 loop-back：下降/上升段走源/目标列侧向细道（节点列之外），不穿同列堆叠节点', () => {
    const { layout, geo, edges } = buildRoutedCanvas(
      crossColumnCanvas([{ id: 'loop', from: 'f', to: 'r1', kind: 'loop-back' }]),
    )
    const lr1 = geo.get('r1')!
    const lf = geo.get('f')!
    const deepest = deepestBottomOf(layout)
    const [edge] = edges
    expect(edge.points).toHaveLength(8)
    expectAxisAligned(edge.points)
    // 上升段 x 在目标列右缘细道（节点右缘之外、分区内边距带 CLUSTER_PAD_X=12 内）
    // ——不再沿目标底中心上升、穿过同列上方堆叠的节点卡片
    const riseX = edge.points[4].x
    expect(riseX).toBeGreaterThan(lr1.x + DAG_NODE_W)
    expect(riseX).toBeLessThan(lr1.x + DAG_NODE_W + 12)
    // 下降段 x 在源列左缘细道
    const dropX = edge.points[2].x
    expect(dropX).toBeGreaterThan(lf.x - 12)
    expect(dropX).toBeLessThan(lf.x)
    // 总线仍压在全图最深节点底之下
    expect(edge.points[3].y).toBeGreaterThan(deepest)
    // 贴边横行段下移进底边下方空隙带（回归锚定：旧实现横行段 y=节点底边，压边框）
    const fromLaneY = edge.points[1].y
    expect(fromLaneY).toBeGreaterThan(lf.y + lf.h)
    expect(fromLaneY).toBeLessThan(lf.y + lf.h + 12)
    const toLaneY = edge.points[6].y
    expect(toLaneY).toBeGreaterThan(lr1.y + lr1.h)
    expect(toLaneY).toBeLessThan(lr1.y + lr1.h + 12)
    // 终锚 = 目标底中心（细道上升 → 空隙带短横 → 底中点收锚）
    expect(edge.points[7]).toEqual({ x: lr1.x + DAG_NODE_W / 2, y: lr1.y + lr1.h })
  })

  it('跨列 loop-back（两端下方无堆叠）：四折点直连，进出垂直于底边中点、节点附近无横行段', () => {
    const { layout, geo, edges } = buildRoutedCanvas(
      crossColumnCanvas([{ id: 'loop', from: 'f', to: 'a', kind: 'loop-back' }]),
    )
    const la = geo.get('a')!
    const lf = geo.get('f')!
    const deepest = deepestBottomOf(layout)
    const [edge] = edges
    // p1 列的 r1/r2 既非端点也不在端点列——两端中轴无遮挡 → 四折点直连
    expect(edge.points).toEqual([
      { x: lf.x + DAG_NODE_W / 2, y: lf.y + lf.h },
      { x: lf.x + DAG_NODE_W / 2, y: deepest + 28 },
      { x: la.x + DAG_NODE_W / 2, y: deepest + 28 },
      { x: la.x + DAG_NODE_W / 2, y: la.y + la.h },
    ])
    expectAxisAligned(edge.points)
  })

  it('自环回边（from===to）：不产出几何（无合法四中点正交环，循环语义由重试状态呈现）', () => {
    const d = dag({
      phases: [{ name: 'p0', order: 0 }],
      nodes: [node({ id: 'a' })],
      edges: [{ id: 'self', from: 'a', to: 'a', kind: 'loop-back' }],
    })
    const layout = layoutDag(d)
    expect(layoutEdges(d, layout.nodes)).toHaveLength(0)
  })

  it('同列前向边：列右缘细道绕行（右中点出 → 右中点入），任何段不穿卡片', () => {
    const d = dag({
      phases: [{ name: 'p0', order: 0 }],
      nodes: [node({ id: 'a' }), node({ id: 'b', templateName: 'zb' })],
      edges: [{ id: 'e-same', from: 'a', to: 'b', kind: 'conditional', predicate: 'commitPlan.stagePaths.length === 0' }],
    })
    const layout = layoutDag(d)
    const [la, lb] = layout.nodes
    const [edge] = layoutEdges(d, layout.nodes)
    expect(edge.points).toHaveLength(4)
    expectAxisAligned(edge.points)
    // 出锚 = 源右中点，入锚 = 目标右中点（朝向细道一侧——入左中点会让末段横线
    // 从右侧细道横穿整张目标卡片，箭头被绘制顺序遮住，回归锚定 dmg-r1-2）
    expect(edge.points[0]).toEqual({ x: la.x + DAG_NODE_W, y: la.y + la.h / 2 })
    expect(edge.points[3]).toEqual({ x: lb.x + DAG_NODE_W, y: lb.y + lb.h / 2 })
    // 末段从细道到入锚的短横线在节点右缘之外（不进入卡片 x 区间）
    expect(edge.points[2].x).toBeGreaterThan(lb.x + DAG_NODE_W)
    // 细道 x 在节点右缘之外、分区内边距带内（CLUSTER_PAD_X=12）——竖线段不穿卡片
    const gutterX = edge.points[1].x
    expect(gutterX).toBe(edge.points[2].x)
    expect(gutterX).toBeGreaterThan(la.x + DAG_NODE_W)
    expect(gutterX).toBeLessThan(la.x + DAG_NODE_W + 12)
    // 谓词标注锚在细道旁（节点列之外，不再落进卡片内部）
    expect(edge.labelX).toBe(gutterX + 5)
    expect(edge.labelY).toBe((la.y + la.h / 2 + lb.y + lb.h / 2) / 2)
  })

  it('同通道并行边（fan-in）：竖线段按错开位居中错开，不再重合成一根线', () => {
    const { layout, geo, edges } = buildRoutedCanvas({
      phases: [{ name: 'p0', order: 0 }, { name: 'p1', order: 1 }],
      nodes: [
        node({ id: 'a', templateName: 'aa', phase: 'p0' }),
        node({ id: 'b', templateName: 'bb', phase: 'p0' }),
        node({ id: 'c', templateName: 'cc', phase: 'p0' }),
        // 目标列占位节点：把 f 排到第 4 行——三条边源行各不同且都不与 f 同行
        //（同行退化为直线不进通道，测不到错开分配）
        node({ id: 't0', templateName: 'pa', phase: 'p1' }),
        node({ id: 't1', templateName: 'pb', phase: 'p1' }),
        node({ id: 't2', templateName: 'pc', phase: 'p1' }),
        node({ id: 'f', templateName: 'zz', phase: 'p1' }),
      ],
      edges: [
        { id: 'e1', from: 'a', to: 'f', kind: 'dataflow' },
        { id: 'e2', from: 'b', to: 'f', kind: 'dataflow' },
        { id: 'e3', from: 'c', to: 'f', kind: 'dataflow' },
      ],
    })
    const la = geo.get('a')!
    const lf = geo.get('f')!
    const routed = edges.filter((le) => le.edge.id.startsWith('e'))
    expect(routed).toHaveLength(3)
    const laneXs = routed.map((le) => le.points[1].x)
    // 三根竖线 x 互不相同（默认中位竖线重合缺陷已修）
    expect(new Set(laneXs).size).toBe(3)
    // 错开位以默认中位为中心、按 LANE_STEP_PX 居中分布，且跟随源 y 序（横支互不交叉）
    const midX = (la.x + DAG_NODE_W + lf.x) / 2
    const sorted = [...laneXs].sort((x, y) => x - y)
    expect(sorted[0]).toBeCloseTo(midX - LANE_STEP_PX, 6)
    expect(sorted[1]).toBeCloseTo(midX, 6)
    expect(sorted[2]).toBeCloseTo(midX + LANE_STEP_PX, 6)
    for (const le of routed) expectAxisAligned(le.points)
  })

  it('同列 loop-back：走分区左内边距侧向细道（不在节点列内折返），贴边段不压底边框', () => {
    const d = dag({
      phases: [{ name: 'p0', order: 0 }],
      nodes: [node({ id: 'a' }), node({ id: 'b', templateName: 'zb' })],
      edges: [{ id: 'loop', from: 'b', to: 'a', kind: 'loop-back' }],
    })
    const layout = layoutDag(d)
    const [la] = layout.nodes.filter((ln) => ln.node.id === 'a')
    const [lb] = layout.nodes.filter((ln) => ln.node.id === 'b')
    const [edge] = layoutEdges(d, layout.nodes)
    expect(edge.points).toHaveLength(6)
    expectAxisAligned(edge.points)
    // 侧向细道 x 在节点左缘与分区左缘之间（内边距带内）
    const sideX = edge.points[2].x
    expect(sideX).toBeLessThan(la.x)
    expect(sideX).toBeGreaterThan(la.x - 12)
    // 贴边横行段各自下移进所属节点底边下方空隙带（源 b 在下、目标 a 在上，不压边框）
    const fromLaneY = edge.points[2].y
    expect(fromLaneY).toBeGreaterThan(lb.y + lb.h)
    expect(fromLaneY).toBeLessThan(lb.y + lb.h + 12)
    const toLaneY = edge.points[3].y
    expect(toLaneY).toBeGreaterThan(la.y + la.h)
    expect(toLaneY).toBeLessThan(la.y + la.h + 12)
    expect(edge.points[5]).toEqual({ x: la.x + DAG_NODE_W / 2, y: la.y + la.h })
  })

  it('连线锚点纪律：全部边首末折点只落在节点四条边的中点（4 个连线点）', () => {
    const { layout, geo, edges } = buildRoutedCanvas(crossColumnCanvas([
      { id: 'e-seq', from: 'a', to: 'r1', kind: 'sequence' },
      { id: 'e-df', from: 'r2', to: 'f', kind: 'dataflow' },
      { id: 'loop-x', from: 'f', to: 'r1', kind: 'loop-back' },
      { id: 'loop-same', from: 'r2', to: 'r1', kind: 'loop-back' },
    ]))
    const midpoints = (ln: { x: number; y: number; h: number }) => [
      { x: ln.x + DAG_NODE_W / 2, y: ln.y },
      { x: ln.x + DAG_NODE_W / 2, y: ln.y + ln.h },
      { x: ln.x, y: ln.y + ln.h / 2 },
      { x: ln.x + DAG_NODE_W, y: ln.y + ln.h / 2 },
    ]
    for (const le of edges) {
      const from = geo.get(le.edge.from)
      const to = geo.get(le.edge.to)
      expect(from).toBeDefined()
      expect(to).toBeDefined()
      const first = le.points[0]
      const last = le.points[le.points.length - 1]
      expect(midpoints(from!).some((m) => m.x === first.x && m.y === first.y)).toBe(true)
      expect(midpoints(to!).some((m) => m.x === last.x && m.y === last.y)).toBe(true)
    }
  })

  it('条件边谓词标注锚在中位竖线旁（labelX = 竖线 x + 间隙）', () => {
    const d = dag({
      phases: [{ name: 'p0', order: 0 }, { name: 'p1', order: 1 }],
      nodes: [
        node({ id: 'a', phase: 'p0' }),
        node({ id: 'b', templateName: 'zb', phase: 'p1' }),
      ],
      edges: [{ id: 'e-cond', from: 'a', to: 'b', kind: 'conditional', predicate: 'fixMode' }],
    })
    const layout = layoutDag(d)
    const [edge] = layoutEdges(d, layout.nodes)
    expect(edge.labelX).toBeDefined()
    expect(edge.labelY).toBeDefined()
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

// ── 通道竖线避让 + 同行直线绕行（workflow-viz-fit-and-routing 设计残余 3/5，白盒）──

describe('layoutEdges 通道竖线避让（残余 3，白盒）', () => {
  /** 走廊带中心（按布局产物几何推算，不手算绝对坐标）：lo = 左列节点右缘，hi = 右列节点左缘。 */
  function corridorCenter(left: DagLayoutNode, right: DagLayoutNode): number {
    return (left.x + DAG_NODE_W + right.x) / 2
  }

  it('隔列边中位竖线穿中间列节点带 → 整体迁移到唯一零穿卡走廊（三段全程校验）', () => {
    // a(row1, y=70) → f(p2 row3, y=194)：p1 两行节点（row2 [110,154] 被中位 302 竖线穿过）；
    // 408 走廊的「源右缘→竖线」横段 @70 被 p1 row1 节点挡（走查反例：横段也要查），
    // 196 走廊零穿卡 → 迁移到 196
    const { geo, edges } = buildRoutedCanvas({
      phases: [
        { name: 'p0', order: 0 },
        { name: 'p1', order: 1 },
        { name: 'p2', order: 2 },
      ],
      nodes: [
        node({ id: 'a', phase: 'p0' }),
        node({ id: 'm0', phase: 'p1' }),
        node({ id: 'm', templateName: 'zm', phase: 'p1' }),
        node({ id: 'fa', phase: 'p2' }),
        node({ id: 'fb', templateName: 'zfa', phase: 'p2' }),
        node({ id: 'f', templateName: 'zz', phase: 'p2' }),
      ],
      edges: [{ id: 'e1', from: 'a', to: 'f', kind: 'dataflow' }],
    })
    const [edge] = edges.filter((le) => le.edge.id === 'e1')
    const expected = corridorCenter(geo.get('a')!, geo.get('m0')!)
    expect(edge.points[1].x).toBe(expected)
    expect(edge.points[2].x).toBe(expected)
    expectAxisAligned(edge.points)
  })

  it('两走廊均零穿卡且等距 → 取较大 x（等距裁决）', () => {
    // a(p0 row2, y=132) → f(p2 row4, y=256)：中位 302 竖线被 p2 row2 [110,154] 穿过
    //（p1 仅 row1 [48,92]，不拦 132/256）；196 与 408 走廊均零穿卡、距中位各 106
    // → 等距取较大 x（408）
    const { geo, edges } = buildRoutedCanvas({
      phases: [
        { name: 'p0', order: 0 },
        { name: 'p1', order: 1 },
        { name: 'p2', order: 2 },
      ],
      nodes: [
        node({ id: 'p0f', templateName: 'a0', phase: 'p0' }),
        node({ id: 'a', templateName: 'a1', phase: 'p0' }),
        node({ id: 'm', phase: 'p1' }),
        node({ id: 'p2a', templateName: 'b0', phase: 'p2' }),
        node({ id: 'p2b', templateName: 'b1', phase: 'p2' }),
        node({ id: 'p2c', templateName: 'b2', phase: 'p2' }),
        node({ id: 'f', templateName: 'b3', phase: 'p2' }),
      ],
      edges: [{ id: 'e1', from: 'a', to: 'f', kind: 'dataflow' }],
    })
    const [edge] = edges.filter((le) => le.edge.id === 'e1')
    const corridorNear = corridorCenter(geo.get('p0f')!, geo.get('m')!)
    const corridorFar = corridorCenter(geo.get('m')!, geo.get('p2a')!)
    const midX = (geo.get('a')!.x + DAG_NODE_W + geo.get('f')!.x) / 2
    // 等距前提自证：两走廊距原中位相等
    expect(midX - corridorNear).toBeCloseTo(corridorFar - midX, 6)
    expect(edge.points[1].x).toBe(corridorFar)
    expect(edge.points[2].x).toBe(corridorFar)
    expectAxisAligned(edge.points)
  })

  it('同通道双成员迁移：整体平移同一差值，车道相对错开保持', () => {
    // 双车道通道（e1=[70,194] 与 e2=[132,256] 纵向跨度重叠 → 两个游程两条车道）：
    // 中位竖线分别被 p1 row1（e1 段）与 p2 row2（e2 段）穿过 → 迁移到 196 走廊后
    // 两成员 laneX 差仍为一个 LANE_STEP
    const { geo, edges } = buildRoutedCanvas({
      phases: [
        { name: 'p0', order: 0 },
        { name: 'p1', order: 1 },
        { name: 'p2', order: 2 },
      ],
      nodes: [
        node({ id: 'c', phase: 'p0' }),
        node({ id: 'a', templateName: 'za', phase: 'p0' }),
        node({ id: 'm', phase: 'p1' }),
        node({ id: 'p2a', templateName: 'b0', phase: 'p2' }),
        node({ id: 'p2b', templateName: 'b1', phase: 'p2' }),
        node({ id: 'g', templateName: 'b2', phase: 'p2' }),
        node({ id: 'f', templateName: 'b3', phase: 'p2' }),
      ],
      edges: [
        { id: 'e1', from: 'c', to: 'g', kind: 'dataflow' },
        { id: 'e2', from: 'a', to: 'f', kind: 'dataflow' },
      ],
    })
    const routed = edges.filter((le) => le.edge.id.startsWith('e'))
    expect(routed).toHaveLength(2)
    const byId = new Map(routed.map((le) => [le.edge.id, le]))
    const laneC = byId.get('e1')!.points[1].x
    const laneA = byId.get('e2')!.points[1].x
    expect(Math.abs(laneA - laneC)).toBeCloseTo(LANE_STEP_PX, 6)
    // 整体落在 p0|p1 走廊（唯一零穿卡候选）内
    const corridor = corridorCenter(geo.get('c')!, geo.get('m')!)
    expect(Math.min(laneA, laneC)).toBeGreaterThan(corridor - LANE_STEP_PX)
    expect(Math.max(laneA, laneC)).toBeLessThan(corridor + LANE_STEP_PX + 0.5)
    expectAxisAligned(byId.get('e1')!.points)
    expectAxisAligned(byId.get('e2')!.points)
  })

  it('无零穿卡候选 → 取穿卡线段数最少者（残留分支；并列时等距取较大 x）', () => {
    // a(row1, y=70) → j(p3 row3, y=194)，四列中位 = 408：196 = seg3@194（p1c+p2c）1 段；
    // 408 = seg1@70 + seg3@194 = 2 段；620 = seg1@70（p1a+p2a）= 1 段——
    // 最少穿卡并列 {196, 620}，距中位 408 各 212 等距 → 取较大 x = 620
    const { geo, edges } = buildRoutedCanvas({
      phases: [
        { name: 'p0', order: 0 },
        { name: 'p1', order: 1 },
        { name: 'p2', order: 2 },
        { name: 'p3', order: 3 },
      ],
      nodes: [
        node({ id: 'a', phase: 'p0' }),
        node({ id: 'p1a', phase: 'p1' }),
        node({ id: 'p1b', templateName: 'pb', phase: 'p1' }),
        node({ id: 'p1c', templateName: 'pc', phase: 'p1' }),
        node({ id: 'p2a', templateName: 'qa', phase: 'p2' }),
        node({ id: 'p2b', templateName: 'qb', phase: 'p2' }),
        node({ id: 'p2c', templateName: 'qc', phase: 'p2' }),
        node({ id: 'p3a', templateName: 'ra', phase: 'p3' }),
        node({ id: 'p3b', templateName: 'rb', phase: 'p3' }),
        node({ id: 'j', templateName: 'rc', phase: 'p3' }),
      ],
      edges: [{ id: 'e1', from: 'a', to: 'j', kind: 'dataflow' }],
    })
    const [edge] = edges.filter((le) => le.edge.id === 'e1')
    const expected = corridorCenter(geo.get('p2c')!, geo.get('j')!)
    expect(edge.points[1].x).toBe(expected)
    expectAxisAligned(edge.points)
  })

  it('走廊容不下车道铺开（≥11 游程）→ 降级单线宽并线到零穿卡走廊中心', () => {
    // 11 条错位目标边（源 row k → 目标 row k+11）：纵向跨度两两相交 → 11 个游程
    // → 车道铺开 60px > 走廊 56 − 2×2 净距 → 无可容纳候选 → 全体并线到走廊中心
    const rowName = (k: number): string => `n${String(k).padStart(2, '0')}`
    const p0Nodes = Array.from({ length: 11 }, (_, i) => node({ id: `s${rowName(i + 1)}`, templateName: rowName(i + 1), phase: 'p0' }))
    const p1Nodes = Array.from({ length: 22 }, (_, i) => node({ id: `t${rowName(i + 1)}`, templateName: rowName(i + 1), phase: 'p1' }))
    const edges = Array.from({ length: 11 }, (_, i) => ({
      id: `e${i}`,
      from: `s${rowName(i + 1)}`,
      to: `t${rowName(i + 12)}`,
      kind: 'dataflow' as const,
    }))
    const { geo, edges: routed } = buildRoutedCanvas({
      phases: [
        { name: 'p0', order: 0 },
        { name: 'p1', order: 1 },
      ],
      nodes: [...p0Nodes, ...p1Nodes],
      edges,
    })
    const laneXs = routed.map((le) => le.points[1].x)
    expect(laneXs).toHaveLength(11)
    // 并线：全部车道重合于走廊中心（原铺开 ±30 不可容纳）
    const anySource = geo.get(`s${rowName(1)}`)!
    const anyTarget = geo.get(`t${rowName(12)}`)!
    const midX = (anySource.x + DAG_NODE_W + anyTarget.x) / 2
    for (const lane of laneXs) expect(lane).toBeCloseTo(midX, 6)
    for (const le of routed) expectAxisAligned(le.points)
  })

  it('降级并线仍无零穿卡走廊 → 保持车道分配原状（中位残留分支，白盒直喂几何输入）', () => {
    // 「仍无」分支在标准网格不可达（seg3 的 y2 恒为自身目标行，p1 节点拦不住）——
    // 按设计 U3「纯函数直喂几何输入的白盒用例」原意直接构造通道：车道铺开 60 不可
    // 容纳 → 并线重评时 196 被 e1 seg3@132（p1 row2）挡、408 被 e1 seg1@70（p1 row1）
    // 挡 → 两走廊均非零穿卡 → 保持原车道 [166, 196, 226]
    const nodes: DagLayoutNode[] = [
      { node: node({ id: 'src', phase: 'p0' }), x: 12, y: 48, h: 44 },
      { node: node({ id: 'm0', phase: 'p1' }), x: 224, y: 48, h: 44 },
      { node: node({ id: 'm2', phase: 'p1' }), x: 224, y: 110, h: 44 },
      { node: node({ id: 'm3', phase: 'p1' }), x: 224, y: 172, h: 44 },
      { node: node({ id: 'dst', phase: 'p2' }), x: 436, y: 48, h: 44 },
    ]
    const members: ChannelMember[] = [
      { x1: 168, y1: 70, x2: 436, y2: 132, lo: 70, hi: 132, laneX: 166, fromId: 'src', toId: 'dst' },
      { x1: 168, y1: 194, x2: 436, y2: 256, lo: 194, hi: 256, laneX: 196, fromId: 'src', toId: 'dst' },
      { x1: 168, y1: 318, x2: 436, y2: 380, lo: 318, hi: 380, laneX: 226, fromId: 'src', toId: 'dst' },
    ]
    avoidObstructedChannelMid(new Map([['168|436', members]]), nodes)
    expect(members.map((m) => m.laneX)).toEqual([166, 196, 226])
  })
})

describe('layoutEdges 同行直线边绕行（残余 5，白盒）', () => {
  it('同行隔列边中间列有节点 → 升级上下绕行 4 折线（等距取上），不穿卡', () => {
    const { geo, edges } = buildRoutedCanvas({
      phases: [
        { name: 'p0', order: 0 },
        { name: 'p1', order: 1 },
        { name: 'p2', order: 2 },
      ],
      nodes: [
        node({ id: 'a', phase: 'p0' }),
        node({ id: 'm', phase: 'p1' }),
        node({ id: 'f', phase: 'p2' }),
      ],
      edges: [{ id: 'e1', from: 'a', to: 'f', kind: 'conditional', predicate: 'fixMode' }],
    })
    const [edge] = edges.filter((le) => le.edge.id === 'e1')
    const lm = geo.get('m')!
    // 上下等距（障碍行底 +12 与行顶 −12 距边 y 相等）→ 取上
    const yB = lm.y - 12
    expect(edge.points).toHaveLength(4)
    expect(edge.points[1]).toEqual({ x: edge.points[0].x, y: yB })
    expect(edge.points[2]).toEqual({ x: edge.points[3].x, y: yB })
    expectAxisAligned(edge.points)
    // conditional 谓词标注锚随迁绕行横段（中点 x、横段 y）
    expect(edge.labelY).toBe(yB)
    expect(edge.labelX).toBe((edge.points[0].x + edge.points[3].x) / 2)
  })

  it('无障碍同行边保持直线零扰动（labelX/labelY 现行公式不变）', () => {
    const { geo, edges } = buildRoutedCanvas({
      phases: [
        { name: 'p0', order: 0 },
        { name: 'p1', order: 1 },
      ],
      nodes: [
        node({ id: 'a', phase: 'p0' }),
        node({ id: 'b', phase: 'p1' }),
      ],
      edges: [{ id: 'e1', from: 'a', to: 'b', kind: 'sequence' }],
    })
    const [edge] = edges
    expect(edge.points).toHaveLength(2)
    expect(edge.labelX).toBe((edge.points[0].x + edge.points[1].x) / 2)
    expect(edge.labelY).toBe(edge.points[0].y)
  })

  it('上方绕行带被高个节点覆盖 → 落到下方绕行带（近者规则的方向回退）', () => {
    // a/f 在 row2（y=132），p2 的 m(row2) 是障碍；p1 的 th(row1) 加高到 [48,128]
    // 覆盖上方带 110−12=98 → 回退下方 154+12=166（p1 无 row2 节点，无覆盖）
    const canvas = dag({
      phases: [
        { name: 'p0', order: 0 },
        { name: 'p1', order: 1 },
        { name: 'p2', order: 2 },
        { name: 'p3', order: 3 },
      ],
      nodes: [
        node({ id: 'p0f', templateName: 'a0', phase: 'p0' }),
        node({ id: 'a', templateName: 'a1', phase: 'p0' }),
        node({ id: 'th', phase: 'p1' }),
        node({ id: 'p2f', templateName: 'b0', phase: 'p2' }),
        node({ id: 'm', templateName: 'b1', phase: 'p2' }),
        node({ id: 'p3f', templateName: 'c0', phase: 'p3' }),
        node({ id: 'f', templateName: 'c1', phase: 'p3' }),
      ],
      edges: [{ id: 'e1', from: 'a', to: 'f', kind: 'dataflow' }],
    })
    const layout = layoutDag(canvas, new Map([['th', dagNodeHeight(2)]]))
    const lm = layout.nodes.find((ln) => ln.node.id === 'm')!
    const [edge] = layoutEdges(canvas, layout.nodes).filter((le) => le.edge.id === 'e1')
    const yB = lm.y + lm.h + 12
    expect(edge.points).toHaveLength(4)
    expect(edge.points[1].y).toBe(yB)
    expect(edge.points[2].y).toBe(yB)
    expect(edge.labelY).toBe(yB)
    expectAxisAligned(edge.points)
  })

  it('上下绕行带均被覆盖 → 保持直线登记残留（现行直线公式不变）', () => {
    // 同上图但 p1 增补 row2 节点 tm [146,190] 覆盖下方带 166 → 两方向均败 → 直线
    const layout = layoutDag(dag({
      phases: [
        { name: 'p0', order: 0 },
        { name: 'p1', order: 1 },
        { name: 'p2', order: 2 },
        { name: 'p3', order: 3 },
      ],
      nodes: [
        node({ id: 'p0f', templateName: 'a0', phase: 'p0' }),
        node({ id: 'a', templateName: 'a1', phase: 'p0' }),
        node({ id: 'th', phase: 'p1' }),
        node({ id: 'tm', templateName: 'tb', phase: 'p1' }),
        node({ id: 'p2f', templateName: 'b0', phase: 'p2' }),
        node({ id: 'm', templateName: 'b1', phase: 'p2' }),
        node({ id: 'p3f', templateName: 'c0', phase: 'p3' }),
        node({ id: 'f', templateName: 'c1', phase: 'p3' }),
      ],
      edges: [{ id: 'e1', from: 'a', to: 'f', kind: 'dataflow' }],
    }), new Map([
      ['th', dagNodeHeight(2)],
      ['tm', dagNodeHeight(2)],
    ]))
    const [edge] = layoutEdges(dag({
      phases: layout.clusters.map((c, i) => ({ name: c.phase, order: i })),
      nodes: layout.nodes.map((ln) => ln.node),
      edges: [{ id: 'e1', from: 'a', to: 'f', kind: 'dataflow' }],
    }), layout.nodes)
    expect(edge.points).toHaveLength(2)
    expect(edge.labelY).toBe(edge.points[0].y)
    expect(edge.labelX).toBe((edge.points[0].x + edge.points[1].x) / 2)
  })
})

describe('dagNodeHeight 节点高（实例数派生）', () => {
  it('0/1 实例 = 基准高（单实例 agent 名直接作标题，不另起行）', () => {
    expect(dagNodeHeight(0)).toBe(DAG_NODE_H)
    expect(dagNodeHeight(1)).toBe(DAG_NODE_H)
  })

  it('≥2 实例 = 基准高 + 实例行区（每实例一行）', () => {
    expect(dagNodeHeight(2)).toBe(DAG_NODE_H + 2 * INSTANCE_ROW_H + 4)
    expect(dagNodeHeight(5)).toBe(DAG_NODE_H + 5 * INSTANCE_ROW_H + 4)
  })
})

describe('layoutDag nodeHeights 高度表消费', () => {
  it('增高节点占据更大纵向步进，分区高度随之增长（卡片与布局同表不溢出）', () => {
    const nodes = [node({ id: 'a', templateName: 'aa' }), node({ id: 'b', templateName: 'zb' })]
    const d = dag({ phases: [{ name: 'p0', order: 0 }], nodes })
    const tall = dagNodeHeight(3)
    const layout = layoutDag(d, new Map([['a', tall]]))
    const [la, lb] = layout.nodes
    expect(la.h).toBe(tall)
    expect(lb.h).toBe(DAG_NODE_H)
    // b 的 y = a 底 + 行距（步进按实际高度累加）
    expect(lb.y).toBe(la.y + tall + 18)
    expect(layout.clusters[0].height).toBeGreaterThanOrEqual(tall + DAG_NODE_H + 18)
  })
})

describe('computeFitTransform fit-to-view（默认打开全图居中、四周 FIT_PAD_PX 留白）', () => {
  it('内容小于视口：k 封顶 1 不放大，两轴居中', () => {
    const fit = computeFitTransform(1000, 800, 180, 100)
    expect(fit.k).toBe(1)
    expect(fit.tx).toBe((1000 - 180) / 2)
    expect(fit.ty).toBe((800 - 100) / 2)
  })

  it('内容某轴超出视口：缩到该轴 pad 内贴边，另一轴居中', () => {
    const fit = computeFitTransform(800, 300, 392, 352)
    expect(fit.k).toBeCloseTo((300 - FIT_PAD_PX * 2) / 352, 6)
    expect(fit.tx).toBeGreaterThan(FIT_PAD_PX)
    expect(fit.ty).toBeCloseTo(FIT_PAD_PX, 6)
  })

  it('超大内容：缩放下限 ZOOM_MIN 兜底（仍居中，pan 可达）', () => {
    const fit = computeFitTransform(100, 100, 2000, 2000)
    expect(fit.k).toBe(ZOOM_MIN)
    expect(fit.tx).toBeCloseTo((100 - 2000 * ZOOM_MIN) / 2, 6)
  })

  it('容器无布局环境（两轴缺失）：退化 k=1 平移 0，不破坏渲染', () => {
    expect(computeFitTransform(0, 0, 180, 100)).toEqual({ k: 1, tx: 0, ty: 0 })
  })

  it('单轴缺失：该轴不参与缩放约束且偏移 0，另一轴正常 fit', () => {
    const fit = computeFitTransform(1000, 0, 180, 100)
    expect(fit.k).toBe(1)
    expect(fit.tx).toBe((1000 - 180) / 2)
    expect(fit.ty).toBe(0)
  })
})
