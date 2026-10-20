/**
 * CanvasService 领域应用层（problem-solve-canvas U2）——per-action 状态应用与校验。
 *
 * 每个 mutation action 的领域规则（存在性 / 邻接矩阵 / 状态机 / 不变量 fail-fast +
 * 状态变更 + 事件构造）一一对应一个 applyX 纯函数（审查三动作在 canvas-review-actions.ts，
 * 其余在本文件）；live mutate 与崩溃后重建重放共用（直写 ≡ 重放的构造点）。原语
 * （fail / 图查询 / 状态机 / 待重审标记）来自 canvas-foundation.ts，依赖单向：
 * foundation ← review-actions ← 本文件 ← canvas-domain.ts（主入口）。
 */
import { isArgumentMateriality, isArgumentPolarity } from '@zhushanwen/extension-protocol'
import type { CanvasActionParams, CanvasActor, CanvasComment, CanvasCreateParams, CanvasEdge, CanvasGrowItem, CanvasNode } from '@zhushanwen/extension-protocol'
import {
  argumentPolarity,
  CANVAS_NAME_MAX,
  canvasLifecycleMachine,
  COMMENT_ID_SEPARATOR,
  convergenceBlockers,
  dirtyEvent,
  edgeOf,
  eventData,
  eventOf,
  fail,
  findTrunkCycle,
  isTrunkEdge,
  markDirty,
  nodeOf,
  pathToRoot,
  selectedOptionOf,
  subtreeOf,
  truncate,
  type CanvasDomainState,
  type CanvasEventBody,
  type CanvasTransformRequest,
  type CreateIds,
  type IdGenerator,
} from './canvas-foundation.js'
import { applyReviewAppend, applyReviewRequest, applyReviewResolve } from './canvas-review-actions.js'

function pushEvent(events: CanvasEventBody[], body: CanvasEventBody): void {
  events.push(body)
}

/**
 * canvas_edit 族 reason 留痕纪律（契约文件头「canvas_edit 族共享 reason 强制字段」的
 * 运行时落地）——空串（含纯空白）fail-fast。空 reason 会产出「已更新（内容）：」式
 * 残缺 summary 与空 why 留痕（F1-14）；与 comment-respond 的 note、transition 的
 * rejection.reason 空串校验同口径（契约守卫只查 isString，空串可过——runtime 是防线）。
 */
function assertReason(reason: string): void {
  if (reason.trim() === '') fail('invalid_params', '变更必须留痕（reason：改动理由 / 对比说明）——不允许无理由改动')
}

// ── create（不变量 1：根三要素；无 prev 状态，独立于 applyMutation）──

/**
 * 创建画布（聚合根诞生）。canvasId / rootNodeId 由服务层生成并经 ids 传入（随事件
 * data.generated 落盘——重放按事件值恢复，不重新生成）。criterias 空数组拒绝：
 * 根完成判据是收敛判据的存在前提（概念文档「不可砍三样」之首）。
 */
export function applyCreate(
  params: CanvasCreateParams,
  actor: CanvasActor,
  at: string,
  ids: CreateIds,
): { state: CanvasDomainState; events: CanvasEventBody[]; evType: CanvasEventBody['type']; summary: string } {
  if (params.statement.trim() === '') fail('invalid_params', '根问题陈述（statement）为空')
  if (params.criterias.length === 0) fail('invalid_params', '根完成判据（criterias）至少一条——否则收敛无判据（不可砍项）')
  // 归属字段不在此填充（领域事件流不承载归属）——服务层 withOwner 从落盘路径推导注入。
  const state: CanvasDomainState = {
    canvasId: ids.canvasId,
    name: params.name?.trim() || truncate(params.statement.trim(), CANVAS_NAME_MAX),
    root: {
      nodeId: ids.rootNodeId,
      statement: params.statement,
      criterias: [...params.criterias],
      scopeExclusions: [...params.scopeExclusions],
    },
    direction: null,
    nodes: [{
      id: ids.rootNodeId,
      type: 'question',
      content: params.statement,
      lifecycle: 'draft',
      createdAt: at,
    }],
    edges: [],
    comments: [],
    dirtyPaths: [],
    review: null,
    converged: false,
    createdAt: at,
    updatedAt: at,
  }
  const events: CanvasEventBody[] = [
    eventOf('create', actor, at, eventData({ ...params }, { canvasId: ids.canvasId, rootNodeId: ids.rootNodeId })),
  ]
  return { state, events, evType: events[0]!.type, summary: `画布「${state.name}」已创建：${truncate(params.statement)}` }
}

