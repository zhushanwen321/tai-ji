/**
 * useSessionDropTarget —— 侧栏 session 拖拽落点的统一交互（dragover 高亮 + drop 回调）。
 *
 * 消费方：ProjectGroup 组头（拖到项目 = 移动归属）与 DefaultProjectHead（拖到默认项目
 * 行 = 归回未归类聚合），两处同一交互语义，收拢为单一实现。
 *
 * 判别：dragover 阶段 getData 不可读（HTML5 DnD 安全限制），按 dataTransfer.types
 * 命中 SESSION_DRAG_MIME 判别「拖的是 session」——文件拖入窗口等无关拖拽不 preventDefault、
 * 不高亮、不触发 drop 回调。
 * dragleave 抖动：进入落点子元素（文字 span / 按钮）也会冒泡 dragleave，按
 * relatedTarget 是否仍在落点元素内过滤，只有真正离开才清高亮。
 */
import { ref } from 'vue'
import { SESSION_DRAG_MIME } from '@/components/sidebar/session-drag'

export function useSessionDropTarget(onDropSession: (sessionId: string) => void) {
  /** 拖拽悬停高亮态（drop 后 / 拖离即清；渲染侧挂视觉 + data-dragover 测试锚点） */
  const dropActive = ref(false)

  function isSessionDrag(e: DragEvent): boolean {
    return e.dataTransfer?.types.includes(SESSION_DRAG_MIME) ?? false
  }

  /** dragover 必须 preventDefault 才允许成为 drop 目标（HTML5 DnD 契约） */
  function onDragOver(e: DragEvent): void {
    if (!isSessionDrag(e)) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    dropActive.value = true
  }

  function onDragLeave(e: DragEvent): void {
    if (e.relatedTarget && (e.currentTarget as Node).contains(e.relatedTarget as Node)) return
    dropActive.value = false
  }

  function onDrop(e: DragEvent): void {
    if (!isSessionDrag(e)) return
    e.preventDefault()
    dropActive.value = false
    const sessionId = e.dataTransfer?.getData(SESSION_DRAG_MIME)
    if (sessionId) onDropSession(sessionId)
  }

  return { dropActive, onDragOver, onDragLeave, onDrop }
}
