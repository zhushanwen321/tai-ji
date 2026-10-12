<!--
  UsageProjectRank · 项目谱排名，微型堆叠条展示 provider 构成。
  行形态 = demo 项目谱 srow（min-h 40 / mono 名 / 140px 8px 条 r-4px / 44px 占比右对齐）。
-->
<template>
  <div class="flex flex-col">
    <div
      v-for="(row, i) in projects"
      :key="row.name"
      class="grid min-h-[40px] grid-cols-[24px_minmax(0,1fr)_140px_80px_44px] items-center gap-1 border-t border-hairline px-[6px] py-[10px] first:border-t-0"
      :title="row.name"
    >
      <!-- 序号 -->
      <span class="w-6 shrink-0 text-right text-[length:var(--text-2xs)] tabular-nums text-[var(--neutral-dim)]">
        {{ String(i + 1).padStart(2, '0') }}
      </span>

      <!-- 项目名（basename） -->
      <span class="min-w-0 truncate font-mono text-[length:var(--text-xs)] text-neutral-fg">
        {{ row.name }}
      </span>

      <!-- 堆叠条（140px 定宽 = demo；无底轨） -->
      <span class="stack-track h-[8px] min-w-0 overflow-hidden rounded-[4px]">
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
      <span class="min-w-0 text-right font-mono text-[length:var(--text-xs)] tabular-nums text-neutral-fg">
        <template v-if="metric === 'cost'">{{ fmtUSD(rowVal(row)) }}</template>
        <template v-else>{{ fmtCompact(rowVal(row)) }}</template>
      </span>

      <!-- 占比 -->
      <span class="min-w-0 text-right font-mono text-[length:var(--text-xs)] tabular-nums text-neutral-mid">
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
} from '@taiji/core'
import type { RankRow } from '@taiji/core'

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

