<!--
  WorkflowVizGantt —— Gantt 时间线纯展示组件（workflow-visualization §3.1-2 / U4）。

  输入 = u2 冻结的分段视图模型 WorkflowGanttSegments（call 级 attempt 分段 + phase
  级色带段 + phase 头卡），全部由上层派生（分段派生单处 = u5 gantt-segments.ts）并
  注入——本组件不做分段派生、不做数据获取（D4 拉模式语义在面板层）。

  渲染要素（设计 §3.1-2 增量项「Gantt 时间线子页」裁决形态）：
  - call 横条按 attempt 分段：失败 attempt 红段 → 退避空档琥珀段（同代际相邻段
    间隙，gantt-view 推导）→ 新 attempt 段；跨代际段不相连（中断/崩溃空隙可见）；
  - phase 色带段（全高背景带，重放空段 emptyReplay 不绘制、不计轮次）；纯脚本
    phase（phaseCards.scriptOnly）按斜纹绘制；
  - 运行中当前时刻游标（nowMs 驱动，上层节流传入）；run 停止（runStatus 非
    running）时游标冻结于最后事件 ts、未收束段不显示运行脉冲、着色随终局形态
    （D9 停止维度：failed/time_limited → 失败色系，interrupted/cancelled → 中性暗）。

  本组件零时钟：不内置 interval（WorkflowTab 1s tick 同款手法归上层），nowMs 由
  props 注入保证纯展示可测。
-->
<template>
  <div class="relative min-h-0 px-4 pb-4 pt-3" data-testid="wfvz-gantt-root">
    <!-- 空态：分段全空（事件流缺行 / started 行缺失降级不分段形态零产出） -->
    <p
      v-if="!domain"
      class="py-8 text-center text-[length:var(--text-xs)] text-neutral-dim"
      data-testid="wfvz-gantt-empty"
    >
      {{ t('panel.workflowViz.ganttEmpty') }}
    </p>

    <template v-else>
      <!-- phase 色带层 + call 行（同一坐标系：时间 → left/width 百分比） -->
      <div class="relative border-b border-hairline" :style="{ height: bodyHeight }" data-testid="wfvz-gantt-body">
        <!-- phase 色带（重放空段不绘制；scriptOnly 斜纹）。
             背景/左边框色互斥条件给出（非基类+覆盖）：background 简写与渐变
             bg-[image:*] 是不同属性会叠加，border 同名工具类胜负取决发射序 -->
        <div
          v-for="(band, i) in drawnBands"
          :key="`band-${band.phase}-${i}`"
          class="absolute inset-y-0 min-w-[2px] border-l"
          :class="[
            isScriptOnly(band.phase)
              ? 'bg-[image:repeating-linear-gradient(135deg,var(--surface-hover)_0_4px,transparent_4px_8px)]'
              : 'bg-accent-soft',
            band.state === 'running' ? 'border-l-accent' : 'border-l-neutral-faint',
          ]"
          :style="{ left: `${pct(band.startTs)}%`, width: `${bandWidth(band)}%` }"
          :data-testid="`wfvz-gantt-band-${band.phase}`"
          :data-script-only="isScriptOnly(band.phase) ? 'true' : undefined"
          :data-state="band.state"
        >
          <span
            class="absolute top-0.5 left-1 max-w-full overflow-hidden text-[10px] whitespace-nowrap text-neutral-faint"
          >{{ band.phase }}</span>
        </div>

        <!-- call 行（taskIndex 一行，多代际段同行不相连） -->
        <div
          v-for="row in rows"
          :key="row.taskIndex"
          class="relative flex h-[26px] items-center"
          :data-testid="`wfvz-gantt-row-${row.taskIndex}`"
        >
          <span
            class="absolute left-0 w-[150px] truncate pr-2 text-right font-mono text-[length:var(--text-3xs)] text-neutral-mid"
            :title="rowTitle(row.taskIndex)"
          >{{ rowTitle(row.taskIndex) }}</span>
          <!-- attempt 分段横条 -->
          <span
            v-for="seg in row.segments"
            :key="`${seg.generation}-${seg.attempt}`"
            class="absolute top-[7px] h-3 min-w-[3px] rounded-[3px]"
            :class="segClass(seg)"
            :style="{ left: `${pct(seg.startTs)}%`, width: `${spanWidth(seg.startTs, seg.endTs)}%` }"
            data-testid="wfvz-gantt-seg"
            :data-task-index="seg.taskIndex"
            :data-generation="seg.generation"
            :data-attempt="seg.attempt"
            :data-state="seg.state"
            :data-stopped="segStopped ? 'true' : undefined"
            :title="segTitle(seg)"
          />
          <!-- 退避琥珀段（同代际相邻 attempt 间隙 = backoffMs） -->
          <span
            v-for="gap in row.backoffGaps"
            :key="`backoff-${gap.generation}-${gap.startTs}`"
            class="absolute top-2.5 h-1.5 min-w-[2px] rounded-[3px] bg-warn opacity-75"
            :style="{ left: `${pct(gap.startTs)}%`, width: `${spanWidth(gap.startTs, gap.endTs)}%` }"
            data-testid="wfvz-gantt-backoff"
            :data-task-index="row.taskIndex"
            :data-generation="gap.generation"
            :title="t('panel.workflowViz.ganttBackoffTitle', { ms: gap.endTs - gap.startTs })"
          />
        </div>

        <!-- 当前时刻游标（运行中实时 / run 停止冻结于最后事件 ts，D9） -->
        <span
          v-if="cursorPct !== null"
          class="absolute inset-y-0 z-[3] w-[1.5px] bg-neutral-fg"
          :class="cursorFrozen ? 'opacity-40' : 'opacity-70'"
          :style="{ left: `${cursorPct}%` }"
          data-testid="wfvz-gantt-cursor"
          :data-frozen="cursorFrozen ? 'true' : undefined"
        />
      </div>

      <!-- 时间轴（域起点相对刻度，mm:ss） -->
      <div class="relative ml-[150px] h-5 border-t border-hairline" data-testid="wfvz-gantt-axis">
        <span
          v-for="tick in ticks"
          :key="tick.pct"
          class="absolute top-0 -translate-x-1/2 pt-[3px] font-mono text-[10px] text-neutral-faint"
          :style="{ left: `${tick.pct}%` }"
          data-testid="wfvz-gantt-tick"
        >{{ tick.label }}</span>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { WorkflowGanttAttemptSegment, WorkflowGanttPhaseBand, WorkflowGanttSegments, WorkflowRunOutcome, WorkflowRunStatus } from '@taiji/shared'
