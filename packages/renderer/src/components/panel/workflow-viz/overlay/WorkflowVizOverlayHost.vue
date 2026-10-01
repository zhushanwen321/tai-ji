<!--
  WorkflowVizOverlayHost —— overlay 容器装配（workflow-visualization U6）。

  结构：Guard（D10 装载失败回落边界，u4 产出）包壳（u4 WorkflowVizOverlay）包实况面板
  （u5 WorkflowLivePanel，slot 填充位）。本组件是 u4 壳注释中「挂载方」与 u5 面板注释中
  「overlay 容器」的落点：

  - 数据源：控制器（workflow-viz-overlay.ts，模块级单例）持开关/当前 run/DAG 态；run
    投影从 workflowStore 分区按 runId 选中（recordsOf 响应式读，workflowUpdate 信号触发
    的重新拉取经 store 自动到达）；节点六态/当前 phase/已用时长在本容器单处派生后经
    props 透传（壳与面板均为已派生输入，不自行判定）。
  - D10 回落动作序列：Guard emit fallback → 关 overlay（清瞬态）→ openDrawerTab('workflow')
    + openWorkflowInDrawer(runId)（显式 drawer 语义函数直调，不经改向后的 openWorkflow——
    重入 overlay 入口会成循环）。无失败标记/计数分支（每次点击入口均重试 overlay）。
  - 每次点击均重试的构造性保证：Guard 的 failed 置位后本实例不再渲染 slot——重开 overlay
    时经 :key="guardEpoch" 重挂全新 Guard 实例（failed 复位），叠加 overlay 关闭态壳
    v-if 不渲染，关闭态 DOM 零痕迹。
  - 已用时长（壳 header 槽，设计 §3.1-1）：D9 停走口径（terminal = completedAt、
    interrupted = health.lastProgressAt 缺省回 startedAt、running = 当前时刻），1s tick
    仅在 open 态运行（关闭即停）；面板 header 的同口径时长归面板自身（设计双 header 形态）。
-->
<template>
  <WorkflowVizOverlayGuard :key="guardEpoch" @fallback="onFallback">
    <WorkflowVizOverlay
      :open="overlayOpen"
      :run="runRecord"
      :dag="overlayDag"
      :dag-error="overlayDagError"
      :node-states="nodeStates"
      :active-phase="activePhase"
      :elapsed-ms="elapsedMs"
      @close="closeWorkflowVizOverlay"
      @select="onSelect"
      @retry-dag="retryDagParse"
    >
      <WorkflowLivePanel
        v-if="panelInput"
        ref="panelRef"
        :key="panelInput.runId"
        :session-id="panelInput.sessionId"
        :run="panelInput.run"
        :gantt-component="WorkflowVizGantt"
      />
    </WorkflowVizOverlay>
  </WorkflowVizOverlayGuard>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import type { WorkflowRunRecord } from '@taiji/shared'
import { openDrawerTab, openWorkflowInDrawer } from '@taiji/core/domain/drawer'
import WorkflowVizOverlay from './WorkflowVizOverlay.vue'
import WorkflowVizOverlayGuard from './WorkflowVizOverlayGuard.vue'
import WorkflowLivePanel from '../panel/WorkflowLivePanel.vue'
import WorkflowVizGantt from '../gantt/WorkflowVizGantt.vue'
import { matchInstancesToNodes } from '../blueprint-match'
import { deriveNodeStatus } from '../gantt-segments'
import type { WorkflowVizDagNodeStatus } from '../dag/types'
import type { WorkflowVizDagClickPayload } from '../dag/types'
import {
  closeWorkflowVizOverlay,
  overlayCurrent,
  overlayDag,
  overlayDagError,
  overlayOpen,
  retryDagParse,
} from './workflow-viz-overlay'
import { useWorkflowStore } from '@/stores/workflow'

const panelRef = ref<InstanceType<typeof WorkflowLivePanel> | null>(null)

/** Guard 重挂代际（fallback 后递增；下次 open 重挂全新 Guard 实例复位 failed——D10 每次点击均重试）。 */
const guardEpoch = ref(0)

// 开 overlay 时递增（immediate 首挂同样建立递增基线，保证 :key 稳定存在）
watch(overlayOpen, (open) => {
  if (open) guardEpoch.value++
}, { immediate: true })

