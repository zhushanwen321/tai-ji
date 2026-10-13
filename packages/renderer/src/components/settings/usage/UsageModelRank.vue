<!--
  UsageModelRank · 模型谱排名条形列表。
  点击行 toggle isolate（单看某模型），选中行 model 名变 accent 色 + accent-soft 行底。
  行形态 = demo 卡内行节奏（srow：min-h 40 / px 6 / py 10 / border-t hairline 首行无；
  条形 8px r-4px 对齐 demo 项目谱条）。行标识 = perModel 复合键 `${provider}/${model}`
  （isolate 语义同键）；展示用 provider/model 分量。
-->
<template>
  <div data-testid="usage-model-rank" class="flex flex-col">
    <div
      v-for="(row, i) in sortedRows"
      :key="row.key"
      :data-testid="`usage-model-${row.key}`"
      class="grid min-h-[40px] cursor-pointer select-none grid-cols-[24px_minmax(0,1fr)_auto_80px_56px] items-center gap-1 border-t border-hairline px-[6px] py-[10px] first:border-t-0"
      :class="{ 'bg-[var(--accent-soft)]': isolate === row.key }"
      @click="toggle(row.key)"
    >
      <!-- 序号 -->
      <span class="w-6 shrink-0 text-right text-[length:var(--text-2xs)] tabular-nums text-[var(--neutral-dim)]">
        {{ String(i + 1).padStart(2, '0') }}
      </span>

      <!-- 模型名（provider 灰前缀 + 裸 model，分量渲染不直接渲染复合键串） -->
      <span class="min-w-0 truncate font-mono text-[length:var(--text-xs)]" :class="isolate === row.key ? 'text-[var(--accent)]' : 'text-neutral-fg'">
        <span class="text-[var(--neutral-dim)]">{{ row.provider }}/</span>{{ row.model }}
      </span>

      <!-- 条形图（8px / r-4px = demo 项目谱条形态；无底轨 = demo 条无 track 底） -->
      <span class="bar-track relative mx-2 h-[8px] min-w-[60px] flex-1 overflow-hidden rounded-[4px]">
        <span
          class="absolute inset-y-0 left-0 rounded-[4px]"
          :style="{ width: maxVal > 0 ? (row.value / maxVal * 100).toFixed(1) + '%' : '0%', background: getProviderColor(providerColors, row.provider) }"
        />
      </span>

      <!-- 数值 -->
      <span class="w-20 shrink-0 text-right font-mono text-[length:var(--text-xs)] tabular-nums text-neutral-fg">
        <template v-if="metric === 'cost'">{{ fmtUSD(row.value) }}<span v-if="row.tokenVal > 0" class="ml-1 text-[length:var(--text-2xs)] text-[var(--neutral-dim)]">{{ fmtCompact(row.tokenVal) }}</span></template>
        <template v-else>{{ fmtCompact(row.value) }}<span v-if="row.costVal > 0" class="ml-1 text-[length:var(--text-2xs)] text-[var(--neutral-dim)]">{{ fmtUSD(row.costVal) }}</span></template>
      </span>

      <!-- 占比 -->
      <span class="w-14 shrink-0 text-right font-mono text-[length:var(--text-xs)] tabular-nums text-neutral-mid">
        {{ fmtPct(totalVal > 0 ? row.value / totalVal : 0) }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import {
  getProviderColor,
  metricValue,
  fmtCompact,
  fmtUSD,
  fmtPct,
  totalTokens,
} from '@taiji/core'
import type { PerModelEntry } from '@taiji/core'

const props = defineProps<{
  perModel: Record<string, PerModelEntry>
  metric: 'tokens' | 'cost'
  isolate: string | null
  /** pid -> CSS 变量色映射（aggregate() 结果的 providerColors） */
  providerColors: Record<string, string>
}>()

const emit = defineEmits<{
  'update:isolate': [key: string | null]
}>()

interface ModelRow {
  /** 复合键 = perModel key（isolate 行标识，比较/emit 均用它）；provider/model 仅用于渲染 */
  key: string
  model: string
  provider: string
  value: number
  tokenVal: number
  costVal: number
}

const TOP_MODELS = 8

const sortedRows = computed<ModelRow[]>(() => {
  return Object.keys(props.perModel)
    .map((key) => {
      const entry = props.perModel[key]
      return {
        key,
        model: entry.model,
        provider: entry.provider,
        value: metricValue(entry.u, props.metric),
        tokenVal: totalTokens(entry.u),
        costVal: entry.u.cost,
      }
    })
    .sort((a, b) => b.value - a.value)
    .slice(0, TOP_MODELS)
})

const maxVal = computed(() => sortedRows.value[0]?.value ?? 0)

const totalVal = computed(() =>
  Object.values(props.perModel).reduce((sum, entry) => sum + metricValue(entry.u, props.metric), 0),
)

function toggle(key: string): void {
  emit('update:isolate', props.isolate === key ? null : key)
}
</script>