// ── 主分发（canvas-domain.applyMutation 的骨架；本文件内聚 per-action 规则）──

export function applyByAction(
  draft: CanvasDomainState,
  req: CanvasTransformRequest,
  actor: CanvasActor,
  at: string,
  idGen: IdGenerator,
  events: CanvasEventBody[],
): string {
  switch (req.action) {
    case 'grow': return applyGrow(draft, req.params, actor, at, events)
    case 'patch': return applyPatch(draft, req.params, actor, at, events)
    case 'decide-direction': return applyDecideDirection(draft, req.params, actor, at, events)
    case 'select': return applySelect(draft, req.params, actor, at, events)
    case 'transition': return applyTransition(draft, req.params, actor, at, events)
    case 'comment': return applyComment(draft, req.params, actor, at, idGen, events)
    case 'comment-respond': return applyCommentRespond(draft, req.params, actor, at, events)
    case 'review-request': return applyReviewRequest(draft, req.params, actor, at, events)
    case 'review-append': return applyReviewAppend(draft, req.params, actor, at, events)
    case 'review-resolve': return applyReviewResolve(draft, req.params, actor, at, events)
    case 'converge-check': return applyConvergeCheck(draft, actor, at, events)
    case 'export': return applyExport(draft, req.params, actor, at, events)
    case 'dispatch': return applyDispatch(draft, req.params, actor, at, events)
  }
}

// ── grow（批量原子事务 + 邻接矩阵 + 不变量 2 + 幂等重试判定）──

function applyGrow(
  draft: CanvasDomainState,
  params: CanvasActionParams['grow'],
  actor: CanvasActor,
  at: string,
  events: CanvasEventBody[],
): string {
  assertReason(params.reason)
  if (params.batch.length === 0) fail('invalid_params', 'grow 批为空：至少一条生长条目')
  // 原子事务：批内逐条在 draft 副本上应用，任一 fail-fast 即整体拒绝（draft 丢弃，无部分写入）。
  for (const item of params.batch) {
    applyGrowItem(draft, item, at)
  }
  draft.updatedAt = at
  pushEvent(events, eventOf('grow', actor, at, eventData({ ...params })))
  const types = new Set(params.batch.map((i) => i.type))
  return `新增 ${params.batch.length} 个元素（${[...types].join('/')}）：${truncate(params.reason)}`
}

/** grow 单条：新节点 + 连接边。节点 id 由 agent 生成（幂等重试判定的键）；边 id 确定性
 * 派生自节点 id（`e-<节点id>`）——同 id 重试按声明一致性判定（下方 growItemDivergence）：
 * 声明一致 = 原样保留（幂等无副作用），声明分歧 = 拒绝。 */
