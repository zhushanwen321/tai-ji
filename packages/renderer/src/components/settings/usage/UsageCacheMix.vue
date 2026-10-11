<!--
  UsageCacheMix · 缓存构成：命中/新输入/输出 百分比构成条。
  为什么缓存命中率值得独立成节：coding agent 上下文复用使 cacheRead 通常占
  70-90%，它是用量健康度的一等公民指标，不只是 totalTokens 的拆分明细
  （原用量设计提案裁决，提案文档已删除，git 可追溯）。
-->
<template>
  <div class="flex flex-col">
    <!-- 每个 model 一行（行形态 = demo 缓存构成 srow：min-h 40 / mono 名 / 120px 条凹陷档底 / 44px 占比） -->
    <div class="flex min-h-[40px] items-center gap-4 border-t border-hairline px-[6px] py-[10px] first:border-t-0" v-for="row in cacheData" :key="`${row.provider}/${row.model}`">
      <span class="min-w-0 flex-1 truncate font-mono text-[length:var(--text-xs)] text-neutral-fg"><span class="text-[var(--neutral-dim)]">{{ row.provider }}/</span>{{ row.model }}</span>

      <!-- 三段构成条（--cache-* 令牌）。底轨引 --bg-input（凹陷档）：demo 同名 --surface-2 =
           var(--card-inset) 凹陷档，real --surface-2 浮起档（登记见 docs/DESIGN.md §4.1
           背景层级）同名分叉，复刻消费点按 demo 方向引凹陷档 -->
      <span class="h-[8px] w-[120px] shrink-0 overflow-hidden rounded-[4px] bg-bg-input">
        <span class="flex h-full">
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
        </span>
      </span>

      <span class="w-[44px] shrink-0 text-right font-mono text-[length:var(--text-xs)] tabular-nums text-neutral-mid">{{ fmtPct(row.hitRate) }}</span>
    </div>

    <!-- 底部图例（三色 = real 独有：hit/newIn/out 构成解码） -->
    <div class="mb-[2px] mt-[8px] flex items-center gap-[16px] px-[6px] text-[length:var(--text-2xs)] text-[var(--neutral-dim)]">
      <span class="flex items-center gap-1.5">
        <span class="inline-block size-[10px] rounded-[2px]" style="background: var(--cache-hit)" />
        <span>{{ t('settings.usage.legendCacheHit') }}</span>
      </span>
      <span class="flex items-center gap-1.5">
        <span class="inline-block size-[10px] rounded-[2px]" style="background: var(--cache-in)" />
        <span>{{ t('settings.usage.legendNewInput') }}</span>
      </span>
      <span class="flex items-center gap-1.5">
        <span class="inline-block size-[10px] rounded-[2px]" style="background: var(--cache-out)" />
        <span>{{ t('settings.usage.legendOutput') }}</span>
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { fmtPct } from '@taiji/core'

const { t } = useI18n()

defineProps<{
  cacheData: { provider: string; model: string; hit: number; newIn: number; out: number; hitRate: number }[]
}>()
</script>
