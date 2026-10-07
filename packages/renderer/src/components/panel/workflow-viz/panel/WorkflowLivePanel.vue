<template>
  <!--
    WorkflowLivePanel —— workflow overlay 右栏实况面板（workflow-visualization 设计 §3.1-2
    两级 tab）：header（run 状态 pill + 已用时长停走 + args 摘要）+ L2TabBar（一级 tab：
    workflow 固定 + phase/agent 动态 tab，close 复用 @taiji/ui L2TabBar）+ 内容分发。
    tab 关闭激活左侧相邻 tab，无左侧相邻回 workflow 固定 tab（panel-tabs.ts 纯逻辑）。
    D11③ 切换 run = overlay 容器按 runId 重挂载本面板（:key），tab 随挂载态消亡构造性
    达成；本组件对 props.run.runId 变化仍做防御性重置（容器未 keyed 时 tab 不串 run）。
  -->
  <div class="flex h-full min-h-0 min-w-0 flex-col" data-testid="wf-viz-live-panel">
    <!-- header：状态 pill + 已用时长（中断/终局停走）+ args 摘要 -->
    <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline px-3 py-2">
      <span
        class="shrink-0 rounded-sm border border-hairline px-1.5 py-px text-[length:var(--text-3xs)] font-medium"
        :class="pillClass"
        data-testid="wf-viz-run-pill"
        :data-status="run.status"
      >
        {{ pillText }}
      </span>
      <span class="shrink-0 font-mono text-[length:var(--text-3xs)] text-neutral-dim" data-testid="wf-viz-run-elapsed">
        {{ t('panel.workflowViz.elapsedLabel', { duration: elapsedText }) }}
      </span>
      <span
        v-if="run.argsSummary"
        class="min-w-0 flex-1 truncate font-mono text-[length:var(--text-3xs)] text-neutral-faint"
        :title="run.argsSummary"
        data-testid="wf-viz-run-args"
      >{{ run.argsSummary }}</span>
    </div>

    <!-- 一级 tab 栏（L2TabBar 复用——close 事件现成；固定 tab builtin 不渲染 close） -->
    <div class="shrink-0 px-2 py-1.5">
      <L2TabBar
        :tabs="tabItems"
        :model-value="activeKey"
        data-testid="wf-viz-tabbar"
        @update:model-value="activeKey = $event"
        @close="onCloseTab"
      />
    </div>

    <!-- 内容分发 -->
    <WorkflowTabContent
      v-if="activeTab === undefined || activeTab.kind === 'workflow'"
      :session-id="sessionId"
      :run="run"
      :gantt-component="ganttComponent"
      class="min-h-0"
      @open-agent="openAgentTab"
    />
    <PhaseTabContent
      v-else-if="activeTab.kind === 'phase'"
      :session-id="sessionId"
      :run="run"
      :phase="activeTab.phase ?? ''"
      @open-agent="openAgentTab"
    />
    <AgentTabContent
      v-else-if="activeTab.kind === 'agent' && activeCall !== undefined"
      :key="activeTab.key"
      :session-id="sessionId"
      :call="activeCall"
      :run-status="run.status"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Component } from 'vue'
import { L2TabBar } from '@taiji/ui/extension-host'
import type { L2TabItem } from '@taiji/ui/extension-host'
import { WORKFLOW_RUN_OUTCOME_LABELS } from '@taiji/shared'
import WorkflowTabContent from './WorkflowTabContent.vue'
import PhaseTabContent from './PhaseTabContent.vue'
import AgentTabContent from './AgentTabContent.vue'
import {
  WORKFLOW_FIXED_TAB_KEY,
  agentTabKey,
  closeLiveTab,
  openLiveTab,
  phaseTabKey,
} from './panel-tabs'
import type { WorkflowLiveTab } from './panel-tabs'
import { useWorkflowStore, deriveWorkflowRunElapsedMs } from '@/stores/workflow'
import { formatCompactDuration, MS_PER_SECOND } from '@/lib/duration-format'
import type { WorkflowAgentCall, WorkflowRunRecord } from '@taiji/shared'

const props = defineProps<{
  /** 主 session id（事件流拉取与 agentcall 编排的归属 session）。 */
  sessionId: string
  /** 当前 run 投影（overlay 容器从 workflowStore.recordsOf 分区选中后传入）。 */
  run: WorkflowRunRecord
  /** u4 Gantt 展示组件（overlay 容器装配时注入；缺省 = 分段统计降级形态）。 */
  ganttComponent?: Component
}>()

const { t } = useI18n()
const store = useWorkflowStore()

// ── D11 挂载编排：活跃 run 登记 + 事件流首拉（缓存命中即复用——重开秒显）────────
onMounted(() => {
  store.setActiveWorkflowRun(props.sessionId, props.run.runId)
  void store.loadWorkflowRunEvents(props.sessionId, props.run.runId)
})
// 同实例换 run 的防御（容器未 keyed 时）：tab 全部重置回固定 tab（D11③ 语义）+ 活跃锚
// 换指 + 事件流拉取（缓存命中复用）
watch(
  () => props.run.runId,
  (runId, prevRunId) => {
    if (runId === prevRunId) return
    tabs.value = []
    activeKey.value = WORKFLOW_FIXED_TAB_KEY
    store.setActiveWorkflowRun(props.sessionId, runId)
    void store.loadWorkflowRunEvents(props.sessionId, runId)
  },
)
onUnmounted(() => {
  store.releaseActiveWorkflowRun(props.sessionId, props.run.runId)
})

