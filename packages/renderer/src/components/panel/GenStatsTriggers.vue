<template>
  <!--
    composer-gen-stats 双触发器（docs/design/composer-gen-stats.md §3.1 / §3.3 D4/D5）。
    位于上下文容量触发器左侧：左 = TOKEN 速度（t/s），右 = 缓存命中率（%），独立判定
    null → 「—」（无值编码纪律：null=无数据，0=真实测量值，D4）。
    命中率语义色三档：≥80 success · 50–80 warn · <50 danger（设计 §3.1，项目语义色 token）。
    hover 出各自浮层：速度四行（本次/今日/7天/30天）+ 口径说明；缓存两行（本次/今日加权）
    + bar + 口径说明。数据纯读 useGenStats 分区（订阅/恢复腿/model 校验兜底全在 composable）。
  -->
  <div class="flex items-center gap-0">
    <!-- 速度触发器 -->
    <HoverCard>
      <HoverCardTrigger as-child>
        <Button
          variant="ghost"
          class="h-7 gap-1 rounded-sm px-2 text-[11px] text-neutral-dim transition-colors hover:text-neutral-mid"
          :title="t('panel.context.genStatsSpeedTitle')"
        >
          <span class="tabular-nums" data-testid="genstats-speed-value">{{ speedDisplay }}</span>
        </Button>
      </HoverCardTrigger>
      <HoverCardContent
        side="top"
        class="w-[260px] p-0"
      >
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
              <!-- 「本次」label 带 hover 补句（C4）：current 无窗口过滤，澄清样本来自最近一次请求 -->
              <span
                class="font-mono text-[10px] uppercase tracking-[0.05em] text-neutral-dim"
                :title="row.note ?? undefined"
              >{{ row.label }}</span>
              <span class="font-sans text-[14px] font-semibold tabular-nums" :class="row.value == null ? 'text-neutral-dim' : 'text-neutral-fg'">
                {{ row.value == null ? '—' : `${row.value} t/s` }}
              </span>
            </div>
          </div>
          <!-- 口径说明 -->
          <div class="border-t border-border px-2.5 py-1.5 font-mono text-[10px] text-neutral-dim">
            {{ t('panel.context.genStatsSpeedNote') }}
          </div>
        </template>
      </HoverCardContent>
    </HoverCard>

    <!-- 缓存命中率触发器 -->
    <HoverCard>
      <HoverCardTrigger as-child>
        <Button
          variant="ghost"
          :class="
            cn(
              'h-7 gap-1 rounded-sm px-2 text-[11px] transition-colors',
              cacheTriggerClass,
            )
          "
          :title="t('panel.context.genStatsCacheTitle')"
        >
          <span class="tabular-nums" data-testid="genstats-cache-value">{{ cacheDisplay }}</span>
        </Button>
      </HoverCardTrigger>
      <HoverCardContent
        side="top"
        class="w-[260px] p-0"
      >
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
              <span class="font-sans text-[14px] font-semibold tabular-nums" :class="frame.cacheRatio.current == null ? 'text-neutral-dim' : 'text-neutral-fg'">
                {{ cachePercentDisplay(frame.cacheRatio.current) }}
              </span>
            </div>
            <div class="flex flex-col gap-0.5">
              <span class="font-mono text-[10px] uppercase tracking-[0.05em] text-neutral-dim">{{ t('panel.context.genStatsDayShort') }}</span>
              <span class="font-sans text-[14px] font-semibold tabular-nums" :class="frame.cacheRatio.day == null ? 'text-neutral-dim' : 'text-neutral-fg'">
                {{ cachePercentDisplay(frame.cacheRatio.day) }}
              </span>
            </div>
          </div>
          <!-- bar（仅本次命中率有值时显示；宽度/颜色按三档语义色） -->
          <div v-if="frame.cacheRatio.current != null" class="mx-2.5 mt-0.5 h-1 overflow-hidden rounded-full bg-surface-2">
            <div
              :class="cn('h-full rounded-full transition-[width,background-color]', cacheBarClass)"
              :style="{ width: `${frame.cacheRatio.current}%` }"
              data-testid="genstats-cache-bar"
            />
          </div>
          <!-- 口径说明 -->
          <div class="mt-2 border-t border-border px-2.5 py-1.5 font-mono text-[10px] text-neutral-dim">
            {{ t('panel.context.genStatsCacheNote') }}
          </div>
        </template>
      </HoverCardContent>
    </HoverCard>
  </div>
</template>

<script setup lang="ts">
import { computed, toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { cn } from '@/lib/utils'
import { useGenStats } from '@/composables/features/model/useGenStats'

/**
 * 纯读组件（D5）：per-session 分区状态在 useGenStats composable，组件只做帧 → 显示映射。
 * session 分区键 + 恢复腿触发源 = sessionId；modelId（复合 "provider/modelId"）供 composable
 * 做帧 model 校验兜底（D4 前端防线），由 Composer 下发（对齐 ContextCapacityPopover 受控范式）。
 */
const props = defineProps<{
  sessionId?: string
  modelId?: string
}>()

const { t } = useI18n()

// 订阅（session.stats_update）/ 恢复腿（session.getGenStats）/ model 校验全在 composable 内
const { current: frame } = useGenStats(toRef(props, 'sessionId'), toRef(props, 'modelId'))

// ── 速度触发器：current →「N t/s」，null →「—」 ──
const speedDisplay = computed(() => {
  const v = frame.value?.speed.current
  return v == null ? '—' : `${v} t/s`
})

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

// ── 缓存命中率：三档语义色阈值（设计 §3.1：≥80 绿 / 50–80 黄 / <50 红） ──
const CACHE_SUCCESS_THRESHOLD = 80
const CACHE_WARN_THRESHOLD = 50

const cacheCurrent = computed(() => frame.value?.cacheRatio.current ?? null)

const cacheTriggerClass = computed(() => {
  const v = cacheCurrent.value
  if (v == null) return 'text-neutral-dim hover:text-neutral-mid'
  if (v >= CACHE_SUCCESS_THRESHOLD) return 'text-success hover:text-success'
  if (v >= CACHE_WARN_THRESHOLD) return 'text-warn hover:text-warn'
  return 'text-danger hover:text-danger'
})

const cacheBarClass = computed(() => {
  const v = cacheCurrent.value
  if (v == null) return 'bg-neutral-dim'
  if (v >= CACHE_SUCCESS_THRESHOLD) return 'bg-success'
  if (v >= CACHE_WARN_THRESHOLD) return 'bg-warn'
  return 'bg-danger'
})

/** 百分比统一显示：null →「—」，否则「N%」 */
function cachePercentDisplay(v: number | null | undefined): string {
  return v == null ? '—' : `${v}%`
}

const cacheDisplay = computed(() => cachePercentDisplay(cacheCurrent.value))
</script>
