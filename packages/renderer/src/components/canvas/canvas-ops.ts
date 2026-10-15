/**
 * canvas 用户操作链（problem-solve-canvas §3.1(3) U7）——GUI 侧操作的对话框规格与
 * mutate 请求构造（纯函数；CanvasPane 编排，组件不内联参数拼装）。
 *
 * 操作链语义（设计 §3.1(3)）：每个操作 = WS RPC `canvas.mutate(canvasId, action,
 * params, actor:'user')` → runtime 校验落盘广播 → 广播回返触发 store 刷新；无乐观
 * 回显（成功才呈现，失败 toast + 原因）。params 形状 SSOT = U1 契约 CanvasActionParams。
 *
 * 权限边界：此处只产出 actor:'user' 请求；表外组合（如 GUI 调 grow）由 runtime 权限
 * 矩阵 fail-fast（actor_not_allowed）——本模块不复制矩阵（U1 矩阵 SSOT 单点）。
 * 状态机合法转移表同样不在本地校验：菜单只提供调用方给定的目标项，表外转移由
 * runtime fail-fast（lifecycle_transition_illegal）。
 */
import type { CanvasActionParams, CanvasMutateRequest, CanvasState } from '@zhushanwen/extension-protocol'
import { questionIdOfOption, selectedOptionIdOf } from './canvas-display'

/** GUI 用户可发起的操作种类（任务书操作链：选定/否决/评论/编辑/判据/处置/派发 + 方向裁决）。 */
export type CanvasOpKind =
  | 'select'
  | 'reject'
  | 'transition'
  | 'comment'
  | 'edit-content'
  | 'edit-criterias'
  | 'resolve'
  | 'dispatch'
  | 'decide-direction'

/** 对话框字段规格（CanvasOpDialog 渲染契约；全部 @taiji/ui 控件，禁原生表单）。 */
export interface CanvasOpField { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  key: string
  kind: 'text' | 'textarea' | 'select' | 'criterias'
  /** i18n key（panel.canvas.op.* 命名空间）。 */
  labelKey: string
  required?: boolean
  placeholderKey?: string
  /** select 字段的选项（value = 提交值；labelKey = 选项文案）。 */
  options?: Array<{ value: string; labelKey: string }>
  /** 初始回填（编辑内容 / 判据）。 */
  initial?: string
}

/** 对话框规格（打开哪个操作弹窗 + 提交按钮文案 + 目标上下文）。 */
export interface CanvasOpSpec { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  kind: CanvasOpKind
  titleKey: string
  submitKey: string
  fields: CanvasOpField[]
  /** 目标节点（select 的 optionId / reject 与 transition 的 nodeId / comment 锚 / patch 目标 / dispatch 叶子）。 */
  nodeId?: string
  /** select 的所属 question（resolve 边 from——params.questionId 来源，opSpecOf 单处解析）。 */
  questionId?: string
  /** 处置目标报告条目。 */
  entryId?: string
  /** transition 的目标生命周期（菜单在 NodeDetail 产出）。 */
  transitionTo?: string
  /** 换选提示：该问题已有选定方案（select 迁移语义的前置告知 + replace 参数来源）。 */
  replacedOptionId?: string
}

/** opSpecOf 的上下文参数（per-kind 构造函数共用形参——签名单点）。 */
type OpContext = { state: CanvasState; nodeId?: string; entryId?: string; transitionTo?: string }

/** 组装操作对话框规格（上下文切片在此单处解析，提交侧不再反查图）。
 *  per-kind 子构造函数拆分（单 switch 内联 9 分支 + 字段构造超 metrics 门禁圈复杂度
 *  阈值）——本函数只做分派，规格细节在各 kind 构造函数。 */
export function opSpecOf(
  kind: CanvasOpKind,
  ctx: { state: CanvasState; nodeId?: string; entryId?: string; transitionTo?: string },
): CanvasOpSpec {
  switch (kind) {
    case 'select':
      return selectOpSpec(ctx)
    case 'reject':
      return rejectOpSpec(ctx)
    case 'transition':
      return transitionOpSpec(ctx)
    case 'comment':
      return commentOpSpec(ctx)
    case 'edit-content':
      return editContentOpSpec(ctx)
    case 'edit-criterias':
      return editCriteriasOpSpec(ctx)
    case 'resolve':
      return resolveOpSpec(ctx)
    case 'dispatch':
      return dispatchOpSpec(ctx)
    case 'decide-direction':
      return decideDirectionOpSpec()
  }
}

