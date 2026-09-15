<!--
  UsageHeatCalendar · 16 周热力日历。
  按分位数分 5 档着色，hover 显示日期 + Token 数。
-->
<template>
  <div class="flex flex-col gap-4">
    <!-- 顶部月份标签 -->
    <div class="relative h-[14px] ml-[28px]" style="font-size:10px;">
      <span
        v-for="ml in monthLabels"
        :key="ml.col"
        class="absolute font-mono text-[var(--neutral-dim)]"
        :style="{ left: `${ml.col * 16}px` }"
      >
        {{ ml.label }}
      </span>
    </div>

    <!-- 日历主体：左侧星期 + 网格 -->
    <div class="flex">
      <!-- 星期标签 -->
      <div
        class="grid grid-rows-7 gap-[3px] mr-2 font-mono text-[10px] text-[var(--neutral-dim)]"
        style="grid-template-rows:repeat(7,13px)"
      >
        <span v-for="(lbl, i) in dayLabels" :key="i" class="h-[13px] leading-[13px]">
          {{ lbl }}
        </span>
      </div>

      <!-- 网格 -->
      <div
        class="grid gap-[3px]"
        style="grid-auto-flow:column; grid-template-rows:repeat(7,13px); width:max-content"
      >
        <div
          v-for="(cell, ci) in cells"
          :key="ci"
          class="w-[13px] h-[13px] rounded-[2.5px] cursor-default"
          :class="[cell.level, { 'opacity-[0.28]': cell.future }]"
          @mouseenter="onEnter($event, cell)"
          @mouseleave="onLeave"
        />
      </div>
    </div>

    <!-- 底部图例 -->
    <div class="flex items-center gap-2 ml-[28px] text-[10px] text-[var(--neutral-dim)] font-mono">
      <span>{{ t('settings.usage.less') }}</span>
      <div class="w-[13px] h-[13px] rounded-[2.5px] bg-[var(--heat-0)]" />
      <div class="w-[13px] h-[13px] rounded-[2.5px] bg-[var(--heat-1)]" />
      <div class="w-[13px] h-[13px] rounded-[2.5px] bg-[var(--heat-2)]" />
      <div class="w-[13px] h-[13px] rounded-[2.5px] bg-[var(--heat-3)]" />
      <div class="w-[13px] h-[13px] rounded-[2.5px] bg-[var(--heat-4)]" />
      <div class="w-[13px] h-[13px] rounded-[2.5px] bg-[var(--heat-5)]" />
      <span>{{ t('settings.usage.more') }}</span>
    </div>

    <!-- tooltip -->
    <Teleport to="body">
      <div
        v-if="tipVisible"
        class="fixed z-40 pointer-events-none bg-[var(--surface)] border border-[var(--border-strong)] rounded-[var(--radius-sm)] shadow-[var(--shadow-2)] px-2.5 py-1.5 text-[12px] leading-[1.7] font-mono"
        :style="tipPos"
      >
        <div class="text-[var(--neutral-dim)] text-[10px]">{{ tipDate }}</div>
        <div class="text-[var(--neutral-fg)]">{{ tipTokens }}</div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { fmtInt, toLocalDate, fmtISO } from './aggregate'

const { t } = useI18n()

const props = defineProps<{
  heatmapData: Map<string, number>
}>()

/* ── 热力日历布局常量 ── */
const CALENDAR_WEEKS = 16
const DAYS_PER_WEEK = 7
const DAYS_BACK_TO_MON_SUN = 6

/* ── 分位数阈值 ── */
const QUANTILE_LOW = 0.25
const QUANTILE_MID = 0.5
const QUANTILE_HIGH = 0.72
const QUANTILE_TOP = 0.9

/* ── tooltip 偏移 ── */
const TOOLTIP_OFFSET_X = 10
const TOOLTIP_OFFSET_Y = 36

/* ── 分位数 ── */
function quantiles(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const pos = q * (sorted.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo])
}

/* ── 日历格子数据 ── */
interface CalendarCell {
  dateStr: string
  value: number
  level: string
  future: boolean
}

