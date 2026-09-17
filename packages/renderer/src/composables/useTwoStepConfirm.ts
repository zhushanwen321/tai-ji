/**
 * useTwoStepConfirm —— 两段式确认原语（首击 arm / 再击执行并复位 / 显式 clear 供 mouseleave
 * 防误触残留清理）。确认态为单槽（同屏至多一个 id 处于确认态）。
 *
 * 消费点：tray bash 终止 / tray subagent 取消 / workflow abort（useWorkflowAction 内部改用
 * 本原语，对外签名不变）。原语只负责确认态与 onConfirm(id) 回调——RPC / toast / 迟到收口
 * 等副作用仍留在各调用点。
 */
import { ref } from 'vue'

export function useTwoStepConfirm(onConfirm: (id: string) => void): {
  /** 该 id 是否处于确认态（按钮形态 / testid 切换判定） */
  isConfirming: (id: string) => boolean
  /** 首击置位；再击同 id = 复位后执行 onConfirm */
  toggle: (id: string) => void
  /** 确认态复位（行 mouseleave 等防误触残留清理） */
  clear: () => void
} {
  const confirmingId = ref<string | null>(null)

  function isConfirming(id: string): boolean {
    return confirmingId.value === id
  }

  function clear(): void {
    confirmingId.value = null
  }

  function toggle(id: string): void {
    if (confirmingId.value === id) {
      clear()
      onConfirm(id)
      return
    }
    confirmingId.value = id
  }

  return { isConfirming, toggle, clear }
}
