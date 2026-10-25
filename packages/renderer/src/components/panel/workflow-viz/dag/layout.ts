/**
 * DAG 列式布局纯函数（workflow-visualization 设计 §3.2「自绘 SVG，手写布局」：
 * 按 phase 列分区，调用点按词法序排列）。
 *
 * 输入 = u2 冻结的 WorkflowDag（shared 协议类型）+ 可选的节点高度表，输出 = 画布
 * 几何（分区矩形 / 节点左上角坐标与高度 / 画布总尺寸 / 边路径）。纯函数零 IO、
 * 零 DOM——构建者白盒测试对象。
 *
 * 布局规则：
 * - 分区列：WorkflowDagPhase.order 升序从左到右；分区内节点按 templateName
 *   词法序（codepoint）垂直排列——同列词法序是设计原型的排列口径。
 * - 节点高度：默认 DAG_NODE_H；挂接 ≥2 个执行实例的调用点按 dagNodeHeight 增高
 *   （实例行画进节点卡片内），经 nodeHeights 表传入布局——高度派生单处在消费侧
 *   （画布按 instancesByNode 计算），布局只消费数值表。
 * - 节点归属分区缺失（node.phase 不在 phases 清单，防御解析器缺省分区缺口）时
 *   动态补尾部分区，节点不丢弃。
 * - 并行组（parallelGroups）v1 不画组框：同组节点天然同列相邻（同 phase 内词法
 *   序排列），并行语义由调用点行内的实例列表表达（设计 §3.1-3 最小形态）。
 *
 * 边路由（正交）：全部边只走横竖两向，任何段不穿节点卡片；连线锚点只取节点四条
 * 边的中点（上/下/左/右共 4 个连线点，上边中点预留）——
 * - 顺序/数据流/条件边：源右中心 → 通道竖线 → 目标左中心的三段折线（同行退化直线）；
 *   跨列并行边（同源列且同目标列）竖线段默认重合，按纵向跨度重叠游程居中错开横向偏移
 *   （LANE_STEP_PX），fan-in/fan-out 不再叠成一根线；同列前向边（源与目标同列）
 *   走列右缘细道绕行——缺省通道中位竖线会落在节点列内穿卡片（绘制顺序遮住不可见）；
 * - loop-back（底边中点进出）：跨列回边在两端同列下方均无堆叠节点时四折点直连——
 *   源底边中点垂直下探 → 底部总线（全图最深节点下方）横行 → 目标底边中点垂直
 *   上升，进出垂直于底边、节点附近无横行段；任一端下方被同列堆叠节点挡住时回退
 *   侧向细道 + 底边下空隙带横行（LOOP_APPROACH_DROP，不压边框）；同列回边 = U 形
 *   细道折返；自环边（from===to）画不出合法的四中点正交环，不产出几何。
 * 折点处用小半径圆弧过渡（视觉圆角，路由仍严格轴对齐）。
 */
import type { WorkflowDag, WorkflowDagEdge, WorkflowDagNode } from '@taiji/shared'

/** 节点卡片尺寸（px，画布坐标系）。 */
export const DAG_NODE_W = 156
export const DAG_NODE_H = 44

/** 列内节点行距（节点间空隙，px；步进 = 节点高 + 行距）。 */
const NODE_GAP = 18
/** 分区内边距（节点区四周）。 */
const CLUSTER_PAD_X = 12
const CLUSTER_PAD_TOP = 30
const CLUSTER_PAD_BOTTOM = 12
/** 分区标题行高。 */
const CLUSTER_TITLE_H = 18
/** 分区列间水平间距。 */
const CLUSTER_GAP_X = 32
/** 比较器返回值（排序比较器惯例语义，命名消 magic number）。 */
const ORDER_BEFORE = -1
const ORDER_AFTER = 1
/** 零节点 run 的最小占位尺寸（渲染层居中摘要提示的底板）。 */
const EMPTY_DAG_MIN_W = 240
const EMPTY_DAG_MIN_H = 96
/** 中点除数（矩形中心 = 左上 + 尺寸/2）。 */
const HALF = 2

// ── 实例行（节点卡片内的执行实例列表）几何 ──

/** 实例行高（px）：状态小圆点 + 实例 agent 名一行。 */
export const INSTANCE_ROW_H = 16
/** 实例行区与节点主体的上间隙（px）。 */
const INSTANCE_ROWS_TOP_GAP = 4

/**
 * 节点卡片高度（按挂接实例数）：0/1 实例保持基准高（单实例的 agent 名直接作为
 * 节点标题，不另起行）；≥2 实例在主体下方追加实例行区（每实例一行）。
 */
