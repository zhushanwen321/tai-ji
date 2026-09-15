/**
 * panel-view —— panel 主区/输入面渲染视图模型 + derivePanelView 派生纯函数。
 *
 * [权威] docs/design/panel-view-derivation-and-flow-lifecycle.md §3.3 D1。
 * 背景（§2.4 根因）：现行 Panel.vue 在组件 computed 里手工组合六个异构状态源
 * （session 绑定 / 消息有无 / flow 单例态 / dead / ask-user / trace），组合空间无穷举
 * 守卫——每个 bug 来自一个未被考虑的格子（flow 卡 landing → turn 结束后 composer 消失）。
 * 本模块把该组合收敛为单一纯函数：决策可穷举（G3，7 输入 = 2^7 = 128 组合全表单测守卫）、
 * 「flow 残留 × 输入面消失」在派生规则上不可表达（G2 结构免疫）。
 *
 * 设计要点：
 * - 输入全原始值、零 import（零跨域依赖），天然可穷举、可移植到任何消费方。
 * - 派生优先级：dead（respawning 抑制，见 PanelViewInput.isSessionRespawning）> trace >
 *   conversation > landing > empty。
 *   ① 前置约束：dead / trace 仅 sessionId 非空成立（dead 是 per-session 事实，
 *      trace 视图替换对话流位置，二者都依附具体会话）。
 *   ② conversation / trace：sessionId 非空即成立——conversation 有消息走 MessageStream、
 *      无消息走空对话态，消息有无只影响分支内部子视图（渲染层 switch 的事），不改变 kind；
 *      输入面按 hasAskUserRequest 互斥二选一（ask-user 阻塞应答替换 composer），trace
 *      同样保留输入面 = session-trace 契约「composer 保留在底部，不打断对话能力」
 *      （D5/V4，一致性审查 R-U1 补入）。
 *      该分支吸收现行「已绑空 session 走空对话态 + band composer 供直输」与
 *      「turn 活跃 + 无消息 → 空白」边界组合（§5 检查点）。
 *   ③ landing：仅 !sessionId && isFlowActive（isFlowActive 对应 NewTaskFlow 的
 *      ACTIVE_STATES = landing + 六 overlay，见 flow-state.ts）——新建任务流程只承接
 *      「无会话」的 panel（G2：流程状态不越权）。
 *   ④ empty：兜底，仅无 session 且 flow 未活跃（选会话空态）可达；绑定空会话归
 *      conversation（见②），empty-with-session 为类型层防御、现行派生不可达。
 *
 * - hasMessages 在输入契约中但不参与 kind 判定：它是 panel 事实全集的一员（G3 穷举的
 *   对象即该全集，设计 D1 输入面明确列入），语义上供消费方区分 conversation 的子视图。
 * - landing 的 !sessionId 条件与既有不变量「startFlow 进入 landing 时清空 activeId
 *   （isFlowActive ⟹ sessionId=null）」（flow.ts）构成双保险：即便不变量未来被破坏，
 *   派生也只会落到 empty/conversation（composer 保持可见），不会错误藏掉输入面。
 */

/** derivePanelView 输入（全原始值，无对象/函数/跨域类型） */
export interface PanelViewInput {
  /** panel 当前绑定的 session id；null = 未绑定任何会话 */
  sessionId: string | null
  /** 绑定会话是否已有消息（不参与 kind 判定，见模块头注释） */
  hasMessages: boolean
  /** session 进程已退出（dead 占位视图：不渲染对话流/composer，提供重开入口） */
  isSessionDead: boolean
  /**
   * pi 意外退出后的「引擎恢复中」过渡态（crash-resilience T4，chat store respawnPending
   * 分区）。抑制 dead：自动 respawn 窗口内对话流 + composer 保持（恢复完成由
   * session.restored 收口；熔断/超时清除本标记后回落 dead 终态页）。用户手动强制退出
   * 不置本标记 → dead 行为不变。
   */
  isSessionRespawning: boolean
  /** session-trace 视图态（per-session 分区，替换对话流位置） */
  isTraceView: boolean
  /** ask-user 阻塞应答请求待答（与 composer 互斥） */
  hasAskUserRequest: boolean
  /** 新建任务流程活跃（ACTIVE_STATES：landing + 六 overlay，flow-state.ts） */
  isFlowActive: boolean
}

/**
 * panel 渲染视图（discriminated union，消费方 switch (view.kind)）。
 * 分支字段即渲染所需最小事实：dead/trace/conversation 恒带非空 sessionId
 * （类型层收窄，消费方免判空）；landing 无字段（无 session 承接）；empty 可带 sessionId。
 */
export type PanelView =
  | { kind: 'dead'; sessionId: string }
  /** trace 保留输入面：session-trace 契约「composer 保留在底部，不打断对话能力」（D5） */
  | { kind: 'trace'; sessionId: string; input: 'ask-user' | 'composer' }
  | { kind: 'conversation'; sessionId: string; input: 'ask-user' | 'composer' }
  | { kind: 'landing' }
  | { kind: 'empty'; sessionId: string | null }

/**
 * 从 panel 事实派生渲染视图（纯函数：无副作用、无状态读取、同输入恒同输出）。
 *
 * 优先级 dead > trace > conversation > landing > empty；dead/trace 前置约束
 * 「sessionId 非空」在分支顺序上天然成立（先判空 session 提前返回）。
 * 全输入组合（7 输入 = 2^7 = 128）的行为由 __tests__/panel-view.test.ts 组合表守卫（验收 V5）。
 */
export function derivePanelView(input: PanelViewInput): PanelView {
  const { sessionId, isSessionDead, isSessionRespawning, isTraceView, hasAskUserRequest, isFlowActive } = input

  // 无 session：flow 活跃 → landing（新建流程唯一承接场景）；否则 empty 兜底。
  // dead/trace/ask-user 在此分支语义上不成立（前置约束：依附具体会话）。
  if (sessionId === null) {
    return isFlowActive ? { kind: 'landing' } : { kind: 'empty', sessionId: null }
  }

  // 有 session：landing 不可达（要求 !sessionId）——「有会话 × landing」组合在规则上不可表达，
  // 这是 G2 结构免疫的落点：无论 flow 单例因何残留活跃态，都不影响有会话 panel 的派生。
  // [crash-resilience T4] respawning 抑制 dead：自动恢复窗口内 UI 保持对话可用形态
  // （kind=conversation，过渡提示条由渲染层读 respawnPending 分区追加，不新增 kind——
  // 消费方 switch 面零膨胀）；仅 isSessionDead 且非恢复窗口才进终态 dead 占位。
  if (isSessionDead && !isSessionRespawning) {
    return { kind: 'dead', sessionId }
  }
  if (isTraceView) {
    // trace 只替换对话流位置，输入面与 conversation 同规则保留（D5，见模块头注释②）
    return { kind: 'trace', sessionId, input: hasAskUserRequest ? 'ask-user' : 'composer' }
  }
  return {
    kind: 'conversation',
    sessionId,
    input: hasAskUserRequest ? 'ask-user' : 'composer',
  }
}