const cells = computed<CalendarCell[]>(() => {
  const today = new Date()
  // 回退到最近的周一
  const dow = today.getDay() // 0=Sun
  const daysBackToMon = dow === 0 ? DAYS_BACK_TO_MON_SUN : dow - 1
  const lastMon = new Date(today)
  lastMon.setDate(today.getDate() - daysBackToMon)
  // 往前推 CALENDAR_WEEKS 周
  const startDate = new Date(lastMon)
  startDate.setDate(lastMon.getDate() - (CALENDAR_WEEKS - 1) * DAYS_PER_WEEK)

  // 提取非零值算分位数
  const values = [...props.heatmapData.values()].filter((v) => v > 0).sort((a, b) => a - b)
  const q25 = quantiles(values, QUANTILE_LOW)
  const q50 = quantiles(values, QUANTILE_MID)
  const q72 = quantiles(values, QUANTILE_HIGH)
  const q90 = quantiles(values, QUANTILE_TOP)

  function getLevel(v: number): string {
    if (v <= 0) return 'bg-[var(--heat-0)]'
    if (v <= q25) return 'bg-[var(--heat-1)]'
    if (v <= q50) return 'bg-[var(--heat-2)]'
    if (v <= q72) return 'bg-[var(--heat-3)]'
    if (v <= q90) return 'bg-[var(--heat-4)]'
    return 'bg-[var(--heat-5)]'
  }

  const result: CalendarCell[] = []
  const todayStr = fmtISO(new Date())
  // CALENDAR_WEEKS × DAYS_PER_WEEK 格，按列排（每列 DAYS_PER_WEEK 行）
  for (let week = 0; week < CALENDAR_WEEKS; week++) {
    for (let day = 0; day < DAYS_PER_WEEK; day++) {
      const d = new Date(startDate)
      d.setDate(startDate.getDate() + week * DAYS_PER_WEEK + day)
      const ds = fmtISO(d)
      const val = props.heatmapData.get(ds) ?? 0
      result.push({
        dateStr: ds,
        value: val,
        level: getLevel(val),
        future: ds > todayStr,
      })
    }
  }
  return result
})

/* ── 星期标签（一/三/五） ── */
const dayLabels = computed(() => ['', t('settings.usage.heatDayMon'), '', t('settings.usage.heatDayWed'), '', t('settings.usage.heatDayFri'), ''])

/* ── 月份标签 ── */
const monthLabels = computed(() => {
  const labels: { col: number; label: string }[] = []
  let lastMonth = -1
  for (let week = 0; week < CALENDAR_WEEKS; week++) {
    // 取该周第一天
    const cell = cells.value[week * DAYS_PER_WEEK]
    if (!cell) continue
    const d = toLocalDate(cell.dateStr)
    const m = d.getMonth()
    if (m !== lastMonth) {
      lastMonth = m
      labels.push({
        col: week,
        label: `${m + 1}${t('settings.usage.heatMonthSuffix')}`,
      })
    }
  }
  return labels
})

/* ── hover tooltip ── */
const tipVisible = ref(false)
const tipDate = ref('')
const tipTokens = ref('')
const tipPos = ref({ left: '0px', top: '0px' })

function onEnter(e: MouseEvent, cell: CalendarCell): void {
  const d = toLocalDate(cell.dateStr)
  const weekdays = [
    t('settings.usage.heatWeekSun'), t('settings.usage.heatWeekMon'),
    t('settings.usage.heatWeekTue'), t('settings.usage.heatWeekWed'),
    t('settings.usage.heatWeekThu'), t('settings.usage.heatWeekFri'),
    t('settings.usage.heatWeekSat'),
  ]
  tipDate.value = `${cell.dateStr}  ${weekdays[d.getDay()]}`
  tipTokens.value = cell.value > 0 ? `${fmtInt(cell.value)} ${t('settings.usage.heatTokens')}` : t('settings.usage.tooltipNoUsage')
  tipPos.value = {
    left: `${e.clientX + TOOLTIP_OFFSET_X}px`,
    top: `${e.clientY - TOOLTIP_OFFSET_Y}px`,
  }
  tipVisible.value = true
}

function onLeave(): void {
  tipVisible.value = false
}
</script>