export function dagNodeHeight(instanceCount: number): number {
  if (instanceCount <= 1) return DAG_NODE_H
  return DAG_NODE_H + INSTANCE_ROWS_TOP_GAP + instanceCount * INSTANCE_ROW_H
}

// ── fit-to-view（默认打开时全图居中自适应）──

/** fit 四周留白（px，用户裁决：主体居中、四周空 ~20px）。 */
export const FIT_PAD_PX = 20
/** fit 缩放下限（与画布手动缩放共用同一可读性下限）。 */
export const ZOOM_MIN = 0.35
/** fit 缩放上上限：内容比视口小不放大（k 封顶 1，保持文字原生渲染不虚）。 */
const FIT_MAX_K = 1

/** 视口变换（k 缩放 + tx/ty 平移，画布 viewport 的 transform 三元组）。 */
export interface FitTransform { // oe-exempt:20261002:framework:workflow-viz 布局产物数据形状类型——布局纯函数的输出契约（数据形状非抽象接口，layout 单源）
  k: number
  tx: number
  ty: number
}

/**
 * 计算 fit-to-view 变换：内容缩放到两侧各留 pad 空隙后居中。
 * 容器某轴无布局环境（jsdom clientWidth/Height 缺失 = 0）时该轴不参与缩放约束、
 * 偏移取 0（退化贴左上，与既有退化口径一致，不破坏渲染）；两轴均缺失 → k=1 平移 0。
 * 内容某轴尺寸 > 0 恒成立（零节点 run 也有最小占位）。
 */
export function computeFitTransform(
  containerW: number,
  containerH: number,
  contentW: number,
  contentH: number,
): FitTransform {
  if (contentW <= 0 || contentH <= 0) return { k: 1, tx: 0, ty: 0 }
  let k = FIT_MAX_K
  if (containerW > 0) k = Math.min(k, (containerW - FIT_PAD_PX * HALF) / contentW)
  if (containerH > 0) k = Math.min(k, (containerH - FIT_PAD_PX * HALF) / contentH)
  k = Math.max(ZOOM_MIN, Math.min(FIT_MAX_K, k))
  return {
    k,
    tx: containerW > 0 ? (containerW - contentW * k) / HALF : 0,
    ty: containerH > 0 ? (containerH - contentH * k) / HALF : 0,
  }
}

/** 布局后的节点几何（x/y = 左上角，h = 节点高——实例行数不同节点不等高）。 */
export interface DagLayoutNode { // oe-exempt:20261002:framework:workflow-viz 布局产物数据形状类型——列式布局纯函数的输出契约（数据形状非抽象接口，layout 单源）
  node: WorkflowDagNode
  x: number
  y: number
  h: number
}

/** 布局后的 phase 分区矩形（背景分区列）。 */
export interface DagLayoutCluster { // oe-exempt:20261002:framework:workflow-viz 布局产物数据形状类型——列式布局纯函数的输出契约（数据形状非抽象接口，layout 单源）
  phase: string
  x: number
  y: number
  width: number
  height: number
}

/** 布局产物：分区矩形 + 节点几何 + 画布总尺寸。 */
export interface DagLayout { // oe-exempt:20261002:framework:workflow-viz 布局产物数据形状类型——列式布局纯函数的输出契约（数据形状非抽象接口，layout 单源）
  clusters: DagLayoutCluster[]
  nodes: DagLayoutNode[]
  width: number
  height: number
}

/** 词法序比较（codepoint 序，环境无关——测试确定性优先于 locale 感知序）。 */
function lexicalCompare(a: string, b: string): number {
  if (a < b) return ORDER_BEFORE
  if (a > b) return ORDER_AFTER
  return 0
}

/**
 * 布局单列：给定分区名与归属节点（已按词法序排好），产出分区矩形与节点坐标。
 * 节点高度查 nodeHeights 表（缺省基准高）——同列步进按各自实际高度累加。
 */
function layoutCluster(phase: string, members: WorkflowDagNode[], x: number, nodeHeights: Map<string, number>): {
  cluster: DagLayoutCluster
  placed: DagLayoutNode[]
} {
  const placed: DagLayoutNode[] = []
  let cursorY = CLUSTER_PAD_TOP + CLUSTER_TITLE_H
  for (const node of members) {
    const h = nodeHeights.get(node.id) ?? DAG_NODE_H
    placed.push({ node, x: x + CLUSTER_PAD_X, y: cursorY, h })
    cursorY += h + NODE_GAP
  }
  const singleNodeMinHeight = CLUSTER_PAD_TOP + CLUSTER_TITLE_H + DAG_NODE_H + CLUSTER_PAD_BOTTOM
  const last = placed[placed.length - 1]
  const contentBottom = last !== undefined
    ? last.y + last.h + CLUSTER_PAD_BOTTOM
    : singleNodeMinHeight
  const cluster: DagLayoutCluster = {
    phase,
    x,
    y: 0,
    width: DAG_NODE_W + CLUSTER_PAD_X * HALF,
    height: Math.max(contentBottom, singleNodeMinHeight),
  }
  return { cluster, placed }
}

