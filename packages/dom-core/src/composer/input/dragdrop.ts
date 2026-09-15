/**
 * composer composer-box 拖拽落位处理 —— packages/dom-core/src/composer/input/dragdrop.ts（W2）。
 *
 * 定位：迁自 renderer useComposerDragDrop.ts。把拖入 composer-box 的图片文件转成 image segment
 * （复用 pasteImage 链路），非图片文件忽略。
 *
 * [W2 改造] 原 import { handleImagePaste } from './useImageAttachment'（走 IPC），
 * 现经 deps.pasteImage 注入（clarify C1 D1）。占位回填范式等价 contenteditable.handleImagePasteEvent
 * （DragEvent 不能复用 ClipboardEvent 通路故内联等价逻辑）。
 *
 * 数据流：dragover → isDragOver=true；drop → 遍历 imageFiles，每项插占位 badge →
 * await pasteImage → 回填真实 path/name（badge）/降级文本；dragleave → relatedTarget contains
 * 检查防子元素冒泡误触发。
 */
import { ref, type Ref } from 'vue'
import { findImageChipEl, applyImagePersistResult } from './input-dom'
import type { ComposerInputInstance, DragDropDeps } from './types'

/**
 * @param inputRef ComposerInput 实例 ref（insertImageBadge 经 defineExpose 暴露）
 * @param composerBoxRef composer-box div 模板 ref（查占位 badge 用）
 * @param onChanged drop 处理后回调（刷新 ContextChipsBar chip 行）
 * @param sessionId 当前会话 id ref（决定图片持久化目录）；landing 态 value 为 null
 * @param deps 含 pasteImage 注入（替代 handleImagePaste）
 */
export function useComposerDragDrop(
  inputRef: Ref<ComposerInputInstance | null>,
  composerBoxRef: Ref<HTMLElement | null>,
  onChanged: () => void,
  sessionId: Ref<string | null>,
  deps: DragDropDeps,
): {
  isDragOver: Ref<boolean>
  onDragOver: (e: DragEvent) => void
  onDragLeave: (e: DragEvent) => void
  onDrop: (e: DragEvent) => void
} {
  const isDragOver = ref(false)
  const { pasteImage } = deps

  function onDragOver(_e: DragEvent): void {
    isDragOver.value = true
  }

  /** dragleave 防子元素冒泡误触发：relatedTarget 仍在 box 内则不复位。 */
  function onDragLeave(e: DragEvent): void {
    const related = e.relatedTarget as Node | null
    if (related && composerBoxRef.value?.contains(related)) return
    isDragOver.value = false
  }

  /**
   * drop：遍历 dataTransfer.files，image/* 每项走占位 badge + pasteImage 回填范式；
   * 非图片文件忽略。末尾复位 isDragOver + 刷新 chip 行。
   */
  function onDrop(e: DragEvent): void {
    isDragOver.value = false
    const files = Array.from(e.dataTransfer?.files ?? [])
    const imageFiles = files.filter((f) => f.type.startsWith('image/'))
    if (imageFiles.length === 0) return
    e.preventDefault()
    void (async () => {
      const sid = sessionId.value
      for (const file of imageFiles) {
        const placeholderMark = `__drag_pending_${crypto.randomUUID()}__`
        inputRef.value?.insertImageBadge(placeholderMark, placeholderMark, '拖入中…', false)
        const result = await pasteImage(file, sid)
        const placeholder = composerBoxRef.value
          ? findImageChipEl(composerBoxRef.value, placeholderMark)
          : null
        applyImagePersistResult({
          placeholderEl: placeholder,
          result,
          insertImageBadge: (p, f, d, m) => inputRef.value?.insertImageBadge(p, f, d, m),
        })
      }
      onChanged()
    })()
  }

  return { isDragOver, onDragOver, onDragLeave, onDrop }
}
