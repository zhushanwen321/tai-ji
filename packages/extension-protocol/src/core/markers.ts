/**
 * 通用传输 marker。extension 用 guiSetWidget 编码进 string[]，
 * runtime event-adapter 检测 marker 解码为结构化 WS 帧。
 *
 * NUL 字符开头的 marker，不会出现在正常文本中。
 */
export const GUI_WIDGET_MARKER = '\x00TAIJI_GUI_WIDGET:'

/**
 * plan 审阅请求的 select title marker。plan extension 的 submit-review 挂起审批时
 * 以此 marker 为 title 发 ctx.ui.select（options[0] = PlanReviewRequest JSON，
 * 类型见 core/types.ts），runtime event-adapter 检测后广播 extension_ui_request
 * （planReview 标记，与 askUser 标记同构分流），前端审批条渲染三键审批而非
 * 原始 dialog——marker 控制符 title 落入通用 dialog 会渲染成乱码。
 *
 * NUL 前缀确保不会与 extension 正常的 select title 冲突，
 * 与 GUI_WIDGET_MARKER / ASK_USER_MARKER 同族（select 通道 marker）。
 */
export const PLAN_REVIEW_MARKER = '\x00TAIJI_PLAN_REVIEW:'

/**
 * permission 审批 select 的 title 首行判定键。pi-permission 扩展的 RPC 审批 select
 * （extensions/universal/permission approval.ts buildApprovalFieldSet 单点构造，
 * title 可多行、首行恒为此串）与 runtime event-adapter 判定（isPermissionApprovalSelect
 * 按首行精确匹配，命中后广播帧附加 permission: true 键）双端共用本常量——
 * 与 PLAN_REVIEW_MARKER 的 planReview: true 键同构分流（select 通道标记）。
 *
 * 与上方 NUL marker 家族的形态区别：这是用户可见文案（审批对话框标题），
 * 无控制符前缀；单源价值同族——双端各自手抄字面量时，生产端改文案 → 消费端
 * 静默不命中 → 侧栏 permission 等待可见性失效，零报错信号。
 */
export const PERMISSION_APPROVAL_TITLE = '[pi-permission] Approval required'