/** 节点高度表（nodeId → 高度；缺省键按基准高）。 */
export type DagNodeHeightMap = Map<string, number>

/**
 * 计算 DAG 列式布局。零节点 run（纯门禁脚本）：nodes 空数组、clusters 空、
 * 画布取最小占位尺寸——渲染层出空画布 + 居中摘要提示（设计 §3.1-3，提示由画布组件
 * 渲染，不归布局）。
 */
export function layoutDag(dag: WorkflowDag, nodeHeights: DagNodeHeightMap = new Map()): DagLayout {
  // 分区清单（order 升序）；防御：节点归属分区缺失时动态补尾部分区（节点不丢弃）
  const phaseOrder = new Map<string, number>()
  const orderedPhases = [...dag.phases].sort((a, b) => a.order - b.order)
  orderedPhases.forEach((p) => phaseOrder.set(p.name, p.order))

  const missing = new Set<string>()
  for (const node of dag.nodes) {
    if (!phaseOrder.has(node.phase)) missing.add(node.phase)
  }
  let nextOrder = orderedPhases.length
  for (const phase of [...missing].sort(lexicalCompare)) {
    phaseOrder.set(phase, nextOrder)
    orderedPhases.push({ name: phase, order: nextOrder })
    nextOrder += 1
  }

  // 分区内节点按词法序分组
  const byPhase = new Map<string, WorkflowDagNode[]>()
  for (const node of dag.nodes) {
    const list = byPhase.get(node.phase) ?? []
    list.push(node)
    byPhase.set(node.phase, list)
  }
  for (const [phase, list] of byPhase) {
    list.sort((a, b) => lexicalCompare(a.templateName, b.templateName) || lexicalCompare(a.id, b.id))
    byPhase.set(phase, list)
  }

  const clusters: DagLayoutCluster[] = []
  const nodes: DagLayoutNode[] = []
  let cursorX = 0
  let maxBottom = 0
  for (const phase of orderedPhases) {
    const members = byPhase.get(phase.name) ?? []
    const { cluster, placed } = layoutCluster(phase.name, members, cursorX, nodeHeights)
    clusters.push(cluster)
    nodes.push(...placed)
    maxBottom = Math.max(maxBottom, cluster.height)
    cursorX += cluster.width + CLUSTER_GAP_X
  }

  // 零分区（零节点 run）：最小占位，渲染层出居中摘要提示（无独立卡片容器）
  const width = clusters.length > 0 ? cursorX - CLUSTER_GAP_X : EMPTY_DAG_MIN_W
  const height = clusters.length > 0 ? maxBottom : EMPTY_DAG_MIN_H
  return { clusters, nodes, width, height }
}

// ── 边几何（正交路由）──

/** 路径折点（画布坐标）。 */
export interface DagPoint { // oe-exempt:20261002:framework:workflow-viz 布局产物数据形状类型——路由纯函数的输出契约（数据形状非抽象接口，layout 单源）
  x: number
  y: number
}

/** 布局后的边几何：折点序列（严格轴对齐）+ 圆角 path d 串 + 条件边谓词标注锚点。 */
export interface DagLayoutEdge { // oe-exempt:20261002:framework:workflow-viz 布局产物数据形状类型——路由纯函数的输出契约（数据形状非抽象接口，layout 单源）
  edge: WorkflowDagEdge
  /** 路由折点（相邻两点恒共享 x 或 y——横竖两向的正交不变量，测试断言锚点）。 */
  points: DagPoint[]
  /** SVG path d 串（fill:none；折点处小半径圆弧过渡）。 */
  d: string
  /** 谓词标注锚点（kind='conditional' 时携带；置于本边通道竖线旁）。 */
  labelX?: number
  labelY?: number
}

/** 回边下探深度（画布坐标系常量——loop-back 横行总线的 y——压在所有分区内容之下）。 */
const LOOP_DROP = 28
/** 回边侧向细道偏移（节点缘到细道；细道落在分区内边距带内——节点列之外，不穿节点）。 */
const LOOP_SIDE_OFFSET = 8
/** 回边贴边水平段相对节点底边的下移间隙（px）：横行段落在底边与分区底界
 *  （CLUSTER_PAD_BOTTOM=12）或下邻节点（NODE_GAP=18）之间的空隙带内——不压节点
 *  边框，进出锚点仍唯一落在底边中点。 */
