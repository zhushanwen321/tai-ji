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
