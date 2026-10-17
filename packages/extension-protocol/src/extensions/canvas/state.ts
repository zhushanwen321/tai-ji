/**
 * problem-solve-canvas 契约 —— 领域状态 schema（CanvasState / ReviewReport）与领域事件词表。
 *
 * 形状对齐概念文档（.tmp/problem-solve-canvas.md）§2 领域模型：四类图节点 + 评论附件 +
 * MVP 四种边（decompose / resolve / argue / rebut；constrain / reference 第二版不入词表）+
 * 生命周期 × 派发二维状态机（§2.4）。
 *
 * 本 schema 同时承载两处消费：
 * - canvas.get RPC reply / canvas_enter（打开形态）的工具结果 = 全量只读视图
 * - runtime canvas.json 加速快照的落盘形状（events.jsonl 为唯一持久权威，
 *   快照可由事件流全量重放推导——U2 落盘契约）
 *
 * 唯一形状分叉：activeBindings 只在 canvas.get reply 出现（查询侧派生，见字段注释），
 * 快照与 marker 工具结果不携带。
 *
 * 时间字段一律 ISO string（不用 Date）——wire 与落盘 JSON 往返无损，序列化即契约。
 */

// ── 图元素 ─────────────────────────────────────────────────────

/** 四类图节点（概念文档 §2.2）。评论不是图节点（裁决点 R2：降为锚定附件）。 */
export type CanvasNodeType = 'question' | 'option' | 'argument' | 'constraint'

/**
 * 节点生命周期状态机（概念文档 §2.4，全部图节点；根节点不可搁置/否决）。
 * 合法转移：draft→under-review / draft→shelved / under-review→passed /
 * under-review→rejected / under-review→shelved / rejected→draft（复活，须留理由）/
 * shelved→draft。表外转移 fail-fast（U2 状态机穷举单测承接）。
 */
export type CanvasNodeLifecycle = 'draft' | 'under-review' | 'passed' | 'rejected' | 'shelved'

/** MVP 四种边（概念文档 §2.3）。constrain / reference 第二版，词表不预留。 */
export type CanvasEdgeType = 'decompose' | 'resolve' | 'argue' | 'rebut'

/** 论据极性（裁决点 R1：原「证据」「反对」合并为论据的极性字段）。 */
export type ArgumentPolarity = 'support' | 'object'

/** 论据素材性：fact 事实（必带核实状态）/ claim 主张。 */
export type ArgumentMateriality = 'fact' | 'claim'

/** 主干边支撑度三值（裁决点 R3：只评 decompose/resolve 主干边，论证边不评级）。 */
export type SupportRating = 'sufficient' | 'gap' | 'invalid'

/** 图节点。per-type 字段全部 optional——类型面宽松、领域约束归 U2 不变量校验
 * （契约层不复制不变量逻辑，避免双权威）。 */
export interface CanvasNode { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  id: string
  type: CanvasNodeType
  content: string
  lifecycle: CanvasNodeLifecycle
  /** option：selected 标记（不变量 3：任一 question 的 resolve 边中 selected 至多一条）。 */
  selected?: boolean
  /** option：选定对比理由（不变量 3：selected 变更须留对比与理由）。 */
  selectionReason?: string
  /** lifecycle=rejected 时的否决记录——不可删除（MVP 不可砍：防 agent 重复提出已否决项）。 */
  rejection?: { reason: string; reviveCondition?: string }
  /** argument：极性。 */
  polarity?: ArgumentPolarity
  /** argument：素材性；fact 时 factVerified 必填（不变量 5）。 */
  materiality?: ArgumentMateriality
  /** argument：核实状态（fact 论据必填；未核实 fact 不得作为 passed 依据——不变量 5）。 */
  factVerified?: boolean
  /** option：执行叶子显式标记（裁决点 R5：叶子是结构派生、执行叶子是规划决策，两不混同）。 */
  dispatchable?: boolean
  /** option：执行叶子完成判据（passed 前必填——不变量 7）。 */
  criterias?: string[]
  /** 派发维度（与 lifecycle 正交，仅执行叶子）：dispatched 后登记下游产物指针（不变量 7）。 */
  dispatch?: { pointer: string; dispatchedAt: string }
  createdAt: string
}