/** select：换选时换提示标题（replaced = 该问题当前选定方案）。 */
function selectOpSpec(ctx: OpContext): CanvasOpSpec {
  const nodeId = ctx.nodeId ?? ''
  const questionId = questionIdOfOption(ctx.state, nodeId) ?? ''
  const replaced = selectedOptionIdOf(ctx.state, questionId)
  return {
    kind: 'select',
    titleKey: replaced ? 'panel.canvas.op.selectReplaceTitle' : 'panel.canvas.op.selectTitle',
    submitKey: 'panel.canvas.op.submit',
    nodeId,
    questionId,
    replacedOptionId: replaced ?? undefined,
    fields: [
      {
        key: 'reason',
        kind: 'textarea',
        labelKey: 'panel.canvas.op.selectReason',
        required: true,
        placeholderKey: 'panel.canvas.op.selectReasonHint',
      },
    ],
  }
}

function rejectOpSpec(ctx: OpContext): CanvasOpSpec {
  return {
    kind: 'reject',
    titleKey: 'panel.canvas.op.rejectTitle',
    submitKey: 'panel.canvas.op.rejectSubmit',
    nodeId: ctx.nodeId,
    fields: [
      { key: 'reason', kind: 'textarea', labelKey: 'panel.canvas.op.rejectReason', required: true, placeholderKey: 'panel.canvas.op.rejectReasonHint' },
      { key: 'reviveCondition', kind: 'textarea', labelKey: 'panel.canvas.op.reviveCondition', placeholderKey: 'panel.canvas.op.reviveConditionHint' },
    ],
  }
}

function transitionOpSpec(ctx: OpContext): CanvasOpSpec {
  return {
    kind: 'transition',
    titleKey: 'panel.canvas.op.transitionTitle',
    submitKey: 'panel.canvas.op.submit',
    nodeId: ctx.nodeId,
    transitionTo: ctx.transitionTo,
    fields: [
      { key: 'to', kind: 'select', labelKey: 'panel.canvas.op.transitionTo', required: true, options: transitionOptionsOf(ctx.transitionTo) },
      { key: 'reason', kind: 'textarea', labelKey: 'panel.canvas.op.transitionReason', required: true },
    ],
  }
}

function commentOpSpec(ctx: OpContext): CanvasOpSpec {
  return {
    kind: 'comment',
    titleKey: 'panel.canvas.op.commentTitle',
    submitKey: 'panel.canvas.op.commentSubmit',
    nodeId: ctx.nodeId,
    fields: [
      { key: 'text', kind: 'textarea', labelKey: 'panel.canvas.op.commentText', required: true, placeholderKey: 'panel.canvas.op.commentHint' },
    ],
  }
}

function editContentOpSpec(ctx: OpContext): CanvasOpSpec {
  const node = ctx.state.nodes.find((n) => n.id === ctx.nodeId)
  return {
    kind: 'edit-content',
    titleKey: 'panel.canvas.op.editTitle',
    submitKey: 'panel.canvas.op.submit',
    nodeId: ctx.nodeId,
    fields: [
      { key: 'content', kind: 'textarea', labelKey: 'panel.canvas.op.editContent', required: true, initial: node?.content ?? '' },
      { key: 'reason', kind: 'text', labelKey: 'panel.canvas.op.editReason', required: true, placeholderKey: 'panel.canvas.op.editReasonHint' },
    ],
  }
}

function editCriteriasOpSpec(ctx: OpContext): CanvasOpSpec {
  const node = ctx.state.nodes.find((n) => n.id === ctx.nodeId)
  return {
    kind: 'edit-criterias',
    titleKey: 'panel.canvas.op.criteriasTitle',
    submitKey: 'panel.canvas.op.submit',
    nodeId: ctx.nodeId,
    fields: [
      { key: 'criterias', kind: 'criterias', labelKey: 'panel.canvas.op.criteriasList', required: true, initial: (node?.criterias ?? []).join('\n'), placeholderKey: 'panel.canvas.op.criteriasHint' },
      { key: 'reason', kind: 'text', labelKey: 'panel.canvas.op.editReason', required: true, placeholderKey: 'panel.canvas.op.editReasonHint' },
    ],
  }
}

