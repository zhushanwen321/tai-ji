/**
 * problem-solve-canvas 契约 —— action 参数 / 结果与运行时守卫。
 *
 * params 形状对齐设计文档 §3.1(1) action 要点与 §3.1(2) 工具面：
 * - grow/patch 的节点 id 由 agent 侧生成（全局唯一：时间戳 + 随机），写入按 id
 *   upsert（同 id 重复写入无副作用）——崩溃窗口（marker 挂起期间 pi 死亡）重试安全
 * - select 带 replace 参数（换选 = 同一调用事务内先迁出旧 selected 再置新，
 *   附对比理由——不变量 3 的迁移语义承载）
 * - canvas_edit 族共享 reason 强制字段（留痕纪律）
 *
 * 守卫边界（对齐 session-manager 先例）：类型面校验——形状 / 词表成员资格；
 * 领域校验（不变量 1-11、邻接矩阵、状态机合法转移）归 U2 CanvasService，
 * 契约层不复制不变量逻辑（避免双权威）。
 */
import { CANVAS_ACTIONS, CANVAS_MARKER_ACTIONS } from './marker.js'
import type {
  ArgumentMateriality,
  ArgumentPolarity,
  CanvasEdgeType,
  CanvasEventType,
  CanvasListEntry,
  CanvasNodeLifecycle,
  CanvasNodeType,
  CanvasState,
  ReviewDimension,
  ReviewSeverity,
  SupportRating,
} from './state.js'
import type { CanvasError } from './errors.js'

/** 三类写入方（权限矩阵建制维度）：user = GUI 直改 / agent = 工具面 / review = reviewer subagent。 */
export type CanvasActor = 'user' | 'agent' | 'review'

// ── params per action（CanvasActionParams 映射，SSOT）─────────

/** create：根三要素必填（不变量 1）。GUI 托盘「＋新建」与 canvas_enter 创建形态共用。 */
export interface CanvasCreateParams { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  /** 画布名（缺省由 runtime 按 statement 派生）。 */
  name?: string
  statement: string
  /** 完成判据（可证伪），至少一条。 */
  criterias: string[]
  /** 范围排除（设计文档 enter 参数表记作 scope）。 */
  scopeExclusions: string[]
}

/** grow 批条目：一条 = 一个新节点 + 其与既有图的一条连接边。 */
export interface CanvasGrowItem { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  /** agent 生成全局唯一 id（时间戳 + 随机）；幂等 upsert 键——崩溃窗口重试不产生重复节点。 */
  id: string
  type: CanvasNodeType
  content: string
  /** 连接目标：既有节点 id（或 argue 指主干边时的边 id）。 */
  attachTo: string
  /** 连接边类型。 */
  edge: CanvasEdgeType
  /** edge='argue' 时必带极性；同时作为 argument 节点的极性（裁决点 R1：极性是论据字段）。 */
  edgePolarity?: ArgumentPolarity
  /**
   * type='argument' 时的素材性（缺省 claim）。fact 时核实状态随事件必带
   * （不变量 5：fact 论据必须携带核实状态）——U2 领域层补写的通道。
   */
  materiality?: ArgumentMateriality
  /** materiality='fact' 时的核实状态（缺省 false = 已携带「未核实」）。 */
  factVerified?: boolean
  /** type='option' 时可显式标记执行叶子。 */
  dispatchable?: boolean
}

export interface CanvasGrowParams { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  canvasId: string
  /** 批量生长：批内任一校验失败 = 整批拒绝、无部分写入（原子事务）。 */
  batch: CanvasGrowItem[]
  /** 变更理由（留痕纪律：没有理由的 agent 改动不可审计）。 */
  reason: string
}

export interface CanvasPatchParams { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  canvasId: string
  nodeId: string
  content?: string
  /** 执行叶子完成判据编辑。 */
  criterias?: string[]
  /** 执行叶子标记变更。 */
  dispatchable?: boolean
  /** fact 论据核实状态翻转。 */
  factVerified?: boolean
  reason: string
}