function applyGrowItem(draft: CanvasDomainState, item: CanvasGrowItem, at: string): void {
  validateGrowVocabulary(item)
  validateGrowAdjacency(draft, item)
  const existing = nodeOf(draft, item.id)
  if (existing) {
    // 幂等重试判定（设计 §3.1(1)「同 id 重复写入无副作用」的落地）：声明字段（type /
    // content / argument 内在属性 / 边三要素）与已落盘节点完全一致 = 真重试，原样保留；
    // 不一致 = 声明分歧，fail-fast 拒绝并指引走 patch。grow 是创建语义——静默覆盖会
    // 改写内容却不进待重审传播（D9 传播集只覆盖 patch / select / comment），审查过的
    // 内容被无痕改写。factVerified / dispatchable / criterias 等 patch 可演化的字段
    // 不参与比对（重试携带的是首次声明值，与演化后值不同属正常）。
    const divergence = growItemDivergence(existing, item, draft)
    if (divergence) {
      fail('invalid_params', `节点「${item.id}」已存在且与本次 grow 声明不一致（${divergence}）：grow 是创建语义，幂等重试须携带与首次完全一致的内容；修改已存在节点请用 patch`)
    }
    return
  }
  const node: CanvasNode = {
    id: item.id,
    type: item.type,
    content: item.content,
    lifecycle: 'draft',
    createdAt: at,
  }
  if (item.type === 'argument') {
    // 素材性：契约缺省 claim；fact 必带核实状态（不变量 5 前半句构造性满足——缺省 false 即已携带）。
    node.materiality = item.materiality ?? 'claim'
    node.polarity = item.edgePolarity
    if (node.materiality === 'fact') node.factVerified = item.factVerified ?? false
  }
  if (item.type === 'option' && item.dispatchable === true) {
    node.dispatchable = true
  }
  // 新节点直达（已存在节点在上方幂等判定处早退——保留原对象，积累状态不丢失）。
  draft.nodes.push(node)
  const edgeId = `e-${item.id}`
  // 边方向按概念 §2.3 邻接表：主干边（decompose/resolve）= 父/问题 → 新子节点；
  // 附属边（argue/rebut）= 新 argument 节点 → 被论证 / 被反驳目标。
  const edge: CanvasEdge = (item.edge === 'decompose' || item.edge === 'resolve')
    ? { id: edgeId, type: item.edge, from: item.attachTo, to: item.id }
    : { id: edgeId, type: item.edge, from: item.id, to: item.attachTo }
  const existingEdge = edgeOf(draft, edgeId)
  if (existingEdge) {
    draft.edges[draft.edges.indexOf(existingEdge)] = edge
  } else {
    draft.edges.push(edge)
  }
  if (item.edge === 'decompose' || item.edge === 'resolve') {
    // 不变量 2 的结构性兜底：新边恒指新节点（无出边）→ 当前 action 面下不可达；同 id
    // 重挂边（历史成环通道）已被上方分歧判定 upfront 拦截。边重挂类 action 若未来进
    // 词表，此处即拦截点——检测逻辑由 findTrunkCycle 纯函数单测覆盖（不靠本路径）。
    const cyclic = findTrunkCycle(draft)
    if (cyclic) fail('cycle_detected', `该边使主干成环（经节点「${cyclic}」）`)
  }
}

/**
 * grow 重试的声明一致性判定：返回 null = 与首次写入完全一致（幂等重试，原样保留）；
 * 返回非空字符串 = 分歧描述（调用方 fail-fast）。
 *
 * 比对范围 = grow 声明拥有且无其他 action 演化的字段：type / content / argument 的
 * materiality+polarity（内在属性）/ 连接边三要素（边无变更 action，创建后不可变）。
 * factVerified / dispatchable / criterias / lifecycle 等 patch 可演化的字段刻意不入
 * 比对——重试携带的是首次声明值，与演化后值不同是正常形态，纳入会把合法重试误判为分歧。
 */
function growItemDivergence(existing: CanvasNode, item: CanvasGrowItem, draft: CanvasDomainState): string | null {
  if (existing.type !== item.type) return `类型「${existing.type}」与本次声明「${item.type}」不一致`
  if (existing.content !== item.content) return '内容与首次写入不一致'
  if (item.type === 'argument') {
    if (existing.materiality !== (item.materiality ?? 'claim')) return '素材性与首次写入不一致'
    if (existing.polarity !== item.edgePolarity) return '论据极性与首次写入不一致'
  }
  const existingEdge = edgeOf(draft, `e-${item.id}`)
  if (!existingEdge) return '连接边缺失'
  const isTrunk = item.edge === 'decompose' || item.edge === 'resolve'
  const expectFrom = isTrunk ? item.attachTo : item.id
  const expectTo = isTrunk ? item.id : item.attachTo
  if (existingEdge.type !== item.edge || existingEdge.from !== expectFrom || existingEdge.to !== expectTo) {
    return '连接边与首次写入不一致'
  }
  return null
}

/** grow 单条值域校验（runtime 第二道防线，契约守卫 isCanvasGrowItem 同口径——handler
 * 层守卫外的直调通道与历史事件重放在此兜底）：词表外极性不得落盘——'Support' 大小写
 * 漂移落盘后不匹配 argumentPolarity(...) === 'support'，伪 support 论据绕过 unverified_fact
 * 拦截面（不变量 5）；素材性词表外值同理不判 fact。文案给合法值域（与 argue/rebut 极性
 * 强制同形态）。 */
