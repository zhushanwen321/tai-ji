/**
 * problem-solve-canvas 契约模块 —— marker 与 action 词表（U1 SSOT）。
 *
 * 设计锚点：.tmp/tech-design/problem-solve-canvas.md §3.1(1)/(2) + §5-U1。
 * 本目录是画布三侧（pi extension 工具面 / runtime CanvasService / renderer 视图）
 * 共享的唯一词表与 schema 来源——防 GUI 与工具两个入口各自发明语义。
 *
 * 两层词表（有意分开，勿合并）：
 * - CANVAS_ACTIONS（16）：CanvasService.mutate 唯一入口的 action 域，
 *   per-action × actor 权限矩阵按此建制（matrix.ts）。
 * - CANVAS_MARKER_ACTIONS（16 + 'enter'）：marker 通道（extension select 挂起）
 *   的 action 域。'enter' 是 canvas_enter 工具「打开已有画布」形态的通道动作：
 *   读全量 + 登记绑定（sessionId ↔ canvasId），非画布 mutation——不产事件、
 *   不在权限矩阵内（marker 通道调用方恒为 agent 工具）。创建形态走 'create'
 *   （marker 通道的 create 只可能来自 canvas_enter 工具，runtime 在该通道
 *   create 成功时一并登记绑定；GUI 托盘新建走 WS RPC 通道、不登记绑定）。
 */

/**
 * canvas 工具请求的 title marker。runtime event-adapter / CanvasHandler 检测此
 * marker 区分 canvas 请求与普通 select（SESSION_MANAGER 同款形态）。
 *
 * NUL 前缀确保不会与 extension 正常的 select title 冲突。
 * 属内部服务类 marker：走 translateInteractiveRequest 显式分支，
 * 不入 MARKER_DIALOG_FALLBACKS 降级表（畸形 payload 以结构化错误应答回
 * marker 通道，不降级为用户可见对话框）。
 */
export const CANVAS_MARKER = '\x00TAIJI_CANVAS'

/**
 * 16 个 mutate / 查询 action 的运行时集合（与 CanvasAction 类型同源——types.ts 从此派生）。
 *
 * 词序按领域生命周期排列：创建 → 生长 → 编辑 → 方向裁决 → 选定 → 状态转移 →
 * 评论 → 评论响应 → 审查三动作 → 收敛确认 → 导出 → 派发 → 查询两类。
 *
 * 'read' / 'list' 是查询类：不产领域事件、不在「每个 mutation action 至少产出
 * 一个事件」的对账范围（U2 承接对账，ACTION_EVENT_MAP 为对账 SSOT——state.ts）。
 */
export const CANVAS_ACTIONS = [
  'create',
  'grow',
  'patch',
  'decide-direction',
  'select',
  'transition',
  'comment',
  'comment-respond',
  'review-request',
  'review-append',
  'review-resolve',
  'converge-check',
  'export',
  'dispatch',
  'read',
  'list',
] as const

/**
 * marker 通道词表 = CANVAS_ACTIONS + 'enter'（两层词表的通道层，见文件头说明）。
 * event-adapter 用它把 JSON 解析出的 action 字符串收窄；表外值折叠为畸形
 * → 结构化错误应答（不降级对话框）。
 */
export const CANVAS_MARKER_ACTIONS = [...CANVAS_ACTIONS, 'enter'] as const
