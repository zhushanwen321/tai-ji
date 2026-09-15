<!--
  UsageCacheMix · 缓存构成：命中/新输入/输出 百分比构成条。
  为什么缓存命中率值得独立成节：coding agent 上下文复用使 cacheRead 通常占
  70-90%，它是用量健康度的一等公民指标，不只是 totalTokens 的拆分明细
  （原用量设计提案裁决，提案文档已删除，git 可追溯）。
-->
<template>
  <div class="flex flex-col gap-3">
    <!-- 每个 model 一行 -->
    <div v-for="row in cacheData" :key="`${row.provider}/${row.model}`" class="flex flex-col gap-1.5">
      <!-- 模型名 + 命中率 -->
      <div class="flex items-center justify-between gap-2">
        <span class="min-w-0 truncate font-[var(--font-mono)] text-[12px] text-[var(--neutral-fg)]"><span class="text-[var(--neutral-dim)]">{{ row.provider }}/</span>{{ row.model }}</span>
        <span class="shrink-0 font-[var(--font-mono)] text-[11px] tabular-nums text-[var(--neutral-dim)]">
          <span class="mr-1 text-[10px] text-[var(--neutral-dim)]">{{ t('settings.usage.cacheHitRate') }}</span>{{ fmtPct(row.hitRate) }}
        </span>
      </div>

      <!-- 三段构成条 -->
      <div class="h-2 overflow-hidden rounded-[3px] bg-[var(--hairline)]">
        <div class="flex h-full">
          <span
            class="h-full shrink-0"
            :style="{ width: (row.hit * 100).toFixed(2) + '%', background: 'var(--cache-hit)' }"
          />
          <span
            class="h-full shrink-0"
            :style="{ width: (row.newIn * 100).toFixed(2) + '%', background: 'var(--cache-in)' }"
          />
          <span
            class="h-full shrink-0"
            :style="{ width: (row.out * 100).toFixed(2) + '%', background: 'var(--cache-out)' }"
          />
        </div>
      </div>
    </div>

    <!-- 底部图例 -->
    <div class="mt-1 flex items-center gap-4 text-[11px] text-[var(--neutral-dim)]">
      <span class="flex items-center gap-1.5">
        <span class="inline-block size-2.5 rounded-[2px]" style="background: var(--cache-hit)" />
        <span>{{ t('settings.usage.legendCacheHit') }}</span>
      </span>
      <span class="flex items-center gap-1.5">
        <span class="inline-block size-2.5 rounded-[2px]" style="background: var(--cache-in)" />
        <span>{{ t('settings.usage.legendNewInput') }}</span>
      </span>
      <span class="flex items-center gap-1.5">
        <span class="inline-block size-2.5 rounded-[2px]" style="background: var(--cache-out)" />
        <span>{{ t('settings.usage.legendOutput') }}</span>
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { fmtPct } from './aggregate'

const { t } = useI18n()

defineProps<{
  cacheData: { provider: string; model: string; hit: number; newIn: number; out: number; hitRate: number }[]
}>()
</script>
