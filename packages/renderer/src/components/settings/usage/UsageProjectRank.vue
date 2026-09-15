<!--
  UsageProjectRank · 项目谱排名，微型堆叠条展示 provider 构成。
-->
<template>
  <div class="flex flex-col">
    <div
      v-for="(row, i) in projects"
      :key="row.name"
      class="grid grid-cols-[24px_minmax(0,1fr)_auto_80px_56px] items-center gap-1 rounded-[var(--radius-sm)] px-2 py-1 transition-colors hover:bg-[var(--row-hover)]"
      :title="row.name"
    >
      <!-- 序号 -->
      <span class="w-6 shrink-0 text-right text-[11px] font-medium text-[var(--neutral-dim)] tabular-nums">
        {{ String(i + 1).padStart(2, '0') }}
      </span>

      <!-- 项目名（basename） -->
      <span class="min-w-0 truncate text-[12px] text-[var(--neutral-fg)]">
        {{ row.name }}
      </span>

      <!-- 堆叠条 -->
      <span class="stack-track mx-2 h-1.5 min-w-[70px] flex-1 overflow-hidden rounded-[3px] bg-[var(--hairline)]">
        <span class="flex h-full">
          <span
            v-for="seg in stackSegments(row)"
            :key="seg.pid"
            class="h-full shrink-0"
            :style="{ width: seg.pct + '%', background: seg.color }"
          />
        </span>
      </span>

      <!-- 数值 -->
      <span class="w-20 shrink-0 text-right font-[var(--font-mono)] text-[12px] tabular-nums text-[var(--neutral-fg)]">
        <template v-if="metric === 'cost'">{{ fmtUSD(rowVal(row)) }}</template>
        <template v-else>{{ fmtCompact(rowVal(row)) }}</template>
      </span>

      <!-- 占比 -->
      <span class="w-14 shrink-0 text-right font-[var(--font-mono)] text-[11px] tabular-nums text-[var(--neutral-dim)]">
        {{ fmtPct(totalMetric > 0 ? rowVal(row) / totalMetric : 0) }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  getProviderColor,
  metricValue,
  fmtCompact,
  fmtUSD,
  fmtPct,
} from './aggregate'
import type { RankRow } from './aggregate'

const props = defineProps<{
  projects: RankRow[]
  metric: 'tokens' | 'cost'
  totalMetric: number
  /** pid -> CSS 变量映射（aggregate() 结果的 providerColors，取色随数据返回，无全局态） */
  providerColors: Record<string, string>
}>()

interface StackSeg {
  pid: string
  pct: number
  color: string
}

function rowVal(row: RankRow): number {
  return metricValue(row.metrics, props.metric)
}

const PERCENT_MULTIPLIER = 100

function stackSegments(row: RankRow): StackSeg[] {
  const provs = row.provs
  if (!provs) return []
  const total = rowVal(row)
  if (total <= 0) return []
  return Object.keys(provs)
    .map((pid) => ({
      pid,
      pct: (metricValue(provs[pid], props.metric) / total) * PERCENT_MULTIPLIER,
      color: getProviderColor(props.providerColors, pid),
    }))
    .sort((a, b) => b.pct - a.pct)
}
</script>

