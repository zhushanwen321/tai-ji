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
 *   = 源右中心→通道竖线→目标左中心的三段折线（同行退化直线），同通道并行边按车道
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
import type { DagLayout, DagLayoutEdge, DagLayoutNode } from '../layout'
import {
  layoutDag,
  layoutEdges,
  computeFitTransform,
  dagNodeHeight,
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
    // 独占通道的边车道 = 默认中位（两锚点中位，竖线落在列间距带内）
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

  it('同通道并行边（fan-in）：竖线段按车道居中错开，不再重合成一根线', () => {
    const { layout, geo, edges } = buildRoutedCanvas({
      phases: [{ name: 'p0', order: 0 }, { name: 'p1', order: 1 }],
      nodes: [
        node({ id: 'a', templateName: 'aa', phase: 'p0' }),
        node({ id: 'b', templateName: 'bb', phase: 'p0' }),
        node({ id: 'c', templateName: 'cc', phase: 'p0' }),
        // 目标列占位节点：把 f 排到第 4 行——三条边源行各不同且都不与 f 同行
        //（同行退化为直线不进通道，测不到车道分配）
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
    // 车道以默认中位为中心、按 LANE_STEP_PX 居中分布，且跟随源 y 序（横支互不交叉）
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