function validateGrowVocabulary(item: CanvasGrowItem): void {
  if (item.edgePolarity !== undefined && !isArgumentPolarity(item.edgePolarity)) {
    fail('invalid_params', `论据极性（edgePolarity）必须是 support | object，收到「${item.edgePolarity}」`)
  }
  if (item.materiality !== undefined && !isArgumentMateriality(item.materiality)) {
    fail('invalid_params', `素材性（materiality）必须是 fact | claim，收到「${item.materiality}」`)
  }
}

/** 邻接合法性（概念 §2.3 边模型，MVP 四种边）：表外组合 invalid_params；端点缺失
 * node_not_found / edge_not_found。每种边型的规则拆单条子守卫（各自圈复杂度预算内
 * ——单 switch 25 分支超 metrics 门禁阈值）。 */
function validateGrowAdjacency(draft: CanvasDomainState, item: CanvasGrowItem): void {
  const attachNode = nodeOf(draft, item.attachTo)
  const attachEdge = attachNode ? undefined : edgeOf(draft, item.attachTo)
  switch (item.edge) {
    case 'decompose':
      validateDecomposeAdjacency(item, attachNode)
      return
    case 'resolve':
      validateResolveAdjacency(item, attachNode)
      return
    case 'argue':
      validateArgueAdjacency(item, attachNode, attachEdge)
      return
    case 'rebut':
      validateRebutAdjacency(item, attachNode)
      return
  }
}

/** decompose：子端必须 question，父端必须 question / option 且存在。 */
function validateDecomposeAdjacency(item: CanvasGrowItem, attachNode: CanvasNode | undefined): void {
  if (item.type !== 'question') fail('invalid_params', `decompose 边的子端必须是 question，收到「${item.type}」`)
  if (!attachNode) fail('node_not_found', `decompose 父节点「${item.attachTo}」不存在`)
  if (attachNode.type !== 'question' && attachNode.type !== 'option') {
    fail('invalid_params', `decompose 父端必须是 question 或 option，收到「${attachNode.type}」`)
  }
}

/** resolve：子端必须 option，父端必须存在且为 question。 */
function validateResolveAdjacency(item: CanvasGrowItem, attachNode: CanvasNode | undefined): void {
  if (item.type !== 'option') fail('invalid_params', `resolve 边的子端必须是 option，收到「${item.type}」`)
  if (!attachNode) fail('node_not_found', `resolve 所在问题「${item.attachTo}」不存在`)
  if (attachNode.type !== 'question') fail('invalid_params', `resolve 父端必须是 question，收到「${attachNode.type}」`)
}

/** argue：起点必须 argument 且带极性；目标 = question / option 节点或主干边。 */
function validateArgueAdjacency(item: CanvasGrowItem, attachNode: CanvasNode | undefined, attachEdge: CanvasEdge | undefined): void {
  if (item.type !== 'argument') fail('invalid_params', `argue 边的起点必须是 argument，收到「${item.type}」`)
  if (item.edgePolarity === undefined) fail('invalid_params', 'argue 边必带极性（edgePolarity: support | object）')
  if (!attachNode && !attachEdge) fail('node_not_found', `被论证目标「${item.attachTo}」不存在`)
  if (attachNode && attachNode.type !== 'question' && attachNode.type !== 'option') {
    fail('invalid_params', `argue 只论证 question / option / 主干边，收到「${attachNode.type}」`)
  }
  if (attachEdge && !isTrunkEdge(attachEdge)) fail('invalid_params', 'argue 指边时只能指主干边（decompose / resolve）')
}

/** rebut：起点必须 argument 且带极性（与 argue 同口径——工具面 edgePolarity 的
 * REQUIRED 承诺在 runtime 的执行点，「论据带极性」统一语言的收口）；目标必须存在且为 argument。 */
function validateRebutAdjacency(item: CanvasGrowItem, attachNode: CanvasNode | undefined): void {
  if (item.type !== 'argument') fail('invalid_params', `rebut 边的起点必须是 argument，收到「${item.type}」`)
  if (item.edgePolarity === undefined) fail('invalid_params', 'rebut 边必带极性（edgePolarity: support | object）')
  if (!attachNode) fail('node_not_found', `被反驳论据「${item.attachTo}」不存在`)
  if (attachNode.type !== 'argument') fail('invalid_params', `rebut 的目标必须是 argument，收到「${attachNode.type}」`)
}

