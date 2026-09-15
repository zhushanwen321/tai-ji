<!--
  UsageDailyChart · 每日堆叠柱状图（手写 SVG）。
  hover tooltip 出三值（输入/缓存命中/输出），按 provider 堆叠。
-->
<template>
  <div class="relative">
    <div ref="wrapRef" class="chart-wrap">
      <svg
        :width="width"
        :height="svgH"
        class="block w-full"
        @mousemove="onMouseMove"
        @mouseleave="onMouseLeave"
      >
        <!-- Y 轴 gridline + label -->
        <template v-for="i in 4" :key="`g${i}`">
          <line
            :x1="padL"
            :x2="width - padR"
            :y1="yScale(i)"
            :y2="yScale(i)"
            :style="{ stroke: 'var(--hairline)' }"
            stroke-dasharray="2,3"
          />
          <text
            :x="padL - 8"
            :y="yScale(i) + 4"
            text-anchor="end"
            :style="{ fill: 'var(--neutral-dim)' }"
            font-size="10"
            font-family="var(--font-mono)"
          >
            {{ metric === 'cost' ? '$' + fmtCompact(yTicks[i]) : fmtCompact(yTicks[i]) }}
          </text>
        </template>

        <!-- 底部 border -->
        <line
          :x1="padL"
          :x2="width - padR"
          :y1="plotBottom"
          :y2="plotBottom"
          :style="{ stroke: 'var(--border)' }"
        />

        <!-- 月份标签 -->
        <text
          v-for="ml in monthLabels"
          :key="`m${ml.x}`"
          :x="ml.x"
          :y="plotBottom + 18"
          text-anchor="middle"
          :style="{ fill: 'var(--neutral-dim)' }"
          font-size="10"
          font-family="var(--font-mono)"
        >
          {{ ml.label }}
        </text>

        <!-- hover 列高亮 -->
        <rect
          v-if="hoverIdx >= 0"
          :x="colX(hoverIdx) - 2"
          :y="padT"
          :width="barW + 4"
          :height="plotH"
          class="hover-col"
          :style="{ fill: 'var(--hover-tint)' }"
        />

        <!-- 堆叠柱 -->
        <template v-for="(day, di) in perDay" :key="day.dateStr">
          <rect
            v-for="seg in stackedSegments(di)"
            :key="seg.pid"
            :x="colX(di)"
            :y="seg.y"
            :width="barW"
            :height="seg.h"
            :style="`fill:${seg.color}`"
            rx="1"
          />
        </template>

        <!-- 峰值日标注（n>=14 才显示） -->
        <template v-if="perDay.length >= MIN_DAYS_FOR_PEAK && peakDayIdx >= 0">
          <text
            :x="colX(peakDayIdx) + barW / 2"
            :y="padT - 4"
            text-anchor="middle"
            :style="{ fill: 'var(--neutral-dim)' }"
            font-size="10"
            font-family="var(--font-mono)"
          >
            {{ peakDayLabel }}
          </text>
          <polygon
            :points="peakTriangle"
            :style="{ fill: 'var(--neutral-dim)' }"
            opacity="0.6"
          />
        </template>
      </svg>

      <!-- tooltip（绝对定位） -->
      <div
        v-if="hoverIdx >= 0 && tipData"
        class="absolute pointer-events-none z-40 bg-[var(--surface)] border border-[var(--border-strong)] rounded-[var(--radius-sm)] shadow-[var(--shadow-2)] p-2.5 min-w-[180px] text-[12px] leading-[1.7]"
        :style="tipStyle"
      >
        <!-- 日期 -->
        <div class="font-mono text-[10px] text-[var(--neutral-dim)] mb-1">
          {{ tipData.dateLabel }}
        </div>
        <!-- 当日总量 -->
        <div class="flex justify-between gap-6 font-mono mb-1.5">
          <span class="text-[var(--neutral-fg)]">{{ metric === 'tokens' ? t('settings.usage.tokens') : t('settings.usage.cost') }}</span>
          <span class="text-[var(--neutral-fg)] font-medium">{{ tipData.total }}</span>
        </div>
        <!-- provider 行 -->
        <div
          v-for="row in tipData.rows"
          :key="row.pid"
          class="flex items-center gap-[7px] font-mono"
        >
          <span class="w-2 h-2 rounded-[2px] shrink-0" :style="`background:${row.color}`" />
          <span class="text-[var(--neutral-mid)] truncate max-w-[100px]">{{ row.pid }}</span>
          <span class="ml-auto text-[var(--neutral-fg)]">{{ row.value }}</span>
          <span class="text-[var(--neutral-dim)] w-[38px] text-right">{{ row.pct }}</span>
        </div>
        <!-- 分隔线 + 输入/缓存/输出 -->
        <div class="border-t border-[var(--hairline)] mt-1.5 pt-1.5">
          <div class="flex justify-between font-mono text-[var(--neutral-mid)]">
            <span>&uarr;{{ t('settings.usage.input') }}</span>
            <span>{{ tipData.input }}</span>
          </div>
          <div class="flex justify-between font-mono text-[var(--neutral-mid)]">
            <span>&larr;{{ t('settings.usage.cacheHit') }}</span>
            <span>{{ tipData.cacheRead }}</span>
          </div>
          <div class="flex justify-between font-mono text-[var(--neutral-mid)]">
            <span>&darr;{{ t('settings.usage.output') }}</span>
            <span>{{ tipData.output }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  type DayView,
  type AggMetrics,
  getProviderColor,
  metricValue,
  niceMax,
  fmtCompact,
  fmtUSD,
  fmtInt,
  fmtISO,
  fmtMMDD,
  fmtPct,
} from './aggregate'