import { formatClockDuration } from '@/lib/duration-format'
import { buildGanttRows, computeGanttDomain, toPercent, type GanttDomain } from './gantt-view'

const props = defineProps<{
  /** 分段视图模型（u2 冻结类型；派生在 u5，上层注入）。 */
  segments: WorkflowGanttSegments
  /** run 级状态（游标冻结与未收束段停止着色的输入；缺省按运行中语义）。 */
  runStatus?: WorkflowRunStatus
  /** run 终局形态（停止着色：failed/time_limited → 失败色系，其余 → 中性暗）。 */
  runOutcome?: WorkflowRunOutcome
  /** 当前时刻（epoch ms，运行中游标位置；上层节流传入，本组件零时钟）。 */
  nowMs?: number
  /** call 行标签（taskIndex → agent 名）；缺省显示 `#taskIndex`。 */
  callLabels?: Record<number, string>
}>()

const { t } = useI18n()

/** 行高几何（px，行区高度 = 行数 × 行高；标签列宽对齐原型 148px 档，模板 w-[150px]）。 */
const ROW_H = 26
const TICK_COUNT = 4
/** 百分比基数（与 gantt-view 的 toPercent 同基数）。 */
const PCT_BASE = 100

const domain = computed<GanttDomain | null>(() => {
  const frozen = cursorTs.value
  return computeGanttDomain(props.segments, frozen ?? undefined)
})

// ── 游标（D9：run 停止冻结于最后事件 ts；运行中 = nowMs） ──

const runStopped = computed(() => props.runStatus !== undefined && props.runStatus !== 'running')

/** 冻结锚 = 全部分段与色带的最后事件 ts（停止时游标位置）。 */
const lastEventTs = computed(() => {
  let max = Number.NEGATIVE_INFINITY
  for (const seg of props.segments.attemptSegments) max = Math.max(max, seg.endTs)
  for (const band of props.segments.phaseBands) max = Math.max(max, band.endTs)
  return Number.isFinite(max) ? max : null
})

const cursorFrozen = computed(() => runStopped.value && lastEventTs.value !== null)
const cursorTs = computed<number | null>(() => {
  if (runStopped.value) return lastEventTs.value
  return props.nowMs ?? null
})
const cursorPct = computed(() => {
  if (cursorTs.value === null || !domain.value) return null
  return toPercent(cursorTs.value, domain.value)
})

