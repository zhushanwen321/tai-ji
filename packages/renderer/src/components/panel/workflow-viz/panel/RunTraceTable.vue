<template>
  <!--
    RunTraceTable —— workflow 实况面板的实例 trace 表（设计 §3.1-2：agentCalls 表，列 =
    taskIndex/agentName/phase/attempt/状态/起止/耗时/token/结果；workflow tab 与 phase tab
    共用，D9 派生状态在本表消费——「DAG 与 trace 逐行一致」S2 构造性一致的数据面）。
    表格形态 = div 网格行列表（仓内表格先例；taste/no-native-html-elements 禁原生 table）。
    行点击上抛 openAgent（pending / sessionId 缺失行 no-op——对齐 WorkflowTab 现状行为）。
  -->
  <div class="min-w-0 flex-1 overflow-y-auto" data-testid="wf-viz-trace-table">
    <!-- 列头行 -->
    <div
      class="grid items-center gap-x-2 px-2 py-[5px] sticky top-0 z-10 border-b border-hairline bg-bg-elevated text-[length:var(--text-3xs)] text-neutral-dim"
      :style="traceGridStyle"
    >
      <span>#</span>
      <span>{{ t('panel.workflowViz.traceColAgent') }}</span>
      <span>{{ t('panel.workflowViz.traceColPhase') }}</span>
      <span>{{ t('panel.workflowViz.traceColAttempt') }}</span>
      <span>{{ t('panel.workflowViz.traceColStatus') }}</span>
      <span>{{ t('panel.workflowViz.traceColStarted') }}</span>
      <span class="text-right">{{ t('panel.workflowViz.traceColDuration') }}</span>
      <span class="text-right">{{ t('panel.workflowViz.traceColTokens') }}</span>
      <span>{{ t('panel.workflowViz.traceColResult') }}</span>
    </div>
    <!-- 空态 -->
    <div
      v-if="calls.length === 0"
      class="flex flex-col items-center gap-1 p-6 text-center"
      data-testid="wf-viz-trace-empty"
    >
      <p class="text-[length:var(--text-xs)] text-neutral-dim">{{ t('panel.workflowViz.traceEmpty') }}</p>
    </div>
    <!-- 数据行 -->
    <div
      v-for="row of rows"
      :key="row.call.id"
      class="grid items-center gap-x-2 px-2 py-[5px] cursor-pointer border-b border-hairline text-[length:var(--text-2xs)] transition-colors hover:bg-surface-hover"
      :style="traceGridStyle"
      :class="row.call.status === 'pending' ? 'opacity-40' : ''"
      :data-testid="`wf-viz-trace-row-${row.call.id}`"
      :title="row.call.status === 'pending' ? t('panel.sideDrawer.workflowPending') : undefined"
      @click="onRowClick(row.call)"
    >
      <span class="font-mono text-neutral-dim">{{ row.call.id }}</span>
      <span class="truncate font-mono font-medium text-neutral-fg" :title="row.call.agent">{{ row.call.agent }}</span>
      <span class="truncate font-mono text-neutral-dim" :title="row.call.phase">{{ row.call.phase ?? '—' }}</span>
      <!-- attempt 列 = 当前尝试序号（与 record 帧 attempt 载荷同名同义；attempts 为失败累计，+1 得当前序号，无重试 = 1） -->
      <span class="font-mono text-neutral-dim">{{ row.call.attempts === undefined ? 1 : row.call.attempts + 1 }}</span>
      <!-- 状态：D9 派生词（retrying = 重试窗口内可见，非仅事后；stoppedInFlight = run 已
           停止的在途行——叠加停止着色不显示蓝脉冲（spinner 静态不旋转，旋转动效本身是
           「还在跑」的视觉信号），着色随 run 终局 outcome） -->
      <span class="flex items-center gap-1" :data-testid="`wf-viz-trace-status-${row.call.id}`" :data-status="row.view.status">
        <Loader2
          v-if="row.isLiveRunning"
          class="size-[11px] shrink-0"
          :class="[row.stoppedColorClass, row.view.stoppedInFlight ? '' : 'animate-spin']"
        />
        <span v-else class="size-1.5 shrink-0 rounded-full" :class="row.dotClass" />
        <span class="font-mono" :class="row.stoppedColorClass">{{ statusLabel(row.view.status) }}</span>
      </span>
      <span class="truncate font-mono text-neutral-dim" :title="row.call.startedAt">{{ formatTime(row.call.startedAt) }}</span>
      <span class="text-right font-mono text-neutral-dim">{{ formatCallDuration(row.call) }}</span>
      <span class="text-right font-mono text-neutral-dim">{{ formatCallTokens(row.call) }}</span>
      <span class="truncate" :class="row.call.status === 'failed' ? 'text-danger' : 'text-neutral-faint'" :title="row.call.error">
        {{ row.call.error ?? '—' }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2 } from '@lucide/vue'
