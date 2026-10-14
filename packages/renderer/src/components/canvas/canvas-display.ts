/**
 * canvas 展示派生（problem-solve-canvas §3.1(3) U7）——CanvasState → 只读展示投影的
 * 单处实现（节点卡 / 论据条 / 边渲染 / 布局共用；不复制 runtime 领域规则）。
 *
 * 派生边界（任务书「领域判定规则」条款）：
 * - 阶段枚举（生长中/审查中/已收敛）与未处置 must-fix 计数是**契约明文委托 renderer 的
 *   派生值**（extension-protocol canvas/state.ts CanvasListEntry 注释），此处按契约口径实现；
 * - 就绪递归（收敛门禁②）是 runtime 领域规则，renderer 不复刻——收敛门禁面板只呈现
 *   ①③两格（root.confirmed / must-fix+dirtyPaths 均契约直读字段），门禁②以 runtime
 *   converge-check / export 的结构化拒绝为准（错误 message 已含完整阻断清单）。
 *
 * 布局（demo v3 内核平移，.tmp/problem-solve-canvas-demo-v3.html layout computed）：
 * 主干定主轴（根在上向下分层），论据收于宿主卡内不占画布位，约束节点不进主干流
 * （底部约束带呈现）；节点高度由调用方实测回填（ResizeObserver），估高仅首帧占位。
 */
import type {
  CanvasComment,
  CanvasEdge,
  CanvasNode,
  CanvasNodeType,
  CanvasState,
  ReviewEntry,
} from '@zhushanwen/extension-protocol'

// ── 阶段枚举（契约 CanvasListEntry 注释的 renderer 派生口径）──────────────────

/** 画布阶段徽标枚举（托盘列表与画布头部共用；派生值非新增可写状态）。 */
export type CanvasPhase = 'growing' | 'reviewing' | 'converged'

/** 未处置 must-fix 条目（resolution 缺席 = 未处置；first-writer-wins 处置记录见契约）。 */
export function openMustFixOf(state: CanvasState): ReviewEntry[] {
  return (state.review?.entries ?? []).filter((e) => e.severity === 'must-fix' && e.resolution === undefined)
}

/**
 * 阶段派生（契约注释逐字口径）：converged = 已收敛；开放 must-fix 或审查进行中 =
 * 审查中；其余 = 生长中。审查停回终态（max-rounds/escalated/stuck）不属「进行中」。
 */
export function canvasPhaseOf(state: CanvasState): CanvasPhase {
  if (state.converged) return 'converged'
  if (openMustFixOf(state).length > 0 || state.review?.status === 'in-progress') return 'reviewing'
  return 'growing'
}

// ── 图关系投影（节点卡 / 论据条 / 边渲染共用）─────────────────────────────────

/** 主干边（decompose/resolve——布局主轴与 SVG 边层的成员；argue/rebut 另两通道呈现）。 */
export function trunkEdgesOf(state: CanvasState): CanvasEdge[] {
  return state.edges.filter((e) => e.type === 'decompose' || e.type === 'resolve')
}

/** 主干邻接：parent(from) → children(to)（decompose 与 resolve 同为 parent→child 方向）。 */
export function trunkKidsOf(state: CanvasState): Map<string, string[]> {
  const kids = new Map<string, string[]>()
  for (const e of trunkEdgesOf(state)) {
    const list = kids.get(e.from) ?? []
    list.push(e.to)
    kids.set(e.from, list)
  }
  return kids
}

/** 节点的主干父节点（decompose/resolve 边 to===nodeId 的 from；根为 null）。 */
export function trunkParentOf(state: CanvasState, nodeId: string): string | null {
  const edge = trunkEdgesOf(state).find((e) => e.to === nodeId)
  return edge ? edge.from : null
}

/** question 的当前选定方案（selected 标记的 resolve 子节点；不变量 3 保证至多一条）。 */
export function selectedOptionIdOf(state: CanvasState, questionId: string): string | null {
  for (const e of state.edges) {
    if (e.type !== 'resolve' || e.from !== questionId) continue
    const opt = nodeOf(state, e.to)
    if (opt?.selected) return opt.id
  }
  return null
}

/** option 所属的 question（resolve 边 from——select params.questionId 的来源）。 */
export function questionIdOfOption(state: CanvasState, optionId: string): string | null {
  const edge = state.edges.find((e) => e.type === 'resolve' && e.to === optionId)
  return edge ? edge.from : null
}

export function nodeOf(state: CanvasState, id: string): CanvasNode | undefined {
  return state.nodes.find((n) => n.id === id)
}

// ── 论据通道（框内论据条 + 互驳留痕）─────────────────────────────────────────

export interface HostArgs { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  support: CanvasNode[]
  object: CanvasNode[]
}

/**
 * 宿主节点的框内论据分组（argue 边 to===hostId，按论据极性分支持/反对两横条；
 * 论据不占画布位——挂宿主卡内，demo §3.2 布局法则 2）。
 */
