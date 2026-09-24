<template>
  <!--
    composer-gen-stats 双触发器（D4/D5）。
    位于上下文容量触发器左侧：左 = TOKEN 速度（t/s），右 = 缓存命中率（%），独立判定
    null → 「—」（无值编码纪律：null=无数据，0=真实测量值，D4）。
    命中率语义色三档：≥80 success · 50–80 warn · <50 danger（项目语义色 token）。
    归因降噪（2026-09-19 D-A）：帧带 cacheRatio.currentMiss 时本次触发器显成因文案（中性色，
    非故障）；未知成因的 0% 仍显示 0% 三档色——那正是需要被看到的信号。
    [HISTORICAL] `variant`（simplified/iconic）中间态已随 W3b 删除——聚合形态由
    ComposerMetricsAggregate（单图标聚合页）承担，本组件恒为 full 文本触发器；
    浮层内容拆为 GenStatsSpeedCard / GenStatsCacheCard（原触发器与聚合页共挂，删重复渲染）。
    hover 出各自浮层：速度四行（本次/今日/7天/30天）+ 口径说明；缓存两行（本次/今日加权）
    + bar + 口径说明。「本次」= 本会话最近一次请求样本（会话视角，runtime per-session 槽）；
    今日/7天/30天 = 该模型跨会话全局聚合（模型视角）。数据纯读 useGenStats 分区
    （订阅/恢复腿/model 校验兜底全在 composable）。
  -->
  <div class="flex items-center gap-0">
    <!-- 速度触发器（只留数值） -->
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
        <GenStatsSpeedCard :session-id="props.sessionId" :model-id="props.modelId" />
      </HoverCardContent>
    </HoverCard>

    <!-- 缓存命中率触发器（归因态仍显成因文案，优先级高于精简） -->
    <HoverCard>
      <HoverCardTrigger as-child>
        <Button
          variant="ghost"
          :class="cn('h-7 gap-1 rounded-sm px-2 text-[11px] transition-colors', cacheTriggerClass)"
          :title="t('panel.context.genStatsCacheTitle')"
        >
          <span class="tabular-nums" data-testid="genstats-cache-value">{{ cacheDisplay }}</span>
        </Button>
      </HoverCardTrigger>
      <HoverCardContent
        side="top"
        class="w-[260px] p-0"
      >
        <GenStatsCacheCard :session-id="props.sessionId" :model-id="props.modelId" />
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
import GenStatsSpeedCard from './GenStatsSpeedCard.vue'
import GenStatsCacheCard from './GenStatsCacheCard.vue'
import {
  CACHE_TIER_TEXT_CLASS,
  cacheMissLabel,
  cachePercentDisplay,
  cacheTierOf,
  formatSpeed,
} from './gen-stats-display'
import type { CacheTier } from './gen-stats-display'

/**
 * 纯读组件（D5）：per-session 分区状态在 useGenStats composable，组件只做帧 → 显示映射。
 * session 分区键 + 恢复腿触发源 = sessionId；modelId（复合 "provider/modelId"）供 composable
 * 做帧 model 校验兜底（D4 前端防线），由 Composer 下发（对齐 ContextCapacityPopover 受控范式）。
 * [HISTORICAL] `variant` prop 已删（W3b）：对外 props 恒为 sessionId / modelId。
 */
const props = defineProps<{
  sessionId?: string
  modelId?: string
}>()

const { t } = useI18n()

// 订阅（session.stats_update）/ 恢复腿（session.getGenStats）/ model 校验全在 composable 内
// （与两张内容卡共享同一分区实例，帧口径单份）
const { current: frame } = useGenStats(toRef(props, 'sessionId'), toRef(props, 'modelId'))

/** 速度触发器：current →「N t/s」，null →「—」（与卡内四行同口径，formatSpeed 共用） */
const speedDisplay = computed(() => formatSpeed(frame.value?.speed.current))

const cacheCurrent = computed(() => frame.value?.cacheRatio.current ?? null)

/** 归因态（runtime 已归因的「预期内 0%」）→ 触发器中性色 + 成因文案 */
const cacheMiss = computed(() => frame.value?.cacheRatio.currentMiss ?? null)

/** 触发器色：归因态 / 无值 → 中性；否则数值三档色（hover 同色，语义色下 hover 不改档） */
const cacheTriggerClass = computed(() => {
  const tier: CacheTier = cacheMiss.value ? 'neutral' : cacheTierOf(cacheCurrent.value)
  if (tier === 'neutral') return 'text-neutral-dim hover:text-neutral-mid'
  const cls = CACHE_TIER_TEXT_CLASS[tier]
  return `${cls} hover:${cls}`
})

/** 触发器显示：归因态 → 成因文案（「空闲过期」等）；否则数值（null →「—」） */
const cacheDisplay = computed(() => {
  const miss = cacheMiss.value
  return miss ? cacheMissLabel(miss.reason, t) : cachePercentDisplay(cacheCurrent.value)
})
</script>