// ── 一级 tab 模型（动态 tab 数组不含固定 tab——固定项由本组件渲染在 L2TabBar 首位）──

const tabs = ref<WorkflowLiveTab[]>([])
const activeKey = ref<string>(WORKFLOW_FIXED_TAB_KEY)

const tabItems = computed<L2TabItem[]>(() => [
  { viewId: WORKFLOW_FIXED_TAB_KEY, title: props.run.scriptName, builtin: true },
  ...tabs.value.map((tab) => ({ viewId: tab.key, title: tab.title })),
])

const activeTab = computed<WorkflowLiveTab | undefined>(() =>
  tabs.value.find((tab) => tab.key === activeKey.value),
)

/** agent tab 归属 call 反查（activeTab.callId → run.agentCalls；run 更新后 trace 行对象
 *  换引用，详情面按 id 重查保持最新投影）。 */
const activeCall = computed<WorkflowAgentCall | undefined>(() => {
  const tab = activeTab.value
  if (tab?.kind !== 'agent' || tab.callId === undefined) return undefined
  return props.run.agentCalls.find((c) => c.id === tab.callId)
})

function onCloseTab(viewId: string): void {
  const next = closeLiveTab(tabs.value, activeKey.value, viewId)
  tabs.value = next.tabs
  activeKey.value = next.activeKey
}

/** 打开 phase tab（点 DAG phase 分区由 u4 容器经 expose 调用；已存在则仅激活）。 */
function openPhaseTab(phase: string): void {
  const next = openLiveTab(tabs.value, {
    key: phaseTabKey(phase),
    kind: 'phase',
    title: phase,
    phase,
  })
  tabs.value = next.tabs
  activeKey.value = next.activeKey
}

/** 打开 agent tab（trace 行点击 / DAG agent 节点由容器经 expose 调用；pending/无 sessionId
 *  call no-op——pending 零对话可看，sessionId 缺失（60s 节流合并窗口）对齐 WorkflowTab 现状）。 */
function openAgentTab(call: WorkflowAgentCall): void {
  if (call.status === 'pending' || !call.sessionId) return
  const next = openLiveTab(tabs.value, {
    key: agentTabKey(call.id),
    kind: 'agent',
    title: call.agent,
    callId: call.id,
  })
  tabs.value = next.tabs
  activeKey.value = next.activeKey
}

defineExpose({ openPhaseTab, openAgentTab })

// ── header：状态 pill（D9 着色映射）+ 已用时长（中断/终局停走）──────────────────

const pillClass = computed(() => {
  switch (props.run.status) {
    case 'running':
      return 'text-accent'
    case 'interrupted':
      return 'text-neutral-mid'
    case 'done':
      // D9 全枚举着色（与 RunTraceTable stoppedColorOf 同源）：cancelled → 取消色
      //（中性，对齐 trace 行）、failed/time_limited → 失败色系、done → 成功色
      if (props.run.outcome === 'failed' || props.run.outcome === 'time_limited') return 'text-danger'
      return props.run.outcome === 'cancelled' ? 'text-neutral-mid' : 'text-success'
    default: {
      const exhaustive: never = props.run.status
      throw new Error(`unreachable run status: ${String(exhaustive)}`)
    }
  }
})

const pillText = computed(() => {
  switch (props.run.status) {
    case 'running':
      return t('panel.sideDrawer.workflowRunning')
    case 'interrupted':
      return t('panel.tray.workflowInterrupted')
    case 'done':
      // 终局文案 = outcome 显示名（WORKFLOW_RUN_OUTCOME_LABELS 词表 SSOT）；failed 终态
      // errorCode 摘要并入（设计：failed 终态附 errorCode 摘要）
      return props.run.outcome !== undefined
        ? `${WORKFLOW_RUN_OUTCOME_LABELS[props.run.outcome]}${props.run.errorCode ? ` · ${props.run.errorCode}` : ''}`
        : t('panel.workflowViz.statusDone')
    default: {
      const exhaustive: never = props.run.status
      throw new Error(`unreachable run status: ${String(exhaustive)}`)
    }
  }
})

// 1s tick 只驱动 running 态已用时长重算（停走 = 数据锚切换，不靠 tick 停）
const now = ref(Date.now())
const TICK_INTERVAL_MS = 1000
const tickTimer = setInterval(() => {
  now.value = Date.now()
}, TICK_INTERVAL_MS)
onUnmounted(() => clearInterval(tickTimer))

const elapsedText = computed(() => {
  // D9 停走口径单点 = workflowStore 的 deriveWorkflowRunElapsedMs（与 overlay 壳 header
  // 共用同一派生，禁双实现——两 header 数值恒一致）
  const ms = deriveWorkflowRunElapsedMs(props.run, now.value)
  if (ms === null) return '—'
  return formatCompactDuration(Math.floor(ms / MS_PER_SECOND), { hours: false })
})
</script>
