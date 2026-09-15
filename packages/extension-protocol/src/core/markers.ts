/**
 * 通用传输 marker。extension 用 guiSetWidget 编码进 string[]，
 * runtime event-adapter 检测 marker 解码为结构化 WS 帧。
 *
 * NUL 字符开头的 marker，不会出现在正常文本中。
 */
export const GUI_WIDGET_MARKER = '\x00TAIJI_GUI_WIDGET:'
