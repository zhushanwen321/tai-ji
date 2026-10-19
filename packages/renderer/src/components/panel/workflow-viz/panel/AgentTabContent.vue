<template>
  <!--
    AgentTabContent —— agent 一级 tab 内容（设计 §3.1-2：对话流走 subagent 三段式虚拟
    id（`subagent:<mainSid>:<memberRecordId>`）+ useSubagentTabData 三段式管线整体复用
    ——拉历史 + subscribeStream 流式订阅（chunk 增量 / 定稿收口 / 失步拉取）+ entry 帧
    投影 + task 气泡种入，与 drawer SubagentTab 同一套实现；独立 streamScope 防与
    drawer 订阅互踩）+ call trace 详情。memberRecordId 未达（run 推送窗口）时出等待
    态，vid 就绪后 watch 触发加载自愈。
  -->
  <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-testid="wf-viz-agent-tab">
    <!-- call trace 详情（元信息条） -->
    <div class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-hairline px-3 py-1.5 font-mono text-[length:var(--text-3xs)] text-neutral-dim" data-testid="wf-viz-agent-meta">
      <span class="font-medium text-neutral-fg">{{ call.agent }}</span>
      <span v-if="call.phase">{{ call.phase }}</span>
      <span :data-status="view.status">{{ statusText }}</span>
      <span v-if="call.durationMs !== undefined">{{ t('panel.workflowViz.traceColDuration') }} {{ formatCompactDuration(Math.floor(call.durationMs / MS_PER_SECOND), { hours: false }) }}</span>
      <span v-if="tokenTotal > 0">{{ formatTokens(tokenTotal, 'tokens') }}</span>
      <span v-if="call.turns !== undefined">{{ call.turns }} {{ t('sidebar.workflowDetail.turnsUnit') }}</span>
    </div>
    <!-- 拉取失败态（错误态语言与子页降级一致） -->
    <div v-if="loadError !== null" class="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center" data-testid="wf-viz-agent-error">
      <AlertCircle class="size-6 text-danger opacity-60" />
      <p class="text-[length:var(--text-xs)] text-neutral-fg">{{ t('panel.sideDrawer.subagentLoadFailed') }}</p>
      <p class="max-w-[420px] break-all text-[length:var(--text-2xs)] text-neutral-dim">{{ loadError }}</p>
      <!-- 重试按钮：点击重调拉取编排，loadSubagentData 开头同步置空 loadError → 错误块
           分支切走按钮消失（构造性防重复点击，与事件流子页 onRetry 同款机制） -->
      <Button variant="ghost" size="sm" data-testid="wf-viz-agent-retry" @click="onRetry">
        <RotateCcw class="mr-1 size-3" />
        {{ t('panel.workflowViz.retry') }}
      </Button>
    </div>
    <!-- 等待态：memberRecordId 未达（run 推送窗口内尚无可订阅的成员 record） -->
    <div v-else-if="virtualId === null" class="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center" data-testid="wf-viz-agent-waiting">
      <p class="text-[length:var(--text-xs)] text-neutral-mid">{{ t('panel.workflowViz.agentTabWaiting') }}</p>
    </div>
    <!-- 对话流（D3 硬约束：直接挂主对话流同一个 MessageStream，不重写任何渲染树）；
         mainSessionId 显式传 props.sessionId（D11⑤ 归属绑定发起 session）——三段式 vid
         命名空间即由它构成，file 白名单/markdown 路径 cwd 解析同源 -->
    <MessageStream v-else :session-id="virtualId" :main-session-id="sessionId" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, RotateCcw } from '@lucide/vue'
import { Button } from '@taiji/ui'
import MessageStream from '@/components/panel/MessageStream.vue'
import { useSubagentTabData } from '@/composables/panel/useSubagentTabData'
import { useSubagentStore } from '@/stores/subagent'
import { subagentVirtualId } from '@taiji/shared'
import { deriveCallView } from '../gantt-segments'
import { formatTokens } from '@/lib/token-format'
import { formatCompactDuration, MS_PER_SECOND } from '@/lib/duration-format'
import type { WorkflowAgentCall, WorkflowRunStatus } from '@taiji/shared'

const props = defineProps<{
  /** 主 session id（三段式 vid 的命名空间中段——overlay 绑定发起 session，D11⑤）。 */
  sessionId: string
  call: WorkflowAgentCall
  /** run 派生视图状态（D9 派生输入）。 */
  runStatus: WorkflowRunStatus
}>()

const { t } = useI18n()
const subagentStore = useSubagentStore()

/**
 * agent tab 独立订阅 scope：与 drawer SubagentTab（'drawer:subagent'）隔离——overlay
 * 盖在面板之上时 drawer 不卸载，共用 token 会互停对方订阅。
 */
const STREAM_SCOPE = 'wf-viz:agent-tab'

/**
 * 三段式虚拟 id（`subagent:<mainSid>:<memberRecordId>`）：分区键 = tee 流式帧路由键 =
 * entry 帧投影键，三键同源构造性对齐（drawer 同款）。memberRecordId 未达（run 推送
 * 窗口）为 null → 等待态，到达后 watch 触发加载自愈。
 */
const virtualId = computed<string | null>(() => {
  const recordId = props.call.memberRecordId
  return recordId === undefined ? null : subagentVirtualId(props.sessionId, recordId)
})

const view = computed(() => deriveCallView(props.call, props.runStatus))

/**
 * 复用 useSubagentTabData 三段式管线（与 drawer SubagentTab 同一套实现，零新拉取链）：
 * currentRecord = 按 memberRecordId 查成员 record（task 气泡种入：磁盘历史未落盘的
 * 窗口内先显任务提示词）；独立 streamScope 防与 drawer 订阅互踩。
 */
const { loadError, loadSubagentData, stopSubagentStream } = useSubagentTabData({
  currentRecord: computed(() => {
    const recordId = props.call.memberRecordId
    if (recordId === undefined) return null
    return subagentStore.getRecordsBySession(props.sessionId).find((r) => r.subagentId === recordId) ?? null
  }),
  noOutcomeText: () => t('panel.sideDrawer.subagentNoOutcome'),
  streamScope: STREAM_SCOPE,
})

onMounted(() => {
  if (virtualId.value !== null) void loadSubagentData(virtualId.value)
})
// tab 复用实例切 call（或 memberRecordId 就绪）时（重）加载——流式订阅随 loadSubagentData
// 按同 scope 先停旧再起新，不泄漏
watch(virtualId, (vid) => {
  if (vid !== null) void loadSubagentData(vid)
})
onUnmounted(() => {
  stopSubagentStream()
})

/** 重试 = 重调拉取编排（loadError 同步置空 → 错误块分支切走按钮消失，构造性防重复点击）。 */
function onRetry(): void {
  if (virtualId.value !== null) void loadSubagentData(virtualId.value)
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