export function argsOfHost(state: CanvasState, hostId: string): HostArgs {
  const g: HostArgs = { support: [], object: [] }
  for (const e of state.edges) {
    if (e.type !== 'argue' || e.to !== hostId) continue
    const arg = nodeOf(state, e.from)
    if (!arg || arg.type !== 'argument') continue
    ;(arg.polarity === 'object' ? g.object : g.support).push(arg)
  }
  return g
}

/** 论据的锚定目标（argue 边 to：宿主节点 id 或主干边 id；离卡呈现用）。 */
export function argTargetIdOf(state: CanvasState, argId: string): string | null {
  const edge = state.edges.find((e) => e.type === 'argue' && e.from === argId)
  return edge ? edge.to : null
}

/** 被 rebut 的论据清单（rebut 边 to===argId 的 from 论据节点）。 */
export function rebuttersOf(state: CanvasState, argId: string): CanvasNode[] {
  return state.edges
    .filter((e) => e.type === 'rebut' && e.to === argId)
    .map((e) => nodeOf(state, e.from))
    .filter((n): n is CanvasNode => n !== undefined && n.type === 'argument')
}

/** 论据的反驳对象（rebut 边 from===argId 的 to 论据节点）。 */
export function rebutTargetOf(state: CanvasState, argId: string): CanvasNode | null {
  const edge = state.edges.find((e) => e.type === 'rebut' && e.from === argId)
  const target = edge ? nodeOf(state, edge.to) : undefined
  return target ?? null
}

// ── 评论附件（锚定附件，非图成员）─────────────────────────────────────────────

/** 锚定目标的评论（节点 id 或边 id）。 */
export function commentsOfAnchor(state: CanvasState, anchorId: string): CanvasComment[] {
  return state.comments.filter((c) => c.anchorId === anchorId)
}

/** 待响应评论数（响应义务在 agent 侧，不变量 8；角标醒目形态的数据源）。 */
export function pendingCommentCountOf(state: CanvasState, anchorId: string): number {
  return commentsOfAnchor(state, anchorId).filter((c) => c.status === 'pending').length
}

// ── 待重审 / 折叠 / 执行叶子 ─────────────────────────────────────────────────

/** 节点是否在待重审集合（节点卡专属角标的数据源；门禁③「待重审=空」由此可感知）。 */
export function isDirtyPath(state: CanvasState, nodeId: string): boolean {
  return state.dirtyPaths.includes(nodeId)
}

/** 节点的被否决 resolve 子节点数（否决折叠 chip 的计数；rejected 折叠不消失）。 */
export function rejectedKidsCountOf(state: CanvasState, nodeId: string): number {
  return state.edges.filter((e) => {
    if (e.type !== 'resolve' || e.from !== nodeId) return false
    return nodeOf(state, e.to)?.lifecycle === 'rejected'
  }).length
}

/** 执行叶子清单（dispatchable 标记的 option——裁决点 R5：叶子是规划决策非结构派生）。 */
export function dispatchableLeavesOf(state: CanvasState): CanvasNode[] {
  return state.nodes.filter((n) => n.type === 'option' && n.dispatchable === true)
}

// ── 布局（demo v3 内核平移）──────────────────────────────────────────────────

export interface LayoutPos { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  x: number
  y: number
  w: number
  h: number
}

export interface CanvasLayout { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  /** 主干节点位置表（仅 question/option 占画布位；argument/约束不进布局）。 */
  pos: Map<string, LayoutPos>
  /** 全图包围盒（fitView / SVG 尺寸 / 网格底纹的依据）。 */
  bbox: { x1: number; y1: number; x2: number; y2: number }
  maxDepth: number
}

// ── 布局常量（demo v3 同名档位平移；magic number 收敛单点）────────────────────

/** 主干节点卡宽（demo NW：question/option 同宽；论据收卡内、约束进底部带）。 */
const TRUNK_NODE_WIDTH = 296
/** 兄弟节点水平间距（demo SGAP）。 */
const SIBLING_GAP = 26
/** 层间垂直间距（demo VGAP）。 */
const LAYER_GAP = 42
/** 画布顶部起始留白（demo acc 初值）。 */
const TOP_MARGIN = 30
/** 中点除数（/2 类中点运算的命名收敛——no-magic-numbers）。 */
const MIDPOINT_DIVISOR = 2
/** 归一化后画布左缘最小留白（demo off 判据）。 */
const NORMALIZE_MIN_X = 60
/** 空画布包围盒最小高度占位（bbox 下限，首帧 fitView 不塌缩）。 */
const MIN_BBOX_HEIGHT = 96
/** 边起点自父卡底边的回退量（抗亚像素渲染缝，靠不透明卡体遮挡）。 */
const EDGE_START_INSET = 6
/** resolve 边终点微入量（保持箭头可见；decompose 用标准 inset）。 */
const EDGE_END_INSET_RESOLVE = 2

/** 主干节点卡宽档位（question/option 同宽；其余类型不占画布位返回 0）。 */
export function nodeWidthOf(type: CanvasNodeType): number {
  return type === 'question' || type === 'option' ? TRUNK_NODE_WIDTH : 0
}

