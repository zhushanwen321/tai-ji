/**
 * 侧栏 session 拖拽（移动到项目）的共享常量。
 *
 * 发起点 = SessionItem 根行（dragstart 写入）；落点识别 = useSessionDropTarget
 * （dragover/drop 按 types 命中判断，文件拖入等无关拖拽不误触高亮）。
 * 自定义 MIME 类型：dataTransfer.getData 在 dragover 阶段不可读（安全限制），
 * types 列表是唯一可在 dragover 判别拖拽来源的通道。
 */
export const SESSION_DRAG_MIME = 'application/x-taiji-session'
