/**
 * DAG 列式布局纯函数（workflow-visualization 设计 §3.2「自绘 SVG，手写布局」：
 * 按 phase 列分区，调用点按词法序排列）。
 *
 * 输入 = u2 冻结的 WorkflowDag（shared 协议类型），输出 = 画布几何（分区矩形 /
 * 节点左上角坐标 / 画布总尺寸）。纯函数零 IO、零 DOM——构建者白盒测试对象。
 *
 * 布局规则：
 * - 分区列：WorkflowDagPhase.order 升序从左到右；分区内节点按 templateName
 *   词法序（codepoint）垂直排列——同列词法序是设计原型的排列口径。
 * - 节点归属分区缺失（node.phase 不在 phases 清单，防御解析器缺省分区缺口）时
 *   动态补尾部分区，节点不丢弃。
 * - 并行组（parallelGroups）v1 不画组框：同组节点天然同列相邻（同 phase 内词法
 *   序排列），并行语义由调用点行内的实例列表表达（设计 §3.1-3 最小形态）。
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
/** 零节点 run 的最小占位尺寸（渲染层出摘要卡的底板）。 */
const EMPTY_DAG_MIN_W = 240
const EMPTY_DAG_MIN_H = 96
/** 中心点除数（矩形中心 = 左上 + 尺寸/2）。 */
const HALF = 2

/** 布局后的节点几何（x/y = 左上角，画布坐标系）。 */
export interface DagLayoutNode { // oe-exempt:20261002:framework:workflow-viz 布局产物数据形状类型——列式布局纯函数的输出契约（数据形状非抽象接口，layout 单源）
  node: WorkflowDagNode
  x: number
  y: number
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
 */
function layoutCluster(phase: string, members: WorkflowDagNode[], x: number): {
  cluster: DagLayoutCluster
  placed: DagLayoutNode[]
} {
  const nodeStepY = DAG_NODE_H + NODE_GAP
  const innerWidth = DAG_NODE_W + CLUSTER_PAD_X * HALF
  const placed = members.map((node, i) => ({
    node,
    x: x + CLUSTER_PAD_X,
    y: CLUSTER_PAD_TOP + CLUSTER_TITLE_H + i * nodeStepY,
  }))
  const contentHeight =
    CLUSTER_PAD_TOP + CLUSTER_TITLE_H + members.length * nodeStepY - NODE_GAP + CLUSTER_PAD_BOTTOM
  const minBySingleNode = CLUSTER_PAD_TOP + CLUSTER_TITLE_H + DAG_NODE_H + CLUSTER_PAD_BOTTOM
  const cluster: DagLayoutCluster = {
    phase,
    x,
    y: 0,
    width: innerWidth,
    height: Math.max(contentHeight, minBySingleNode),
  }
  return { cluster, placed }
}

/**
 * 计算 DAG 列式布局。零节点 run（纯门禁脚本）：nodes 空数组、clusters 空、
 * 画布取最小占位尺寸——渲染层出单节点摘要卡提示（设计 §3.1-3，卡片由画布组件
 * 渲染，不归布局）。
 */
export function layoutDag(dag: WorkflowDag): DagLayout {
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
    const { cluster, placed } = layoutCluster(phase.name, members, cursorX)
    clusters.push(cluster)
    nodes.push(...placed)
    maxBottom = Math.max(maxBottom, cluster.height)
    cursorX += cluster.width + CLUSTER_GAP_X
  }

  // 零分区（零节点 run）：最小占位，渲染层出摘要卡
  const width = clusters.length > 0 ? cursorX - CLUSTER_GAP_X : EMPTY_DAG_MIN_W
  const height = clusters.length > 0 ? maxBottom : EMPTY_DAG_MIN_H
  return { clusters, nodes, width, height }
}

/** 布局后的边几何：path d 串 + 条件边谓词标注锚点（画布坐标）。 */
export interface DagLayoutEdge { // oe-exempt:20261002:framework:workflow-viz 布局产物数据形状类型——列式布局纯函数的输出契约（数据形状非抽象接口，layout 单源）
  edge: WorkflowDagEdge
  /** SVG path d 串（fill:none）。 */
  d: string
  /** 谓词标注锚点（kind='conditional' 时携带；取路径中点近似）。 */
  labelX?: number
  labelY?: number
}

/** 回边下探深度（画布坐标系常量——loop-back 走节点行下方绕行）。 */
const LOOP_DROP = 28
/** 水平贝塞尔的控制点外伸（相邻列间距的一半，下限 40 保证弧度可见）。 */
const EDGE_CTRL_MIN = 40

/**
 * 计算边几何。顺序/数据流/条件边 = 源右中心 → 目标左中心的三次贝塞尔；
 * loop-back = 源底中心 → 目标底中心的下绕弧（循环回边的视觉区分形态）。
 * 端点缺失（边引用不存在节点——防御解析器缺口）的边不产出（跳过，不抛）。
 */
export function layoutEdges(dag: WorkflowDag, nodes: DagLayoutNode[]): DagLayoutEdge[] {
  const byId = new Map<string, DagLayoutNode>()
  for (const ln of nodes) byId.set(ln.node.id, ln)

  const result: DagLayoutEdge[] = []
  for (const edge of dag.edges) {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (!from || !to) continue
    const x1 = from.x + DAG_NODE_W
    const y1 = from.y + DAG_NODE_H / HALF
    const x2 = to.x
    const y2 = to.y + DAG_NODE_H / HALF
    if (edge.kind === 'loop-back') {
      // 底部绕行弧：两节点行下方 LOOP_DROP 处圆滑连接（视觉区分循环回边）
      const yb = Math.max(from.y, to.y) + DAG_NODE_H + LOOP_DROP
      const bx1 = from.x + DAG_NODE_W / HALF
      const bx2 = to.x + DAG_NODE_W / HALF
      result.push({ edge, d: `M ${bx1} ${from.y + DAG_NODE_H} C ${bx1} ${yb}, ${bx2} ${yb}, ${bx2} ${to.y + DAG_NODE_H}` })
      continue
    }
    const dx = Math.max(EDGE_CTRL_MIN, Math.abs(x2 - x1) / HALF)
    const midX = (x1 + x2) / HALF
    const midY = (y1 + y2) / HALF
    result.push({ edge, d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`, labelX: midX, labelY: midY })
  }
  return result
}
