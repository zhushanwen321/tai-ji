<!--
  WorkflowVizOverlayHost —— overlay 容器装配（workflow-visualization U6）。

  结构：Guard（D10 装载失败回落边界，u4 产出）包壳（u4 WorkflowVizOverlay）包实况面板
  （u5 WorkflowLivePanel，slot 填充位）。本组件是 u4 壳注释中「挂载方」与 u5 面板注释中
  「overlay 容器」的落点：

  - 数据源：开合/当前内容读 core/domain/overlay（SSOT，u-w1-core 迁移——workflow-viz-overlay
    的 overlayOpen/overlayCurrent 已退役）；DAG 解析态（overlayDag/overlayDagError）与
    一级 tab 展示态（overlayTab，scheduler 整合 2026-10-06）留
    renderer 控制器 workflow-viz-overlay.ts；本容器壳承载 workflow 与 scheduler 两类内容
    （browser 由 BrowserOverlay 承载，三壳互斥）；scheduler 内容下 run 相关 props 按无 run
    形态透传（run/dag/dagError = null，「运行」tab 由壳按 run 缺省禁用）；run
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
    仅在 workflow 内容 open 态运行（内容切走/关闭即停，[U4] kind 门控）；D2 单 header
    终态（workflow-overlay-refine）：面板无 header 行，已用时长由壳 header 单点呈现
    （派生单源 deriveWorkflowRunElapsedMs 不变，双 header 形态已废止）。
-->
<template>
  <WorkflowVizOverlayGuard :key="guardEpoch" @fallback="onFallback">
    <WorkflowVizOverlay
      :open="isOverlayShellOpen"
      :run="runRecord"
      :dag="overlayDag"
      :dag-error="overlayDagError"
      :tab="overlayTab"
      :scheduler-session-id="overlaySessionId"
      :node-states="nodeStates"
      :active-phase="activePhase"
      :elapsed-ms="elapsedMs"
      :unmatched="unmatchedInstances"
      @close="closeWorkflowVizOverlay"
      @select="onSelect"
      @retry-dag="retryDagParse"
      @update:tab="setOverlayTab"
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
  <!-- 浮层浏览器内容（display-containers §7.4，u-w2-browser-mount）：单例换内容——
       当前内容是 browser 时由 BrowserOverlay 的 OverlayShell 承载（workflow 壳同期门控
       只在 workflow 内容时开，两壳互斥不叠显）。Guard 只包 workflow 内容（回落语义
       归属 workflow），browser 内容不进回落链。 -->
  <BrowserOverlay />
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import type { WorkflowRunRecord } from '@taiji/shared'
import { openDrawerTab, openWorkflowInDrawer } from '@taiji/core/domain/drawer'
import WorkflowVizOverlay from './WorkflowVizOverlay.vue'
import WorkflowVizOverlayGuard from './WorkflowVizOverlayGuard.vue'
import BrowserOverlay from '@/components/panel/BrowserOverlay.vue'
import WorkflowLivePanel from '../panel/WorkflowLivePanel.vue'
import WorkflowVizGantt from '../gantt/WorkflowVizGantt.vue'
import { matchInstancesToNodes } from '../blueprint-match'
import type { WorkflowInstanceMatchResult } from '../blueprint-match'
import { deriveNodeStatus } from '../gantt-segments'
import type { WorkflowVizDagNodeStatus } from '../dag/types'
import type { WorkflowVizDagClickPayload } from '../dag/types'
import { useOverlayControl } from '@taiji/core/domain/overlay'
import {
  closeWorkflowVizOverlay,
  overlayDag,
  overlayDagError,
  overlayTab,
  retryDagParse,
  setOverlayTab,
} from './workflow-viz-overlay'
import { useWorkflowStore, deriveWorkflowRunElapsedMs } from '@/stores/workflow'

const panelRef = ref<InstanceType<typeof WorkflowLivePanel> | null>(null)

// overlay 开合态读 core SSOT（u-w1-core 迁移：workflow-viz-overlay 的 overlayOpen/overlayCurrent
// 模块级 ref 已退役，开合态唯一权威 = core/domain/overlay）。
const { isOpen: overlayOpen, current: overlayContent } = useOverlayControl()

/** workflow 内容开合（单例换内容门控，u-w2-browser-mount）：browser 内容由 BrowserOverlay 的
 *  壳承载，workflow/scheduler 两类内容由本组件壳承载（scheduler 整合 2026-10-06），三壳互斥不叠显。 */
const isWorkflowOpen = computed(() => overlayOpen.value && overlayContent.value?.kind === 'workflow')

/** scheduler 内容开合（定时任务 tab 直达）：本组件壳同时承载 workflow 与 scheduler 两类内容。 */
const isSchedulerOpen = computed(() => overlayOpen.value && overlayContent.value?.kind === 'scheduler')

/** 壳开合（本组件承载的两类内容任一在场即开——Guard/scheduler tab 数据链共用该门控）。 */
const isOverlayShellOpen = computed(() => isWorkflowOpen.value || isSchedulerOpen.value)

