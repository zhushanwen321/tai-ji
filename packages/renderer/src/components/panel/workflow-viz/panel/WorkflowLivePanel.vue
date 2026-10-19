<template>
<!--
  WorkflowLivePanel —— workflow overlay 下区 dock 实况面板（workflow-visualization
  设计 §3.1-2 两级 tab；纵向布局 D2 单 header 终态：面板自身无 header 行——run 状态
  pill / 已用时长 / args 摘要由壳 header 单点呈现，本面板顶格从 L2TabBar 开始）：
  L2TabBar（一级 tab：workflow 固定 + phase 动态 tab，close 复用 @taiji/ui
  L2TabBar）+ 内容分发。tab 关闭激活左侧相邻 tab，无左侧相邻回 workflow 固定 tab
  （panel-tabs.ts 纯逻辑）。D11③ 切换 run = overlay 容器按 runId 重挂载本面板
  （:key），tab 随挂载态消亡构造性达成；本组件对 props.run.runId 变化仍做防御性
  重置（容器未 keyed 时 tab 不串 run）。
  [2026-10-19] agent 钻取不再进面板 tab（原 agent 动态 tab + AgentTabContent 分支
  移除）：trace 行 / DAG 点击经 open-agent 上抛宿主，归宿 = 浮层右侧 AgentStreamDrawer。
-->
<div class="flex h-full min-h-0 min-w-0 flex-col" data-testid="wf-viz-live-panel">
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
      @open-agent="(call) => emit('openAgent', call)"
    />
    <PhaseTabContent
      v-else-if="activeTab.kind === 'phase'"
      :session-id="sessionId"
      :run="run"
      :phase="activeTab.phase ?? ''"
      @open-agent="(call) => emit('openAgent', call)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { Component } from 'vue'
import { L2TabBar } from '@taiji/ui/extension-host'
import type { L2TabItem } from '@taiji/ui/extension-host'
import WorkflowTabContent from './WorkflowTabContent.vue'
import PhaseTabContent from './PhaseTabContent.vue'
import {
  WORKFLOW_FIXED_TAB_KEY,
  closeLiveTab,
  openLiveTab,
  phaseTabKey,
} from './panel-tabs'
import type { WorkflowLiveTab } from './panel-tabs'
import { useWorkflowStore } from '@/stores/workflow'
import type { WorkflowAgentCall, WorkflowRunRecord } from '@taiji/shared'

const emit = defineEmits<{
  /** agent 钻取上抛（trace 行 / phase 子页行点击；宿主接 AgentStreamDrawer.openAgent）。 */
  openAgent: [call: WorkflowAgentCall]
}>()

const props = defineProps<{
  /** 主 session id（事件流拉取与 agentcall 编排的归属 session）。 */
  sessionId: string
  /** 当前 run 投影（overlay 容器从 workflowStore.recordsOf 分区选中后传入）。 */
  run: WorkflowRunRecord
  /** u4 Gantt 展示组件（overlay 容器装配时注入；缺省 = 分段统计降级形态）。 */
  ganttComponent?: Component
}>()

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

defineExpose({ openPhaseTab })
</script>
