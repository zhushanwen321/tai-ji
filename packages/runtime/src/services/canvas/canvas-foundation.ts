/**
 * CanvasService 领域原语层（problem-solve-canvas U2）——错误 / 事件形状 / 图查询 /
 * 状态机 / 就绪递归 / 收敛门禁 / 待重审标记。
 *
 * 设计锚点：.tmp/tech-design/problem-solve-canvas.md §3.1(1) + §5-U2；概念文档
 * （不变量与状态机的上游 SSOT）：.tmp/problem-solve-canvas.md §2.3 / §2.4 / §2.5 / §2.7。
 *
 * 本文件零 IO；与 canvas-actions.ts（per-action 状态应用）/ canvas-review-actions.ts
 * （审查聚合三动作）/ canvas-domain.ts（mutate 主入口门面）构成单向依赖
 * foundation ← review-actions ← actions ← domain，无环。
 */
import {
  ACTION_EVENT_MAP,
  canvasError,
  type CanvasAction,
  type CanvasActionParams,
  type CanvasActor,
  type CanvasEdge,
  type CanvasErrorCode,
  type CanvasError,
  type CanvasEventType,
  type CanvasNode,
  type CanvasNodeLifecycle,
  type CanvasState,
} from '@zhushanwen/extension-protocol'
import { defineStateMachine } from '@zhushanwen/state-machine'
import type { IllegalTransitionInfo } from '@zhushanwen/state-machine'

/** mutate 词表的写面（16 action 减 read / list 两个查询类——查询不产事件、不在对账范围）。 */
export type CanvasMutationAction = Exclude<CanvasAction, 'read' | 'list'>
/** 图变换类 action（create 之外：create 无 prev 状态，走独立 applyCreate）。 */
export type CanvasTransformAction = Exclude<CanvasMutationAction, 'create'>

/**
 * 领域层状态形状（CanvasState 减去归属字段）：ownerSessionId 由服务层从落盘路径推导
 * 注入（契约「服务层唯一写入点」——领域事件流不承载归属，CanvasCreated 事件 data 不含
 * sessionId），故领域纯函数（applyCreate / applyMutation / 重放）的产出不含该字段；
 * 服务层 withOwner 是领域态 → CanvasState 的唯一收口。
 */
export type CanvasDomainState = Omit<CanvasState, 'ownerSessionId'>

/** 判别联合：按 action 收窄 params（与契约 CanvasMutateRequest 同构、减去 read/list/create）。 */
export type CanvasTransformRequest = {
  [A in CanvasTransformAction]: { action: A; params: CanvasActionParams[A] }
}[CanvasTransformAction]

// ── 领域错误（结构化：错误码 + 恢复动作文案，对齐分级错误处理契约）──

/** 领域拒绝（不变量 / 状态机 / 矩阵 / 寻址失败）的唯一抛出形态；mutate 入口 catch 后转 reply 失败腿。 */
export class CanvasDomainError extends Error {
  constructor(public readonly detail: CanvasError) {
    super(detail.message)
    this.name = 'CanvasDomainError'
  }
}

export function fail(code: CanvasErrorCode, message: string): never {
  throw new CanvasDomainError(canvasError(code, message))
}

export function isCanvasDomainError(e: unknown): e is CanvasDomainError {
  return e instanceof CanvasDomainError
}

// ── 领域事件（events.jsonl 行的语义形状；seq/eventId 编号在落盘层）──

/** 一次 mutate 产出的单条领域事件体（who=actor / when=at / why=data.reason / what=data）。 */
export interface CanvasEventBody { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  type: CanvasEventType
  action: CanvasMutationAction
  actor: CanvasActor
  /** ISO 时间戳；一次 mutate 的全部事件共享同一 at（重放时恢复状态用）。 */
  at: string
  /** 事件载荷 = 该 action 的 params（+ 生成 id 见 generated）——事件流单独即可全量重建。 */
  data: Record<string, unknown>
}

/** 事件构造辅助：type 取 ACTION_EVENT_MAP 主映射（对账 SSOT 单点）。 */
export function eventOf(action: CanvasMutationAction, actor: CanvasActor, at: string, data: Record<string, unknown>): CanvasEventBody {
  return { type: ACTION_EVENT_MAP[action], action, actor, at, data }
}

/** runtime 生成 id 随事件落盘的通道（重放自足：直写 ≡ 重放的关键）。 */
export interface GeneratedIds { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  canvasId?: string
  rootNodeId?: string
  commentId?: string
}