export interface CanvasDecideDirectionParams { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  canvasId: string
  direction: 'top-down' | 'bottom-up'
  reason: string
}

export interface CanvasSelectParams { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  canvasId: string
  /** 被选定方案所属的 question 节点 id。 */
  questionId: string
  optionId: string
  /**
   * 换选迁移语义：同一调用事务内先迁出旧 selected（fromOptionId）再置新，
   * 旧选中方案的整个子树进入待重审（D9）。不带 replace 时旧选定已存在
   * → selection_conflict 拒绝（不变量 3）。
   */
  replace?: { fromOptionId: string }
  /** 对比理由（不变量 3：选择须留对比与理由）。 */
  reason: string
}

export interface CanvasTransitionParams { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  canvasId: string
  nodeId: string
  /** 目标生命周期态（合法转移表校验归 U2；rejected 须附否决记录——不可删除）。 */
  to: CanvasNodeLifecycle
  /** 否决记录（to='rejected' 时必填：否决理由，可附复活条件）。 */
  rejection?: { reason: string; reviveCondition?: string }
  reason: string
}

export interface CanvasCommentParams { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  canvasId: string
  /** 锚定目标：节点 id 或边 id。 */
  anchorId: string
  text: string
}

export interface CanvasCommentRespondParams { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  canvasId: string
  commentId: string
  /** 采纳（并落实到图）/ 反驳（留理由）二选一——不允许无视（不变量 8 响应义务）。 */
  disposition: 'adopted' | 'rebutted'
  /** 响应留痕（采纳的落实说明 / 反驳的理由）。 */
  note: string
}

export interface CanvasReviewRequestParams { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  canvasId: string
  /** R2+ 轮次的审查范围收窄描述（「上轮处置表 + 攻击点」）；R1 全面审缺省。 */
  scope?: string
}

/** review-append 单条报告条目输入（id 由 reviewer 生成，幂等 upsert 同 grow）。 */
export interface CanvasReviewEntryInput { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  id: string
  round: number
  dimension: ReviewDimension
  severity: ReviewSeverity
  /** 引用的图元素 id（必须存在于画布——聚合 2 不变量 1）。 */
  targetId: string
  note: string
  /**
   * 支撑度评价（概念 §2.4「边的缺陷经支撑度表达」的写入通道——审查结论随条目落
   * edge.support，round 由 runtime 按报告轮次注入「审查轮次溯源」）：targetId 须为
   * 主干边（decompose/resolve，裁决点 R3——论证边不评级），非主干边携带即拒。
   */
  supportRating?: SupportRating
  /** rating='gap' 的缺口清单（「有缺口附清单」词条语义：至少一条）；sufficient/invalid 不带。 */
  supportGaps?: string[]
}

export interface CanvasReviewAppendParams { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  canvasId: string
  /** 报告归属轮次。 */
  round: number
  entries: CanvasReviewEntryInput[]
}

export interface CanvasReviewResolveParams { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  canvasId: string
  entryId: string
  /** 处置三选一（采纳 / 登记后做 / 拒绝留理由）。 */
  disposition: 'accepted' | 'deferred' | 'rejected'
  /** 处置说明（拒绝时为拒绝理由）。 */
  note: string
}

/** converge-check：无业务参数——三门禁校验（不变量 10）+ 置 converged 终态。 */
export interface CanvasConvergeCheckParams { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  canvasId: string
}

export type CanvasExportTarget =
  | { target: 'planning-doc' }
  | { target: 'requirement-card'; /** 需求卡对应的执行叶子节点 id。 */ leafId: string }

export interface CanvasExportParams { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  canvasId: string
  target: CanvasExportTarget
}

export interface CanvasDispatchParams { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  canvasId: string
  /** 执行叶子节点 id（dispatched 前必须 passed——不变量 7）。 */
  nodeId: string
  /** 下游产物指针（必填：设计文档 / impl-plan 位置，用户手填）。 */
  pointer: string
}

