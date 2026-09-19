/**
 * scheduler 创建确认请求的 title marker。runtime event-adapter 和前端 useExtensionUI
 * 检测此 marker 区分 schedule 创建确认请求与普通 select。
 *
 * NUL 前缀确保不会与 extension 正常的 select title 冲突。
 * 与 ASK_USER_MARKER 同规范（ask-user 模块同包 marker.ts）。
 */
export const SCHEDULE_CREATE_MARKER = '\x00TAIJI_SCHEDULE_CREATE'