const LOOP_APPROACH_DROP = 5
/** 同通道并行边的错开步长（竖线段错开间距；列间走廊 ~56px，容得下常规并行度）。 */
export const LANE_STEP_PX = 6
/** 线段穿卡判定的外扩间隙（px，每侧）：车道/绕行带与卡片缘的最小净距——列间走廊
 * 56px 的容量口径（车道铺开 + 2×本值 ≤ 走廊宽）由它推导。 */
const PIERCE_CLEARANCE_PX = 2
/** 同行绕行带与障碍行缘的间隙（px，设计决策四 margin）。 */
const BYPASS_MARGIN_PX = 12
/** 折点圆角半径（px；实际半径再按相邻段长收敛，短段不打弯）。 */
const CORNER_RADIUS = 6
/** 条件谓词标注与中位竖线的间隙（px）。 */
const LABEL_GAP_X = 5
/** 坐标重合判定（同列回边 bx1≈bx2 的浮点容差）。 */
const COINCIDE_EPS = 0.5

/**
 * 折点序列 → 圆角 path d 串：直线段 L 连接，内部折点处用半径 r 的二次贝塞尔
 * 过渡（r 收敛到相邻段长一半，避免短段翻折）。折点本身保持轴对齐不变量。
 */
function roundedPath(points: DagPoint[]): string {
  /** 线段最少点数（起点 + 终点；少于则无路径可言）。 */
  const MIN_PATH_POINTS = 2
  if (points.length < MIN_PATH_POINTS) return ''
  let d = `M ${points[0].x} ${points[0].y}`
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]
    const cur = points[i]
    const next = points[i + 1]
    const inLen = Math.hypot(cur.x - prev.x, cur.y - prev.y)
    const outLen = Math.hypot(next.x - cur.x, next.y - cur.y)
    const r = Math.min(CORNER_RADIUS, inLen / HALF, outLen / HALF)
    const t1 = r / (inLen || 1)
    const t2 = r / (outLen || 1)
    const p1 = { x: cur.x + (prev.x - cur.x) * t1, y: cur.y + (prev.y - cur.y) * t1 }
    const p2 = { x: cur.x + (next.x - cur.x) * t2, y: cur.y + (next.y - cur.y) * t2 }
    d += ` L ${p1.x} ${p1.y} Q ${cur.x} ${cur.y} ${p2.x} ${p2.y}`
  }
  const last = points[points.length - 1]
  d += ` L ${last.x} ${last.y}`
  return d
}

/**
 * 轴对齐线段与节点卡片的穿卡判定（通道竖线避让与同行直线绕行共用的障碍谓词，
 * 设计 workflow-viz-fit-and-routing §3.2 决策三/决策四）。
 *
 * x 覆盖区间两端各外扩 PIERCE_CLEARANCE_PX（车道/绕行带与卡片缘净距口径，列间走廊
 * 容量公式按此推导）；y 覆盖区间开区间相交（端点相触不算穿卡）。
 * excludeNodeId 排除线段自身锚定的端点节点——锚点贴卡片边缘，外扩后必然「命中」
 * 自身，属锚定而非穿卡；一条线段排除一个端点（横段 1 排除源、横段 3 排除目标）。
 */
function segmentHitsNode(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  node: DagLayoutNode,
  excludeNodeId?: string,
): boolean {
  if (node.node.id === excludeNodeId) return false
  const segX0 = Math.min(x0, x1) - PIERCE_CLEARANCE_PX
  const segX1 = Math.max(x0, x1) + PIERCE_CLEARANCE_PX
  const segY0 = Math.min(y0, y1)
  const segY1 = Math.max(y0, y1)
  const nodeX1 = node.x + DAG_NODE_W
  const nodeY1 = node.y + node.h
  // x 轴经外扩恒非退化区间 → 开区间相交；y 轴在水平段退化为一点 → 按严格包含判定
  //（点落在卡片 y 区间内才算穿，压边框线不算——「端点相触不算」在点轴上的形态）
  const xHit = Math.max(segX0, node.x) < Math.min(segX1, nodeX1)
  const yHit = segY0 === segY1
    ? node.y < segY0 && segY0 < nodeY1
    : Math.max(segY0, node.y) < Math.min(segY1, nodeY1)
  return xHit && yHit
}

/** 通道成员（三段折线前向边）：源同列且目标同列 → 默认路径完全重合，装配前按纵向跨度重叠关系错开车道。
 *  导出仅供避让纯函数的白盒用例直喂几何输入（设计 U3 降级/残留分支用例形态）。 */