// ── patch（内容编辑 + root 三要素同步 + 不变量 5/7/9）──────────

function applyPatch(
  draft: CanvasDomainState,
  params: CanvasActionParams['patch'],
  actor: CanvasActor,
  at: string,
  events: CanvasEventBody[],
): string {
  assertReason(params.reason)
  const node = nodeOf(draft, params.nodeId)
  if (!node) fail('node_not_found', `待编辑节点「${params.nodeId}」不存在`)
  const changes: string[] = []
  // per-field 拆子应用函数（各自圈复杂度预算内——单函数 17 分支超 metrics 门禁阈值）；
  // 字段应用顺序 = 校验顺序 = content → criterias → dispatchable → factVerified（保持）。
  applyPatchContent(draft, node, params, changes)
  applyPatchCriterias(draft, node, params, changes)
  applyPatchDispatchable(node, params, changes)
  applyPatchFactVerified(node, params, changes)
  if (changes.length === 0) fail('invalid_params', 'patch 未携带任何可编辑字段（content / criterias / dispatchable / factVerified 至少一项）')
  // D9：用户改动 → 上溯路径进待重审（不变量 9）。agent 修复不触发（处置表承载复审范围）。
  if (actor === 'user') {
    const added = pathToRoot(draft, node.id)
    markDirty(draft, added)
    pushEvent(events, dirtyEvent(draft, 'patch', actor, at, added))
  }
  draft.updatedAt = at
  pushEvent(events, eventOf('patch', actor, at, eventData({ ...params })))
  return `节点「${truncate(node.content)}」已更新（${changes.join('/')}）：${truncate(params.reason)}`
}

/** content 字段应用：节点内容 + 根问题时同步 root.statement（元数据镜像，单处）。 */
function applyPatchContent(
  draft: CanvasDomainState,
  node: CanvasNode,
  params: CanvasActionParams['patch'],
  changes: string[],
): void {
  if (params.content === undefined) return
  node.content = params.content
  changes.push('内容')
  if (node.id === draft.root.nodeId) draft.root.statement = params.content
}

/** criterias 字段应用：根问题写 root.criterias、执行叶子写节点（不变量 7 的载体域）。 */
function applyPatchCriterias(
  draft: CanvasDomainState,
  node: CanvasNode,
  params: CanvasActionParams['patch'],
  changes: string[],
): void {
  if (params.criterias === undefined) return
  if (node.type !== 'option' && node.id !== draft.root.nodeId) {
    fail('invalid_params', '完成判据只能编辑在根问题或执行叶子（option）上')
  }
  if (node.id === draft.root.nodeId) draft.root.criterias = [...params.criterias]
  else node.criterias = [...params.criterias]
  changes.push('判据')
}

/** dispatchable 字段应用：执行叶子标记（只能设在 option 上）。 */
function applyPatchDispatchable(node: CanvasNode, params: CanvasActionParams['patch'], changes: string[]): void {
  if (params.dispatchable === undefined) return
  if (node.type !== 'option') fail('invalid_params', '执行叶子标记（dispatchable）只能设在 option 上')
  node.dispatchable = params.dispatchable
  changes.push(params.dispatchable ? '标记执行叶子' : '取消执行叶子')
}

/** factVerified 字段应用：核实状态翻转（只能设在 fact 论据上——不变量 5）。 */
function applyPatchFactVerified(node: CanvasNode, params: CanvasActionParams['patch'], changes: string[]): void {
  if (params.factVerified === undefined) return
  if (node.type !== 'argument' || node.materiality !== 'fact') {
    fail('invalid_params', '核实状态（factVerified）只能翻转在 fact 论据上')
  }
  node.factVerified = params.factVerified
  changes.push(params.factVerified ? '核实' : '撤销核实')
}

// ── decide-direction（画布元数据 + 事件留痕，R4：非图节点）────

function applyDecideDirection(
  draft: CanvasDomainState,
  params: CanvasActionParams['decide-direction'],
  actor: CanvasActor,
  at: string,
  events: CanvasEventBody[],
): string {
  assertReason(params.reason)
  draft.direction = { direction: params.direction, reason: params.reason, decidedAt: at }
  draft.updatedAt = at
  pushEvent(events, eventOf('decide-direction', actor, at, eventData({ ...params })))
  return `生长方向已裁决：${params.direction === 'top-down' ? '自顶向下' : '自底向上'}（${truncate(params.reason)}）`
}