function resolveOpSpec(ctx: OpContext): CanvasOpSpec {
  return {
    kind: 'resolve',
    titleKey: 'panel.canvas.op.resolveTitle',
    submitKey: 'panel.canvas.op.resolveSubmit',
    entryId: ctx.entryId,
    fields: [
      {
        key: 'disposition',
        kind: 'select',
        labelKey: 'panel.canvas.op.resolveDisposition',
        required: true,
        options: [
          { value: 'accepted', labelKey: 'panel.canvas.op.resolveAccepted' },
          { value: 'deferred', labelKey: 'panel.canvas.op.resolveDeferred' },
          { value: 'rejected', labelKey: 'panel.canvas.op.resolveRejected' },
        ],
      },
      { key: 'note', kind: 'textarea', labelKey: 'panel.canvas.op.resolveNote', required: true, placeholderKey: 'panel.canvas.op.resolveNoteHint' },
    ],
  }
}

function dispatchOpSpec(ctx: OpContext): CanvasOpSpec {
  return {
    kind: 'dispatch',
    titleKey: 'panel.canvas.op.dispatchTitle',
    submitKey: 'panel.canvas.op.dispatchSubmit',
    nodeId: ctx.nodeId,
    fields: [
      { key: 'pointer', kind: 'text', labelKey: 'panel.canvas.op.dispatchPointer', required: true, placeholderKey: 'panel.canvas.op.dispatchPointerHint' },
    ],
  }
}

function decideDirectionOpSpec(): CanvasOpSpec {
  return {
    kind: 'decide-direction',
    titleKey: 'panel.canvas.op.directionTitle',
    submitKey: 'panel.canvas.op.directionSubmit',
    fields: [
      {
        key: 'direction',
        kind: 'select',
        labelKey: 'panel.canvas.op.directionChoice',
        required: true,
        options: [
          // 方向词条复用外层画布域（CanvasPane 头部同款，单份不进 op 子树）
          { value: 'top-down', labelKey: 'panel.canvas.directionTopDown' },
          { value: 'bottom-up', labelKey: 'panel.canvas.directionBottomUp' },
        ],
      },
      { key: 'reason', kind: 'textarea', labelKey: 'panel.canvas.op.directionReason', required: true },
    ],
  }
}

/** transition 目标选项（单目标菜单；labelKey 复用 lifecycle 词条）。 */
function transitionOptionsOf(to: string | undefined): Array<{ value: string; labelKey: string }> {
  const LABELS: Record<string, string> = {
    draft: 'panel.canvas.lifecycleDraft',
    'under-review': 'panel.canvas.lifecycleUnderReview',
    passed: 'panel.canvas.lifecyclePassed',
    rejected: 'panel.canvas.lifecycleRejected',
    shelved: 'panel.canvas.lifecycleShelved',
  }
  const key = to !== undefined ? LABELS[to] : undefined
  return key && to !== undefined ? [{ value: to, labelKey: key }] : []
}

// ── 提交值 → mutate 请求（params 形状 SSOT = U1 契约）────────────────────────

/** 对话框提交值（key → 字符串；criterias 为多行原文）。 */
export type CanvasOpValues = Record<string, string>