export interface ChannelMember {
  x1: number
  y1: number
  x2: number
  y2: number
  /** 竖线段纵向跨度（lo ≤ hi）。 */
  lo: number
  hi: number
  /** 错开分配后的竖线 x（缺省 = 默认中位；装配前回填）。 */
  laneX: number
  /** 端点节点 id（穿卡检测排除横段自身锚定的端点卡片）。 */
  fromId: string
  toId: string
}

/** 待装配边（保持 dag.edges 序——输出序不因错开分配分遍打乱）：已定型路径或通道成员。 */
type PendingEdge =
  | { edge: WorkflowDagEdge; kind: 'fixed'; points: DagPoint[]; labelX?: number; labelY?: number }
  | { edge: WorkflowDagEdge; kind: 'channeled'; chan: ChannelMember }

/**
 * loop-back 路由（锚点只取节点四边中点：底边中点进出）。形态分三档：
 * - 自环边（解析器把单调用点循环折叠成 from===to）：闭环要同时起止于底边中点必沿
 *   底边折返或与自身重叠，无合法正交形态，不产出几何——循环语义由实例行重试状态
 *   呈现，不画自指线；
 * - 同列回边：U 形侧向细道折返（细道在分区左内边距带内，贴边横行走底边下空隙带）；
 * - 跨列回边：两端同列下方均无堆叠节点时四折点直连——源底边中点垂直下探 → 底部
 *   总线（全图最深节点下方 LOOP_DROP 处）横行 → 目标底边中点垂直上升，进出垂直
 *   于底边；任一端下方被同列堆叠节点挡住（中轴升降段会穿卡片）时回退侧向细道 +
 *   空隙带横行，细道取朝向对端一侧（总线不回头折）。
 */
function loopBackPoints(
  from: DagLayoutNode,
  to: DagLayoutNode,
  deepestBottom: number,
  nodes: DagLayoutNode[],
): DagPoint[] {
  if (from === to) return []
  const fromBottom = from.y + from.h
  const toBottom = to.y + to.h
  const fromLaneY = fromBottom + LOOP_APPROACH_DROP
  const toLaneY = toBottom + LOOP_APPROACH_DROP
  const bx1 = from.x + DAG_NODE_W / HALF
  const bx2 = to.x + DAG_NODE_W / HALF
  if (Math.abs(bx1 - bx2) < COINCIDE_EPS) {
    const sx = Math.min(from.x, to.x) - LOOP_SIDE_OFFSET
    return [
      { x: bx1, y: fromBottom },
      { x: bx1, y: fromLaneY },
      { x: sx, y: fromLaneY },
      { x: sx, y: toLaneY },
      { x: bx2, y: toLaneY },
      { x: bx2, y: toBottom },
    ]
  }
  const busY = Math.max(deepestBottom, fromBottom, toBottom) + LOOP_DROP
  // 同列下方堆叠节点会挡住中轴升降段（垂直段穿卡片）——任一端被挡即整体回退细道
  const columnBlocked = (n: DagLayoutNode): boolean =>
    nodes.some((o) => o !== n && Math.abs(o.x - n.x) < COINCIDE_EPS && o.y > n.y)
  if (!columnBlocked(from) && !columnBlocked(to)) {
    return [
      { x: bx1, y: fromBottom },
      { x: bx1, y: busY },
      { x: bx2, y: busY },
      { x: bx2, y: toBottom },
    ]
  }
  const towardTo = from.x > to.x
  const fromSideX = towardTo ? from.x - LOOP_SIDE_OFFSET : from.x + DAG_NODE_W + LOOP_SIDE_OFFSET
  const toSideX = towardTo ? to.x + DAG_NODE_W + LOOP_SIDE_OFFSET : to.x - LOOP_SIDE_OFFSET
  return [
    { x: bx1, y: fromBottom },
    { x: bx1, y: fromLaneY },
    { x: fromSideX, y: fromLaneY },
    { x: fromSideX, y: busY },
    { x: toSideX, y: busY },
    { x: toSideX, y: toLaneY },
    { x: bx2, y: toLaneY },
    { x: bx2, y: toBottom },
  ]
}

/**
 * 错开分配（通道表原地回填 laneX）：通道内按 y1 升序贪心分「纵向跨度互相重叠」的
 * 游程（首碰归属，端点相触视作重叠）——游程序 = 错开序：同游程的边互不重叠可共线，
 * 跨游程必重叠必须分道；整通道按游程数以默认中位为中心居中错开（单游程回到中位不动）
 * ——fan-in/fan-out 不再叠成一根线。
 */
