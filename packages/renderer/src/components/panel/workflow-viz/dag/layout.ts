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
 *   同一通道（源同列且目标同列）的并行边竖线段默认重合，按纵向跨度重叠游程居中
 *   错开车道（LANE_STEP_PX），fan-in/fan-out 不再叠成一根线；
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
/** 同通道并行边的车道步长（竖线段错开间距；列间走廊 ~56px，容得下常规并行度）。 */
export const LANE_STEP_PX = 6
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

/** 通道成员（三段折线前向边）：源同列且目标同列 → 默认路径完全重合，装配前按纵向跨度重叠关系错开车道。 */
interface ChannelMember {
  x1: number
  y1: number
  x2: number
  y2: number
  /** 竖线段纵向跨度（lo ≤ hi）。 */
  lo: number
  hi: number
  /** 车道分配后的竖线 x（缺省 = 默认中位；装配前回填）。 */
  laneX: number
}

/** 待装配边（保持 dag.edges 序——输出序不因车道分遍打乱）：已定型路径或通道成员。 */
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
 * 计算边几何（正交路由）。顺序/数据流/条件边 = 源右中心 → 通道竖线 → 目标左中心
 * （同行退化为直线）：同一通道（源同列且目标同列）的并行边竖线段默认重合，装配前
 * 按纵向跨度重叠分游程、以游程序为车道序居中错开 LANE_STEP_PX——fan-in/fan-out
 * 不再叠成一根线；同游程 = 跨度互不重叠，共享车道不无谓铺开（贪心首碰归属，
 * 端点相触视作重叠）。
 * loop-back 见 loopBackPoints。端点缺失（边引用不存在节点——防御解析器缺口）的边
 * 不产出（跳过，不抛）。
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
    if (Math.abs(y1 - y2) < COINCIDE_EPS) {
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
    }
    pending.push({ edge, kind: 'channeled', chan })
    const key = `${x1}|${x2}`
    const list = channels.get(key)
    if (list) list.push(chan)
    else channels.set(key, [chan])
  }

  // 车道分配：通道内按 y1 升序贪心分「纵向跨度互相重叠」的游程（首碰归属，端点
  // 相触视作重叠）——游程序 = 车道序：同游程的边互不重叠可共线，跨游程必重叠
  // 必须分道；整通道按游程数以默认中位为中心居中错开（单游程回到中位不动）
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