// ── select（不变量 3：至多一条 selected + 换选迁移 + D9）──────

function applySelect(
  draft: CanvasDomainState,
  params: CanvasActionParams['select'],
  actor: CanvasActor,
  at: string,
  events: CanvasEventBody[],
): string {
  assertReason(params.reason)
  const question = nodeOf(draft, params.questionId)
  if (!question || question.type !== 'question') fail('node_not_found', `目标问题「${params.questionId}」不存在或不是 question`)
  const option = nodeOf(draft, params.optionId)
  if (!option || option.type !== 'option') fail('node_not_found', `目标方案「${params.optionId}」不存在或不是 option`)
  if (!draft.edges.some((e) => e.type === 'resolve' && e.from === params.questionId && e.to === params.optionId)) {
    fail('invalid_params', `方案「${params.optionId}」不是问题「${params.questionId}」的候选（无 resolve 边相连）`)
  }
  const current = selectedOptionOf(draft, params.questionId)
  if (current && current.id !== params.optionId) {
    if (!params.replace) {
      fail('selection_conflict', `该问题已选定方案「${truncate(current.content)}」`)
    }
    if (params.replace.fromOptionId !== current.id) {
      fail('invalid_params', `replace.fromOptionId「${params.replace.fromOptionId}」不是该问题当前选定方案「${current.id}」`)
    }
    // 换选迁移（同一调用事务内）：先迁出旧 selected 再置新（不变量 3 的迁移语义承载）。
    current.selected = false
    current.selectionReason = undefined
  }
  option.selected = true
  option.selectionReason = params.reason
  // D9：用户选定 → 上溯路径进待重审；换选 → 旧选中方案整个子树一并进入（旧支柱已被换下）。
  if (actor === 'user') {
    const added = [...pathToRoot(draft, params.questionId)]
    if (params.replace) {
      for (const id of subtreeOf(draft, params.replace.fromOptionId)) {
        if (!added.includes(id)) added.push(id)
      }
    }
    markDirty(draft, added)
    pushEvent(events, dirtyEvent(draft, 'select', actor, at, added))
  }
  draft.updatedAt = at
  pushEvent(events, eventOf('select', actor, at, eventData({ ...params })))
  const verb = params.replace ? '换选' : '选定'
  return `方案已${verb}：「${truncate(option.content)}」（${truncate(params.reason)}）`
}

// ── transition（状态机 + 不变量 4/5/7 + 根豁免）──────────────

function applyTransition(
  draft: CanvasDomainState,
  params: CanvasActionParams['transition'],
  actor: CanvasActor,
  at: string,
  events: CanvasEventBody[],
): string {
  assertReason(params.reason)
  const node = nodeOf(draft, params.nodeId)
  if (!node) fail('node_not_found', `目标节点「${params.nodeId}」不存在`)
  if (node.id === draft.root.nodeId && (params.to === 'shelved' || params.to === 'rejected')) {
    fail('lifecycle_transition_illegal', '根节点不可搁置 / 否决（否则就绪递归对根豁免将使收敛门禁空集通过）')
  }
  // 表外转移（含自转移 / passed 终态 / 词表外 to）由机器 errorFactory 抛既有
  // CanvasDomainError（lifecycle_transition_illegal + recover 指引）——判定与拒绝
  // 单入口；状态应用（node.lifecycle 赋值）与事件构造仍在本函数（编排留域内）。
  canvasLifecycleMachine.transition(node.lifecycle, params.to)
  if (params.to === 'rejected') {
    if (!params.rejection?.reason) fail('invalid_params', '否决（rejected）必须附否决记录（rejection.reason）——否决分支灰显保留、不可删除')
    node.rejection = { reason: params.rejection.reason, reviveCondition: params.rejection.reviveCondition }
  }
  if (params.to === 'passed') {
    assertPassable(draft, node)
  }
  // 否决 / 搁置 = 放弃该候选（不变量 3 的转移侧语义）：selected 标记同步清除——被
  // 否决 / 搁置的方案不得继续以选定身份参与就绪递归（收敛门禁②）与导出渲染；复活为
  // draft 后须重新 select。重放执行同一函数同清除（StateTransitioned 事件的 params
  // 确定性重导出该效果，直写 ≡ 重放，无需独立事件）。仅在 selected 命中时覆写，避免
  // 给全部节点强加 selected: false 的序列化形态。
  if ((params.to === 'rejected' || params.to === 'shelved') && node.selected === true) {
    node.selected = false
    node.selectionReason = undefined
  }
  const from = node.lifecycle
  node.lifecycle = params.to
  draft.updatedAt = at
  pushEvent(events, eventOf('transition', actor, at, eventData({ ...params })))
  return `节点「${truncate(node.content)}」状态：${from} → ${params.to}（${truncate(params.reason)}）`
}

