/**
 * useCopy —— 复制到剪贴板 + 反馈态 composable。
 *
 * 抽自 Turn.vue 的局部 copy 逻辑，供 Turn（user/summary 复制）、MarkdownRenderer
 * （代码块复制）等复用，消除复制反馈态逻辑重复。单一真相源。
 *
 * - navigator.clipboard.writeText 写入剪贴板；**成功后再置 copied 图标**（RD-1#3：
 *   旧实现同步置图标 + `.catch(()=>{})` 空吞，写盘失败仍显示「已复制」= 假成功）。
 * - 失败：清本次图标（若在显示）+ console.warn 留痕 + toast 显形——与 composer 快捷键
 *   复制路径（composer-shortcut-actions copyLastAssistantReply → toast error
 *   panel.composer.copyLastReplyFailed）同口径：键盘/点击复制失败都须用户可见。
 * - copied ref 记录最近复制的 key，COPIED_FEEDBACK_MS 后清除；连续复制时后者覆盖前者的定时。
 */
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from '@/composables/useToast'

/** 复制反馈持续时长（ms）—— 与原 Turn.vue 局部常量一致 */
const COPIED_FEEDBACK_MS = 1200

export function useCopy() {
  /** 最近复制的 key（null = 无反馈态）；调用方用它切换 Copy/Check 图标 */
  const copied = ref<string | null>(null)
  const { t } = useI18n()
  const { error: toastError } = useToast()
  let resetTimer: ReturnType<typeof setTimeout> | null = null

  /** 清反馈图标（仅当仍是本次 key 时才清，避免误清后到 copy 的反馈）。 */
  function clearFeedback(key: string): void {
    if (copied.value === key) copied.value = null
  }

  function copy(text: string, key: string): void {
    // 两个回调都提供 → 无 unhandled rejection（fire-and-forget 不得成为新崩溃源）。
    void navigator.clipboard.writeText(text).then(
      () => {
        // 写盘确认成功后才显示「已复制」图标（假成功修复：RD-1#3）
        copied.value = key
        if (resetTimer) clearTimeout(resetTimer)
        resetTimer = setTimeout(() => {
          // 仅当仍是本次 key 时才清，避免被更新的 copy 覆盖
          clearFeedback(key)
        }, COPIED_FEEDBACK_MS)
      },
      (e: unknown) => {
        // 失败：回滚图标 + warn 留痕 + toast 显形（非关键路径但不得假成功/静默）
        console.warn(`[useCopy] clipboard writeText failed (key=${key}):`, e)
        clearFeedback(key)
        toastError(t('panel.composer.copyLastReplyFailed'))
      },
    )
  }

  return { copied, copy }
}
