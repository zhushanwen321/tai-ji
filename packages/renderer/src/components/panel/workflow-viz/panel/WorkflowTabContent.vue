<template>
  <!--
    WorkflowTabContent —— workflow 固定 tab 的内容区（设计 §3.1-2：三子页 = 实例 trace
    （主干）+ 事件流（截断态 + 错误二分）+ Gantt 时间线；子页切换 = 分段按钮组）。Gantt
    子页消费 gantt-segments 派生结果，展示组件由 u4 overlay 容器经 props 注入（面板不反向
    import u4——分界 = WorkflowGanttSegments 视图模型契约）；未注入时渲染分段统计降级形态。
  -->
  <div class="flex min-h-0 min-w-0 flex-1 flex-col">
    <!-- 子页切换器 -->
    <div class="flex shrink-0 gap-1 border-b border-hairline px-2 py-1.5" data-testid="wf-viz-subpage-switch">
      <Button
        v-for="page of SUBPAGES"
        :key="page"
        variant="ghost"
        size="sm"
        :data-testid="`wf-viz-subpage-${page}`"
        :data-active="subpage === page ? 'true' : 'false'"
        class="h-6 rounded-sm px-2 text-[length:var(--text-3xs)]"
        :class="subpage === page ? 'bg-bg-elevated text-neutral-fg' : 'text-neutral-dim hover:text-neutral-fg'"
        @click="subpage = page"
      >
        {{ subpageLabel(page) }}
      </Button>
    </div>

    <!-- 实例 trace 子页 -->
    <RunTraceTable
      v-if="subpage === 'trace'"
      :calls="run.agentCalls"
      :run-status="run.status"
      :run-outcome="run.outcome"
      data-testid="wf-viz-subpage-trace-panel"
      @open-agent="(call) => emit('openAgent', call)"
    />

    <!-- 事件流子页（与 Gantt 子页共享同一份拉取/缓存分区） -->
    <RunEventStream
      v-else-if="subpage === 'events'"
      :session-id="sessionId"
      :run-id="run.runId"
      data-testid="wf-viz-subpage-events-panel"
    />

    <!-- Gantt 时间线子页：分段派生（事件流拉取结果 → 纯函数）→ u4 展示组件注入 -->
    <div v-else class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-testid="wf-viz-subpage-gantt-panel">
      <component
        :is="ganttComponent"
        v-if="ganttComponent !== undefined"
        :segments="segments"
        :run="run"
      />
      <div v-else class="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
        <p class="text-[length:var(--text-2xs)] text-neutral-dim">{{ t('panel.workflowViz.ganttUnavailable') }}</p>
        <!-- 分段统计降级形态（派生结果可见性保留——事件流失败时 attemptSegments 为空即
             「不分段降级」口径的数据面：agentCalls/phase 色带经 getWorkflows 仍可得） -->
        <dl class="mt-2 flex flex-col gap-1 font-mono text-[length:var(--text-3xs)] text-neutral-mid" data-testid="wf-viz-gantt-segments-summary">
          <div class="flex gap-2">
            <dt>{{ t('panel.workflowViz.ganttAttemptSegments') }}</dt>
            <dd>{{ segments.attemptSegments.length }}</dd>
          </div>
          <div class="flex gap-2">
            <dt>{{ t('panel.workflowViz.ganttPhaseBands') }}</dt>
            <dd>{{ drawnPhaseBands.length }}</dd>
          </div>
          <div class="flex gap-2">
            <dt>{{ t('panel.workflowViz.ganttPhaseTurns') }}</dt>
            <dd>{{ phaseTurnSummary }}</dd>
          </div>
        </dl>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Component } from 'vue'
import { Button } from '@taiji/ui'
import RunTraceTable from './RunTraceTable.vue'
import RunEventStream from './RunEventStream.vue'
import { deriveWorkflowGanttSegments } from '../gantt-segments'
import { useWorkflowStore } from '@/stores/workflow'
import type { WorkflowRunRecord } from '@taiji/shared'

/** 子页词表（切换器顺序 = 设计 §3.1-2 列举顺序：trace 主干在前）。 */
const SUBPAGES = ['trace', 'events', 'gantt'] as const
type Subpage = (typeof SUBPAGES)[number]

const props = defineProps<{
  sessionId: string
  run: WorkflowRunRecord
  /**
   * u4 Gantt 展示组件（overlay 容器装配时注入；props 契约 = { segments: WorkflowGanttSegments,
   * run: WorkflowRunRecord }）。面板不反向 import u4——分界 = u2 冻结的分段视图模型。
   */
  ganttComponent?: Component
}>()

const emit = defineEmits<{
  openAgent: [call: WorkflowRunRecord['agentCalls'][number]]
}>()

const { t } = useI18n()
const store = useWorkflowStore()

const subpage = ref<Subpage>('trace')

/** 子页文案（字面全路径引用——locale-key-usage-guard 消费者扫描以字面为准，禁模板拼接）。 */
function subpageLabel(page: Subpage): string {
  switch (page) {
    case 'trace': return t('panel.workflowViz.subpage_trace')
    case 'events': return t('panel.workflowViz.subpage_events')
    case 'gantt': return t('panel.workflowViz.subpage_gantt')
    default: {
      const exhaustive: never = page
      throw new Error(`unreachable subpage: ${String(exhaustive)}`)
    }
  }
}

/** 事件流缓存读（与事件流子页共享同一份拉取；未拉取/失败时段派生输入为空——不分段降级）。 */
const events = computed(() => store.runEventsOf(props.run.runId)?.events)

const segments = computed(() => deriveWorkflowGanttSegments(events.value ?? []))

/** 绘制面段数（重放空段不计——消费方按 emptyReplay 判定结果决定绘制的口径在本统计对齐）。 */
const drawnPhaseBands = computed(() => segments.value.phaseBands.filter((b) => !b.emptyReplay))

/** 头卡轮次汇总（每 phase 非空段段数；纯脚本 phase 段数即轮数）。 */
const phaseTurnSummary = computed(() =>
  segments.value.phaseCards.map((c) => `${c.phase}:${c.turnCount}`).join('  '),
)
</script>