const { t } = useI18n()

/* ── 周几标签（i18n 收口 D6：复用热力日历 heatWeek* keys，与 HeatCalendar 同款静态 key 列表） ── */
const weekdayLabels = computed(() => [
  t('settings.usage.heatWeekSun'), t('settings.usage.heatWeekMon'),
  t('settings.usage.heatWeekTue'), t('settings.usage.heatWeekWed'),
  t('settings.usage.heatWeekThu'), t('settings.usage.heatWeekFri'),
  t('settings.usage.heatWeekSat'),
])

function weekdayLabel(d: Date): string {
  return weekdayLabels.value[d.getDay()]
}

const props = defineProps<{
  perDay: DayView[]
  perProv: Record<string, AggMetrics>
  metric: 'tokens' | 'cost'
  /** pid -> CSS 变量映射（aggregate() 结果的 providerColors，取色随数据返回，无全局态） */
  providerColors: Record<string, string>
}>()

/* ── 布局常量 ── */
const svgH = 232
const padL = 48
const padR = 12
const padT = 26
const padB = 26
const plotH = svgH - padT - padB
const plotBottom = svgH - padB
const DEFAULT_CHART_WIDTH = 600

/* ── 柱宽 & 步进常量 ── */
const MIN_SLOT_WIDTH = 20
const MAX_BAR_WIDTH = 26
const MIN_BAR_WIDTH = 2
const BAR_WIDTH_RATIO = 0.72

/* ── Y 轴 ── */
const Y_TICK_COUNT = 4

/* ── 堆叠段 ── */
const MIN_BAR_HEIGHT = 0.5

/* ── tooltip 布局 ── */
const TIP_OFFSET_X = 14
const TIP_FLIP_RATIO = 0.6
const TIP_WIDTH_ESTIMATE = 200
const TIP_TOP_MARGIN = 8
const TIP_Y_SHIFT = 40

/* ── 容器宽度（ResizeObserver） ── */
const wrapRef = ref<HTMLElement | null>(null)
const width = ref(DEFAULT_CHART_WIDTH)
let ro: ResizeObserver | null = null

onMounted(() => {
  if (!wrapRef.value) return
  width.value = wrapRef.value.clientWidth
  ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      width.value = e.contentRect.width
    }
  })
  ro.observe(wrapRef.value)
})

onBeforeUnmount(() => {
  ro?.disconnect()
})

/* ── 柱宽 & 步进 ── */
const plotW = computed(() => width.value - padL - padR)
const slot = computed(() => (props.perDay.length > 0 ? plotW.value / props.perDay.length : MIN_SLOT_WIDTH))
const barW = computed(() => Math.min(MAX_BAR_WIDTH, Math.max(MIN_BAR_WIDTH, Math.floor(slot.value * BAR_WIDTH_RATIO))))

function colX(i: number): number {
  // eslint-disable-next-line no-magic-numbers -- 柱居中：偏移半个柱宽
  return padL + slot.value * i + (slot.value - barW.value) / 2
}

/* ── Y 轴 ── */
const maxVal = computed(() => {
  let m = 0
  for (const day of props.perDay) {
    const v = metricValue(day.dTot, props.metric)
    if (v > m) m = v
  }
  return niceMax(m)
})

const yTicks = computed(() => {
  const step = maxVal.value / Y_TICK_COUNT
  return Array.from({ length: Y_TICK_COUNT + 1 }, (_, i) => step * i)
})

function yScale(i: number): number {
  return plotBottom - (yTicks.value[i] / maxVal.value) * plotH
}

/* ── 堆叠段 ── */
interface StackedSeg {
  pid: string
  color: string
  y: number
  h: number
}

