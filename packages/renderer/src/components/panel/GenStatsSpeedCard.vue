<!--
  GenStatsSpeedCard —— TOKEN 速度浮层的**纯内容卡**（W3a 拆分：原 GenStatsTriggers 的速度
  HoverCardContent 内容原样迁移，head / 四行聚合 / 口径说明与 data-testid 不变）。

  拆分动机：指标聚合页（ComposerMetricsAggregate）要把速度卡与容量卡、缓存卡纵向拼进同一浮层，
  沿用「触发器包内容」会嵌套 HoverCard 且重复渲染——故内容独立成卡，原触发器与聚合页共挂本卡。

  契约：props = { sessionId?, modelId? }（受控，语义与原触发器一致），无 emits。
  数据纯读：本卡自持 useGenStats 分区实例（useSessionScopedState 共享分区，与触发器同源收敛）。
-->
<template>
  <!-- head -->
  <div
    class="flex items-center justify-between border-b border-border bg-white/[0.015] px-2.5 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-neutral-dim"
  >
    <span>{{ t('panel.context.genStatsSpeedTitle') }}</span>
    <span class="max-w-[140px] truncate" data-testid="genstats-speed-model">{{ frame?.model ?? '—' }}</span>
  </div>
  <!-- 无合法帧：暂无数据（§3.4——从未有帧与有帧无值的 UX 差异落在浮层） -->
  <div v-if="!frame" class="px-2.5 py-3 text-center text-[10.5px] text-neutral-dim">
    {{ t('panel.context.genStatsNoData') }}
  </div>
  <template v-else>
    <!-- 四行聚合（2×2 grid）：本次 / 今日均值 / 近 7 天 / 近 30 天 -->
    <div class="grid grid-cols-2 gap-x-3.5 gap-y-2 px-2.5 py-2.5">
      <div v-for="row in speedRows" :key="row.label" class="flex flex-col gap-0.5">
        <!-- 「本次」label 带 hover 补句（C4）：current 无窗口过滤且为会话私有样本，澄清样本来自本会话最近一次请求 -->
        <span
          class="font-mono text-[10px] uppercase tracking-[0.05em] text-neutral-dim"
          :title="row.note ?? undefined"
        >{{ row.label }}</span>
        <span class="font-sans text-[14px] font-semibold tabular-nums" :class="row.value == null ? 'text-neutral-dim' : 'text-neutral-fg'">
          {{ row.value == null ? '—' : formatSpeed(row.value) }}
        </span>
      </div>
    </div>
    <!-- 口径说明 -->
    <div class="border-t border-border px-2.5 py-1.5 font-mono text-[10px] text-neutral-dim">
      {{ t('panel.context.genStatsSpeedNote') }}
    </div>
  </template>
</template>

<script setup lang="ts">
import { computed, toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useGenStats } from '@/composables/features/model/useGenStats'
import { formatSpeed } from './gen-stats-display'

const props = defineProps<{
  /** session 分区键 + 恢复腿触发源（同原触发器受控范式） */
  sessionId?: string
  /** 当前复合 modelId，供 composable 做帧 model 校验兜底（D4 前端防线） */
  modelId?: string
}>()

const { t } = useI18n()

// 订阅（session.stats_update）/ 恢复腿（session.getGenStats）/ model 校验全在 composable 内
const { current: frame } = useGenStats(toRef(props, 'sessionId'), toRef(props, 'modelId'))

/** 速度浮层四行（label + 聚合值；null → 浮层行显「—」）。note = label 的原生
 *  title 补句（仅「本次」有——C4 current 无窗口过滤语义澄清）。 */
const speedRows = computed(() => {
  const s = frame.value?.speed
  return [
    { label: t('panel.context.genStatsCurrent'), note: t('panel.context.genStatsCurrentNote'), value: s?.current ?? null },
    { label: t('panel.context.genStatsDay'), value: s?.day ?? null },
    { label: t('panel.context.genStatsD7'), value: s?.d7 ?? null },
    { label: t('panel.context.genStatsD30'), value: s?.d30 ?? null },
  ]
})
</script>
