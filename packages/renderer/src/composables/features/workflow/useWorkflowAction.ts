/**
 * useWorkflowAction —— workflow abort 两段式动作单点（drawer WorkflowTab + tray workflow
 * 面板共享，质量审查结构收敛批：原两组件各持一份「两段式确认 + workflowAction RPC +
 * loadWorkflows 刷新 + toast」双实现收敛于此）。
 *
 * - 确认态：单槽 ref（同屏至多一个 run 处于确认态），首击置位、再击执行并复位；
 *   clearAbortConfirm 供行 mouseleave 防误触残留清理（tray 面板消费）。
 * - 执行：workflowAction RPC + loadWorkflows 刷新（不做乐观写——workflow 状态由 runtime
 *   推送权威）；失败 toast（错误文案单 key panel.tray.workflowOpFailed，zh/en 同步登记）。
 * - sessionId 由调用方以 getter 注入（tab 消费 panelStore.focusedSessionId / tray 消费
 *   props.sessionId），getter 返回空时不发 RPC（守卫边界）。
 */
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toErrorMessage } from '@taiji/core'
import { workflowAction } from '@taiji/core/transport/api/domains/session'
import { useWorkflowStore } from '@/stores/workflow'
import { useToast } from '@/composables/useToast'

export function useWorkflowAction(getSessionId: () => string | null | undefined) {
  const { t } = useI18n()
  const { error: toastError } = useToast()
  const workflowStore = useWorkflowStore()

  /** 两段式确认态：处于确认态的 runId（null = 无） */
  const confirmingRunId = ref<string | null>(null)

  /** 该 run 是否处于 abort 确认态（按钮形态/测试 id 切换判定） */
  function isAbortConfirming(runId: string): boolean {
    return confirmingRunId.value === runId
  }

  /** 确认态复位（行 mouseleave 防误触残留清理） */
  function clearAbortConfirm(): void {
    confirmingRunId.value = null
  }

  /** abort 两段式：首击进入确认态，再击执行并复位 */
  function onAbortClick(runId: string): void {
    if (confirmingRunId.value === runId) {
      clearAbortConfirm()
      void abortWorkflow(runId)
      return
    }
    confirmingRunId.value = runId
  }

  /** workflow abort：调 runtime RPC + 刷新列表（pause/resume 随扩展 D-2 一次性生命周期移除） */
  async function abortWorkflow(runId: string): Promise<void> {
    const sid = getSessionId()
    if (!sid) return
    try {
      await workflowAction(sid, 'abort', runId)
      void workflowStore.loadWorkflows(sid)
    } catch (e) {
      toastError(t('panel.tray.workflowOpFailed', { msg: toErrorMessage(e) }))
    }
  }

  return { isAbortConfirming, onAbortClick, clearAbortConfirm, abortWorkflow }
}
