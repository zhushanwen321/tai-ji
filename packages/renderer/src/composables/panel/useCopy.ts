/**
 * useCopy —— 复制到剪贴板 + 反馈态 composable。
 *
 * 抽自 Turn.vue 的局部 copy 逻辑，供 Turn（user/summary 复制）、MarkdownRenderer
 * （代码块复制）等复用，消除复制反馈态逻辑重复。单一真相源。
 *
 * - navigator.clipboard.writeText 写入剪贴板（失败静默，catch 吞错——非关键路径）。
 * - copied ref 记录最近复制的 key，COPIED_FEEDBACK_MS 后清除；连续复制时后者覆盖前者的定时。
 */
import { ref } from 'vue'

/** 复制反馈持续时长（ms）—— 与原 Turn.vue 局部常量一致 */
const COPIED_FEEDBACK_MS = 1200

export function useCopy() {
  /** 最近复制的 key（null = 无反馈态）；调用方用它切换 Copy/Check 图标 */
  const copied = ref<string | null>(null)
  let resetTimer: ReturnType<typeof setTimeout> | null = null

  function copy(text: string, key: string): void {
    navigator.clipboard.writeText(text).catch(() => {
      /* 剪贴板失败静默：非关键路径，不阻塞 UI */
    })
    copied.value = key
    if (resetTimer) clearTimeout(resetTimer)
    resetTimer = setTimeout(() => {
      // 仅当仍是本次 key 时才清，避免被更新的 copy 覆盖
      if (copied.value === key) copied.value = null
    }, COPIED_FEEDBACK_MS)
  }

  return { copied, copy }
}