/** 图边。argue 边的 to 可指向主干边 id（论证一条分解/解边本身）——targetId 域校验归 U2。 */
export interface CanvasEdge { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  id: string
  type: CanvasEdgeType
  /** 起点节点 id（argument 节点）。 */
  from: string
  /** 终点：节点 id 或主干边 id（仅 argue 边可指边）。 */
  to: string
  /** argue 边极性。 */
  polarity?: ArgumentPolarity
  /** 主干边支撑度（decompose/resolve 专用；审查轮次溯源）。 */
  support?: { rating: SupportRating; gaps?: string[]; round?: number }
}

/** 评论附件（锚定在节点或边上，非图成员）。响应状态机承载 agent 响应义务（不变量 8）。 */
export interface CanvasComment { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  id: string
  /** 锚定目标：节点 id 或边 id。 */
  anchorId: string
  text: string
  /** 待响应 / 已响应；转已响应前必须留采纳或反驳的痕（不变量 8）。 */
  status: 'pending' | 'responded'
  /** 响应留痕：采纳（并落实到图）/ 反驳（留理由）二选一。 */
  response?: { disposition: 'adopted' | 'rebutted'; note: string }
  createdAt: string
}

/** 方向裁决记录（裁决点 R4：画布元数据 + 事件留痕，不是图节点）。矩阵限 user 拍板。 */
export interface CanvasDirectionDecision { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  direction: 'top-down' | 'bottom-up'
  reason: string
  decidedAt: string
}

// ── 审查报告（聚合 2）─────────────────────────────────────────

/** 六维度审查清单（概念文档 §4.3：逐维度打靶，不泛泛「是否合理」）。 */
export type ReviewDimension =
  | 'completeness'
  | 'necessity'
  | 'support'
  | 'authenticity'
  | 'conflict'
  | 'depth'

/** 条目分级：must-fix 清零不收敛；suggestion 处置制（三选一）。 */
export type ReviewSeverity = 'must-fix' | 'suggestion'

/** 审查终态族（对齐 review-fix-loop 终态集；除 converged 外全部停回用户）。
 * 各值的驻留口径：converged / max-rounds 驻留于 status；escalated 不驻留——升级经
 * ReviewEscalated 事件留痕，放行后即回 in-progress（每次升级裁决恰放行一轮，轮次
 * 预算随放行抬升）；stuck 为终态族词表值，MVP 无触发路径（reviewer 派发失败经
 * 错误显式上报，不落聚合终态）。 */
export type ReviewReportStatus = 'in-progress' | 'converged' | 'max-rounds' | 'escalated' | 'stuck'

/** 处置三选一（采纳 / 登记后做 / 拒绝留理由）。 */
export type ReviewResolutionDisposition = 'accepted' | 'deferred' | 'rejected'

/** 审查报告条目：经图元素 id 引用画布（聚合 2 不变量 1：id 必须存在；R6 裁决点：
 * 图承载内容、报告承载过程）。 */
export interface ReviewEntry { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  id: string
  round: number
  dimension: ReviewDimension
  severity: ReviewSeverity
  /** 引用的图元素 id（节点 / 边 / 评论）。 */
  targetId: string
  note: string
  /** 随条目写回的支撑度评价输入原文（评价结果落 edge.support；round 溯源取条目 round）。 */
  supportRating?: SupportRating
  /** rating='gap' 的缺口清单（与 edge.support.gaps 同源）。 */
  supportGaps?: string[]
  /**
   * 处置记录（first-writer-wins：已有处置记录后再次 review-resolve = 拒绝 +
   * already_resolved 错误——覆盖会让 R2 审到与登记方实际动作不符的处置表）。
   */
  resolution?: {
    disposition: ReviewResolutionDisposition
    /** 处置登记方（agent 执行侧 / user 复核直处）。 */
    by: 'user' | 'agent'
    note: string
  }
}

