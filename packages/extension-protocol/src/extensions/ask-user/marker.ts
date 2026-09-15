/**
 * ask-user 富交互请求的 title marker。runtime event-adapter 和前端 useExtensionUI
 * 检测此 marker 区分 ask-user 请求与普通 select。
 *
 * NUL 前缀确保不会与 extension 正常的 select title 冲突。
 * 与 GUI_WIDGET_MARKER 同理（见 core/markers.ts）。
 */
export const ASK_USER_MARKER = '\x00TAIJI_ASK_USER'