/** 从多行原文解析判据清单（逐行 trim，去空行）。 */
function parseCriterias(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/**
 * 构造 mutate 请求（actor:user 由调用方附——本函数只产 {action, params}）。
 * required 缺失由对话框拦截；此处空上下文按空串透传（runtime 契约守卫/不变量
 * fail-fast——GUI 侧不复制校验，双通道同构）。
 * per-kind 子构造函数拆分（单 switch 内联 9 分支 + 参数拼装超 metrics 门禁圈复杂度
 * 阈值）——本函数只做分派，params 形状细节在各 kind 构造函数（U1 契约对齐不变）。
 */
export function buildMutateRequest(canvasId: string, spec: CanvasOpSpec, values: CanvasOpValues): CanvasMutateRequest {
  switch (spec.kind) {
    case 'select':
      return selectRequest(canvasId, spec, values)
    case 'reject':
      return rejectRequest(canvasId, spec, values)
    case 'transition':
      return transitionRequest(canvasId, spec, values)
    case 'comment':
      return commentRequest(canvasId, spec, values)
    case 'edit-content':
      return editContentRequest(canvasId, spec, values)
    case 'edit-criterias':
      return editCriteriasRequest(canvasId, spec, values)
    case 'resolve':
      return resolveRequest(canvasId, spec, values)
    case 'dispatch':
      return dispatchRequest(canvasId, spec, values)
    case 'decide-direction':
      return decideDirectionRequest(canvasId, values)
  }
}

/** select：换选时附 replace（fromOptionId = 迁移出的旧选定）。 */
function selectRequest(canvasId: string, spec: CanvasOpSpec, values: CanvasOpValues): CanvasMutateRequest {
  const params: CanvasActionParams['select'] = {
    canvasId,
    questionId: spec.questionId ?? '',
    optionId: spec.nodeId ?? '',
    reason: values['reason'] ?? '',
  }
  if (spec.replacedOptionId) params.replace = { fromOptionId: spec.replacedOptionId }
  return { action: 'select', params }
}

/** reject：transition to=rejected 的 GUI 形态（否决理由入 rejection 记录 + reason 双写留痕）。 */
function rejectRequest(canvasId: string, spec: CanvasOpSpec, values: CanvasOpValues): CanvasMutateRequest {
  return {
    action: 'transition',
    params: {
      canvasId,
      nodeId: spec.nodeId ?? '',
      to: 'rejected',
      rejection: {
        reason: values['reason'] ?? '',
        ...(values['reviveCondition'] ? { reviveCondition: values['reviveCondition']! } : {}),
      },
      reason: values['reason'] ?? '',
    },
  }
}

function transitionRequest(canvasId: string, spec: CanvasOpSpec, values: CanvasOpValues): CanvasMutateRequest {
  return {
    action: 'transition',
    params: {
      canvasId,
      nodeId: spec.nodeId ?? '',
      to: (values['to'] ?? '') as CanvasActionParams['transition']['to'],
      reason: values['reason'] ?? '',
    },
  }
}

function commentRequest(canvasId: string, spec: CanvasOpSpec, values: CanvasOpValues): CanvasMutateRequest {
  return { action: 'comment', params: { canvasId, anchorId: spec.nodeId ?? '', text: values['text'] ?? '' } }
}

function editContentRequest(canvasId: string, spec: CanvasOpSpec, values: CanvasOpValues): CanvasMutateRequest {
  return {
    action: 'patch',
    params: { canvasId, nodeId: spec.nodeId ?? '', content: values['content'] ?? '', reason: values['reason'] ?? '' },
  }
}

function editCriteriasRequest(canvasId: string, spec: CanvasOpSpec, values: CanvasOpValues): CanvasMutateRequest {
  return {
    action: 'patch',
    params: {
      canvasId,
      nodeId: spec.nodeId ?? '',
      criterias: parseCriterias(values['criterias'] ?? ''),
      reason: values['reason'] ?? '',
    },
  }
}

function resolveRequest(canvasId: string, spec: CanvasOpSpec, values: CanvasOpValues): CanvasMutateRequest {
  return {
    action: 'review-resolve',
    params: {
      canvasId,
      entryId: spec.entryId ?? '',
      disposition: (values['disposition'] ?? 'accepted') as 'accepted' | 'deferred' | 'rejected',
      note: values['note'] ?? '',
    },
  }
}

function dispatchRequest(canvasId: string, spec: CanvasOpSpec, values: CanvasOpValues): CanvasMutateRequest {
  return { action: 'dispatch', params: { canvasId, nodeId: spec.nodeId ?? '', pointer: values['pointer'] ?? '' } }
}

function decideDirectionRequest(canvasId: string, values: CanvasOpValues): CanvasMutateRequest {
  return {
    action: 'decide-direction',
    params: {
      canvasId,
      direction: (values['direction'] ?? 'top-down') as 'top-down' | 'bottom-up',
      reason: values['reason'] ?? '',
    },
  }
}