/** 审查报告聚合（ReviewReport）。挂于 CanvasState.review；null = 从未发起审查。 */
export interface ReviewReport { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  status: ReviewReportStatus
  /** 当前 / 最近轮次（R1 全面审，R2+ 只审上轮处置表 + 攻击点）。 */
  round: number
  maxRounds: number
  entries: ReviewEntry[]
  /** 非 converged 终态的停回说明（聚合 2 不变量 2：max-rounds / escalated / stuck 必附）。 */
  stopNote?: string
  /** 恢复动作建议（停回说明的配套：升级裁决后可再发起）。 */
  recoverHint?: string
}

// ── 画布全量快照 ──────────────────────────────────────────────

/** 画布状态（聚合 1 全量投影；canvas.get reply 与 canvas.json 快照共用形状）。 */
export interface CanvasState { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  canvasId: string
  /**
   * 归属会话 id（画布归属 = 创建它的 session，1:N——一个 session 可有多张画布）。
   * 归属即落盘路径（`<dataDir>/ext-sessions/<ownerSessionId>/canvases/<canvasId>/`），
   * 路径即归属的构造性承载：该字段由 runtime 从落盘路径推导填充（服务层唯一写入点），
   * 领域事件流不承载归属（CanvasCreated 事件 data 不含 sessionId——事件流内容与格式
   * 不随布局反转变化，只挪位置）；跨会话访问按本字段归属校验拒绝（forbidden）。
   */
  ownerSessionId: string
  /** 画布名（canvasId = 短随机 id；重命名属第二版多画布管理，MVP 只读）。 */
  name: string
  /** 根问题三要素（不变量 1：有且仅有一个根节点，类型 question，带完成判据与范围排除）。 */
  root: {
    nodeId: string
    statement: string
    /** 完成判据（可证伪）。 */
    criterias: string[]
    /** 范围排除（设计文档 enter 参数表记作 scope 的全称形态）。 */
    scopeExclusions: string[]
    /** 根判据经用户确认（收敛判据 1）。 */
    confirmed?: boolean
  }
  /** 生长方向裁决；未裁决为 null。 */
  direction: CanvasDirectionDecision | null
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  comments: CanvasComment[]
  /** 待重审集合（节点 id；不变量 9：用户改动后该节点到根的路径进入本集合）。 */
  dirtyPaths: string[]
  /** 审查报告聚合；null = 从未发起审查。 */
  review: ReviewReport | null
  /** 规划收敛终态（converge-check 校验不变量 10 后置位；export 同校验）。 */
  converged: boolean
  /**
   * 活跃绑定数（绑定记录 ∩ 存活 session，设计 §3.1(1) 回推节 / §3.1(3) 绑定徽标
   * 数据源）——canvas.get reply 的查询侧派生值：transport 装配层附加（存活判定经
   * sessionService，CanvasService 无该依赖），domain 产物与 canvas.json 快照均不含
   * （绑定是 runtime 内存态、不可由事件流重放推导——落盘会污染「快照可由事件流
   * 全量重放重建」的唯一权威承诺）。optional = marker 通道（enter/read 工具结果）
   * 与旧 runtime reply 不携带；消费方缺字段按未知处理（徽标不渲染）。
   */
  activeBindings?: number
  /**
   * 收敛阻断清单（canvas-foundation convergenceBlockers 的现算结果，导出面板
   * 门禁区②格「规划就绪」的逐项呈现数据源——门禁②的判定是 runtime 领域规则
   * 不跨 wire，本字段把判定结论（缺什么）随 canvas.get 携带给界面）。与
   * activeBindings 同款查询侧派生：transport 装配层附加，domain 产物与
   * canvas.json 快照均不含（纯派生值，落盘即与画布状态二源漂移）。optional =
   * marker 通道（enter/read 工具结果）与旧 runtime reply 不携带；消费方缺字段
   * 按未知处理（②格退回「由权威校验」措辞形态）。空数组 = 无阻断（已收敛或
   * 收敛后再改动时仅剩待重审类条目，与门禁③计数互补）。
   */
  convergenceBlockers?: string[]
  createdAt: string
  updatedAt: string
}