/**
 * 主干布局：深度分层（层高 = 该层实测高度最大值）+ 子树宽递归 + 父对子树居中 +
 * 负 x 归一。heightOf 由调用方注入（DOM offsetHeight 实测优先、估高兜底——demo
 * realH/estH 同款分工）；hidden 判据供否决折叠（折叠子树整支让位，重排由响应式触发）。
 */
export function computeCanvasLayout(
  state: CanvasState,
  opts: { heightOf: (id: string) => number; hidden?: (id: string) => boolean },
): CanvasLayout {
  const kids = trunkKidsOf(state)
  const isHidden = (id: string): boolean => opts.hidden?.(id) ?? false
  const rootId = state.root.nodeId

  // 1. 深度（跳过隐藏子树）
  const depth = new Map<string, number>()
  const walk = (id: string, dp: number): void => {
    if (depth.has(id)) return
    depth.set(id, dp)
    for (const k of kids.get(id) ?? []) {
      if (!isHidden(k)) walk(k, dp + 1)
    }
  }
  walk(rootId, 0)
  const maxDepth = depth.size > 0 ? Math.max(...depth.values()) : 0

  // 2. 层高：只由主干节点实测/估算高度决定（论据已收进框内）
  const yOf = new Map<number, number>()
  let acc = TOP_MARGIN
  for (let dp = 0; dp <= maxDepth; dp++) {
    let need = 0
    for (const [id, dd] of depth) {
      if (dd === dp) need = Math.max(need, opts.heightOf(id))
    }
    yOf.set(dp, acc)
    acc += need + LAYER_GAP
  }

  // 3. 水平：子树宽递归（节点占位即自身宽度）
  const subW = new Map<string, number>()
  const measure = (id: string): number => {
    const self = nodeWidthOf(nodeOf(state, id)?.type ?? 'question')
    const kl = (kids.get(id) ?? []).filter((k) => !isHidden(k))
    let kw = 0
    for (const k of kl) kw += measure(k)
    kw += Math.max(0, kl.length - 1) * SIBLING_GAP
    const w = Math.max(self, kw)
    subW.set(id, w)
    return w
  }
  measure(rootId)

  const pos = new Map<string, LayoutPos>()
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  const place = (id: string, x0: number): void => {
    const node = nodeOf(state, id)
    if (!node) return
    const w = nodeWidthOf(node.type)
    const kl = (kids.get(id) ?? []).filter((k) => !isHidden(k))
    let nx: number
    if (kl.length === 0) {
      nx = x0 + ((subW.get(id) ?? w) - w) / MIDPOINT_DIVISOR
    } else {
      let kw = 0
      for (const k of kl) kw += subW.get(k) ?? 0
      kw += (kl.length - 1) * SIBLING_GAP
      let cx = x0 + ((subW.get(id) ?? w) - kw) / MIDPOINT_DIVISOR
      let first = 0
      let last = 0
      kl.forEach((k, i) => {
        place(k, cx)
        if (i === 0) first = cx
        last = cx + (subW.get(k) ?? 0)
        cx += (subW.get(k) ?? 0) + SIBLING_GAP
      })
      nx = (first + last) / MIDPOINT_DIVISOR - w / MIDPOINT_DIVISOR
    }
    const h = opts.heightOf(id)
    pos.set(id, { x: nx, y: yOf.get(depth.get(id) ?? 0) ?? TOP_MARGIN, w, h })
    minX = Math.min(minX, nx)
    maxX = Math.max(maxX, nx + w)
    maxY = Math.max(maxY, (yOf.get(depth.get(id) ?? 0) ?? TOP_MARGIN) + h)
  }
  place(rootId, 0)

  // 4. 归一化：负 x（父对子树居中可产生）平移进画布
  const off = Math.max(0, NORMALIZE_MIN_X - minX)
  if (off > 0) {
    for (const p of pos.values()) p.x += off
    minX += off
    maxX += off
  }
  return {
    pos,
    bbox: { x1: minX, y1: TOP_MARGIN, x2: maxX, y2: Math.max(maxY, TOP_MARGIN + MIN_BBOX_HEIGHT) },
    maxDepth,
  }
}

/** 主干边 SVG 路径（demo edgePath 平移：起点 = 父卡底边中点，终点 = 子卡顶边中点；
 * C 曲线垂直出入；resolve 终点微入保箭头可见）。 */
export function edgePathOf(a: LayoutPos, b: LayoutPos, type: CanvasEdge['type']): string {
  const x1 = a.x + a.w / MIDPOINT_DIVISOR
  const y1 = a.y + a.h - EDGE_START_INSET
  const x2 = b.x + b.w / MIDPOINT_DIVISOR
  const y2 = type === 'resolve' ? b.y + EDGE_END_INSET_RESOLVE : b.y + EDGE_START_INSET
  const my = (y1 + y2) / MIDPOINT_DIVISOR
  return `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`
}
