<!--
  GenStatsCacheCard —— 缓存命中率浮层的**纯内容卡**（W3a 拆分：原 GenStatsTriggers 的缓存
  HoverCardContent 内容原样迁移，head / 两行聚合 / bar / 归因说明行与 data-testid 不变）。

  拆分动机与 GenStatsSpeedCard 相同：指标聚合页直拼本卡，原触发器也改挂本卡，删重复渲染。

  归因降噪（2026-09-19 D-A）：帧带 cacheRatio.currentMiss（cold-start / idle-expiry /
  context-rewrite）时，本次行显成因文案（中性色，非故障）+ 浮层说明行；未知成因的 0% 仍走
  数值三档色——那正是需要被看到的信号。三档阈值 / 归因 label 收敛在 gen-stats-display（共用）。

  契约：props = { sessionId?, modelId? }，无 emits。数据纯读（useGenStats 分区自持实例）。
-->
<template>
  <!-- head -->
  <div
    class="flex items-center justify-between border-b border-border bg-white/[0.015] px-2.5 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-neutral-dim"
  >
    <span>{{ t('panel.context.genStatsCacheTitle') }}</span>
    <span class="max-w-[140px] truncate" data-testid="genstats-cache-model">{{ frame?.model ?? '—' }}</span>
  </div>
  <!-- 无合法帧：暂无数据 -->
  <div v-if="!frame" class="px-2.5 py-3 text-center text-[10.5px] text-neutral-dim">
    {{ t('panel.context.genStatsNoData') }}
  </div>
  <template v-else>
    <!-- 两行聚合：本次请求 / 今日加权 -->
    <div class="grid grid-cols-2 gap-x-3.5 gap-y-2 px-2.5 py-2.5">
      <div class="flex flex-col gap-0.5">
        <span class="font-mono text-[10px] uppercase tracking-[0.05em] text-neutral-dim">{{ t('panel.context.genStatsCurrentReq') }}</span>
        <span class="font-sans text-[14px] font-semibold tabular-nums" :class="cacheCurrentClass">
          {{ cacheDisplay }}
        </span>
      </div>
      <div class="flex flex-col gap-0.5">
        <span class="font-mono text-[10px] uppercase tracking-[0.05em] text-neutral-dim">{{ t('panel.context.genStatsDayShort') }}</span>
        <span class="font-sans text-[14px] font-semibold tabular-nums" :class="frame.cacheRatio.day == null ? 'text-neutral-dim' : 'text-neutral-fg'">
          {{ cachePercentDisplay(frame.cacheRatio.day) }}
        </span>
      </div>
    </div>
    <!-- bar（仅未归因的数值命中率有值时显示；宽度/颜色按三档语义色）——归因态无 0% 数值可画，
         空轨道反而会读成「命中率 0」的另一种画法，故整体隐藏 -->
    <div v-if="frame.cacheRatio.current != null && !cacheMiss" class="mx-2.5 mt-0.5 h-1 overflow-hidden rounded-full bg-surface-2">
      <div
        :class="cn('h-full rounded-full transition-[width,background-color]', CACHE_TIER_BG_CLASS[cacheTierOf(cacheCurrent)])"
        :style="{ width: `${frame.cacheRatio.current}%` }"
        data-testid="genstats-cache-bar"
      />
    </div>
    <!-- 口径说明（归因降噪：已知成因的 0% 先把成因说清，再接通用口径） -->
    <div class="mt-2 border-t border-border px-2.5 py-1.5 font-mono text-[10px] text-neutral-dim">
      <p
        v-if="cacheMissNoteText"
        class="mb-1 text-neutral-mid"
        data-testid="genstats-cache-miss-note"
      >{{ cacheMissNoteText }}</p>
      {{ t('panel.context.genStatsCacheNote') }}
    </div>
  </template>
</template>

<script setup lang="ts">
import { computed, toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { cn } from '@/lib/utils'
import { useGenStats } from '@/composables/features/model/useGenStats'
import {
  CACHE_TIER_BG_CLASS,
  cacheMissLabel,
  cachePercentDisplay,
  cacheTierOf,
} from './gen-stats-display'

const props = defineProps<{
  /** session 分区键 + 恢复腿触发源（同原触发器受控范式） */
  sessionId?: string
  /** 当前复合 modelId，供 composable 做帧 model 校验兜底（D4 前端防线） */
  modelId?: string
}>()

const { t } = useI18n()

// 订阅（session.stats_update）/ 恢复腿 / model 校验全在 composable 内（与触发器共享分区）
const { current: frame } = useGenStats(toRef(props, 'sessionId'), toRef(props, 'modelId'))

/** 空闲时长格式化基数（毫秒/分钟、分钟/小时；模块级常量，避免 no-magic-numbers） */
const MS_PER_MINUTE = 60_000
const MINUTES_PER_HOUR = 60

const cacheCurrent = computed(() => frame.value?.cacheRatio.current ?? null)

/**
 * 归因降噪（2026-09-19 D-A）：帧内 currentMiss（runtime 已归因的「预期内 0%」）为
 * 显示与着色的最高优先依据——有归因时本次行渲染成因文案 + 中性色（非故障），
 * 无归因才回落到数值三档色。
 */
const cacheMiss = computed(() => frame.value?.cacheRatio.currentMiss ?? null)

/** 浮层本次行文字色：归因态与无值同为中性（归因不是异常，不该用 fg 强调） */
const cacheCurrentClass = computed(() =>
  cacheMiss.value || cacheCurrent.value == null ? 'text-neutral-dim' : 'text-neutral-fg',
)

/** 空闲时长显示（locale-neutral 短单位：< 1h →「20m」，≥ 1h →「3h50m」） */
function formatIdle(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MS_PER_MINUTE))
  if (minutes < MINUTES_PER_HOUR) return `${minutes}m`
  const hours = Math.floor(minutes / MINUTES_PER_HOUR)
  const rest = minutes % MINUTES_PER_HOUR
  return rest === 0 ? `${hours}h` : `${hours}h${rest}m`
}

/** 浮层归因说明行（无归因 → null，不出行；reason 已知值穷尽，防御分支见 cacheMissLabel default） */
const cacheMissNoteText = computed(() => {
  const miss = cacheMiss.value
  if (!miss) return null
  if (miss.reason === 'cold-start') return t('panel.context.genStatsCacheMissColdStartNote')
  if (miss.reason === 'idle-expiry') {
    // [RD-2#6] idleMs 缺失 = 时长未知：不以 ?? 0 伪装成「空闲 1m」假测量值（D4：null=无数据/0=真值）
    return miss.idleMs != null
      ? t('panel.context.genStatsCacheMissIdleNote', { duration: formatIdle(miss.idleMs) })
      : t('panel.context.genStatsCacheMissIdleNoteUnknownDuration')
  }
  if (miss.reason === 'context-rewrite') return t('panel.context.genStatsCacheMissCompactionNote')
  // 防御：协议新增 reason 时不出说明行（触发器文案侧的 default 分支兜底 + warn）
  return null
})

/** 触发器/本次行显示：归因态 → 成因文案（「空闲过期」等）；否则数值（null →「—」） */
const cacheDisplay = computed(() => {
  const miss = cacheMiss.value
  return miss ? cacheMissLabel(miss.reason, t) : cachePercentDisplay(cacheCurrent.value)
})
</script>
