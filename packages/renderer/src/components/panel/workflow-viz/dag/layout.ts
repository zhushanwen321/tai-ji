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
 * 边路由（正交化，2026-10 用户裁决替代原贝塞尔）：全部边只走横竖两向——
 * - 顺序/数据流/条件边：源右中心 → 中位竖线 → 目标左中心的三段折线（同行退化直线）；
 * - loop-back：源底中心下探 → 底部总线（全图最深节点下方）横行 → 目标底中心；
 *   同列回边走分区左内边距的侧向细道，不在节点列内穿过。
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
  /** 谓词标注锚点（kind='conditional' 时携带；置于中位竖线旁）。 */
  labelX?: number
  labelY?: number
}

/** 回边下探深度（画布坐标系常量——loop-back 横行走全图最深节点下方）。 */
const LOOP_DROP = 28
/** 同列回边侧向细道的偏移（CLUSTER_PAD_X=12 的内边距带内，不穿节点列）。 */
const LOOP_SIDE_OFFSET = 8
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
 * 计算边几何（正交路由）。顺序/数据流/条件边 = 源右中心 → 中位竖线 → 目标左中心
 * （同行退化为直线）；loop-back = 源底中心下探至全图最深节点下方 LOOP_DROP 处横行
 * → 目标底中心（同列回边改走分区左内边距侧向细道，不在节点列内折返）。
 * 端点缺失（边引用不存在节点——防御解析器缺口）的边不产出（跳过，不抛）。
 */
export function layoutEdges(dag: WorkflowDag, nodes: DagLayoutNode[]): DagLayoutEdge[] {
  const byId = new Map<string, DagLayoutNode>()
  for (const ln of nodes) byId.set(ln.node.id, ln)

  // 全图最深节点底（loop-back 横行总线的 y——压在所有分区内容之下，不穿行内节点）
  let deepestBottom = 0
  for (const ln of nodes) deepestBottom = Math.max(deepestBottom, ln.y + ln.h)

  const result: DagLayoutEdge[] = []
  for (const edge of dag.edges) {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (!from || !to) continue
    let points: DagPoint[]
    let labelX: number | undefined
    let labelY: number | undefined
    if (edge.kind === 'loop-back') {
      const fromBottom = from.y + from.h
      const toBottom = to.y + to.h
      const bx1 = from.x + DAG_NODE_W / HALF
      const bx2 = to.x + DAG_NODE_W / HALF
      if (Math.abs(bx1 - bx2) < COINCIDE_EPS) {
        // 同列回边：侧向细道在节点左缘之外的内边距带（不穿节点列，也不穿源节点自身）
        const sx = Math.min(from.x, to.x) - LOOP_SIDE_OFFSET
        points = [
          { x: bx1, y: fromBottom },
          { x: sx, y: fromBottom },
          { x: sx, y: toBottom },
          { x: bx2, y: toBottom },
        ]
      } else {
        const busY = Math.max(deepestBottom, fromBottom, toBottom) + LOOP_DROP
        points = [
          { x: bx1, y: fromBottom },
          { x: bx1, y: busY },
          { x: bx2, y: busY },
          { x: bx2, y: toBottom },
        ]
      }
    } else {
      const x1 = from.x + DAG_NODE_W
      const y1 = from.y + from.h / HALF
      const x2 = to.x
      const y2 = to.y + to.h / HALF
      if (Math.abs(y1 - y2) < COINCIDE_EPS) {
        points = [{ x: x1, y: y1 }, { x: x2, y: y2 }]
        labelX = (x1 + x2) / HALF
        labelY = y1
      } else {
        const midX = (x1 + x2) / HALF
        points = [
          { x: x1, y: y1 },
          { x: midX, y: y1 },
          { x: midX, y: y2 },
          { x: x2, y: y2 },
        ]
        labelX = midX + LABEL_GAP_X
        labelY = (y1 + y2) / HALF
      }
    }
    result.push({ edge, points, d: roundedPath(points), labelX, labelY })
  }
  return result
}
