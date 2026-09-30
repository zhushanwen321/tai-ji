<!--
  GenStatsTtftCard —— TTFT 首字延迟浮层的**纯内容卡**（合并集成：dev-0.10.4 线 TTFT 触发器
  的 HoverCardContent 内容原样迁出，head / 四行聚合（p50 口径）/ 口径说明与 data-testid 不变）。

  拆分动机同 GenStatsSpeedCard：触发器与指标聚合页（ComposerMetricsAggregate）共挂本卡，
  避免嵌套 HoverCard 与重复渲染（2026-09-19 D-A 拆卡先例）。

  契约：props = { sessionId?, modelId? }（受控，语义与原触发器一致），无 emits。
  数据纯读：本卡自持 useGenStats 分区实例（useSessionScopedState 共享分区，与触发器同源收敛）。
-->
<template>
  <!-- head -->
  <div
    class="flex items-center justify-between border-b border-border bg-white/[0.015] px-2.5 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-neutral-dim"
  >
    <span>{{ t('panel.context.genStatsTtftTitle') }}</span>
    <span class="max-w-[140px] truncate" data-testid="genstats-ttft-model">{{ frame?.model ?? '—' }}</span>
  </div>
  <!-- 无合法帧：暂无数据（§3.1——从未有帧与有帧无值的 UX 差异落在浮层） -->
  <div v-if="!frame" class="px-2.5 py-3 text-center text-[10.5px] text-neutral-dim">
    {{ t('panel.context.genStatsNoData') }}
  </div>
  <template v-else>
    <!-- 四行聚合（2×2 grid）：本次 / 今日 p50 / 近 7 天 p50 / 近 30 天 p50 -->
    <div class="grid grid-cols-2 gap-x-3.5 gap-y-2 px-2.5 py-2.5">
      <div v-for="row in ttftRows" :key="row.label" class="flex flex-col gap-0.5">
        <!-- 「本次」label 复用 C4 hover 补句（同「本会话最近一次请求」语义，速度侧共用） -->
        <span
          class="font-mono text-[10px] uppercase tracking-[0.05em] text-neutral-dim"
          :title="row.note ?? undefined"
        >{{ row.label }}</span>
        <span
          class="font-sans text-[14px] font-semibold tabular-nums"
          :class="row.value == null ? 'text-neutral-dim' : 'text-neutral-fg'"
        >{{ row.display }}</span>
      </div>
    </div>
    <!-- 口径说明 -->
    <div class="border-t border-border px-2.5 py-1.5 font-mono text-[10px] text-neutral-dim">
      {{ t('panel.context.genStatsTtftNote') }}
    </div>
  </template>
</template>

<script setup lang="ts">
import { computed, toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useGenStats } from '@/composables/features/model/useGenStats'
import { formatTtftDuration } from './gen-stats-display'

const props = defineProps<{
  /** session 分区键 + 恢复腿触发源（同原触发器受控范式） */
  sessionId?: string
  /** 当前复合 modelId，供 composable 做帧 model 校验兜底（D4 前端防线） */
  modelId?: string
}>()

const { t } = useI18n()

// 订阅（session.stats_update）/ 恢复腿（session.getGenStats）/ model 校验全在 composable 内
const { current: frame } = useGenStats(toRef(props, 'sessionId'), toRef(props, 'modelId'))

/** TTFT 浮层四行（display 预格式化：null →「—」；<1000ms →「820ms」；≥1000 →「1.2s」）。
 *  p50 行 label 用 TTFT 专属 key（「今日 p50」），不复用 genStatsDay（「今日均值」与 p50
 *  中位数语义矛盾，设计 §3.1）；「本次」行 label/hover 补句复用速度侧 key（语义相同）。 */
const ttftRows = computed(() => {
  const v = frame.value?.ttft
  return [
    { label: t('panel.context.genStatsCurrent'), note: t('panel.context.genStatsCurrentNote'), value: v?.current ?? null },
    { label: t('panel.context.genStatsTtftDay'), value: v?.day ?? null },
    { label: t('panel.context.genStatsTtftD7'), value: v?.d7 ?? null },
    { label: t('panel.context.genStatsTtftD30'), value: v?.d30 ?? null },
  ].map((row) => ({ ...row, display: row.value == null ? '—' : formatTtftDuration(row.value) }))
})
</script>