/** 按当前 metric 值降序排当日 provider（堆叠段与 tooltip 共用，保证视觉顺序一致） */
function sortedDayProvs(day: DayView): { pid: string; val: number }[] {
  return Object.keys(day.provs)
    .map((pid) => ({ pid, val: metricValue(day.provs[pid], props.metric) }))
    .sort((a, b) => b.val - a.val)
}

function stackedSegments(di: number): StackedSeg[] {
  const day = props.perDay[di]
  const sorted = sortedDayProvs(day)

  const result: StackedSeg[] = []
  let cumH = 0
  for (const { pid, val } of sorted) {
    const h = (val / maxVal.value) * plotH
    result.push({
      pid,
      color: getProviderColor(props.providerColors, pid),
      y: plotBottom - cumH - h,
      h: Math.max(h, MIN_BAR_HEIGHT),
    })
    cumH += h
  }
  return result
}

/* ── 月份标签 ── */
const monthLabels = computed(() => {
  const labels: { x: number; label: string }[] = []
  let lastMonth = -1
  for (let i = 0; i < props.perDay.length; i++) {
    const m = props.perDay[i].date.getMonth()
    if (m !== lastMonth) {
      lastMonth = m
      labels.push({
        // eslint-disable-next-line no-magic-numbers -- 月标居中：偏移半个柱宽
        x: colX(i) + barW.value / 2,
        label: `${m + 1}${t('settings.usage.heatMonthSuffix')}`,
      })
    }
  }
  return labels
})

/* ── hover 状态 ── */
const hoverIdx = ref(-1)
const mouseX = ref(0)
const mouseY = ref(0)

function onMouseMove(e: MouseEvent): void {
  const rect = wrapRef.value?.getBoundingClientRect()
  if (!rect) return
  const x = e.clientX - rect.left
  const y = e.clientY - rect.top
  mouseX.value = x
  mouseY.value = y
  const idx = Math.floor((x - padL) / slot.value)
  if (idx >= 0 && idx < props.perDay.length) {
    hoverIdx.value = idx
  } else {
    hoverIdx.value = -1
  }
}

function onMouseLeave(): void {
  hoverIdx.value = -1
}

/* ── tooltip 数据 ── */
interface TipRow {
  pid: string
  color: string
  value: string
  pct: string
}

interface TipData {
  dateLabel: string
  total: string
  input: string
  cacheRead: string
  output: string
  rows: TipRow[]
}

const tipData = computed<TipData | null>(() => {
  if (hoverIdx.value < 0) return null
  const day = props.perDay[hoverIdx.value]
  const totVal = metricValue(day.dTot, props.metric)
  const sorted = sortedDayProvs(day)

  const fmt = props.metric === 'cost' ? fmtUSD : fmtInt

  return {
    dateLabel: `${fmtISO(day.date)} \u00A0${weekdayLabel(day.date)}`,
    total: fmt(totVal),
    input: fmtCompact(day.dTot.input),
    cacheRead: fmtCompact(day.dTot.cacheRead),
    output: fmtCompact(day.dTot.output),
    rows: sorted.map(({ pid, val }) => ({
      pid,
      color: getProviderColor(props.providerColors, pid),
      value: fmt(val),
      pct: totVal > 0 ? fmtPct(val / totVal) : '0%',
    })),
  }
})

const tipStyle = computed(() => {
  const x = mouseX.value + TIP_OFFSET_X
  const flip = mouseX.value > (width.value * TIP_FLIP_RATIO)
  return {
    left: flip ? `${mouseX.value - TIP_WIDTH_ESTIMATE}px` : `${x}px`,
    top: `${Math.max(TIP_TOP_MARGIN, mouseY.value - TIP_Y_SHIFT)}px`,
  }
})

/* ── 峰值日标注 ── */
const MIN_DAYS_FOR_PEAK = 14

const peakDayIdx = computed(() => {
  let maxV = 0
  let maxI = -1
  for (let i = 0; i < props.perDay.length; i++) {
    const v = metricValue(props.perDay[i].dTot, props.metric)
    if (v > maxV) { maxV = v; maxI = i }
  }
  return maxI
})

const peakDayLabel = computed(() => {
  if (peakDayIdx.value < 0) return ''
  return fmtMMDD(props.perDay[peakDayIdx.value].date)
})

const HALF_DIVISOR = 2

const peakTriangle = computed(() => {
  if (peakDayIdx.value < 0) return ''
  const cx = colX(peakDayIdx.value) + barW.value / HALF_DIVISOR
  const TRI_W = 5
  const TRI_H = 4
  return `${cx - TRI_W},${padT - 1} ${cx + TRI_W},${padT - 1} ${cx},${padT - 1 + TRI_H}`
})
</script>