/** 当前 run 投影（workflowStore 分区按 runId 选中；信号触发的重拉经 store 响应式到达）。 */
const runRecord = computed<WorkflowRunRecord | null>(() => {
  const cur = overlayCurrent.value
  if (cur === null) return null
  const records = useWorkflowStore().recordsOf(cur.sessionId).value
  return records.find((w) => w.runId === cur.runId) ?? null
})

/** 面板输入（session + run 同时就绪才挂面板；run 记录被清理/分区清空时面板随之卸载）。 */
const panelInput = computed<{ sessionId: string; runId: string; run: WorkflowRunRecord } | null>(() => {
  const cur = overlayCurrent.value
  const run = runRecord.value
  return cur !== null && run !== null ? { sessionId: cur.sessionId, runId: cur.runId, run } : null
})

// ── 派生输入（容器单处派生，壳/面板均消费已派生 props）────────────────────────

/** 节点六态映射（D2 蓝图-实例匹配 → D9 节点级派生；DAG 未就绪时 undefined = 画布解析中）。 */
const nodeStates = computed<Record<string, WorkflowVizDagNodeStatus> | undefined>(() => {
  const dag = overlayDag.value
  const run = runRecord.value
  if (dag === null || run === null) return undefined
  const { byNode } = matchInstancesToNodes(dag, run.agentCalls)
  const out: Record<string, WorkflowVizDagNodeStatus> = {}
  for (const node of dag.nodes) {
    out[node.id] = deriveNodeStatus({ runStatus: run.status, calls: byNode.get(node.id) ?? [] })
  }
  return out
})

/** 当前 phase 分区（运行中最后一个未收束 phase——phases 折叠单行快照，§3.1-2④ 口径）。 */
const activePhase = computed<string | null>(() => {
  const run = runRecord.value
  if (run === null || run.status !== 'running') return null
  const phases = run.phases ?? []
  for (let i = phases.length - 1; i >= 0; i--) {
    if (phases[i].settledAt === undefined) return phases[i].phase
  }
  return null
})

// 已用时长 tick（仅 open 态运行；关闭即停，不留常驻定时器）
const OPEN_TICK_INTERVAL_MS = 1000
const now = ref(Date.now())
let openTickTimer: ReturnType<typeof setInterval> | null = null
watch(overlayOpen, (open) => {
  if (open) {
    now.value = Date.now()
    openTickTimer = setInterval(() => { now.value = Date.now() }, OPEN_TICK_INTERVAL_MS)
  } else if (openTickTimer !== null) {
    clearInterval(openTickTimer)
    openTickTimer = null
  }
})
onUnmounted(() => {
  if (openTickTimer !== null) clearInterval(openTickTimer)
})

/** 已用时长 ms（D9 停走口径；与面板 elapsedText 同口径的 ms 形态，壳 header 槽消费）。 */
const elapsedMs = computed<number | undefined>(() => {
  const run = runRecord.value
  if (run === null) return undefined
  const start = Date.parse(run.startedAt)
  if (Number.isNaN(start)) return undefined
  let endMs: number
  if (run.status === 'running') {
    endMs = now.value
  } else if (run.completedAt !== undefined) {
    const parsed = Date.parse(run.completedAt)
    endMs = Number.isNaN(parsed) ? start : parsed
  } else {
    const lastProgress = run.health?.lastProgressAt
    endMs = lastProgress !== undefined && lastProgress >= start ? lastProgress : start
  }
  return Math.max(0, endMs - start)
})

// ── 事件接线 ─────────────────────────────────────────────────────────────────

/** DAG 点击：phase 语义开 phase tab；agent 语义开该节点首个挂接实例的钻取（多实例节点
 *  取列表首个；pending/无 sessionId 实例由 openAgentTab 内部守卫 no-op）。 */
function onSelect(payload: WorkflowVizDagClickPayload): void {
  if (payload.semantic === 'phase') {
    panelRef.value?.openPhaseTab(payload.phase)
    return
  }
  const dag = overlayDag.value
  const run = runRecord.value
  if (dag === null || run === null) return
  const call = matchInstancesToNodes(dag, run.agentCalls).byNode.get(payload.nodeId)?.[0]
  if (call !== undefined) panelRef.value?.openAgentTab(call)
}

/** D10 回落动作序列（无失败标记/计数分支）：关 overlay → drawer workflow tab + 注入选中态。 */
function onFallback(): void {
  const runId = overlayCurrent.value?.runId ?? ''
  closeWorkflowVizOverlay()
  openDrawerTab('workflow')
  openWorkflowInDrawer(runId)
}
</script>