/** 当前内容所属会话（两类载荷都持 sessionId；scheduler tab 的 ViewHost per-session 分区键）。 */
const overlaySessionId = computed(() => {
  const cur = overlayContent.value
  return cur !== null ? cur.payload.sessionId : ''
})

/** 当前 workflow run 投影（core OverlayContent → Host 的 run 选择形状；非 workflow 内容 = null）。 */
const overlayRun = computed<{ sessionId: string; runId: string } | null>(() => {
  const cur = overlayContent.value
  return cur !== null && cur.kind === 'workflow' ? cur.payload : null
})

/** Guard 重挂代际（fallback 后递增；下次 open 重挂全新 Guard 实例复位 failed——D10 每次点击均重试）。 */
const guardEpoch = ref(0)

// 本组件承载的内容（workflow / scheduler）开时递增（immediate 首挂同样建立递增基线，
// 保证 :key 稳定存在）。[U4 修复] 门控用 isOverlayShellOpen（本组件两类内容的 kind 判定）
// 而非裸 overlayOpen：开合态 SSOT 迁 core 后 isOpen kind 无关（browser 浮层开着时也是
// true），裸值会让 Guard 随 browser 开合无谓重挂、且错过「workflow → browser 换出再换回
// （isOpen 全程 true）」的重入重挂——fresh Guard 复位 failed 的语义对本组件两类内容都有
// 意义（D10 每次点击均重试；workflow fallback 后经 scheduler 直达打开同样需要 fresh Guard）。
watch(isOverlayShellOpen, (open) => {
  if (open) guardEpoch.value++
}, { immediate: true })

/** 当前 run 投影（workflowStore 分区按 runId 选中；信号触发的重拉经 store 响应式到达）。 */
const runRecord = computed<WorkflowRunRecord | null>(() => {
  const cur = overlayRun.value
  if (cur === null) return null
  const records = useWorkflowStore().recordsOf(cur.sessionId).value
  return records.find((w) => w.runId === cur.runId) ?? null
})

/** 面板输入（session + run 同时就绪才挂面板；run 记录被清理/分区清空时面板随之卸载）。 */
const panelInput = computed<{ sessionId: string; runId: string; run: WorkflowRunRecord } | null>(() => {
  const cur = overlayRun.value
  const run = runRecord.value
  return cur !== null && run !== null ? { sessionId: cur.sessionId, runId: cur.runId, run } : null
})

// ── 派生输入（容器单处派生，壳/面板均消费已派生 props）────────────────────────

/** D2 匹配单源（byNode + 未匹配列表一次派生；节点六态 / 未匹配分组 / 点击钻取共用，
 *  避免三处各自调 matchInstancesToNodes 重复计算）。 */
const matchResult = computed<WorkflowInstanceMatchResult | null>(() => {
  const dag = overlayDag.value
  const run = runRecord.value
  if (dag === null || run === null) return null
  return matchInstancesToNodes(dag, run.agentCalls)
})

/** 节点六态映射（D2 蓝图-实例匹配 → D9 节点级派生；DAG 未就绪时 undefined = 画布解析中）。 */
const nodeStates = computed<Record<string, WorkflowVizDagNodeStatus> | undefined>(() => {
  const dag = overlayDag.value
  const run = runRecord.value
  const result = matchResult.value
  if (dag === null || run === null || result === null) return undefined
  const out: Record<string, WorkflowVizDagNodeStatus> = {}
  for (const node of dag.nodes) {
    out[node.id] = deriveNodeStatus({ runStatus: run.status, calls: result.byNode.get(node.id) ?? [] })
  }
  return out
})

/** 未匹配实例（D2⑥：零命中/歧义不静默丢弃——透传壳渲染画布下方的 phase 分组）。 */
const unmatchedInstances = computed(() => matchResult.value?.unmatched ?? [])

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

// 已用时长 tick（仅 workflow 内容 open 态运行——scheduler 内容无 run 数据无需时长；
// 内容切走（browser 换入 / scheduler 换入）或关闭即停，不留常驻定时器。[U4 修复] kind
// 门控同 guardEpoch watch——isOpen 本身 kind 无关）
const OPEN_TICK_INTERVAL_MS = 1000
const now = ref(Date.now())
let openTickTimer: ReturnType<typeof setInterval> | null = null
watch(isWorkflowOpen, (open) => {
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

/** 已用时长 ms（D9 停走口径单点 = workflowStore 的 deriveWorkflowRunElapsedMs——与面板 header 共用同一派生）。 */
const elapsedMs = computed<number | undefined>(() => {
  const run = runRecord.value
  if (run === null) return undefined
  return deriveWorkflowRunElapsedMs(run, now.value) ?? undefined
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
  const call = matchResult.value?.byNode.get(payload.nodeId)?.[0]
  if (call !== undefined) panelRef.value?.openAgentTab(call)
}

/** D10 回落动作序列（无失败标记/计数分支）：关 overlay → drawer workflow tab + 注入选中态。 */
function onFallback(): void {
  const runId = overlayRun.value?.runId ?? ''
  closeWorkflowVizOverlay()
  openDrawerTab('workflow')
  openWorkflowInDrawer(runId)
}
</script>