/** 不变量 5 + 7：passed 前置——执行叶子判据必填；支撑该节点的 fact 论据必须已核实。 */
function assertPassable(draft: CanvasDomainState, node: CanvasNode): void {
  if (node.type === 'option' && node.dispatchable === true && (!node.criterias || node.criterias.length === 0)) {
    fail('lifecycle_transition_illegal', `执行叶子「${node.id}」passed 前必须填写完成判据（不变量 7）`)
  }
  const supporting = draft.edges.filter((e) => e.type === 'argue' && e.to === node.id && argumentPolarity(draft, e.from) === 'support')
  for (const e of supporting) {
    const arg = nodeOf(draft, e.from)
    if (arg && arg.materiality === 'fact' && arg.factVerified !== true) {
      fail('unverified_fact', `未核实的 fact 论据「${truncate(arg.content)}」不得作为 passed 的依据（不变量 5）`)
    }
  }
}

// ── comment / comment-respond（不变量 8 响应义务）────────────

function applyComment(
  draft: CanvasDomainState,
  params: CanvasActionParams['comment'],
  actor: CanvasActor,
  at: string,
  idGen: IdGenerator,
  events: CanvasEventBody[],
): string {
  const anchorNode = nodeOf(draft, params.anchorId)
  const anchorEdge = anchorNode ? undefined : edgeOf(draft, params.anchorId)
  if (!anchorNode && !anchorEdge) fail('node_not_found', `评论锚定目标「${params.anchorId}」不存在（节点或边 id）`)
  const commentId = `${params.anchorId}${COMMENT_ID_SEPARATOR}${idGen.next()}`
  const comment: CanvasComment = { id: commentId, anchorId: params.anchorId, text: params.text, status: 'pending', createdAt: at }
  draft.comments.push(comment)
  // D9：用户评论 = 注入议题 → 锚定目标（节点；锚边取子端）上溯路径进待重审。
  if (actor === 'user') {
    const added = pathToRoot(draft, anchorNode ? anchorNode.id : (anchorEdge as CanvasEdge).to)
    markDirty(draft, added)
    pushEvent(events, dirtyEvent(draft, 'comment', actor, at, added))
  }
  draft.updatedAt = at
  pushEvent(events, eventOf('comment', actor, at, eventData({ ...params }, { commentId })))
  return `新评论（锚定「${truncate(params.anchorId)}」）：${truncate(params.text)}`
}

function applyCommentRespond(
  draft: CanvasDomainState,
  params: CanvasActionParams['comment-respond'],
  actor: CanvasActor,
  at: string,
  events: CanvasEventBody[],
): string {
  const comment = draft.comments.find((c) => c.id === params.commentId)
  if (!comment) fail('invalid_params', `评论「${params.commentId}」不存在：先 canvas_read 核对评论 id`)
  if (comment.status === 'responded') fail('invalid_params', `评论「${comment.id}」已响应（${comment.response?.disposition}）：不得重复响应`)
  if (params.note.trim() === '') fail('invalid_params', '响应必须留痕（note：采纳的落实说明 / 反驳的理由）——不允许无视')
  comment.status = 'responded'
  comment.response = { disposition: params.disposition, note: params.note }
  draft.updatedAt = at
  pushEvent(events, eventOf('comment-respond', actor, at, eventData({ ...params })))
  return `评论已响应（${params.disposition === 'adopted' ? '采纳' : '反驳'}）：${truncate(params.note)}`
}

// ── converge-check / export（不变量 10 三门禁）────────────────