export interface CanvasReadParams { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  canvasId: string
  /** 子树读取：从该节点 id 向下的主干子树；缺省读全量。 */
  subtree?: string
}

/** list：无参数（全量画布清单的 action 侧形状——归属过滤字段不在共享 params 内：
 * sessionId 是**通道级字段**（WS payload 携带、marker 通道由 dispatch 上下文的发起
 * 会话注入，与 canvas.mutate 的 actor/sessionId 同款通道字段模式），runtime 按归属
 * 会话过滤（D4 裁决 3）。Record 结构性拒绝夹带任何过滤字段）。 */
export type CanvasListParams = Record<string, never>

/** 16 action 的 params 映射（SSOT；两通道共用——WS RPC 与 marker 的 params 同构）。 */
export interface CanvasActionParams { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  create: CanvasCreateParams
  grow: CanvasGrowParams
  patch: CanvasPatchParams
  'decide-direction': CanvasDecideDirectionParams
  select: CanvasSelectParams
  transition: CanvasTransitionParams
  comment: CanvasCommentParams
  'comment-respond': CanvasCommentRespondParams
  'review-request': CanvasReviewRequestParams
  'review-append': CanvasReviewAppendParams
  'review-resolve': CanvasReviewResolveParams
  'converge-check': CanvasConvergeCheckParams
  export: CanvasExportParams
  dispatch: CanvasDispatchParams
  read: CanvasReadParams
  list: CanvasListParams
}

export type CanvasAction = (typeof CANVAS_ACTIONS)[number]

/** mutate 请求判别联合：按 action 收窄 params（renderer / handler 两侧 switch 同构收窄）。 */
export type CanvasMutateRequest = {
  [A in CanvasAction]: { action: A; params: CanvasActionParams[A] }
}[CanvasAction]

// ── marker 通道层（enter 动作）────────────────────────────────

export type CanvasMarkerAction = (typeof CANVAS_MARKER_ACTIONS)[number]

/** enter（canvas_enter 打开形态）：读全量（归属校验在 readState，非 owner → forbidden）；非画布 mutation、不产事件、无登记动作。 */
export interface CanvasEnterParams { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  canvasId: string
}

/** marker 通道 params 映射 = mutate 词表 params + enter。 */
export interface CanvasMarkerParams extends CanvasActionParams { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  enter: CanvasEnterParams
}

/** marker 请求条目（extension select 挂起载荷：[{action, params}]，session-manager 同构）。 */
export interface CanvasMarkerRequest { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  action: CanvasMarkerAction
  params: CanvasMarkerParams[CanvasMarkerAction]
}

// ── 结果形状 ──────────────────────────────────────────────────

/** mutate 统一两态信封（mcp McpMutationResult 先例；广播 canvas.updated 与本信封
 * 的成功腿同源同值——调用方拿本 mutation 的事件回执，全量状态经 canvas.get 拉取）。 */
export type CanvasMutateReply =
  | { ok: true; eventId: string; evType: CanvasEventType; summary: string }
  | { ok: false; error: CanvasError }

/** canvas.list reply。 */
export interface CanvasListReply { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  canvases: CanvasListEntry[]
}

/** enter / read 的结果：画布全量（打开即完整图——设计目标 1「用户点开即见完整图」）。 */
export type CanvasReadReply = CanvasState

// ── 运行时守卫（信任边界：marker params 来自 extension_ui_request，LLM 可控 JSON）──
// handler dispatch 前校验；非法 params 走结构化错误应答（invalid_params），
// 不经断言静默流入 service（session-manager 先例同款纪律）。

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isOptionalString(v: unknown): boolean {
  return v === undefined || typeof v === 'string'
}