import { deriveCallView } from '../gantt-segments'
import type { WorkflowAgentCall, WorkflowRunStatus, WorkflowRunOutcome } from '@taiji/shared'
import { formatTokens } from '@/lib/token-format'
import { formatCompactDuration, MS_PER_SECOND } from '@/lib/duration-format'

const props = defineProps<{
  /** 实例列表（workflow tab = 全部 agentCalls；phase tab = 本 phase 归属实例）。 */
  calls: WorkflowAgentCall[]
  /** run 投影状态（D9 stoppedInFlight 与 retrying 派生的 run 级输入）。 */
  runStatus: WorkflowRunStatus
  /** run 终局形态（停止着色映射输入；可缺省 = 未终局/旧投影）。 */
  runOutcome?: WorkflowRunOutcome
}>()

const emit = defineEmits<{
  openAgent: [call: WorkflowAgentCall]
}>()

const { t } = useI18n()

/**
 * 网格列宽单源（列头行与数据行共用同一 grid 模板——两处漂移即错位）：
 * # / agent(弹性) / phase / attempt / 状态 / 起止 / 耗时 / token / 结果(弹性)。
 */
const TRACE_GRID_TEMPLATE =
  '2.5rem minmax(6rem,1.2fr) minmax(4rem,0.8fr) 3.5rem 5.5rem 4.5rem 4rem 4.5rem minmax(4rem,1fr)'

/** 列头/数据行共用的动态网格样式（列宽模板 Tailwind 无法表达，:style 内联注入） */
const traceGridStyle = { gridTemplateColumns: TRACE_GRID_TEMPLATE }

interface TraceRow {
  call: WorkflowAgentCall
  view: ReturnType<typeof deriveCallView>
  isLiveRunning: boolean
  dotClass: string
  stoppedColorClass: string
}

/**
 * 停止着色映射（D9 全枚举）：cancelled → 取消（中性）色；failed/time_limited → 失败色系；
 * interrupted（暂停态，无 outcome）→ 中性停止色。非停止在途 = accent 蓝脉冲（不叠加）。
 */
function stoppedColorOf(runStatus: WorkflowRunStatus, outcome: WorkflowRunOutcome | undefined): string {
  if (runStatus === 'interrupted') return 'text-neutral-mid'
  switch (outcome) {
    case 'cancelled':
      return 'text-neutral-mid'
    case 'failed':
    case 'time_limited':
      return 'text-danger'
    case 'done':
    case undefined:
      return 'text-neutral-mid'
    default: {
      const exhaustive: never = outcome
      throw new Error(`unreachable outcome: ${String(exhaustive)}`)
    }
  }
}

const rows = computed<TraceRow[]>(() =>
  props.calls.map((call) => {
    const view = deriveCallView(call, props.runStatus)
    const stoppedColor = view.stoppedInFlight ? stoppedColorOf(props.runStatus, props.runOutcome) : ''
    const isLiveRunning = view.status === 'running' || view.status === 'retrying'
    const dotClass =
      view.status === 'done' ? 'bg-success'
        : view.status === 'failed' ? 'bg-danger'
          : view.status === 'retrying' ? 'bg-accent'
            : view.status === 'running' ? 'bg-accent'
              : 'bg-neutral-dim opacity-40'
    return { call, view, isLiveRunning, dotClass, stoppedColorClass: stoppedColor }
  }),
)

/** 状态文案（D9 派生词表；停止叠加的语义说明由 title 承载——列宽有限不折行）。 */
function statusLabel(status: TraceRow['view']['status']): string {
  switch (status) {
    case 'pending': return t('panel.sideDrawer.workflowPending')
    case 'running': return t('panel.sideDrawer.workflowRunning')
    case 'retrying': return t('panel.workflowViz.statusRetrying')
    case 'done': return t('panel.workflowViz.statusDone')
    case 'failed': return t('panel.workflowViz.statusFailed')
    default: {
      const exhaustive: never = status
      throw new Error(`unreachable derived status: ${String(exhaustive)}`)
    }
  }
}

/** 起止列：startedAt ISO → HH:mm:ss（title 全文 ISO；完成时刻语义并入耗时列，不双列）。 */
function formatTime(iso: string | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleTimeString('zh-CN', { hour12: false })
}

/** 耗时列：durationMs；running call 无 duration → '—'（已执行时长槽归 header 面，不双轨）。 */
function formatCallDuration(call: WorkflowAgentCall): string {
  if (call.durationMs === undefined) return '—'
  return formatCompactDuration(Math.floor(call.durationMs / MS_PER_SECOND), { hours: false })
}

/** token 列 = input+output 单列总量（增量表裁决：分项数据进协议、展示单列）。 */
function formatCallTokens(call: WorkflowAgentCall): string {
  const total = (call.inputTokens ?? 0) + (call.outputTokens ?? 0)
  return total > 0 ? formatTokens(total, 'tokens') : '—'
}

/** 行点击 → openAgent；pending / sessionId 缺失行 no-op（对齐 WorkflowTab 现状行为）。 */
function onRowClick(call: WorkflowAgentCall): void {
  if (call.status === 'pending' || !call.sessionId) return
  emit('openAgent', call)
}
</script>

