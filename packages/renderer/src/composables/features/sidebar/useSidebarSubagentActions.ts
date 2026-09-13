/**
 * Sidebar subagent/workflow 操作 handler 集合（从 Sidebar.vue 提取，减行用）。
 *
 * 职责：subagent select/cancel + workflow select/back/action/agentCall 的事件处理。
 *
 * [U6 drawer tab 化] onSelectSubagent / onSelectAgentCall 入口改向 drawer：
 * 点击不再进 Panel overlay（全屏替换主对话流），而是 openSubagent 开 drawer subagent tab（并排）。
 * 数据加载（fetchAndInject 拉历史 + subscribeStream 实时增量）由 drawer SubagentTab 挂载时自接管
 * （SubagentTab watch(selectedSubagentId, immediate) → loadSubagentData），入口不重复拉取（DRY，
 * 避免双 RPC 竞态）。原 selectSubagent/selectAgentCall 的 overlay viewing 状态机属 U7 移除范围。
 */
import type { Ref } from 'vue'
import { usePanelStore } from '@/stores/panel'
import { useSubagentStore, subagentVirtualId } from '@/stores/subagent'
import { useWorkflowStore, agentCallVirtualId } from '@/stores/workflow'
import { useToast } from '@/composables/useToast'
import { useI18n } from 'vue-i18n'
import { openSubagent } from '@xyz-agent/core/domain/drawer'
import * as sessionApi from '@xyz-agent/core/transport/api/domains/session'
import { toErrorMessage } from '@xyz-agent/core'

export function useSidebarSubagentActions(focusedSessionId: Ref<string | null>) {
  const { t } = useI18n()
  const { error: toastError, info: toastInfo } = useToast()
  const panelStore = usePanelStore()
  const subagentStore = useSubagentStore()
  const workflowStore = useWorkflowStore()

  /** 选中 subagent → drawer 开 subagent tab（D1 统一入口，并排不遮主对话流）。
   *  mainSid 取当前 leaf session；数据加载由 SubagentTab 挂载自接管。 */
  function onSelectSubagent(subagentId: string): void {
    const mainSid = panelStore.currentLeaf?.sessionId
    if (!mainSid) return
    openSubagent({ virtualId: subagentVirtualId(mainSid, subagentId), enteredFrom: 'chat' })
  }

  /** 取消 running subagent（调 RPC + 乐观更新，失败 toast）。
   *  [GUI 快修③] 确认第二击时任务可能已收口（迟到 isStreaming=false 窗口）——此时不发
   *  cancel RPC（会被 runtime 拒绝误报「取消失败」），toast「任务已结束」给出确定反馈。 */
  async function onCancelSubagent(subagentId: string): Promise<void> {
    const sid = focusedSessionId.value
    if (!sid) return
    if (!subagentStore.isStreamingSubagent(sid, subagentId)) {
      toastInfo(t('sidebar.subagentList.alreadyEnded'))
      return
    }
    try {
      await subagentStore.cancelSubagent(sid, subagentId)
    } catch (e) {
      const msg = toErrorMessage(e)
      toastError(t('sidebar.cancelSubagentFailed', { msg }))
    }
  }

  /** 选中 workflow → 视图 2 详情（sidebar 内，不切 Panel） */
  function onSelectWorkflow(runId: string): void {
    workflowStore.selectWorkflow(panelStore.activePanelId, runId)
  }

  /** 视图 2 → 视图 1（返回 workflow 列表） */
  function onWorkflowBack(): void {
    workflowStore.backToWorkflowList(panelStore.activePanelId)
  }

  /** 选中 agent call → drawer 开 subagent tab（agentcall 两段式虚拟 id，D4 快照只读）。
   *  sidebar 点 agent call 直接进 subagent tab，无返回按钮（enteredFrom='chat'）。 */
  function onSelectAgentCall(agentCallSessionId: string | undefined): void {
    if (!agentCallSessionId) {
      toastError(t('sidebar.agentCallFailed'))
      return
    }
    openSubagent({ virtualId: agentCallVirtualId(agentCallSessionId), enteredFrom: 'chat' })
  }

  /** workflow 操作（pause/resume/abort），调 runtime RPC + 刷新列表 */
  async function onWorkflowAction(payload: { action: 'pause' | 'resume' | 'abort'; runId: string }): Promise<void> {
    const sid = focusedSessionId.value
    if (!sid) return
    try {
      await sessionApi.workflowAction(sid, payload.action, payload.runId)
      void workflowStore.loadWorkflows(sid)
    } catch (e) {
      const msg = toErrorMessage(e)
      toastError(t('sidebar.workflowOpFailed', { msg }))
    }
  }

  return {
    onSelectSubagent,
    onCancelSubagent,
    onSelectWorkflow,
    onWorkflowBack,
    onSelectAgentCall,
    onWorkflowAction,
  }
}
