<!--
  GenStatsSpeedCard —— TOKEN 速度浮层的**纯内容卡**：head / 本次值 / 分布矩阵（5 统计量 ×
  3 窗口）/ 口径说明，data-testid 随卡承载。

  内容独立成卡的动机：指标聚合页（ComposerMetricsAggregate）把容量、TTFT、速度、缓存四张卡
  纵向拼进同一 HoverCard 浮层——入口各自包内容会嵌套 HoverCard 且重复渲染。本卡唯一挂载方
  = ComposerMetricsAggregate。

  分布矩阵（2026-10-24 用户裁决，与 TTFT 卡同构）：窗口聚合原为「总量加权平均」单值，
  该口径按耗时分摊权重、长请求主导，一次极慢的短请求几乎不可见。现改为逐样本速度的五量
  分布（avg / p50 / p99 / max / min），矩阵本体在 GenStatsDistributionGrid。

  契约：props = { sessionId?, modelId? }（受控），无 emits。
  数据纯读：本卡自持 useGenStats 分区实例（useSessionScopedState 共享分区，与聚合页同源）。
-->
<template>
  <!-- head（demo .cap-h：hairline 下边 + mono 10px 0.08em 小写标，无底色 tint，M4c） -->
  <div
    class="flex items-center justify-between border-b border-hairline px-2.5 py-2 font-mono text-[length:var(--text-3xs)] uppercase tracking-[0.08em] text-neutral-dim"
  >
    <span>{{ t('panel.context.genStatsSpeedTitle') }}</span>
    <span class="max-w-[140px] truncate" data-testid="genstats-speed-model">{{ frame?.model ?? '—' }}</span>
  </div>
  <!-- 无合法帧：暂无数据（§3.4——从未有帧与有帧无值的 UX 差异落在浮层） -->
  <div v-if="!frame" class="px-2.5 py-3 text-center text-[length:var(--text-3xs)] text-neutral-dim">
    {{ t('panel.context.genStatsNoData') }}
  </div>
  <template v-else>
    <!-- 本次（本会话最近一次请求）：单样本，不存在分布——单列一行，不塞进矩阵 -->
    <div class="flex items-baseline justify-between px-2.5 pt-2.5">
      <span
        class="font-mono text-[length:var(--text-3xs)] uppercase tracking-[0.05em] text-neutral-dim"
        :title="t('panel.context.genStatsCurrentNote')"
      >{{ t('panel.context.genStatsCurrent') }}</span>
      <span
        class="font-sans text-[length:var(--text-base)] font-semibold tabular-nums"
        :class="speedCurrent == null ? 'text-neutral-dim' : 'text-neutral-fg'"
        data-testid="genstats-speed-current"
      >{{ formatSpeed(speedCurrent) }}</span>
    </div>
    <!-- 分布矩阵（5 统计量 × 3 窗口） -->
    <GenStatsDistributionGrid
      :rows="speedRows"
      :columns="speedColumns"
      :format-value="formatCell"
      testid-prefix="genstats-speed-dist"
    />
    <!-- 口径说明 -->
    <div class="border-t border-hairline px-2.5 py-1.5 font-mono text-[length:var(--text-3xs)] text-neutral-dim">
      {{ t('panel.context.genStatsSpeedNote') }}
    </div>
  </template>
</template>

<script setup lang="ts">
import { computed, toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useGenStats } from '@/composables/features/model/useGenStats'
import { formatSpeed, formatDistributionValue, distributionColumns, distributionRows } from './gen-stats-display'
import type { DistributionColumn, DistributionRow } from './gen-stats-display'
import GenStatsDistributionGrid from './GenStatsDistributionGrid.vue'

const props = defineProps<{
  /** session 分区键 + 恢复路径触发源（同原触发器受控范式） */
  sessionId?: string
  /** 当前复合 modelId（签名保留，归属判定权威在 runtime，见 useGenStats 注释） */
  modelId?: string
}>()

const { t } = useI18n()

// 订阅（session.stats_update）/ 恢复路径（session.getGenStats）/ model 校验全在 composable 内
const { current: frame } = useGenStats(toRef(props, 'sessionId'), toRef(props, 'modelId'))

/** 本次（本会话最近一次请求）：单样本原值，不进分布矩阵 */
const speedCurrent = computed(() => frame.value?.speed.current ?? null)

/** 矩阵列 = 五个统计量（列头/矩阵行/缺省值与 TTFT 卡共用 gen-stats-display 单一来源） */
const speedColumns = computed<DistributionColumn[]>(() => distributionColumns(t))

/** 矩阵行 = 三个滚动窗口（本会话 current 已在矩阵上方单列，不入表） */
const speedRows = computed<DistributionRow[]>(() => distributionRows(t, frame.value?.speed))

/** 单元格格式化：速度格不带单位（列头已声明 t/s——详见 formatDistributionValue 注释） */
function formatCell(v: number | null): string {
  return formatDistributionValue(v, String)
}

</script>
