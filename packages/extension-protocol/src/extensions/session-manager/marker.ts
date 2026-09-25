/**
 * session-manager 请求的 title marker。runtime event-adapter 和 handler
 * 检测此 marker 区分 session-manager 请求与普通 select。
 *
 * NUL 前缀确保不会与 extension 正常的 select title 冲突。
 * 与 ASK_USER_MARKER / GUI_WIDGET_MARKER 同理。
 */
export const SESSION_MANAGER_MARKER = '\x00TAIJI_SESSION_MANAGER'

/**
 * 7 个 action 的运行时集合（与 SessionManagerAction 类型同源——types.ts 从此派生）。
 * event-adapter 用它把 JSON 解析出的 action 字符串收窄为联合类型，
 * 非法值折叠为 '__malformed__' 哨兵（与 handler default 分支同走 cancelled）。
 *
 * 'watch'（notify-once D6）：通知债权的纯应答通道——单键 params={notifyId} 寻址、
 * 不传 timeout、fire-and-forget 长挂 select；必须在本集合内，否则 event-adapter
 * 把它折叠成 '__malformed__'（旧 runtime 兼容象限的静默降级形态），watch 永远到不了
 * handler 路由。
 */
export const SESSION_MANAGER_ACTIONS = ['create', 'send', 'history', 'status', 'list', 'abort', 'watch'] as const