/** canvas.list 条目：托盘画布列表的数据源（名称 + 阶段徽标 + must-fix 计数）。
 * 阶段徽标本身是 renderer 派生值（开放 must-fix 或审查进行中 = 审查中；
 * converged = 已收敛；其余 = 生长中），契约只给派生输入。清单按请求 sessionId
 * 过滤（只返回归属该会话的画布），ownerSessionId 即过滤判据的回显。 */
export interface CanvasListEntry { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  canvasId: string
  /** 归属会话 id（= 请求的过滤 sessionId；语义同 CanvasState.ownerSessionId）。 */
  ownerSessionId: string
  name: string
  statement: string
  converged: boolean
  /** 未关闭 must-fix 条目数。 */
  openMustFix: number
  /** 审查报告状态；从未审查为 null。 */
  reviewStatus: ReviewReportStatus | null
}

// ── 领域事件词表（广播 evType 契约 + U2 对账 SSOT）───────────

/**
 * 领域事件类型词表（过去式命名，概念文档 §2.6 + U2 增补）。
 *
 * 广播 canvas.updated 的 evType 取值域；renderer 按值分流——CanvasCreated 驱动
 * 创建后自动唤起（U5），其余类型仅作失效提示（重新拉取收敛）。
 *
 * SSOT 对账义务（U2 承接）：每个 mutation action 至少产出一个事件，主事件映射
 * 见 ACTION_EVENT_MAP；read / list 为查询类不产事件、不在对账范围；DirtiedPathMarked
 * 与审查终态族是 mutate 事务 / 审查编排内的附属事件，不独立对应 action。
 */
export const CANVAS_EVENT_TYPES = [
  'CanvasCreated',
  'GrowthDirectionDecided',
  'NodeCreated',
  'NodeModified',
  'StateTransitioned',
  'OptionSelected',
  'NodeDispatched',
  'CommentAdded',
  'CommentResponded',
  'ReviewRequested',
  'ReviewEntryAppended',
  'ReviewEntryResolved',
  'ConvergenceChecked',
  'CanvasExported',
  'DirtiedPathMarked',
  'ReviewConverged',
  'ReviewMaxRoundsReached',
  'ReviewEscalated',
] as const

export type CanvasEventType = (typeof CANVAS_EVENT_TYPES)[number]

/**
 * mutation action → 主领域事件映射（「每个 mutation action 至少产出一个事件」
 * 的对账 SSOT）。键集约束（= 16 action 减 read/list 的 14 个 mutation action）
 * 由一致性测试锁定（不在此回引 actions 层——保持依赖单向 actions → state）；
 * read / list（查询类）不在表内 = 不产事件、不在对账范围——查询写事件会使
 * append-only 日志体积随读取次数无界增长。U2 实现的事件产出与本表对账；
 * 本表缺失键即对账红。
 */
export const ACTION_EVENT_MAP = {
  create: 'CanvasCreated',
  grow: 'NodeCreated',
  patch: 'NodeModified',
  'decide-direction': 'GrowthDirectionDecided',
  select: 'OptionSelected',
  transition: 'StateTransitioned',
  comment: 'CommentAdded',
  'comment-respond': 'CommentResponded',
  'review-request': 'ReviewRequested',
  'review-append': 'ReviewEntryAppended',
  'review-resolve': 'ReviewEntryResolved',
  'converge-check': 'ConvergenceChecked',
  export: 'CanvasExported',
  dispatch: 'NodeDispatched',
} as const satisfies Record<string, CanvasEventType>
