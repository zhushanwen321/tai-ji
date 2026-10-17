/**
 * problem-solve-canvas 契约 —— 错误码词表与恢复动作文案。
 *
 * 对齐分级错误处理契约：mutate / marker 调用被拒时返回结构化错误
 * （code + message + recover），每码附一句恢复指引（设计 §3.1(1)）——
 * 错误必须指向恢复动作，GUI toast 与 agent 工具结果双呈现同一文案。
 * 文案面向用户（中文），agent 可读。
 */

/** 结构化错误形状（CanvasMutateReply 失败腿 / marker 畸形请求应答共用）。 */
export interface CanvasError { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  code: CanvasErrorCode
  /** 错误概述（发生了什么）。 */
  message: string
  /** 恢复动作指引（下一步怎么做；SSOT = CANVAS_ERROR_RECOVERY，runtime 可附加动态数值）。 */
  recover: string
}

/**
 * 错误码词表（封闭 16 值）。分组：
 * - 寻址 / 形状：canvas_not_found / node_not_found / edge_not_found /
 *   invalid_params / unknown_action
 * - 权限：actor_not_allowed（矩阵表外组合 fail-fast）/ forbidden（画布不属当前会话——
 *   归属校验拒绝，画布归属 = 创建它的 session，跨会话访问一律结构化拒绝）
 * - 不变量拦截：selection_conflict（不变量 3 双选定）/ cycle_detected（不变量 2 成环）/
 *   unverified_fact（不变量 5）/ dispatch_blocked（不变量 7）/ not_converged（不变量 10）/
 *   lifecycle_transition_illegal（状态机表外转移）
 * - 审查聚合：entry_ref_missing（聚合 2 不变量 1）/ already_resolved（first-writer-wins）/
 *   review_max_rounds（轮次上限后再发起）
 */
export const CANVAS_ERROR_CODES = [
  'canvas_not_found',
  'node_not_found',
  'invalid_params',
  'unknown_action',
  'actor_not_allowed',
  'forbidden',
  'selection_conflict',
  'cycle_detected',
  'unverified_fact',
  'dispatch_blocked',
  'not_converged',
  'lifecycle_transition_illegal',
  'entry_ref_missing',
  'already_resolved',
  'review_max_rounds',
  'edge_not_found',
] as const

export type CanvasErrorCode = (typeof CANVAS_ERROR_CODES)[number]

/**
 * 每码一句恢复动作文案（SSOT；runtime 构造 CanvasError 时 recover 字段取此处
 * 模板，可前缀动态数值如「先处置 3 条 must-fix」。缺码 = 词表与文案表漂移，
 * 由测试锁定非空全覆盖）。
 */
export const CANVAS_ERROR_RECOVERY: Record<CanvasErrorCode, string> = {
  canvas_not_found: '画布不存在或已被删除：先经 canvas_list / canvas.list 核对画布 id 后重试',
  node_not_found: '目标节点 id 不存在：先 canvas_read 取当前态，核对节点 id 后重试',
  edge_not_found: '目标边 id 不存在：先 canvas_read 取当前态，核对边 id 后重试',
  invalid_params: '请求参数形状非法：对照该 action 的 params 契约修正字段后重试',
  unknown_action: 'action 不在词表：对照 CANVAS_ACTIONS 词表修正 action 名',
  actor_not_allowed: '当前操作方无此动作权限：查权限矩阵（该动作仅限特定操作方），改由有权方执行',
  forbidden: '画布不属于当前会话（画布归属创建它的会话，跨会话访问被拒绝）：请让用户切换到画布归属会话后重试，或经 canvas_list 查看当前会话可用的画布',
  selection_conflict: '该问题已有选定方案：换选走 select 的 replace 参数（同一调用内迁移旧选定）并附对比理由',
  cycle_detected: '该边会使主干成环：分解/解边只能指向上层节点的下层，去掉回边后重试',
  unverified_fact: '未核实的 fact 论据不得作为通过依据：先补核实状态（factVerified）再重试',
  dispatch_blocked: '执行叶子须先通过审查（passed）并填写下游产物指针，才能派发',
  not_converged: '画布未收敛：先处置全部 must-fix / 清空待重审路径 / 确认根判据，再执行收敛确认或导出',
  lifecycle_transition_illegal: '状态机不允许该转移：对照合法转移表（rejected/shelved 须先复活为 draft），或留理由走复活路径',
  entry_ref_missing: '报告条目引用的图元素 id 不存在：先 canvas_read 核对目标 id 后重试',
  already_resolved: '该条目已有处置记录（先登记先生效）：改判走下一轮审查复审，或在 GUI 以新轮次处置',
  review_max_rounds: '审查已达轮次上限：升级裁决（扩大审查范围或修改判据）后重新发起审查',
}

/** 构造结构化错误（recover 缺省取词表模板——每码必有恢复指引，构造性保证）。 */
export function canvasError(code: CanvasErrorCode, message: string): CanvasError {
  return { code, message, recover: CANVAS_ERROR_RECOVERY[code] }
}