/**
 * comment 评论 id 的锚定分隔符（applyComment 产 `${anchorId}${COMMENT_ID_SEPARATOR}<生成段>`
 * 契约形态；generated.commentId 落盘完整 id）。写侧（applyComment 拼接）与重放读侧
 * （按落盘 id 反解生成段）共用本常量——分隔符形态单点定义，两端不得漂移。
 */
export const COMMENT_ID_SEPARATOR = '#c-'

export function eventData(params: Record<string, unknown>, generated?: GeneratedIds): Record<string, unknown> {
  return generated ? { ...params, generated } : { ...params }
}

/** runtime 生成 id 的供给口（live 注入随机源；重放注入 fail-fast——生成 id 必随事件落盘）。 */
export interface IdGenerator { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  next(): string
}

/** 重放专用 id 源：事件 data 未带生成 id 即抛（数据损坏 fail-fast，不静默另造破坏等价性）。 */
export const replayIdGenerator: IdGenerator = {
  next(): string {
    throw new CanvasDomainError(canvasError('invalid_params', '重放事件缺少生成 id（generated），事件流数据损坏：以 events.jsonl 为准检查该行'))
  },
}

export interface AppliedMutation { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  state: CanvasDomainState
  events: CanvasEventBody[]
  /** 主事件类型（广播 evType；主事件 = events[0]，对账 SSOT 见 ACTION_EVENT_MAP）。 */
  evType: CanvasEventType
  summary: string
}

export interface CreateIds { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  canvasId: string
  rootNodeId: string
}

// ── 图查询辅助（纯，作用于领域态 CanvasDomainState）────────────────

export function nodeOf(state: CanvasDomainState, id: string): CanvasNode | undefined {
  return state.nodes.find((n) => n.id === id)
}

export function edgeOf(state: CanvasDomainState, id: string): CanvasEdge | undefined {
  return state.edges.find((e) => e.id === id)
}

/** 主干边（decompose + resolve）——就绪递归与成环检测的作用域（概念 §2.3 R3）。 */
export function isTrunkEdge(e: CanvasEdge): boolean {
  return e.type === 'decompose' || e.type === 'resolve'
}

/** 反向主干邻居：nodeId 作为子端（decompose.to / resolve.to）时的全部父 id。 */
export function parentIdsOf(state: CanvasDomainState, nodeId: string): string[] {
  return state.edges.filter((e) => isTrunkEdge(e) && e.to === nodeId).map((e) => e.from)
}

/** 分解出边：nodeId 作为父端（decompose.from）的子 question 集（option 就绪递归用）。 */
export function decomposeChildrenOf(state: CanvasDomainState, nodeId: string): string[] {
  return state.edges.filter((e) => e.type === 'decompose' && e.from === nodeId).map((e) => e.to)
}

/** question 的选定方案（不变量 3：至多一条——由 select 写入路径保证）。 */
export function selectedOptionOf(state: CanvasDomainState, questionId: string): CanvasNode | undefined {
  for (const e of state.edges) {
    if (e.type !== 'resolve' || e.from !== questionId) continue
    const option = nodeOf(state, e.to)
    if (option?.selected) return option
  }
  return undefined
}

/**
 * 待重审上溯路径（不变量 9 / D9）：从 nodeId 沿反向主干边收集到根的全部路径途经节点
 * （多父形态全路径收集，含起点与根——根判据是上溯终点）。无环由不变量 2 保证，递归必终止。
 */
export function pathToRoot(state: CanvasDomainState, nodeId: string): string[] {
  const visited = new Set<string>()
  const queue = [nodeId]
  while (queue.length > 0) {
    const cur = queue.pop() as string
    if (visited.has(cur)) continue
    visited.add(cur)
    for (const p of parentIdsOf(state, cur)) {
      if (!visited.has(p)) queue.push(p)
    }
  }
  return [...visited]
}

/** 主干向下子树：从 rootId 沿 decompose 出边可达的节点集（含自身）——换选 D9 用。 */
export function subtreeOf(state: CanvasDomainState, rootId: string): Set<string> {
  const visited = new Set<string>([rootId])
  const queue = [rootId]
  while (queue.length > 0) {
    const cur = queue.shift() as string
    for (const child of decomposeChildrenOf(state, cur)) {
      if (!visited.has(child)) {
        visited.add(child)
        queue.push(child)
      }
    }
  }
  return visited
}