function applyConvergeCheck(
  draft: CanvasDomainState,
  actor: CanvasActor,
  at: string,
  events: CanvasEventBody[],
): string {
  const blockers = convergenceBlockers(draft)
  if (blockers.length > 0) {
    fail('not_converged', `收敛门禁未通过（${blockers.length} 项）：${blockers.join('；')}`)
  }
  // 门禁①：根判据确认（用户点击 converge-check 即确认动作本身）。
  draft.root.confirmed = true
  draft.converged = true
  if (draft.review) {
    draft.review.status = 'converged'
    pushEvent(events, { type: 'ReviewConverged', action: 'converge-check', actor, at, data: { canvasId: draft.canvasId } })
  }
  draft.updatedAt = at
  pushEvent(events, eventOf('converge-check', actor, at, eventData({ canvasId: draft.canvasId })))
  return '规划收敛已确认：三门禁全绿（根判据确认 / 就绪递归成立 / must-fix 清零且待重审为空）'
}

function applyExport(
  draft: CanvasDomainState,
  params: CanvasActionParams['export'],
  actor: CanvasActor,
  at: string,
  events: CanvasEventBody[],
): string {
  const blockers = convergenceBlockers(draft)
  // 导出前置 = converge-check 同门禁（不变量 10）+ 收敛确认已执行（converged 终态）——
  // 两条表面同一前置：GUI 导出面板门禁①（root.confirmed）与 runtime 同口径，agent 代
  // 执行导出不因通道不同绕过用户确认（converge-check 按权限矩阵仅 user 可调，其存在
  // 意义即导出门禁；恢复文案「确认根判据」由此可达——旧实现只查 blocker 集，未经确认
  // 的画布在 agent 通道可导出，与设计 §3.1(3)「export 内部同校验——未收敛即拒」分裂）。
  const unconfirmed = !draft.converged
  if (unconfirmed || blockers.length > 0) {
    const items = blockers.length > 0 ? [...blockers] : []
    if (unconfirmed) items.push('尚未执行收敛确认（converge-check：三门禁全绿后用户点「确认收敛」）')
    fail('not_converged', `画布未收敛，导出被拒（${items.length} 项）：${items.join('；')}`)
  }
  if (params.target.target === 'requirement-card') {
    const leaf = nodeOf(draft, params.target.leafId)
    if (!leaf || leaf.type !== 'option' || leaf.dispatchable !== true) {
      fail('node_not_found', `需求卡目标「${params.target.leafId}」不存在或不是执行叶子`)
    }
  }
  draft.updatedAt = at
  pushEvent(events, eventOf('export', actor, at, eventData({ ...params })))
  return params.target.target === 'planning-doc' ? '方向规划文档已导出' : `需求卡已导出（叶子 ${params.target.leafId}）`
}

// ── dispatch（不变量 7 + D8）─────────────────────────────────

const DISPATCH_POINTER_MAX = 40

function applyDispatch(
  draft: CanvasDomainState,
  params: CanvasActionParams['dispatch'],
  actor: CanvasActor,
  at: string,
  events: CanvasEventBody[],
): string {
  const node = nodeOf(draft, params.nodeId)
  if (!node) fail('node_not_found', `派发目标「${params.nodeId}」不存在`)
  if (node.type !== 'option' || node.dispatchable !== true) fail('dispatch_blocked', `「${params.nodeId}」不是执行叶子（dispatchable option）`)
  if (node.lifecycle !== 'passed') fail('dispatch_blocked', `执行叶子「${truncate(node.content)}」未通过审查（当前 ${node.lifecycle}）：先经审查转 passed 再派发`)
  // 不变量 7 后半句：下游产物指针必填——空串（含纯空白）= 无指针，dispatched 状态失去
  // 「派到哪」的解读依据（指针是用户手填的设计文档 / impl-plan 位置）。寻址与 passed
  // 门槛先行，本校验落状态变更前一步——拒绝即无写入，node.dispatch 不落。
  if (params.pointer.trim() === '') fail('invalid_params', '派发指针（pointer）为空：下游产物指针必填（设计文档 / impl-plan 位置，用户手填）')
  node.dispatch = { pointer: params.pointer, dispatchedAt: at }
  draft.updatedAt = at
  pushEvent(events, eventOf('dispatch', actor, at, eventData({ ...params })))
  return `执行叶子「${truncate(node.content)}」已派发 → ${truncate(params.pointer, DISPATCH_POINTER_MAX)}`
}