function assignChannelLanes(channels: Map<string, ChannelMember[]>): void {
  for (const members of channels.values()) {
    members.sort((a, b) => a.y1 - b.y1 || a.y2 - b.y2)
    const runs: ChannelMember[][] = []
    const runMaxHi: number[] = []
    for (const m of members) {
      const fit = runs.findIndex((_, i) => m.lo > runMaxHi[i])
      if (fit === -1) {
        runs.push([m])
        runMaxHi.push(m.hi)
      } else {
        runs[fit].push(m)
        runMaxHi[fit] = Math.max(runMaxHi[fit], m.hi)
      }
    }
    const midX = (members[0].x1 + members[0].x2) / HALF
    const laneBase = -((runs.length - 1) * LANE_STEP_PX) / HALF
    runs.forEach((run, ri) => {
      const laneX = midX + laneBase + ri * LANE_STEP_PX
      for (const m of run) m.laneX = laneX
    })
  }
}

/** 节点列间走廊带（通道避让候选）：相邻两列卡片带之间的空隙（lo/hi = 卡片缘，center = 带中心）。 */
interface CorridorBand {
  lo: number
  hi: number
  center: number
}

/** 枚举节点列间走廊带：按节点左缘 x 聚列（容差同列判定），相邻列卡片右/左缘之间为一带。 */
function corridorBands(nodes: DagLayoutNode[]): CorridorBand[] {
  const columns: number[] = []
  for (const n of nodes) {
    if (!columns.some((x) => Math.abs(x - n.x) < COINCIDE_EPS)) columns.push(n.x)
  }
  columns.sort((a, b) => a - b)
  const bands: CorridorBand[] = []
  for (let i = 0; i + 1 < columns.length; i++) {
    const lo = columns[i] + DAG_NODE_W
    const hi = columns[i + 1]
    if (hi - lo <= 0) continue
    bands.push({ lo, hi, center: (lo + hi) / HALF })
  }
  return bands
}

/**
 * 通道竖线避让（设计 workflow-viz-fit-and-routing §3.2 决策三）：穿卡检测覆盖三段
 * 折线全程（竖线迁移后横段仍可能穿卡——走查反例：避让侧选中等距一侧时「源右缘→竖线」
 * 横段完整穿过中间列节点带）；通道内全部成员的竖线随车道整体平移同一差值（车道相对
 * 错开保持，折点结构不变），候选 = 跨度内列间走廊带中心。
 *
 * 选择规则：①零穿卡候选取距原中位最近者（等距取较大 x）；②有候选但全穿卡 → 取穿卡
 * 线段数最少、再距原中位最近者（已知残留：错误呈现不追阶梯绕行，恢复路径 = 任一 DAG
 * 变更触发布局重评，重审触发 = 残留形态稳定复现，见设计「残留登记要素」）；③无任何
 * 可容纳车道铺开的走廊（高并行车道铺开越界）→ 降级单线宽（车道并线）重评，仍无 →
 * 保持中位（罕见残留，不抛）。
 *
 * 零扰动约束：无障碍通道（相邻列常态）的走廊中心恰等于原中位，零穿卡且最近候选即
 * 自身，laneX 不动——既有中位断言用例保持绿。
 */
