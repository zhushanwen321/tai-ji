/**
 * problem-solve-canvas 契约 —— per-action × actor 权限矩阵 + 工具 ↔ action 映射表。
 *
 * 权限矩阵（设计 §3.1(1)）：GUI 直改与 agent 工具共用同一 16 action 词表
 * （同一 mutate 入口，仅 actor 区分）；CanvasService 唯一入口按表校验，
 * 表外 actor 组合 fail-fast（actor_not_allowed）。矩阵按 action 建制、与
 * extension 侧工具映射解耦——工具面重组零 runtime 改动（矩阵放契约层的红利）。
 *
 * 工具 ↔ action 映射（设计 §3.1(2)）：6 工具动词族，全部 deferred 注册。
 * 映射表是 extension 工具面与 runtime 词表的登记点——U4 工具面按此对账，
 * 「agent 可用 action 集 = 映射表动作并集」由一致性测试锁定（无悬空、无幽灵）。
 *
 * 词表 × 映射 × 矩阵三方对账口径（一致性测试 SSOT）：
 *   TOOL_ACTION_MAP 的动作并集 = 经工具可达的 action 集（agent 11 + review-append 1
 *   = 12——review-append 是 review actor 经 canvas_review 工具的写入路径，设计
 *   §3.1(2) 审查编排节明文）；NON_TOOL_ACTIONS = 其余 4 个 GUI-only 动作；
 *   两集并 = CANVAS_ACTIONS（16）、交为空。
 */
import { CANVAS_ACTIONS } from './marker.js'
import type { CanvasActor, CanvasAction } from './actions.js'

/**
 * 权限矩阵：action × actor → 是否合法。逐格对齐设计 §3.1(1) 矩阵表：
 * - decide-direction / comment / converge-check / dispatch 仅 user（用户裁决性动作，
 *   agent 侧走对话文本建议 / 代执行边界见设计；review 无）
 * - review-append 仅 review（reviewer subagent 的报告写回通道）
 * - read / list 全 actor 开放（查询类）
 * - select 的 agent 格 = 仅代执行用户明示指令——语义约束落 prompt 指引层（U4），
 *   runtime 按通道放行、不按意图判定（矩阵此格为 true）
 */
export const CANVAS_ACTOR_MATRIX: Record<CanvasAction, Record<CanvasActor, boolean>> = {
  create: { user: true, agent: true, review: false },
  grow: { user: false, agent: true, review: false },
  patch: { user: true, agent: true, review: false },
  'decide-direction': { user: true, agent: false, review: false },
  select: { user: true, agent: true, review: false },
  transition: { user: true, agent: true, review: false },
  comment: { user: true, agent: false, review: false },
  'comment-respond': { user: false, agent: true, review: false },
  'review-request': { user: true, agent: true, review: false },
  'review-append': { user: false, agent: false, review: true },
  'review-resolve': { user: true, agent: true, review: false },
  'converge-check': { user: true, agent: false, review: false },
  export: { user: true, agent: true, review: false },
  dispatch: { user: true, agent: false, review: false },
  read: { user: true, agent: true, review: true },
  list: { user: true, agent: true, review: true },
}

/** 矩阵单格查询（CanvasService 唯一入口的校验原语；表外组合 = false → fail-fast）。 */
export function isActionAllowed(action: CanvasAction, actor: CanvasActor): boolean {
  return CANVAS_ACTOR_MATRIX[action][actor]
}

/** 六工具动词族（全部 exposure: "deferred"）：工具名 → 该工具承载的 action 清单。
 * enter 打开形态走 marker 通道 'enter' 动作（非 mutation、不在本表——本表只登记
 * mutate 词表落点）；canvas_enter 创建形态落 create。 */
export const TOOL_ACTION_MAP = {
  canvas_enter: ['create'],
  canvas_edit: ['grow', 'patch', 'select', 'transition', 'comment-respond'],
  canvas_read: ['read'],
  canvas_review: ['review-request', 'review-append', 'review-resolve'],
  canvas_export: ['export'],
  canvas_list: ['list'],
} as const satisfies Record<string, readonly CanvasAction[]>

export type CanvasToolName = keyof typeof TOOL_ACTION_MAP

/** 六工具名清单（U4 工具面注册对账用）。 */
export const CANVAS_TOOL_NAMES = Object.keys(TOOL_ACTION_MAP) as readonly CanvasToolName[]

/**
 * 非工具入口动作（4 个）：不进任何工具、仅 GUI（WS RPC mutate, actor=user）直达的
 * 用户裁决性动作——「16 action 全部进入映射对账」的另一半（工具可达 12 + GUI-only 4
 * = 词表 16）。全部仅 user（权限矩阵）：
 * - decide-direction：方向裁决是终裁决动作，agent 不得自主（方向推荐走对话文本建议）
 * - comment：评论 = 用户注入议题；响应义务方是 agent（走 comment-respond）
 * - converge-check：确认收敛 = 用户点击（三门禁校验后置 converged 终态）
 * - dispatch：派发 = 用户逐叶确认 + 手填下游指针（D8 裁决：派发 = 用户拍板）
 */
export const NON_TOOL_ACTIONS = [
  { action: 'decide-direction', entry: 'gui-only（用户拍板：方向裁决是终裁决动作，agent 不得自主）' },
  { action: 'comment', entry: 'gui-only（评论 = 用户注入议题；响应义务方是 agent，走 comment-respond）' },
  { action: 'converge-check', entry: 'gui-only（确认收敛 = 用户点击，三门禁校验后置终态）' },
  { action: 'dispatch', entry: 'gui-only（派发 = 用户逐叶确认 + 手填下游指针，用户拍板）' },
] as const satisfies readonly { action: CanvasAction; entry: string }[]

/** 反查：action 由哪个工具承载（未命中 = 非工具动作，见 NON_TOOL_ACTIONS）。 */
export function toolOfAction(action: CanvasAction): CanvasToolName | undefined {
  for (const tool of CANVAS_TOOL_NAMES) {
    const actions: readonly string[] = TOOL_ACTION_MAP[tool]
    if (actions.includes(action)) return tool
  }
  return undefined
}

/** 全部映射动作的并集（对账辅助；一致性测试断言其与 CANVAS_ACTIONS 的关系）。 */
export function allToolActions(): CanvasAction[] {
  const out: CanvasAction[] = []
  for (const tool of CANVAS_TOOL_NAMES) {
    for (const action of TOOL_ACTION_MAP[tool]) {
      if (!out.includes(action)) out.push(action)
    }
  }
  return out
}

/** 词表全集（对账辅助：-export const 引用，保持三方对账口径单点）。 */
export function allCanvasActions(): readonly CanvasAction[] {
  return CANVAS_ACTIONS
}