/** run 停止时未收束段（state='running'）不显示运行脉冲、着色随终局形态。 */
const segStopped = computed(() => runStopped.value)

// ── phase 色带（重放空段不绘制——emptyReplay 判定已由派生层算好） ──

const drawnBands = computed(() => props.segments.phaseBands.filter((b) => !b.emptyReplay))

/** 纯脚本 phase（全历史零 agent 事件）→ 斜纹。权威判定 = phaseCards.scriptOnly
    （u2 冻结模型的派生单处字段）；该 phase 无头卡行时不斜纹（保守，不猜）。 */
const scriptOnlyPhases = computed(() => {
  const set = new Set<string>()
  for (const card of props.segments.phaseCards) {
    if (card.scriptOnly) set.add(card.phase)
  }
  return set
})

function isScriptOnly(phase: string): boolean {
  return scriptOnlyPhases.value.has(phase)
}

// ── call 行分组与退避间隙（gantt-view 纯函数） ──

const rows = computed(() => buildGanttRows(props.segments.attemptSegments))

/** 行区底部呼吸空隙（px）与空数据时的最小带高（px）。 */
const BODY_PAD_Y = 8
const BODY_MIN_HEIGHT = 60
/** 段/带最小可见宽（域占比 %——极短段不至于不可见）。 */
const MIN_SPAN_PCT = 0.3

const bodyHeight = computed(() => {
  return `${Math.max(BODY_MIN_HEIGHT, rows.value.length * ROW_H + BODY_PAD_Y)}px`
})

// ── 几何映射 ──

function pct(ts: number): number {
  return toPercent(ts, domain.value as GanttDomain)
}
function spanWidth(startTs: number, endTs: number): number {
  return Math.max(MIN_SPAN_PCT, pct(endTs) - pct(startTs))
}
function bandWidth(band: WorkflowGanttPhaseBand): number {
  return Math.max(MIN_SPAN_PCT, pct(band.endTs) - pct(band.startTs))
}

// ── 形态类与文案 ──

/**
 * 段状态 → Tailwind 着色类（keyframes wfvz-gantt-pulse 定义在 style.css 全局层——
 * scoped 内定义会被编译器改名为哈希名，模板类引用会失效）。
 */
function segClass(seg: WorkflowGanttAttemptSegment): string {
  if (seg.state === 'running' && segStopped.value) {
    // D9 停止着色：failed/time_limited → 失败色系；interrupted/cancelled/数据缺口 → 中性暗
    return props.runOutcome === 'failed' || props.runOutcome === 'time_limited'
      ? 'bg-danger opacity-90'
      : 'bg-neutral-dim opacity-70'
  }
  switch (seg.state) {
    case 'running': return 'bg-accent animate-[wfvz-gantt-pulse_1.5s_ease-in-out_infinite]'
    case 'done': return 'bg-success opacity-85'
    case 'failed': return 'bg-danger opacity-90'
    case 'cancelled': return 'bg-neutral-dim opacity-70'
    default: return ''
  }
}

function segTitle(seg: WorkflowGanttAttemptSegment): string {
  return `#${seg.taskIndex} · ${t('panel.workflowViz.ganttAttempt', { n: seg.attempt })} · ${segStateLabel(seg.state)}`
}

/** 段收束态中文词（title 悬停文案；shared WorkflowGanttSegmentState 四值词表的展示映射）。 */
function segStateLabel(state: WorkflowGanttAttemptSegment['state']): string {
  switch (state) {
    case 'running': return t('panel.workflowViz.ganttStateRunning')
    case 'done': return t('panel.workflowViz.ganttStateDone')
    case 'failed': return t('panel.workflowViz.ganttStateFailed')
    case 'cancelled': return t('panel.workflowViz.ganttStateCancelled')
    default: return state
  }
}

function rowTitle(taskIndex: number): string {
  return props.callLabels?.[taskIndex] ?? `#${taskIndex}`
}

// ── 时间轴刻度（域内均分，相对域起点的 mm:ss） ──

const ticks = computed(() => {
  const d = domain.value
  if (!d) return []
  const span = d.endTs - d.startTs
  return Array.from({ length: TICK_COUNT + 1 }, (_, i) => {
    const ts = d.startTs + (span * i) / TICK_COUNT
    // 刻度位置 = 域内均分的百分比（i/TICK_COUNT × 100），非毫秒直映射
    return { pct: (i * PCT_BASE) / TICK_COUNT, label: formatClockDuration(Math.max(0, ts - d.startTs), { padHours: false }) }
  })
})
</script>

