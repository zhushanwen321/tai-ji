<template>
  <!--
    PhaseTabContent —— phase 一级 tab 内容（设计 §3.1-2：头卡【phase 名 + 状态 + 起止 +
    轮次计数，规则③推导】+ phase 内 trace + 事件流过滤——仅本 phase 归属事件
    （phase-started/settled + 本 phase agent 事件），run 级事件与 worker-log 不进）。
    头卡数据 = gantt-segments 规则③派生（不经 phases 折叠——fold last-wins 快照多轮丢旧轮）。
  -->
  <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-testid="wf-viz-phase-tab">
    <!-- 头卡（规则③：跨轮聚合区间 + 轮次 = 非空段段数 + 状态 = 最新非空段收束态） -->
    <div class="shrink-0 border-b border-hairline px-3 py-2" data-testid="wf-viz-phase-card">
      <div class="flex items-center gap-2">
        <span class="size-1.5 shrink-0 rounded-full" :class="card?.state === 'running' ? 'bg-accent' : 'bg-success'" />
        <span class="min-w-0 truncate font-mono text-xs font-medium text-neutral-fg">{{ phase }}</span>
        <span
          v-if="card?.scriptOnly"
          class="shrink-0 rounded-sm border border-hairline border-dashed px-1 text-[length:var(--text-3xs)] text-neutral-dim"
          :title="t('panel.workflowViz.scriptOnlyHint')"
          data-testid="wf-viz-phase-script-only"
        >
          {{ t('panel.workflowViz.scriptOnly') }}
        </span>
        <span class="ml-auto shrink-0 font-mono text-[length:var(--text-3xs)] text-neutral-dim" data-testid="wf-viz-phase-card-state">
          {{ card?.state === 'running' ? t('panel.sideDrawer.workflowRunning') : t('panel.workflowViz.phaseSettled') }}
        </span>
      </div>
      <div class="mt-1 flex items-center gap-3 font-mono text-[length:var(--text-3xs)] text-neutral-dim">
        <span data-testid="wf-viz-phase-card-range">{{ rangeText }}</span>
        <span data-testid="wf-viz-phase-card-turns">{{ t('panel.workflowViz.turnCount', { count: card?.turnCount ?? 0 }) }}</span>
      </div>
    </div>

    <!-- phase 内 trace（本 phase 归属实例） -->
    <RunTraceTable
      :calls="phaseCalls"
      :run-status="run.status"
      :run-outcome="run.outcome"
      class="max-h-[40%] shrink-0"
      @open-agent="(call) => emit('openAgent', call)"
    />

    <!-- 事件流过滤区（仅本 phase 归属事件；失败/加载态收敛为简短提示——重试入口与重拉
         链在 workflow tab 事件流子页，同一份缓存重拉后本区响应式更新，不复制错误二分） -->
    <div class="flex min-h-0 flex-1 flex-col overflow-y-auto border-t border-hairline" data-testid="wf-viz-phase-events">
      <p class="shrink-0 px-3 py-1 text-[length:var(--text-3xs)] text-neutral-faint">{{ t('panel.workflowViz.phaseEventsTitle') }}</p>
      <div v-if="entry?.status !== 'ready'" class="px-3 pb-2 text-[length:var(--text-3xs)] text-neutral-dim" data-testid="wf-viz-phase-events-unavailable">
        {{ t('panel.workflowViz.phaseEventsUnavailable') }}
      </div>
      <div v-else-if="phaseEventRows.length === 0" class="px-3 pb-2 text-[length:var(--text-3xs)] text-neutral-dim">
        {{ t('panel.workflowViz.phaseEventsEmpty') }}
      </div>
      <template v-else>
        <div
          v-for="row of phaseEventRows"
          :key="row.key"
          class="border-b border-hairline px-3 py-1 text-[length:var(--text-2xs)] last:border-b-0"
        >
        <div class="flex items-center gap-2">
          <span class="shrink-0 font-mono text-[length:var(--text-3xs)] text-neutral-faint">{{ row.timeText }}</span>
          <span class="shrink-0 rounded-sm border border-hairline px-1 font-mono text-[length:var(--text-3xs)] text-neutral-mid">{{ row.type }}</span>
          <span class="min-w-0 flex-1 truncate font-mono text-neutral-mid">{{ row.summary }}</span>
        </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import RunTraceTable from './RunTraceTable.vue'
import { deriveWorkflowGanttSegments } from '../gantt-segments'
import { useWorkflowStore } from '@/stores/workflow'
import type { WorkflowRunEventEntry, WorkflowRunRecord } from '@taiji/shared'

const props = defineProps<{
  sessionId: string
  run: WorkflowRunRecord
  /** 归属 phase 名。 */
  phase: string
}>()

const emit = defineEmits<{
  openAgent: [call: WorkflowRunRecord['agentCalls'][number]]
}>()

const { t } = useI18n()
const store = useWorkflowStore()

const entry = computed(() => store.runEventsOf(props.run.runId))
const events = computed(() => entry.value?.events)

/** 规则③头卡派生（本 phase 行）。 */
const card = computed(() => deriveWorkflowGanttSegments(events.value ?? []).phaseCards.find((c) => c.phase === props.phase))

/** phase 内 trace = 本 phase 归属实例（WorkflowTab 同款 phase 分组判据）。 */
const phaseCalls = computed(() => props.run.agentCalls.filter((c) => c.phase === props.phase))

/** 事件流过滤：phase-started/settled（本 phase）+ 本 phase agent 事件；run 级与 worker-log 不进。 */
function isPhaseOwnedEvent(e: WorkflowRunEventEntry): boolean {
  if (e.type === 'phase-started' || e.type === 'phase-settled') return e.phase === props.phase
  // 协议载荷只有 agent-started 携带 phase 字段（retrying/settled 均无）——按 taskIndex
  // 归属到本 phase 的 call 反查（call.phase 是 trace 投影的归属快照）
  if (e.type === 'agent-started') return e.phase === props.phase
  if (e.type === 'agent-retrying' || e.type === 'agent-settled') {
    return phaseCalls.value.some((c) => c.id === e.taskIndex)
  }
  return false
}

interface PhaseEventRow {
  key: string
  type: string
  timeText: string
  summary: string
}

function timeTextOf(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
}

function summaryOf(e: WorkflowRunEventEntry): string {
  switch (e.type) {
    case 'phase-started':
    case 'phase-settled':
      return e.phase
    case 'agent-started':
      return `#${e.taskIndex} ${e.agentName}`
    case 'agent-retrying':
      return `#${e.taskIndex} ${e.reason}`
    case 'agent-settled':
      return `#${e.taskIndex} ${e.outcome}`
    default:
      return ''
  }
}

const phaseEventRows = computed<PhaseEventRow[]>(() =>
  (events.value ?? [])
    .filter(isPhaseOwnedEvent)
    .map((e, i) => ({
      key: `${e.seq ?? i}-${e.type}`,
      type: e.type,
      timeText: timeTextOf(e.ts),
      summary: summaryOf(e),
    })),
)

const rangeText = computed(() => {
  if (card.value === undefined) return '—'
  return `${timeTextOf(card.value.startTs)} → ${timeTextOf(card.value.endTs)}`
})
</script>
