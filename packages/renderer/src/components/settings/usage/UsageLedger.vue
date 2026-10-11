<!--
  UsageLedger · 摘要台账行。
  一行内联数字，1px 竖分隔（demo 台账行：flex baseline / gap 20px / padding 4px 0 14px，
  数字在上、srow-desc 标签在下）。从 demo ledger 移植。
  数字行字号为 demo ledger 展示级字面大字号（总 Token lead 24px，其余格 21px）：
  超出 --text-* 字号档上限（15px，style.css 字号 scale），刻意跳过归档、维持 demo
  字面 px（不随全局/分区字号缩放链）；登记见 docs/todo/ui-replica-demo-fidelity.md。

  为什么 Token 是 lead 主指标而费用条件展示：订阅制 provider（kimi/zai/xiaomi 等）
  cost 恒为 0（USD 口径），以费用为中心会让订阅用户大面积看到 $0.00，故 cost=0 时
  显「—」并降 dim（原用量设计提案裁决，提案文档已删除，git 可追溯）。
-->
<template>
  <div data-testid="usage-ledger" class="flex flex-wrap items-stretch gap-x-5 gap-y-[18px] pb-[14px] pt-[4px]">
    <!-- 总 Token（lead 大字） -->
    <div data-testid="usage-ledger-total-tokens" class="flex flex-col">
      <div class="font-mono text-[24px] leading-[1.35] tabular-nums text-neutral-fg">
        {{ fmtInt(totalTokens(tot)) }}
      </div>
      <div class="mt-[2px] text-[length:var(--text-sm)] text-neutral-mid">{{ t('settings.usage.totalTokens') }} &middot; {{ range === 0 ? t('settings.usage.rangeAll') : t('settings.usage.recentDays', { n: nDays }) }}</div>
    </div>

    <div class="w-px self-stretch bg-[var(--border)]" aria-hidden="true" />

    <!-- 费用 -->
    <div data-testid="usage-ledger-cost" class="flex flex-col">
      <div
        class="font-mono text-[21px] leading-[1.35] tabular-nums"
        :class="tot.cost === 0 ? 'text-[var(--neutral-fg-2)]' : 'text-neutral-fg'"
      >
        {{ tot.cost === 0 ? '\u2014' : fmtUSD(tot.cost) }}
      </div>
      <div class="mt-[2px] text-[length:var(--text-sm)] text-neutral-mid">{{ t('settings.usage.cost') }}</div>
    </div>

    <div class="w-px self-stretch bg-[var(--border)]" aria-hidden="true" />

    <!-- 消息数 -->
    <div class="flex flex-col">
      <div class="font-mono text-[21px] leading-[1.35] tabular-nums text-neutral-fg">
        {{ fmtInt(msgs) }}
      </div>
      <div class="mt-[2px] text-[length:var(--text-sm)] text-neutral-mid">{{ t('settings.usage.messages') }}</div>
    </div>

    <div class="w-px self-stretch bg-[var(--border)]" aria-hidden="true" />

    <!-- 活跃天 -->
    <div class="flex flex-col">
      <div class="font-mono text-[21px] leading-[1.35] tabular-nums text-neutral-fg">
        {{ activeDays }} / {{ nDays }}
      </div>
      <div class="mt-[2px] text-[length:var(--text-sm)] text-neutral-mid">{{ t('settings.usage.activeDays') }}</div>
    </div>

    <div class="w-px self-stretch bg-[var(--border)]" aria-hidden="true" />

    <!-- 缓存命中率（demo 把峰值日并入本格标签行；real 独立峰值格保留，见峰值格） -->
    <div class="flex flex-col">
      <div class="font-mono text-[21px] leading-[1.35] tabular-nums text-neutral-fg">
        {{ cacheHitRate }}
      </div>
      <div class="mt-[2px] text-[length:var(--text-sm)] text-neutral-mid">{{ t('settings.usage.cacheHitRate') }}</div>
    </div>

    <div class="w-px self-stretch bg-[var(--border)]" aria-hidden="true" />

    <!-- 峰值日（real 独有格：demo 无对应；数字=日期，标签下附峰值量） -->
    <div class="flex flex-col">
      <div class="font-mono text-[21px] leading-[1.35] tabular-nums text-neutral-fg">
        {{ peak.d ? fmtMMDD(toLocalDate(peak.d)) : '\u2014' }}
      </div>
      <div class="mt-[2px] text-[length:var(--text-sm)] text-neutral-mid">{{ t('settings.usage.peakDay') }}</div>
      <div v-if="peak.d" class="mt-[2px] font-mono text-[length:var(--text-2xs)] tabular-nums text-neutral-mid">
        {{ metric === 'tokens' ? fmtCompact(peak.v) : fmtUSD(peak.v) }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  type AggMetrics,
  fmtInt,
  fmtCompact,
  fmtUSD,
  fmtPct,
  totalTokens,
  fmtMMDD,
  toLocalDate,
} from '@taiji/core'

const { t } = useI18n()

const props = defineProps<{
  tot: AggMetrics
  msgs: number
  activeDays: number
  nDays: number
  peak: { v: number; d: string | null }
  range: number
  metric: 'tokens' | 'cost'
}>()

const cacheHitRate = computed(() => {
  const base = props.tot.cacheRead + props.tot.input
  return base > 0 ? fmtPct(props.tot.cacheRead / base) : '\u2014'
})
</script>