/** 论据节点的极性（裁决点 R1：极性是论据节点字段——边不重复承载）。 */
export function argumentPolarity(state: CanvasDomainState, argumentNodeId: string): 'support' | 'object' | undefined {
  return nodeOf(state, argumentNodeId)?.polarity
}

// ── 不变量 2：主干无环 ────────────────────────────────────────

/** 主干子图（decompose + resolve）DFS 成环检测；返回环上任一节点 id（错误消息用），无环返回 null。 */
export function findTrunkCycle(state: CanvasDomainState): string | null {
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  for (const n of state.nodes) color.set(n.id, WHITE)
  const trunkFrom = new Map<string, string[]>()
  for (const e of state.edges) {
    if (!isTrunkEdge(e)) continue
    trunkFrom.set(e.from, [...(trunkFrom.get(e.from) ?? []), e.to])
  }
  const visit = (id: string): string | null => {
    color.set(id, GRAY)
    for (const to of trunkFrom.get(id) ?? []) {
      const c = color.get(to) ?? WHITE
      if (c === GRAY) return to
      if (c === WHITE) {
        const found = visit(to)
        if (found) return found
      }
    }
    color.set(id, BLACK)
    return null
  }
  for (const n of state.nodes) {
    if ((color.get(n.id) ?? WHITE) === WHITE) {
      const found = visit(n.id)
      if (found) return found
    }
  }
  return null
}

// ── 状态机（概念 §2.4：生命周期维度合法转移表）────────────────

/**
 * 生命周期状态机（@zhushanwen/state-machine 行式声明；设计锚点
 * state-machine-infrastructure §6 D6-M5）：draft→under-review / draft→shelved /
 * under-review→passed / under-review→rejected / under-review→shelved /
 * rejected→draft（复活，须留理由）/ shelved→draft。表外（含自转移、passed 终态、
 * rejected 直转 passed——不变量 4）一律 fail-fast。派发维度正交（node.dispatch 字段，
 * 不经本机）。
 *
 * 事件词表从 transition action 的目标态语义派生（事件名 = params.to 的目标态名）——
 * mutate 词表 16 action 中仅 transition 驱动本机，其余不改 lifecycle（事件维度按此收窄）。
 *
 * 表外转移由 errorPolicy:'throw' + errorFactory 构造既有 CanvasDomainError（
 * lifecycle_transition_illegal 错误码 + recover 恢复指引随 canvasError 构造性携带）
 * ——canvas-service 三处 catch 与 canvas-message-handler 两处 isCanvasDomainError
 * 分类分支按 instanceof 命中，类型保形非仅消息形态。
 */
function canvasLifecycleErrorFactory(info: IllegalTransitionInfo): Error {
  return new CanvasDomainError(
    canvasError(
      'lifecycle_transition_illegal',
      `状态机不允许「${info.from}」→「${info.on}」（rejected / shelved 须先复活为 draft）`,
    ),
  )
}

export const canvasLifecycleMachine = defineStateMachine<CanvasNodeLifecycle, CanvasNodeLifecycle>({
  name: 'canvas-node-lifecycle',
  states: {
    draft: {},
    'under-review': {},
    passed: { terminal: true },
    rejected: {},
    shelved: {},
  },
  initial: 'draft',
  events: {
    draft: {},
    'under-review': {},
    passed: {},
    rejected: {},
    shelved: {},
  },
  transitions: [
    { from: 'draft', on: 'under-review', to: 'under-review' },
    { from: 'draft', on: 'shelved', to: 'shelved' },
    { from: 'under-review', on: 'passed', to: 'passed' },
    { from: 'under-review', on: 'rejected', to: 'rejected' },
    { from: 'under-review', on: 'shelved', to: 'shelved' },
    { from: 'rejected', on: 'draft', to: 'draft' },
    { from: 'shelved', on: 'draft', to: 'draft' },
  ],
  errorPolicy: 'throw',
  errorFactory: canvasLifecycleErrorFactory,
})

// ── 就绪递归（概念 §2.3）─────────────────────────────────────

/** option 就绪 = 无分解子问题，或子问题全部就绪。 */
export function isOptionReady(state: CanvasDomainState, optionId: string): boolean {
  const children = decomposeChildrenOf(state, optionId)
  return children.every((qid) => isQuestionReady(state, qid))
}

