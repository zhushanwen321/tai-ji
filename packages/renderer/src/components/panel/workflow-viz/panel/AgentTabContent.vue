<template>
  <!--
    AgentTabContent —— agent 一级 tab 内容（设计 §3.1-2：对话流复用 `agentcall:` 虚拟 id +
    MessageStream 快照语义（D4：agentcall 通道不接实时流式——实时性由列表 status +
    workflowUpdate 信号重新拉取体现，信号 watch 见 script 末段）与 call trace 详情；复用
    useSubagentTabData 既有拉取编排（getAgentCallHistory + setMessages + registerAgentCall
    清理映射登记；归属 mainSid 显式传 props.sessionId）。
  -->
  <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-testid="wf-viz-agent-tab">
    <!-- call trace 详情（快照元信息条） -->
    <div class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-hairline px-3 py-1.5 font-mono text-[length:var(--text-3xs)] text-neutral-dim" data-testid="wf-viz-agent-meta">
      <span class="font-medium text-neutral-fg">{{ call.agent }}</span>
      <span v-if="call.phase">{{ call.phase }}</span>
      <span :data-status="view.status">{{ statusText }}</span>
      <span v-if="call.durationMs !== undefined">{{ t('panel.workflowViz.traceColDuration') }} {{ formatCompactDuration(Math.floor(call.durationMs / MS_PER_SECOND), { hours: false }) }}</span>
      <span v-if="tokenTotal > 0">{{ formatTokens(tokenTotal, 'tokens') }}</span>
      <span v-if="call.turns !== undefined">{{ call.turns }} {{ t('sidebar.workflowDetail.turnsUnit') }}</span>
    </div>
    <!-- 拉取失败态（agentcall 快照拉取失败——错误态语言与子页降级一致） -->
    <div v-if="loadError !== null" class="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center" data-testid="wf-viz-agent-error">
      <AlertCircle class="size-6 text-danger opacity-60" />
      <p class="text-[length:var(--text-xs)] text-neutral-fg">{{ t('panel.sideDrawer.subagentLoadFailed') }}</p>
      <p class="max-w-[420px] break-all text-[length:var(--text-2xs)] text-neutral-dim">{{ loadError }}</p>
      <!-- 重试按钮（设计 §3.1-2 失败路径：错误态 + 重试，同一错误态语言）；点击重调快照拉取，
           loadSubagentData 开头同步置空 loadError → 错误块分支切走按钮消失（构造性防重复
           点击，与事件流子页 onRetry 同款机制） -->
      <Button variant="ghost" size="sm" data-testid="wf-viz-agent-retry" @click="onRetry">
        <RotateCcw class="mr-1 size-3" />
        {{ t('panel.workflowViz.retry') }}
      </Button>
    </div>
    <!-- 对话流（D3 硬约束：直接挂主对话流同一个 MessageStream，不重写任何渲染树） -->
    <MessageStream v-else :session-id="virtualId" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, RotateCcw } from '@lucide/vue'
import { Button } from '@taiji/ui'
import MessageStream from '@/components/panel/MessageStream.vue'
import { useSubagentTabData } from '@/composables/panel/useSubagentTabData'
import { agentCallVirtualId, useWorkflowStore } from '@/stores/workflow'
import { deriveCallView } from '../gantt-segments'
import { formatTokens } from '@/lib/token-format'
import { formatCompactDuration, MS_PER_SECOND } from '@/lib/duration-format'
import type { WorkflowAgentCall, WorkflowRunStatus } from '@taiji/shared'

const props = defineProps<{
  /** 主 session id（agentcall 快照的显式归属——overlay 绑定发起 session 不随焦点，D11⑤）。 */
  sessionId: string
  call: WorkflowAgentCall
  /** run 投影状态（D9 派生输入）。 */
  runStatus: WorkflowRunStatus
}>()

const { t } = useI18n()
const store = useWorkflowStore()

/** `agentcall:` 虚拟 id（两段式；chatStore.messages Map 按虚拟 id 分区）。 */
const virtualId = computed(() => agentCallVirtualId(props.call.sessionId ?? ''))

const view = computed(() => deriveCallView(props.call, props.runStatus))

/**
 * 复用 SubagentTab 的 agentcall 快照编排（零新拉取链）：currentRecord 传 null（三段式
 * subagent 专属兜底/种入分支不适用 agentcall 快照语义，agentcall 分支不读它）；
 * agentcallMainSid 显式传 props.sessionId——overlay agent tab 绑定发起 session，不经
 * 焦点 pane（焦点漂移窗口内的重拉仍打正确分区，D11⑤）。
 */
const { loadError, loadSubagentData } = useSubagentTabData({
  currentRecord: computed(() => null),
  noOutcomeText: () => '',
  agentcallMainSid: () => props.sessionId,
})

onMounted(() => {
  void loadSubagentData(virtualId.value)
})
// tab 复用实例切 call 时重拉快照（agentcall 快照只读语义：重拉覆盖分区）
watch(virtualId, (vid) => {
  void loadSubagentData(vid)
})
// [D8/§3.1-2] workflowUpdate 信号重拉：store 活跃 run 信号纪元自增（信号命中活跃 run）
// → 重调本 tab 快照拉取（拉取时刻快照 + 信号触发重新拉取——对话流随 run 推进刷新）
watch(() => store.activeRunSignalEpoch, () => {
  void loadSubagentData(virtualId.value)
})

/** 重试 = 重调 agentcall 快照拉取（loadError 同步置空 → 错误块切走按钮消失，构造性防重复点击）。 */
function onRetry(): void {
  void loadSubagentData(virtualId.value)
}

const statusText = computed(() => {
  switch (view.value.status) {
    case 'pending': return t('panel.sideDrawer.workflowPending')
    case 'running': return t('panel.sideDrawer.workflowRunning')
    case 'retrying': return t('panel.workflowViz.statusRetrying')
    case 'done': return t('panel.workflowViz.statusDone')
    case 'failed': return t('panel.workflowViz.statusFailed')
    default: {
      const exhaustive: never = view.value.status
      throw new Error(`unreachable derived status: ${String(exhaustive)}`)
    }
  }
})

const tokenTotal = computed(() => (props.call.inputTokens ?? 0) + (props.call.outputTokens ?? 0))
</script>