export function avoidObstructedChannelMid(channels: Map<string, ChannelMember[]>, nodes: DagLayoutNode[]): void {
  const bands = corridorBands(nodes)
  if (bands.length === 0) return
  for (const members of channels.values()) {
    const midX = (members[0].x1 + members[0].x2) / HALF
    const spanLo = Math.min(members[0].x1, members[0].x2)
    const spanHi = Math.max(members[0].x1, members[0].x2)
    const laneSpread = Math.max(...members.map((m) => m.laneX)) - Math.min(...members.map((m) => m.laneX))
    const inSpan = (band: CorridorBand): boolean => band.center > spanLo && band.center < spanHi
    /** 走廊容量：车道铺开 + 两侧净距须容于带宽（spread=0 即单线宽档）。 */
    const capacityOk = (band: CorridorBand, spread: number): boolean =>
      band.hi - band.lo >= spread + PIERCE_CLEARANCE_PX * HALF
    /** 候选中心下全通道的穿卡线段数（collapse=true 时全体成员竖线并到 center，丢弃车道错开）。 */
    const countPierced = (center: number, collapse: boolean): number => {
      let count = 0
      for (const m of members) {
        const lane = collapse ? center : m.laneX + (center - midX)
        const segments: [number, number, number, number, string | undefined][] = [
          [m.x1, m.y1, lane, m.y1, m.fromId],
          [lane, m.y1, lane, m.y2, undefined],
          [lane, m.y2, m.x2, m.y2, m.toId],
        ]
        for (const [sx0, sy0, sx1, sy1, excludeId] of segments) {
          const hit = nodes.some((n) => segmentHitsNode(sx0, sy0, sx1, sy1, n, excludeId))
          if (hit) count += 1
        }
      }
      return count
    }
    /** 距原中位最近者（等距取较大 x）。 */
    const pickNearest = (candidates: CorridorBand[]): CorridorBand => {
      let best = candidates[0]
      for (const b of candidates.slice(1)) {
        const db = Math.abs(b.center - midX)
        const dBest = Math.abs(best.center - midX)
        if (db < dBest || (db === dBest && b.center > best.center)) best = b
      }
      return best
    }

    const usable = bands.filter((b) => inSpan(b) && capacityOk(b, laneSpread))
    if (usable.length > 0) {
      const zeros = usable.filter((b) => countPierced(b.center, false) === 0)
      if (zeros.length > 0) {
        const delta = pickNearest(zeros).center - midX
        for (const m of members) m.laneX += delta
      } else {
        // 规则②：全穿卡残留——最少穿卡线段数优先，再距原中位最近，再取较大 x
        const ranked = [...usable].sort((a, b) =>
          countPierced(a.center, false) - countPierced(b.center, false)
          || Math.abs(a.center - midX) - Math.abs(b.center - midX)
          || b.center - a.center)
        const delta = ranked[0].center - midX
        for (const m of members) m.laneX += delta
      }
      continue
    }
    // 规则③：无任何可容纳车道铺开的走廊 → 降级单线宽（并线）重评；仍无 → 保持中位
    const collapsedZeros = bands.filter((b) => inSpan(b) && capacityOk(b, 0) && countPierced(b.center, true) === 0)
    if (collapsedZeros.length > 0) {
      const center = pickNearest(collapsedZeros).center
      for (const m of members) m.laneX = center
    }
  }
}

/**
 * 同行直线边的纵向绕行带（设计 workflow-viz-fit-and-routing §3.2 决策四）：直线由
 * 两端点决定无法横向迁移（纯水平路径必穿同 y 节点），唯一避让维度 = 纵向。障碍 =
 * 覆盖边 y 且 x 区间与 (x1,x2) 相交的节点（共用穿卡谓词，多障碍取并集）；绕行带
 * yB 取全部障碍行底 + margin（向下）或行顶 − margin（向上）的近者（等距取上），
 * 选择后校验绕行横段（yB 高度上跨度内无任何节点覆盖），不满足试另一方向，两方向
 * 均不满足 → null（调用方保持直线，罕见残留——恢复路径与重审触发同决策三「残留
 * 登记要素」，重审后评估多级绕行档）。
 */
function sameRowBypass(
  x1: number,
  y: number,
  x2: number,
  nodes: DagLayoutNode[],
  fromId: string,
  toId: string,
): { yB: number } | null {
  const notEndpoint = (n: DagLayoutNode): boolean => n.node.id !== fromId && n.node.id !== toId
  const obstacles = nodes.filter((n) => notEndpoint(n) && segmentHitsNode(x1, y, x2, y, n))
  if (obstacles.length === 0) return null
  const downY = Math.max(...obstacles.map((o) => o.y + o.h)) + BYPASS_MARGIN_PX
  const upY = Math.min(...obstacles.map((o) => o.y)) - BYPASS_MARGIN_PX
  const preferUp = Math.abs(upY - y) <= Math.abs(downY - y)
  for (const yB of preferUp ? [upY, downY] : [downY, upY]) {
    const crossed = nodes.some((n) => notEndpoint(n) && segmentHitsNode(x1, yB, x2, yB, n))
    if (!crossed) return { yB }
  }
  return null
}

/**
 * 计算边几何（正交路由）。顺序/数据流/条件边 = 源右中心 → 通道竖线 → 目标左中心
 * （同行退化为直线）：同一通道（源同列且目标同列）的并行边竖线段默认重合，装配前
 * 经 assignChannelLanes 按车道错开，再经 avoidObstructedChannelMid 整体避让到最近
 * 零穿卡走廊；同行直线边有障碍时升级上下绕行 4 折线（标注锚随迁绕行横段）。loop-back
 * 见 loopBackPoints。端点缺失（边引用不存在节点——防御解析器缺口）的边不产出
 * （跳过，不抛）。
 */