/**
 * question 就绪（概念 §2.3 递归 + 其 decompose 边语义的直接落实）：
 * - 该问题被 rejected/shelved = 判定范围外，恒就绪；
 * - resolve 路径：存在 selected 方案且该方案就绪（§2.3 字面）；
 * - decompose 路径：分解子问题全部就绪（§2.3 表「父元素的完成由子问题集的解决构成」
 *   ——根问题通常只有 decompose 子、无 resolve 候选，缺此路径任何标准画布不可收敛）；
 * - 两路并存时须同时成立（两条完成路径缺一不可）；
 * - 两路皆无 = 悬空问题（无完成路径），不就绪。
 */
export function isQuestionReady(state: CanvasDomainState, questionId: string): boolean {
  const node = nodeOf(state, questionId)
  if (!node) return false
  if (node.lifecycle === 'rejected' || node.lifecycle === 'shelved') return true
  const selected = selectedOptionOf(state, questionId)
  const children = decomposeChildrenOf(state, questionId)
  if (!selected && children.length === 0) return false
  if (selected && !isOptionReady(state, selected.id)) return false
  return children.every((qid) => isQuestionReady(state, qid))
}

/** 根就绪（收敛门禁②的就绪递归半边）。 */
export function isRootReady(state: CanvasDomainState): boolean {
  return isQuestionReady(state, state.root.nodeId)
}

/**
 * 执行叶子 = dispatchable 标记的 option（裁决点 R5：叶子是结构派生、执行叶子是显式
 * 规划决策；「叶子 = 无分解出边的 selected 方案」的结构侧由就绪递归承载）。
 */
export function dispatchableLeaves(state: CanvasDomainState): CanvasNode[] {
  return state.nodes.filter((n) => n.type === 'option' && n.dispatchable === true)
}

// ── 收敛门禁（概念 §2.7 三门禁 + 任务书 activeLeaves 非空断言）──

/**
 * 收敛阻断项清单（空数组 = 三门禁全绿）。converge-check 与 export 共用（不变量 10）。
 * ① 根判据确认（converge-check 点击即确认，前置 = 判据存在）；② 就绪递归 + 执行叶子全
 * passed 带判据；③ must-fix 清零 + 待重审空；另含 activeLeaves 非空断言（防空集 vacuous 通过）。
 */
export function convergenceBlockers(state: CanvasDomainState): string[] {
  const blockers: string[] = []
  if (state.root.criterias.length === 0) {
    blockers.push('根节点缺完成判据')
  }
  if (!isRootReady(state)) {
    blockers.push('就绪递归未成立（根未就绪：存在无选定方案或子树未就绪的问题）')
  }
  const leaves = dispatchableLeaves(state)
  if (leaves.length === 0) {
    blockers.push('画布没有执行叶子（无 dispatchable 标记的选定方案），无交付单元')
  }
  for (const leaf of leaves) {
    if (leaf.lifecycle !== 'passed') {
      blockers.push(`执行叶子「${leaf.id}」未通过审查（当前 ${leaf.lifecycle}）`)
    } else if (!leaf.criterias || leaf.criterias.length === 0) {
      blockers.push(`执行叶子「${leaf.id}」缺完成判据`)
    }
  }
  const openMustFix = (state.review?.entries ?? []).filter((e) => e.severity === 'must-fix' && !e.resolution)
  if (openMustFix.length > 0) {
    blockers.push(`还有 ${openMustFix.length} 条 must-fix 未处置`)
  }
  if (state.dirtyPaths.length > 0) {
    blockers.push(`还有 ${state.dirtyPaths.length} 条待重审路径未清`)
  }
  return blockers
}

// ── 待重审标记（不变量 9 的写入原语）──────────────────────────

export const SUMMARY_TRUNCATE_MAX = 30
export const CANVAS_NAME_MAX = 24

export function truncate(s: string, max = SUMMARY_TRUNCATE_MAX): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

export function markDirty(draft: CanvasDomainState, ids: string[]): void {
  for (const id of ids) {
    if (!draft.dirtyPaths.includes(id)) draft.dirtyPaths.push(id)
  }
}

/** 附属事件 DirtiedPathMarked（不在 ACTION_EVENT_MAP——非独立 action，概念 §2.6）。 */
export function dirtyEvent(draft: CanvasDomainState, action: CanvasMutationAction, actor: CanvasActor, at: string, path: string[]): CanvasEventBody {
  return { type: 'DirtiedPathMarked', action, actor, at, data: { canvasId: draft.canvasId, path } }
}