function isStringArray(v: unknown): boolean {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

function isOptionalStringArray(v: unknown): boolean {
  return v === undefined || isStringArray(v)
}

function isOptionalBoolean(v: unknown): boolean {
  return v === undefined || typeof v === 'boolean'
}

function isStringIn<T extends readonly string[]>(set: T, v: unknown): v is T[number] {
  return typeof v === 'string' && (set as readonly string[]).includes(v)
}

/** optional 词表守卫：字段可缺省（undefined 放行），携带时必须落在守卫词表内——
 * 只做 isOptionalString 形状放行会让词表外值（如 'Support' 大小写漂移）流入 runtime。 */
function isOptionalGuarded(guard: (v: unknown) => boolean, v: unknown): boolean {
  return v === undefined || guard(v)
}

function isStringField(v: Record<string, unknown>, key: string): boolean {
  return typeof v[key] === 'string'
}

function requireCanvasId(v: Record<string, unknown>): boolean {
  return isStringField(v, 'canvasId')
}

export function isCanvasCreateParams(v: unknown): v is CanvasCreateParams {
  return (
    isRecord(v) &&
    isOptionalString(v.name) &&
    typeof v.statement === 'string' &&
    isStringArray(v.criterias) &&
    isStringArray(v.scopeExclusions)
  )
}

const CANVAS_NODE_TYPES = ['question', 'option', 'argument', 'constraint'] as const
const CANVAS_EDGE_TYPES = ['decompose', 'resolve', 'argue', 'rebut'] as const
const ARGUMENT_POLARITIES = ['support', 'object'] as const

/** grow 批条目守卫（类型面；attachTo 指向存在性 / 邻接合法性归 U2）。edgePolarity /
 * materiality 走词表校验而非形状放行：词表外极性（'Support'）落盘后不匹配
 * argumentPolarity(...) === 'support'，passed 的 unverified_fact 拦截面（不变量 5）失守。 */
function isCanvasGrowItem(v: unknown): v is CanvasGrowItem {
  return (
    isRecord(v) &&
    isStringField(v, 'id') &&
    isStringIn(CANVAS_NODE_TYPES, v.type) &&
    isStringField(v, 'content') &&
    isStringField(v, 'attachTo') &&
    isStringIn(CANVAS_EDGE_TYPES, v.edge) &&
    isOptionalGuarded(isArgumentPolarity, v.edgePolarity) &&
    isOptionalGuarded(isArgumentMateriality, v.materiality) &&
    isOptionalBoolean(v.factVerified) &&
    isOptionalBoolean(v.dispatchable)
  )
}

export function isCanvasGrowParams(v: unknown): v is CanvasGrowParams {
  return (
    isRecord(v) &&
    requireCanvasId(v) &&
    Array.isArray(v.batch) &&
    v.batch.every((item) => isCanvasGrowItem(item)) &&
    typeof v.reason === 'string'
  )
}

export function isCanvasPatchParams(v: unknown): v is CanvasPatchParams {
  return (
    isRecord(v) &&
    requireCanvasId(v) &&
    isStringField(v, 'nodeId') &&
    isOptionalString(v.content) &&
    isOptionalStringArray(v.criterias) &&
    isOptionalBoolean(v.dispatchable) &&
    isOptionalBoolean(v.factVerified) &&
    typeof v.reason === 'string'
  )
}

export function isCanvasDecideDirectionParams(v: unknown): v is CanvasDecideDirectionParams {
  return (
    isRecord(v) &&
    requireCanvasId(v) &&
    isStringIn(['top-down', 'bottom-up'] as const, v.direction) &&
    typeof v.reason === 'string'
  )
}

export function isCanvasSelectParams(v: unknown): v is CanvasSelectParams {
  if (!(isRecord(v) && requireCanvasId(v) && isStringField(v, 'questionId') && isStringField(v, 'optionId') && typeof v.reason === 'string')) {
    return false
  }
  if (v.replace === undefined) return true
  return isRecord(v.replace) && isStringField(v.replace, 'fromOptionId')
}

const CANVAS_LIFECYCLES = ['draft', 'under-review', 'passed', 'rejected', 'shelved'] as const

export function isCanvasTransitionParams(v: unknown): v is CanvasTransitionParams {
  if (!(isRecord(v) && requireCanvasId(v) && isStringField(v, 'nodeId') && typeof v.reason === 'string')) {
    return false
  }
  if (!isStringIn(CANVAS_LIFECYCLES, v.to)) return false
  if (v.rejection === undefined) return true
  return isRecord(v.rejection) && isStringField(v.rejection, 'reason') && isOptionalString(v.rejection.reviveCondition)
}

export function isCanvasCommentParams(v: unknown): v is CanvasCommentParams {
  return isRecord(v) && requireCanvasId(v) && isStringField(v, 'anchorId') && typeof v.text === 'string'
}

export function isCanvasCommentRespondParams(v: unknown): v is CanvasCommentRespondParams {
  return (
    isRecord(v) &&
    requireCanvasId(v) &&
    isStringField(v, 'commentId') &&
    isStringIn(['adopted', 'rebutted'] as const, v.disposition) &&
    typeof v.note === 'string'
  )
}

export function isCanvasReviewRequestParams(v: unknown): v is CanvasReviewRequestParams {
  return isRecord(v) && requireCanvasId(v) && isOptionalString(v.scope)
}

const REVIEW_DIMENSIONS = ['completeness', 'necessity', 'support', 'authenticity', 'conflict', 'depth'] as const
const REVIEW_SEVERITIES = ['must-fix', 'suggestion'] as const
const SUPPORT_RATINGS = ['sufficient', 'gap', 'invalid'] as const

/** review-append 单条守卫（round 必须为有限数；dimension/severity/supportRating 词表内；
 * gap 评价必附缺口清单、sufficient/invalid 不得夹带清单——「有缺口附清单」词条语义：
 * rating='gap' 的缺口清单至少一条，sufficient/invalid 不带）。
 *
 * 支撑度字段拆两条子守卫（单链 20 分支超 metrics 门禁圈复杂度阈值）：shape 管
 * 「字段在时的类型/词表」，semantics 管「字段间组合规则」。 */
function isCanvasReviewEntryInput(v: unknown): v is CanvasReviewEntryInput {
  return (
    isRecord(v) &&
    isStringField(v, 'id') &&
    typeof v.round === 'number' &&
    Number.isFinite(v.round) &&
    isStringIn(REVIEW_DIMENSIONS, v.dimension) &&
    isStringIn(REVIEW_SEVERITIES, v.severity) &&
    isStringField(v, 'targetId') &&
    typeof v.note === 'string' &&
    isReviewSupportShape(v) &&
    isReviewSupportSemantics(v)
  )
}

/** 支撑度字段类型面：supportRating 在词表内（可缺省）、supportGaps 为字符串数组（可缺省）。 */
function isReviewSupportShape(v: Record<string, unknown>): boolean {
  if (v.supportRating !== undefined && !isStringIn(SUPPORT_RATINGS, v.supportRating)) return false
  return v.supportGaps === undefined || isStringArray(v.supportGaps)
}

/** 支撑度字段语义面：「有缺口附清单」——rating='gap' 必附至少一条缺口清单；
 * gaps 仅随 gap 评价携带（sufficient/invalid 不带；带 gaps 则 rating 必须为 gap）。 */
function isReviewSupportSemantics(v: Record<string, unknown>): boolean {
  if (v.supportGaps === undefined) return v.supportRating !== 'gap'
  if (v.supportRating !== 'gap') return false
  // Array.isArray 收窄（类型面由 isReviewSupportShape 把关，此处防 null/散型防御性收窄）
  return Array.isArray(v.supportGaps) && v.supportGaps.length > 0
}

export function isCanvasReviewAppendParams(v: unknown): v is CanvasReviewAppendParams {
  return (
    isRecord(v) &&
    requireCanvasId(v) &&
    typeof v.round === 'number' &&
    Number.isFinite(v.round) &&
    Array.isArray(v.entries) &&
    v.entries.every((entry) => isCanvasReviewEntryInput(entry))
  )
}

export function isCanvasReviewResolveParams(v: unknown): v is CanvasReviewResolveParams {
  return (
    isRecord(v) &&
    requireCanvasId(v) &&
    isStringField(v, 'entryId') &&
    isStringIn(['accepted', 'deferred', 'rejected'] as const, v.disposition) &&
    typeof v.note === 'string'
  )
}

export function isCanvasConvergeCheckParams(v: unknown): v is CanvasConvergeCheckParams {
  return isRecord(v) && requireCanvasId(v)
}

export function isCanvasExportParams(v: unknown): v is CanvasExportParams {
  if (!(isRecord(v) && requireCanvasId(v))) return false
  const target: unknown = v.target
  if (!isRecord(target)) return false
  if (target.target === 'planning-doc') return true
  return target.target === 'requirement-card' && isStringField(target, 'leafId')
}

export function isCanvasDispatchParams(v: unknown): v is CanvasDispatchParams {
  return isRecord(v) && requireCanvasId(v) && isStringField(v, 'nodeId') && isStringField(v, 'pointer')
}

export function isCanvasReadParams(v: unknown): v is CanvasReadParams {
  return isRecord(v) && requireCanvasId(v) && isOptionalString(v.subtree)
}

/** list：无参数——Record 结构性拒绝夹带任何过滤字段（session-manager list 同款；
 * 归属过滤字段是通道级的，见 CanvasListParams 注释）。 */
export function isCanvasListParams(v: unknown): v is CanvasListParams {
  return isRecord(v)
}

/** enter（canvas_enter 打开形态）：封闭单键 canvasId。 */
export function isCanvasEnterParams(v: unknown): v is CanvasEnterParams {
  if (!isRecord(v)) return false
  const keys = Object.keys(v)
  return keys.length === 1 && keys[0] === 'canvasId' && typeof v.canvasId === 'string'
}

/** marker action → params 守卫映射（词表全键，缺 action 即类型错误——switch 的
 * 穷尽性由 Record 键集编译期承载；圈复杂度预算：17 分支 switch 超 metrics 门禁
 * 阈值，查表分派把分支数压回词表数据）。 */
const MARKER_PARAMS_GUARDS: Record<CanvasMarkerAction, (v: unknown) => boolean> = {
  create: isCanvasCreateParams,
  grow: isCanvasGrowParams,
  patch: isCanvasPatchParams,
  'decide-direction': isCanvasDecideDirectionParams,
  select: isCanvasSelectParams,
  transition: isCanvasTransitionParams,
  comment: isCanvasCommentParams,
  'comment-respond': isCanvasCommentRespondParams,
  'review-request': isCanvasReviewRequestParams,
  'review-append': isCanvasReviewAppendParams,
  'review-resolve': isCanvasReviewResolveParams,
  'converge-check': isCanvasConvergeCheckParams,
  export: isCanvasExportParams,
  dispatch: isCanvasDispatchParams,
  read: isCanvasReadParams,
  list: isCanvasListParams,
  enter: isCanvasEnterParams,
}

/** marker 通道总守卫：action + params 按 marker 词表分派；表外 action 返回 false
 * （event-adapter / CanvasHandler 据此走结构化错误应答）。 */
export function isCanvasMarkerRequest(v: unknown): v is CanvasMarkerRequest {
  if (!isRecord(v)) return false
  if (!isStringIn(CANVAS_MARKER_ACTIONS, v.action)) return false
  const action: CanvasMarkerAction = v.action
  return MARKER_PARAMS_GUARDS[action](v.params)
}

/** 材料性守卫（grow item 的 materiality 类型面收窄备用；U2 重建回放读侧消费）。 */
export function isArgumentMateriality(v: unknown): v is ArgumentMateriality {
  return isStringIn(['fact', 'claim'] as const, v)
}

/** 论据极性守卫（读侧收窄备用）。 */
export function isArgumentPolarity(v: unknown): v is ArgumentPolarity {
  return isStringIn(ARGUMENT_POLARITIES, v)
}