export function layoutEdges(dag: WorkflowDag, nodes: DagLayoutNode[]): DagLayoutEdge[] {
  const byId = new Map<string, DagLayoutNode>()
  for (const ln of nodes) byId.set(ln.node.id, ln)

  // 全图最深节点底（loop-back 横行总线的 y——压在所有分区内容之下，不穿行内节点）
  let deepestBottom = 0
  for (const ln of nodes) deepestBottom = Math.max(deepestBottom, ln.y + ln.h)

  const pending: PendingEdge[] = []
  const channels = new Map<string, ChannelMember[]>()
  for (const edge of dag.edges) {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (!from || !to) continue
    if (edge.kind === 'loop-back') {
      const points = loopBackPoints(from, to, deepestBottom, nodes)
      if (points.length > 0) pending.push({ edge, kind: 'fixed', points })
      continue
    }
    const x1 = from.x + DAG_NODE_W
    const y1 = from.y + from.h / HALF
    const x2 = to.x
    const y2 = to.y + to.h / HALF
    // 同列前向边（同 phase 内上下游调用点）：右中点出 → 列右缘细道下/上升 → 右中点
    // 入（入锚取朝向细道一侧——若入左边中点，末段横线要从右侧细道横穿整张卡片，
    // 箭头被「边先节点后」的绘制顺序遮住不可见）。缺省通道路由的中位竖线 = 两端 x
    // 的中点，同样落在节点列内部穿卡片；细道在分区右内边距带内（LOOP_SIDE_OFFSET，
    // CLUSTER_PAD_X=12 容得下），与回边细道共带——同列多条边共享细道时纵向跨度
    // 相邻链（a→b→c）天然衔接不重叠，跨行跳连（a→c 与 a→b 并存）的重叠为已知罕见形态
    if (Math.abs(from.x - to.x) < COINCIDE_EPS) {
      const gutterX = from.x + DAG_NODE_W + LOOP_SIDE_OFFSET
      pending.push({
        edge,
        kind: 'fixed',
        points: [
          { x: x1, y: y1 },
          { x: gutterX, y: y1 },
          { x: gutterX, y: y2 },
          { x: to.x + DAG_NODE_W, y: y2 },
        ],
        labelX: gutterX + LABEL_GAP_X,
        labelY: (y1 + y2) / HALF,
      })
      continue
    }
    if (Math.abs(y1 - y2) < COINCIDE_EPS) {
      // 同行直线边（残余 5）：有障碍升级上下绕行 4 折线，标注锚随迁绕行横段中点；
      // 无障碍/两方向均不满足保持直线（零扰动——现行直线公式不变）
      const bypass = sameRowBypass(x1, y1, x2, nodes, from.node.id, to.node.id)
      if (bypass !== null) {
        pending.push({
          edge,
          kind: 'fixed',
          points: [
            { x: x1, y: y1 },
            { x: x1, y: bypass.yB },
            { x: x2, y: bypass.yB },
            { x: x2, y: y2 },
          ],
          labelX: (x1 + x2) / HALF,
          labelY: bypass.yB,
        })
        continue
      }
      pending.push({
        edge,
        kind: 'fixed',
        points: [{ x: x1, y: y1 }, { x: x2, y: y2 }],
        labelX: (x1 + x2) / HALF,
        labelY: y1,
      })
      continue
    }
    const chan: ChannelMember = {
      x1, y1, x2, y2,
      lo: Math.min(y1, y2),
      hi: Math.max(y1, y2),
      laneX: (x1 + x2) / HALF,
      fromId: from.node.id,
      toId: to.node.id,
    }
    pending.push({ edge, kind: 'channeled', chan })
    const key = `${x1}|${x2}`
    const list = channels.get(key)
    if (list) list.push(chan)
    else channels.set(key, [chan])
  }

  // 错开分配：同通道并行边按纵向跨度重叠游程序错开（机制见 assignChannelLanes）
  assignChannelLanes(channels)
  // 通道竖线避让：穿卡通道整体平移到最近零穿卡走廊（机制见 avoidObstructedChannelMid）
  avoidObstructedChannelMid(channels, nodes)

  const result: DagLayoutEdge[] = []
  for (const item of pending) {
    if (item.kind === 'fixed') {
      result.push({ edge: item.edge, points: item.points, d: roundedPath(item.points), labelX: item.labelX, labelY: item.labelY })
      continue
    }
    const c = item.chan
    const points: DagPoint[] = [
      { x: c.x1, y: c.y1 },
      { x: c.laneX, y: c.y1 },
      { x: c.laneX, y: c.y2 },
      { x: c.x2, y: c.y2 },
    ]
    result.push({
      edge: item.edge,
      points,
      d: roundedPath(points),
      labelX: c.laneX + LABEL_GAP_X,
      labelY: (c.y1 + c.y2) / HALF,
    })
  }
  return result
}
